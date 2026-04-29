"""
auê Backend — FastAPI
Serve eventos reais de Curitiba enriquecidos com Claude.

Local:  uvicorn main:app --reload --port 8000
Deploy: Railway runs this via Dockerfile (PORT injected by Railway)

(O nome do diretório/repo ainda é "reroot" — produto anterior; a voz e o
branding já migraram pra auê.)
"""
import functools
import json
import logging
import os
import re
import unicodedata
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
from anthropic import Anthropic
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

import database as db
import badges
from scheduler import start_scheduler, stop_scheduler, run_refresh

# Static files directory (built React app, copied by Dockerfile)
STATIC_DIR = Path(__file__).parent / "static"

# ── Logging ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("aue")


# ── Settings (lê do .env) ──
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str = ""
    instagram_user: str = ""
    instagram_pass: str = ""
    apify_api_token: str = ""
    city: str = "Curitiba"
    # Founder is auto-seeded as a curator at startup. Override via env var if
    # the app changes hands.
    founder_email: str = "ciro.b.domingos@gmail.com"
    # Email — used to send scrape summaries to the founder. Defaults to
    # Gmail SMTP. Set SMTP_USER + SMTP_PASSWORD (an App Password generated
    # at myaccount.google.com/apppasswords, NOT the regular password) to
    # enable. SMTP_FROM defaults to the user; override for a custom display.
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""  # falls back to smtp_user if empty
    # Resend (https://resend.com) — HTTPS API for transactional email.
    # Used when SMTP outbound is blocked by the host (Railway blocks
    # port 587). When RESEND_API_KEY is set, send_email routes via
    # Resend instead of SMTP. Free tier = 3,000/month, enough for
    # founder-only scrape summaries + future user pings.
    resend_api_key: str = ""
    # The "From" address Resend uses. Without a verified domain,
    # use "onboarding@resend.dev" — sends only to the email used to
    # sign up Resend (i.e., founder_email). Add a verified domain
    # later for sending to other users.
    resend_from: str = "auê <onboarding@resend.dev>"
    # Android Trusted Web Activity — exposes /.well-known/assetlinks.json so
    # the Play Store app can verify domain ownership. Both vars come from
    # PWABuilder's signing-key-info.txt after generating the AAB bundle.
    twa_package_name: str = "app.aue"
    twa_sha256_fingerprint: str = ""  # e.g. "AB:CD:EF:..." — empty disables endpoint
    # Deployment environment label. Defaults to "production" so a missing
    # var fails-safe (staging-only behaviors stay off if someone forgets to
    # set it). Set ENV_NAME=staging on the Railway staging service and use
    # `if settings.env_name == "staging": ...` to gate behavior.
    env_name: str = "production"


settings = Settings()

# Anthropic key validation cache. The /health endpoint reports this so a
# misconfigured key surfaces fast (the previous "configured: bool(env_var)"
# check returned True for empty-but-set keys and for rotated/invalid keys).
# Validated once at startup with a cheap models-list call; refreshable.
_anthropic_key_status: dict = {"valid": None, "checked_at": None, "error": None}


def _check_anthropic_key(api_key: str) -> dict:
    """Return {valid, error}. Uses a cheap GET that doesn't burn tokens."""
    if not api_key:
        return {"valid": False, "error": "ANTHROPIC_API_KEY ausente"}
    try:
        client = Anthropic(api_key=api_key)
        client.models.list(limit=1)  # auth-validating call, no completion cost
        return {"valid": True, "error": None}
    except Exception as e:
        msg = str(e)[:200]
        return {"valid": False, "error": msg}


# ── App lifecycle ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    log.info(f"DB inicializado em {db.DB_PATH}")

    # Seed Instagram tracking list on first run so the admin UI isn't empty.
    _seed_default_ig_accounts()

    # Make sure the founder is always a curator. They can grant the role to
    # anyone else from the admin UI; this seed ensures they can log in.
    try:
        db.add_curator(
            email=settings.founder_email,
            added_by_email="system",
            notes="Founder",
            is_founder_flag=True,
        )
        log.info(f"Founder curator ensured: {settings.founder_email}")
    except Exception as e:
        log.warning(f"Failed to seed founder curator: {e}")

    # Validate the Anthropic key once at startup so /health can report the
    # real status (ENV var present is not the same as "key works").
    key_status = _check_anthropic_key(settings.anthropic_api_key)
    _anthropic_key_status.update(key_status)
    _anthropic_key_status["checked_at"] = datetime.now(timezone.utc).isoformat()
    if key_status["valid"]:
        log.info("Anthropic key validated ✓")
        start_scheduler(settings, run_immediately=True)
    elif settings.anthropic_api_key:
        log.error(f"ANTHROPIC_API_KEY rejeitada: {key_status['error']}")
        log.error("Scheduler desativado até a chave ser corrigida no env.")
    else:
        log.warning(
            "ANTHROPIC_API_KEY não configurada — scheduler desativado. "
            "O app vai usar dados estáticos de fallback."
        )

    yield  # ← app rodando

    stop_scheduler()


app = FastAPI(
    title="auê API",
    description="Catálogo de eventos sociais de Curitiba — shows, exposições, feiras, oficinas, encontros pequenos.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Capacitor native apps send requests from arbitrary origins
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Endpoints ──

# ── TWA Digital Asset Links ──────────────────────────────
# Required for the Android TWA (PWABuilder bundle) to verify it's allowed
# to handle this domain's URLs without the URL bar showing. The file is
# served at exactly /.well-known/assetlinks.json (Play Store + Chrome
# fetch this path on first launch and on updates).
@app.get("/.well-known/assetlinks.json")
def asset_links():
    fp = (settings.twa_sha256_fingerprint or "").strip()
    if not fp:
        # Until the fingerprint is set in env, return empty list — the TWA
        # will show a URL bar (degraded UX) but nothing breaks.
        return []
    return [{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {
            "namespace": "android_app",
            "package_name": settings.twa_package_name,
            "sha256_cert_fingerprints": [fp],
        },
    }]


# ── Privacy policy ───────────────────────────────────────
# Plain HTML, served at /privacy. Required URL for Play Console submission
# (data safety form references it). Easier to keep here than as a React
# route because Play crawlers prefer plain HTML over SPA-rendered pages.
_PRIVACY_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>auê — Política de Privacidade</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif;
         max-width: 720px; margin: 40px auto; padding: 0 20px;
         color: #2C2C2C; line-height: 1.6; }
  h1 { color: #E8623F; }
  h2 { margin-top: 28px; color: #2C2C2C; }
  a  { color: #7A9E7E; }
  small { color: #888; }
  code { background: #F4EFE6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style>
</head>
<body>
<h1>auê — Política de Privacidade</h1>
<small>Última atualização: 28 de abril de 2026</small>

<p>O <strong>auê</strong> é um catálogo social de eventos em Curitiba.
Esta política descreve, de forma objetiva, quais dados a gente coleta,
por quê, e o que você pode pedir pra remover.</p>

<h2>O que a gente coleta</h2>
<ul>
  <li><strong>Login Google</strong>: nome, email, foto de perfil e ID Google. Necessário pra
  RSVPs, lista de amigos e sincronização entre dispositivos.</li>
  <li><strong>Atividade no app</strong>: eventos que você confirmou (RSVPs), amizades aceitas,
  grupos que entrou, lugares favoritados. Tudo armazenado vinculado ao seu ID Google.</li>
  <li><strong>Feedback</strong>: mensagens enviadas via "Mandar feedback" no Perfil são
  guardadas com seu email pra que possamos responder.</li>
  <li><strong>Métricas anônimas</strong>: contagem de uso (DAU, WAU) sem identificação
  pessoal, agregada pelo backend.</li>
</ul>

<h2>O que a gente NÃO coleta</h2>
<ul>
  <li>Localização precisa (GPS).</li>
  <li>Lista de contatos do celular.</li>
  <li>Conteúdo de outras redes sociais além do que você publicou publicamente.</li>
  <li>Dados de pagamento — o app não cobra nada nem processa pagamentos.</li>
</ul>

<h2>De onde vêm os eventos do catálogo</h2>
<p>Os eventos exibidos vêm de perfis públicos do Instagram que você pode ver
na tela <em>Fontes monitoradas</em>, mais alguns eventos curados pela equipe.
Pra extrair informações estruturadas das legendas do Instagram, a gente usa
a API da <a href="https://www.anthropic.com/legal/privacy">Anthropic (Claude)</a>;
nada de dados pessoais seus é enviado, só o conteúdo público dos posts.</p>
<p>Cada evento exibido inclui um link <em>"Ver no Instagram"</em> que leva direto
ao post original — o auê é um agregador, não uma cópia. As fontes (perfis
do Instagram) continuam donas do conteúdo; nós apenas indexamos o que está
público pra facilitar a descoberta de quem mora em Curitiba.</p>

<h2>Sou dono de um perfil — quero sair do catálogo</h2>
<p>Se você representa um dos perfis listados em <em>Fontes monitoradas</em> e
quer que ele <strong>deixe de ser indexado</strong>, é só mandar e-mail pra
<code>ciro.b.domingos@gmail.com</code> com assunto
<em>"Remover @&lt;handle&gt; do auê"</em>, do email associado ao perfil ou de
alguém que você indique. Removemos a conta da listagem e apagamos os eventos
+ imagens cacheadas do nosso catálogo em até <strong>24 horas</strong>, sem
necessidade de justificativa.</p>
<p>Se preferir, você também pode <strong>reivindicar</strong> o perfil pra
controlar diretamente como ele aparece (em breve — escreva pro mesmo email
e a gente conversa).</p>

<h2>Quem mais vê seus dados</h2>
<ul>
  <li>Seus amigos veem os eventos que você confirmou (a menos que você desative em
  <em>Privacidade</em>).</li>
  <li>Membros dos seus grupos veem os eventos que você adicionou ao grupo.</li>
  <li>O fundador (administrador) tem acesso ao painel de uso e ao feedback enviado.</li>
  <li>A gente <strong>não vende</strong> dados, <strong>não compartilha</strong> com anunciantes,
  <strong>não há integração com adtech</strong>.</li>
</ul>

<h2>Por quanto tempo a gente guarda</h2>
<p>Enquanto sua conta estiver ativa. Se você quiser deletar tudo, mande email pra
<code>ciro.b.domingos@gmail.com</code> com assunto <em>"Deletar minha conta auê"</em> —
removo seus dados em até 7 dias e te confirmo.</p>

<h2>Seus direitos</h2>
<p>Pela <strong>LGPD</strong> (Lei Geral de Proteção de Dados), você tem direito a:</p>
<ul>
  <li>Saber quais dados a gente tem sobre você.</li>
  <li>Pedir correção ou deleção.</li>
  <li>Pedir portabilidade (exportação dos seus dados).</li>
  <li>Revogar consentimento a qualquer momento.</li>
</ul>
<p>Pra exercer qualquer um, mande email pro contato abaixo.</p>

<h2>Crianças</h2>
<p>O app não é destinado a menores de 13 anos. Quem tem entre 13 e 18 precisa
do consentimento dos responsáveis pra usar.</p>

<h2>Mudanças nesta política</h2>
<p>Se a política mudar, atualizo a data no topo e aviso usuários ativos via email
ou notificação no app.</p>

<h2>Contato</h2>
<p>Ciro Beduschi Domingos · <code>ciro.b.domingos@gmail.com</code> · Curitiba, PR, Brasil</p>

</body>
</html>
"""


@app.get("/privacy", response_class=PlainTextResponse)
def privacy():
    return PlainTextResponse(_PRIVACY_HTML, media_type="text/html; charset=utf-8")


# ── /install — universal install walkthrough ─────────────
# Single page that detects platform and shows the right walkthrough:
#   - iOS Safari      → Add to Home Screen (3 steps)
#   - iOS in-app      → "open in Safari" warning + copy-link button
#   - Android Chrome  → menu → Install app (3 steps)
#   - Android in-app  → "open in Chrome" warning + copy-link button
#   - Desktop         → install icon in address bar (Chrome/Edge/Brave)
# Plus a universal "share with friends" button using Web Share API
# (falls back to clipboard copy).
_INSTALL_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#E8623F">
<title>auê — Instalar</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #FCF5EB; color: #2C2C2C;
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    min-height: 100vh;
  }
  .container { max-width: 480px; margin: 0 auto; padding: 36px 20px 48px; }
  .logo { font-size: 56px; font-weight: 900; color: #E8623F; text-align: center;
          margin: 0 0 4px; letter-spacing: -2px; line-height: 1; }
  .tag  { text-align: center; color: #2C2C2C; opacity: 0.65;
          font-size: 13px; font-weight: 500; margin-bottom: 32px;
          text-transform: uppercase; letter-spacing: 1.5px; }
  h1 { font-size: 24px; font-weight: 800; margin: 0 0 8px; line-height: 1.25; }
  .sub { color: #2C2C2C; opacity: 0.7; font-size: 14px;
         margin: 0 0 24px; line-height: 1.55; }
  .warning {
    background: #FFF4E5; border-left: 4px solid #E8A93F;
    padding: 14px 16px; border-radius: 10px; margin-bottom: 18px;
    font-size: 14px; line-height: 1.5;
  }
  .warning strong { color: #B8761F; display: block; margin-bottom: 6px; }
  .warning button, .copy-btn {
    display: block; width: 100%; margin-top: 10px;
    background: #E8623F; color: white; border: none;
    padding: 12px; border-radius: 10px; font-size: 14px; font-weight: 700;
    cursor: pointer; -webkit-tap-highlight-color: transparent;
    font-family: inherit;
  }
  .warning button:active, .copy-btn:active { background: #C84F30; }
  .step {
    background: white; border-radius: 16px; padding: 16px;
    margin-bottom: 10px; display: flex; gap: 14px; align-items: flex-start;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.03);
  }
  .num {
    width: 30px; height: 30px; border-radius: 50%;
    background: #E8623F; color: white;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 14px; flex-shrink: 0;
  }
  .sc { flex: 1; min-width: 0; }
  .st { font-weight: 700; font-size: 15px; margin-bottom: 3px; line-height: 1.3; }
  .sd { font-size: 13px; color: #2C2C2C; opacity: 0.75; line-height: 1.5; }
  .ic {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; vertical-align: -6px;
    background: #F4EFE6; border-radius: 5px; padding: 3px; margin: 0 2px;
  }
  .done {
    text-align: center; margin-top: 16px;
    background: #7A9E7E12; border: 1px solid #7A9E7E40;
    padding: 14px; border-radius: 12px;
    font-size: 13px; color: #2C2C2C; line-height: 1.5;
  }
  .done strong { color: #5A7E5E; display: block; margin-bottom: 4px; font-size: 14px; }
  .share {
    margin-top: 32px; padding: 18px 16px; border-radius: 14px;
    background: white; border: 1px solid #E8623F30;
    text-align: center;
  }
  .share-title {
    font-size: 13px; font-weight: 700; color: #2C2C2C;
    margin-bottom: 4px;
  }
  .share-sub {
    font-size: 12px; color: #2C2C2C; opacity: 0.6;
    margin-bottom: 12px;
  }
  .share button {
    display: inline-block; width: auto; min-width: 220px;
    background: linear-gradient(135deg, #E8623F 0%, #F08869 100%);
    color: white; border: none;
    padding: 12px 22px; border-radius: 999px; font-size: 14px; font-weight: 700;
    cursor: pointer; font-family: inherit;
    box-shadow: 0 4px 14px rgba(232, 98, 63, 0.35);
  }
  .share button:active { transform: translateY(1px); }
  .share .copied { font-size: 12px; color: #5A7E5E; margin-top: 8px; min-height: 16px; }
  .open-app {
    display: block; width: 100%;
    background: linear-gradient(135deg, #E8623F 0%, #F08869 100%);
    color: white !important; text-align: center; text-decoration: none;
    padding: 14px 18px; border-radius: 14px; font-size: 15px; font-weight: 700;
    box-shadow: 0 6px 18px rgba(232, 98, 63, 0.32);
    margin-bottom: 8px;
    -webkit-tap-highlight-color: transparent;
  }
  .open-app:active { transform: translateY(1px); }
  .open-hint {
    font-size: 11px; color: #B8761F;
    background: #FFF4E5; border-radius: 8px;
    padding: 8px 12px; margin-bottom: 16px;
    line-height: 1.45;
  }
  .footer {
    text-align: center; margin-top: 24px; font-size: 12px;
    color: #2C2C2C; opacity: 0.55; line-height: 1.7;
  }
  .footer a { color: #7A9E7E; text-decoration: none; }
  .footer a:hover { text-decoration: underline; }
  [hidden] { display: none !important; }

  /* Full-screen blocker for in-app browsers (WhatsApp/Instagram/etc.) — */
  /* surface the install impossibility immediately instead of inline warning. */
  /* R3 finding: 36 mentions of users giving up here. */
  .iab-overlay {
    position: fixed; inset: 0; z-index: 9000;
    background: rgba(40, 30, 20, 0.92);
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  }
  .iab-card {
    background: white; border-radius: 24px;
    padding: 32px 26px 26px;
    max-width: 380px; width: 100%;
    box-shadow: 0 24px 60px rgba(0,0,0,0.4);
    text-align: center;
  }
  .iab-icon { font-size: 48px; line-height: 1; margin-bottom: 14px; }
  .iab-title {
    font-size: 20px; font-weight: 800; line-height: 1.25;
    color: #2C2C2C; margin-bottom: 10px;
  }
  .iab-body {
    font-size: 14px; color: #5A5A5A; line-height: 1.55;
    margin-bottom: 22px;
  }
  .iab-body strong { color: #2C2C2C; }
  .iab-cta {
    display: block; width: 100%;
    background: linear-gradient(135deg, #E8623F 0%, #F08869 100%);
    color: white; border: none; cursor: pointer;
    padding: 16px 22px; border-radius: 14px;
    font-size: 15px; font-weight: 800; letter-spacing: 0.2px;
    box-shadow: 0 6px 18px rgba(232, 98, 63, 0.4);
    -webkit-tap-highlight-color: transparent;
    font-family: inherit;
  }
  .iab-cta:active { transform: translateY(1px); }
  .iab-secondary {
    display: block; width: 100%; margin-top: 10px;
    background: none; border: none; cursor: pointer;
    padding: 10px; font-size: 12px; color: #999;
    font-family: inherit;
  }
  .iab-secondary:active { color: #666; }
</style>
</head>
<body>
<div class="container">
  <div class="logo">auê</div>
  <div class="tag">Curitiba que acontece</div>

  <!-- ── iOS Safari ── -->
  <section id="ios-safari" hidden>
    <h1>Instalar no iPhone</h1>
    <p class="sub">Em 30 segundos você tem o auê na tela inicial, com ícone próprio e sem barra do navegador.</p>
    <a href="/" class="open-app">1. Abrir o auê →</a>
    <div class="open-hint">
      ⚠️ Adicione o ícone <strong>enquanto estiver no auê</strong>, não nesta página — senão o ícone instalado abre as instruções, não o app.
    </div>
    <div class="step">
      <div class="num">2</div>
      <div class="sc">
        <div class="st">Lá no auê, toque o botão Compartilhar</div>
        <div class="sd">É o ícone <span class="ic"><svg width="14" height="18" viewBox="0 0 16 20" fill="none"><path d="M8 1L4 5h3v8h2V5h3L8 1z" stroke="#2C2C2C" stroke-width="1.4" stroke-linejoin="round"/><path d="M2 13v5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5" stroke="#2C2C2C" stroke-width="1.4" stroke-linejoin="round"/></svg></span> no menu inferior do Safari (no iPad fica no canto superior).</div>
      </div>
    </div>
    <div class="step">
      <div class="num">3</div>
      <div class="sc">
        <div class="st">Role e toque "Adicionar à Tela de Início"</div>
        <div class="sd">A opção fica perto do final da lista. Tem um ícone <span class="ic"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2.5" stroke="#2C2C2C" stroke-width="1.4"/><path d="M8 5v6M5 8h6" stroke="#2C2C2C" stroke-width="1.4" stroke-linecap="round"/></svg></span> ao lado.</div>
      </div>
    </div>
    <div class="step">
      <div class="num">4</div>
      <div class="sc">
        <div class="st">Toque "Adicionar" no canto superior direito</div>
        <div class="sd">Pronto. O ícone laranja do auê aparece na sua tela inicial.</div>
      </div>
    </div>
    <div class="done"><strong>🎉 É isso</strong>Da próxima vez, é só tocar no ícone — abre tela cheia, sem Safari por cima.</div>
  </section>

  <!-- ── iOS in-app browser (WhatsApp, Instagram, Chrome iOS) ── -->
  <section id="ios-inapp" hidden>
    <h1>Abre no Safari primeiro</h1>
    <p class="sub">"Adicionar à Tela de Início" só aparece no Safari de verdade — aqui no app de mensagem não dá.</p>
    <div class="warning">
      <strong>⚠️ Como fazer</strong>
      Toca no botão abaixo pra copiar o link, abre o app Safari (azul) no teu iPhone, cola na barra de endereço e segue o passo a passo de instalação.
      <button onclick="copyLink('Link copiado! Abra o Safari e cole na barra de endereço.')">Copiar link</button>
    </div>
  </section>

  <!-- ── Android Chrome / Edge / Brave / Samsung ── -->
  <section id="android-chrome" hidden>
    <h1>Instalar no Android</h1>
    <p class="sub">O Chrome pode oferecer "Instalar app" automaticamente no rodapé. Se não aparecer:</p>
    <a href="/" class="open-app">1. Abrir o auê →</a>
    <div class="open-hint">
      Faça os passos abaixo <strong>dentro do auê</strong>, não nesta página de instruções.
    </div>
    <div class="step">
      <div class="num">2</div>
      <div class="sc">
        <div class="st">Toque o menu (3 pontinhos)</div>
        <div class="sd">No canto superior direito do navegador.</div>
      </div>
    </div>
    <div class="step">
      <div class="num">3</div>
      <div class="sc">
        <div class="st">Toque "Instalar app"</div>
        <div class="sd">Em alguns Androids aparece como "Adicionar à Tela inicial" — é a mesma coisa.</div>
      </div>
    </div>
    <div class="step">
      <div class="num">4</div>
      <div class="sc">
        <div class="st">Confirme "Instalar"</div>
        <div class="sd">O ícone do auê aparece junto dos outros apps. Da próxima vez, abre direto sem navegador.</div>
      </div>
    </div>
    <div class="done"><strong>🎉 É isso</strong>Funciona como app de verdade — incluindo notificações.</div>
  </section>

  <!-- ── Android in-app (WhatsApp, Instagram, etc.) ── -->
  <section id="android-inapp" hidden>
    <h1>Abre no Chrome primeiro</h1>
    <p class="sub">A opção "Instalar app" só aparece no Chrome (ou Edge / Samsung Browser) — não funciona dentro do app de mensagem.</p>
    <div class="warning">
      <strong>⚠️ Como fazer</strong>
      Toca pra copiar o link, abre o Chrome no teu Android, cola na barra de endereço e segue.
      <button onclick="copyLink('Link copiado! Abra o Chrome e cole na barra de endereço.')">Copiar link</button>
    </div>
  </section>

  <!-- ── Desktop ── -->
  <section id="desktop" hidden>
    <h1>Instalar no computador</h1>
    <p class="sub">Funciona em Chrome, Edge, Brave, Opera. Vira um app de verdade na tua área de trabalho.</p>
    <a href="/" class="open-app">1. Abrir o auê →</a>
    <div class="open-hint">
      Os passos abaixo precisam ser feitos <strong>dentro do auê</strong>, não nesta página.
    </div>
    <div class="step">
      <div class="num">2</div>
      <div class="sc">
        <div class="st">Procure o ícone de instalação na barra de endereço</div>
        <div class="sd">É um quadradinho com seta pra baixo, do lado direito da URL. Senão, abre o menu (3 pontos) → "Instalar auê".</div>
      </div>
    </div>
    <div class="step">
      <div class="num">3</div>
      <div class="sc">
        <div class="st">Confirme "Instalar"</div>
        <div class="sd">O auê abre numa janela própria, sem abas — comportamento de app.</div>
      </div>
    </div>
    <div class="done"><strong>📱 Bonus</strong>No celular, instala como app também — fica com ícone na tela inicial e abre offline.</div>
  </section>

  <!-- ── Full-screen blocker for in-app browsers — shown by JS below ── -->
  <div id="iab-blocker" class="iab-overlay" hidden>
    <div class="iab-card">
      <div class="iab-icon">⚠️</div>
      <div class="iab-title" id="iab-title">Esse link não abre aqui</div>
      <div class="iab-body" id="iab-body">
        Você abriu o link dentro do <strong>WhatsApp / Instagram</strong> — esse
        navegador não permite instalar apps. Toca no botão abaixo pra abrir
        no <strong>Chrome ou Safari</strong> e seguir.
      </div>
      <button class="iab-cta" id="iab-cta-btn" onclick="iabAction()">
        Abrir no navegador certo
      </button>
      <button class="iab-secondary" onclick="document.getElementById('iab-blocker').hidden = true">
        Continuar mesmo assim
      </button>
    </div>
  </div>

  <!-- ── Universal share section ── -->
  <div class="share">
    <div class="share-title">📲 Manda pra um amigo</div>
    <div class="share-sub">Galera de Curitiba — bora junto saber o que rola.</div>
    <button onclick="shareApp()" id="share-btn">Compartilhar com amigos</button>
    <div class="copied" id="copied-msg"></div>
  </div>

  <div class="footer">
    Algum problema? <a href="mailto:ciro.b.domingos@gmail.com">manda mensagem pro Ciro</a><br>
    <a href="/">← Voltar pro auê</a>
  </div>
</div>

<script>
  // Detected platform (set by IIFE below) — used by iabAction() too.
  var __aueIsIOS = false;
  var __aueIsAndroid = false;

  // ── Platform detection: pick one section, hide the rest ──
  (function() {
    var ua = navigator.userAgent || "";
    var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    var isAndroid = /Android/.test(ua);
    __aueIsIOS = isIOS;
    __aueIsAndroid = isAndroid;
    // In-app browsers and non-Safari browsers on iOS: install option missing.
    var inApp = /FB_IAB|FBAN|FBAV|FBIOS|Instagram|Line|WhatsApp|Twitter|GSA|CriOS|FxiOS|EdgiOS|MicroMessenger|TikTok/i.test(ua);
    var which;
    if (isIOS) which = inApp ? "ios-inapp" : "ios-safari";
    else if (isAndroid) which = inApp ? "android-inapp" : "android-chrome";
    else which = "desktop";
    var el = document.getElementById(which);
    if (el) el.hidden = false;

    // If running in standalone (already installed), say so up top.
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
      document.querySelector(".container").insertAdjacentHTML("afterbegin",
        '<div class="done" style="margin-bottom:24px"><strong>✓ Já instalado</strong>Você está abrindo o auê instalado. Pode mandar o link pra um amigo abaixo.</div>');
      return;
    }

    // Full-screen blocker for in-app browsers — single decision.
    if (inApp) {
      var blocker = document.getElementById("iab-blocker");
      var btn = document.getElementById("iab-cta-btn");
      var title = document.getElementById("iab-title");
      var body = document.getElementById("iab-body");
      if (isIOS) {
        title.textContent = "Esse link não abre aqui";
        body.innerHTML = "O <strong>WhatsApp/Instagram</strong> não permite instalar apps. Toca abaixo pra copiar o link e abrir no <strong>Safari</strong>.";
        btn.textContent = "Copiar link e abrir Safari";
      } else if (isAndroid) {
        title.textContent = "Esse link não abre aqui";
        body.innerHTML = "O <strong>WhatsApp/Instagram</strong> não permite instalar apps. Toca abaixo pra abrir direto no <strong>Chrome</strong>.";
        btn.textContent = "Abrir no Chrome";
      } else {
        title.textContent = "Abre num navegador completo";
        body.innerHTML = "Toca abaixo pra copiar o link e abrir no Chrome, Safari ou Firefox.";
        btn.textContent = "Copiar link";
      }
      blocker.hidden = false;
    }
  })();

  // ── In-app browser action — platform-specific escape ──
  function iabAction() {
    var canonical = window.location.origin + "/install";
    if (__aueIsAndroid) {
      // Android intent:// scheme — opens directly in Chrome bypassing the
      // in-app webview. Fallback URL (http://) handles browsers that
      // refuse the intent.
      // Strip protocol via split to avoid Python SyntaxWarning on the JS regex.
      var clean = canonical.indexOf("://") > 0 ? canonical.split("://")[1] : canonical;
      window.location.href =
        "intent://" + clean + "#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=" + encodeURIComponent(canonical) + ";end";
      // Safety net: if the intent didn't fire, fall back to copy after 1.5s
      setTimeout(function() { copyLink("Link copiado! Cola na barra do Chrome."); }, 1500);
      return;
    }
    // iOS + everything else: copy and instruct.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(canonical).then(function() {
        var msg = __aueIsIOS
          ? "Link copiado! Abre o Safari (azul) e cola na barra de endereço."
          : "Link copiado! Cola num navegador completo.";
        alert(msg);
      }, function() { prompt("Copie o link:", canonical); });
    } else {
      prompt("Copie o link:", canonical);
    }
  }

  // ── Copy URL to clipboard (used by in-app warning sections) ──
  function copyLink(msg) {
    // Copy /install (not /) so when the user pastes in Safari/Chrome they
    // land on this walkthrough, not the app home — which would skip the
    // platform-specific install instructions entirely.
    var url = window.location.origin + "/install";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        alert(msg || "Link copiado!");
      }, function() {
        prompt("Copie o link:", url);
      });
    } else {
      prompt("Copie o link:", url);
    }
  }

  // ── Web Share API with clipboard fallback ──
  function shareApp() {
    var url = window.location.origin + "/install";
    var text = "Olha o auê — app de eventos em Curitiba. Bora ver o que tá rolando? 🎉";
    var msg = document.getElementById("copied-msg");
    if (navigator.share) {
      navigator.share({ title: "auê — Curitiba que acontece", text: text, url: url })
        .then(function() { msg.textContent = ""; })
        .catch(function() { /* user cancelled — no-op */ });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        msg.textContent = "✓ Link copiado — cola onde quiser mandar.";
        setTimeout(function() { msg.textContent = ""; }, 4000);
      });
    } else {
      prompt("Copie o link:", url);
    }
  }
</script>
</body>
</html>
"""


@app.get("/install", response_class=PlainTextResponse)
def install_page():
    return PlainTextResponse(_INSTALL_HTML, media_type="text/html; charset=utf-8")


@app.get("/ios")
def ios_redirect():
    """Backward-compat: /ios was the iOS-only walkthrough before /install
    became universal. 301 so any cached share links still land somewhere
    sensible (the universal page detects iOS Safari and shows the same
    walkthrough)."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/install", status_code=301)


@app.get("/health")
def health():
    total = db.count_events()
    return {
        "status": "ok",
        "events_in_db": total,
        # "configured" used to mean "env var present" — that hid a 401 in
        # prod for hours. Now it's True only when the key validates against
        # the Anthropic API at startup. `anthropic_error` carries the error
        # text when invalid so the health check is self-explanatory.
        "anthropic_configured": bool(_anthropic_key_status.get("valid")),
        "anthropic_error": _anthropic_key_status.get("error"),
        "anthropic_checked_at": _anthropic_key_status.get("checked_at"),
        "instagram_configured": bool(settings.apify_api_token),
        "apify_configured": bool(settings.apify_api_token),
        "ai_gap_fill_configured": bool(_anthropic_key_status.get("valid")),
        # SMTP shows whether scrape-summary emails will fire. Both vars
        # required — missing either silently skips email send.
        "smtp_configured": bool(settings.smtp_user and settings.smtp_password),
        # Resend (HTTPS) — preferred when set, since Railway blocks SMTP outbound.
        "resend_configured": bool(settings.resend_api_key),
        "email_transport": (
            "resend" if settings.resend_api_key
            else ("smtp" if (settings.smtp_user and settings.smtp_password) else "none")
        ),
        "email_to": settings.founder_email or None,
    }


# Each mood maps to a filter spec applied AFTER the DB fetch. Keeping this
# translation in the API layer (not in SQL) lets us mix kind-based filters
# (tranquilo/ativo/criativo/comunidade — backed by ev.kind) with
# source-based filters (cultural — institutional sources only) and flag
# filters (familia → kids_welcome). New moods plug in without touching SQL.
_MOOD_KIND = {
    "tranquilo":  "quiet_social",
    "ativo":      "active",
    "criativo":   "creative",
    "comunidade": "community",
}
_MOOD_SOURCES = {
    # Institutional curators — museums, theatres, public-cultural orgs
    # Was a hard-coded list of institutional sources; now empty since we
    # only have IG + aue_original. The 'cultural' mood now matches via
    # event kind (creative/community) only — see _mood_predicate.
    "cultural": set(),
}


def _mood_predicate(mood: Optional[str]):
    """
    Return a callable(EnrichedEvent) -> bool that decides whether an event
    matches the given mood. None / 'all' matches everything.
    """
    if not mood or mood == "all":
        return lambda ev: True
    if mood in _MOOD_KIND:
        target = _MOOD_KIND[mood]
        return lambda ev: ev.kind == target
    if mood in _MOOD_SOURCES:
        sources = _MOOD_SOURCES[mood]
        return lambda ev: ev.source in sources
    if mood == "familia":
        return lambda ev: bool(ev.kids_welcome)
    # Unknown mood — fail open (show everything) rather than show nothing
    return lambda ev: True


@app.get("/events")
def list_events(
    category: Optional[str] = None,
    mood: Optional[str] = None,
    good_only: bool = False,
    price_tier: Optional[str] = None,
    kids_welcome: Optional[bool] = None,
    limit: int = 20,
):
    """
    Retorna eventos enriquecidos prontos para o frontend.

    The default is the BROAD view: every real Curitiba event the catalog
    has (subject only to hard sanity filters — region, virtual placeholder,
    closed esoteric venues). Pass `good_only=true` for the curated view.

    mood: tranquilo | ativo | criativo | comunidade | cultural | familia | all
    category: legacy alias (quiet_social|active|creative|community|all). When
      both `mood` and `category` are passed, `mood` wins.
    price_tier: free | paid (paid = anything that is not free)
    kids_welcome: true to filter only family-friendly events
    """
    # If a kind-aligned mood was requested, push it down to the DB filter
    # (smaller result set out of SQL = less memory). Source/flag-based moods
    # get applied in Python after the fetch.
    db_category = category if category and category != "all" else None
    if mood and mood in _MOOD_KIND:
        db_category = _MOOD_KIND[mood]
    mood_pred = _mood_predicate(mood)

    # Pull more than `limit` from DB so the cleanup pass can drop near-duplicates
    # and out-of-region events without leaving us short of results.
    raw = db.get_events(
        city=settings.city,
        good_only=good_only,
        category=db_category,
        price_tier=price_tier,
        kids_welcome=kids_welcome,
        limit=limit * 3,
    )
    # Only surface events whose source is currently active. The DB still
    # holds rows from sources we've since dropped (sympla, eventbrite, IG
    # handles a curator removed) — without this filter the catalog leaks
    # them until they age past their date_start. Sources screen does the
    # same gating per-handle, so this keeps Eventos and Fontes in sync.
    raw = [ev for ev in raw if _is_active_source(ev)]
    cleaned = [
        ev for ev in raw
        if _is_in_curitiba(ev)
        and _passes_content_filter(ev, curated=good_only)
        and mood_pred(ev)
    ]
    # Host-first sort before dedup: when the same event is posted by a
    # venue (bardosax) AND a curator (umcuradorqualquer), we want the
    # venue's version to survive — it has the canonical time/venue and
    # richer description. _dedupe_events keeps the first occurrence, so
    # putting non-curators first naturally accomplishes this. date_start
    # ASC is the secondary sort to preserve the existing chronology
    # (which Tier 2.5 of dedup relies on for "earliest session wins").
    cleaned.sort(key=lambda ev: (
        _is_curator_event(ev),
        ev.date_start or datetime.max.replace(tzinfo=timezone.utc),
    ))
    deduped = _dedupe_events(cleaned)[:limit]

    # Featured-first re-sort: events from a Destaque handle (and the
    # institutional aue_original source) lift to the very top of the
    # list — not just within their day bucket. This is the paid-
    # placement guarantee the venue is paying for: "your events show
    # above everything else, regardless of date". Chronology holds
    # within the featured tier and within the non-featured tier.
    featured = _featured_ig_handles_cached()
    def _featured_rank(ev):
        if ev.source == "aue_original":
            return 0
        if ev.source == "instagram":
            handle = _handle_for_event(ev)
            if handle in featured:
                return 0
        return 1
    deduped.sort(key=lambda ev: (
        _featured_rank(ev),
        (ev.date_start.date() if ev.date_start else date.max),
        ev.date_start or datetime.max.replace(tzinfo=timezone.utc),
    ))

    # Pull the venue→coords map once per request so every event's
    # _to_frontend lookup is O(1). Map is small (~150 venues) — fits
    # easily in memory and the geocoded subset is what we actually use.
    venue_coords = db.get_venue_coords_map()

    return {
        "events": [_to_frontend(ev, venue_coords=venue_coords) for ev in deduped],
        "total": len(deduped),
        "city": settings.city,
    }


# Portuguese stopwords + connectors that don't carry meaning for event-name
# similarity. Tuned for the typical Curitiba event title — short, descriptive,
# often uses "no/do/da/de/em" articles and edition markers ("3ª edição").
_PT_STOPWORDS = frozenset({
    "a", "o", "as", "os", "um", "uma", "uns", "umas",
    "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
    "para", "pra", "por", "com", "sem",
    "e", "ou", "mas",
    "ao", "aos", "à", "às",
    "the", "of", "in", "at", "and", "to", "for",
    "edicao", "edição", "edition", "ed",
})

def _name_tokens(name: str) -> frozenset[str]:
    """
    Normalize a name to a token set for fuzzy matching:
      lowercase, strip accents, drop punctuation, split on whitespace,
      drop stopwords + tokens shorter than 3 chars (a/no/de/etc.).
    """
    if not name:
        return frozenset()
    # NFKD strips combining marks (à → a, ç → c, é → e)
    folded = unicodedata.normalize("NFKD", name)
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    folded = folded.lower()
    # Replace anything non-alphanumeric with whitespace
    folded = re.sub(r"[^a-z0-9]+", " ", folded)
    tokens = folded.split()
    return frozenset(t for t in tokens if len(t) >= 3 and t not in _PT_STOPWORDS)


def _dedupe_events(events):
    """
    Drop events that are likely the same thing scraped from multiple sources.

    Tiers, in order of confidence:
      1. Exact match on (normalized name, day) — fast.
      2. Same day + same hour + venue overlap (Jaccard ≥ 0.4 on venue
         tokens, or one venue contained in the other). Strongest signal:
         a venue rarely hosts two distinct events at the same hour.
      2.5. Same day + venue overlap + name share (≥ 0.4) — different
         hours but clearly the same event with multiple sessions or
         scrape variants ("Brasilidades 13 Anos - Festa de Dia" 15h vs
         "Brasilidades 13 anos" 19h, same venue → keep earliest).
      3. Same day + name fuzzy ≥ 0.6 (no venue/hour gate) — catches
         near-misses like "Caça à Arte no MON sem Paredes" vs "MON sem
         Paredes — Arte ao Ar Livre".

    Input is sorted by date_start ASC upstream, so "first occurrence wins"
    means the earliest-time variant survives — which is what we want for
    Tier 2.5 (multiple sessions of the same event collapse to the early one).
    """
    NAME_JACCARD = 0.6
    # When venue already matches, accept lower Jaccard but require at
    # least 2 shared distinctive tokens. Pure Jaccard at 0.3 would
    # false-positive on "Show de Música" vs "Workshop de Música" (1
    # shared token); requiring ≥ 2 shared tokens fixes that.
    NAME_VENUE_SHARED_MIN = 2
    NAME_VENUE_JACCARD = 0.3
    VENUE_JACCARD = 0.4
    out = []
    for ev in events:
        ev_day = ev.date_start.date().isoformat() if ev.date_start else ""
        ev_hour = ev.date_start.strftime("%H:%M") if ev.date_start else ""
        ev_name_tokens = _name_tokens(ev.name)
        ev_venue_tokens = _name_tokens(ev.venue_name or "")
        is_dup = False
        for kept in out:
            kept_day = kept.date_start.date().isoformat() if kept.date_start else ""
            if ev_day != kept_day:
                continue

            kept_venue_tokens = _name_tokens(kept.venue_name or "")
            venue_match = False
            if ev_venue_tokens and kept_venue_tokens:
                vinter = len(ev_venue_tokens & kept_venue_tokens)
                vunion = len(ev_venue_tokens | kept_venue_tokens)
                if (vunion and vinter / vunion >= VENUE_JACCARD) \
                   or ev_venue_tokens.issubset(kept_venue_tokens) \
                   or kept_venue_tokens.issubset(ev_venue_tokens):
                    venue_match = True

            # Tier 2: same hour + venue overlap
            if ev_day and ev_hour and venue_match:
                kept_hour = kept.date_start.strftime("%H:%M") if kept.date_start else ""
                if ev_hour == kept_hour:
                    is_dup = True
                    break

            # Tier 2.5: venue overlap + name share — different hours OK
            if venue_match and ev_name_tokens:
                kept_name_tokens = _name_tokens(kept.name)
                if kept_name_tokens:
                    inter = len(ev_name_tokens & kept_name_tokens)
                    union = len(ev_name_tokens | kept_name_tokens)
                    if union and inter >= NAME_VENUE_SHARED_MIN \
                       and inter / union >= NAME_VENUE_JACCARD:
                        is_dup = True
                        break

            # Tier 3: name fuzzy on the same day, no venue requirement
            kept_name_tokens = _name_tokens(kept.name)
            if not ev_name_tokens or not kept_name_tokens:
                if ev.name.strip().lower() == kept.name.strip().lower():
                    is_dup = True
                    break
                continue
            inter = len(ev_name_tokens & kept_name_tokens)
            union = len(ev_name_tokens | kept_name_tokens)
            if union and inter / union >= NAME_JACCARD:
                is_dup = True
                break
        if not is_dup:
            out.append(ev)
    return out


def _dedupe_feed_entries(entries: list[dict]) -> list[dict]:
    """
    Same dedup rules as `_dedupe_events`, but on the dict shape used by
    /friends/feed: {event_id, event_name, event_venue, event_date,
    friends_going[]}. When two entries collapse, their friends_going
    lists merge (dedup by google_id) so the count stays accurate.
    """
    NAME_JACCARD = 0.6
    NAME_VENUE_SHARED_MIN = 2
    NAME_VENUE_JACCARD = 0.3
    VENUE_JACCARD = 0.4

    def _parse_iso_date(s: str):
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return None

    def _venue_first_part(venue: str) -> str:
        # "Pedreira Paulo Leminski · Centro" → "Pedreira Paulo Leminski"
        return (venue or "").split("·")[0].strip()

    out: list[dict] = []
    for ev in entries:
        ev_dt = _parse_iso_date(ev.get("event_date") or "")
        ev_day = ev_dt.date().isoformat() if ev_dt else ""
        ev_hour = ev_dt.strftime("%H:%M") if ev_dt else ""
        ev_name_tokens = _name_tokens(ev.get("event_name") or "")
        ev_venue_tokens = _name_tokens(_venue_first_part(ev.get("event_venue") or ""))
        merged = False
        for kept in out:
            kept_dt = _parse_iso_date(kept.get("event_date") or "")
            kept_day = kept_dt.date().isoformat() if kept_dt else ""
            if ev_day != kept_day:
                continue
            kept_hour = kept_dt.strftime("%H:%M") if kept_dt else ""

            kept_venue_tokens = _name_tokens(_venue_first_part(kept.get("event_venue") or ""))
            venue_match = False
            if ev_venue_tokens and kept_venue_tokens:
                vinter = len(ev_venue_tokens & kept_venue_tokens)
                vunion = len(ev_venue_tokens | kept_venue_tokens)
                if (vunion and vinter / vunion >= VENUE_JACCARD) \
                   or ev_venue_tokens.issubset(kept_venue_tokens) \
                   or kept_venue_tokens.issubset(ev_venue_tokens):
                    venue_match = True

            is_dup = False
            # Tier 2: same hour + venue overlap
            if ev_hour and ev_hour == kept_hour and venue_match:
                is_dup = True
            # Tier 2.5: venue overlap + relaxed name match (collapses different
            # session times of the same event)
            if not is_dup and venue_match and ev_name_tokens:
                kept_name_tokens = _name_tokens(kept.get("event_name") or "")
                if kept_name_tokens:
                    inter = len(ev_name_tokens & kept_name_tokens)
                    union = len(ev_name_tokens | kept_name_tokens)
                    if union and inter >= NAME_VENUE_SHARED_MIN \
                       and inter / union >= NAME_VENUE_JACCARD:
                        is_dup = True
            # Tier 3: name fuzzy on the same day
            if not is_dup and ev_name_tokens:
                kept_name_tokens = _name_tokens(kept.get("event_name") or "")
                if kept_name_tokens:
                    inter = len(ev_name_tokens & kept_name_tokens)
                    union = len(ev_name_tokens | kept_name_tokens)
                    if union and inter / union >= NAME_JACCARD:
                        is_dup = True
            if is_dup:
                # Merge friends_going dedup'd by google_id
                seen_gids = {f.get("google_id") for f in kept["friends_going"] if f.get("google_id")}
                for f in ev["friends_going"]:
                    if f.get("google_id") and f["google_id"] not in seen_gids:
                        kept["friends_going"].append(f)
                        seen_gids.add(f["google_id"])
                merged = True
                break
        if not merged:
            out.append(ev)
    return out


# Cities that have shown up in scraped data despite NOT being Curitiba.
# Used as a deny-list at API time so retroactively bad events vanish without
# requiring a DB migration. New scrapers should also filter at ingest time.
_NON_CURITIBA_TOKENS = (
    "vacaria", "caçador", "cacador", "joaçaba", "joacaba", "concórdia",
    "concordia", "videira", "canoinhas", "rio do sul", "toledo",
    "londrina", "maringá", "maringa", "florianópolis", "florianopolis",
    "porto alegre", "são paulo", "sao paulo", "rio de janeiro",
)


# Name/description keywords that signal an event we never want to recommend
# regardless of what the LLM enrichment said. Defense-in-depth: the prompt
# tells Claude to flag these false, and this catches the cases it misses.
# HARD content deny — always applied, regardless of curated mode. These are
# events nobody opening Reroot wants to discover: closed initiatic groups
# and virtual placeholder leaks.
_HARD_CONTENT_DENY_TOKENS = (
    # closed religious rituals / esoteric initiatic groups
    "ritualística", "ritualistica", "convocação ritual", "convocacao ritual",
    "rosacruz", "rosicrucian", "iipc", "espiritualidade iniciática",
    "h. spencer lewis", "conselho de solace", "auditório solace",
    # virtual signals — these are scraper leaks, not real Curitiba events
    "virtual event", "evento virtual", "live webinar", "online webinar",
)

# CURATED content deny — only applied when the user asks for the curated view.
# These ARE legitimate Curitiba events; they just aren't a fit for the original
# Reroot "low-pressure social re-entry" vibe. In broad/all-events mode users
# can still see them.
_CURATED_CONTENT_DENY_TOKENS = (
    # business / networking / career
    "founders", "ceos", "career fair", "job fair", "feira de carreira",
    "marketing day", "growth marketing", "vendas b2b",
    "semana s do comércio", "semana s do comercio",
    # technical / corporate training
    "treinamento técnico", "treinamento tecnico", "certificação técnica",
)

# Specific venues we know belong to closed esoteric/private groups in Curitiba.
# Anything happening here gets dropped regardless of name. Hard filter.
_VENUE_DENY_SUBSTRINGS = (
    "nicarágua, 2620", "nicaragua, 2620",  # AMORC / Templo Rosacruz Curitiba
)


def _passes_content_filter(ev, curated: bool = False) -> bool:
    """
    Drop events whose name/description/venue match a deny-list.

    Hard rules (always): closed esoteric groups, virtual placeholders, AMORC
    temple address. These are filtered even in the broad "Tudo" view.

    Curated rules (only when curated=True): business networking, career
    fairs, corporate training. These are real Curitiba events but not the
    original Reroot vibe — broad-view users can still see them.
    """
    blob = f"{ev.name} {ev.description or ''}".lower()
    if any(token in blob for token in _HARD_CONTENT_DENY_TOKENS):
        return False
    venue_blob = f"{ev.venue_name or ''} {ev.venue_address or ''}".lower()
    if any(token in venue_blob for token in _VENUE_DENY_SUBSTRINGS):
        return False
    if curated and any(token in blob for token in _CURATED_CONTENT_DENY_TOKENS):
        return False
    return True


def _is_active_source(ev) -> bool:
    """
    Drop events whose source is no longer being monitored. Two cases:
      1. Legacy rows from scrapers we removed (sympla, eventbrite, sesc,
         catraca_livre, etc.) — they sit in the DB until their date passes.
      2. IG events from handles a curator deleted/disabled.

    Only `aue_original` (institutional) and `instagram` (for currently-
    enabled handles) are kept. External_id for IG is `ig_<handle>_<post>`,
    so we extract the handle from the prefix.
    """
    source = (ev.source or "").lower()
    if source == "aue_original":
        return True
    if source == "instagram":
        ext = ev.external_id or ""
        if not ext.startswith("ig_"):
            return False
        # Format: ig_<handle>_<post_id> — handle is everything between the
        # first and last underscore.
        rest = ext[3:]
        idx = rest.rfind("_")
        if idx <= 0:
            return False
        handle = rest[:idx].lower()
        return handle in _enabled_ig_handles()
    # Any other source (sympla, eventbrite, ingresso, meetup, sesc, mon,
    # teatro_guaira, turismo_curitiba, catraca_livre, google_places…)
    # is from a scraper we no longer run.
    return False


@functools.lru_cache(maxsize=1)
def _enabled_ig_handles_cached() -> frozenset[str]:
    return frozenset(a["handle"].lower() for a in db.get_enabled_ig_accounts())


def _enabled_ig_handles() -> frozenset[str]:
    """Cached lookup of currently-enabled IG handles. Cached for the life of
    the process — handle changes via /admin/ig-accounts call _bust_handle_cache
    so the catalog reflects them on the next /events fetch."""
    return _enabled_ig_handles_cached()


@functools.lru_cache(maxsize=1)
def _curator_ig_handles_cached() -> frozenset[str]:
    """Subset of enabled handles whose category is 'curador' — aggregator
    pages that repost other venues' events rather than hosting their own.
    Used to break dedup ties: when the same event is captured by both a
    venue handle and a curator, we keep the venue's version (richer info,
    canonical time/venue)."""
    return frozenset(
        a["handle"].lower()
        for a in db.get_enabled_ig_accounts()
        if (a.get("category") or "").lower() == "curador"
    )


@functools.lru_cache(maxsize=1)
def _featured_ig_handles_cached() -> frozenset[str]:
    """Handles flagged as 'Destaque' (paid placement). Drives top-of-list
    sorting on Sources + Events plus a star pill on the cards."""
    return frozenset(
        a["handle"].lower()
        for a in db.list_ig_accounts()
        if a.get("featured")
    )


@functools.lru_cache(maxsize=1)
def _venue_promo_cached() -> dict[str, dict]:
    """{handle: {code, perk}} for every featured handle that has a
    non-empty promo_code set. Non-featured handles are excluded — promo
    codes ride with the paid Seleção auê placement, not with the free
    listing. Bust the cache when admin edits the code or toggles
    featured."""
    out = {}
    for a in db.list_ig_accounts():
        if not a.get("featured"):
            continue
        code = (a.get("promo_code") or "").strip()
        if not code:
            continue
        out[a["handle"].lower()] = {
            "code": code,
            "perk": (a.get("promo_perk") or "").strip(),
        }
    return out


def _bust_handle_cache() -> None:
    _enabled_ig_handles_cached.cache_clear()
    _curator_ig_handles_cached.cache_clear()
    _featured_ig_handles_cached.cache_clear()
    _venue_promo_cached.cache_clear()


def _handle_for_event(ev) -> str:
    """Extract the IG handle from an event's external_id. Returns '' for
    non-IG events (aue_original) or malformed ids."""
    if (ev.source or "").lower() != "instagram":
        return ""
    ext = ev.external_id or ""
    if not ext.startswith("ig_"):
        return ""
    rest = ext[3:]
    idx = rest.rfind("_")
    if idx <= 0:
        return ""
    return rest[:idx].lower()


def _handle_from_event_id(event_id: str) -> str:
    """Extract IG handle from a frontend-shaped catalog event id of the
    form `instagram_ig_<handle>_<post>`. Returns '' for non-IG ids
    (aue_original, group events, anything malformed). Used to attribute
    forked group events back to their source venue's Painel."""
    eid = (event_id or "").strip()
    if not eid.startswith("instagram_ig_"):
        return ""
    rest = eid[len("instagram_ig_"):]
    idx = rest.rfind("_")
    if idx <= 0:
        return ""
    return rest[:idx].lower()


def _is_curator_event(ev) -> bool:
    """True when the event came from a handle categorized as 'curador'.
    aue_original and venue handles return False — they're treated as
    primary-host candidates in dedup ordering."""
    return _handle_for_event(ev) in _curator_ig_handles_cached()


def _is_in_curitiba(ev) -> bool:
    """
    Heuristic that drops two kinds of bad events left over in the DB from older
    scrapes:
      1. Empty venue_name AND empty venue_address — almost always a virtual or
         placeholder event the discovery page leaked in.
      2. venue/address/neighborhood that explicitly names another Brazilian
         city we know our scrapers have leaked.
    """
    venue = (ev.venue_name or "").strip()
    addr = (ev.venue_address or "").strip()
    if not venue and not addr:
        return False

    haystack = " ".join([venue.lower(), addr.lower(), (ev.neighborhood or "").lower()])
    for token in _NON_CURITIBA_TOKENS:
        if token in haystack:
            return False
    return True


def _group_event_to_frontend(ge: dict, group_name: str = "") -> dict:
    """Shape a `group_events` row into the EnrichedEvent dict the frontend
    consumes. Used by GET /events/{id} and GET /events/group so both paths
    return identical shapes."""
    from datetime import datetime as _dt
    ds = ge.get("date_start") or ""
    try:
        dt = _dt.fromisoformat(ds.replace("Z", "+00:00")) if ds else None
    except (ValueError, AttributeError):
        dt = None
    time_str = dt.strftime("%H:%M") if dt else ""
    date_label = dt.strftime("%a, %d %b") if dt else ""
    # Empty venue stays empty — the frontend conditionally renders the
    # venue line, so a missing field just collapses cleanly. (Earlier we
    # fell back to "Evento de grupo" / "Plano" placeholders, but that
    # showed up as fake-looking venue text in the card and detail view.)
    venue = ge.get("venue") or ""
    # Catalog imports stash "Ver original: <url>" at the end of the
    # description. Pull it out so the frontend's existing "Ver no <source>"
    # button works, and remove from description so it doesn't duplicate
    # above the button.
    raw_desc = ge.get("description") or ""
    url_match = re.search(r"Ver original:\s*(\S+)", raw_desc)
    event_url = url_match.group(1).rstrip(".,;") if url_match else ""
    cleaned_desc = re.sub(r"\n*Ver original:.*$", "", raw_desc).strip()
    # Personal plans (no group_id) flagged separately so the frontend can
    # show "Convite de Ciro" instead of a group label, and to bypass any
    # group-membership UI affordances.
    is_personal = not ge.get("group_id")
    return {
        "id": ge["id"],
        "name": ge.get("name") or "",
        "category": "community",
        "categoryLabel": "Plano" if is_personal else "Grupo",
        "categoryEmoji": "🎲" if is_personal else "👥",
        "venue": venue,
        "date": date_label,
        "time": time_str,
        "duration": "",
        "headerBg": "linear-gradient(135deg, #FFE0B2, #FFCC80)",
        "icon": "🎲" if is_personal else "👥",
        "description": cleaned_desc,
        "price": "",
        "priceTier": "free",
        "kidsWelcome": False,
        "hasFood": False,
        "isLowPressure": False,
        "attendeesConfirmed": 0,
        "expectedSize": "intimate",
        "vibeSummary": "",
        "pitch": "",
        "url": event_url,
        "source": "group",
        "igHandle": None,
        "dateStart": ds,
        "venueAddress": "",
        "city": "Curitiba",
        "imageUrl": None,
        "isCustom": False,
        # Group-event markers — the frontend uses these to render the lock
        # pill, group-name link, and to gate any "private" affordances.
        # Personal plans set isPersonalPlan=true; isGroupEvent stays true
        # so the existing "private/yours" sage stripe is reused.
        "isGroupEvent": True,
        "isPersonalPlan": is_personal,
        "groupId": ge.get("group_id"),
        "groupName": group_name,
        "createdBy": ge.get("created_by"),
        "inviteeCount": len(ge.get("extra_invitee_ids", []) or []),
        "note": ge.get("note") or "",
        # Source venue handle when this row was forked from a public IG
        # catalog event. Frontend uses it to fire `event_view` analytics
        # against the source venue so the original Painel still gets
        # credit for downstream attention.
        "sourceIgHandle": ge.get("source_ig_handle") or "",
    }


@app.get("/events/group")
def list_user_group_events(google_id: str):
    """Return all upcoming private events the user can see:
      - Group events from groups they're a member of (classic case)
      - Personal plans where they're creator OR in extra_invitee_ids
      - Group + extras events where they're an invited friend even
        though they're not in the group
    Shaped like catalog events. Server-side gated by membership /
    invitee status."""
    if not google_id:
        return {"events": []}
    today = date.today().isoformat()
    out: list[dict] = []
    seen_ids: set[str] = set()

    def _push(ge: dict, group_name: str = "") -> None:
        ds = ge.get("date_start") or ""
        if ds and ds[:10] < today:
            return
        if ge["id"] in seen_ids:
            return
        seen_ids.add(ge["id"])
        out.append(_group_event_to_frontend(ge, group_name=group_name))

    # Group events you're a member of
    for g in db.get_groups_for_user(google_id):
        for ge in db.get_group_events(g["id"], is_member=True):
            _push(ge, group_name=g.get("name") or "")

    # Personal plans — creator OR extra invitee
    for ge in db.get_personal_plans_for_user(google_id):
        _push(ge)

    # Group + extras events where you're an extra invitee but not a member
    for ge in db.get_group_events_with_extras_for_user(google_id):
        # Skip if already seen via group membership
        _push(ge)

    out.sort(key=lambda e: e.get("dateStart") or "9999-99-99")
    return {"events": out}


@app.get("/events/{event_id}")
def get_event(event_id: str, google_id: str = ""):
    # Catalog events first.
    ev = db.get_event_by_id(event_id)
    if ev:
        return _to_frontend(ev, detail=True, venue_coords=db.get_venue_coords_map())

    # Fallback: group events (ids start with "grp_ev_") so a friend's
    # public-group RSVP can be opened from the catalog detail panel.
    # Personal plans live in the same table; visibility is creator-or-
    # invitee. We require google_id for personal plans (no public reads).
    if event_id.startswith("grp_ev_"):
        ge = db.get_group_event(event_id)
        if ge:
            invitees = ge.get("extra_invitee_ids") or []
            creator_id = ge.get("created_by")
            group_id = ge.get("group_id")
            if group_id:
                # Group event. Visibility decides who can read via the
                # link: 'public' = anyone, 'members' = only the group's
                # members + any extra invitees + the creator.
                visibility = (ge.get("visibility") or "members").lower()
                if visibility == "public":
                    group = db.get_group(group_id)
                    return _group_event_to_frontend(ge, group_name=(group or {}).get("name") or "")
                # 'members' (default) — gate by membership / invitee / creator.
                is_member = bool(google_id and db.get_group_member_role(group_id, google_id))
                is_invitee = bool(google_id and google_id in invitees)
                is_creator = bool(google_id and google_id == creator_id)
                if is_member or is_invitee or is_creator:
                    group = db.get_group(group_id)
                    return _group_event_to_frontend(ge, group_name=(group or {}).get("name") or "")
                raise HTTPException(
                    status_code=403,
                    detail="Evento privado de grupo — só membros do grupo podem ver",
                )
            # Personal plan (no group_id): only creator + invitees may see it.
            if google_id and (google_id == creator_id or google_id in invitees):
                return _group_event_to_frontend(ge)
            raise HTTPException(status_code=403, detail="Plano privado — só convidados podem ver")

    raise HTTPException(status_code=404, detail="Evento não encontrado")


@app.post("/events/refresh")
async def trigger_refresh(background_tasks: BackgroundTasks):
    """Força um refresh manual — útil durante desenvolvimento."""
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=400, detail="ANTHROPIC_API_KEY não configurada")
    background_tasks.add_task(run_refresh, settings)
    return {"message": "Refresh iniciado em background"}


@app.get("/events/stats/summary")
def stats():
    """Resumo para debugging — quantos eventos por categoria."""
    events = db.get_events(city=settings.city, good_only=False, limit=200)
    by_cat: dict = {}
    for ev in events:
        by_cat[ev.kind] = by_cat.get(ev.kind, 0) + 1

    return {
        "total": len(events),
        "is_curated": sum(1 for e in events if e.is_curated),
        "by_category": by_cat,
        "sources": {
            src: sum(1 for e in events if e.source == src)
            for src in [
                "instagram",
                "ai_generated", "submitted", "aue_original",
            ]
        },
    }


# ── User event submission ──────────────────────────────────

class EventSubmission(BaseModel):
    name: str
    description: str = ""
    venue_name: str
    venue_address: str = ""
    city: str = "Curitiba"
    date_start: str                   # ISO 8601 string from frontend
    price_min: float = 0.0
    price_max: float = 0.0
    url: str = ""
    submitted_by: Optional[str] = None  # google_id


async def _enrich_and_save_submission(submission_id: int, req: EventSubmission):
    """Background task: enrich a submitted event with Claude then upsert into events table."""
    if not settings.anthropic_api_key:
        return

    from enrichment import EnrichmentPipeline
    from models import RawEvent
    from datetime import timezone as tz

    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            ds = __import__("datetime").datetime.strptime(req.date_start, fmt).replace(tzinfo=tz.utc)
            break
        except ValueError:
            ds = None

    if not ds:
        log.warning(f"Submission {submission_id}: invalid date_start '{req.date_start}'")
        return

    raw = RawEvent(
        source="submitted",
        external_id=f"sub_{submission_id}",
        name=req.name[:200],
        description=req.description[:1000],
        venue_name=req.venue_name[:200],
        venue_address=req.venue_address[:300],
        city=req.city,
        date_start=ds,
        price_min=req.price_min,
        price_max=req.price_max,
        url=req.url[:500],
    )

    pipeline = EnrichmentPipeline(api_key=settings.anthropic_api_key)
    enriched = pipeline.enrich(raw)
    if not enriched:
        log.warning(f"Submission {submission_id}: enrichment failed")
        return

    try:
        db.upsert_event(enriched)
        db.mark_submitted_enriched(submission_id, enriched.id)
        log.info(f"Submission {submission_id}: enriched → {enriched.id} ({enriched.kind})")
    except Exception as e:
        log.error(f"Submission {submission_id}: save error: {e}")


# ── Sources catalog ─────────────────────────────────────────────────────
# Transparency surface: lists every source the catalog pulls from with a
# future-event count. Powers the `/sources` screen on the frontend.
#
# Apr 2026: dropped every web/institutional scraper (MON, SESC, Teatro
# Guaíra, Eventbrite, Turismo Curitiba) — yields were near-zero for our
# public, and the equivalent IG handles for those venues are already
# tracked. aue_original stays as the curated-seed slot.
_INSTITUTIONAL_SOURCES = {
    "aue_original": {
        "label": "Seleção auê",
        "url": "",
        "icon": "⭐",
        "blurb": "Eventos curados pela equipe do auê.",
    },
}


@app.get("/sources")
def list_sources():
    """
    Catalog of every monitored source with a future-event count. The
    frontend uses this for the Sources screen — transparency surface that
    shows users where the catalog comes from.

    Counts reflect the same dedup the catalog/source-detail apply, so a
    handle with 4 raw rows that collapse to 2 events shows "2" here.
    """
    def _deduped_count(events_list) -> int:
        cleaned = [
            ev for ev in events_list
            if _passes_content_filter(ev, curated=False) and _is_in_curitiba(ev)
        ]
        return len(_dedupe_events(cleaned))

    institutional = []
    for src_id, meta in _INSTITUTIONAL_SOURCES.items():
        evs = db.get_future_events_by_source(src_id, limit=500)
        institutional.append({
            "id": src_id,
            "label": meta["label"],
            "url": meta["url"],
            "icon": meta["icon"],
            "blurb": meta["blurb"],
            "future_events": _deduped_count(evs),
        })
    institutional.sort(key=lambda s: (-s["future_events"], s["label"]))

    instagram = []
    for acc in db.list_ig_accounts():
        if not acc.get("enabled"):
            continue
        evs = db.get_future_events_by_source("instagram", ig_handle=acc["handle"], limit=200)
        instagram.append({
            "handle": acc["handle"],
            "label": acc.get("display_name") or acc.get("label") or f"@{acc['handle']}",
            "category": acc.get("category", ""),
            "url": f"https://www.instagram.com/{acc['handle']}/",
            "last_scraped_at": acc.get("last_scraped_at"),
            "future_events": _deduped_count(evs),
            "profile_pic_url": acc.get("profile_pic_url") or "",
            "featured": bool(acc.get("featured")),
        })
    # Featured handles (Destaque) lift to the top regardless of event count;
    # within each tier, busier handles first, then alphabetical. Same logic
    # is shown on the Sources screen with a star pill.
    instagram.sort(key=lambda s: (
        not s["featured"],
        -s["future_events"],
        s["label"],
    ))

    return {"institutional": institutional, "instagram": instagram}


@app.get("/sources/{source_id}")
def source_detail(source_id: str):
    """
    Detail for a single source: metadata + upcoming events.
    `source_id` can be "aue_original" or "ig:<handle>" for an Instagram handle.
    """
    today = date.today().isoformat()
    if source_id.startswith("ig:"):
        handle = source_id[3:]
        accounts = {a["handle"]: a for a in db.list_ig_accounts()}
        acc = accounts.get(handle)
        if not acc:
            raise HTTPException(status_code=404, detail="Conta IG não encontrada")
        events = db.get_future_events_by_source("instagram", ig_handle=handle, limit=200)
        meta = {
            "id": source_id,
            "label": acc.get("display_name") or acc.get("label") or f"@{handle}",
            "url": f"https://www.instagram.com/{handle}/",
            "icon": "📷",
            # Prefer the real IG bio when we've enriched it; fall back to
            # the curator-set label or a generic note.
            "blurb": (
                acc.get("bio_snippet") or acc.get("category", "")
                or f"Perfil monitorado @{handle}."
            ),
            "bio": acc.get("bio_snippet", ""),  # full bio for display
            "profile_pic_url": acc.get("profile_pic_url", ""),
            "category": acc.get("category", ""),
            "last_scraped_at": acc.get("last_scraped_at"),
        }
    else:
        meta_src = _INSTITUTIONAL_SOURCES.get(source_id)
        if not meta_src:
            raise HTTPException(status_code=404, detail="Fonte não encontrada")
        events = db.get_future_events_by_source(source_id, limit=200)
        meta = {
            "id": source_id,
            "label": meta_src["label"],
            "url": meta_src["url"],
            "icon": meta_src["icon"],
            "blurb": meta_src["blurb"],
        }
    # Apply the same filters as /events so the detail view doesn't surface
    # events the catalog already hides — content/region filter PLUS dedup.
    # Without dedup, near-duplicates that the catalog collapses (e.g. five
    # variants of one MON concert) re-appear here.
    cleaned = [
        ev for ev in events
        if _passes_content_filter(ev, curated=False) and _is_in_curitiba(ev)
    ]
    deduped = _dedupe_events(cleaned)
    venue_coords = db.get_venue_coords_map()
    return {
        "source": meta,
        "events": [_to_frontend(ev, venue_coords=venue_coords) for ev in deduped],
        "total": len(deduped),
    }


@app.post("/events/submit", status_code=202)
async def submit_event(req: EventSubmission, background_tasks: BackgroundTasks):
    """
    Accept a user- or partner-submitted event.
    The event is recorded immediately; enrichment runs in the background.
    Returns the submission id so the frontend can poll for status.
    """
    # Basic input validation
    if not req.name or len(req.name.strip()) < 3:
        raise HTTPException(status_code=400, detail="Event name too short")
    if len(req.name) > 200 or len(req.description) > 2000:
        raise HTTPException(status_code=400, detail="Input exceeds maximum length")
    if not req.venue_name or len(req.venue_name.strip()) < 2:
        raise HTTPException(status_code=400, detail="Venue name required")

    submission_id = db.insert_submitted_event(
        name=req.name.strip(),
        description=req.description.strip(),
        venue_name=req.venue_name.strip(),
        venue_address=req.venue_address.strip(),
        city=req.city.strip() or settings.city,
        date_start=req.date_start,
        price_min=req.price_min,
        price_max=req.price_max,
        url=req.url.strip(),
        submitted_by=req.submitted_by,
    )

    if settings.anthropic_api_key:
        background_tasks.add_task(_enrich_and_save_submission, submission_id, req)

    return {"ok": True, "submission_id": submission_id, "status": "pending"}


# ── User state sync ──

class UserStateSaveRequest(BaseModel):
    google_id: str
    state: dict


@app.get("/user/state/{google_id}")
def get_user_state_endpoint(google_id: str):
    """Load persisted app state for a Google account."""
    saved = db.get_user_state(google_id)
    if saved is None:
        raise HTTPException(status_code=404, detail="No state found for this user")
    return {"state": saved}


REQUIRED_STATE_KEYS = {"hasJoined", "language", "rsvps"}
MAX_STATE_SIZE_BYTES = 512_000  # 500 KB — generous but prevents abuse


@app.post("/user/state")
def save_user_state_endpoint(req: UserStateSaveRequest):
    """Upsert app state for a Google account with validation."""
    if not req.google_id or len(req.google_id) > 200:
        raise HTTPException(status_code=400, detail="Invalid google_id")

    # Validate state is a reasonable object
    if not isinstance(req.state, dict) or not REQUIRED_STATE_KEYS.issubset(req.state.keys()):
        log.warning(f"State validation failed for {req.google_id[:20]}: missing keys")
        raise HTTPException(status_code=400, detail="Invalid state object — missing required keys")

    state_json = json.dumps(req.state)
    if len(state_json) > MAX_STATE_SIZE_BYTES:
        log.warning(f"State too large for {req.google_id[:20]}: {len(state_json)} bytes")
        raise HTTPException(status_code=400, detail="State object too large")

    db.upsert_user_state(req.google_id, req.state)
    return {"ok": True, "saved_at": int(__import__('time').time() * 1000)}


# ── RSVPs ──────────────────────────────────────────────────

class RsvpUpsertRequest(BaseModel):
    google_id: str
    event_id: str
    event_name: str
    event_venue: str = ""
    event_date: str = ""
    event_url: str = ""


@app.post("/rsvp")
def rsvp_upsert(req: RsvpUpsertRequest):
    """Record that a user is going to an event (normalized, queryable).
    Side-effects: evaluates the badge engine + (when this is a NEW
    RSVP, not a re-confirm) pushes a notification to friends with
    privacy.shareRsvps = true."""
    is_new = not db.rsvp_exists(req.google_id, req.event_id)
    db.upsert_rsvp(
        google_id=req.google_id,
        event_id=req.event_id,
        event_name=req.event_name,
        event_venue=req.event_venue,
        event_date=req.event_date,
        event_url=req.event_url,
    )
    new_badges = badges.evaluate(req.google_id)

    # Notify friends — only on a fresh RSVP (toggle off→on cycles
    # don't re-spam) and only if the user opted in to sharing.
    if is_new and _user_share_rsvps(req.google_id):
        user_name = _user_display_name(req.google_id)
        # Tag includes (user, event) so multiple friends RSVPing the same
        # event don't pile up — each user/event pair gets one slot.
        tag = f"friend-rsvp-{req.google_id}-{req.event_id}"
        for friend in db.get_friends(req.google_id):
            if friend.get("status") != "accepted":
                continue
            _send_push_to_user(
                friend["google_id"],
                title=f"🎉 {user_name} vai",
                body=req.event_name,
                url="/",
                tag=tag,
            )

    return {"ok": True, "new_badges": new_badges}


@app.delete("/rsvp/{event_id}")
def rsvp_delete(event_id: str, google_id: str):
    """Remove an RSVP for the given user/event pair."""
    db.delete_rsvp(google_id=google_id, event_id=event_id)
    return {"ok": True}


# ── Badges ─────────────────────────────────────────────────

@app.get("/badges/catalog")
def badges_catalog():
    """Return the static catalog of all defined badges. Frontend uses this
    to render the full Conquistas list, with earned ones highlighted."""
    return {"badges": badges.catalog()}


@app.get("/user/{google_id}/badges")
def user_badges(google_id: str):
    """Return the badges this user has earned, newest first."""
    return {"badges": badges.for_user(google_id)}


@app.get("/user/{google_id}/stats")
def user_stats(google_id: str):
    """Lifetime / personal-best counters — feeds the 'Recordes' section on
    Profile. Anxiety-free: streak counter only tracks all-time best, never
    a fragile 'current streak' the user could break."""
    return badges.stats(google_id)


# ── Event attendees ────────────────────────────────────────

@app.get("/events/{event_id}/attendees")
def event_attendees(event_id: str, google_id: str):
    """
    Return list of users who RSVPed to this event, excluding the requester.
    Each attendee has google_id, name, picture, is_friend, and friend_code.
    """
    attendees = db.get_event_attendees(event_id, google_id)
    # Attach friend_code so the frontend can call addFriend directly
    for a in attendees:
        a["friend_code"] = db.get_friend_code(a["google_id"])
    return {"attendees": attendees}


# ── Friends ────────────────────────────────────────────────

class FriendAddRequest(BaseModel):
    google_id: str
    code: str


@app.get("/friends/my-code")
def friends_my_code(google_id: str):
    """Return the deterministic invite code for this user."""
    return {"code": db.get_friend_code(google_id)}


@app.get("/friends/lookup")
def friends_lookup(code: str):
    """
    Resolve an invite code to the inviter's profile (name + picture) so the
    AddFriend screen can show a confirmation before committing the friendship.
    Returns 404 if the code doesn't match a known user.
    """
    google_id = db._code_to_google_id(code)
    if not google_id:
        raise HTTPException(status_code=404, detail="Código inválido ou usuário não encontrado.")
    state = db.get_user_state(google_id) or {}
    return {
        "google_id": google_id,
        "name": state.get("userName") or "",
        "picture": (state.get("googleUser") or {}).get("picture") or "",
    }


@app.post("/friends/add")
def friends_add(req: FriendAddRequest):
    """
    Attempt to add a friendship using an invite code.
    Returns status 'ok' | 'self' | 'already_friends' | 'not_found'
    and, on success, the friend's display name.
    """
    result = db.upsert_friendship(
        requester_google_id=req.google_id,
        code=req.code,
    )
    if result["status"] == "ok":
        # Resolve friend name for the confirmation message
        friend_id = db._code_to_google_id(req.code)
        if friend_id:
            state = db.get_user_state(friend_id)
            if state:
                result["friend_name"] = state.get("userName") or friend_id
        # Award the "Galera junto" badge for first accepted friend.
        # Run for both sides so whoever crosses the threshold sees the toast.
        result["new_badges"] = badges.evaluate(req.google_id)
        if friend_id:
            badges.evaluate(friend_id)  # silent on the other side; they'll see it next load
    return result


@app.get("/friends")
def friends_list(google_id: str):
    """Return all accepted friends with their profile info."""
    friends = db.get_friends(google_id)
    return {"friends": friends}


@app.delete("/friends/{friend_google_id}")
def remove_friend(friend_google_id: str, google_id: str):
    """Remove a friendship. Either side can call this."""
    if not google_id or not friend_google_id:
        raise HTTPException(status_code=400, detail="google_id required")
    ok = db.remove_friendship(google_id, friend_google_id)
    return {"ok": ok}


@app.get("/friends/feed")
def friends_feed(google_id: str):
    """
    Return upcoming events that accepted friends have RSVPed to,
    grouped by event, each with a list of friends going.
    Only includes events with event_date >= today.
    """
    friends = db.get_friends(google_id)
    if not friends:
        return {"events": []}

    friend_ids = [f["google_id"] for f in friends]
    friend_map = {f["google_id"]: f for f in friends}

    # Filter out friends who disabled RSVP sharing in their privacy settings
    visible_ids = []
    for fid in friend_ids:
        friend_state = db.get_user_state(fid)
        if friend_state:
            privacy = friend_state.get("privacy", {})
            # Default to True (sharing on) if privacy key is absent — backward compat
            if not privacy.get("shareRsvps", friend_state.get("shareRsvps", True)):
                continue
        visible_ids.append(fid)

    if not visible_ids:
        return {"events": []}

    rsvps = db.get_rsvps_for_users(visible_ids)
    today = date.today().isoformat()

    # Privacy gate for group events: a friend's RSVP to a group event
    # (event_id starts with "grp_ev_") must be filtered out unless the
    # viewer is a member of that group. Otherwise the day-strip dot would
    # leak the existence of private plans the viewer can't even open.
    viewer_group_ids = {g["id"] for g in db.get_groups_for_user(google_id)}

    # Group by event_id, filter to future events
    grouped: dict[str, dict] = {}
    for rsvp in rsvps:
        if rsvp["event_date"] and rsvp["event_date"] < today:
            continue
        eid = rsvp["event_id"]
        if eid.startswith("grp_ev_"):
            ge = db.get_group_event(eid)
            if not ge or ge["group_id"] not in viewer_group_ids:
                continue
        if eid not in grouped:
            grouped[eid] = {
                "event_id": eid,
                "event_name": rsvp["event_name"],
                "event_venue": rsvp["event_venue"],
                "event_date": rsvp["event_date"],
                "event_url": rsvp["event_url"],
                "friends_going": [],
            }
        friend_info = friend_map.get(rsvp["google_id"], {})
        grouped[eid]["friends_going"].append({
            "google_id": rsvp["google_id"],
            "name": friend_info.get("name", rsvp["google_id"]),
            "picture": friend_info.get("picture", ""),
        })

    # Apply the same dedup rules as the catalog so users don't see "X amigo
    # vai" twice for the same event with different scraped variants. Merges
    # friends_going lists across collapsed entries.
    grouped_list = _dedupe_feed_entries(list(grouped.values()))
    grouped = {e["event_id"]: e for e in grouped_list}

    # Sort by event_date ascending, nulls last
    events = sorted(
        grouped.values(),
        key=lambda e: e["event_date"] or "9999-99-99",
    )
    return {"events": events}


# ── Venues (tracked IG handles by category) ──
#
# Was previously backed by Google Places (random bakeries, no curation).
# Now each chip surfaces the IG handles WE curate via tracked_ig_accounts,
# grouped by their `category` field. Tap a card → opens that handle's
# source page (recent events scraped from their IG feed).

_PLACES_TYPE_MAP: dict[str, list[str]] = {
    # chip id → list of category values stored on tracked_ig_accounts
    "bars_cafes": ["bar", "cafe", "restaurante"],
    "parks":      ["parque"],
    "cinema":     ["cinema"],
    "bookstore":  ["livraria"],
}

_PLACES_META: dict[str, dict] = {
    "bars_cafes": {
        "label": "Bares & Cafés", "emoji": "🍺", "icon": "🍺",
        "headerBg": "linear-gradient(135deg, #3d2d25 0%, #7a4e3a 100%)",
    },
    "parks": {
        "label": "Parques", "emoji": "🌿", "icon": "🌿",
        "headerBg": "linear-gradient(135deg, #2d3d25 0%, #4e7a3a 100%)",
    },
    "cinema": {
        "label": "Cinema", "emoji": "🎬", "icon": "🎬",
        "headerBg": "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
    },
    "bookstore": {
        "label": "Livrarias", "emoji": "📚", "icon": "📚",
        "headerBg": "linear-gradient(135deg, #2d2520 0%, #5c3d2e 100%)",
    },
}


@app.get("/places")
def list_places(type: str = "bars_cafes", limit: int = 50):
    """
    Returns the venues we curate for the given chip type, sourced from
    tracked_ig_accounts (NOT Google Places, which we removed). Each entry
    is shaped to look like an event-card so the existing Events tab UI
    can render it without forking; tap → /sources/ig:<handle>.
    """
    cats = _PLACES_TYPE_MAP.get(type, ["bar"])
    meta = _PLACES_META.get(type, _PLACES_META["bars_cafes"])
    cats_set = {c.lower() for c in cats}

    accounts = [
        a for a in db.list_ig_accounts()
        if a.get("enabled")
        and (a.get("category") or "").strip().lower() in cats_set
    ]

    # Compute future-event yield per handle so we can surface "rolling"
    # venues first — the handles that actually post events read as the
    # most alive bars/cafés to a browser.
    yields_by_handle = db.count_future_events_by_ig_handle()

    venues = [_ig_handle_to_venue(a, type, meta, yields_by_handle.get(a["handle"], 0))
              for a in accounts]
    venues.sort(key=lambda v: (-v["attendeesConfirmed"], v["name"].lower()))
    return {"places": venues[:limit], "total": len(venues), "type": type}


def _ig_handle_to_venue(acc: dict, chip_type: str, meta: dict, future_count: int) -> dict:
    """Shape a tracked_ig_accounts row as a venue card. Reuses the event
    shape so Events.jsx renders it without a separate code path."""
    handle = acc["handle"]
    name = acc.get("display_name") or acc.get("label") or f"@{handle}"
    cat = (acc.get("category") or "").lower()
    is_cafe = cat in ("cafe", "padaria")
    bio = (acc.get("bio_snippet") or "").strip()[:140]
    vibe = bio if bio else f"@{handle}"

    return {
        "id": f"ig_handle_{handle}",
        "name": name,
        "category": chip_type,
        "categoryLabel": meta["label"],
        "categoryEmoji": meta["emoji"],
        "venue": f"@{handle}",
        "date": "Sempre disponível",
        "time": "",
        "duration": "",
        "headerBg": meta["headerBg"],
        "icon": "☕" if is_cafe else meta["icon"],
        "price": "",
        "priceTier": "free",
        "hasFood": cat in ("bar", "cafe", "restaurante"),
        "isLowPressure": is_cafe,
        # attendeesConfirmed doubles as the sort key; using future-event
        # count makes "alive" venues bubble up.
        "attendeesConfirmed": future_count,
        "expectedSize": "intimate",
        "vibeSummary": vibe,
        "pitch": "",
        "url": f"https://www.instagram.com/{handle}/",
        "cohortGoing": [],
        "source": "instagram",
        "igHandle": handle,
        "isReal": True,
        "rating": 0,
        "placeSubtype": cat,
        # No "Aberto agora" — we don't have hours data. None hides the pill.
        "openNow": None,
        "imageUrl": acc.get("profile_pic_url") or None,
        # Future event count surfaced so the card can show "3 eventos próximos".
        "futureEventCount": future_count,
    }


# ── Serialização para o frontend ──

def _next_recurring_occurrence(reference_dt: datetime, days: list) -> datetime:
    """
    For a recurring event with stored `reference_dt` (potentially in the past),
    compute the next occurrence on/after now whose ISO weekday is in `days`
    (1=Mon … 7=Sun). Preserves the time-of-day from reference_dt.

    Used by _to_frontend so a routine's stored date_start can drift past
    without making the event vanish — we just compute the next match at
    serialization time.
    """
    if not days:
        return reference_dt
    now = datetime.now(timezone.utc)
    today_iso = now.isoweekday()
    valid = {int(d) for d in days if isinstance(d, (int, str)) and str(d).isdigit() and 1 <= int(d) <= 7}
    if not valid:
        return reference_dt
    for delta in range(0, 8):
        candidate_iso = ((today_iso - 1 + delta) % 7) + 1
        if candidate_iso not in valid:
            continue
        candidate_date = (now.date() + timedelta(days=delta))
        candidate_dt = datetime.combine(
            candidate_date,
            reference_dt.time(),
            tzinfo=reference_dt.tzinfo or timezone.utc,
        )
        if candidate_dt > now:
            return candidate_dt
    return reference_dt


def _to_frontend(ev, detail: bool = False, venue_coords: Optional[dict] = None) -> dict:
    """
    Converte EnrichedEvent para o formato que o React espera.
    Mantém consistência com o shape do data/events.js existente.

    `venue_coords` is an optional {normalized_key: {lat, lng}} map fetched
    once per /events call. Per-event lookups would be N queries — passing
    the map in keeps it batched. Events whose venue isn't in the map (or
    whose venue_name is empty) get lat/lng=None so the frontend can drop
    them from the map view but still show in list view.
    """
    price_label = _format_price(ev.price_min, ev.price_max, ev.currency)
    member_count = ev.attendees_confirmed  # "popularidade real"

    # Reroot Originals are evergreen suggestions, not scheduled events.
    is_original = ev.source == "aue_original"

    # Recurring routines: roll forward to the next occurrence whenever the
    # stored date_start is in the past. The DB query layer also keeps these
    # rows visible (is_recurring=1 OR date_start>=today), so the only thing
    # left here is to compute a sensible effective start for display.
    effective_start = ev.date_start
    is_recurring = bool(getattr(ev, "is_recurring", False))
    if is_recurring and ev.date_start < datetime.now(timezone.utc):
        effective_start = _next_recurring_occurrence(
            ev.date_start, getattr(ev, "recurrence_days", []) or []
        )

    # Long-running events (museum exhibitions, programs) often started months
    # ago but are still on. Showing their start date misleads — surface the
    # END date as "Em cartaz até …" instead.
    today = datetime.now(timezone.utc).date()
    is_ongoing = (
        not is_original
        and not is_recurring
        and ev.date_end is not None
        and effective_start.date() < today
        and ev.date_end.date() >= today
    )

    if is_original:
        date_label = "Sempre disponível"
    elif is_ongoing:
        date_label = f"Em cartaz até {_format_event_date(ev.date_end)}"
    elif is_recurring:
        # Show the human-readable label ("Toda quinta") next to the next date
        # so the user sees both the pattern and when it next happens.
        rec_label = (getattr(ev, "recurrence_label", None) or "").strip()
        if rec_label:
            date_label = f"{rec_label} · próx. {_format_event_date(effective_start)}"
        else:
            date_label = _format_event_date(effective_start)
    else:
        date_label = _format_event_date(effective_start)

    out = {
        "id": ev.id,
        "name": ev.name,
        "category": ev.kind,
        "categoryLabel": ev.category_label,
        "categoryEmoji": ev.category_emoji,
        "venue": f"{ev.venue_name} · {ev.neighborhood}",
        "date": date_label,
        "time": "" if (is_original or is_ongoing) else effective_start.strftime("%H:%M"),
        "duration": "" if (is_original or is_ongoing) else _duration(ev),
        "headerBg": ev.header_gradient,
        "icon": _category_icon(ev.kind),
        "price": price_label,
        "priceTier": ev.price_tier,
        "kidsWelcome": ev.kids_welcome,
        "hasFood": ev.has_food,
        "isLowPressure": ev.is_low_pressure,
        "attendeesConfirmed": member_count,
        "expectedSize": ev.expected_size,
        "vibeSummary": ev.vibe_summary,
        "pitch": ev.pitch,
        # Fall back to a Google Maps search for the venue when we don't have
        # a canonical event URL (e.g. seed events, partner-submitted events
        # without a registration link). Better to show "Ver no mapa" than a
        # dead button.
        "url": ev.url or _venue_maps_url(ev),
        # cohortGoing simulado — em produção viria de uma tabela de RSVPs
        "cohortGoing": [],
        "source": ev.source,
        # Surface the IG handle so the frontend can show "@<handle>" instead
        # of a generic "Instagram" badge. external_id is "ig_<handle>_<shortcode>".
        "igHandle": (
            ev.external_id.split("_", 2)[1]
            if ev.source == "instagram"
            and ev.external_id.startswith("ig_")
            and len(ev.external_id.split("_", 2)) >= 2
            else None
        ),
        "dateStart": effective_start.isoformat(),
        # Recurring routines (e.g. "every Thursday MPB"). The frontend uses
        # these for a distinct badge style + a filter chip. Defaults keep
        # one-off events identical to before this change. dateStart above
        # is the next-occurrence (rolled forward at serialization time);
        # `recurrenceLabel` is the human-readable pattern.
        "isRecurring": is_recurring,
        "recurrenceLabel": getattr(ev, "recurrence_label", None),
        "recurrenceDays": list(getattr(ev, "recurrence_days", []) or []),
        # Range events ("terça a domingo", multi-day exhibitions, festivals
        # spanning a weekend) need the end date so the frontend can show
        # the event on every day it covers, not just its start day.
        "dateEnd": ev.date_end.isoformat() if ev.date_end else None,
    }

    # Attach pin coordinates + bairro when the venue's been geocoded.
    # Frontend uses lat/lng in the map view (list view ignores) and
    # bairro on the event card chip ("📍 Batel"). Bairro from the
    # venues cache is the canonical source — feeds the Explorer badge
    # and the "from this neighborhood" filter (TBD).
    coords = None
    if venue_coords and ev.venue_name:
        key = db._normalize_venue_key(ev.venue_name)
        coords = venue_coords.get(key)
    out["lat"] = coords["lat"] if coords else None
    out["lng"] = coords["lng"] if coords else None
    out["bairro"] = (coords or {}).get("bairro") or ""

    # "Destaque" flag — events from a featured IG handle (paid placement)
    # OR aue_originals get the star pill on the card and float to the
    # top of the list. Frontend reads `featured` for both surfaces.
    is_featured = ev.source == "aue_original"
    venue_handle = ""
    if ev.source == "instagram":
        venue_handle = _handle_for_event(ev)
        if venue_handle and venue_handle in _featured_ig_handles_cached():
            is_featured = True
    out["featured"] = is_featured

    # Static promo code for paid-placement venues. Surfaced on the
    # event card as a "🎁 Mostrar código no balcão" affordance; the
    # venue self-honors the code at the door. Code only ships for
    # featured Instagram venues — the cache is pre-filtered.
    promo = _venue_promo_cached().get(venue_handle) if venue_handle else None
    out["promoCode"] = (promo or {}).get("code") or ""
    out["promoPerk"] = (promo or {}).get("perk") or ""

    # imageUrl ships on the list response too (not just detail) — the
    # hero drawer uses it as a banner background, and openDetail can
    # render from local state without forcing a round-trip to fetch
    # the image alone. Adds ~150 chars per event, fine for the catalog.
    out["imageUrl"] = ev.image_url

    if detail:
        out["description"] = ev.description
        out["venueAddress"] = ev.venue_address
        out["city"] = ev.city

    return out


def _venue_maps_url(ev) -> str:
    """
    Build a Google Maps search URL for an event's venue. Used as a fallback
    when the event itself has no canonical URL.
    Returns "" if we don't have enough venue info to make a useful search.
    """
    parts = [p for p in (ev.venue_name, ev.neighborhood) if p and p.strip()]
    if not parts:
        return ""
    parts.append("Curitiba")
    from urllib.parse import quote_plus
    query = quote_plus(" ".join(parts))
    return f"https://www.google.com/maps/search/?api=1&query={query}"


_PT_WEEKDAYS_SHORT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]
_PT_MONTHS_SHORT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
                    "Jul", "Ago", "Set", "Out", "Nov", "Dez"]


def _format_event_date(dt: datetime) -> str:
    """
    Localized short date in pt-BR. "Sáb, 25 Abr" by default; tacks on the year
    when the event is in a different year than today so the user never has to
    guess (e.g. "Sáb, 25 Abr 2027").
    """
    weekday = _PT_WEEKDAYS_SHORT[dt.weekday()]
    month = _PT_MONTHS_SHORT[dt.month - 1]
    base = f"{weekday}, {dt.day} {month}"
    if dt.year != datetime.now(timezone.utc).year:
        base += f" {dt.year}"
    return base


def _format_price(min_p: float, max_p: float, currency: str) -> str:
    symbol = "R$" if currency == "BRL" else "$"
    if min_p == 0 and max_p == 0:
        return "Gratuito"
    if min_p == max_p:
        return f"{symbol} {min_p:.0f}"
    return f"{symbol} {min_p:.0f} – {max_p:.0f}"


def _duration(ev) -> str:
    start = ev.date_start.strftime("%H:%M")
    if ev.date_end:
        return f"{start} – {ev.date_end.strftime('%H:%M')}"
    return start


def _category_icon(cat: str) -> str:
    return {"quiet_social": "☕", "active": "🧘", "creative": "✍️", "community": "🎲"}.get(cat, "🌿")


# ── Client Error Reporting ──

class ClientErrorRequest(BaseModel):
    error_type: str          # "sync_save_failed", "sync_load_failed", "js_error", etc.
    message: str = ""
    context: dict = {}       # extra info: url, component, state snapshot hash, etc.
    session_id: str = ""
    google_id: str = ""


@app.post("/errors/client", status_code=200)
def report_client_error(req: ClientErrorRequest):
    """Receive frontend error reports. Logged server-side for monitoring.
    Never fails to the client — errors about errors shouldn't cascade."""
    try:
        log.warning(
            f"CLIENT ERROR [{req.error_type}] "
            f"user={req.google_id[:20] if req.google_id else 'anon'} "
            f"session={req.session_id[:12]} — {req.message[:200]}"
        )
        # Also store in analytics table for dashboarding
        db.insert_analytics_event(
            event_name=f"client_error:{req.error_type}",
            properties_json=json.dumps({
                "message": req.message[:500],
                "google_id": req.google_id[:30] if req.google_id else "",
                **{k: str(v)[:200] for k, v in (req.context or {}).items()},
            }),
            session_id=req.session_id,
        )
    except Exception as e:
        log.error(f"Error reporting endpoint itself failed: {e}")
    return {"ok": True}


# ── Analytics ──

class AnalyticsEventRequest(BaseModel):
    event_name: str
    properties: dict = {}
    session_id: str = ""


@app.post("/analytics/event", status_code=200)
def track_event(req: AnalyticsEventRequest):
    """Fire-and-forget analytics ingestion. Never raises to the client."""
    try:
        db.insert_analytics_event(
            event_name=req.event_name,
            properties_json=json.dumps(req.properties),
            session_id=req.session_id,
        )
    except Exception as e:
        log.warning(f"Analytics insert failed (non-fatal): {e}")
    return {"ok": True}


@app.get("/analytics/funnel")
def analytics_funnel():
    """Admin view: event counts grouped by name — shows onboarding drop-off."""
    try:
        rows = db.get_funnel_counts()
    except Exception as e:
        log.error(f"Analytics funnel query failed: {e}")
        raise HTTPException(status_code=500, detail="Analytics query failed")
    return {"funnel": rows, "total_rows": sum(r["total"] for r in rows)}


# ── AI Companion ──

class CompanionRequest(BaseModel):
    message: str
    situation: str | None = None
    goal: str | None = None
    week: int = 1
    language: str = "pt"
    history: list[dict] = []  # previous messages for context
    events_context: list[dict] = []  # compact event catalog sent by frontend


COMPANION_SYSTEM_PROMPT = """\
You are the auê Companion — a warm, direct AI guide inside an app that \
aggregates everything happening in Curitiba (Brazil). Users come to you \
when they want to find something to do this week, alone or with friends.

CRITICAL RULES:
1. ALWAYS recommend events from the catalog when remotely relevant. Be generous \
   with matching — yoga request matches any active/wellness event, "board games" \
   matches quiet_social/community events, "dancing" matches active events, etc.
2. NEVER ask follow-up questions. NEVER say "what kind of X do you prefer?" — \
   just pick the best matches and recommend them immediately.
3. Keep it SHORT: 1-2 sentences max, then the events speak for themselves.
4. Be warm but brief. Think friendly text message, not therapy session.
5. If truly nothing matches, say so in one sentence and suggest what's closest.
6. ALSO suggest custom activity ideas the user could create as private events \
   with friends. These are personalized suggestions NOT in the catalog — things \
   like "wine night with friends", "movie marathon", "picnic in the park". \
   Always suggest 1-3 custom ideas that fit the user's mood/request. \
   Each suggestion needs a name, emoji, short description, and category.

USER CONTEXT:
- Reconnection mode: {situation}
  (gentle=wants to go slow; explorer=discovering new things; builder=building real bonds;
   rebounder=ready to jump back in; depth=few deep connections; steady=needs consistency;
   curious=experimenting with no agenda)
- Goal: {goal}
- Week {week}/12
- Language: {language}

AVAILABLE EVENTS:
{events}

RESPONSE FORMAT — return ONLY valid JSON (no markdown):
{{
  "message": "<1-2 sentences in {language_name}, warm and direct>",
  "event_ids": ["id1", "id2"],
  "suggestions": [
    {{
      "name": "<activity name in {language_name}>",
      "emoji": "<single emoji>",
      "description": "<1 sentence description in {language_name}>",
      "category": "quiet_social" | "active" | "creative" | "community" | "bars_cafes"
    }}
  ],
  "tone": "encouraging" | "gentle" | "excited" | "practical"
}}

event_ids MUST be exact IDs from the catalog.
suggestions are NEW activity ideas — never use catalog event names/IDs.
Always respond in {language_name}.
"""


@app.post("/companion")
async def companion_chat(req: CompanionRequest):
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    # Build compact event catalog from frontend-provided events
    # This ensures static/embedded events are always available, not just DB events
    event_lines = []
    events_by_id: dict[str, dict] = {}
    for ev in req.events_context[:60]:
        eid = ev.get("id", "")
        events_by_id[eid] = ev
        event_lines.append(
            f"- [{eid}] {ev.get('name', '')} | {ev.get('category', '')} | "
            f"{ev.get('venue', '')} | {ev.get('date', '')} {ev.get('time', '')} | "
            f"{ev.get('price', '')} | low_pressure={ev.get('isLowPressure', False)} | "
            f"vibe: {ev.get('vibeSummary', '')}"
        )
    event_catalog = "\n".join(event_lines) if event_lines else "(no events available)"

    language_name = "Portuguese" if req.language == "pt" else "English"

    system = COMPANION_SYSTEM_PROMPT.format(
        situation=req.situation or "unknown",
        goal=req.goal or "general wellbeing",
        week=req.week,
        language=req.language,
        language_name=language_name,
        events=event_catalog,
    )

    # Build message history for multi-turn context
    messages = []
    for msg in req.history[-6:]:  # keep last 6 messages for context window
        messages.append({"role": msg.get("role", "user"), "content": msg["content"]})
    messages.append({"role": "user", "content": req.message})

    try:
        client = Anthropic(api_key=settings.anthropic_api_key)
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=512,
            system=system,
            messages=messages,
        )
        raw_text = response.content[0].text.strip()
        # Strip markdown fences if present
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
        raw_text = re.sub(r"\s*```$", "", raw_text)
        data = json.loads(raw_text)
    except json.JSONDecodeError:
        # Claude returned non-JSON — use raw text as message
        data = {"message": raw_text, "event_ids": [], "tone": "encouraging"}
    except Exception as e:
        log.error(f"Companion API error: {e}")
        raise HTTPException(status_code=502, detail="AI companion unavailable")

    # Resolve event IDs back to full frontend objects (from what frontend sent)
    recommended_events = []
    for eid in data.get("event_ids", []):
        if eid in events_by_id:
            recommended_events.append(events_by_id[eid])

    return {
        "message": data.get("message", ""),
        "events": recommended_events,
        "suggestions": data.get("suggestions", []),
        "tone": data.get("tone", "encouraging"),
    }


# ── Groups ────────────────────────────────────────────────

class GroupCreateRequest(BaseModel):
    google_id: str
    name: str
    description: str = ""
    visibility: str = "private"  # 'public' | 'private'


class GroupUpdateRequest(BaseModel):
    google_id: str
    name: Optional[str] = None
    description: Optional[str] = None
    visibility: Optional[str] = None


class GroupJoinRequest(BaseModel):
    google_id: str
    invite_code: str


class GroupEventCreateRequest(BaseModel):
    google_id: str
    name: str
    description: str = ""
    venue: str = ""
    date_start: str
    date_end: Optional[str] = None
    visibility: str = "members"  # 'public' | 'members'
    note: str = ""  # short free-text "que tal esse?" attached to the card
    # Catalog event id when this row was forked from a public event
    # (e.g., "instagram_ig_<handle>_<post>"). Backend parses out the
    # IG handle so views/RSVPs on the group copy still attribute to
    # the source venue's Painel. Empty for plans-from-scratch.
    source_event_id: str = ""


class PersonalPlanCreateRequest(BaseModel):
    """Create a personal plan — an event tied to a hand-picked invitee list,
    with no group context. The 'add a whole group's members' affordance is
    expanded on the frontend; backend just sees the final invitee list."""
    google_id: str                       # creator
    name: str
    description: str = ""
    venue: str = ""
    date_start: str
    date_end: Optional[str] = None
    note: str = ""
    invitee_google_ids: list[str] = []   # everyone invited (excluding creator)
    source_event_id: str = ""            # see GroupEventCreateRequest


@app.post("/groups")
def create_group(req: GroupCreateRequest):
    """Create a new group. Creator becomes admin automatically."""
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Group name is required")
    group = db.create_group(
        google_id=req.google_id,
        name=req.name.strip(),
        description=req.description.strip(),
        visibility=req.visibility,
    )
    new_badges = badges.evaluate(req.google_id)
    return {**group, "new_badges": new_badges}


@app.get("/groups")
def list_groups(google_id: str):
    """List all groups a user belongs to."""
    groups = db.get_groups_for_user(google_id)
    # Attach next upcoming event for each group
    for g in groups:
        events = db.get_group_events(g["id"], is_member=True)
        now = datetime.now(timezone.utc).isoformat()
        upcoming = [e for e in events if e["date_start"] >= now[:10]]
        g["next_event"] = upcoming[0] if upcoming else None
    return {"groups": groups}


@app.get("/groups/{group_id}")
def get_group(group_id: str, google_id: str):
    """Get group detail with members and events."""
    group = db.get_group(group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    role = db.get_group_member_role(group_id, google_id)
    is_member = role is not None

    # Private groups require membership to view
    if group["visibility"] == "private" and not is_member:
        raise HTTPException(status_code=403, detail="This is a private group")

    members = db.get_group_members(group_id) if is_member else []
    events = db.get_group_events(group_id, is_member=is_member)

    return {
        **group,
        "role": role,
        "is_member": is_member,
        "members": members,
        "events": events,
    }


@app.put("/groups/{group_id}")
def update_group(group_id: str, req: GroupUpdateRequest):
    """Update group info. Requires admin role."""
    role = db.get_group_member_role(group_id, req.google_id)
    if role != "admin":
        raise HTTPException(status_code=403, detail="Only admins can update the group")
    db.update_group(group_id, name=req.name, description=req.description, visibility=req.visibility)
    return {"ok": True}


@app.delete("/groups/{group_id}")
def delete_group(group_id: str, google_id: str):
    """Delete a group. Requires admin role on the group — any admin can
    delete, not just the original creator. Promote/demote happens via the
    /members/{id}/role endpoint, so the admin set is intentional."""
    group = db.get_group(group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    role = db.get_group_member_role(group_id, google_id)
    if role != "admin":
        raise HTTPException(status_code=403, detail="Only group admins can delete the group")
    db.delete_group(group_id)
    return {"ok": True}


@app.get("/groups/by-invite/{invite_code}")
def get_group_by_invite(invite_code: str):
    """
    Resolve an invite code to the group's public info (name, member count) so
    the JoinGroup screen can show a confirmation before joining.
    Doesn't add the user to the group — that's a separate POST.
    """
    group = db.get_group_by_invite_code(invite_code)
    if not group:
        raise HTTPException(status_code=404, detail="Grupo não encontrado para esse código.")
    member_count = sum(1 for _ in db.get_group_members(group["id"]))
    return {
        "id": group["id"],
        "name": group["name"],
        "description": group.get("description") or "",
        "visibility": group["visibility"],
        "member_count": member_count,
    }


@app.post("/groups/join")
def join_group(req: GroupJoinRequest):
    """Join a group via invite code."""
    group = db.get_group_by_invite_code(req.invite_code)
    if not group:
        return {"status": "not_found"}
    already = not db.join_group(group["id"], req.google_id)
    if already:
        return {"status": "already_member", "group": group}
    new_badges = badges.evaluate(req.google_id)
    return {"status": "ok", "group": group, "new_badges": new_badges}


@app.delete("/groups/{group_id}/members/{member_google_id}")
def remove_group_member(group_id: str, member_google_id: str, google_id: str):
    """Remove a member from a group (admin) or leave (self)."""
    if google_id != member_google_id:
        role = db.get_group_member_role(group_id, google_id)
        if role != "admin":
            raise HTTPException(status_code=403, detail="Only admins can remove members")
    db.leave_group(group_id, member_google_id)
    return {"ok": True}


class GroupMemberRoleUpdate(BaseModel):
    google_id: str          # the requester (must be admin)
    role: str               # 'admin' | 'member'


@app.put("/groups/{group_id}/members/{member_google_id}/role")
def update_group_member_role(group_id: str, member_google_id: str, req: GroupMemberRoleUpdate):
    """Promote a member to admin or demote an admin back to member.
    Admin-only. Refuses to demote the last remaining admin so the group
    never ends up with zero admins (otherwise no-one could invite, edit
    settings, or eject a bad actor)."""
    if req.role not in ("admin", "member"):
        raise HTTPException(status_code=400, detail="role must be 'admin' or 'member'")
    actor_role = db.get_group_member_role(group_id, req.google_id)
    if actor_role != "admin":
        raise HTTPException(status_code=403, detail="Only admins can change roles")
    target_role = db.get_group_member_role(group_id, member_google_id)
    if target_role is None:
        raise HTTPException(status_code=404, detail="Member not in group")
    # Block the last-admin trapdoor.
    if target_role == "admin" and req.role == "member":
        if db.count_group_admins(group_id) <= 1:
            raise HTTPException(
                status_code=400,
                detail="Não dá pra remover o último admin — promova alguém antes",
            )
    db.set_group_member_role(group_id, member_google_id, req.role)
    return {"ok": True, "role": req.role}


@app.get("/groups/{group_id}/stats")
def group_stats(group_id: str, google_id: str):
    """Mural stats for a group — event totals, RSVP rollup, top organizer.
    Member-only (private groups never leak counts; public-group stats only
    surface to members so the founder/admins keep some bargaining
    information)."""
    role = db.get_group_member_role(group_id, google_id)
    if role is None:
        raise HTTPException(status_code=403, detail="Apenas membros veem as estatísticas do grupo")
    stats = db.get_group_stats(group_id)
    return stats


@app.post("/groups/{group_id}/events")
def create_group_event(group_id: str, req: GroupEventCreateRequest):
    """Create an event within a group. Any member can create events.
    Side-effect: pushes a notification to all OTHER group members so the
    crew finds out without having to open the app."""
    role = db.get_group_member_role(group_id, req.google_id)
    if role is None:
        raise HTTPException(status_code=403, detail="Must be a group member to create events")
    event = db.create_group_event(
        group_id=group_id,
        google_id=req.google_id,
        name=req.name.strip(),
        description=req.description.strip(),
        venue=req.venue.strip(),
        date_start=req.date_start,
        date_end=req.date_end,
        visibility=req.visibility,
        note=req.note.strip(),
        source_ig_handle=_handle_from_event_id(req.source_event_id),
    )
    # Notify other group members. Tag per (group, event) so accidental
    # double-creates collapse instead of stacking. The note (if any) shows
    # in the push body — gives instant context without opening the app.
    group = db.get_group(group_id)
    group_name = (group or {}).get("name") or "no grupo"
    creator_name = _user_display_name(req.google_id)
    tag = f"group-event-{group_id}-{event['id']}"
    note = (req.note or "").strip()
    body = (
        f'{creator_name}: "{note[:80]}" — {req.name.strip()}'
        if note else
        f"{creator_name} adicionou: {req.name.strip()}"
    )
    for member in db.get_group_members(group_id):
        if member.get("google_id") == req.google_id:
            continue  # skip the creator
        _send_push_to_user(
            member["google_id"],
            title=f"🎲 {group_name}",
            body=body,
            url=f"/#/groups/{group_id}",
            tag=tag,
        )
    # Run badge eval on the creator so curador progression surfaces on
    # the next /user/state load. Other members get crew_quente tier-ups
    # on their own next interaction (cheaper than evaluating N members
    # synchronously here).
    new_badges = badges.evaluate(req.google_id)
    return {**event, "new_badges": new_badges}


@app.get("/groups/{group_id}/events")
def list_group_events(group_id: str, google_id: str = ""):
    """List events for a group. Non-members see only public events."""
    is_member = bool(google_id and db.get_group_member_role(group_id, google_id))
    events = db.get_group_events(group_id, is_member=is_member)
    return {"events": events}


@app.delete("/groups/{group_id}/events/{event_id}")
def delete_group_event(group_id: str, event_id: str, google_id: str):
    """Delete a group event. Admins or the event creator can delete."""
    event = db.get_group_event(event_id)
    if not event or event["group_id"] != group_id:
        raise HTTPException(status_code=404, detail="Event not found in this group")
    role = db.get_group_member_role(group_id, google_id)
    if role != "admin" and event["created_by"] != google_id:
        raise HTTPException(status_code=403, detail="Only admins or the event creator can delete")
    db.delete_group_event(event_id)
    return {"ok": True}


@app.post("/events/private")
def create_personal_plan(req: PersonalPlanCreateRequest, background_tasks: BackgroundTasks):
    """Create a 'personal plan' — an event tied to hand-picked invitees,
    no group attached. Side-effects:
      - Auto-RSVPs the creator (per product decision: making the plan
        means you're going).
      - Pushes to every invitee with a friendly 'Ciro te convidou…'
        message; invitees see the event in their group-events feed even
        though it has no group_id.

    Push fan-out runs in a BackgroundTask so the HTTP response doesn't
    block on N serial webpush calls. With Railway cold-start, the
    inline path easily exceeded the frontend's 5s fetch timeout and
    surfaced as 'Failed to fetch' even though the event was created.

    The 'add a whole group's members' affordance is a frontend
    convenience — backend just receives the expanded invitee list.
    """
    if not req.google_id:
        raise HTTPException(status_code=401, detail="Login required")
    name = (req.name or "").strip()
    if not name or len(name) < 3:
        raise HTTPException(status_code=400, detail="Nome do plano muito curto")
    if not req.date_start:
        raise HTTPException(status_code=400, detail="Data é obrigatória")
    invitees = sorted({str(g) for g in req.invitee_google_ids if g and g != req.google_id})
    if not invitees:
        raise HTTPException(
            status_code=400,
            detail="Convide pelo menos um amigo — sem invitees, é um custom event privado em vez de plano",
        )

    event = db.create_group_event(
        group_id=None,
        google_id=req.google_id,
        name=name,
        description=(req.description or "").strip(),
        venue=(req.venue or "").strip(),
        date_start=req.date_start,
        date_end=req.date_end,
        visibility="members",  # not used when group_id is null, but keep the column happy
        note=(req.note or "").strip(),
        extra_invitee_ids=invitees,
        source_ig_handle=_handle_from_event_id(req.source_event_id),
    )

    # Auto-RSVP the creator. Mirrors the contract from POST /rsvp so the
    # event shows up in the creator's RSVPs immediately.
    try:
        db.upsert_rsvp(
            google_id=req.google_id,
            event_id=event["id"],
            event_name=name,
            event_venue=event.get("venue", ""),
            event_date=req.date_start,
            event_url="",
        )
    except Exception as e:
        log.warning(f"Personal plan {event['id']}: auto-RSVP failed: {e}")

    # Push fan-out in a background task. Tag per (creator, event) so accidental
    # double-creates collapse instead of stacking. Body is computed here so the
    # task closure has everything it needs.
    creator_name = _user_display_name(req.google_id)
    when_label = (req.date_start or "")[:10]
    venue_label = event.get("venue") or ""
    note = (req.note or "").strip()
    body = (
        f'{creator_name}: "{note[:80]}" — {name}'
        if note else
        f"{creator_name} te convidou pra {name}"
        + (f" no {venue_label}" if venue_label else "")
        + (f", {when_label}" if when_label else "")
    )
    tag = f"personal-plan-{event['id']}"
    event_id = event["id"]

    def _fanout_pushes():
        for invitee in invitees:
            try:
                _send_push_to_user(
                    invitee,
                    title="🎲 Convite",
                    body=body,
                    url=f"/#/events/{event_id}",
                    tag=tag,
                )
            except Exception as exc:
                log.warning(f"Personal plan {event_id}: push to {invitee} failed: {exc}")

    background_tasks.add_task(_fanout_pushes)
    # Eval the creator now so the organizador ladder + first_rsvp pop
    # without waiting for the next reload. Mature filter still applies
    # inside _organized_count so this isn't free progress.
    new_badges = badges.evaluate(req.google_id)
    return {**event, "new_badges": new_badges}


@app.delete("/events/private/{event_id}")
def delete_personal_plan(event_id: str, google_id: str):
    """Only the creator can delete their own personal plan."""
    event = db.get_group_event(event_id)
    if not event or event.get("group_id"):
        raise HTTPException(status_code=404, detail="Plano não encontrado")
    if event["created_by"] != google_id:
        raise HTTPException(status_code=403, detail="Só quem criou o plano pode apagar")
    db.delete_group_event(event_id)
    return {"ok": True}


# ── Group Calendar Feed (iCal subscription) ──────────────

def _to_ical_date(iso_str: str) -> str:
    """Convert ISO 8601 date string to iCal DTSTART format (YYYYMMDDTHHMMSSZ)."""
    # Handle various formats: 2026-04-15, 2026-04-15T19:00, 2026-04-15T19:00:00
    clean = iso_str.replace("-", "").replace(":", "")
    if "T" not in clean:
        clean += "T000000"
    # Ensure exactly 15 chars: YYYYMMDDTHHMMSS
    clean = clean[:15]
    if len(clean) < 15:
        clean = clean.ljust(15, "0")
    return clean + "Z"


@app.get("/groups/feed/{feed_token}.ics")
def group_calendar_feed(feed_token: str):
    """
    iCal subscription feed for a group's events.
    No auth required — the feed_token acts as a bearer token.
    Subscribe via webcal:// in Google Calendar or Apple Calendar.
    """
    group = db.get_group_by_feed_token(feed_token)
    if not group:
        raise HTTPException(status_code=404, detail="Calendar feed not found")

    events = db.get_group_events(group["id"], is_member=True)

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Reroot//Group Calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{group['name']}",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    ]

    for ev in events:
        lines.append("BEGIN:VEVENT")
        lines.append(f"UID:{ev['id']}@aue.app")
        lines.append(f"DTSTART:{_to_ical_date(ev['date_start'])}")
        if ev.get("date_end"):
            lines.append(f"DTEND:{_to_ical_date(ev['date_end'])}")
        lines.append(f"SUMMARY:{ev['name']}")
        if ev.get("venue"):
            lines.append(f"LOCATION:{ev['venue']}")
        if ev.get("description"):
            lines.append(f"DESCRIPTION:{ev['description'][:500]}")
        lines.append("END:VEVENT")

    lines.append("END:VCALENDAR")

    ical_content = "\r\n".join(lines) + "\r\n"
    return PlainTextResponse(
        content=ical_content,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'inline; filename="{group["name"]}.ics"'},
    )


# ── Admin: tracked Instagram accounts ─────────────────────
#
# These power the Apify-backed Instagram scraper. The admin UI under
# /admin/ig-accounts lets you add, enable/disable, label and remove handles.
# No auth gate today — this is a single-user dev tool. Add bearer-token
# protection before exposing it on prod.


class IgAccountUpsert(BaseModel):
    handle: str
    label: str = ""
    category: str = ""
    enabled: bool = True
    notes: str = ""
    requesting_email: str = ""  # logged-in user's email — checked against curators


class CuratorAdd(BaseModel):
    email: str
    notes: str = ""
    requesting_email: str = ""  # must be a founder
    # Role flags — at least one must be true. Founders cannot be granted via
    # this endpoint (founder bootstrap is config-time only).
    is_curator: bool = True
    is_feedbacker: bool = False


class CuratorRoleUpdate(BaseModel):
    is_curator: bool
    is_feedbacker: bool
    requesting_email: str = ""  # must be a founder


class FeedbackSubmit(BaseModel):
    text: str
    context: str = ""              # screen / route hint
    requesting_email: str = ""     # logged-in user — must be a feedbacker
    google_id: str = ""


def _require_curator(email: str) -> str:
    """
    Verify the requesting email belongs to a curator. Returns the
    normalized email on success. Raises 401/403 otherwise.
    """
    email = (email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="É preciso estar logado para gerenciar contas.")
    if not db.is_curator(email):
        raise HTTPException(
            status_code=403,
            detail="Sua conta não é curadora. Peça pro fundador te liberar.",
        )
    return email


def _require_founder(email: str) -> str:
    email = (email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="É preciso estar logado.")
    if not db.is_founder(email):
        raise HTTPException(
            status_code=403, detail="Apenas o fundador pode gerenciar curadores.",
        )
    return email


def _require_feedbacker(email: str) -> str:
    email = (email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="É preciso estar logado.")
    if not db.is_feedbacker(email):
        raise HTTPException(
            status_code=403,
            detail="Sua conta não tem permissão de feedback. Peça pro fundador te liberar.",
        )
    return email


# Curated starter handles. These are GUESSES based on common Curitiba culture
# accounts; many will be wrong (the test scrape revealed @mon_oficial is a
# Chevette page, not the museum). Use the admin UI to fix them quickly.
_DEFAULT_IG_ACCOUNTS = [
    # Cultural venues
    {"handle": "museuoscarniemeyer", "label": "MON — Museu Oscar Niemeyer", "category": "museu"},
    {"handle": "sescpr",              "label": "SESC Paraná",                "category": "cultural"},
    {"handle": "pacodaliberdade",     "label": "Paço da Liberdade",          "category": "cultural"},
    {"handle": "teatroguaira",        "label": "Teatro Guaíra",              "category": "teatro"},
    {"handle": "memorialdecuritiba",  "label": "Memorial de Curitiba",       "category": "cultural"},
    # Curators / aggregators
    {"handle": "curitibacuriosa",     "label": "Curitiba Curiosa",           "category": "curador"},
    {"handle": "curitibasecreta",     "label": "Curitiba Secreta",           "category": "curador"},
    {"handle": "ondeircuritiba",      "label": "Onde Ir Curitiba",           "category": "curador"},
    # Cafés / small venues
    {"handle": "cafelucca",           "label": "Café Lucca",                 "category": "cafe"},
    {"handle": "cafecomjogos",        "label": "Café com Jogos",             "category": "cafe"},
    # Wellness / outdoor
    {"handle": "yogacuritiba",        "label": "Yoga Curitiba",              "category": "wellness"},
    {"handle": "parquebariguioficial","label": "Parque Barigui",             "category": "parque"},
    # Music / nightlife
    {"handle": "hardcorecuritiba",    "label": "Hardcore Curitiba",          "category": "musica"},
    {"handle": "brewbarganda",        "label": "Brew Bar Ganda",             "category": "bar"},
    # Books / literature
    {"handle": "livrariaarcangelo",   "label": "Livraria Arcângelo",         "category": "livraria"},
]


def _seed_default_ig_accounts() -> None:
    """One-time seed: if the table is empty, populate with starter handles."""
    if db.list_ig_accounts():
        return
    for acc in _DEFAULT_IG_ACCOUNTS:
        try:
            db.upsert_ig_account(**acc, added_by_email="system")
        except Exception as e:
            log.warning(f"Falha seedando {acc['handle']}: {e}")
    log.info(f"Seeded {len(_DEFAULT_IG_ACCOUNTS)} starter Instagram accounts")


@app.get("/admin/ig-accounts")
def admin_list_ig_accounts(requesting_email: str = ""):
    """
    List tracked Instagram accounts. Open to any authenticated user — even
    non-curators can see the catalog (transparency makes the system trusted).
    Each row is enriched with `future_events` (post-dedup, matching what
    the catalog actually shows) so the admin UI shows real yield per
    handle and the chip count agrees with the catalog.
    """
    accounts = db.list_ig_accounts()
    enriched = []
    for a in accounts:
        evs = db.get_future_events_by_source("instagram", ig_handle=a["handle"], limit=200)
        cleaned = [
            ev for ev in evs
            if _passes_content_filter(ev, curated=False) and _is_in_curitiba(ev)
        ]
        deduped_count = len(_dedupe_events(cleaned))
        enriched.append({**a, "future_events": deduped_count})
    # Sort: featured first (Destaque + curators want their paid placements
    # at the top of the admin list too), then by detected event count DESC
    # so the highest-yield handles are visually obvious. Disabled accounts
    # land at the bottom.
    enriched.sort(key=lambda a: (
        not a.get("enabled"),
        not a.get("featured"),
        -(a.get("future_events") or 0),
        (a.get("label") or a.get("handle") or "").lower(),
    ))
    return {
        "accounts": enriched,
        "is_curator": db.is_curator(requesting_email),
        "is_founder": db.is_founder(requesting_email),
    }


@app.post("/admin/ig-accounts")
def admin_upsert_ig_account(req: IgAccountUpsert):
    email = _require_curator(req.requesting_email)
    handle = req.handle.strip().lstrip("@")
    if not re.match(r"^[A-Za-z0-9._]{1,30}$", handle):
        raise HTTPException(status_code=400, detail="Handle inválido (use letras, números, '.' ou '_')")
    account = db.upsert_ig_account(
        handle=handle, label=req.label.strip(), category=req.category.strip(),
        enabled=req.enabled, notes=req.notes.strip(),
        added_by_email=email,
    )
    _bust_handle_cache()
    return {"account": account}


@app.delete("/admin/ig-accounts/{handle}")
def admin_delete_ig_account(handle: str, requesting_email: str = ""):
    _require_curator(requesting_email)
    ok = db.delete_ig_account(handle)
    if not ok:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    _bust_handle_cache()
    return {"ok": True}


class IgClaimUpdate(BaseModel):
    requesting_email: str
    email: str  # empty string clears the claim


@app.put("/admin/ig-accounts/{handle}/claim")
def admin_set_ig_claim(handle: str, req: IgClaimUpdate):
    """Assign (or clear) the venue dashboard claim for a handle.
    Founder-only — claims map a venue to a Google-login email; the
    dashboard endpoint /venue/{handle}/stats checks that the
    requesting user matches the claim before returning data."""
    _require_founder(req.requesting_email)
    ok = db.set_ig_claim(handle, req.email)
    if not ok:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    return {"ok": True, "claimed_by_email": (req.email or "").strip().lower()}


@app.get("/admin/venues/leaderboard")
def admin_venue_leaderboard(requesting_email: str = "", window_days: int = 30):
    """Founder-only: every active IG handle ranked by aggregate views
    + RSVPs over the last `window_days`. The sales tool — venues at
    the top are the strongest candidates for paid placement (Destaque)
    deals because they already have audience pull on the catalog."""
    _require_founder(requesting_email)
    return {"venues": db.get_venue_leaderboard(window_days=max(1, min(window_days, 90)))}


@app.get("/venue/{handle}/stats")
def venue_dashboard_stats(handle: str, requesting_email: str = ""):
    """Per-venue dashboard data. Two access tiers:
       1. The founder always has read access (admin oversight).
       2. The email matching the venue's claim has read access
          (the venue's own dashboard).
    Anyone else gets 403, even when authenticated — these are paid-
    placement metrics, not catalog data."""
    handle = handle.strip().lstrip("@").lower()
    cleaned_email = (requesting_email or "").strip().lower()
    is_founder = bool(cleaned_email and db.is_founder(cleaned_email))
    if not is_founder:
        # Non-founder: must match the venue's claim. db.get_ig_account
        # returns the row (or None) for the handle.
        acc = db.get_ig_account(handle)
        if not acc:
            raise HTTPException(status_code=404, detail="Conta não encontrada")
        claimed = (acc.get("claimed_by_email") or "").strip().lower()
        if not claimed or claimed != cleaned_email:
            raise HTTPException(status_code=403, detail="Sem acesso ao painel deste local")
    stats = db.get_venue_dashboard_stats(handle)
    # Surface the venue's display info so the dashboard header has the
    # name + avatar without a second round-trip.
    acc = db.get_ig_account(handle) or {}
    return {
        "handle": handle,
        "label": acc.get("display_name") or acc.get("label") or f"@{handle}",
        "profile_pic_url": acc.get("profile_pic_url") or "",
        "featured": bool(acc.get("featured")),
        "claimed_by_email": (acc.get("claimed_by_email") or "").lower(),
        **stats,
    }


class IgFeaturedToggle(BaseModel):
    requesting_email: str
    featured: bool


class IgPromoUpdate(BaseModel):
    requesting_email: str
    code: str = ""  # empty clears
    perk: str = ""  # short user-facing description of the perk


@app.put("/admin/ig-accounts/{handle}/promo")
def admin_set_ig_promo(handle: str, req: IgPromoUpdate):
    """Set/clear the static promo code for a venue. Founder-only.
    The code only renders on event cards when the venue is also
    featured (paid Seleção auê) — promo is part of the paid bundle,
    not a free perk."""
    _require_founder(req.requesting_email)
    ok = db.set_ig_promo(handle, req.code or "", req.perk or "")
    if not ok:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    _bust_handle_cache()
    return {"ok": True, "code": req.code.strip(), "perk": req.perk.strip()}


@app.put("/admin/ig-accounts/{handle}/featured")
def admin_set_ig_featured(handle: str, req: IgFeaturedToggle):
    """Flip the Destaque flag on a tracked IG account. Founder-only:
    Destaque is the paid-placement surface (R$/mo per venue), so the
    set of featured handles is a business decision the founder owns —
    curators can add/remove handles but can't grant placement."""
    _require_founder(req.requesting_email)
    ok = db.set_ig_featured(handle, req.featured)
    if not ok:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    _bust_handle_cache()
    return {"ok": True, "featured": req.featured}


@app.post("/admin/ig-accounts/{handle}/scrape")
async def admin_scrape_ig_account(handle: str, requesting_email: str = ""):
    """
    Scrape a single IG handle on demand — useful right after adding/editing
    a handle so the curator gets immediate feedback (avatar, sample event)
    without waiting for the next 24h scheduler tick. Forces a full fetch
    even if the probe says nothing's new.
    """
    _require_curator(requesting_email)
    handle = handle.strip().lstrip("@").lower()
    acc = db.get_ig_account(handle)
    if not acc:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    if not acc.get("enabled"):
        raise HTTPException(status_code=400, detail="Conta desativada — ative antes de scrape manual")

    # Run the existing scrape pipeline scoped to this one handle, then push
    # the events through the same enrichment + persistence flow as the
    # scheduler. Returns the count of new RawEvents extracted.
    from scrapers.instagram_apify import fetch_events as ig_fetch
    from enrichment import EnrichmentPipeline
    try:
        raw_events = await ig_fetch(
            anthropic_api_key=settings.anthropic_api_key,
            apify_token=settings.apify_api_token,
            handles=[handle],
            posts_per_account=5,
        )
    except Exception as e:
        log.exception(f"Manual scrape ig_fetch failed for @{handle}")
        raise HTTPException(status_code=500, detail=f"Apify fetch failed: {e}")

    new_event_ids: set[str] = set()
    if raw_events:
        pipeline = EnrichmentPipeline(api_key=settings.anthropic_api_key)
        for raw in raw_events:
            try:
                enriched = pipeline.enrich(raw)
                if enriched:
                    db.upsert_event(enriched)
                    new_event_ids.add(enriched.id)
            except Exception as e:
                log.warning(f"Enrichment failed for @{handle}/{raw.external_id}: {e}")

    # Manual scrape is a "rebuild this handle" — wipe stale rows that the
    # re-evaluation didn't reaffirm. This is what cleans up old wrongly-
    # dated events when the prompt fix or vision improvements reclassify
    # them as past/not-an-event.
    try:
        deleted = db.delete_events_by_handle_except(handle, new_event_ids)
    except Exception as e:
        log.exception(f"Manual scrape cleanup failed for @{handle}")
        raise HTTPException(status_code=500, detail=f"Cleanup failed: {e}")
    if deleted:
        log.info(f"Manual scrape @{handle}: deleted {deleted} stale event row(s)")

    # Re-read the row so the updated profile metadata is in the response
    updated = db.get_ig_account(handle) or {}
    return {
        "handle": handle,
        "events_extracted": len(raw_events),
        "stale_deleted": deleted,
        "display_name": updated.get("display_name", ""),
        "profile_pic_url": updated.get("profile_pic_url", ""),
    }


@app.get("/admin/apify-debug")
def admin_apify_debug(requesting_email: str = ""):
    """
    Founder-only debug surface — returns the redacted top-level shape of
    the most recent Apify post payload. Used to introspect actor schema
    drift when profile enrichment isn't finding fields. Temporary.
    """
    _require_founder(requesting_email)
    from scrapers.instagram_apify import LAST_POST_DEBUG
    return LAST_POST_DEBUG or {"empty": True, "hint": "Run /events/refresh first"}


@app.post("/admin/ig-accounts/seed-defaults")
def admin_seed_default_ig_accounts(requesting_email: str = ""):
    """Force-seed the starter list (only inserts missing handles)."""
    email = _require_curator(requesting_email)
    inserted = 0
    for acc in _DEFAULT_IG_ACCOUNTS:
        try:
            existing = db.list_ig_accounts()
            if not any(a["handle"] == acc["handle"] for a in existing):
                db.upsert_ig_account(**acc, added_by_email=email)
                inserted += 1
        except Exception:
            pass
    if inserted:
        _bust_handle_cache()
    return {"inserted": inserted, "total_defaults": len(_DEFAULT_IG_ACCOUNTS)}


# ── Map / venues (founder-only ops) ───────────────────────

# Sources we used to scrape but have since dropped. Events from these
# sources still sit in the DB and the rsvps table can still reference
# them — without an explicit purge they age out only when their date
# passes. The purge endpoint below cleans both.
_DROPPED_SCRAPER_SOURCES = (
    "sympla", "eventbrite", "ingresso", "meetup", "sesc", "mon",
    "teatro_guaira", "turismo_curitiba", "catraca_livre", "google_places",
    "prefeitura",
)


@app.post("/admin/venues/seed")
def admin_seed_venues(requesting_email: str = ""):
    """Walk every event in the catalog and ensure a venue row exists for
    each distinct venue_name. Idempotent — safe to re-run after every
    scrape. Curators can run it: it's append-only (INSERT OR IGNORE), no
    rows are modified, and the only side-effect is queueing more rows
    for the geocode backfill."""
    _require_curator(requesting_email)
    new_count = db.seed_venues_from_events()
    return {"new_venues": new_count}


@app.post("/admin/venues/geocode")
def admin_geocode_venues(requesting_email: str = "", limit: int = 25):
    """Run the Nominatim backfill for up to `limit` pending venues.
    Bounded by `limit` so a single HTTP call doesn't run for minutes —
    Nominatim's ToS asks for ≤1 req/sec, so 25 venues ≈ 30s of wall time.
    Curators can trigger this: the only external touch is Nominatim
    (free, public, no API key), and a curator-driven fix to a missing
    pin shouldn't have to wait for the founder."""
    _require_curator(requesting_email)
    from geocoding import geocode_pending_venues
    return geocode_pending_venues(limit=limit)


@app.get("/admin/venues")
def admin_list_venues(requesting_email: str = "", status: str = "all"):
    """List venues for the curator UI — typically filtered to status='pending'
    so the curator can hand-fix what Nominatim couldn't resolve. Each row
    includes the catalog event count so the high-impact gaps surface first."""
    _require_curator(requesting_email)
    if status not in ("pending", "ok", "all"):
        raise HTTPException(status_code=400, detail="status must be 'pending', 'ok', or 'all'")
    return {"venues": db.list_venues(status=status)}


class VenueUpdateRequest(BaseModel):
    requesting_email: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    address: Optional[str] = None  # when set, persisted for future Nominatim retries


@app.put("/admin/venues/{name_normalized}")
def admin_update_venue(name_normalized: str, req: VenueUpdateRequest):
    """Manual curator override. Two modes:
      - lat + lng provided → mark 'ok', source='manual'. Pin appears
        on the map immediately; Nominatim won't overwrite it.
      - lat + lng both None → mark 'pending'. Useful when the curator
        updated the address and wants Nominatim to retry on the next
        backfill pass.

    Address is optional in both modes: when provided we persist it (so
    the next geocode retry has cleaner input); when omitted the existing
    address is left untouched."""
    _require_curator(req.requesting_email)
    if (req.lat is None) != (req.lng is None):
        raise HTTPException(status_code=400, detail="lat and lng must both be provided or both omitted")
    if req.lat is not None:
        # Sanity check — Curitiba lives roughly between (-25.7, -49.5)
        # and (-25.2, -49.0). Accepting anything in Brazil's lat range
        # would drop pins on the wrong continent if a typo creeps in.
        if not (-26.5 <= req.lat <= -24.5 and -50.5 <= req.lng <= -48.0):
            raise HTTPException(
                status_code=400,
                detail="Coordenadas fora da região de Curitiba — verifica antes de salvar",
            )
    ok = db.update_venue_manual(
        name_normalized=name_normalized,
        lat=req.lat, lng=req.lng,
        address=req.address,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Local não encontrado")
    return {"ok": True}


@app.post("/admin/venues/{name_normalized}/geocode")
def admin_geocode_one_venue(name_normalized: str, requesting_email: str = ""):
    """Re-run Nominatim against a single venue immediately — useful right
    after the curator updated the address and wants the pin to fill in
    without waiting for the next /admin/venues/geocode batch."""
    _require_curator(requesting_email)
    from geocoding import geocode_one
    with db.get_conn() as conn:
        row = conn.execute(
            "SELECT name_original, address FROM venues WHERE name_normalized = ?",
            (name_normalized,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Local não encontrado")
    result = geocode_one(row["name_original"], row["address"] or "")
    if result:
        lat, lng, bairro = result
        db.record_geocode_result(name_normalized, lat, lng, bairro=bairro)
        return {"ok": True, "lat": lat, "lng": lng, "bairro": bairro}
    db.record_geocode_result(name_normalized, None, None)
    return {"ok": False, "lat": None, "lng": None}


@app.post("/admin/avatars/rehost")
def admin_rehost_avatars(requesting_email: str = "", limit: int = 50):
    """Backfill: rehost IG profile pictures whose stored URL is still
    pointing at IG's CDN (signed → expires in weeks). New scrapes do
    this automatically — this endpoint is for the existing rows. Re-run
    until `remaining` returns 0. Founder-only."""
    _require_founder(requesting_email)
    from image_store import rehost_pending_avatars
    return rehost_pending_avatars(limit=limit)


@app.post("/admin/diag/rsvp-backfill")
def admin_rsvp_backfill(requesting_email: str = "", dry_run: bool = False):
    """Founder-only one-shot: walk every user_states row, parse
    state_json.rsvps, and INSERT OR IGNORE missing entries into the
    rsvps table. Catches every catalog RSVP made before today's
    syncRsvp wiring landed — those rows lived only in the user's
    state blob and never reached the rsvps table, so /friends/feed
    couldn't surface them.

    Idempotent: INSERT OR IGNORE skips rows already keyed by
    (google_id, event_id). Pass dry_run=true to count without
    inserting."""
    _require_founder(requesting_email)
    inserted = 0
    skipped_no_data = 0
    users_scanned = 0
    sample_inserts: list[dict] = []
    now_iso = datetime.now(timezone.utc).isoformat()
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT google_id, state_json FROM user_states"
        ).fetchall()
        for r in rows:
            users_scanned += 1
            try:
                state = json.loads(r["state_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            rsvps = state.get("rsvps") or {}
            if not isinstance(rsvps, dict):
                continue
            for event_id, info in rsvps.items():
                # Legacy boolean shape: skip — we don't have name/date/venue.
                if not isinstance(info, dict):
                    skipped_no_data += 1
                    continue
                date_start = (info.get("dateStart") or "").strip()
                name = (info.get("name") or "").strip()
                venue = (info.get("venue") or "").strip()
                if not name and not date_start:
                    skipped_no_data += 1
                    continue
                if dry_run:
                    inserted += 1
                    if len(sample_inserts) < 10:
                        sample_inserts.append({
                            "google_id": r["google_id"],
                            "event_id": event_id,
                            "event_name": name,
                            "event_date": date_start,
                        })
                    continue
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO rsvps
                           (google_id, event_id, event_name, event_venue,
                            event_date, event_url, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        (r["google_id"], event_id, name, venue,
                         date_start, "", now_iso),
                    )
                    if conn.total_changes:
                        # total_changes is cumulative on the conn; use rowcount
                        # via cursor instead. Simpler: just count attempts and
                        # let INSERT OR IGNORE be a no-op for existing rows.
                        pass
                    inserted += 1
                except sqlite3.Error as exc:
                    log.warning("rsvp-backfill: insert failed for %s/%s: %s",
                                r["google_id"], event_id, exc)
        if not dry_run:
            conn.commit()
    return {
        "users_scanned": users_scanned,
        "inserted_or_existing": inserted,
        "skipped_no_data": skipped_no_data,
        "dry_run": dry_run,
        "sample": sample_inserts if dry_run else None,
    }


@app.get("/admin/diag/rsvps")
def admin_diag_rsvps(requesting_email: str = "", target_google_id: str = ""):
    """Founder-only: dump the rsvps table rows for a target user and
    their friends list. One-off diagnostic — deletes the mystery of
    'why doesn't X see Y in /friends/feed' without needing DB shell."""
    _require_founder(requesting_email)
    if not target_google_id:
        raise HTTPException(status_code=400, detail="target_google_id required")
    today = date.today().isoformat()
    with db.get_conn() as conn:
        own_rsvps = [dict(r) for r in conn.execute(
            "SELECT event_id, event_name, event_date FROM rsvps WHERE google_id = ? ORDER BY event_date",
            (target_google_id,),
        ).fetchall()]
        friends = db.get_friends(target_google_id)
        friend_ids = [f["google_id"] for f in friends]
        friend_rsvps_future = []
        if friend_ids:
            ph = ",".join("?" * len(friend_ids))
            friend_rsvps_future = [dict(r) for r in conn.execute(
                f"""SELECT google_id, event_id, event_name, event_date
                    FROM rsvps WHERE google_id IN ({ph})
                    AND (event_date = '' OR event_date >= ?)
                    ORDER BY event_date""",
                friend_ids + [today],
            ).fetchall()]
    return {
        "target": target_google_id,
        "today": today,
        "own_rsvps": own_rsvps,
        "friends": [{"google_id": f["google_id"], "name": f.get("name", "")} for f in friends],
        "friends_future_rsvps": friend_rsvps_future,
    }


@app.post("/admin/avatars/clear-bot-blocked")
def admin_clear_bot_blocked_avatars(requesting_email: str = ""):
    """Cleanup: when IG's bot detection fires on a profile-page fetch,
    the og:image we cached is the generic Instagram brand logo (a
    .png from static.cdninstagram.com) instead of the real avatar.
    Delete those files and reset profile_pic_url so the next backfill
    pass re-fetches them. Real avatars are stored as .jpg from
    scontent.cdninstagram.com — only `.png` files in the avatars dir
    are candidates for cleanup. Founder-only."""
    _require_founder(requesting_email)
    from image_store import clear_bot_blocked_avatars
    return clear_bot_blocked_avatars()


class AvatarRehostFromUrl(BaseModel):
    requesting_email: str = ""
    handle: str
    source_url: str


@app.post("/admin/avatars/rehost-url")
def admin_rehost_avatar_from_url(req: AvatarRehostFromUrl):
    """Rehost a single avatar from a caller-provided IG CDN URL.

    Why this exists: Railway IPs get bot-blocked when scraping
    instagram.com for og:image, so the founder fetches the og:image
    from their local machine (which works) and POSTs the URL here.
    Server downloads the image bytes, stores under /event-images/avatars,
    updates the DB row. Founder-only."""
    _require_founder(req.requesting_email)
    from image_store import rehost_avatar
    handle = (req.handle or "").strip().lstrip("@").lower()
    if not handle:
        raise HTTPException(status_code=400, detail="handle required")
    import html as _html
    src = _html.unescape((req.source_url or "").strip())
    if not src or "static.cdninstagram.com" in src or "/rsrc.php/" in src:
        raise HTTPException(status_code=400, detail="invalid source_url")
    local = rehost_avatar(handle, src)
    if not local:
        raise HTTPException(status_code=502, detail="rehost failed")
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE tracked_ig_accounts SET profile_pic_url = ? WHERE handle = ?",
            (local, handle),
        )
        conn.commit()
    return {"ok": True, "handle": handle, "stored_at": local}


@app.post("/admin/images/rehost")
def admin_rehost_images(requesting_email: str = "", limit: int = 50):
    """One-shot backfill: rehost IG-CDN-served event images that haven't
    been saved locally yet. Bounded by `limit` so a single call doesn't
    sit for minutes. Re-run until `remaining` returns 0.

    New scrapes do this automatically — this endpoint is for the
    transition period where existing rows still point at expiring
    IG URLs. Founder-only because it touches a write path that mutates
    every event payload."""
    _require_founder(requesting_email)
    from image_store import rehost_pending_events
    return rehost_pending_events(limit=limit)


@app.post("/admin/venues/backfill-bairros")
def admin_backfill_bairros(requesting_email: str = "", limit: int = 30):
    """One-shot backfill: for venues that already have lat/lng but no
    bairro, reverse-geocode the coords through Nominatim to fill the
    bairro column. Doesn't touch lat/lng — just populates the missing
    field so the Explorer badge stops missing the existing geocoded
    venues from before bairro was tracked.

    Bounded by `limit` (≥1s/req per Nominatim ToS, so 30 venues ≈ 35s).
    Re-run until 'remaining' returns 0."""
    _require_curator(requesting_email)
    headers = {
        "User-Agent": "aue-curitiba-events/1.0 (https://reroot-production.up.railway.app)",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
    }
    with db.get_conn() as conn:
        rows = conn.execute(
            """SELECT name_normalized, lat, lng FROM venues
               WHERE geocode_status = 'ok'
                 AND lat IS NOT NULL AND lng IS NOT NULL
                 AND (bairro IS NULL OR bairro = '')
               LIMIT ?""",
            (limit,),
        ).fetchall()
    rows = [dict(r) for r in rows]
    filled = 0
    failed = 0
    import time
    for r in rows:
        try:
            res = httpx.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"lat": r["lat"], "lon": r["lng"],
                        "format": "json", "addressdetails": "1", "zoom": "16"},
                headers=headers, timeout=8.0,
            )
            data = res.json()
            addr = data.get("address") or {}
            bairro = (
                addr.get("suburb") or addr.get("neighbourhood")
                or addr.get("quarter") or addr.get("city_district") or ""
            )
            if bairro:
                with db.get_conn() as conn:
                    conn.execute(
                        "UPDATE venues SET bairro = ? WHERE name_normalized = ?",
                        (bairro, r["name_normalized"]),
                    )
                    conn.commit()
                filled += 1
            else:
                failed += 1
        except Exception as exc:
            log.warning("Reverse-geocode failed for %r: %s", r["name_normalized"], exc)
            failed += 1
        time.sleep(1.1)  # Nominatim ToS
    # How many still need filling, so the admin UI knows whether to re-run.
    with db.get_conn() as conn:
        remaining = conn.execute(
            """SELECT COUNT(*) AS c FROM venues
               WHERE geocode_status = 'ok'
                 AND lat IS NOT NULL AND lng IS NOT NULL
                 AND (bairro IS NULL OR bairro = '')"""
        ).fetchone()["c"]
    return {"processed": len(rows), "filled": filled, "failed": failed, "remaining": int(remaining)}


@app.post("/admin/venues/{name_normalized}/ai-lookup")
def admin_ai_lookup_venue(name_normalized: str, requesting_email: str = ""):
    """Ask Claude for the venue's address + coords. Doesn't write to the
    venues table — returns the suggestion so the curator reviews it in
    the editor sheet and clicks Save when satisfied. Cheaper than guessing
    via Nominatim + addressed dictation; falls back to null when Claude
    is uncertain (its training data covers most established Curitiba
    venues but not every random handle a curator might add)."""
    _require_curator(requesting_email)
    from geocoding import ai_lookup_venue
    with db.get_conn() as conn:
        row = conn.execute(
            "SELECT name_original, address FROM venues WHERE name_normalized = ?",
            (name_normalized,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Local não encontrado")
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY não configurada")
    result = ai_lookup_venue(
        row["name_original"], row["address"] or "",
        anthropic_api_key=settings.anthropic_api_key,
    )
    if not result:
        return {"ok": False, "address": None, "lat": None, "lng": None,
                "confidence": "low", "notes": "IA não respondeu ou falhou ao parsear"}
    return {
        "ok": True,
        "address": result.get("address"),
        "lat": result.get("lat"),
        "lng": result.get("lng"),
        "confidence": result.get("confidence") or "low",
        "notes": result.get("notes") or "",
    }


@app.delete("/admin/cleanup/dead-sources")
def admin_cleanup_dead_sources(requesting_email: str = ""):
    """Purge events (and their RSVPs) from scrapers we no longer run.
    Mayra-style RSVPs to ghost eventbrite events get cleaned in one pass.

    Founder-only because the delete is irreversible. Returns counts so the
    caller sees what hit. Group events / personal plans are untouched —
    those live in `group_events`, not `events`."""
    _require_founder(requesting_email)
    if not _DROPPED_SCRAPER_SOURCES:
        return {"events_deleted": 0, "rsvps_deleted": 0}
    placeholders = ",".join("?" * len(_DROPPED_SCRAPER_SOURCES))
    with db.get_conn() as conn:
        ghost_ids = [
            r["id"] for r in conn.execute(
                f"SELECT id FROM events WHERE source IN ({placeholders})",
                _DROPPED_SCRAPER_SOURCES,
            ).fetchall()
        ]
        rsvps_deleted = 0
        if ghost_ids:
            id_placeholders = ",".join("?" * len(ghost_ids))
            cur = conn.execute(
                f"DELETE FROM rsvps WHERE event_id IN ({id_placeholders})",
                ghost_ids,
            )
            rsvps_deleted = cur.rowcount or 0
            conn.execute(
                f"DELETE FROM events WHERE source IN ({placeholders})",
                _DROPPED_SCRAPER_SOURCES,
            )
        conn.commit()
    return {
        "events_deleted": len(ghost_ids),
        "rsvps_deleted": rsvps_deleted,
        "sources_purged": list(_DROPPED_SCRAPER_SOURCES),
    }


# ── Curator management (founder-only) ─────────────────────


@app.get("/admin/curators")
def admin_list_curators(requesting_email: str = ""):
    """
    Anyone authenticated can see the permissioned-users list (transparency).
    Only the founder can add or remove or change roles — enforced on the
    mutating endpoints below.
    """
    return {
        "curators": db.list_curators(),
        "is_founder": db.is_founder(requesting_email),
        "is_curator": db.is_curator(requesting_email),
        "is_feedbacker": db.is_feedbacker(requesting_email),
    }


@app.post("/admin/curators")
def admin_add_curator(req: CuratorAdd):
    founder_email = _require_founder(req.requesting_email)
    email = req.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Email inválido")
    if not (req.is_curator or req.is_feedbacker):
        raise HTTPException(status_code=400, detail="Marque pelo menos um papel (curador ou feedbacker).")
    return {"curator": db.add_curator(
        email=email, added_by_email=founder_email, notes=req.notes.strip(),
        is_founder_flag=False,
        is_curator_flag=req.is_curator,
        is_feedbacker_flag=req.is_feedbacker,
    )}


@app.patch("/admin/curators/{email}")
def admin_update_curator_roles(email: str, req: CuratorRoleUpdate):
    _require_founder(req.requesting_email)
    if not (req.is_curator or req.is_feedbacker):
        # Both off ⇒ remove the row. update_curator_roles handles the cleanup.
        pass
    updated = db.update_curator_roles(
        email=email,
        is_curator_flag=req.is_curator,
        is_feedbacker_flag=req.is_feedbacker,
    )
    return {"curator": updated}


@app.delete("/admin/curators/{email}")
def admin_remove_curator(email: str, requesting_email: str = ""):
    _require_founder(requesting_email)
    if email.strip().lower() == requesting_email.strip().lower():
        raise HTTPException(status_code=400, detail="Você não pode remover a si mesmo.")
    ok = db.remove_curator(email)
    if not ok:
        raise HTTPException(status_code=404, detail="Curador não encontrado (ou é o fundador, que não pode ser removido).")
    return {"ok": True}


# ── Feedback ──────────────────────────────────────────────


@app.post("/feedback")
def submit_feedback(req: FeedbackSubmit):
    # Feedback is open to anyone signed in — we just need an email to
    # attribute the message. Earlier versions gated this on a feedbacker
    # role; that role is now vestigial (kept in DB for backward compat
    # but no longer required).
    email = (req.requesting_email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=401, detail="É preciso estar logado pra mandar feedback.")
    text = (req.text or "").strip()
    if len(text) < 5:
        raise HTTPException(status_code=400, detail="Feedback muito curto.")
    if len(text) > 4000:
        raise HTTPException(status_code=400, detail="Feedback muito longo (máx. 4000 chars).")
    return {"feedback": db.insert_feedback(
        email=email, text=text, google_id=req.google_id, context=req.context,
    )}


@app.get("/admin/feedback")
def admin_list_feedback(requesting_email: str = "", limit: int = 200):
    """Founder-only: read submitted feedback, newest first."""
    _require_founder(requesting_email)
    return {"feedback": db.list_feedback(limit=limit)}


@app.get("/admin/usage-stats")
def admin_usage_stats(requesting_email: str = "", window_days: int = 30):
    """
    Founder-only: aggregated usage metrics — DAU/WAU/MAU, funnel,
    daily series, recent logins. Used by the dashboard section in
    the Curar tab.
    """
    _require_founder(requesting_email)
    return db.get_usage_stats(window_days=window_days)


@app.post("/admin/test-email")
async def admin_test_email(requesting_email: str = ""):
    """Founder-only: smoke test the email transport. Routes through
    notifications.send_email() which prefers Resend (HTTPS) when
    RESEND_API_KEY is set, else falls back to SMTP. Returns the
    transport used + verdict so misconfig surfaces in seconds."""
    import asyncio as _asyncio
    _require_founder(requesting_email)

    transport = (
        "resend" if settings.resend_api_key
        else ("smtp" if (settings.smtp_user and settings.smtp_password) else "none")
    )
    if transport == "none":
        return {
            "ok": False,
            "transport": "none",
            "reason": (
                "Nenhum transport configurado. Defina RESEND_API_KEY (recomendado, "
                "HTTPS) ou SMTP_USER+SMTP_PASSWORD nas env vars do Railway."
            ),
        }

    from notifications import send_email
    try:
        ok = await _asyncio.wait_for(
            send_email(
                settings=settings,
                to=settings.founder_email,
                subject=f"[auê] teste {transport}",
                html=f"<p>Se você recebeu isso, o transport <b>{transport}</b> do auê está funcionando 🎉</p>",
                text=f"Se você recebeu isso, transport {transport} do auê está funcionando.",
            ),
            timeout=15,
        )
    except _asyncio.TimeoutError:
        return {
            "ok": False,
            "transport": transport,
            "reason": "Timeout >15s — sem resposta do transport.",
        }
    except Exception as e:
        return {
            "ok": False,
            "transport": transport,
            "reason": f"{type(e).__name__}: {e}",
        }
    return {
        "ok": ok,
        "transport": transport,
        "to": settings.founder_email,
        "reason": None if ok else "send_email retornou False — ver logs do Railway",
    }


class FeedbackStatusUpdate(BaseModel):
    status: str            # 'open' | 'concluded' | 'canceled'
    requesting_email: str = ""


@app.patch("/admin/feedback/{feedback_id}")
def admin_update_feedback_status(feedback_id: int, req: FeedbackStatusUpdate):
    """Founder-only: mark a feedback as concluded, canceled, or reopen."""
    _require_founder(req.requesting_email)
    try:
        updated = db.update_feedback_status(feedback_id, req.status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not updated:
        raise HTTPException(status_code=404, detail="Feedback não encontrado")
    return {"feedback": updated}


# ── Web Push Notifications ──
#
# VAPID key pair — in production, generate your own and store in env vars.
# These test keys are safe to commit for development only.
# Generate production keys: py -m py_vapid --gen
VAPID_PRIVATE_KEY = "nOAa5iExKg1EvBMkLblGvg"
VAPID_PUBLIC_KEY  = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBZuhbr6lT5E12OwvTPrBa5ygw"
VAPID_CLAIMS = {"sub": "mailto:admin@aue.app"}
WEEKLY_PUSH_MESSAGE = "Olha o auê do fim de semana — vai junto? 🎉"


class PushSubscriptionBody(BaseModel):
    endpoint: str
    keys: dict
    google_id: str = ""  # links the subscription to a logged-in user


@app.post("/push/subscribe")
def push_subscribe(body: PushSubscriptionBody):
    """Store or update a Web Push subscription from the browser. The
    google_id, when present, lets us send per-user pushes (group events,
    friend RSVPs) — anonymous subs only receive the weekly broadcast."""
    db.upsert_push_subscription(body.endpoint, json.dumps(body.keys), body.google_id)
    log.info(f"Push subscription saved (user={body.google_id or 'anon'}): {body.endpoint[:60]}…")
    return {"status": "subscribed"}


# ── Per-user push helper ─────────────────────────────────
# Sends a structured payload (title/body/url/tag) to every device the
# user has registered. The Service Worker parses the JSON and shows a
# rich notification — falls back to text body if it can't parse.
# Failures are dropped silently and dead endpoints (410/404) are pruned.
def _send_push_to_user(
    google_id: str,
    title: str,
    body: str,
    url: str = "/",
    tag: str = "default",
) -> int:
    """Returns the number of devices the push was successfully delivered to."""
    if not google_id:
        return 0
    subs = db.get_push_subscriptions_for_user(google_id)
    if not subs:
        return 0
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        return 0
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    sent = 0
    for sub in subs:
        try:
            webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS,
            )
            sent += 1
        except WebPushException as exc:
            # 410 Gone / 404 Not Found = subscription invalid; drop it
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                db.delete_push_subscription_by_endpoint(sub["endpoint"])
            else:
                log.warning(f"push to {google_id} failed ({status}): {exc}")
        except Exception as exc:
            log.warning(f"push to {google_id} errored: {exc}")
    return sent


def _user_share_rsvps(google_id: str) -> bool:
    """Read user's privacy preference for sharing RSVPs with friends. Same
    fallback as the frontend (privacy.shareRsvps → legacy shareRsvps → True)."""
    if not google_id:
        return False
    state = db.get_user_state(google_id) or {}
    privacy = state.get("privacy") or {}
    if "shareRsvps" in privacy:
        return bool(privacy["shareRsvps"])
    if "shareRsvps" in state:
        return bool(state["shareRsvps"])
    return True  # default opted-in


def _user_display_name(google_id: str) -> str:
    """Best-effort first-name lookup. Falls back to "Alguém" if unset."""
    if not google_id:
        return "Alguém"
    state = db.get_user_state(google_id) or {}
    name = state.get("userName") or (state.get("googleUser") or {}).get("givenName")
    return name or "Alguém"


@app.post("/push/send-weekly")
async def push_send_weekly():
    """Send the weekly check-in push to all subscribers."""
    subscriptions = db.get_all_push_subscriptions()
    if not subscriptions:
        return {"sent": 0, "message": "No subscribers"}
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        raise HTTPException(status_code=501, detail="pywebpush not installed")
    sent = 0
    failed = 0
    for sub in subscriptions:
        try:
            webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                data=WEEKLY_PUSH_MESSAGE,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS,
            )
            sent += 1
        except Exception as exc:
            log.warning(f"Push failed for {sub['endpoint'][:60]}…: {exc}")
            failed += 1
    log.info(f"Weekly push: {sent} sent, {failed} failed")
    return {"sent": sent, "failed": failed}


@app.get("/push/vapid-public-key")
def push_vapid_public_key():
    """Return the VAPID public key so the frontend can subscribe."""
    return {"publicKey": VAPID_PUBLIC_KEY}


# ── Static files + SPA fallback ──
# Must be registered AFTER all API routes so /events, /health etc. take priority

_ASSET_LINKS = [{
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
        "namespace": "android_app",
        "package_name": "com.reroot.app",
        "sha256_cert_fingerprints": [
            "4F:AA:60:AE:A0:F9:23:1A:B6:B3:19:01:C4:7C:15:48:A2:6F:49:ED:55:BE:42:C0:24:D8:A2:50:7E:B3:0B:75"
        ]
    }
}]

# Rehosted IG event images live on the persistent volume (IMAGES_DIR
# in image_store.py — defaults to a sibling of DB_PATH so the same
# Railway volume holds both). Mounted before the SPA fallback so the
# path doesn't get swallowed by index.html for unknown routes.
from image_store import IMAGES_DIR as _IMAGES_DIR
app.mount("/event-images", StaticFiles(directory=_IMAGES_DIR), name="event-images")

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa_fallback(request: Request, path: str):
        """Serve static files or fall back to index.html for SPA routing.

        Also handles /.well-known/assetlinks.json here because Starlette's
        router does not reliably match explicit routes for dotfile paths.
        """
        from fastapi.responses import JSONResponse
        if path == ".well-known/assetlinks.json":
            return JSONResponse(content=_ASSET_LINKS)
        file_path = STATIC_DIR / path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(STATIC_DIR / "index.html")
