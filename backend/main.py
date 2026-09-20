"""
auê Backend — FastAPI (v2)
Serve eventos reais de Curitiba enriquecidos com Claude.

Local:  uvicorn main:app --reload --port 8000
Deploy: Railway runs this via Dockerfile (PORT injected by Railway)

(O nome do diretório/repo ainda é "reroot" — produto anterior; a voz e o
branding já migraram pra auê.)
"""
import functools
import json
import logging
import asyncio
import os
import sqlite3
import hashlib
import re
import unicodedata
import secrets
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
from anthropic import Anthropic
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

import database as db
import badges
import image_store
import ota
import quiet_hours
from urllib.parse import quote
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
    # AI gap-fill: when the catalog is thin, ask Claude to invent plausible
    # events to pad it out. Off by default since Sept 2026.
    #
    # These events are fabricated — real venue names, real-looking dates,
    # but nothing actually scheduled. That is a catalog whose entries a user
    # can show up for and find nothing, which costs more trust than an
    # honestly short list. It also spends tokens producing rows we'd rather
    # not have. Set AI_GAP_FILL=true to re-enable.
    ai_gap_fill: bool = False
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
    # Beta distribution links — the /install endpoint sniffs User-Agent and
    # 302s Android users to Play Store internal testing. Empty string
    # disables the redirect and falls back to the universal HTML
    # walkthrough. iOS no longer needs an env var here: auê is public on
    # the App Store (id 6765535013, see APP_STORE_URL below), so that's
    # the default iOS redirect. testflight_invite_url is now only an
    # override — set it during a version-bump testing window (the app
    # occasionally goes back to TestFlight-only between releases) to send
    # /install to the beta instead of the store's current build.
    testflight_invite_url: str = ""  # https://testflight.apple.com/join/XXXXXX
    play_store_internal_url: str = ""  # https://play.google.com/apps/internaltest/...
    # Deployment environment label. Defaults to "production" so a missing
    # var fails-safe (staging-only behaviors stay off if someone forgets to
    # set it). Set ENV_NAME=staging on the Railway staging service and use
    # `if settings.env_name == "staging": ...` to gate behavior.
    env_name: str = "production"
    # Canonical public address, for links we generate server-side and for
    # the User-Agent we introduce ourselves with. The Railway subdomain
    # still says "reroot" — the old product name — so this exists to make
    # moving to a real auê domain a variable instead of a string hunt.
    # Requests still prefer their own forwarded host when they have one,
    # so a new domain works before anyone sets this.
    public_origin: str = "https://reroot-production.up.railway.app"
    # Catalog sync (staging pulls production's events so tests run against
    # real data). Shared secret, set to the same value on both Railway
    # services. Empty disables the export endpoint entirely — the catalog
    # is the product, so this fails closed rather than open.
    catalog_sync_token: str = ""
    # Where staging pulls from. Only read when env_name != "production".
    catalog_sync_origin: str = "https://reroot-production.up.railway.app"


settings = Settings()

# Anthropic key validation cache. The /health endpoint reports this so a
# misconfigured key surfaces fast (the previous "configured: bool(env_var)"
# check returned True for empty-but-set keys and for rotated/invalid keys).
# Validated once at startup with a cheap models-list call; refreshable.
_anthropic_key_status: dict = {"valid": None, "checked_at": None, "error": None}


def _check_anthropic_key(api_key: str) -> dict:
    """Return {valid, error}. Does a 1-token completion to validate both auth AND credits."""
    if not api_key:
        return {"valid": False, "error": "ANTHROPIC_API_KEY ausente"}
    try:
        client = Anthropic(api_key=api_key)
        client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1,
            messages=[{"role": "user", "content": "ok"}],
        )
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


# ── iOS Universal Links (Apple App Site Association) ────
# Apple validates this domain belongs to the iOS app by fetching this JSON
# on every app install/update. Once validated, taps on URLs matching the
# `paths` patterns open the auê iOS app instead of Safari.
#
# Format requirements (Apple is strict):
#   - Served over HTTPS (Railway provides)
#   - Content-Type: application/json (NOT pkcs7 — that was iOS 8 era)
#   - No redirects on the path
#   - Apple ID format: <TEAM_ID>.<BUNDLE_ID>
#
# Apple fetches at BOTH /apple-app-site-association and /.well-known/...
# — modern iOS prefers the .well-known path; we serve both for compat.
APPLE_APP_SITE_ASSOCIATION = {
    "applinks": {
        "details": [
            {
                "appIDs": ["GR8L4N89V2.app.aue"],
                "components": [
                    # Match every path so the app handles any reroot URL
                    # users get from share sheets. The HashRouter fragment
                    # (`#/events?event=...`) isn't part of the path — iOS
                    # passes the full URL to the app, where the React
                    # router reads window.location.hash.
                    {"/": "/*"},
                ],
            }
        ]
    }
}


@app.get("/apple-app-site-association")
@app.get("/.well-known/apple-app-site-association")
def apple_app_site_association():
    from fastapi.responses import JSONResponse
    return JSONResponse(content=APPLE_APP_SITE_ASSOCIATION)


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
<meta name="theme-color" content="#0A0510">
<title>auê — Curitiba que acontece</title>
<!-- The card an unfurler builds when this link is pasted into WhatsApp.
     Same tags as index.html and for the same reasons: absolute URLs
     pinned to the canonical origin (unfurlers won't resolve a relative
     og:image), the PNG rather than the SVG (they don't render SVG).
     Without this block the card was a bare title over the domain, which
     is what "não profissional" looked like. -->
<meta name="description" content="Todos os eventos da cidade num lugar só. Instala e vê o que tá rolando hoje." />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="auê" />
<meta property="og:locale" content="pt_BR" />
<meta property="og:title" content="auê — Curitiba que acontece" />
<meta property="og:description" content="Todos os eventos da cidade num lugar só. Instala e vê o que tá rolando hoje." />
<meta property="og:url" content="https://auecuritiba.com/install" />
<meta property="og:image" content="https://auecuritiba.com/og-image.png" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="auê — Curitiba que acontece" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="auê — Curitiba que acontece" />
<meta name="twitter:description" content="Todos os eventos da cidade num lugar só. Instala e vê o que tá rolando hoje." />
<meta name="twitter:image" content="https://auecuritiba.com/og-image.png" />
<link rel="canonical" href="https://auecuritiba.com/install" />
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


def _event_deep_link(event_id: str) -> str:
    """The one in-app URL that opens an event.

    There is NO `/events/:id` route — App.jsx routes `/events` and the
    screen reads `?event=` on mount to open the detail drawer. Anything
    shaped `/#/events/<id>` falls through to the `path="*"` catch-all and
    redirects to the root, so the recipient lands on the start screen
    instead of the event.

    Three push triggers (event invite, co-host promotion, personal-plan
    invite) shipped with that broken shape — the most socially important
    notifications in the app, each dumping the user at the front door.
    Build every event link through here so the shape lives in one place.
    """
    return f"/#/events?event={event_id}"


def _request_origin(request: Request) -> str:
    """The public origin THIS request came in on.

    Preferred over the configured one because it is automatically right
    on a new domain, on staging, and on localhost. Railway terminates TLS
    in front of uvicorn, so request.base_url reports http:// and the
    forwarded headers are the only honest source.
    """
    proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host")
            or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        return settings.public_origin.rstrip("/")
    if not proto:
        proto = "http" if host.split(":")[0] in ("localhost", "127.0.0.1") else "https"
    return f"{proto}://{host}"


# Clients that fetch a URL to build a preview card instead of to read it.
# "bot" is deliberately broad: a false positive costs nothing, because the
# page we serve them also redirects.
_LINK_PREVIEW_UA = re.compile(
    r"whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|slackbot|"
    r"discordbot|linkedinbot|pinterest|skypeuripreview|googlebot|bingbot|"
    r"embedly|quora link preview|redditbot|applebot|vkshare|w3c_validator|"
    r"bot\b|crawler|spider|preview|scraper",
    re.I,
)


def _og_escape(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _preview_html(*, title: str, description: str, image: str, url: str,
                  redirect_to: str) -> str:
    """A card for the crawler, a redirect for the human who slipped through."""
    img_tag = f'<meta property="og:image" content="{_og_escape(image)}" />' if image else ""
    card = "summary_large_image" if image else "summary"
    return f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>{_og_escape(title)}</title>
<meta name="description" content="{_og_escape(description)}" />
<meta property="og:site_name" content="auê" />
<meta property="og:type" content="website" />
<meta property="og:title" content="{_og_escape(title)}" />
<meta property="og:description" content="{_og_escape(description)}" />
<meta property="og:url" content="{_og_escape(url)}" />
{img_tag}
<meta name="twitter:card" content="{card}" />
<meta name="twitter:title" content="{_og_escape(title)}" />
<meta name="twitter:description" content="{_og_escape(description)}" />
<meta http-equiv="refresh" content="0; url={_og_escape(redirect_to)}" />
</head>
<body>
<script>location.replace({json.dumps(redirect_to)});</script>
<p>Abrindo no auê… <a href="{_og_escape(redirect_to)}">toque aqui</a>.</p>
</body>
</html>"""


def _event_preview_card(event_id: str, origin: str) -> Optional[dict]:
    """Title/description/image for a shared event link, or None.

    A PRIVATE event gets its NAME and nothing else. The line to draw is
    what the app already tells a link holder: GET /events/{id} answers
    403 to a stranger, but that 403 carries event_name, because the
    "Pedir convite" screen has to say what you're asking to join. So the
    name is already public to whoever holds the URL, and a card that
    omits it just makes a real invite look like spam.

    Venue, date and the photo are NOT in that payload, so they stay out
    of the card — those are the details that would turn a forwarded link
    into an address and a time for a private party.
    """
    if not event_id:
        return None
    if event_id.startswith("grp_ev_"):
        ge = db.get_group_event(event_id)
        name = (ge or {}).get("name") or ""
        if not name:
            return None
        return {
            "title": f"{name} · auê",
            "description": "Você foi convidado. Abra no auê pra ver quem vai e confirmar.",
            "image": "",
        }
    ev = db.get_event_by_id(event_id)
    if not ev:
        return None
    when = ""
    if ev.date_start:
        try:
            when = ev.date_start.strftime("%d/%m às %H:%M")
        except Exception:
            when = ""
    where = (ev.venue_name or "").strip()
    bits = [b for b in (when, where) if b]
    description = " · ".join(bits)
    extra = (ev.vibe_summary or ev.description or "").strip()
    if extra:
        description = f"{description} — {extra}" if description else extra
    image = (ev.image_url or "").strip()
    if image.startswith("/"):
        image = f"{origin}{image}"
    return {
        "title": f"{ev.name} · auê",
        "description": description[:200] or "Curitiba que acontece",
        "image": image,
    }


@app.get("/e/{event_id}")
def short_event_link(event_id: str, request: Request):
    """Short-link redirect for share URLs. Tradeoff: shorter copy at
    the cost of one extra HTTP hop on the recipient's first tap.
    Universal Links on iOS still match the path (the AASA's component
    `/*` covers /e/* too), so an installed app intercepts before the
    redirect ever runs. For not-installed users, this 302s into the
    full HashRouter URL the React app expects.

    Sharing pattern: appLink('/events?event=<id>') → frontend rewrites
    to /e/<id> when the id starts with grp_ev_ or instagram_ig_, or
    falls back to the long URL for anything else."""
    from fastapi.responses import RedirectResponse, HTMLResponse
    if not event_id:
        return RedirectResponse(url="/", status_code=302)
    target = _event_deep_link(event_id)

    # Humans keep the plain 302 they have always had: no flash, no extra
    # render, and Universal Links still intercept before this ever runs.
    # Only preview crawlers get HTML, so nothing about the installed-app
    # path or the service worker changes.
    ua = request.headers.get("user-agent") or ""
    if not _LINK_PREVIEW_UA.search(ua):
        return RedirectResponse(url=target, status_code=302)

    origin = _request_origin(request)
    card = _event_preview_card(event_id, origin) or {
        "title": "auê — Curitiba que acontece",
        "description": "Todos os eventos da cidade num lugar só, com a galera junto.",
        "image": f"{origin}/icon-512x512.png",
    }
    return HTMLResponse(_preview_html(
        title=card["title"], description=card["description"],
        image=card["image"], url=f"{origin}/e/{event_id}",
        redirect_to=target,
    ))


# auê's public App Store listing. The id is permanent (unlike a TestFlight
# invite link, which rotates), so it's a constant rather than an env var.
APP_STORE_URL = "https://apps.apple.com/app/id6765535013"


@app.get("/install", response_class=PlainTextResponse)
def install_page(request: Request):
    """Universal install entry point. Sniffs the recipient's User-Agent
    and 302s to the right channel:

      - iOS / iPadOS  → TestFlight invite link, if one is set (an active
                        version-bump testing window — see settings.
                        testflight_invite_url); otherwise the public App
                        Store listing.
      - Android       → Play Store internal-testing link
      - Anything else → existing HTML walkthrough (PWA install + manual
                        Add-to-Home-Screen instructions for both platforms)

    Why server-side sniffing instead of a JS redirect on the page: the
    sharer's QR code or pasted link works for any recipient OS without
    them landing on a "tap your platform" intermediary screen. UA can
    be spoofed but it costs nothing here — worst case we send them to
    the wrong store and they hit a "not available" page.
    """
    from fastapi.responses import RedirectResponse
    ua = (request.headers.get("user-agent") or "").lower()
    # Bracket on iPad too — iPadOS still sends "Mac OS X" with a "Mobile"
    # token in some Safari versions, but the most reliable signal is the
    # iPhone/iPad/iPod string.
    is_ios = (
        ("iphone" in ua or "ipad" in ua or "ipod" in ua)
        # iPadOS 13+ Safari masquerades as Mac — heuristic: "Mac OS X" UA
        # AND multi-touch hint. We err on the side of NOT redirecting
        # desktop Macs accidentally; iPad users can fall through to /install
        # and tap the Add-to-Home-Screen walkthrough.
    )
    is_android = "android" in ua
    if is_ios:
        url = settings.testflight_invite_url or APP_STORE_URL
        return RedirectResponse(url=url, status_code=302)
    if is_android and settings.play_store_internal_url:
        return RedirectResponse(url=settings.play_store_internal_url, status_code=302)
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
        # Which environment answered. Without this there is no way to tell
        # from outside whether the staging service actually has
        # ENV_NAME=staging — it defaults to "production" when unset, so
        # anything gated on it would behave as prod on staging.
        "env_name": settings.env_name,
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
        # Reflects the AI_GAP_FILL switch, not just key validity — the
        # feature is off by default (it fabricates events).
        "ai_gap_fill_configured": bool(
            settings.ai_gap_fill and _anthropic_key_status.get("valid")
        ),
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
    # The host-first pre-sort that used to live here moved into
    # _dedupe_events, which now orders its own input by (_source_rank,
    # date_start) — the other three callers never pre-sorted at all, so
    # they inherited whatever order SQLite returned. The featured-first
    # re-sort below re-establishes the final order either way.
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

    Ordering decides who survives, since the loop below keeps the first
    occurrence — so this sorts its own input rather than trusting callers
    to do it. Primary key is _source_rank (the venue's own post beats a
    hand-typed submission of the same night); secondary is date_start ASC,
    which keeps Tier 2.5 collapsing multiple sessions to the earliest one.
    Three of the four callers never pre-sorted at all, so they used to
    inherit whatever order SQLite returned.
    """
    NAME_JACCARD = 0.6
    # When venue already matches, accept lower Jaccard but require at
    # least 2 shared distinctive tokens. Pure Jaccard at 0.3 would
    # false-positive on "Show de Música" vs "Workshop de Música" (1
    # shared token); requiring ≥ 2 shared tokens fixes that.
    NAME_VENUE_SHARED_MIN = 2
    NAME_VENUE_JACCARD = 0.3
    VENUE_JACCARD = 0.4
    events = sorted(events, key=lambda ev: (
        _source_rank(ev),
        ev.date_start or datetime.max.replace(tzinfo=timezone.utc),
    ))
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


@functools.lru_cache(maxsize=1)
def _known_ig_handles_by_length() -> tuple:
    """Every tracked handle, enabled or not, longest first. Used to read a
    handle out of an external_id unambiguously."""
    return tuple(sorted(
        (a["handle"].lower() for a in db.list_ig_accounts()),
        key=len, reverse=True,
    ))


def _ig_handle_from_external_id(ext: str) -> str:
    """`ig_<handle>_<shortcode>[-<MMDD>]` -> handle, or "".

    Counting underscores does not work here and never really did: handles
    carry them ("damarate_confeitaria") and so do shortcodes. It survived
    because "everything between the first and last underscore" happened to
    be right while ids had exactly two. A lineup post appends a date suffix
    to the second and later events, which broke that assumption — the
    handle came back as "changes.cwb_ABC123", matched no tracked account,
    and _is_active_source silently dropped those events from the catalog
    while the venue's own Painel (a prefix LIKE) still listed them.

    Match against the handles we actually track instead. That is the only
    unambiguous reading, and it is what the scraper already does when it
    attributes scraped events back to a handle.
    """
    if not ext or not ext.startswith("ig_"):
        return ""
    rest = ext[3:]
    low = rest.lower()
    for handle in _known_ig_handles_by_length():
        if low.startswith(f"{handle}_"):
            return handle
    # Untracked handle (deleted account, legacy row): fall back to the old
    # shape, after dropping a date suffix if one is present.
    rest = re.sub(r"[-_]\d{4}$", "", rest)
    idx = rest.rfind("_")
    return rest[:idx].lower() if idx > 0 else ""


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
    # User submissions ("Adicionar ao catálogo" / SubmitEventSheet). Not a
    # scraper, so there is nothing to deactivate — but this function was
    # written during the April scraper cleanup as an allowlist of the two
    # sources still running, and "submitted" fell into the "no longer run"
    # bucket below. Every submission was saved and then silently dropped
    # from /events while the app told the user it would appear "em
    # instantes"; the only ones that ever reached the DB came in duplicate
    # pairs, i.e. people resubmitting because the first never showed up.
    if source == "submitted":
        return True
    if source == "instagram":
        handle = _ig_handle_from_external_id(ev.external_id or "")
        return bool(handle) and handle in _enabled_ig_handles()
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
    _known_ig_handles_by_length.cache_clear()
    _enabled_ig_handles_cached.cache_clear()
    _curator_ig_handles_cached.cache_clear()
    _featured_ig_handles_cached.cache_clear()
    _venue_promo_cached.cache_clear()


def _handle_for_event(ev) -> str:
    """Extract the IG handle from an event's external_id. Returns '' for
    non-IG events (aue_original) or malformed ids."""
    if (ev.source or "").lower() != "instagram":
        return ""
    return _ig_handle_from_external_id(ev.external_id or "")


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


def _source_rank(ev) -> int:
    """Precedence when two rows turn out to be the same event. Lower wins.

    The venue's own Instagram post beats a manual submission of the same
    night: a submission is a one-time snapshot someone typed (or a curator
    approved once), while the venue's post is re-scraped and re-enriched
    every day, so it carries the real time, venue line and description.
    aue_original sits above both — hand-curated institutional events, not
    a scrape of anything. Curator handles come last: they repost other
    people's nights, so their copy is the least authoritative.

    This used to be decided by insertion order, which meant the
    submission usually won — a curator approves a suggestion before the
    next scrape runs, so its row landed first. Same class of bug as the
    curator-vs-venue coin flip that the (is_curator, date_start) pre-sort
    fixed; this generalizes that fix to every source.
    """
    source = (ev.source or "").lower()
    if source == "aue_original":
        return 0
    if source == "instagram":
        return 3 if _is_curator_event(ev) else 1
    return 2  # submitted, and anything else that still reaches dedup


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


_SOURCE_BACKED_FIELDS = ("name", "venue", "date_start", "date_end", "description", "image_url")


def _merge_source_event(ge: dict) -> dict:
    """Overlay the catalog twin's current values onto a private event that
    was created from the same Instagram post.

    A private event built from an IG link used to be a photograph of one
    client-side parse of that post: wrong time, the handle sitting in the
    venue line, no cover image, and no way to ever improve — while the
    catalog held the same post enriched, re-scraped and correct. Two
    cards for one night out, disagreeing with each other.

    They are one post, so they read one set of facts. The private layer
    (who's invited, the note, co-hosts, RSVPs) stays on this row, and any
    field a human actually edited is pinned in edited_fields and wins.
    Falls back to the stored copy when the catalog row is gone.
    """
    src_id = (ge.get("source_event_id") or "").strip()
    if not src_id:
        # Rows created before the link existed carry only the post URL.
        # Resolve it once and write it down — every event made from a
        # link the catalog already had is in this state, and they are
        # the ones showing the wrong time and no cover today.
        src_id = db.find_catalog_event_id_by_shortcode(
            _ig_shortcode(_source_url_of(ge))
        )
        if not src_id:
            return ge
        db.set_group_event_source(ge["id"], src_id)
    src = db.get_event_by_id(src_id)
    if not src:
        return ge
    pinned = set(ge.get("edited_fields") or [])
    merged = dict(ge)
    # The two rows don't share a vocabulary: a catalog event calls the
    # place venue_name and holds its dates as datetimes, while a private
    # event stores venue and ISO strings. Translate here, once — reading
    # src.venue raised AttributeError on every linked event, which is a
    # 500 on the event screen.
    values = {
        "name": src.name,
        "venue": src.venue_name,
        "date_start": _as_iso(src.date_start),
        "date_end": _as_iso(src.date_end),
        "description": src.description,
        "image_url": src.image_url,
    }
    for field in _SOURCE_BACKED_FIELDS:
        if field in pinned:
            continue
        value = values.get(field)
        if isinstance(value, str):
            value = value.strip()
        if not value:
            continue  # the catalog has nothing better to say
        if field == "description":
            # Keep the "Ver original:" suffix this row carries — it's how
            # the private event links back to the post.
            merged[field] = _description_with_source(value, _source_url_of(ge))
        else:
            merged[field] = value
    return merged


def _as_iso(value) -> str:
    """Catalog dates are datetimes, private-event dates are ISO strings.
    Everything downstream parses strings."""
    if not value:
        return ""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _source_url_of(ge: dict) -> str:
    m = re.search(r"Ver original:\s*(\S+)", ge.get("description") or "")
    return m.group(1).rstrip(".,;") if m else ""


def _group_event_to_frontend(ge: dict, group_name: str = "", viewer_google_id: str = "",
                             prefer_group_id: Optional[str] = None) -> dict:
    """Shape a `group_events` row into the EnrichedEvent dict the frontend
    consumes. Used by GET /events/{id} and GET /events/group so both paths
    return identical shapes.

    Viewer-awareness: the group tag (groupId/groupName) is only exposed
    to viewers who are *also* in that group. An outsider invitee — added
    to extra_invitee_ids without joining the group — sees the event as a
    plain personal event with no source-group label. This is how we
    honor "invite an outsider to a group event without revealing the
    group" without diverging the event into two rows. When viewer is
    unknown (empty string), we default to hiding the group context — a
    safe-by-default for any unauthenticated read paths.

    Multi-group: an event can belong to several groups at once, and the
    label names one the VIEWER is in rather than the primary. Checking
    only `group_id` meant a member of a SECOND group saw the event as a
    personal invite — no group named, not even inside that group's own
    screen, which is where they were looking at it from.

    `prefer_group_id` is the group whose screen we're rendering. Someone
    in both groups opening Turma B should read "Turma B", not whichever
    group happened to be tagged first."""
    from datetime import datetime as _dt
    # One post, one set of facts — see _merge_source_event. Guarded: the
    # merge reads a second row's shape, and getting that wrong turned
    # every linked event into a 500 instead of a slightly stale card.
    try:
        ge = _merge_source_event(ge)
    except Exception as exc:
        log.warning(f"source merge failed for {ge.get('id')}: {exc}")
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
    # Group tag is exposed to the viewer only for groups they're a
    # member of. Non-members on the invitee list (outsiders) see the
    # event as if it were ungrouped — drives "invite outsider without
    # leaking the group" semantics.
    #
    # Every group this event belongs to, primary first, deduped.
    # group_ids is authoritative; group_id is the primary kept for
    # callers that predate multi-group.
    linked_ids: list[str] = []
    for gid in [ge.get("group_id"), *(ge.get("group_ids") or [])]:
        if gid and gid not in linked_ids:
            linked_ids.append(gid)
    viewer_group_ids = [
        gid for gid in linked_ids
        if viewer_google_id and db.get_group_member_role(gid, viewer_google_id)
    ]
    # Prefer the group whose screen this is, then whichever the viewer
    # is in. Falling back to the primary regardless is what showed a
    # secondary group's members a "personal invite".
    if prefer_group_id and prefer_group_id in viewer_group_ids:
        visible_group_id = prefer_group_id
    else:
        visible_group_id = viewer_group_ids[0] if viewer_group_ids else None
    show_group = visible_group_id is not None
    if not show_group:
        visible_group_name = ""
    elif visible_group_id == ge.get("group_id") and group_name:
        visible_group_name = group_name        # caller already resolved it
    else:
        visible_group_name = (db.get_group(visible_group_id) or {}).get("name") or ""
    # Every channel of the viewer's this event sits in, named, with the
    # visible one first. groupName names exactly one of them, which is
    # right for a screen that is already inside a channel and wrong for
    # a list: there the card has to say where the night came from, and
    # an event in two channels was answering that question twice — once
    # per row, because each channel's copy arrived by its own path.
    visible_group_names: list[str] = []
    if show_group:
        ordered = [visible_group_id] + [
            gid for gid in viewer_group_ids if gid != visible_group_id
        ]
        for gid in ordered:
            nm = (visible_group_name if gid == visible_group_id
                  else (db.get_group(gid) or {}).get("name") or "")
            if nm and nm not in visible_group_names:
                visible_group_names.append(nm)
    # Personal-event mode (frontend uses this to pick "Convite de Ciro"
    # over a group label, and to bypass group-membership UI affordances).
    # Now defined per-viewer: an outsider on a group-tagged event sees
    # the event in its personal flavor — no source group leaks through.
    is_personal = not show_group
    creator_id = ge.get("created_by") or ""
    creator_name = ""
    creator_picture = ""
    if creator_id:
        cstate = db.get_user_state(creator_id) or {}
        cgoogle = cstate.get("googleUser") or {}
        creator_name = cstate.get("userName") or cgoogle.get("givenName") or cgoogle.get("name") or ""
        creator_picture = db.user_picture(cstate)
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
        # Multi-day ranges (Carnaval, a weekend trip, a 3-day festival).
        # The column and the create endpoint have always accepted this;
        # the payload used to drop it, which silently collapsed every
        # private event to a single day. The frontend's eventCoversDay()
        # needs it to light the event up on each day of the range in the
        # week strip and the per-day filter.
        "dateEnd": ge.get("date_end") or None,
        "venueAddress": "",
        "city": "Curitiba",
        # User-uploaded images live on the same /event-images/ mount as
        # catalog rehosts. Empty string means "no image; render the
        # default sage gradient on the hero." cache_busted appends a
        # ?v=<mtime> param so iOS WKWebView refetches when the user
        # replaces the photo (without it, the cached old image stays
        # visible because the URL bytes are identical).
        "imageUrl": image_store.cache_busted(ge.get("image_url") or "") or None,
        "isCustom": False,
        # Group-event markers — the frontend uses these to render the lock
        # pill, group-name link, and to gate any "private" affordances.
        # Personal plans set isPersonalPlan=true; isGroupEvent stays true
        # so the existing "private/yours" sage stripe is reused.
        "isGroupEvent": True,
        "isPersonalPlan": is_personal,
        "groupId": visible_group_id,
        "groupName": visible_group_name,
        # Multi-group: full list of groups this event is linked to.
        # Frontend uses this for the AddToGroupSheet "Já adicionado"
        # check and to show all groups the event belongs to.
        # Only the ones the viewer is actually in. The full list used to
        # ship to everyone, which handed an outsider the ids of groups
        # the three lines above go out of their way to hide.
        "groupIds": viewer_group_ids,
        # Names for those ids, visible one first. See above: a list row
        # names all of them, a channel screen names the one you're on.
        "groupNames": visible_group_names,
        # How many of the viewer's own groups this single event belongs
        # to. Lets the card say "Turma A +1" instead of implying the
        # event lives in one place.
        "viewerGroupCount": len(viewer_group_ids),
        "createdBy": ge.get("created_by"),
        "createdByName": creator_name,
        "createdByPicture": creator_picture,
        "inviteeCount": len(ge.get("extra_invitee_ids", []) or []),
        # Full invitee list — needed by the post-creation invite picker
        # so it can filter out already-invited friends. Anyone who can
        # see the event already sees these google_ids via the
        # /events/{id}/attendees endpoint, so this isn't a fresh
        # privacy surface.
        "extraInviteeIds": list(ge.get("extra_invitee_ids", []) or []),
        # Co-hosts — invitees promoted to share the creator's invite +
        # delete privileges. Frontend uses this to extend the
        # "Adicionado por" chip and gate the manage sheet.
        "coHostIds": list(ge.get("co_host_ids", []) or []),
        # Did THIS viewer say "Não vou"? Drives the "você recusou" state
        # on the event, which replaces the Vou/Não vou pair with a way
        # back in. Viewer-scoped: who else declined is the host's
        # business (see the declined list in /attendees), not every
        # guest's.
        "youDeclined": bool(
            viewer_google_id and viewer_google_id in (ge.get("declined_ids") or [])
        ),
        "note": ge.get("note") or "",
        # Source venue handle when this row was forked from a public IG
        # catalog event. Frontend uses it to fire `event_view` analytics
        # against the source venue so the original Painel still gets
        # credit for downstream attention.
        "sourceIgHandle": ge.get("source_ig_handle") or "",
        # The catalog event this one mirrors, when it came from a post the
        # catalog also has. The frontend uses it to treat the two as one
        # event — chiefly so declining the private one also quiets the
        # public one on Home.
        "sourceEventId": ge.get("source_event_id") or "",
    }


@app.get("/events/group")
def list_user_group_events(google_id: str):
    """Return all upcoming private events the user can see — single rule:
    they're the creator or appear in extra_invitee_ids. After the May
    2026 unification this collapses what used to be three separate
    queries (group events / personal plans / hybrid) into one.
    Shaped like catalog events."""
    if not google_id:
        return {"events": []}
    today = date.today().isoformat()
    # Cache group lookups so we don't hit the DB once per event when
    # several events share a tagged group.
    group_name_cache: dict[str, str] = {}

    def _resolve_group_name(group_id: Optional[str]) -> str:
        if not group_id:
            return ""
        if group_id not in group_name_cache:
            group = db.get_group(group_id)
            group_name_cache[group_id] = (group or {}).get("name") or ""
        return group_name_cache[group_id]

    out: list[dict] = []
    for ge in db.get_events_visible_to_user(google_id):
        ds = ge.get("date_start") or ""
        if ds and ds[:10] < today:
            continue
        # A PUBLIC channel's events are not the curator's personal
        # plans, even though the curator created the row. Without this,
        # whoever publishes into one gets every event back in their own
        # private feed — sorted above the catalog with the "your plan"
        # treatment, while everyone else sees an ordinary card.
        #
        # They reach people through the band above Eventos and the
        # marker on the catalog row, which is the same for the curator
        # as for anyone else.
        #
        # Private channels are the opposite case and must NOT be
        # excluded: their events reach members through exactly this
        # feed, because members were invited to them. Scoping this to
        # public channels is the difference, and getting it wrong
        # emptied every crew's feed at once.
        linked_gids = {ge.get("group_id"), *(ge.get("group_ids") or [])}
        linked_gids.discard(None)
        linked_gids.discard("")
        if any(db.is_public_channel(gid) for gid in linked_gids):
            continue
        # An orphaned catalog fork is not a plan.
        #
        # Taking a night out of its last channel nulls the group and
        # keeps the row (unlink_event_from_group), which leaves a copy
        # of a catalog event belonging to no channel and invited to by
        # nobody. Every surface here reads a group-less event as a plan
        # its creator made, so it came back as an unremovable private
        # plan — with a padlock, on an event anyone can see in the
        # catalog. The catalog row already represents it.
        #
        # Suppressed rather than deleted: adding to a channel
        # auto-RSVPs the creator, so these rows carry a real RSVP and
        # throwing them away would throw that away too. Re-adding the
        # event re-links this very row (find_orphaned_fork), and it
        # comes back as the channel's event.
        #
        # Narrow: a fork with invitees or a note is something a person
        # built on top of the catalog row, and that IS a plan.
        if (not linked_gids
                and (ge.get("source_event_id") or "").strip()
                and not (ge.get("extra_invitee_ids") or [])
                and not (ge.get("note") or "").strip()):
            continue
        # "Só aqui dentro — fora dos Eventos" is what the ☆ switch
        # promises, and until now it promised it to nobody: the flag was
        # only read by the public-channel feed. A private channel's
        # events arrive through here, so this is where turning it off
        # has to take effect.
        #
        # Any, not all: an event in a muted channel and a live one is
        # still an event you asked to see. Muting one channel is not a
        # way to hide what another one is telling you about.
        if linked_gids and all(
            not db.get_channel_prioritize(gid, google_id) for gid in linked_gids
        ):
            continue
        out.append(_group_event_to_frontend(
            ge,
            group_name=_resolve_group_name(ge.get("group_id")),
            viewer_google_id=google_id,
        ))

    out.sort(key=lambda e: e.get("dateStart") or "9999-99-99")
    return {"events": out}


def _declined_but_in_its_group(ge: dict, google_id: str) -> bool:
    """A guest who declined keeps access while the event still belongs to
    a group they're in — the same rule get_events_visible_to_user applies.

    Without it the event listed on the group screen 404s for the one
    person whose state that screen exists to explain, and "mudei de
    ideia" has nowhere to happen.
    """
    if not google_id or google_id not in (ge.get("declined_ids") or []):
        return False
    for gid in {ge.get("group_id"), *(ge.get("group_ids") or [])}:
        if gid and db.get_group_member_role(gid, google_id):
            return True
    return False


@app.get("/events/{event_id}")
def get_event(event_id: str, google_id: str = ""):
    # Catalog events first.
    ev = db.get_event_by_id(event_id)
    if ev:
        return _to_frontend(ev, detail=True, venue_coords=db.get_venue_coords_map())

    # Fallback: private events (ids start with "grp_ev_"). After the May
    # 2026 model unification, every private event — group-tagged or not
    # — uses the same visibility rule: the viewer must be the creator or
    # in extra_invitee_ids. Group membership alone no longer grants
    # access; the creation flow snapshots members into the invitee list,
    # and the migration in database.py backfilled legacy rows. The
    # group_id stays as a metadata tag (drives the group calendar feed
    # and the in-card group label, but not access).
    if event_id.startswith("grp_ev_"):
        ge = db.get_group_event(event_id)
        if ge:
            # A fork of a public channel is a public event. The
            # creator-or-invitee rule below is for private plans; it
            # used to admit followers by accident, because publishing
            # into a channel wrote every follower onto the invitee list.
            # Once that stopped (following is not being invited), every
            # public-channel fork 403'd for everyone but its curator —
            # "tento entrar via canal e dá como se fosse privado".
            linked = {ge.get("group_id"), *(ge.get("group_ids") or [])} - {None, ""}
            is_public_fork = any(db.is_public_channel(g) for g in linked)
            invitees = ge.get("extra_invitee_ids") or []
            creator_id = ge.get("created_by")
            is_invitee = bool(google_id and google_id in invitees)
            is_creator = bool(google_id and google_id == creator_id)
            if is_public_fork or is_creator or is_invitee or _declined_but_in_its_group(ge, google_id):
                group_name = ""
                if ge.get("group_id"):
                    group = db.get_group(ge["group_id"])
                    group_name = (group or {}).get("name") or ""
                return _group_event_to_frontend(
                    ge, group_name=group_name, viewer_google_id=google_id,
                )
            # Forbidden — but include enough info for the frontend to
            # show "Pedir convite" instead of just a hard lock screen.
            # request_status: 'none' | 'pending' | 'rejected' decides
            # the button state. event_name surfaces in the request UX
            # so the user knows what they're asking to join.
            req_status = (
                db.get_invite_request_status(event_id, google_id) or "none"
                if google_id else "none"
            )
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "private_event",
                    "message": "Evento privado — só convidados podem ver",
                    "event_id": event_id,
                    "event_name": ge.get("name") or "",
                    "can_request": bool(google_id) and req_status != "rejected",
                    "request_status": req_status,
                },
            )

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
    # Last day of a multi-day run (festival, exhibition, Carnaval). Optional
    # — a one-off event leaves it None and renders on its start day only.
    # EnrichmentPipeline already carries date_end from RawEvent through to
    # the enriched row, so both submission paths below just pass it along.
    date_end: Optional[str] = None
    price_min: float = 0.0
    price_max: float = 0.0
    url: str = ""
    submitted_by: Optional[str] = None  # google_id
    ig_handle: str = ""               # if sourced from an IG post — auto-tracked
    # Post image from /events/extract-ig (Apify displayUrl). Until this
    # existed the form received the image and dropped it, and neither save
    # path had anywhere to put it — every submitted event rendered with the
    # gradient fallback. Rehosted on save; see _rehost_submission_image.
    image_url: str = ""


def _parse_submission_date(value: str):
    """Parse the frontend's date string in any of the three shapes an
    <input type="datetime-local"> / type="date" pair can produce. Returns
    a UTC-aware datetime, or None when the string is unusable."""
    import datetime as _dt
    from datetime import timezone as _tz
    if not value:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return _dt.datetime.strptime(value, fmt).replace(tzinfo=_tz.utc)
        except ValueError:
            pass
    return None


# Hosts a submitted image may be fetched from. The server downloads this
# URL, and the URL comes from the client, so an open fetch would let anyone
# point our backend at internal addresses (SSRF). Instagram serves post
# images from these CDNs, which is the only source the submit form offers.
_SUBMISSION_IMAGE_HOSTS = ("cdninstagram.com", "fbcdn.net")


async def _rehost_submission_image(event_id: str, source_url: str) -> Optional[str]:
    """Copy a submitted post image into our own store and return the URL to
    save on the event.

    IG CDN links are signed and expire within weeks, so storing the raw link
    would blank the card later — the scraper rehosts for the same reason.
    Falls back to the original CDN link when the download fails (it still
    works until it rots), and returns None for anything that isn't an https
    Instagram CDN URL.
    """
    url = (source_url or "").strip()
    if not _is_allowed_submission_image(event_id, url):
        return None
    # rehost_image is synchronous httpx — keep it off the event loop, same
    # as the scrape pipeline does.
    rehosted = await asyncio.to_thread(image_store.rehost_image, event_id, url)
    return rehosted or url


def _is_allowed_submission_image(event_id: str, url: str) -> bool:
    """https + Instagram CDN host only. See _SUBMISSION_IMAGE_HOSTS."""
    from urllib.parse import urlparse
    if not url:
        return False
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not any(
        host == h or host.endswith("." + h) for h in _SUBMISSION_IMAGE_HOSTS
    ):
        log.warning(f"Image for {event_id} rejected: host '{host}' not allowed")
        return False
    return True


def _attach_instagram_post(event: dict, image_url: str, source_url: str) -> dict:
    """Store the cover image for a private event created from an Instagram
    link. Called from the sync create endpoints, which FastAPI already runs
    in a worker thread, so the download can block here.

    Rehosted under the event id — the same filename a manual photo upload
    uses — so the existing delete cascade and cache-busting cover it. Keeps
    the CDN link as a fallback when the download fails, like the scraper.
    """
    url = (image_url or "").strip()
    if not url or not _is_allowed_submission_image(event["id"], url):
        return event
    stored = image_store.rehost_image(event["id"], url) or url
    if db.set_event_image_url(event["id"], stored):
        event["image_url"] = stored
    return event


def _description_with_source(description: str, source_url: str) -> str:
    """Append "Ver original: <link>" for an Instagram post link.
    _group_event_to_frontend already extracts that suffix into the event's
    `url` (the "Ver no Instagram" button) and strips it from the visible
    description — the same convention catalog forks use — so a private
    event can carry its source link without a schema change."""
    desc = (description or "").strip()
    link = (source_url or "").strip()
    if not link or not re.match(r"https://(www\.)?instagram\.com/", link) or "Ver original:" in desc:
        return desc
    return f"{desc}\n\nVer original: {link}".strip()


_IG_POST_RE = re.compile(r"instagram\.com/(?:p|reel)/([A-Za-z0-9_-]+)")


def _ig_shortcode(url: str) -> str:
    m = _IG_POST_RE.search(url or "")
    return m.group(1) if m else ""


def _catalog_event_id_for(shortcode: str) -> str:
    """One catalog row per Instagram post, whoever suggested it and however
    many times: approving the same post again updates this row instead of
    adding a second card."""
    return f"submitted_igpost_{shortcode}"


def _queue_catalog_request(event: dict, req, background_tasks: BackgroundTasks) -> None:
    """Suggest the Instagram post behind a new private event for the public
    catalog, and tell the curators.

    The private event is already live for its invitees; only the public
    copy waits for review. A post is never queued twice: if it was already
    approved, the new private event just links to that catalog event; if a
    request is already open, this one rides on it.
    """
    shortcode = _ig_shortcode(req.source_url)
    if not shortcode:
        return
    # Bind to the catalog's copy of this post whichever way it got there:
    # a curator-approved suggestion, or the daily scrape of a tracked
    # handle. Only the first id shape was checked here before, so pasting
    # a link to a post from a handle we already track — most posts —
    # produced a private event bound to nothing, which is how one night
    # out ended up as two cards that disagreed.
    existing = db.find_catalog_event_id_by_shortcode(shortcode)
    if existing:
        db.set_group_event_source(event["id"], existing)
        return
    if db.find_catalog_request_by_shortcode(shortcode):
        return
    post = req.post or {}
    name = (post.get("name") or "").strip()
    date_start = (post.get("date_start") or "").strip()
    if not (name and _parse_submission_date(date_start)):
        # The post didn't read as an event (no title or date) — nothing a
        # curator could publish. The private event stands on its own.
        return
    venue = (post.get("venue_name") or "").strip()
    handle = re.sub(
        r"[^A-Za-z0-9._]", "",
        (post.get("handle") or req.source_ig_handle or "").lstrip("@"),
    )[:30].lower()
    image = (post.get("image_url") or req.image_url or "").strip()
    request_id = db.insert_catalog_request(
        name=name[:200],
        description=(post.get("description") or "").strip()[:2000],
        venue_name=venue[:200],
        date_start=date_start,
        url=f"https://www.instagram.com/p/{shortcode}/",
        image_url=image if _is_allowed_submission_image(f"request_{shortcode}", image) else "",
        ig_handle=handle,
        shortcode=shortcode,
        group_event_id=event["id"],
        submitted_by=req.google_id,
    )
    background_tasks.add_task(
        _notify_curators_of_request, request_id, name, venue,
        _user_display_name(req.google_id),
    )


def _notify_curators_of_request(request_id: int, name: str, venue: str, requester: str) -> None:
    """Push every curator. Roles are stored by email and pushes by account
    id, so this joins through users.email — a curator who signs in only via
    Apple's private-relay address won't be reached until the curator email
    on file is that relay address."""
    body = f"{requester} sugeriu: {name}" + (f" · {venue}" if venue else "")
    for uid in db.user_ids_for_emails(db.list_curator_emails()):
        try:
            _send_push_to_user(
                uid,
                title="📋 Evento pra curadoria",
                body=body[:180],
                url=f"/#/curadoria/{request_id}",
                tag=f"catalog-request-{request_id}",
            )
        except Exception as exc:
            log.warning(f"Catalog request {request_id}: push to {uid} failed: {exc}")


def _build_catalog_event(*, event_id: str, external_id: str, name: str,
                         description: str, venue_name: str, date_start,
                         url: str, image_url: str):
    """A publishable catalog event from curator-approved fields. Generic
    category until _enrich_catalog_event fills it in the background."""
    from models import EnrichedEvent
    return EnrichedEvent(
        id=event_id,
        source="submitted",
        external_id=external_id,
        name=name[:200],
        description=(description or "")[:1000],
        venue_name=(venue_name or "")[:200],
        venue_address="",
        neighborhood="",
        city=settings.city,
        date_start=date_start,
        date_end=None,
        price_min=0.0,
        price_max=0.0,
        currency="BRL",
        capacity=None,
        attendees_confirmed=0,
        kind="community",
        category_label="Evento",
        category_emoji="🎉",
        has_food=False,
        is_low_pressure=False,
        is_curated=False,
        pitch=(description or "")[:200] or name,
        kids_welcome=False,
        price_tier="free",
        vibe_summary=name,
        expected_size="medium",
        header_gradient="linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        url=url[:500],
        image_url=image_url or None,
        fetched_at=datetime.now(timezone.utc),
    )


def _enrich_catalog_event(ev) -> None:
    """Fill category, pitch and vibe with the same Claude pass the scraper
    uses, keeping the approved name, date, venue and image. Runs after
    approval so publishing never waits on the model; on failure the event
    simply keeps the generic "Evento" category."""
    if not settings.anthropic_api_key:
        return
    try:
        from enrichment import EnrichmentPipeline
        from models import RawEvent
        raw = RawEvent(
            source=ev.source, external_id=ev.external_id, name=ev.name,
            description=ev.description, venue_name=ev.venue_name,
            venue_address=ev.venue_address, city=ev.city,
            date_start=ev.date_start, url=ev.url, image_url=ev.image_url,
        )
        enriched = EnrichmentPipeline(api_key=settings.anthropic_api_key).enrich(raw)
        if enriched:
            db.upsert_event(enriched)
    except Exception as exc:
        log.warning(f"Catalog enrichment for {ev.id} failed: {exc}")


async def _save_unenriched_submission(submission_id: int, req: EventSubmission) -> None:
    """Write a user submission straight to the events table without Claude enrichment.
    Used when Anthropic credits are unavailable. Enrichment will overwrite on the
    next scrape cycle once credits are restored."""
    from models import EnrichedEvent

    ds = _parse_submission_date(req.date_start)
    if not ds:
        log.warning(f"Unenriched submission {submission_id}: invalid date_start '{req.date_start}'")
        return
    # A malformed end date degrades to "one-off event" rather than
    # rejecting the whole submission — the start date is what matters.
    de = _parse_submission_date(req.date_end or "")
    image_url = await _rehost_submission_image(f"submitted_sub_{submission_id}", req.image_url)

    price_min = req.price_min or 0.0
    if price_min == 0:
        price_tier = "free"
    elif price_min <= 50:
        price_tier = "low"
    elif price_min <= 150:
        price_tier = "medium"
    else:
        price_tier = "high"

    ev = EnrichedEvent(
        id=f"submitted_sub_{submission_id}",
        source="submitted",
        external_id=f"sub_{submission_id}",
        name=req.name.strip()[:200],
        description=req.description.strip()[:1000],
        venue_name=req.venue_name.strip()[:200],
        venue_address=req.venue_address.strip()[:300],
        neighborhood="",
        city=req.city.strip() or settings.city,
        date_start=ds,
        date_end=de,
        price_min=price_min,
        price_max=req.price_max or 0.0,
        currency="BRL",
        capacity=None,
        attendees_confirmed=0,
        kind="community",
        category_label="Evento",
        category_emoji="🎉",
        has_food=False,
        is_low_pressure=False,
        is_curated=False,
        pitch=req.description.strip()[:200] or req.name.strip(),
        kids_welcome=False,
        price_tier=price_tier,
        vibe_summary=req.name.strip(),
        expected_size="medium",
        header_gradient="linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        url=req.url.strip()[:500],
        image_url=image_url,
        fetched_at=datetime.now(timezone.utc),
    )
    try:
        db.upsert_event(ev)
        db.mark_submitted_enriched(submission_id, ev.id)
        log.info(f"Unenriched submission {submission_id} → catalog as {ev.id}")
    except Exception as e:
        log.error(f"Unenriched submission {submission_id}: save error: {e}")


async def _enrich_and_save_submission(submission_id: int, req: EventSubmission):
    """Background task: enrich a submitted event with Claude then upsert into events table."""
    if not settings.anthropic_api_key:
        return

    from enrichment import EnrichmentPipeline
    from models import RawEvent

    ds = _parse_submission_date(req.date_start)
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
        date_end=_parse_submission_date(req.date_end or ""),
        price_min=req.price_min,
        price_max=req.price_max,
        url=req.url[:500],
    )

    pipeline = EnrichmentPipeline(api_key=settings.anthropic_api_key)
    enriched = pipeline.enrich(raw)
    if not enriched:
        log.warning(f"Submission {submission_id}: enrichment failed")
        return

    enriched.image_url = await _rehost_submission_image(enriched.id, req.image_url)

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


def _regex_extract_ig_fields(result: dict, caption: str, post: dict) -> None:
    """
    Best-effort field extraction from caption when Claude is unavailable.
    Mutates `result` in place; only sets fields that are still None.
    """
    import datetime as dt
    today = dt.datetime.now(dt.timezone.utc)
    cl = caption.lower()

    # ── Date ─────────────────────────────────────────────────────────────────
    # "Neste sábado (29)", "sexta (28/08)", "sábado, 30/08", "30/08", "30 de agosto"
    MONTHS_PT = {"janeiro":1,"fevereiro":2,"março":3,"abril":4,"maio":5,"junho":6,
                 "julho":7,"agosto":8,"setembro":9,"outubro":10,"novembro":11,"dezembro":12}
    WEEKDAYS_PT = {"segunda":0,"terça":1,"quarta":2,"quinta":3,"sexta":4,"sábado":5,"domingo":6}

    date_obj = None

    # DD/MM or DD/MM/YYYY
    m = re.search(r'\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b', caption)
    if m:
        day, mon = int(m.group(1)), int(m.group(2))
        year = int(m.group(3)) if m.group(3) else today.year
        if len(str(year)) == 2: year += 2000
        try: date_obj = dt.date(year, mon, day)
        except ValueError: pass

    # "dia 29", "sábado (29)", "sexta (28)"
    if not date_obj:
        m = re.search(r'(?:dia\s+|(?:' + '|'.join(WEEKDAYS_PT) + r')\s*\()(\d{1,2})\)?', cl)
        if m:
            day = int(m.group(1))
            for delta in range(0, 32):
                candidate = (today + dt.timedelta(days=delta)).date()
                if candidate.day == day:
                    date_obj = candidate
                    break

    # "30 de agosto"
    if not date_obj:
        m = re.search(r'\b(\d{1,2})\s+de\s+(' + '|'.join(MONTHS_PT) + r')\b', cl)
        if m:
            day, month = int(m.group(1)), MONTHS_PT[m.group(2)]
            year = today.year if month >= today.month else today.year + 1
            try: date_obj = dt.date(year, month, day)
            except ValueError: pass

    # "neste/próximo sábado/sexta" without explicit day number
    if not date_obj:
        for name, wd in WEEKDAYS_PT.items():
            if re.search(r'\b(?:neste?|nessa?|pr[oó]xim[oa])\s+' + name, cl):
                days_ahead = (wd - today.weekday()) % 7 or 7
                date_obj = (today + dt.timedelta(days=days_ahead)).date()
                break

    # ── Time ─────────────────────────────────────────────────────────────────
    # "às 19h", "19h30", "19:00", "abre às 21h"
    time_str = None
    m = re.search(r'\b(\d{1,2})h(\d{2})?\b', cl)
    if m:
        h, mi = int(m.group(1)), int(m.group(2) or 0)
        if 0 <= h <= 23 and 0 <= mi <= 59:
            time_str = f"{h:02d}:{mi:02d}:00"

    if date_obj and result.get("date_start") is None:
        t = time_str or "00:00:00"
        result["date_start"] = f"{date_obj.isoformat()}T{t}"

    # ── Venue from @mentions ──────────────────────────────────────────────────
    # First @mention in the caption that isn't the poster's own handle
    if result.get("venue_name") is None:
        poster = (result.get("handle") or "").lower()
        mentions = re.findall(r'@([A-Za-z0-9._]{2,30})', caption)
        for mention in mentions:
            if mention.lower() != poster:
                result["venue_name"] = mention
                break

    # ── Price ────────────────────────────────────────────────────────────────
    if re.search(r'\b(?:gratuito|entrada\s+franca|rol[eê]\s+livre|sem\s+cobran[cç]a|free)\b', cl):
        result["price_min"] = 0
        result["price_max"] = 0
    else:
        m = re.search(r'R\$\s*(\d+)', caption)
        if m and result.get("price_min") == 0:
            result["price_min"] = int(m.group(1))
            result["price_max"] = int(m.group(1))


class IgExtractRequest(BaseModel):
    url: str


@app.post("/events/extract-ig")
async def extract_ig_event(req: IgExtractRequest):
    """
    Given an Instagram post or profile URL, fetch the post via Apify and run
    Claude extraction. Returns pre-filled event fields for the submission form.
    Always returns 200 — missing fields are null so the client can fall back
    to manual entry gracefully.
    """
    url = req.url.strip()
    if not url.startswith("http"):
        url = "https://" + url

    result: dict = {"handle": None, "name": None, "date_start": None,
                    "venue_name": None, "description": None,
                    "price_min": 0, "price_max": 0,
                    "image_url": None, "caption": None, "url": url}

    if not settings.apify_api_token:
        return result

    from scrapers.instagram_apify import _run_apify_scrape, _extract_events
    from anthropic import AsyncAnthropic
    from datetime import timezone as tz

    posts = await _run_apify_scrape(settings.apify_api_token, [url], posts_per_account=1)
    if not posts:
        return result

    post = posts[0]
    result["handle"] = (post.get("ownerUsername") or "").lower() or None
    result["caption"] = (post.get("caption") or "").strip() or None
    result["image_url"] = post.get("displayUrl") or None

    # Regex fallback — runs when Anthropic is unavailable. Catches the most
    # common caption patterns used by Curitiba venues so the form pre-fills
    # even without Claude. Claude path overwrites these when available.
    caption = result["caption"] or ""
    _regex_extract_ig_fields(result, caption, post)

    if not settings.anthropic_api_key:
        return result

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    today_str = __import__("datetime").datetime.now(tz.utc).strftime("%Y-%m-%d")
    # A lineup post yields several; this form fills one event, so take the
    # earliest — _extract_events returns them date-sorted.
    raw_events = await _extract_events(client, post, today_str)
    raw_event = raw_events[0] if raw_events else None

    if raw_event:
        result["name"] = raw_event.name
        result["date_start"] = raw_event.date_start.strftime("%Y-%m-%dT%H:%M:%S") if raw_event.date_start else None
        result["venue_name"] = raw_event.venue_name
        result["description"] = raw_event.description
        result["price_min"] = raw_event.price_min or 0
        result["price_max"] = raw_event.price_max or 0

    return result


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

    handle = re.sub(r"[^A-Za-z0-9._]", "", req.ig_handle.lstrip("@"))[:30]
    if handle:
        db.upsert_ig_account(handle=handle, label="", category="", enabled=True,
                             added_by_email="user_submitted")

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
    else:
        # No Claude available — write a basic unenriched event directly so it
        # appears in the catalog immediately. Enrichment will overwrite via
        # upsert when credits are restored and the next scrape cycle runs.
        background_tasks.add_task(_save_unenriched_submission, submission_id, req)

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


def _event_rsvp_audience(event_id: str, actor_id: str) -> list[str]:
    """Who to tell when someone confirms a PRIVATE event: the people
    planning it (creator, co-hosts) and the people invited to it — both
    those who already said yes and those still deciding.

    Catalog events return [] — they have no invitee list, and announcing
    a public RSVP to everyone else going would be spam. Friends are the
    high-signal cut there, and they're handled separately.

    Built from raw ids rather than get_event_attendees(), which is the
    display roster: that one hides users who opted out of discovery from
    non-friends. Right for a roster, wrong here — they'd silently stop
    hearing about their own event.

    declined_ids needs no subtracting: "Não vou" already takes you off
    extra_invitee_ids and deletes your RSVP (see db.decline_event_invite),
    so a decliner only reappears here by being re-invited or by
    confirming after all.
    """
    ge = db.get_group_event(event_id)
    if not ge:
        return []
    audience = set(ge.get("extra_invitee_ids") or [])
    audience |= set(ge.get("co_host_ids") or [])
    audience |= set(db.get_event_rsvp_ids(event_id))
    if ge.get("created_by"):
        audience.add(ge["created_by"])
    audience.discard(actor_id)
    audience.discard("")
    return sorted(audience)


def _fanout_rsvp_pushes(req: RsvpUpsertRequest) -> None:
    """Tell the people who care that someone confirmed. Two audiences,
    at most one push each — a friend who is also on the invitee list
    must not get two notifications for the same RSVP:

      1. Friends already invested in this event. Gated by the user's
         "compartilhar RSVPs com amigos" toggle, and unchanged.
      2. For a private event, everyone planning or invited to it. NOT
         gated by that toggle: it is about the friends feed, while
         these people see the same confirmation on the event's "Quem
         vai" roster either way — and a host who can't tell who
         accepted can't plan the thing.

    Runs in the background: both lists fan out to serial webpush + APNs
    calls, so on a 20-guest event the RSVP tap would otherwise wait on
    20 round trips before the UI could respond.
    """
    actor, event_id = req.google_id, req.event_id
    user_name = _user_display_name(actor)
    title = f"🎉 {user_name} vai"
    notified: set[str] = set()

    if _user_share_rsvps(actor):
        for friend in db.get_friends(actor):
            fid = friend["google_id"]
            if friend.get("status") != "accepted":
                continue
            if not _friend_cares_about_event(fid, event_id):
                continue
            notified.add(fid)
            try:
                _send_push_to_user(
                    fid, title=title, body=req.event_name,
                    url=_event_deep_link(event_id),
                    tag=f"friend-rsvp-{actor}-{event_id}",
                )
            except Exception as exc:
                log.warning(f"friend-rsvp push to {fid} failed: {exc}")

    guests = [g for g in _event_rsvp_audience(event_id, actor) if g not in notified]
    if not guests:
        return
    # One tag per event, so a burst of confirmations collapses into a
    # single slot instead of stacking. The running count keeps that
    # honest — replacing "Ana vai" with "Bia vai" would lose Ana.
    going = len(db.get_event_rsvp_ids(event_id))
    body = req.event_name if going <= 1 else f"{req.event_name} · {going} confirmados"
    for gid in guests:
        try:
            _send_push_to_user(
                gid, title=title, body=body,
                url=_event_deep_link(event_id),
                tag=f"event-rsvp-{event_id}",
            )
        except Exception as exc:
            log.warning(f"event-rsvp push to {gid} failed: {exc}")


@app.post("/rsvp")
def rsvp_upsert(req: RsvpUpsertRequest, background_tasks: BackgroundTasks):
    """Record that a user is going to an event (normalized, queryable).
    Side-effects: evaluates the badge engine + (when this is a NEW RSVP,
    not a re-confirm) notifies friends and, on a private event, the
    people planning or invited to it. See _fanout_rsvp_pushes."""
    is_new = not db.rsvp_exists(req.google_id, req.event_id)
    # Changing your mind: confirming an event you had declined puts you
    # back on the invitee list and clears the decline. Done here rather
    # than in a dedicated endpoint so it holds no matter which screen
    # confirms — the two states are mutually exclusive, and a row that
    # says both is a roster the host can't trust. No-op for catalog
    # events and for anyone who never declined.
    db.undecline_event_invite(req.event_id, req.google_id)
    db.upsert_rsvp(
        google_id=req.google_id,
        event_id=req.event_id,
        event_name=req.event_name,
        event_venue=req.event_venue,
        event_date=req.event_date,
        event_url=req.event_url,
    )
    new_badges = badges.evaluate(req.google_id)

    # Only on a fresh RSVP — toggling off→on shouldn't re-spam anyone.
    if is_new:
        background_tasks.add_task(_fanout_rsvp_pushes, req)

    return {"ok": True, "new_badges": new_badges}


@app.delete("/rsvp/{event_id}")
def rsvp_delete(event_id: str, google_id: str):
    """Remove an RSVP for the given user/event pair."""
    db.delete_rsvp(google_id=google_id, event_id=event_id)
    return {"ok": True}


@app.delete("/user/account")
def delete_account(google_id: str):
    """Permanently delete all data for a user (Apple 5.1.1v / LGPD).
    The client signs out locally immediately after calling this."""
    if not google_id:
        raise HTTPException(status_code=400, detail="google_id required")
    deleted = db.delete_user_account(google_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")
    image_store.delete_event_image(_avatar_image_id(google_id))
    return {"ok": True}


_AVATAR_UPLOAD_CAP = 8 * 1024 * 1024


def _avatar_image_id(google_id: str) -> str:
    """File stem for a user's uploaded photo. Hashed so account ids (Apple
    ids contain dots) never end up in a public URL or a file name."""
    import hashlib
    return "useravatar_" + hashlib.sha256(google_id.encode()).hexdigest()[:24]


@app.post("/user/avatar")
async def upload_user_avatar(
    file: UploadFile = File(...),
    google_id: str = Form(...),
):
    """Profile photo upload. Stored on the same /event-images/ volume as
    event covers; replacing overwrites the same file.

    The URL is returned, not written into user_states: the client owns
    that blob and rewrites it on every change, so it stores the URL as
    `customPicture` and every picture reader prefers it
    (db.user_picture). The ?v= stamp busts caches on replace — the file
    name doesn't change."""
    if not google_id or db.get_user_state(google_id) is None:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")
    content = await file.read()
    if len(content) > _AVATAR_UPLOAD_CAP:
        raise HTTPException(status_code=413, detail="Imagem maior que 8MB")
    public = image_store.save_user_upload(
        _avatar_image_id(google_id), content, file.content_type or "",
    )
    if not public:
        raise HTTPException(status_code=400, detail="Imagem inválida (use JPG, PNG, WebP, GIF ou HEIC)")
    stamp = int(datetime.now(timezone.utc).timestamp())
    return {"ok": True, "picture": f"{public}?v={stamp}"}


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
    """Return RSVPed attendees + named invitees still pending, both
    excluding the requester. Each user dict has google_id, name,
    picture, is_friend, friend_code. Pending applies only to private
    events (group_events table); for catalog events `pending` is empty.
    """
    attendees = db.get_event_attendees(event_id, google_id)
    pending = db.get_event_invitees_pending(event_id, google_id)
    # Attach friend_code so the frontend can call addFriend directly
    for a in attendees:
        a["friend_code"] = db.get_friend_code(a["google_id"])
    for p in pending:
        p["friend_code"] = db.get_friend_code(p["google_id"])
    # Who said "Não vou" — for the people planning the event only. Other
    # guests don't need to see who bailed.
    declined: list[dict] = []
    ge = db.get_group_event(event_id)
    if ge and (ge.get("created_by") == google_id or google_id in (ge.get("co_host_ids") or [])):
        declined = db.get_event_declined(event_id, google_id)
    return {"attendees": attendees, "pending": pending, "declined": declined}


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
        "picture": db.user_picture(state),
    }


@app.get("/users/{target_google_id}/profile")
def get_user_profile(target_google_id: str, google_id: str = ""):
    """Public-ish profile lookup for any user by google_id. Used by the
    "tap-to-add-friend" flow when the viewer sees someone in the app
    (event creator, attendee, member of a shared group) and wants to
    send a friend request without juggling codes.

    Returns: { google_id, name, picture, friend_status }
    where friend_status is 'self' | 'friends' | 'none'.

    Doesn't leak anything that's not already visible elsewhere — name
    + picture come from the same user_states the friends-feed already
    surfaces. The friend_status check lets the frontend hide the
    "Adicionar" button when the relationship already exists."""
    target_state = db.get_user_state(target_google_id) or {}
    if not target_state and not target_google_id:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")
    gu = target_state.get("googleUser") or {}
    profile = {
        "google_id": target_google_id,
        "name": target_state.get("userName") or gu.get("givenName") or gu.get("name") or "",
        "picture": db.user_picture(target_state),
        "friend_status": "none",
    }
    if google_id:
        # 'self' | 'friends' | 'requested' | 'incoming' | 'none'
        profile["friend_status"] = db.friendship_status(google_id, target_google_id)
    return profile


class AddFriendByIdRequest(BaseModel):
    google_id: str        # the requester
    target_google_id: str # who they want to add


def _user_display_name(google_id: str) -> str:
    state = db.get_user_state(google_id) or {}
    gu = state.get("googleUser") or {}
    return state.get("userName") or gu.get("givenName") or gu.get("name") or "Alguém"


def _notify_friend_request(requester_id: str, target_id: str) -> None:
    """Push the target: tap opens the requester's profile, which carries
    the Aceitar / Recusar buttons."""
    try:
        _send_push_to_user(
            target_id,
            "👋 Pedido de amizade",
            f"{_user_display_name(requester_id)} quer ser seu amigo no auê",
            url=f"/#/friends/{quote(requester_id, safe='')}",
            tag=f"friend-request-{requester_id}",
        )
    except Exception as exc:
        log.warning(f"friend request push failed: {exc}")


def _on_friendship_accepted(acceptor_id: str, requester_id: str,
                            via_code: bool = False) -> list:
    """Tell the requester, award badges on both sides. Returns the
    acceptor's new badges for the toast.

    via_code is the invite-code/link path: the "requester" never sent a
    pedido, they shared their code and someone claimed it. Same push,
    honest wording — "aceitou seu pedido" would name something that
    never happened."""
    name = _user_display_name(acceptor_id)
    title = "🤝 Novo amigo" if via_code else "🤝 Pedido aceito"
    body = (f"{name} entrou pelo seu link — vocês são amigos no auê"
            if via_code else
            f"{name} aceitou seu pedido de amizade")
    try:
        _send_push_to_user(
            requester_id,
            title,
            body,
            url=f"/#/friends/{quote(acceptor_id, safe='')}",
            tag=f"friend-accepted-{acceptor_id}",
        )
    except Exception as exc:
        log.warning(f"friend accepted push failed: {exc}")
    badges.evaluate(requester_id)
    return badges.evaluate(acceptor_id)


@app.post("/friends/add-by-id")
def friends_add_by_id(req: AddFriendByIdRequest):
    """Send a friend request by the target's google_id. Used by the in-app
    tap-to-add surfaces (group member list, someone's profile, post-event
    "people you met"). Unlike invite codes these don't auto-accept: being
    in the same group as someone isn't their consent, and friendship
    shows them your RSVPs.

    Returns {status}: 'requested' | 'accepted' (they had already asked
    you) | 'already_requested' | 'already_friends' | 'self' | 'not_found'."""
    result = db.request_friendship(req.google_id, req.target_google_id)
    status = result["status"]
    if status == "requested":
        _notify_friend_request(req.google_id, req.target_google_id)
    elif status == "accepted":
        result["new_badges"] = _on_friendship_accepted(req.google_id, req.target_google_id)
    if status in ("requested", "accepted"):
        result["friend_name"] = _user_display_name(req.target_google_id)
    return result


class FriendRequestAction(BaseModel):
    google_id: str  # the person answering the request


@app.get("/friends/requests")
def friends_requests(google_id: str):
    """Incoming requests to answer, plus the ids the user has asked (so
    member lists can show "Pedido enviado" instead of "+ amigo")."""
    return {
        "incoming": db.get_incoming_friend_requests(google_id),
        "outgoing_ids": db.get_outgoing_friend_request_ids(google_id),
    }


@app.post("/friends/requests/{from_google_id}/accept")
def friends_request_accept(from_google_id: str, req: FriendRequestAction):
    if not db.accept_friendship(req.google_id, from_google_id):
        # Already accepted counts as success — a double tap or two devices.
        if db.friendship_status(req.google_id, from_google_id) == "friends":
            return {"ok": True, "status": "already_friends"}
        raise HTTPException(status_code=404, detail="Pedido não encontrado")
    return {"ok": True, "status": "accepted",
            "new_badges": _on_friendship_accepted(req.google_id, from_google_id)}


# ── Notifications ─────────────────────────────────────────────────
# The inbox behind the Notificações tab, and the number on its badge.
#
# Everything countable here is DERIVED from existing state rather than
# stored as a row when something happens. That's the whole design:
#
#   - It can't drift. There's no producer to forget to call, no backfill
#     for anything that happened before this shipped, and no way for the
#     badge to disagree with the screen it opens.
#   - It clears for the right reason. A derived count goes down when the
#     person ACTS — answers the invite, accepts the friend — not when
#     they glance at the tab. A badge you can clear by looking teaches
#     people that looking is enough, and then it stops being read at all.
#
# So the rule the badge follows is: count only what needs YOU. An event
# invite with no answer needs you. A new venue being tracked does not.
# "There is new stuff" never reaches zero, and a badge that never
# reaches zero is one people stop seeing within a week.
#
# Informational items still appear in the list — they're worth a look,
# just not a number. They carry actionable=false and are excluded from
# the count.

@app.get("/notifications")
def list_notifications(google_id: str = "", email: str = ""):
    """The notification inbox: what's waiting on you, plus what's new.

    One call for the whole screen AND the badge, so the two can never
    show different numbers.

    Curation items are included only for curators, and a non-curator
    gets silence rather than a 403 — same reasoning as /me/pending:
    "nothing pending" and "not yours to see" should look identical."""
    items: list[dict] = []

    if google_id:
        for ev in db.get_unanswered_invites(google_id):
            items.append({
                "kind": "event_invite",
                "actionable": True,
                "id": f"invite:{ev['id']}",
                "ref_id": ev["id"],
                "title": ev["name"],
                "body": ev.get("venue") or "",
                "at": ev["date_start"],
            })
        for req in db.get_incoming_friend_requests(google_id):
            items.append({
                "kind": "friend_request",
                "actionable": True,
                "id": f"friend:{req.get('google_id')}",
                "ref_id": req.get("google_id"),
                # get_incoming_friend_requests returns `name`, not `display_name`.
                "title": req.get("name") or "Alguém",
                "body": "quer ser teu amigo no auê",
                "at": req.get("created_at") or "",
            })

    if email and db.is_curator(email):
        pending_events = len(db.list_catalog_requests("review"))
        pending_accounts = len(db.list_account_requests("review"))
        if pending_events:
            items.append({
                "kind": "curation_events", "actionable": True,
                "id": "curation:events", "ref_id": "",
                "title": f"{pending_events} evento(s) pra revisar",
                "body": "Sugestões da comunidade esperando curadoria",
                "at": "",
            })
        if pending_accounts:
            items.append({
                "kind": "curation_accounts", "actionable": True,
                "id": "curation:accounts", "ref_id": "",
                "title": f"{pending_accounts} conta(s) sugerida(s)",
                "body": "Perfis do Instagram esperando aprovação",
                "at": "",
            })

    # Informational: worth a look, never a number on the badge.
    latest = db.get_latest_daily_digest()
    if latest and latest.get("event_ids"):
        count = len(latest["event_ids"])
        items.append({
            "kind": "digest",
            "actionable": False,
            "id": f"digest:{latest['id']}",
            "ref_id": latest["id"],
            "title": f"{count} novidade(s) no catálogo",
            "body": "O que entrou desde ontem",
            "at": latest.get("created_at") or "",
        })

    # Actionable first, then most recent. An item with no date sorts
    # last within its group rather than jumping to the top on "".
    items.sort(key=lambda i: (not i["actionable"], i["at"] == "", i["at"]), reverse=False)
    return {
        "items": items,
        "unread_count": sum(1 for i in items if i["actionable"]),
    }


@app.get("/me/pending")
def me_pending(google_id: str = "", email: str = ""):
    """Everything waiting on this user — powers the Pendências block on Home.

    One call instead of three: the curation queues are curator-only and
    would 403 for everyone else, and Home can't know the role up front.
    Non-curators get zeros rather than an error — from Home, "nothing
    pending" and "not yours to see" should look identical, so the block
    never hints the área exists.

    Event invites are deliberately NOT here: Home already pulls those
    from /events/user-groups with the dates and RSVP state it needs to
    split pending from accepted.
    """
    out = {
        "friend_requests": db.get_incoming_friend_requests(google_id) if google_id else [],
        "curation": {"is_curator": False, "events": 0, "accounts": 0},
    }
    if email and db.is_curator(email):
        out["curation"] = {
            "is_curator": True,
            "events": len(db.list_catalog_requests("review")),
            "accounts": len(db.list_account_requests("review")),
        }
    return out


@app.post("/friends/requests/{from_google_id}/decline")
def friends_request_decline(from_google_id: str, req: FriendRequestAction):
    return {"ok": db.decline_friend_request(req.google_id, from_google_id)}


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
        # Tell the code owner someone claimed their link, and award the
        # "Galera junto" badge on both sides (whoever crosses the
        # threshold sees the toast). This path used to be silent: you
        # shared your link and never learned it worked, while the
        # request/accept path has always pushed. Same event, so it gets
        # the same push.
        if friend_id:
            result["new_badges"] = _on_friendship_accepted(
                req.google_id, friend_id, via_code=True,
            )
        else:
            result["new_badges"] = badges.evaluate(req.google_id)
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

    # Privacy gate for private events (event_id starts with "grp_ev_"):
    # surface the friend's RSVP only when the viewer can see the event
    # itself — same rule as /events/{id} after the May 2026 unification:
    # viewer is the creator OR is in extra_invitee_ids. Group membership
    # alone no longer grants access.
    #
    # Pre-unification, this gate filtered by `viewer_group_ids` membership,
    # which silently dropped (a) personal plans (group_id IS NULL) and
    # (b) group-tagged events where the viewer was an outsider invitee.
    # That's why outsiders weren't seeing friends_going stacks on Home.
    grouped: dict[str, dict] = {}
    for rsvp in rsvps:
        if rsvp["event_date"] and rsvp["event_date"] < today:
            continue
        eid = rsvp["event_id"]
        if eid.startswith("grp_ev_"):
            ge = db.get_group_event(eid)
            if not ge:
                continue
            invitees = ge.get("extra_invitee_ids") or []
            if google_id != ge.get("created_by") and google_id not in invitees:
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


# Bairros the enrichment pass is allowed to claim it found. The prompt
# field is literally called `neighborhood_guess` (enrichment.py), and the
# model answers even with nothing to go on: it hedges ("Centro ou
# Mercês"), answers with the city ("Curitiba"), or invents outright — one
# @barfolia post produced both "Bar Folia · Centro" and "Bar Folia · Água
# Verde". Measured Sep 2026: 100 of 123 catalog events disagreed with the
# geocoded bairro, and the geocoder was the one telling the truth.
#
# `venues.bairro` (Nominatim) is the real answer; this only runs for
# venues that were never geocoded. Showing no bairro beats showing a
# confident wrong one, so anything reading as a hedge is dropped.
_NEIGHBORHOOD_HEDGE_RE = re.compile(r"\bou\b|/|,|\(", re.IGNORECASE)


def _clean_neighborhood_guess(value: str) -> str:
    """Keep only unhedged, single-bairro guesses from the enrichment pass."""
    guess = (value or "").strip(" ·")
    if not guess:
        return ""
    # "Curitiba" is the city, not a bairro — the model's way of saying it
    # doesn't know. Also catches "Centro ou região central de Curitiba".
    # Costs us the real bairro "Cidade Industrial de Curitiba", which is a
    # fair trade: that one loses its suffix, the other 99 stop lying.
    if "curitiba" in guess.casefold():
        return ""
    if _NEIGHBORHOOD_HEDGE_RE.search(guess):
        return ""
    # A bairro name is short. Anything longer is prose, not an answer.
    if len(guess) > 28:
        return ""
    return guess


def _venue_label(venue_name: str, geocoded_bairro: str, guessed_bairro: str) -> str:
    """The "Bar Folia · Água Verde" string the card and detail row show.

    Preference is geocoded > guessed > name alone. Kept as a single
    string because several readers parse that shape (badges.py,
    Events.jsx); splitting `venue` into two fields is a wider change
    than this fix warrants."""
    name = (venue_name or "").strip()
    bairro = (geocoded_bairro or "").strip() or _clean_neighborhood_guess(guessed_bairro)
    if not name:
        return bairro
    return f"{name} · {bairro}" if bairro else name


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

    # Resolved before `out` so the venue label can prefer the geocoded
    # bairro over the enrichment guess — see _venue_label.
    coords = None
    if venue_coords and ev.venue_name:
        coords = venue_coords.get(db._normalize_venue_key(ev.venue_name))

    out = {
        "id": ev.id,
        "name": ev.name,
        "category": ev.kind,
        "categoryLabel": ev.category_label,
        "categoryEmoji": ev.category_emoji,
        "venue": _venue_label(
            ev.venue_name, (coords or {}).get("bairro") or "", ev.neighborhood
        ),
        "date": date_label,
        "time": "" if (is_original or is_ongoing) else effective_start.strftime("%H:%M"),
        "duration": "" if (is_original or is_ongoing) else _duration(ev),
        "headerBg": ev.header_gradient,
        "icon": _category_icon(ev.kind),
        "price": price_label,
        "priceTier": ev.price_tier,
        # Raw bounds alongside the formatted label: the curator edit sheet
        # needs numbers to prefill, and `price` is already prose by then
        # ("Grátis", "R$ 40 a R$ 80").
        "priceMin": ev.price_min,
        "priceMax": ev.price_max,
        "kidsWelcome": ev.kids_welcome,
        "hasFood": ev.has_food,
        "isLowPressure": ev.is_low_pressure,
        "attendeesConfirmed": member_count,
        "expectedSize": ev.expected_size,
        "vibeSummary": ev.vibe_summary,
        "genre": getattr(ev, "genre", "") or "",
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

    # Sympla buy-link — set by the matching pipeline (sympla_match.py)
    # when a CWB Sympla event aligns with this catalog event by venue +
    # date + name fuzzy. Frontend renders a "🎟️ Comprar ingresso" CTA
    # and appends utm tagging at click time so we can show venues
    # "auê drove X clicks to your Sympla" until per-event affiliate
    # invites get us a real take rate.
    out["symplaUrl"] = (getattr(ev, "sympla_url", None) or "")

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
    """A price we actually read off the post, or "" — never a guess.

    Zero used to render as "Gratuito", but zero is also what the
    extractor leaves behind whenever a caption says nothing about money,
    which is most captions. So the catalog told people a pile of events
    were free when they charge at the door. That is the one error in a
    listing that costs the reader something real: they show up with no
    money on them.

    Empty string here, and the app renders no price at all. Silence is
    honest; the reader finds out from the venue. A genuinely free event
    we DID read as free is currently indistinguishable from an unknown
    one — worth fixing in the extractor (a "price_known" flag), not by
    guessing here.
    """
    if min_p == 0 and max_p == 0:
        return ""
    symbol = "R$" if currency == "BRL" else "$"
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
    note: str = ""  # short free-text "que tal esse?" attached to the card
    # Explicit invitee list. When None, the endpoint defaults to "all
    # current group members minus the creator" — preserves the legacy
    # "create from inside the group, everyone gets it" behavior for any
    # client that doesn't yet send the field. New clients (post-commit-2)
    # will always send a curated list, including extras outside the
    # group. Empty list is allowed (event for the creator only).
    invitee_google_ids: Optional[list[str]] = None
    # Catalog event id when this row was forked from a public event
    # (e.g., "instagram_ig_<handle>_<post>"). Backend parses out the
    # IG handle so views/RSVPs on the group copy still attribute to
    # the source venue's Painel. Empty for plans-from-scratch.
    source_event_id: str = ""
    # Created from an Instagram post link (the link field at the top of the
    # creation sheet): the post image, the post link, and its account.
    image_url: str = ""
    source_url: str = ""
    source_ig_handle: str = ""
    # What /events/extract-ig read from the post, before the creator edited
    # anything. The catalog request is built from this rather than the
    # creator's fields, so a private title ("aniver da Ana") or a personal
    # description never reaches the public review queue.
    post: Optional[dict] = None


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
    # Created from an Instagram post link (the link field at the top of the
    # creation sheet): the post image, the post link, and its account.
    image_url: str = ""
    source_url: str = ""
    source_ig_handle: str = ""
    # What /events/extract-ig read from the post, before the creator edited
    # anything. The catalog request is built from this rather than the
    # creator's fields, so a private title ("aniver da Ana") or a personal
    # description never reaches the public review queue.
    post: Optional[dict] = None


# ── Channels ──────────────────────────────────────────────────────
# Curated collections people follow. Same `groups` table as a private
# crew (kind='channel'), because a channel is structurally the same
# thing and forking the schema would fork every event-attach and notify
# path that already works.
#
# The caution recorded in docs/NEXT.md was that a curated channel must
# not read as a crew — people arriving at what looks like a group and
# finding a bot feed. Since both are now called "canal", that gets
# solved by shape rather than vocabulary:
#
#   canal privado  -> membros, convite, nudge pra convidar
#   canal do auê   -> seguidores, descoberta aberta, nunca um nudge
#
# The guards below are what make that real rather than a UI convention.

def _is_curator_google_id(google_id: str) -> bool:
    """Curator check by user id rather than email — the group endpoints
    identify callers by google_id, while the curators table is keyed by
    email."""
    if not google_id:
        return False
    user = db.get_user_profile(google_id) or {}
    return db.is_curator(user.get("email") or "")


def _founder_google_id() -> str:
    """The founder's user id, used as the owner of every auê channel.

    Returns "" when the founder has never signed into the app, which is
    a real state on a fresh environment — the curators table is seeded
    from settings at boot, but `users` only gets a row on first login.
    The caller turns that into a 409 with an instruction rather than a
    500."""
    return db.get_user_id_by_email(settings.founder_email) or ""


class ChannelCreate(BaseModel):
    requesting_email: str
    name: str
    description: str = ""


class ChannelFollow(BaseModel):
    google_id: str


@app.get("/channels")
def list_channels(google_id: str = ""):
    """Every channel, with follower count and whether the caller follows.

    Open to anyone, signed in or not. A group is invisible without an
    invite code; a channel that isn't findable can't be opted into, and
    opt-in is the entire model — nobody is ever enrolled automatically."""
    return {"channels": db.list_channels(google_id)}


@app.post("/admin/channels")
def create_channel(req: ChannelCreate):
    """Create an auê channel. Founder-only.

    User-created channels are deferred on purpose (docs/NEXT.md): a
    user's channel would be private, which is what a group already is,
    and an empty channel with an audience is the same stall that groups
    already measure. Curated first, prove it retains, then open it up."""
    _require_founder(req.requesting_email)
    name = req.name.strip()[:80]
    if not name:
        raise HTTPException(status_code=400, detail="Nome não pode ficar vazio")
    founder_id = _founder_google_id()
    if not founder_id:
        raise HTTPException(
            status_code=409,
            detail="A conta do auê ainda não entrou no app — entra uma vez e tenta de novo.",
        )
    channel = db.create_group(
        google_id=founder_id,
        name=name,
        description=req.description.strip()[:500],
        visibility="public",   # discovery is the point
        kind="channel",
    )
    return {"channel": channel}


class ChannelNotify(BaseModel):
    google_id: str
    notify: bool


@app.get("/channels/feed")
def channel_feed(google_id: str = "", limit: int = 40):
    """Upcoming events from the channels this person follows, for the
    band above Eventos.

    Declared BEFORE /channels/{group_id} on purpose: FastAPI matches
    in declaration order, so the other way round this resolves as a
    channel whose id is literally "feed" and 404s. Same trap the
    /digests/latest route already carries a note about.

    A separate call from the catalog on purpose. Channel events have no
    invitee list, so the main feed's creator-or-invitee rule drops every
    one of them — and keeping the band separate keeps the catalog below
    exactly what it was. Following three channels shouldn't bury the
    city under them.
    """
    if not google_id:
        return {"events": []}
    rows = db.get_followed_channel_events(google_id, limit=min(limit, 100))
    return {"events": [
        _group_event_to_frontend(
            e,
            group_name=e.get("channel_name") or "",
            viewer_google_id=google_id,
            prefer_group_id=e.get("channel_id"),
        )
        for e in rows
    ]}


@app.get("/channels/{group_id}")
def get_channel(group_id: str, google_id: str = ""):
    """Everything the channel screen needs, in one call.

    Separate from GET /groups/{id} on purpose. That endpoint answers
    "what is this crew" — members, roles, invite code, stats — and a
    channel needs almost none of it. Reusing it meant the screen either
    rendered crew chrome it had to hide, or ignored most of the payload;
    both are how an "...unless it's a channel" branch spreads.

    Open to anyone, signed in or not: a channel that can't be looked at
    before following makes the follow a blind purchase."""
    channel = db.get_group(group_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Canal não encontrado")

    # One screen serves both kinds, so this endpoint has to gate the way
    # the old group endpoint did: a private channel is for the people in
    # it. A public one is open, because being able to look before you
    # follow is the whole model.
    public = channel.get("visibility") == "public"
    role = db.get_group_member_role(group_id, google_id) if google_id else None
    if not public and role is None:
        raise HTTPException(status_code=403, detail="Esse canal é privado")

    # A public channel is a published feed: everyone sees every event,
    # follower or not, because auê creates them with no invitees and the
    # crew visibility rule would hand its own followers an empty list.
    #
    # A private one keeps that rule — its events are the members', and
    # an outsider invited to one specific night must not see the rest.
    events = [
        _group_event_to_frontend(
            e,
            group_name=channel.get("name") or "",
            viewer_google_id=google_id,
            prefer_group_id=group_id,
        )
        for e in db.get_group_events(
            group_id, viewer_google_id=None if public else google_id)
    ]
    today = datetime.now(timezone.utc).date().isoformat()
    upcoming = [e for e in events if (e.get("dateStart") or "")[:10] >= today]
    past = [e for e in events if (e.get("dateStart") or "")[:10] < today]

    # `following`, the same field the list reads. These two used to
    # disagree — the list counted any membership row, this counted only
    # role='follower' — so auê saw "Seguindo" on one screen and "Seguir"
    # on the other, for the same channel.
    members = db.get_group_members(group_id)
    # "Followers" on a public channel, "members" on a private one — same
    # rows, and the screen picks the word. On a private channel everyone
    # in it counts, because being a member IS being in it; following is
    # only about whether it also shows up in your lists.
    followers = [m for m in members if (m.get("following") or not public)]
    is_following = any(m["google_id"] == google_id for m in followers) if google_id else False

    return {
        "channel": {
            **channel,
            "follower_count": len(followers),
            "is_following": is_following,
            # Pre-armed for someone who hasn't followed yet, so tapping
            # "seguir" doesn't drop them into a state they didn't pick.
            "notify": db.get_channel_notify(group_id, google_id),
            "prioritize": db.get_channel_prioritize(group_id, google_id),
            "upcoming_event_count": len(upcoming),
            # The screen needs to know which shape to render: a public
            # channel has followers and no invite, a private one has
            # members and an invite code.
            "is_public": public,
            "viewer_role": role,
            # Whether this viewer may edit the channel and publish into
            # it. One curator role (Sep 2026): a curator curates every
            # channel — you don't have to be the rock specialist to add
            # a show to Rockzera, and a curator who wants to help another
            # channel along is welcome. Per-channel appointment still
            # exists underneath, for handing a single channel to someone
            # who isn't a curator; it's the founder's tool, so the screen
            # needs to know who the founder is.
            "can_curate": bool(google_id) and (
                _is_curator_google_id(google_id)
                or db.is_channel_curator(group_id, google_id)
            ),
            "viewer_is_founder": bool(google_id) and db.is_founder(
                (db.get_user_profile(google_id) or {}).get("email") or ""
            ),
        },
        "events": upcoming,
        # Recent past, so a channel between shows still looks alive
        # rather than empty. Newest first — "what you missed", not a
        # schedule.
        "past_events": sorted(past, key=lambda e: e.get("dateStart") or "", reverse=True)[:5],
        "followers": followers[:12],
    }


class ChannelUpdate(BaseModel):
    requesting_email: str
    name: Optional[str] = None
    description: Optional[str] = None


class ChannelCuratorAdd(BaseModel):
    requesting_email: str
    google_id: str


def _require_channel_owner(group_id: str, email: str) -> str:
    """Only the owner appoints curators — auê on a public channel, the
    creator on a private one.

    Not curators themselves: a curator who can appoint curators makes
    the roster ungovernable, and there is exactly one person who owns
    that decision for any given channel."""
    google_id = db.get_user_id_by_email(email)
    owner = db.channel_owner(group_id)
    if google_id and owner and google_id == owner:
        return google_id
    if db.is_public_channel(group_id) and db.is_founder(email):
        return google_id or ""
    raise HTTPException(
        status_code=403,
        detail="Só quem criou esse canal pode escolher a curadoria",
    )


def _can_curate_channel(group_id: str, email: str) -> bool:
    """Who may edit a channel: its owner, or someone the owner
    appointed.

    The founder counts only on a PUBLIC channel, because that's one auê
    owns. Letting the founder edit anyone's private channel would make
    "private" mean something it doesn't — and the unification is about
    both kinds working the same way with a different owner, not about
    one owner outranking the other.

    Global curators are deliberately not included either. That role is
    "can touch the catalog" — approve suggestions, edit events, add IG
    handles. Running a channel is a different job, and the point of
    per-channel curators is handing out the second without the first."""
    # One curator role (Sep 2026): a general curator edits any channel.
    # The docstring above records why they were once kept apart; the
    # split turned out to be more roles than the team needs.
    if db.is_curator(email):
        return True
    google_id = db.get_user_id_by_email(email)
    if google_id and db.is_channel_curator(group_id, google_id):
        return True
    return db.is_public_channel(group_id) and db.is_founder(email)


@app.put("/channels/{group_id}")
def update_channel(group_id: str, req: ChannelUpdate):
    """Rename a channel or rewrite its description."""
    if not db.is_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    if not _can_curate_channel(group_id, req.requesting_email):
        raise HTTPException(status_code=403, detail="Só a curadoria desse canal pode editar")
    name = (req.name or "").strip()[:80] if req.name is not None else None
    if req.name is not None and not name:
        raise HTTPException(status_code=400, detail="Nome não pode ficar vazio")
    db.update_group(
        group_id,
        name=name,
        description=(req.description or "").strip()[:500] if req.description is not None else None,
        visibility=None,
    )
    return {"ok": True, "channel": db.get_group(group_id)}


@app.get("/channels/{group_id}/curators")
def list_channel_curators(group_id: str, requesting_email: str = ""):
    """Who runs this channel. Founder-only — a follower has no reason to
    see the roster, and it's a list of real people."""
    if not db.is_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    _require_channel_owner(group_id, requesting_email)
    return {"curators": db.list_channel_curators(group_id)}


@app.post("/channels/{group_id}/curators")
def add_channel_curator(group_id: str, req: ChannelCuratorAdd):
    """Hand someone this channel. Founder-only: a curator being able to
    appoint more curators makes the roster ungovernable, and there's one
    person who owns that decision."""
    if not db.is_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    _require_channel_owner(group_id, req.requesting_email)
    if not db.get_user_profile(req.google_id):
        raise HTTPException(status_code=404, detail="Pessoa não encontrada")
    db.add_channel_curator(group_id, req.google_id)
    return {"ok": True, "curators": db.list_channel_curators(group_id)}


@app.delete("/channels/{group_id}/curators/{google_id}")
def remove_channel_curator(group_id: str, google_id: str, requesting_email: str = ""):
    """Step someone down. Only removes a 'curator' row, so auê's own
    ownership of the channel survives this being called on it."""
    if not db.is_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    _require_channel_owner(group_id, requesting_email)
    db.remove_channel_curator(group_id, google_id)
    return {"ok": True, "curators": db.list_channel_curators(group_id)}


class ChannelPrioritize(BaseModel):
    google_id: str
    prioritize: bool


@app.put("/channels/{group_id}/prioritize")
def set_channel_prioritize(group_id: str, req: ChannelPrioritize):
    """Whether this channel's events surface in the band above Eventos."""
    if not db.is_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    if not req.google_id:
        raise HTTPException(status_code=401, detail="Entra na tua conta")
    if not db.set_channel_prioritize(group_id, req.google_id, req.prioritize):
        raise HTTPException(status_code=409, detail="Segue o canal primeiro")
    return {"ok": True, "prioritize": req.prioritize}


@app.put("/channels/{group_id}/notify")
def set_channel_notify(group_id: str, req: ChannelNotify):
    """Turn a channel's pushes on or off, for one follower.

    Only a follower has a preference to set — auê's own admin row on its
    channel is ownership, not a subscription."""
    if not db.is_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    if not req.google_id:
        raise HTTPException(status_code=401, detail="Entra na tua conta")
    if not db.set_channel_notify(group_id, req.google_id, req.notify):
        raise HTTPException(status_code=409, detail="Segue o canal primeiro")
    return {"ok": True, "notify": req.notify}


@app.post("/channels/{group_id}/follow")
def follow_channel(group_id: str, req: ChannelFollow):
    """Follow a channel. Idempotent: the button can be double-tapped."""
    if not db.is_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    if not req.google_id:
        raise HTTPException(status_code=401, detail="Entra na tua conta pra seguir")
    db.follow_channel(group_id, req.google_id)
    return {"ok": True, "following": True}


@app.delete("/channels/{group_id}/follow")
def unfollow_channel(group_id: str, google_id: str = ""):
    """Stop following. Only removes a 'follower' row, so auê's own admin
    membership on its channel can't be deleted by an unfollow."""
    if not db.is_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    db.unfollow_channel(group_id, google_id)
    return {"ok": True, "following": False}


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
    # Attach next upcoming event for each group — gated by the viewer's
    # invitee status, so a group member who wasn't invited to a specific
    # event won't see it surface as "next_event" for the group card.
    for g in groups:
        events = db.get_group_events(g["id"], viewer_google_id=google_id)
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

    # A channel is a published feed, not a private crew. Its events are
    # visible to everyone — follower or not, invited or not — because
    # nobody is ever on their invite list: auê creates them with no
    # invitees. Running them through the crew gate showed an empty
    # channel to its own followers, which is the opposite of the point
    # and made "seguir" look broken.
    #
    # Its followers are public for the same reason: the count is social
    # proof, and you should be able to see it before deciding to follow.
    channel = group.get("kind") == "channel"
    if channel:
        members = db.get_group_members(group_id)
        raw_events = db.get_group_events(group_id, viewer_google_id=None)
    else:
        members = db.get_group_members(group_id) if is_member else []
        # Events tagged to this group AND the viewer is invited. Members
        # who weren't on a specific event's invite list (e.g. excluded
        # for a subset event before the create flow auto-disconnects the
        # group) won't see it here. Non-members see no events.
        raw_events = db.get_group_events(group_id, viewer_google_id=google_id) if is_member else []
    # Shaped exactly like /events/group and the catalog, rather than
    # handed over as raw DB rows. The frontend renders group events with
    # the same component as everything else, and it should not need a
    # per-endpoint translation layer to do it — that is how GroupDetail
    # ended up with its own near-copy of the detail view in the first
    # place. _group_event_to_frontend is the one mapping; it also handles
    # the image cache-busting that used to be done inline here.
    events = [
        _group_event_to_frontend(
            e,
            group_name=group.get("name") or "",
            viewer_google_id=google_id,
            # This screen IS a group, so its own name wins over whichever
            # linked group happens to come first.
            prefer_group_id=group_id,
        )
        for e in raw_events
    ]

    return {
        **group,
        "role": role,
        "is_member": is_member,
        "members": members,
        "events": events,
    }


@app.put("/groups/{group_id}")
def update_group(group_id: str, req: GroupUpdateRequest):
    """Rename a channel or rewrite its description.

    Owner or curator. Curators used to exist only on auê's channels,
    so a private one had exactly one person who could change anything —
    which is the gap the unification closes."""
    if not db.is_channel_curator(group_id, req.google_id):
        raise HTTPException(
            status_code=403,
            detail="Só quem cuida desse canal pode editar",
        )
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
    return {"ok": True, **db.delete_group(group_id)}


@app.delete("/admin/channels/{group_id}")
def admin_delete_channel(group_id: str, requesting_email: str):
    """Delete an auê channel with everything that only exists because of
    it. Founder-only, and only for public channels: a private crew is
    its members' and is deleted by its own admin through /groups/{id}.

    Exists so a channel can be rebuilt from the catalog cleanly rather
    than corrected in place — every kind of leftover a channel can
    accumulate (orphaned forks, stale invitee lists, curator RSVPs) has
    now shown up once as a production bug."""
    _require_founder(requesting_email)
    if not db.is_public_channel(group_id):
        raise HTTPException(status_code=404, detail="Canal não encontrado")
    return {"ok": True, **db.delete_group(group_id)}


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
    """Join a group via invite code.

    Channels are excluded even though they carry an invite_code column
    (every row does). You follow a channel from the open list; there is
    no code to pass around, and honouring one here would create a second
    way in that no UI offers and no guard covers."""
    group = db.get_group_by_invite_code(req.invite_code)
    if not group:
        return {"status": "not_found"}
    if group.get("kind") == "channel":
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


@app.delete("/groups/{group_id}/members/{member_google_id}")
def remove_group_member(group_id: str, member_google_id: str, google_id: str):
    """Kick a member out of a group. Admin-only. Refuses to remove the
    last admin (would leave the group ungovernable). A member kicking
    themselves out should use POST /groups/{id}/leave instead — this
    endpoint is for admin-driven removal of someone else.

    Side effect: existing event invitee lists are NOT cleaned up here.
    The kicked user keeps access to events they were already invited
    to (their RSVPs survive); they just stop receiving new event
    notifications from the group going forward. That's the gentlest
    semantic for "I removed you from my group" — drama-free for already
    confirmed plans, prevents future ones."""
    actor_role = db.get_group_member_role(group_id, google_id)
    if actor_role != "admin":
        raise HTTPException(status_code=403, detail="Apenas admins podem remover membros")
    target_role = db.get_group_member_role(group_id, member_google_id)
    if target_role is None:
        raise HTTPException(status_code=404, detail="Membro não está no grupo")
    if target_role == "admin" and db.count_group_admins(group_id) <= 1:
        raise HTTPException(
            status_code=400,
            detail="Não dá pra remover o último admin — promova alguém antes",
        )
    db.remove_group_member(group_id, member_google_id)
    return {"ok": True}


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


# ── Invite requests ──────────────────────────────────────
# Flow: a non-invitee opens an event link → backend's GET /events/{id}
# returns 403 with `request_status` so the frontend shows "Pedir convite";
# user POSTs request-invite → creator sees inline "Pedidos pendentes" on
# the event hero and pushes are bundled to one notification per event;
# accept folds the requester into extra_invitee_ids; reject keeps the row
# (status='rejected') as a permanent block on re-requests.

@app.post("/events/{event_id}/request-invite")
def request_event_invite(event_id: str, google_id: str, background_tasks: BackgroundTasks):
    """Ask the event's creator + co-hosts to be added as an invitee.
    Rate-limited to 5 per hour per requesting user across all events.
    Idempotent at the (event, user) level — calling again on a pending
    or rejected request returns the existing status. Notifications to
    creator/co-hosts are bundled via a tag so iOS replaces previous
    pushes for the same event with the latest count."""
    if not google_id:
        raise HTTPException(status_code=400, detail="google_id obrigatório")
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Evento não encontrado")

    # Already has access? Skip the request and return 200.
    creator_id = event.get("created_by") or ""
    invitees = event.get("extra_invitee_ids") or []
    co_hosts = event.get("co_host_ids") or []
    if google_id == creator_id or google_id in invitees or google_id in co_hosts:
        return {"ok": True, "status": "already_invited"}

    # Existing request for this (event, user) — return its status.
    current = db.get_invite_request_status(event_id, google_id)
    if current == "pending":
        return {"ok": True, "status": "pending"}
    if current == "rejected":
        return {"ok": True, "status": "rejected"}
    if current == "accepted":
        return {"ok": True, "status": "accepted"}

    # Rate limit: 5 / hour / user.
    if db.count_recent_invite_requests(google_id) >= db.RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(status_code=429, detail="Muitos pedidos. Tenta de novo mais tarde.")

    if not db.create_invite_request(event_id, google_id):
        return {"ok": True, "status": "pending"}

    # Notify creator + co-hosts. Bundle via tag so multiple requests
    # for the same event collapse into one notification slot.
    requester_name = _user_display_name(google_id)
    pending = db.get_pending_invite_requests(event_id)
    count = len(pending)
    body = (
        f"{requester_name} pediu pra entrar"
        if count == 1
        else f"{requester_name} e mais {count - 1} pediram pra entrar"
    )
    title = f"📩 {event.get('name') or 'Convite'}"
    tag = f"invite-request-{event_id}"
    targets = [creator_id, *[c for c in co_hosts if c != creator_id]]

    def _fanout():
        for tgt in targets:
            try:
                _send_push_to_user(
                    tgt, title=title, body=body,
                    url=_event_deep_link(event_id), tag=tag,
                )
            except Exception as exc:
                log.warning(f"invite-request push to {tgt} failed: {exc}")

    background_tasks.add_task(_fanout)
    return {"ok": True, "status": "pending"}


@app.get("/events/{event_id}/invite-requests")
def list_invite_requests(event_id: str, google_id: str):
    """List pending invite requests for an event. Creator/co-host only.
    The frontend renders these as "Pedidos pendentes" rows on the hero
    with inline Aceitar/Recusar buttons."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Evento não encontrado")
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Apenas criador ou co-organizadores")
    return {"requests": db.get_pending_invite_requests(event_id)}


@app.post("/events/{event_id}/invite-requests/{requester_google_id}/accept")
def accept_invite_request(
    event_id: str, requester_google_id: str, google_id: str,
    background_tasks: BackgroundTasks,
):
    """Approve a pending request. Adds the requester to extra_invitee_ids,
    marks the request accepted, and pushes "Te convidaram pra ..." to the
    requester so they know to RSVP."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Evento não encontrado")
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Apenas criador ou co-organizadores")
    if not db.accept_invite_request(event_id, requester_google_id):
        raise HTTPException(status_code=404, detail="Pedido não encontrado ou já decidido")

    # Push to the now-invited user. Mirrors the post-creation invite copy.
    creator_name = _user_display_name(google_id)
    name = event.get("name") or "um plano"
    venue_label = event.get("venue") or ""
    when_label = (event.get("date_start") or "")[:10]
    body = (
        f"{creator_name} aceitou seu pedido — {name}"
        + (f" no {venue_label}" if venue_label else "")
        + (f", {when_label}" if when_label else "")
    )

    def _push():
        try:
            _send_push_to_user(
                requester_google_id,
                title="🎉 Você foi convidado",
                body=body,
                url=_event_deep_link(event_id),
                tag=f"invite-accepted-{event_id}",
            )
        except Exception as exc:
            log.warning(f"invite-accepted push to {requester_google_id} failed: {exc}")

    background_tasks.add_task(_push)
    return {"ok": True}


@app.delete("/events/{event_id}/invite-requests/{requester_google_id}")
def reject_invite_request(event_id: str, requester_google_id: str, google_id: str):
    """Reject a pending request. The row stays (status='rejected') so
    the same user can't re-request the same event."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Evento não encontrado")
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Apenas criador ou co-organizadores")
    db.reject_invite_request(event_id, requester_google_id)
    return {"ok": True}


@app.delete("/events/{event_id}/invitees/{invitee_google_id}")
def remove_event_invitee(event_id: str, invitee_google_id: str, google_id: str):
    """Remove someone from an event's invitee list. Allowed for the
    event's creator OR any co-host (they share the invite privilege).
    Distinct from POST /events/{event_id}/decline (which a user calls
    on themselves to leave) — this is the host-driven kick.

    No effect on the user's existing RSVP — that's a separate concern.
    Cleaner UX would also clear the RSVP, but for now we keep semantics
    simple: removing from invite list = "you're no longer expected";
    if they had RSVP'd they'd see the event vanish from group fetches
    on next refresh anyway."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Apenas criador ou co-organizadores podem remover convidados")
    if invitee_google_id == event["created_by"]:
        raise HTTPException(status_code=400, detail="Não dá pra remover o criador do próprio evento")
    # Remove from BOTH the invitee list AND any RSVP they made.
    # Without the rsvp delete, an attendee who'd already RSVP'd would
    # stay visible in the "Quem vai" roster after being kicked
    # (the attendees endpoint joins both lists).
    db.decline_event_invite(event_id, invitee_google_id)
    db.delete_rsvp(invitee_google_id, event_id)
    return {"ok": True}


@app.delete("/events/{event_id}/groups/{group_id}")
def unlink_event_group(event_id: str, group_id: str, google_id: str):
    """Remove a group link from a user-owned event. The event itself
    isn't deleted — only the link to this group. Allowed for the
    event's creator or any co-host. Returns the updated event row.
    Accepts either the private event's own id or the CATALOG event's id:
    the "Adicionar a um grupo" sheet only ever knows the latter, because
    a fork gets a new id the sheet never sees. Without this, removing was
    a dead end that told you to go delete the event inside the group.

    No-op if the group wasn't linked."""
    event = db.get_group_event(event_id)
    if not event:
        event = db.find_group_event_by_source(group_id, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    event_id = event["id"]
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Só criador ou co-organizadores podem desvincular")
    updated = db.unlink_event_from_group(event_id, group_id)
    return {"ok": True, "event": updated}


@app.get("/catalog-events/{source_event_id}/groups")
def get_groups_with_source(source_event_id: str, google_id: str):
    """Which channels already hold a fork of this event. Drives the
    "Adicionado · toque pra remover" state in AddToGroupSheet; without
    it the only way to know is to open each channel and look.

    Two things this has to get right, and used to get wrong:

    1. Channels count. The scan ran over get_groups_for_user, which
       deliberately excludes channels (see its docstring), while the
       sheet lists every channel the caller curates right alongside the
       crews. So an auê channel that already had the event sat there
       offering to add it again, and the answer was wrong for exactly
       the rows the curator uses most.

    2. The id may already be a fork's. Once an event has been added
       anywhere, the row the user is looking at in Eventos IS the fork,
       so the sheet hands us `grp_ev_…` and not the catalog id. Resolve
       through it, and count the fork's own channels while we're there.

    Scanning every channel rather than only the curated ones is
    deliberate: which events a public channel holds is public — you can
    open it and read them — and the sheet renders rows only for the
    channels it already listed, so extra ids here surface nothing."""
    if not google_id or not source_event_id:
        return {"linked_group_ids": []}
    linked: list[str] = []
    catalog_id = source_event_id
    fork = db.get_group_event(source_event_id)
    if fork:
        catalog_id = (fork.get("source_event_id") or "").strip() or source_event_id
        for gid in [fork.get("group_id"), *(fork.get("group_ids") or [])]:
            if gid and gid not in linked:
                linked.append(gid)
    candidates: list[str] = []
    for g in (db.get_groups_for_user(google_id) or []):
        gid = g.get("id") or g.get("group_id")
        if gid and gid not in candidates:
            candidates.append(gid)
    for c in (db.list_channels(google_id) or []):
        gid = c.get("id")
        if gid and gid not in candidates:
            candidates.append(gid)
    for gid in candidates:
        if gid in linked:
            continue
        if db.find_group_event_by_source(gid, catalog_id):
            linked.append(gid)
    return {"linked_group_ids": linked}


@app.post("/groups/{group_id}/events")
def create_group_event(group_id: str, req: GroupEventCreateRequest,
                       background_tasks: BackgroundTasks):
    """Create an event tagged to a group. Any member can create.

    Visibility is the unified rule (creator OR in invitee list); the
    `group_id` is metadata that drives the calendar feed and the
    in-card group label for viewers who are also members.

    Invitee list resolution:
      - Caller sends `invitee_google_ids` → use it verbatim (already
        curated; new client knows what it's doing).
      - Caller omits it (legacy clients) → expand to all current group
        members minus the creator. Preserves today's behavior.

    Pushes go to everyone in the resolved invitee list — outsiders
    included — so an invite always surfaces as a notification."""
    # A channel is curated: following it must not grant the right to
    # publish into it. Without this, "seguir" would be an open write to
    # a feed every other follower sees.
    # PUBLIC channels only. Publishing into one is publishing to
    # everyone who follows it, so it belongs to whoever runs it.
    #
    # A private channel stays open to its members, which is the whole
    # point of it — control here means administration, not publishing.
    # Only 3 of 38 accounts have ever created an event, and narrowing
    # who may add one is the opposite of what that number asks for.
    if db.is_public_channel(group_id) and not (
        _is_curator_google_id(req.google_id)
        or db.is_channel_curator(group_id, req.google_id)
    ):
        raise HTTPException(
            status_code=403,
            detail="Só a curadoria desse canal publica nele",
        )
    role = db.get_group_member_role(group_id, req.google_id)
    if role is None:
        raise HTTPException(status_code=403, detail="Must be a group member to create events")

    # Same floor as create_personal_plan. Both endpoints write the same
    # group_events row, so a name accepted by one and rejected by the
    # other is pure drift — the HTML `required` attribute was the only
    # thing standing between this path and a 1-char event name.
    if len((req.name or "").strip()) < 3:
        raise HTTPException(status_code=400, detail="Dá um nome pro evento (mín 3 letras)")

    # Dedup: if this catalog event has already been added to this group,
    # return the existing row instead of creating a second one. Without
    # this, tapping "Adicionar a um grupo" twice spawned two group_events
    # rows from the same source — one auto-RSVP per row, two "Confirmado"
    # badges for what the user thinks is the same plan. source_event_id
    # is the catalog event id (set by the frontend in eventData), empty
    # for from-scratch personal plans.
    src_id = (req.source_event_id or "").strip()

    # Multi-group ADD when the source IS a user-owned group_events row
    # (id starts with grp_ev_, the user is the creator). Adding their
    # own plan to a group should LINK it (append to group_ids), not
    # create a second event with the same name. Catalog events fall
    # through to the dedup + create path below.
    if src_id.startswith("grp_ev_"):
        src_row = db.get_group_event(src_id)
        if src_row and src_row.get("created_by") == req.google_id:
            if group_id in (src_row.get("group_ids") or []):
                # Already linked to this group — nothing to do.
                # notified_count is what the sheet reports back to the
                # user ("3 avisados"). It has to be what actually went
                # out, not the group's size: three of this endpoint's
                # four exits send no push at all, and a count computed
                # on the client would claim otherwise on every one.
                return {**src_row, "notified_count": 0}
            # Expand the invitee list to include this group's members
            # (minus the creator). Existing invitees are preserved so
            # other groups' members stay visible.
            existing_invitees = {
                str(g) for g in (src_row.get("extra_invitee_ids") or []) if g
            }
            group_member_ids = {
                m["google_id"] for m in db.get_group_members(group_id)
                if m.get("google_id") and m["google_id"] != req.google_id
            }
            new_invitees = sorted(existing_invitees | group_member_ids)
            # Only the people this link actually adds. Everyone already on
            # the list was pushed when the event was created — pushing
            # them again for a link they can't see would be noise.
            newly_invited = sorted(group_member_ids - existing_invitees)
            linked = db.link_event_to_group(src_id, group_id, new_invitees)
            if linked:
                # This path used to send nothing at all: the group's
                # members became invitees, the event appeared in their
                # Pendências, and the one channel that reaches a phone
                # before the app is opened stayed quiet. "Fiz um plano,
                # quero chamar a galera" is the most group-shaped action
                # there is, so it gets the same push the catalog path
                # gets. Everyone here came out of get_group_members, so
                # the group framing is safe — no outsider learns the
                # group exists.
                if newly_invited:
                    group = db.get_group(group_id)
                    title = f"🎲 {(group or {}).get('name') or 'no grupo'}"
                    body = f"{_user_display_name(req.google_id)} adicionou: {linked.get('name') or ''}"
                    tag = f"group-event-{group_id}-{src_id}"

                    def _fanout_link_pushes():
                        for invitee_id in newly_invited:
                            try:
                                _send_push_to_user(
                                    invitee_id, title=title, body=body,
                                    url=f"/#/channels/{group_id}", tag=tag,
                                )
                            except Exception as exc:
                                log.warning(
                                    f"Group event {src_id}: link push to {invitee_id} failed: {exc}"
                                )

                    background_tasks.add_task(_fanout_link_pushes)
                return {**linked, "notified_count": len(newly_invited)}

    if src_id:
        existing = db.find_group_event_by_source(group_id, src_id)
        if not existing:
            # Your own copy of this night that belongs to no channel —
            # left behind by taking it out of one. Re-link it instead of
            # writing a second row beside it: the duplicate check looks
            # for a fork in THIS group, and an orphan is in none, so
            # remove-and-re-add used to leave two rows for one night
            # with nothing saying they were the same.
            orphan = db.find_orphaned_fork(req.google_id, src_id)
            if orphan:
                # link_event_to_group REPLACES the invitee list rather
                # than merging into it — its docstring says so, and the
                # list is empty on an orphan anyway. Public channels
                # invite nobody; a private one invites its members, the
                # same rule the create path below applies.
                if db.is_public_channel(group_id):
                    relink_invitees: list[str] = []
                else:
                    relink_invitees = sorted({
                        m["google_id"] for m in db.get_group_members(group_id)
                        if m.get("google_id") and m["google_id"] != req.google_id
                    })
                relinked = db.link_event_to_group(
                    orphan["id"], group_id, relink_invitees
                )
                if relinked:
                    return {**relinked, "notified_count": 0}
        if existing:
            # Self-heal legacy events that pre-date the create-time
            # auto-RSVP — re-tapping "Adicionar a um grupo" on the
            # same source now ensures the user is RSVP'd. upsert_rsvp
            # is idempotent so this is a no-op for fresh events.
            try:
                db.upsert_rsvp(
                    google_id=req.google_id,
                    event_id=existing["id"],
                    event_name=existing.get("name") or "",
                    event_venue=existing.get("venue") or "",
                    event_date=existing.get("date_start") or "",
                    event_url="",
                )
            except Exception as e:
                log.warning(f"Group event {existing['id']}: dedup auto-RSVP failed: {e}")
            # Already in this group from an earlier tap — the push went
            # out then, not now.
            return {**existing, "notified_count": 0}

    # Nobody is invited to a public channel.
    #
    # Publishing into one used to write every follower into
    # extra_invitee_ids, because a channel is a `groups` row and this
    # expanded members. But that list is what every personal surface
    # keys off — "esperando você", "ver convite", the creator-or-invitee
    # visibility rule, isPersonalPlan — so following auê Rockzera turned
    # its whole programme into a pile of personal invitations, and an
    # event you were "invited" to by a channel you aren't a member of
    # came back labelled as your own plan.
    #
    # Following is not being invited. A channel's events reach you
    # through the channel screen and the Eventos section, neither of
    # which consults this list.
    if db.is_public_channel(group_id):
        invitees = []
    elif req.invitee_google_ids is None:
        invitees = [
            m["google_id"]
            for m in db.get_group_members(group_id)
            if m.get("google_id") and m["google_id"] != req.google_id
        ]
    else:
        # De-dup, drop creator (tracked via created_by), drop empties.
        invitees = sorted({
            str(g) for g in req.invitee_google_ids
            if g and str(g) != req.google_id
        })
    event = db.create_group_event(
        group_id=group_id,
        google_id=req.google_id,
        name=req.name.strip(),
        description=_description_with_source(req.description, req.source_url),
        venue=req.venue.strip(),
        date_start=req.date_start,
        date_end=req.date_end,
        # Visibility is intentionally hardcoded — auê group events are
        # members-only by design. The column stays for backward compat
        # but the values are no longer user-controllable.
        visibility="members",
        note=req.note.strip(),
        extra_invitee_ids=invitees,
        # Credit the venue's Painel for views/RSVPs: a catalog fork carries
        # the handle in its event id; a link-created event sends it directly.
        source_ig_handle=_handle_from_event_id(req.source_event_id)
            or re.sub(r"[^A-Za-z0-9._]", "", (req.source_ig_handle or "").lstrip("@"))[:30],
        source_event_id=(req.source_event_id or "").strip(),
    )
    event = _attach_instagram_post(event, req.image_url, req.source_url)
    # A fork reads its facts back off the catalog row it points at, so
    # that a forked event's name, time and cover keep improving as the
    # scrape does. That is right for everything except a date the caller
    # chose on purpose.
    #
    # A run — a residency, a week-long programação — is one catalog row
    # shown on every day it covers. Adding it from the 18th forks the
    # 18th, but the catalog row still says the run STARTED on the 14th,
    # and the merge would quietly put the 14th back: the event arrives
    # in the channel already over, which is how it was reported. Pinning
    # is the existing way to say "a human decided this".
    if src_id and (req.date_start or "")[:10]:
        catalog_row = db.get_event_by_id(src_id)
        catalog_day = _as_iso(getattr(catalog_row, "date_start", ""))[:10] if catalog_row else ""
        if catalog_day and catalog_day != req.date_start[:10]:
            db.pin_group_event_fields(event["id"], ["date_start", "date_end"])
            event["edited_fields"] = list(
                set((event.get("edited_fields") or []) + ["date_start", "date_end"])
            )
    _queue_catalog_request(event, req, background_tasks)

    # Auto-RSVP the creator — same contract as create_personal_plan.
    # Without this, "Adicionar a um grupo" leaves the creator showing
    # in their own Pendentes section, asking them to confirm an event
    # they just created. They're already going by definition.
    #
    # Except in a public channel, where they are not. Publishing into
    # auê Rockzera is editorial work, not attendance: a curator clearing
    # an afternoon's backlog ended up marked as going to fifteen nights
    # across the city, and their friends saw it — "vou" is one of the
    # few things this app says about you to other people.
    if not db.is_public_channel(group_id):
        try:
            db.upsert_rsvp(
                google_id=req.google_id,
                event_id=event["id"],
                event_name=req.name.strip(),
                event_venue=event.get("venue", ""),
                event_date=req.date_start,
                event_url="",
            )
        except Exception as e:
            log.warning(f"Group event {event['id']}: auto-RSVP failed: {e}")

    # Notify everyone on the invitee list (group members + outsiders).
    # Tag per (group, event) so accidental double-creates collapse
    # instead of stacking. The note (if any) shows in the push body —
    # instant context without opening the app.
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
    # "adicionou" only makes sense if you know what it was added TO.
    # An outsider has no group context, so they get the same phrasing
    # create_personal_plan uses. Neither string names the group.
    outsider_body = (
        f'{creator_name}: "{note[:80]}" — {req.name.strip()}'
        if note else
        f"{creator_name} te convidou pra {req.name.strip()}"
    )
    # Fan out in a BackgroundTask, not inline. create_personal_plan already
    # learned this: N serial webpush + APNs calls before responding blew past
    # the frontend's 5s fetch timeout on a Railway cold start, so the UI
    # showed "Failed to fetch" for an event that had in fact been created.
    # This path kept the inline loop — a group of 8 meant 8 serial sends
    # holding the response open. Same fix, backported.
    # Outsiders must not learn the group exists. _group_event_to_frontend
    # already gates groupId/groupName on membership, and GET /groups/{id}
    # 403s non-members — but the push bypassed both: it put the private
    # group's NAME in the title and deep-linked every recipient to
    # /#/channels/{id}, a page outsiders are then refused. So the one
    # channel that reaches you before you open the app was the one
    # leaking. Members get the group framing; outsiders get the creator's
    # name and a link to the event itself.
    member_ids = {
        m["google_id"] for m in db.get_group_members(group_id)
        if m.get("google_id")
    }
    # The 🔔 switch on the channel screen wrote to group_members.notify
    # and nothing read it on this path, so a member of a busy channel
    # got a push per event with no way to stop it short of leaving.
    # Members only: an outsider invited to one event has no channel to
    # have muted, and silencing them would drop the single push that
    # tells them they were invited at all.
    muted_ids = {
        gid for gid in member_ids
        if not db.get_channel_notify(group_id, gid)
    }
    # A public channel is a feed, not an invitation. Publishing into one
    # is an editorial act that happens several times in an afternoon —
    # a curator clearing a backlog sent a push per event, which is the
    # shape people mute the app over. Its followers get one summary a
    # day instead (send_channel_digests, 20:00), and the count in that
    # summary is read off the table, so nothing here has to keep score.
    #
    # Private channels keep the instant push. There the event IS the
    # message: somebody you know is doing something, and holding that
    # until evening makes it news about a night that already started.
    batched = db.is_public_channel(group_id)

    def _fanout_pushes():
        for invitee_id in invitees:
            is_member = invitee_id in member_ids
            if invitee_id in muted_ids:
                continue
            try:
                _send_push_to_user(
                    invitee_id,
                    title=f"🎲 {group_name}" if is_member else "🎲 Convite",
                    body=body if is_member else outsider_body,
                    url=f"/#/channels/{group_id}" if is_member else _event_deep_link(event["id"]),
                    tag=tag,
                )
            except Exception as exc:
                log.warning(f"Group event {event['id']}: push to {invitee_id} failed: {exc}")

    if not batched:
        background_tasks.add_task(_fanout_pushes)
    # Run badge eval on the creator so curador progression surfaces on
    # the next /user/state load. Other members get crew_quente tier-ups
    # on their own next interaction (cheaper than evaluating N members
    # synchronously here).
    new_badges = badges.evaluate(req.google_id)
    # How many people this add actually reaches. The fan-out is a
    # BackgroundTask, so this is "queued for", not "delivered to" — an
    # individual send can still fail on a dead token. It is the honest
    # number available at this point, and the only exit that isn't zero.
    #
    # Muted members are subtracted rather than counted: the sheet shows
    # this back to the user as "3 avisados", and the loop above skips
    # them, so counting them would be the same claim the count exists
    # to avoid — a number computed from the group's size rather than
    # from what went out.
    return {
        **event,
        "new_badges": new_badges,
        # Zero on a public channel, and honestly so: nobody is notified
        # by this call. The sheet says "3 avisados" off this number, and
        # claiming three when the pushes go out at 20:00 — or don't,
        # because somebody muted the channel — is the kind of number
        # this field was narrowed to stop producing.
        "notified_count": 0 if batched else len(
            [i for i in invitees if i not in muted_ids]
        ),
    }


@app.get("/groups/{group_id}/events")
def list_group_events(group_id: str, google_id: str = ""):
    """List events tagged with this group that the viewer is invited
    to. Non-authenticated callers get an empty list (no public-event
    surface anymore — event publicness was removed in April 2026)."""
    if not google_id:
        return {"events": []}
    events = db.get_group_events(group_id, viewer_google_id=google_id)
    return {"events": events}


@app.delete("/groups/{group_id}/events/{event_id}")
def delete_group_event(group_id: str, event_id: str, google_id: str):
    """Delete a group event. Admins, the creator, or any co-host can
    delete — co-hosts share the creator's destructive privilege."""
    event = db.get_group_event(event_id)
    if not event or event["group_id"] != group_id:
        raise HTTPException(status_code=404, detail="Event not found in this group")
    role = db.get_group_member_role(group_id, google_id)
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if role != "admin" and not is_creator and not is_co_host:
        raise HTTPException(status_code=403, detail="Only admins, the creator, or co-organizers can delete")
    db.delete_group_event(event_id)
    image_store.delete_event_image(event_id)  # cascade: don't leave orphan image files
    return {"ok": True}


@app.post("/events/{event_id}/decline")
def decline_event(event_id: str, google_id: str):
    """"Não vou" — take the calling user off the invitee list, drop their
    RSVP and record the decline so the host sees it (see
    db.decline_event_invite). Called from the event hero and from the
    trash icon in My RSVPs.

    No-op (still 200) if the user wasn't on the invitee list — the
    frontend uses this defensively right after a cancel-RSVP and we
    don't want to surface "already gone" as an error."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    db.decline_event_invite(event_id, google_id)
    return {"ok": True}


class UpdateGroupEventRequest(BaseModel):
    google_id: str                       # the requester (must be creator or co-host)
    name: Optional[str] = None
    venue: Optional[str] = None
    date_start: Optional[str] = None
    date_end: Optional[str] = None
    description: Optional[str] = None
    note: Optional[str] = None


@app.patch("/events/{event_id}")
def edit_group_event(event_id: str, req: UpdateGroupEventRequest):
    """Edit an event's content fields. Allowed for the event's creator
    OR any co-host — same permission set as image management and
    invitee additions. Works for both group-tagged events and
    standalone personal plans (same row schema).

    Image, co-hosts, and visibility have separate endpoints — this is
    only for name / venue / date / description / note."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    is_creator = event["created_by"] == req.google_id
    is_co_host = req.google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Só criador ou co-organizadores podem editar")

    fields = req.model_dump(exclude={"google_id"}, exclude_none=True)
    # Sanitize text fields. Length limits mirror the create flow.
    for k, limit in (("name", 200), ("venue", 200), ("description", 1000), ("note", 280)):
        if k in fields:
            fields[k] = (fields[k] or "").strip()[:limit]
    if "name" in fields and not fields["name"]:
        raise HTTPException(status_code=400, detail="Nome não pode ficar vazio")

    updated = db.update_group_event(event_id, fields)
    return {"ok": True, "event": updated}


class AddInviteesRequest(BaseModel):
    google_id: str                       # the requester (must be creator)
    invitee_google_ids: list[str] = []   # google_ids to add to the invitee list


@app.post("/events/{event_id}/invitees")
def add_event_invitees(event_id: str, req: AddInviteesRequest, background_tasks: BackgroundTasks):
    """Append google_ids to an event's invitee list post-creation.
    Allowed for the event's creator OR any co-host — co-hosts share
    the invite privilege by design.

    Works for both group-tagged events and standalone plans (same row
    schema after the May 2026 unification). Dedupes against the
    existing invitee list. Fires a "Ciro te convidou pra…" push to
    just-added invitees in a background task — mirrors the create-time
    flow so an invite always feels the same regardless of when it
    happened."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    is_creator = event["created_by"] == req.google_id
    is_co_host = req.google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Só o criador ou co-organizadores podem convidar mais gente")
    incoming = sorted({
        str(g) for g in req.invitee_google_ids
        if g and str(g) != req.google_id  # creator is implicit
    })
    if not incoming:
        return {
            "ok": True,
            "invitee_google_ids": event.get("extra_invitee_ids") or [],
            "added": [],
        }
    full_list, added = db.add_invitees_to_event(event_id, incoming)
    if added:
        creator_name = _user_display_name(req.google_id)
        name = event.get("name") or "um plano"
        venue_label = event.get("venue") or ""
        when_label = (event.get("date_start") or "")[:10]
        body = (
            f"{creator_name} te convidou pra {name}"
            + (f" no {venue_label}" if venue_label else "")
            + (f", {when_label}" if when_label else "")
        )
        tag = f"event-invite-{event_id}"

        def _fanout_pushes():
            for invitee in added:
                try:
                    _send_push_to_user(
                        invitee,
                        title="🎲 Convite",
                        body=body,
                        url=_event_deep_link(event_id),
                        tag=tag,
                    )
                except Exception as exc:
                    log.warning(f"Event {event_id}: invite push to {invitee} failed: {exc}")

        background_tasks.add_task(_fanout_pushes)
    return {
        "ok": True,
        "invitee_google_ids": full_list,
        "added": added,
    }


class AddCoHostRequest(BaseModel):
    google_id: str            # the requester (must be the creator)
    co_host_google_id: str    # the user to promote


@app.post("/events/{event_id}/co-hosts")
def add_event_co_host(event_id: str, req: AddCoHostRequest, background_tasks: BackgroundTasks):
    """Promote an invitee to co-host. Creator-only — co-hosts share the
    creator's invite + delete privileges, so the privilege of *granting*
    that power stays with the framer of the plan.

    The promoted user must already be on extra_invitee_ids (you can't
    co-host someone who isn't even invited). After promotion, fires a
    push: 'Ciro te promoveu a co-organizador de…'."""
    if not req.co_host_google_id or str(req.co_host_google_id) == req.google_id:
        raise HTTPException(status_code=400, detail="co_host_google_id inválido")
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    if event["created_by"] != req.google_id:
        raise HTTPException(status_code=403, detail="Só o criador do evento pode promover co-organizadores")
    target = str(req.co_host_google_id)
    invitees = event.get("extra_invitee_ids") or []
    if target not in invitees:
        raise HTTPException(
            status_code=400,
            detail="A pessoa precisa estar convidada antes de virar co-organizador",
        )
    full_list, was_added = db.add_co_host(event_id, target)
    if was_added:
        creator_name = _user_display_name(req.google_id)
        name = event.get("name") or "um plano"
        body = f"{creator_name} te promoveu a co-organizador de {name}"
        tag = f"event-co-host-{event_id}-{target}"

        def _push():
            try:
                _send_push_to_user(
                    target,
                    title="🎲 Co-organizador",
                    body=body,
                    url=_event_deep_link(event_id),
                    tag=tag,
                )
            except Exception as exc:
                log.warning(f"Event {event_id}: co-host push to {target} failed: {exc}")

        background_tasks.add_task(_push)
    return {"ok": True, "co_host_ids": full_list, "added": was_added}


@app.delete("/events/{event_id}/co-hosts/{co_host_google_id}")
def remove_event_co_host(event_id: str, co_host_google_id: str, google_id: str):
    """Remove a co-host. Creator can demote anyone; a co-host can
    self-demote (no creator approval needed for stepping down)."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    is_creator = event["created_by"] == google_id
    is_self = google_id == co_host_google_id
    if not (is_creator or is_self):
        raise HTTPException(status_code=403, detail="Só o criador ou o próprio co-organizador podem remover")
    full_list, was_removed = db.remove_co_host(event_id, str(co_host_google_id))
    return {"ok": True, "co_host_ids": full_list, "removed": was_removed}


# Image upload max — generous for phone photos. The image_store helper
# also enforces this; the FastAPI-level cap is a defense-in-depth so
# a malicious upload doesn't even reach our handler. 8MB headroom over
# the 5MB store cap so we get a clean 413 instead of a silent
# truncation when someone sends a borderline file.
_EVENT_IMAGE_UPLOAD_CAP = 8 * 1024 * 1024


@app.post("/events/{event_id}/image")
async def upload_event_image(
    event_id: str,
    file: UploadFile = File(...),
    google_id: str = Form(...),
):
    """Upload (or replace) the cover image for a private event. Allowed
    for the creator OR any co-host — same role set as invite/delete.

    Stored on the same /event-images/ volume as catalog rehosts; same
    filename convention (`<event_id>.<ext>`) so a replace overwrites
    cleanly. Validates content-type (jpg/png/webp/gif) and size (5MB
    via image_store, 8MB hard cap here as defense-in-depth)."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Só o criador ou co-organizadores podem editar a foto")
    content = await file.read()
    if len(content) > _EVENT_IMAGE_UPLOAD_CAP:
        raise HTTPException(status_code=413, detail="Imagem maior que 8MB")
    public = image_store.save_user_upload(event_id, content, file.content_type or "")
    if not public:
        raise HTTPException(status_code=400, detail="Imagem inválida (use JPG, PNG, WebP, GIF ou HEIC)")
    db.set_event_image_url(event_id, public)
    return {"ok": True, "image_url": public}


@app.delete("/events/{event_id}/image")
def delete_event_image(event_id: str, google_id: str):
    """Clear the cover image. Same auth as upload."""
    event = db.get_group_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Só o criador ou co-organizadores podem remover a foto")
    image_store.delete_event_image(event_id)
    db.set_event_image_url(event_id, "")
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
        description=_description_with_source(req.description, req.source_url),
        venue=(req.venue or "").strip(),
        date_start=req.date_start,
        date_end=req.date_end,
        visibility="members",  # not used when group_id is null, but keep the column happy
        note=(req.note or "").strip(),
        extra_invitee_ids=invitees,
        # Credit the venue's Painel for views/RSVPs: a catalog fork carries
        # the handle in its event id; a link-created event sends it directly.
        source_ig_handle=_handle_from_event_id(req.source_event_id)
            or re.sub(r"[^A-Za-z0-9._]", "", (req.source_ig_handle or "").lstrip("@"))[:30],
        source_event_id=(req.source_event_id or "").strip(),
    )
    event = _attach_instagram_post(event, req.image_url, req.source_url)
    _queue_catalog_request(event, req, background_tasks)

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
                    url=_event_deep_link(event_id),
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
    """The creator or any co-host can delete the plan. Co-hosts share
    the destructive privilege."""
    event = db.get_group_event(event_id)
    if not event or event.get("group_id"):
        raise HTTPException(status_code=404, detail="Plano não encontrado")
    is_creator = event["created_by"] == google_id
    is_co_host = google_id in (event.get("co_host_ids") or [])
    if not (is_creator or is_co_host):
        raise HTTPException(status_code=403, detail="Só o criador ou co-organizadores podem apagar")
    db.delete_group_event(event_id)
    image_store.delete_event_image(event_id)  # cascade: don't leave orphan image files
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

    # Feed token = bearer auth granting access to the entire group's
    # calendar. We intentionally bypass the per-user invitee gate here
    # because the URL is a holistic subscription — that's how iCal
    # feeds work and how subscribers expect them to behave. (Per-user
    # feed tokens would be a follow-up if we ever need finer scoping.)
    events = db.get_group_events(group["id"])

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


# ── Account suggestions ────────────────────────────────────
# Anyone signed in can suggest an Instagram account in Fontes; curators
# approve it in /curadoria?tab=contas. Not added straight to tracking:
# each tracked account costs a daily Apify + Claude pass, and the catalog
# only works if the accounts post Curitiba events.

_IG_HANDLE_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
_MAX_OPEN_ACCOUNT_SUGGESTIONS = 10


class AccountSuggestion(BaseModel):
    google_id: str
    handle: str
    note: str = ""


@app.post("/accounts/requests")
def suggest_account(req: AccountSuggestion):
    """Returns {status, handle}: 'requested' | 'already_requested' (someone
    already suggested it — counted, not re-queued) | 'already_tracked'."""
    handle = req.handle.strip().lstrip("@").lower()
    if not _IG_HANDLE_RE.match(handle):
        raise HTTPException(status_code=400, detail="Handle inválido (use letras, números, '.' ou '_')")
    if not req.google_id or db.get_user_state(req.google_id) is None:
        raise HTTPException(status_code=401, detail="Entra na sua conta pra sugerir")
    tracked = db.find_ig_account_ci(handle)
    if tracked and tracked.get("enabled"):
        return {"status": "already_tracked", "handle": tracked["handle"]}
    if db.count_open_account_requests_by(req.google_id) >= _MAX_OPEN_ACCOUNT_SUGGESTIONS:
        raise HTTPException(
            status_code=429,
            detail="Você já tem várias sugestões esperando — a curadoria olha essas primeiro 🙏",
        )
    request, created = db.insert_account_request(handle, req.note.strip()[:300], req.google_id)
    if created:
        body = f"{_user_display_name(req.google_id)} sugeriu @{handle}"
        if request.get("note"):
            body += f": {request['note']}"
        for uid in db.user_ids_for_emails(db.list_curator_emails()):
            try:
                _send_push_to_user(
                    uid,
                    title="📡 Conta sugerida",
                    body=body[:180],
                    url="/#/curadoria?tab=contas",
                    tag=f"account-request-{request['id']}",
                )
            except Exception as exc:
                log.warning(f"Account request {request['id']}: push to {uid} failed: {exc}")
    return {"status": "requested" if created else "already_requested", "handle": handle}


class AccountRequestDecision(BaseModel):
    requesting_email: str
    category: str = ""
    label: str = ""


def _account_request_out(r: dict) -> dict:
    tracked = db.find_ig_account_ci(r["handle"])
    return {
        **r,
        "requested_by_name": _user_display_name(r["requested_by"]),
        "reviewed_by_name": _reviewer_name(r["reviewed_by"]) if r.get("reviewed_by") else "",
        "previously_tracked": bool(tracked and not tracked.get("enabled")),
    }


def _already_resolved(request_id: int) -> dict:
    current = db.get_account_request(request_id) or {}
    return {
        "ok": False,
        "status": current.get("status", ""),
        "reviewed_by_name": _reviewer_name(current["reviewed_by"]) if current.get("reviewed_by") else "",
    }


@app.get("/admin/account-requests")
def admin_list_account_requests(requesting_email: str = "", status: str = "review"):
    _require_curator(requesting_email)
    if status not in ("review", "approved", "rejected", "all"):
        raise HTTPException(status_code=400, detail="status inválido")
    return {"requests": [_account_request_out(r) for r in db.list_account_requests(status)]}


@app.post("/admin/account-requests/{request_id}/approve")
def admin_approve_account_request(request_id: int, req: AccountRequestDecision):
    """Claim the request, then start tracking the account. If adding the
    account fails the claim is undone, so the request doesn't end up
    'approved' with nothing tracked."""
    email = _require_curator(req.requesting_email)
    request = db.get_account_request(request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Sugestão não encontrada")
    category = req.category.strip()
    if not category:
        raise HTTPException(status_code=400, detail="Escolhe uma categoria")
    if not db.resolve_account_request(request_id, "approved", email):
        return _already_resolved(request_id)
    existing = db.find_ig_account_ci(request["handle"])
    try:
        account = db.upsert_ig_account(
            handle=existing["handle"] if existing else request["handle"],
            label=req.label.strip() or ((existing or {}).get("label") or ""),
            category=category,
            enabled=True,
            notes=f"Sugerida por {_user_display_name(request['requested_by'])}",
            added_by_email=email,
        )
    except Exception:
        db.reopen_account_request(request_id)
        raise
    _bust_handle_cache()
    try:
        _send_push_to_user(
            request["requested_by"],
            title="📡 Sugestão aceita",
            body=f"@{request['handle']} entrou nas fontes do auê — os eventos aparecem depois do próximo scrape",
            url="/#/sources",
            tag=f"account-request-{request_id}",
        )
    except Exception as exc:
        log.warning(f"Account request {request_id}: requester push failed: {exc}")
    return {"ok": True, "status": "approved", "account": account}


@app.post("/admin/account-requests/{request_id}/reject")
def admin_reject_account_request(request_id: int, req: AccountRequestDecision):
    """Silent for the person who suggested it — same as declining a
    friend request."""
    email = _require_curator(req.requesting_email)
    if not db.get_account_request(request_id):
        raise HTTPException(status_code=404, detail="Sugestão não encontrada")
    if not db.resolve_account_request(request_id, "rejected", email):
        return _already_resolved(request_id)
    return {"ok": True, "status": "rejected"}


@app.post("/admin/events/backfill-genre")
def admin_backfill_genre(requesting_email: str = "", limit: int = 200,
                         dry_run: bool = False):
    """Tag upcoming events that have no genre yet.

    Genre ships per event from the enrichment pass, but events scraped
    before the field existed have nothing, and the catalog only re-tags
    as it turns over. Measured 19 Sep: 32 of 128 upcoming events carried
    a tag, so a channel assembled from tags alone would have opened with
    six events.

    That's why this reverses the earlier "no genre backfill" call. The
    reasoning then was that events are perishable and the catalog
    refreshes itself — true, and still true for history, which this
    leaves alone. What changed is that channels depend on tag density
    now, and "it'll be fine in a month" isn't density.

    Founder-only because it spends money, bounded by `limit` because it
    spends it per event. `dry_run` reports what would be tagged without
    calling Claude at all.

    Writes without pinning: edited_fields means a human decided, and a
    machine fill shouldn't be frozen against a future enrichment pass
    that might do better. A genre a curator set by hand is skipped
    entirely — see list_events_needing_genre."""
    _require_founder(requesting_email)
    pending = db.list_events_needing_genre(limit=limit)
    if dry_run:
        return {
            "dry_run": True,
            "would_tag": len(pending),
            "sample": [p["name"] for p in pending[:10]],
        }
    if not pending:
        return {"considered": 0, "tagged": 0, "by_genre": {}}
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY não configurada")

    from enrichment import EnrichmentPipeline
    pipeline = EnrichmentPipeline(settings.anthropic_api_key)
    assigned = pipeline.classify_genres(pending)

    by_genre: dict[str, int] = {}
    tagged = 0
    for event_id, genre in assigned.items():
        if db.update_catalog_event(event_id, {"genre": genre}, pin=False):
            tagged += 1
            by_genre[genre] = by_genre.get(genre, 0) + 1
    log.info(f"Genre backfill by {requesting_email}: {tagged}/{len(pending)} tagged")
    return {
        "considered": len(pending),
        "tagged": tagged,
        # The gap between the two is events the model answered "nenhum"
        # for — not a failure. Most of the catalog isn't a music night.
        "left_untagged": len(pending) - tagged,
        "by_genre": dict(sorted(by_genre.items(), key=lambda kv: -kv[1])),
    }


@app.delete("/admin/events/{event_id}")
def admin_delete_catalog_event(event_id: str, requesting_email: str = ""):
    """Hard-delete a catalog event by id. Used to fix LLM mis-extractions
    that produced wrong dates / wrong recurrence / duplicated venues etc.
    Founder-only — this directly mutates the catalog seen by every user.
    User RSVPs that pointed at this event become orphan rows; the
    frontend's "evento não está mais no catálogo" fallback handles them
    cleanly on the next open."""
    _require_founder(requesting_email)
    ok = db.delete_catalog_event(event_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Evento não encontrado")
    return {"ok": True, "event_id": event_id}


class CatalogEventUpdate(BaseModel):
    """A curator's corrections to a catalog event. Every field is
    optional — only what's sent is changed, and only what's changed gets
    pinned against the next re-scrape."""
    requesting_email: str = ""
    name: Optional[str] = None
    description: Optional[str] = None
    venue_name: Optional[str] = None
    neighborhood: Optional[str] = None
    date_start: Optional[str] = None       # ISO 8601
    date_end: Optional[str] = None         # ISO 8601, or "" to clear
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    kind: Optional[str] = None             # quiet_social | active | creative | community
    genre: Optional[str] = None            # see GENRES in enrichment.py


def _price_tier_for(price_min: float) -> str:
    """Same ladder the partner-submission path uses, kept in one place
    so an edited price lands in the same bucket a submitted one would."""
    if price_min <= 0:
        return "free"
    if price_min <= 50:
        return "low"
    if price_min <= 150:
        return "medium"
    return "high"


@app.patch("/admin/events/{event_id}")
def admin_edit_catalog_event(event_id: str, req: CatalogEventUpdate):
    """Correct a catalog event's facts by hand.

    Until now the only lever over a bad extraction was DELETE, which
    throws away a real event because one field is wrong. The trigger was
    a user reporting an event "in the wrong place" (Sep 2026).

    Curator-level rather than founder-only: the people who notice a wrong
    venue are the ones already curating handles, and every change is
    pinned and reversible. DELETE stays founder-only — it destroys.

    Edits survive re-scrapes: `edited_fields` records which fields a
    human set, and upsert_event replays them over the freshly enriched
    payload. Fields nobody touched keep refreshing from Instagram.

    Propagates for free into groups. `_merge_group_event_with_catalog`
    already reads facts from the catalog row for any group event forked
    from it, so fixing the catalog fixes every fork that didn't override
    the field itself.

    Not here: the map pin. Coordinates live on the `venues` row, keyed by
    venue name, and a venue is shared by many events — PUT
    /admin/venues/{name_normalized} is the right lever, and it validates
    that the pin lands in Curitiba."""
    # Local import mirrors the rest of main.py — enrichment pulls in the
    # Anthropic client, which shouldn't load just to serve an edit.
    from enrichment import CATEGORY_GRADIENTS, CATEGORY_META, GENRES

    email = _require_curator(req.requesting_email)
    existing = db.get_event_by_id(event_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Evento não encontrado")

    fields: dict = {}
    sent = req.model_dump(exclude={"requesting_email"}, exclude_none=True)

    for key, limit in (("name", 200), ("description", 1000),
                       ("venue_name", 200), ("neighborhood", 100)):
        if key in sent:
            fields[key] = (sent[key] or "").strip()[:limit]
    if "name" in fields and not fields["name"]:
        raise HTTPException(status_code=400, detail="Nome não pode ficar vazio")
    if "venue_name" in fields and not fields["venue_name"]:
        raise HTTPException(status_code=400, detail="Local não pode ficar vazio")

    for key in ("date_start", "date_end"):
        if key not in sent:
            continue
        raw = (sent[key] or "").strip()
        if not raw:
            # Only date_end is clearable — an event without a start is
            # not an event, and the model won't accept it either.
            if key == "date_start":
                raise HTTPException(status_code=400, detail="Data de início não pode ficar vazia")
            fields[key] = None
            continue
        try:
            fields[key] = datetime.fromisoformat(raw.replace("Z", "+00:00")).isoformat()
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Data inválida: {raw}")

    if "price_min" in sent or "price_max" in sent:
        pmin = sent.get("price_min", existing.price_min) or 0.0
        pmax = sent.get("price_max", existing.price_max) or 0.0
        if pmin < 0 or pmax < 0:
            raise HTTPException(status_code=400, detail="Preço não pode ser negativo")
        if pmax and pmax < pmin:
            raise HTTPException(status_code=400, detail="Preço máximo não pode ser menor que o mínimo")
        fields["price_min"] = pmin
        fields["price_max"] = pmax
        # Derived, so it can't drift out of step with the price it labels.
        fields["price_tier"] = _price_tier_for(pmin)

    if "kind" in sent:
        kind = (sent["kind"] or "").strip()
        if kind not in CATEGORY_META:
            raise HTTPException(
                status_code=400,
                detail=f"Categoria inválida: {kind}. Use uma de {sorted(CATEGORY_META)}",
            )
        emoji, label = CATEGORY_META[kind]
        # The label, emoji and gradient all follow from kind. Setting them
        # together keeps a re-scrape from restoring a gradient that
        # belongs to the category we just edited away from.
        fields["kind"] = kind
        fields["category_emoji"] = emoji
        fields["category_label"] = label
        fields["header_gradient"] = CATEGORY_GRADIENTS.get(kind, CATEGORY_GRADIENTS["community"])

    if "genre" in sent:
        genre = (sent["genre"] or "").strip().lower()
        if genre and genre not in GENRES:
            raise HTTPException(
                status_code=400,
                detail=f"Gênero inválido: {genre}. Use uma de {sorted(GENRES)} ou vazio",
            )
        fields["genre"] = genre

    if not fields:
        raise HTTPException(status_code=400, detail="Nada pra editar")

    updated = db.update_catalog_event(event_id, fields)
    if not updated:
        raise HTTPException(status_code=404, detail="Evento não encontrado")
    log.info(f"Catalog event {event_id} edited by {email}: {sorted(fields)}")
    return {
        "ok": True,
        "event": _to_frontend(updated, detail=True, venue_coords=db.get_venue_coords_map()),
        "edited_fields": db.get_catalog_edited_fields(event_id),
    }


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


@app.get("/admin/ig-extract-debug")
async def admin_ig_extract_debug(url: str, requesting_email: str = ""):
    """Run the extractor on ONE Instagram post and report what happened.

    "That post didn't become an event" has been answerable only by reading
    Railway logs, so every investigation started with a guess. This returns
    the caption we sent, whether the flyer reached the model, the model's
    raw answer, every event that survived, and the reason each rejected one
    was dropped — the gates are exactly where a real event quietly
    disappears.

    Costs one Apify fetch + one Claude call per call. Curator-only.
    """
    _require_curator(requesting_email)
    if not re.match(r"https?://(www\.)?instagram\.com/(p|reel)/", url.strip()):
        raise HTTPException(status_code=400, detail="Cole o link de um post do Instagram")
    if not (settings.apify_api_token and settings.anthropic_api_key):
        raise HTTPException(status_code=503, detail="Apify ou Anthropic não configurados")

    from scrapers.instagram_apify import _run_apify_scrape, _extract_events
    from anthropic import AsyncAnthropic

    posts = await _run_apify_scrape(settings.apify_api_token, [url.strip()], posts_per_account=1)
    if not posts:
        return {"ok": False, "stage": "apify", "detail": "Apify não devolveu o post"}

    debug: dict = {}
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    events = await _extract_events(client, posts[0], today_str, debug_out=debug)

    return {
        "ok": True,
        "handle": (posts[0].get("ownerUsername") or "").lower(),
        "posted_at": (posts[0].get("timestamp") or "")[:10],
        "caption": debug.get("caption", "")[:1500],
        "image_sent_to_model": bool(debug.get("image_sent_to_model")),
        "model_answer": debug.get("model_answer"),
        "extracted": [
            {
                "external_id": e.external_id,
                "name": e.name,
                "date_start": e.date_start.isoformat() if e.date_start else None,
                "venue_name": e.venue_name,
            }
            for e in events
        ],
        "dropped": debug.get("drops", []),
    }


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


@app.post("/admin/test-extraction")
async def admin_test_extraction(requesting_email: str = "", caption: str = "", handle: str = "test", post_date: str = ""):
    """Founder-only: run Claude extraction on a raw caption and return the full response for debugging."""
    _require_founder(requesting_email)
    if not caption:
        raise HTTPException(status_code=400, detail="caption required")
    from anthropic import AsyncAnthropic
    import json as _json
    from scrapers.instagram_apify import EXTRACTION_PROMPT
    from datetime import datetime, timezone
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    post_date = post_date or today_str
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    prompt = EXTRACTION_PROMPT.format(today=today_str, handle=handle, post_date=post_date, caption=caption[:1500])
    try:
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        )
        raw_text = response.content[0].text.strip()
        # Strip markdown fences exactly as _extract_events does. Without
        # this the debug endpoint reports "parse failed" on responses the
        # real pipeline handles fine — which makes it look like extraction
        # is broken when it isn't.
        cleaned = re.sub(r"^```(?:json)?\s*", "", raw_text)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        try:
            parsed = _json.loads(cleaned)
        except Exception:
            parsed = None
        return {"raw_response": raw_text, "parsed": parsed, "model": "claude-haiku-4-5-20251001"}
    except Exception as e:
        return {"error": str(e)}


@app.post("/admin/ig-accounts/reset-shortcodes")
def admin_reset_ig_shortcodes(requesting_email: str = ""):
    """
    Founder-only. Clears last_post_shortcode for all enabled accounts so
    the next scheduled probe treats every handle as "new content" and
    triggers a full re-scrape. Use when the catalog feels stale and you
    suspect the probe has been silently skipping accounts (e.g. after
    Apify rate-limiting or IG bot-detection). Safe to call anytime —
    worst case is one extra Apify run.
    """
    _require_founder(requesting_email)
    count = db.reset_ig_shortcodes()
    log.info(f"admin reset_ig_shortcodes: cleared {count} shortcodes by {requesting_email}")
    return {"reset": count, "message": f"{count} shortcodes resetados — próximo refresh fará full scrape de todos os handles."}


@app.post("/admin/ig-accounts/reset-extraction-ledger")
def admin_reset_extraction_ledger(requesting_email: str = "", handle: str = ""):
    """
    Founder-only. Forgets which IG posts have already been through Claude
    extraction, so the next scrape re-evaluates them.

    Costs a full re-extraction of everything Apify hands back (roughly one
    Claude call with an image per post) — call it knowingly. The reasons
    that justify it: the extraction prompt changed and old posts should be
    re-judged, or a bad run wrote wrong verdicts.

    Pass `handle` to scope it to one account; omit for the whole ledger.
    Usually paired with /admin/ig-accounts/reset-shortcodes, which is what
    makes the probe re-fetch the posts in the first place.
    """
    _require_founder(requesting_email)
    handles = [handle] if handle.strip() else None
    removed = db.reset_processed_ig_posts(handles)
    log.info(f"admin reset_extraction_ledger: {removed} rows by {requesting_email}")
    return {
        "removed": removed,
        "scope": handle.strip().lower() or "all",
        "message": (
            f"{removed} posts esquecidos — o próximo scrape vai reextraí-los "
            f"(custa uma chamada Claude por post)."
        ),
    }


@app.get("/admin/token-usage")
def admin_token_usage(requesting_email: str = ""):
    """
    Claude token spend for the most recent refresh in this process.

    In-memory and reset at the start of each run, so it reports the last
    completed (or in-flight) refresh and is wiped by a redeploy. It exists
    because an individual Anthropic account has no Admin API — without it
    the only way to read spend is grepping Railway logs for
    "Claude token usage", and the only signal that spend is wrong is the
    balance reaching zero.
    """
    _require_founder(requesting_email)
    try:
        import token_meter
        return token_meter.snapshot()
    except Exception as e:
        return {"error": str(e)}


@app.get("/admin/extraction-ledger")
def admin_extraction_ledger(requesting_email: str = ""):
    """Ledger size + how many of those posts turned out to be events.

    A low was_event ratio is normal and is exactly why the ledger pays:
    the non-events are the bulk of what Apify returns, and without this
    table every one of them would be re-sent to Claude on every run."""
    _require_founder(requesting_email)
    stats = db.count_processed_ig_posts()
    total = stats["total"] or 0
    return {
        **stats,
        "event_rate": round(stats["was_event"] / total, 3) if total else None,
    }


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


# ── Catalog sync: staging pulls production's events ──────────────────
#
# Staging runs on its own volume, so without this it has three fake
# events and every test is a guess. These two endpoints move the
# catalog — events, venues, tracked handles — and nothing else. See
# db.export_catalog for what's deliberately left behind and why.


@app.get("/catalog-export")
def catalog_export(token: str = "", event_limit: int = 5000):
    """Production side of the sync. Token-gated, and the token has no
    default: with CATALOG_SYNC_TOKEN unset this 404s as if it were never
    deployed. The catalog is most of what auê is worth, so an open dump
    of it is not a thing we leave lying around — /events is paginated
    and filtered for a reason.
    """
    if not settings.catalog_sync_token:
        raise HTTPException(status_code=404, detail="Not found")
    if not secrets.compare_digest(token, settings.catalog_sync_token):
        raise HTTPException(status_code=404, detail="Not found")
    return db.export_catalog(event_limit=min(event_limit, 20000))


def _sync_payload_or_502(resp, endpoint: str) -> dict:
    """Parse a sync response, or fail with something worth reading.

    The origin serves a SPA, and its catch-all answers any unknown path
    with index.html and a 200. So an endpoint that hasn't been deployed
    there yet doesn't 404 — it returns a page, and the only symptom is
    JSON parsing dying on "<". That reads as "production is broken"
    when it means "production doesn't have this yet", which is the
    normal state for the exporting half of a new sync: it lives in
    production, so production has to ship first.
    """
    try:
        return resp.json()
    except Exception:
        body = (resp.text or "")[:80].lstrip().lower()
        if body.startswith("<!doctype") or body.startswith("<html"):
            raise HTTPException(
                status_code=502,
                detail=(
                    f"A produção devolveu a página do app em {endpoint}, não dados — "
                    "esse endpoint ainda não foi pra produção. A metade que exporta "
                    "precisa estar lá antes desta aqui funcionar."
                ),
            )
        raise HTTPException(
            status_code=502,
            detail=f"Produção respondeu algo que não é JSON em {endpoint}.",
        )


@app.get("/social-export")
def social_export(token: str = ""):
    """Production side of the social sync, anonymised before it leaves.

    Same token gate as /catalog-export, and the same 404-when-unset
    behaviour: with CATALOG_SYNC_TOKEN missing this looks like it was
    never deployed.

    The scrubbing happens in db.export_social, on this side, on purpose.
    Real names, emails and photos never travel and never sit in a
    response body — anonymising on the staging side would mean the real
    data made the trip and only got cleaned on arrival, which protects
    nobody. The token doubles as the pseudonym salt, so the same person
    maps to the same fake person on every pull and staging's graph lines
    up instead of piling up.

    The founder's own row passes through untouched, so they can sign
    into staging as themselves and appear in the graph they're testing.
    That's their data and their call; nobody else is in that position.
    """
    if not settings.catalog_sync_token:
        raise HTTPException(status_code=404, detail="Not found")
    if not secrets.compare_digest(token, settings.catalog_sync_token):
        raise HTTPException(status_code=404, detail="Not found")
    return db.export_social(
        salt=settings.catalog_sync_token,
        keep_real=(settings.founder_email,),
    )


@app.post("/admin/sync-social")
def admin_sync_social(requesting_email: str = ""):
    """Staging side. Replaces this environment's social graph with
    production's anonymised one.

    Founder-only, a step up from sync-catalog's curator gate: this drops
    every user, friendship, channel and RSVP in the environment before
    writing. The catalog sync is additive and recoverable by re-running
    it; this one is not.

    Direction is enforced twice, which is deliberate for something whose
    wrong direction would overwrite production's users:

      1. env_name must not be "production" — and it DEFAULTS to
         "production", so a service with the variable missing refuses
         rather than importing over real people.
      2. db.import_social refuses a payload not marked anonymised, so a
         misconfigured origin isn't enough on its own.

    There is no staging-to-production path, and adding one would mean
    writing an endpoint that doesn't exist.
    """
    _require_founder(requesting_email)
    if settings.env_name == "production":
        raise HTTPException(
            status_code=400,
            detail="Sync só roda fora da produção — é ela que é a fonte.",
        )
    if not settings.catalog_sync_token:
        raise HTTPException(
            status_code=400,
            detail="CATALOG_SYNC_TOKEN não configurado neste serviço.",
        )

    url = f"{settings.catalog_sync_origin.rstrip('/')}/social-export"
    try:
        resp = httpx.get(url, params={"token": settings.catalog_sync_token}, timeout=120.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Não consegui falar com a produção: {e}")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Produção respondeu {resp.status_code} — token errado ou origem errada?",
        )
    payload = _sync_payload_or_502(resp, "/social-export")

    try:
        counts = db.import_social(payload)
    except ValueError as e:
        # The anonymised guard. A 400 rather than a 500: nothing broke,
        # we refused.
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.exception("Social sync: import_social falhou")
        raise HTTPException(status_code=500, detail=f"Import falhou: {type(e).__name__}: {e}")

    log.info(f"Social sync de {settings.catalog_sync_origin}: {counts}")
    return {
        "ok": True,
        "source": settings.catalog_sync_origin,
        "anonymised": True,
        "kept_real": payload.get("kept_real") or [],
        **counts,
    }


@app.post("/admin/sync-catalog")
def admin_sync_catalog(requesting_email: str = "", event_limit: int = 5000):
    """Staging side. Pulls production's catalog and upserts it here.

    Blocked in production — env_name defaults to "production" when the
    var is missing, so an unconfigured service refuses rather than
    importing something over the real catalog.
    """
    _require_curator(requesting_email)
    if settings.env_name == "production":
        raise HTTPException(
            status_code=400,
            detail="Sync só roda fora da produção — é ela que é a fonte.",
        )
    if not settings.catalog_sync_token:
        raise HTTPException(
            status_code=400,
            detail="CATALOG_SYNC_TOKEN não configurado neste serviço.",
        )

    url = f"{settings.catalog_sync_origin.rstrip('/')}/catalog-export"
    try:
        resp = httpx.get(
            url,
            params={"token": settings.catalog_sync_token, "event_limit": event_limit},
            timeout=120.0,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Não consegui falar com a produção: {e}")
    if resp.status_code == 404:
        # 404 is also what a bad token returns, so say both.
        raise HTTPException(
            status_code=502,
            detail="Produção respondeu 404 — token errado, ou ainda sem CATALOG_SYNC_TOKEN lá.",
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Produção respondeu {resp.status_code}")
    # This app has no real 404 for an unknown route — the SPA fallback
    # (spa_fallback, below) matches anything unmatched and serves
    # index.html with a plain 200. So a route that doesn't exist YET on
    # production (this endpoint shipped to dev/staging first; production
    # only gets it once dev merges into main) looks like success until
    # you look at what came back. Catch that specific case by content
    # type instead of leaving it to a bare JSON-parse error.
    if "html" in resp.headers.get("content-type", "").lower():
        raise HTTPException(
            status_code=502,
            detail=(
                "Produção respondeu a página do site, não o catálogo — "
                "ela ainda não tem o endpoint /catalog-export. Precisa "
                "sair o release (dev → main) antes do sync funcionar."
            ),
        )

    payload = _sync_payload_or_502(resp, "/catalog-export")

    try:
        result = db.import_catalog(payload)
    except Exception as e:
        # import_catalog already catches per-row sqlite errors into
        # `skipped` — this is the backstop for whatever it didn't
        # anticipate. First run against the real catalog hit exactly
        # that: an uncaught exception here used to surface as a bodyless
        # HTTP 500 (FastAPI's default handler for anything it didn't
        # expect), which the frontend could only report as "HTTP 500" —
        # true, but useless. Log the real trace for Railway and hand the
        # client a message worth reading.
        log.exception("Catalog sync: import_catalog falhou")
        raise HTTPException(status_code=500, detail=f"Import falhou: {type(e).__name__}: {e}")

    log.info(
        f"Catalog sync de {settings.catalog_sync_origin}: "
        f"{result['events']} eventos, {result['venues']} locais, "
        f"{result['ig_accounts']} @s, {len(result['skipped'])} ignorados"
    )
    return {"ok": True, "source": settings.catalog_sync_origin, **result}



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


# Coordinate formats a curator can paste. The workflow this exists for:
# find the place in Google Maps, right-click, "copiar coordenadas" — or
# just copy the URL out of the address bar. Asking someone to pull two
# floats out of a URL by hand is how a pin ends up with the longitude in
# the latitude field.
#
# Parsed on the backend rather than in the sheet because this is all
# edge cases, and the repo's tests are pytest — there is no JS unit
# runner (only eslint + Playwright), so a frontend parser would ship
# untested.
#
# Deliberately NOT supported: Brazilian decimal commas ("-25,42, -49,27").
# The comma is also the pair separator, so "-25,42,-49,27" is genuinely
# ambiguous and guessing wrong puts the pin in another state.
_COORD_PAIR = r"(-?\d{1,3}\.\d+)"
_COORD_PATTERNS = (
    # Place pin in a Maps URL (.../data=...!3d-25.42!4d-49.27). This is
    # the place itself, so it beats the viewport center below.
    re.compile(rf"!3d{_COORD_PAIR}!4d{_COORD_PAIR}"),
    # Explicit query: ?q=lat,lng / ?query=lat,lng / ?ll=lat,lng
    re.compile(rf"[?&](?:q|query|ll)={_COORD_PAIR}%2C\s*{_COORD_PAIR}", re.IGNORECASE),
    re.compile(rf"[?&](?:q|query|ll)={_COORD_PAIR},\s*{_COORD_PAIR}", re.IGNORECASE),
    # Viewport center (.../@-25.42,-49.27,17z) — the map's center, which
    # is close enough when there's no place pin in the URL.
    re.compile(rf"@{_COORD_PAIR},{_COORD_PAIR}"),
    # Bare "lat, lng", which is what "copiar coordenadas" puts on the
    # clipboard. Anchored so a longer string doesn't match by accident.
    re.compile(rf"^\s*{_COORD_PAIR}\s*,\s*{_COORD_PAIR}\s*$"),
)


def _parse_coords_text(text: str) -> Optional[tuple[float, float]]:
    """Pull (lat, lng) out of pasted text — a Google Maps URL or a bare
    "lat, lng" pair. None when nothing parses.

    Range-checks only what's universally true (lat +-90, lng +-180); the
    caller applies the Curitiba bounds, so the error a curator sees for a
    pin in the wrong city says that, not "invalid format"."""
    raw = (text or "").strip()
    if not raw:
        return None
    for pattern in _COORD_PATTERNS:
        m = pattern.search(raw)
        if not m:
            continue
        lat, lng = float(m.group(1)), float(m.group(2))
        if -90 <= lat <= 90 and -180 <= lng <= 180:
            return lat, lng
    return None


class VenueUpdateRequest(BaseModel):
    requesting_email: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    address: Optional[str] = None  # when set, persisted for future Nominatim retries
    # A pasted Google Maps URL or "lat, lng" pair, parsed server-side.
    # Takes precedence over lat/lng when both arrive — a curator who
    # pasted something meant that, not whatever was in the fields.
    coords_text: Optional[str] = None


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
    lat, lng = req.lat, req.lng
    # A pasted URL/pair wins over the numeric fields — see coords_text.
    if (req.coords_text or "").strip():
        parsed = _parse_coords_text(req.coords_text)
        if not parsed:
            raise HTTPException(
                status_code=400,
                detail="Não consegui ler as coordenadas. Cole o link do Google Maps ou \"-25.42, -49.27\".",
            )
        lat, lng = parsed
    if (lat is None) != (lng is None):
        raise HTTPException(status_code=400, detail="lat and lng must both be provided or both omitted")
    if lat is not None:
        # Sanity check — Curitiba lives roughly between (-25.7, -49.5)
        # and (-25.2, -49.0). Accepting anything in Brazil's lat range
        # would drop pins on the wrong continent if a typo creeps in.
        if not (-26.5 <= lat <= -24.5 and -50.5 <= lng <= -48.0):
            raise HTTPException(
                status_code=400,
                detail="Coordenadas fora da região de Curitiba — verifica antes de salvar",
            )
    ok = db.update_venue_manual(
        name_normalized=name_normalized,
        lat=lat, lng=lng,
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


@app.post("/admin/diag/rsvp-prune-orphans")
def admin_rsvp_prune_orphans(requesting_email: str = "", dry_run: bool = True):
    """Delete rsvps rows whose event_id no longer matches any row in the
    events table OR group_events table — left over from sources we
    dropped (Sympla, Catraca Livre, etc. in the April 2026 cleanup) or
    catalog events that aged out. Default dry_run=true so callers can
    inspect counts before committing."""
    _require_founder(requesting_email)
    with db.get_conn() as conn:
        rsvp_ids = [r["event_id"] for r in conn.execute(
            "SELECT DISTINCT event_id FROM rsvps"
        ).fetchall()]
        if not rsvp_ids:
            return {"orphans": 0, "deleted": 0, "dry_run": dry_run, "sample": []}
        ph = ",".join("?" * len(rsvp_ids))
        live_catalog = {r["id"] for r in conn.execute(
            f"SELECT id FROM events WHERE id IN ({ph})", rsvp_ids,
        ).fetchall()}
        live_group = {r["id"] for r in conn.execute(
            f"SELECT id FROM group_events WHERE id IN ({ph})", rsvp_ids,
        ).fetchall()}
        live = live_catalog | live_group
        orphans = [eid for eid in rsvp_ids if eid not in live]
        sample_rows: list[dict] = []
        for eid in orphans[:10]:
            row = conn.execute(
                "SELECT event_name, event_date FROM rsvps WHERE event_id = ? LIMIT 1",
                (eid,),
            ).fetchone()
            sample_rows.append({
                "event_id": eid,
                "event_name": (row["event_name"] if row else "") or "",
                "event_date": (row["event_date"] if row else "") or "",
            })
        deleted = 0
        if not dry_run and orphans:
            o_ph = ",".join("?" * len(orphans))
            cur = conn.execute(
                f"DELETE FROM rsvps WHERE event_id IN ({o_ph})", orphans,
            )
            deleted = cur.rowcount or 0
            conn.commit()
    return {
        "orphans": len(orphans),
        "deleted": deleted,
        "dry_run": dry_run,
        "sample": sample_rows,
    }


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


@app.post("/admin/sympla/enrich")
def admin_sympla_enrich(requesting_email: str = "", max_pages: int = 60):
    """Founder-only: walk Sympla's CWB discovery feed, parse each event
    page, and attach matching catalog events with a `sympla_url` for the
    "🎟️ Comprar ingresso" CTA. Idempotent — already-matched events stay
    as-is unless the Sympla URL changes. Cap `max_pages` to bound runtime."""
    _require_founder(requesting_email)
    from scrapers.sympla import fetch_curitiba_events
    from sympla_match import match_and_enrich
    sympla_events = fetch_curitiba_events(max_pages=max_pages)
    return match_and_enrich(sympla_events)


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


class CatalogRequestDecision(BaseModel):
    requesting_email: str
    # Curator edits applied before publishing. Omitted = keep what was sent.
    name: Optional[str] = None
    description: Optional[str] = None
    venue_name: Optional[str] = None
    date_start: Optional[str] = None
    image_url: Optional[str] = None
    # Also start scraping this post's account daily.
    track_handle: bool = False
    note: str = ""


def _reviewer_name(email: str) -> str:
    """Name to show for the curator who resolved a request.

    Every curator gets the same push, so the others will open requests that
    are already decided. Reviews are recorded by email — that's how curator
    roles are granted — but "já aprovado por ana.souza@gmail.com" reads like
    a log line; they should see a person. Falls back to the part before the
    @ when that curator has never signed into the app.
    """
    email = (email or "").strip().lower()
    if not email:
        return ""
    ids = db.user_ids_for_emails([email])
    name = _user_display_name(ids[0]) if ids else ""
    if name and name != "Alguém":
        return name
    return email.split("@")[0]


def _catalog_request_out(row: dict) -> dict:
    handle = (row.get("ig_handle") or "").lower()
    return {
        "id": row["id"],
        "status": row["status"],
        "name": row["name"],
        "description": row["description"],
        "venue_name": row["venue_name"],
        "date_start": row["date_start"],
        "url": row["url"],
        "image_url": row.get("image_url") or "",
        "ig_handle": handle,
        "handle_tracked": bool(handle) and handle in _enabled_ig_handles(),
        "submitted_by_name": _user_display_name(row["submitted_by"]) if row.get("submitted_by") else "",
        "created_at": row["created_at"],
        "reviewed_by": row.get("reviewed_by") or "",
        "reviewed_by_name": _reviewer_name(row.get("reviewed_by") or ""),
        "reviewed_at": row.get("reviewed_at") or "",
        "catalog_event_id": row.get("enriched_event_id") or "",
    }


@app.get("/admin/catalog-requests")
def admin_list_catalog_requests(requesting_email: str = "", status: str = "review"):
    """Catalog suggestions waiting for (or past) curator review."""
    _require_curator(requesting_email)
    if status not in ("review", "approved", "rejected"):
        raise HTTPException(status_code=400, detail="status inválido")
    return {"requests": [_catalog_request_out(r) for r in db.list_catalog_requests(status)]}


@app.get("/admin/catalog-requests/{request_id}")
def admin_get_catalog_request(request_id: int, requesting_email: str = ""):
    _require_curator(requesting_email)
    row = db.get_catalog_request(request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Pedido não encontrado")
    return _catalog_request_out(row)


@app.post("/admin/catalog-requests/{request_id}/approve")
def admin_approve_catalog_request(request_id: int, req: CatalogRequestDecision,
                                  background_tasks: BackgroundTasks):
    """Publish a suggested post to the catalog, with the curator's edits,
    and optionally start tracking its account."""
    curator = _require_curator(req.requesting_email)
    row = db.get_catalog_request(request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Pedido não encontrado")
    if row["status"] != "review":
        raise HTTPException(status_code=409, detail="Esse pedido já foi resolvido.")
    edits = {
        "name": req.name, "description": req.description,
        "venue_name": req.venue_name, "date_start": req.date_start,
        "image_url": req.image_url,
    }
    row = db.update_catalog_request(request_id, edits) or row
    name = (row["name"] or "").strip()
    ds = _parse_submission_date(row["date_start"])
    if len(name) < 3 or not ds:
        raise HTTPException(status_code=400, detail="Nome e data válidos são obrigatórios pra publicar.")

    shortcode = row.get("shortcode") or _ig_shortcode(row["url"])
    event_id = _catalog_event_id_for(shortcode)
    # Claim the request first: the conditional update is what stops two
    # curators publishing the same request at the same moment.
    if not db.resolve_catalog_request(request_id, "approved", curator,
                                      catalog_event_id=event_id, note=req.note):
        raise HTTPException(status_code=409, detail="Outro curador acabou de resolver esse pedido.")
    try:
        image = ""
        if row.get("image_url") and _is_allowed_submission_image(event_id, row["image_url"]):
            image = image_store.rehost_image(event_id, row["image_url"]) or row["image_url"]
        ev = _build_catalog_event(
            event_id=event_id, external_id=f"igpost_{shortcode}", name=name,
            description=row["description"], venue_name=row["venue_name"],
            date_start=ds, url=row["url"], image_url=image,
        )
        db.upsert_event(ev)
    except Exception as exc:
        db.reopen_catalog_request(request_id)
        log.error(f"Catalog request {request_id}: publish failed: {exc}")
        raise HTTPException(status_code=500, detail="Não consegui publicar. O pedido voltou pra fila.")

    if row.get("group_event_id"):
        db.set_group_event_source(row["group_event_id"], event_id)

    tracked = False
    handle = (row.get("ig_handle") or "").lower()
    if req.track_handle and handle:
        known = {a["handle"].lower(): a for a in db.list_ig_accounts()}
        if handle not in known:
            # Only ever insert. An account that already exists (even if a
            # curator disabled it) keeps its label, category and state.
            db.upsert_ig_account(
                handle=handle, enabled=True, added_by_email=curator,
                notes=f"Adicionado ao aprovar o pedido #{request_id}",
            )
            _bust_handle_cache()
            tracked = True
        else:
            tracked = bool(known[handle].get("enabled"))

    background_tasks.add_task(_enrich_catalog_event, ev)
    if row.get("submitted_by"):
        background_tasks.add_task(
            _send_push_to_user, row["submitted_by"], "✅ No catálogo",
            f"{name} entrou no catálogo do auê", _event_deep_link(event_id),
            f"catalog-approved-{request_id}",
        )
    return {"ok": True, "catalog_event_id": event_id, "handle_tracked": tracked}


@app.post("/admin/catalog-requests/{request_id}/reject")
def admin_reject_catalog_request(request_id: int, req: CatalogRequestDecision):
    """Turn a suggestion down. The private event is untouched, and the same
    post can be suggested again later. No push to the person who suggested
    it — auê doesn't tell people their plans weren't good enough."""
    curator = _require_curator(req.requesting_email)
    if not db.get_catalog_request(request_id):
        raise HTTPException(status_code=404, detail="Pedido não encontrado")
    if not db.resolve_catalog_request(request_id, "rejected", curator, note=req.note):
        raise HTTPException(status_code=409, detail="Esse pedido já foi resolvido.")
    return {"ok": True}


@app.post("/admin/submissions/backfill-images")
async def admin_backfill_submission_images(requesting_email: str = "", dry_run: bool = True):
    """Give already-saved submitted events the post image they should have
    had. Submissions never carried an image until the form started sending
    one, so existing rows only have the Instagram post link.

    For each submitted event with no image and an instagram.com/p|reel link,
    re-reads the post via Apify (one call per distinct link — duplicate
    submissions of the same post share it) and rehosts displayUrl. Founder-
    only: it spends Apify credit and rewrites payloads. dry_run (default)
    reports candidates without scraping or writing.
    """
    _require_founder(requesting_email)
    candidates: dict[str, list[tuple[str, dict]]] = {}
    with db.get_conn() as conn:
        rows = conn.execute("SELECT id, payload FROM events WHERE source = 'submitted'").fetchall()
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except (json.JSONDecodeError, TypeError):
            continue
        if payload.get("image_url"):
            continue
        link = (payload.get("url") or "").split("?")[0].rstrip("/")
        if not re.search(r"instagram\.com/(p|reel)/[A-Za-z0-9_-]+$", link):
            continue
        candidates.setdefault(link, []).append((r["id"], payload))

    report = {
        "dry_run": dry_run,
        "posts": len(candidates),
        "events": sum(len(v) for v in candidates.values()),
        "results": [],
    }
    if dry_run or not candidates:
        report["results"] = [{"url": u, "event_ids": [e for e, _ in evs]} for u, evs in candidates.items()]
        return report
    if not settings.apify_api_token:
        raise HTTPException(status_code=503, detail="Apify not configured")

    from scrapers.instagram_apify import _run_apify_scrape
    for link, evs in candidates.items():
        posts = await _run_apify_scrape(settings.apify_api_token, [link + "/"], posts_per_account=1)
        display = (posts[0].get("displayUrl") if posts else None) or ""
        for event_id, payload in evs:
            image = await _rehost_submission_image(event_id, display) if display else None
            if image:
                payload["image_url"] = image
                with db.get_conn() as conn:
                    conn.execute("UPDATE events SET payload = ? WHERE id = ?", (json.dumps(payload), event_id))
                    conn.commit()
            report["results"].append({"event_id": event_id, "image_url": image, "found_post": bool(posts)})
    return report


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
        "User-Agent": f"aue-curitiba-events/1.0 ({settings.public_origin})",
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


@app.get("/admin/users")
def admin_users(requesting_email: str = "", limit: int = 200, offset: int = 0,
                sort: str = "last_seen", q: str = ""):
    """Founder-only: every user with their activity counts. The dashboard
    could only show the last ten logins, which answered "who showed up
    recently" but never "who are these people and what do they do"."""
    _require_founder(requesting_email)
    return db.get_user_directory(limit=min(limit, 500), offset=max(offset, 0), sort=sort, query=q)


@app.get("/admin/group-stats")
def admin_group_stats(requesting_email: str = ""):
    """Founder-only: whether the groups that exist have members and
    events, or were created and abandoned. See db.get_group_composition."""
    _require_founder(requesting_email)
    return db.get_group_composition()


@app.get("/admin/client-errors")
def admin_client_errors(requesting_email: str = "", limit: int = 50):
    """Founder-only: client_error:* rows grouped by (type, message), with
    count/first-seen/last-seen/a sample url+user per group. See
    db.get_client_error_summary."""
    _require_founder(requesting_email)
    return {"errors": db.get_client_error_summary(limit=min(limit, 200))}


@app.get("/admin/weekly-summary")
def admin_weekly_summary(requesting_email: str = ""):
    """Founder-only: return the past-7-days vs prior-7-days activity
    snapshot. Same payload the Monday 10am scheduler emails. Founders
    can call this any time to peek at the current numbers."""
    _require_founder(requesting_email)
    return db.get_weekly_summary()


@app.post("/admin/weekly-summary/send")
async def admin_weekly_summary_send(requesting_email: str = ""):
    """Founder-only: trigger the weekly summary email immediately
    instead of waiting for the Monday 10am cron. Useful for proofing
    template changes or sending an out-of-band digest."""
    _require_founder(requesting_email)
    from scheduler import run_weekly_summary
    await run_weekly_summary(settings)
    return {"ok": True, "to": settings.founder_email}


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
# VAPID key pair — read from env so production secrets aren't committed.
# Generate with: py -m py_vapid --gen
# Then set:  VAPID_PRIVATE_KEY=...  VAPID_PUBLIC_KEY=...  VAPID_CLAIMS_SUB=mailto:you@host
# When unset, push functions silently no-op (logged once per process boot).
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
VAPID_PUBLIC_KEY  = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
VAPID_CLAIMS = {"sub": os.environ.get("VAPID_CLAIMS_SUB", "mailto:admin@aue.app")}
if not (VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY):
    log.warning(
        "VAPID keys not configured — push notifications will no-op. "
        "Generate with `py -m py_vapid --gen` and set VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY env vars."
    )


class PushSubscriptionBody(BaseModel):
    endpoint: str
    keys: dict
    google_id: str = ""  # links the subscription to a logged-in user


@app.post("/push/subscribe")
def push_subscribe(body: PushSubscriptionBody):
    """Store or update a Web Push subscription from the browser. The
    google_id, when present, lets us send per-user pushes (group events,
    friend RSVPs) — anonymous subs only receive the daily digest."""
    db.upsert_push_subscription(body.endpoint, json.dumps(body.keys), body.google_id)
    log.info(f"Push subscription saved (user={body.google_id or 'anon'}): {body.endpoint[:60]}…")
    return {"status": "subscribed"}


class PushUnsubscribeBody(BaseModel):
    endpoint: str


@app.delete("/push/subscribe")
def push_unsubscribe(body: PushUnsubscribeBody):
    """Drop a subscription from the DB. Called by the client right after
    pushManager.unsubscribe() so we don't keep firing pushes against an
    endpoint that's already dead. Backend also self-prunes on 410 Gone,
    so this is best-effort cleanup, not strict correctness."""
    db.delete_push_subscription_by_endpoint(body.endpoint)
    return {"status": "unsubscribed"}


class ApnsRegisterBody(BaseModel):
    token: str            # APNs device token (hex, 64 chars)
    google_id: str = ""   # links to a logged-in user (anonymous = "")
    bundle_id: str = ""   # iOS app bundle id, used for cross-app safety
    env: str = "production"  # "production" (TestFlight/App Store) or "sandbox" (Xcode debug)


@app.post("/push/register-device-token")
def push_register_device_token(body: ApnsRegisterBody):
    """Store an iOS APNs device token. The Capacitor PushNotifications
    plugin emits the hex token via its `registration` event after the
    user grants permission; the JS hook POSTs it here.

    Tokens are unique per (device, app, install) — re-installing the app
    yields a new token, so the upsert key is the token itself, not
    google_id (a single user can also have multiple devices: iPhone +
    iPad)."""
    db.upsert_apns_token(body.token, body.google_id, body.bundle_id, body.env)
    log.info(f"APNs token saved (user={body.google_id or 'anon'}, env={body.env}): {body.token[:16]}…")
    return {"status": "registered"}


class ApnsUnregisterBody(BaseModel):
    token: str


@app.delete("/push/register-device-token")
def push_unregister_device_token(body: ApnsUnregisterBody):
    """Drop an APNs token (e.g. user toggled push off in Profile)."""
    db.delete_apns_token(body.token)
    return {"status": "unregistered"}


# ── Per-user push helper ─────────────────────────────────
# Sends a structured payload (title/body/url/tag) to every device the
# user has registered, across both push channels:
#   - Web Push (browser PWA, including iOS Safari "Add to Home Screen"
#     standalone), via VAPID + pywebpush. The custom Service Worker
#     parses the JSON and shows a rich notification.
#   - APNs (iOS native via Capacitor), via JWT-authed HTTP/2 to
#     api.push.apple.com. The Capacitor PushNotifications plugin emits
#     a JS event on tap, the frontend reads `url` and navigates the SPA.
# Dead endpoints/tokens are pruned lazily on the corresponding error
# codes. Both fanouts run regardless of which channels the user has —
# missing channels short-circuit cheaply.
def _send_push_to_user(
    google_id: str,
    title: str,
    body: str,
    url: str = "/",
    tag: str = "default",
) -> int:
    """Returns total devices (web + APNs) that received the push."""
    if not google_id:
        return 0
    sent = _send_webpush_to_user(google_id, title, body, url, tag)
    sent += _send_apns_to_user(google_id, title, body, url, tag)
    return sent


def _send_webpush_to_user(google_id: str, title: str, body: str,
                           url: str, tag: str) -> int:
    """Browser PWA channel — VAPID + pywebpush."""
    subs = db.get_push_subscriptions_for_user(google_id)
    if not subs:
        return 0
    if not (VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY):
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
                log.warning(f"webpush to {google_id} failed ({status}): {exc}")
        except Exception as exc:
            log.warning(f"webpush to {google_id} errored: {exc}")
    return sent


def _send_apns_to_user(google_id: str, title: str, body: str,
                       url: str, tag: str) -> int:
    """iOS native channel — APNs HTTP/2 with token-based JWT auth."""
    tokens = db.get_apns_tokens_for_user(google_id)
    if not tokens:
        return 0
    try:
        from apns import send_to_token as apns_send
    except ImportError:
        return 0
    sent = 0
    for t in tokens:
        ok, reason = apns_send(t["token"], title, body, url=url, tag=tag)
        if ok:
            sent += 1
        elif reason and ("BadDeviceToken" in reason or "Unregistered" in reason or reason.startswith("410")):
            db.delete_apns_token(t["token"])
        elif reason:
            log.warning(f"apns to {google_id} failed: {reason}")
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


def _friend_cares_about_event(friend_google_id: str, event_id: str) -> bool:
    """True iff the friend has skin in the event — they've RSVPed, are
    on the invitee list of a private event, or are creator/co-host of one.

    Used to gate the friend-RSVP push so it only fires for events the
    recipient was already considering. Without this, every popular friend
    spams their whole network on each catalog RSVP.
    """
    if not friend_google_id or not event_id:
        return False
    if db.rsvp_exists(friend_google_id, event_id):
        return True
    private = db.get_group_event(event_id)
    if private:
        if private.get("created_by") == friend_google_id:
            return True
        if friend_google_id in (private.get("co_host_ids") or []):
            return True
        if friend_google_id in (private.get("extra_invitee_ids") or []):
            return True
    return False


def _user_daily_digest_opted_in(google_id: str) -> bool:
    """Default ON. User toggles off in Profile (privacy.dailyDigest = false)."""
    if not google_id:
        return True  # anonymous subscribers — no UI to toggle, default in
    state = db.get_user_state(google_id) or {}
    privacy = state.get("privacy") or {}
    if "dailyDigest" in privacy:
        return bool(privacy["dailyDigest"])
    return True


async def send_event_reminders_for_tomorrow() -> dict:
    """Day-before reminder for everything you've RSVP'd to.

    The README has promised this since launch and it never existed — the
    app notified you when a friend RSVP'd, when you were invited, when
    the catalog found something new, but never that the thing you already
    committed to is happening. For a group of friends coordinating a
    night out, that is the notification that actually earns its place.

    A day before rather than hours before, deliberately: the useful
    window is while you can still move something in your calendar, buy a
    ticket, or arrange a ride — not ninety minutes out when the answer is
    already yes or no.

    Runs once daily and covers every event dated tomorrow, so a single
    cron tick handles a whole day. Reuses the digest opt-out — someone
    who muted notifications shouldn't get these either — and the
    sent_reminders table makes the whole thing idempotent.
    """
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("America/Sao_Paulo")
    tomorrow = (datetime.now(tz).date() + timedelta(days=1)).isoformat()

    rows = db.get_rsvps_for_day(tomorrow)
    if not rows:
        log.info(f"Reminders: nothing on {tomorrow}")
        return {"date": tomorrow, "candidates": 0, "sent": 0}

    sent = skipped = 0
    for r in rows:
        gid, eid = r.get("google_id"), r.get("event_id")
        if not gid or not eid:
            continue
        if db.reminder_already_sent(gid, eid):
            skipped += 1
            continue
        if not _user_daily_digest_opted_in(gid):
            skipped += 1
            continue
        name = (r.get("event_name") or "seu rolê").strip()
        venue = (r.get("event_venue") or "").strip()
        when = _reminder_time_label(r.get("event_date") or "")
        body = name + (f" · {venue}" if venue else "") + (f" · {when}" if when else "")
        try:
            _send_push_to_user(
                gid,
                title="⏰ Amanhã!",
                body=body,
                url=_event_deep_link(eid),
                tag=f"reminder-{eid}",
            )
            # Mark even when zero devices were reached: the user has no
            # push channel registered, and re-trying tomorrow would send
            # a "tomorrow!" for an event happening today.
            db.mark_reminder_sent(gid, eid)
            sent += 1
        except Exception as exc:
            log.warning(f"Reminder for {eid} → {gid} failed: {exc}")

    log.info(f"Reminders for {tomorrow}: {sent} sent, {skipped} skipped")
    return {"date": tomorrow, "candidates": len(rows), "sent": sent, "skipped": skipped}


def _reminder_time_label(date_iso: str) -> str:
    """"21:00" from an ISO timestamp; empty when the row has date only."""
    raw = (date_iso or "").strip()
    if "T" not in raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return ""
    return dt.strftime("%H:%M")


def _digest_deep_link(digest_id: str) -> str:
    """The URL a digest push points at.

    /novidades/:digestId is a real route (shipped alongside this function)
    that survives a refresh, unlike the old ?digest= query param the app
    stripped on read. Gated behind an env var rather than switched
    outright: phones run whatever JS bundle they last downloaded, and an
    old bundle has no route for /novidades — it'd fall through to the
    default screen. Flip DIGEST_URL_NOVIDADES=true once the OTA rollout
    has had time to reach production devices (see docs/NEXT.md item 3)."""
    if os.environ.get("DIGEST_URL_NOVIDADES", "false").strip().lower() == "true":
        return f"/#/novidades/{digest_id}"
    return f"/#/events?digest={digest_id}"


async def send_daily_digest_to_all_subscribers(
    new_event_ids: list[str] | None,
    *,
    ignore_quiet_hours: bool = False,
) -> dict:
    """Fanout the daily "novidades hoje" push after the catalog refresh,
    across both push channels:
      - Web Push subscribers (browser PWA / iOS Safari standalone)
      - APNs device tokens (iOS native via Capacitor / TestFlight)

    Replaces the old weekly broadcast — that one was generic ("vai junto?")
    and risked broadcast-fatigue. This version pulls the events from
    today's scrape and tells each subscriber "X novos — Tributo Bowie ·
    Pedreira · +2 mais", with the tap routed to the top event hero.

    Quiet hours (22:00–09:00 Curitiba, quiet_hours.py): the ids are parked
    and the 09:00 job sends them. Outside quiet hours anything still parked
    rides along — covers a 09:00 run missed because the container was down.

    Skipped silently when:
      - No new events from this scrape (would be a noise push)
      - No subscribers on either channel
      - User toggled off via privacy.dailyDigest = false
    """
    if not ignore_quiet_hours and quiet_hours.is_quiet():
        if new_event_ids:
            db.defer_digest_events(list(new_event_ids))
        return {"sent": 0, "skipped": 0, "reason": "quiet hours",
                "deferred": len(new_event_ids or [])}
    parked = db.take_deferred_digest_events()
    if parked:
        new_event_ids = list(dict.fromkeys(parked + list(new_event_ids or [])))
    if not new_event_ids:
        return {"sent": 0, "skipped": 0, "reason": "no new events"}

    new_events_raw = db.get_events_by_ids(list(new_event_ids))
    if not new_events_raw:
        return {"sent": 0, "skipped": 0, "reason": "events not in DB"}

    # Parse + filter to events with names. Sort by date_start ASC so the
    # soonest-happening events lead the body — that's the hook ("Tributo
    # Bowie HOJE 21h" beats "show genérico daqui 3 semanas").
    #
    # ev["id"] is the internal SQLite id — the same key /events/{id} uses
    # to look events up. ev["external_id"] is the source-scoped key (like
    # "ig_terno_rei_post123") and would 404 the deep link, surfacing the
    # frontend's "não está mais no catálogo" fallback instead of opening
    # the hero. Past bug — left this comment so it doesn't come back.
    parsed = []
    for ev in new_events_raw:
        try:
            payload = json.loads(ev["payload"])
        except (json.JSONDecodeError, TypeError):
            continue
        name = (payload.get("name") or "").strip()
        if not name:
            continue
        parsed.append({
            "id": ev["id"],
            "name": name,
            "date_start": payload.get("date_start") or "",
        })
    if not parsed:
        return {"sent": 0, "skipped": 0, "reason": "no parseable events"}
    parsed.sort(key=lambda e: e.get("date_start") or "9999")

    n = len(parsed)
    preview = " · ".join(e["name"][:38] for e in parsed[:3])
    if n > 3:
        preview += f" · +{n - 3} mais"
    title = f"✨ {n} novo{'s' if n != 1 else ''} em CWB"
    # Persist the full digest set in the daily_digests table and put
    # only the small digest_id in the push payload. The app fetches
    # the full list of event_ids on tap via /digests/{id}. This avoids
    # the APNs 4KB / web push 3KB payload cap that would otherwise
    # force a hard limit on N (was capped at 12 — too restrictive when
    # a scrape lands 30+ events).
    digest_id = f"d_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}"
    db.insert_daily_digest(digest_id, [e["id"] for e in parsed])
    url = _digest_deep_link(digest_id)
    tag = "daily-digest"

    web_subs = db.get_all_push_subscriptions()
    apns_tokens = db.get_all_apns_tokens()
    if not web_subs and not apns_tokens:
        return {"sent": 0, "skipped": 0, "reason": "no subscribers"}

    # Group both channels by google_id so opt-out runs once per user.
    by_user_web: dict[str, list[dict]] = {}
    for sub in web_subs:
        by_user_web.setdefault(sub.get("google_id") or "", []).append(sub)
    by_user_apns: dict[str, list[dict]] = {}
    for tok in apns_tokens:
        by_user_apns.setdefault(tok.get("google_id") or "", []).append(tok)
    all_users = set(by_user_web) | set(by_user_apns)

    # Lazy imports — keeps endpoint usable even without optional deps.
    # Per-person copy, because the interesting part of this push is not
    # how many events the city got — it's how many came from a channel
    # you chose. That number is different for everyone, so the payload
    # can't be built once and reused.
    #
    # This replaces the separate 20:00 channel digest. Two daily pushes
    # about the same events, one saying "23 novos em CWB" and the other
    # "3 rolês novos no Rockzão", is the app telling you the same news
    # twice and making you reconcile it.
    picks_by_user = db.channel_picks_by_follower([e["id"] for e in parsed])

    def _copy_for(google_id: str) -> tuple[str, str]:
        """Headline the part this person chose; keep the city in the body."""
        picks = picks_by_user.get(google_id) or {}
        mine = sum(picks.values())
        if not mine:
            return title, preview
        if len(picks) == 1:
            channel = next(iter(picks))
            head = f"✨ {mine} novo{'s' if mine != 1 else ''} no {channel}"
        else:
            # Three channel names in a notification is a list, not a
            # headline — the names are on the screen it opens.
            head = f"✨ {mine} dos teus {len(picks)} canais"
        return head, f"+{n} novos em CWB hoje · {preview}"

    try:
        from pywebpush import webpush, WebPushException
        has_pywebpush = True
    except ImportError:
        has_pywebpush = False

    try:
        from apns import send_to_token as apns_send, _is_configured as apns_configured
        has_apns = apns_configured()
    except ImportError:
        has_apns = False

    sent = 0
    skipped = 0
    failed = 0
    for google_id in all_users:
        if not _user_daily_digest_opted_in(google_id):
            skipped += len(by_user_web.get(google_id, []))
            skipped += len(by_user_apns.get(google_id, []))
            continue
        u_title, u_body = _copy_for(google_id)
        web_payload = json.dumps(
            {"title": u_title, "body": u_body, "url": url, "tag": tag}
        )
        # Web push channel
        if has_vapid and has_pywebpush:
            for sub in by_user_web.get(google_id, []):
                try:
                    webpush(
                        subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
                        data=web_payload,
                        vapid_private_key=VAPID_PRIVATE_KEY,
                        vapid_claims=VAPID_CLAIMS,
                    )
                    sent += 1
                except WebPushException as exc:
                    status = getattr(exc.response, "status_code", None)
                    if status in (404, 410):
                        db.delete_push_subscription_by_endpoint(sub["endpoint"])
                    else:
                        log.warning(f"digest webpush failed ({status}): {exc}")
                    failed += 1
                except Exception as exc:
                    failed += 1
                    log.warning(f"digest webpush errored: {exc}")
        # APNs channel
        if has_apns:
            for tok in by_user_apns.get(google_id, []):
                ok, reason = apns_send(tok["token"], u_title, u_body, url=url, tag=tag)
                if ok:
                    sent += 1
                else:
                    failed += 1
                    if reason and ("BadDeviceToken" in reason or "Unregistered" in reason or reason.startswith("410")):
                        db.delete_apns_token(tok["token"])
                    elif reason:
                        log.warning(f"digest apns failed: {reason}")

    log.info(f"Daily digest: {sent} sent, {skipped} opted-out, {failed} failed (events={n})")
    return {"sent": sent, "skipped": skipped, "failed": failed, "events": n}


class DigestTriggerBody(BaseModel):
    requesting_email: str
    new_event_ids: list[str] = []
    # Founder testing at night: send now instead of parking until 09:00.
    ignore_quiet_hours: bool = False


@app.post("/push/send-daily-digest")
async def push_send_daily_digest(body: DigestTriggerBody):
    """Manual digest trigger — admin/test helper. The scheduler calls
    send_daily_digest_to_all_subscribers() automatically after each
    refresh; this endpoint exists for backfills, dev testing, or
    re-firing on a scrape where the cron didn't catch the event ids."""
    _require_founder(body.requesting_email)
    return await send_daily_digest_to_all_subscribers(
        body.new_event_ids, ignore_quiet_hours=body.ignore_quiet_hours,
    )


async def send_deferred_digest() -> dict:
    """09:00 job: send whatever the night parked. No-op when empty —
    send_daily_digest_to_all_subscribers takes the parked ids itself."""
    return await send_daily_digest_to_all_subscribers([])


# ── Live updates (Capgo self-hosted) ─────────────────────────────────
# Ships the web bundle this container is already serving to installed
# native apps, so a JS-only fix reaches phones in minutes instead of an
# App Review cycle.
#
# DORMANT BY DEFAULT. With OTA_BUNDLE_VERSION unset, /updates/check tells
# every device "nothing new" — which is what the first build ships with.
# The plugin and notifyAppReady() get validated on real hardware through
# TestFlight before a single update is ever offered, and if OTA ever
# misbehaves, unsetting one Railway variable stops it instantly without a
# deploy of the app.
#
# Publishing an update is therefore deliberate: deploy as usual, confirm
# the web build is good, then bump OTA_BUNDLE_VERSION. The bundle served
# is whatever /app/static holds right now, so "publish" means "bless the
# current deploy", and the version is a human decision rather than a
# timestamp that fires on every push.
_OTA_ZIP_CACHE: dict[str, object] = {}


def _ota_main_chunk_name() -> Optional[str]:
    """Filename of the largest JS chunk in the static dir — the main
    bundle. Its hash is content-derived, so comparing it against what
    the site serves confirms a deploy actually landed."""
    if not STATIC_DIR.exists():
        return None
    assets = STATIC_DIR / "assets"
    if not assets.exists():
        return None
    js = [p for p in assets.glob("index-*.js") if p.is_file()]
    if not js:
        return None
    return max(js, key=lambda p: p.stat().st_size).name


def _ota_env() -> tuple[str, str, frozenset[str]]:
    """(published, canary, canary device ids) — see ota.py."""
    return (
        (os.environ.get("OTA_BUNDLE_VERSION") or "").strip(),
        (os.environ.get("OTA_CANARY_VERSION") or "").strip(),
        ota.parse_devices(os.environ.get("OTA_CANARY_DEVICES")),
    )


def _ota_bundle_zip(version: str) -> Optional[bytes]:
    """Zip of the static dir, built once per process and memoized.

    Keyed on the version being served so a redeploy (fresh process) always
    rebuilds, while repeated downloads from many devices don't re-zip.
    """
    version = (version or "").strip()
    if not version or not STATIC_DIR.exists():
        return None
    if _OTA_ZIP_CACHE.get("version") == version:
        return _OTA_ZIP_CACHE.get("data")  # type: ignore[return-value]
    import io as _io
    import zipfile
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(STATIC_DIR.rglob("*")):
            if path.is_file():
                # Paths must be relative to the bundle root — the plugin
                # unpacks this over the webview's document root.
                zf.write(path, path.relative_to(STATIC_DIR).as_posix())
    data = buf.getvalue()
    # Content hash of the packed bundle. A published version is supposed to
    # be IMMUTABLE — the version string is the content's identity, and a
    # device that already has it is told "up to date" and never refetches.
    # But the zip is packed from whatever is in /app/static at the time, so
    # bumping the version before a deploy lands publishes the OLD build
    # under the NEW number, and the device is then stranded on it with no
    # way to be offered the same version again. That happened on 1.1.2.
    # Logging the hash makes "is the published bundle the build I think it
    # is?" answerable instead of assumed.
    digest = hashlib.sha256(data).hexdigest()[:12]
    _OTA_ZIP_CACHE.clear()
    _OTA_ZIP_CACHE["version"] = version
    _OTA_ZIP_CACHE["data"] = data
    _OTA_ZIP_CACHE["sha256"] = digest
    log.info(f"OTA bundle {version} packed: {len(data)} bytes, sha256:{digest}")
    return data


@app.post("/updates/check")
async def ota_check(request: Request):
    """Capgo update endpoint. Returns {} when there is nothing to offer.

    The plugin posts its current bundle version and device metadata; we
    only look at the version. No checksum is returned because the bundle
    is unencrypted (the plugin only requires one for encrypted bundles),
    and no stats are collected — statsUrl is "" in capacitor.config.json
    so nothing about our users reaches a third party.
    """
    published, canary, canary_devices = _ota_env()
    if not published and not canary:
        return {"message": "Live updates disabled", "error": "disabled"}
    try:
        body = await request.json()
    except Exception:
        body = {}
    current = str(body.get("version_name") or body.get("version") or "").strip()
    offer = ota.decide(current, str(body.get("device_id") or ""), published, canary, canary_devices)
    if offer.version is None:
        return {"message": offer.reason}
    version = offer.version
    if _ota_bundle_zip(version) is None:
        return {"message": "No bundle packed", "error": "no_bundle"}
    # Build the URL from the proxy's forwarded headers, not request.base_url.
    # Railway terminates TLS in front of uvicorn, so base_url reports
    # http:// — and iOS App Transport Security refuses a plain-HTTP
    # download. The update would be offered, fail silently on the device,
    # and look exactly like "live updates don't work".
    proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        host = request.url.netloc
    if not proto:
        # Anything that isn't a local dev host is behind TLS in practice.
        proto = "http" if host.split(":")[0] in ("localhost", "127.0.0.1") else "https"
    base = f"{proto}://{host}"
    log.info(f"OTA: offering {version} ({offer.reason}) to a device on '{current or 'unknown'}' via {base}")
    return {"version": version, "url": f"{base}/updates/bundle/{version}.zip"}


@app.get("/updates/bundle/{version}.zip")
def ota_bundle(version: str):
    """Serve the packed bundle. Version in the path must match the one
    currently published — a device holding a stale URL gets a 404 rather
    than whatever happens to be on disk now."""
    from fastapi.responses import Response
    published, canary, _ = _ota_env()
    if version not in ota.servable_versions(published, canary):
        raise HTTPException(status_code=404, detail="Unknown bundle version")
    data = _ota_bundle_zip(version)
    if data is None:
        raise HTTPException(status_code=404, detail="Bundle not available")
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{version}.zip"'},
    )


@app.get("/updates/status")
def ota_status(requesting_email: str = ""):
    """Is OTA on, and what would be served? Founder-only."""
    _require_founder(requesting_email)
    published, canary, canary_devices = _ota_env()
    data = _ota_bundle_zip(canary or published)
    return {
        "enabled": bool(published or canary),
        "published_version": published or None,
        # While set, only canary_devices are offered anything (ota.py).
        "canary_version": canary or None,
        "canary_devices": len(canary_devices),
        "bundle_bytes": len(data) if data else 0,
        # Verify this against the deployed web build before telling anyone
        # to test — it is the only way to know the published version holds
        # the code you think it does.
        "bundle_sha256": _OTA_ZIP_CACHE.get("sha256") if data else None,
        "main_chunk": _ota_main_chunk_name(),
        "static_dir_present": STATIC_DIR.exists(),
        "hint": (
            "Set OTA_BUNDLE_VERSION on Railway to publish the current deploy. "
            "It must sort ABOVE the native app version the devices are running."
        ),
    }


@app.post("/push/send-reminders")
async def push_send_reminders(requesting_email: str = "", dry_run: bool = True):
    """Manual trigger for the day-before reminders — the scheduler runs
    this at 18:00 America/Sao_Paulo daily. Exists so the job can be
    verified without waiting for the cron, and re-fired if a deploy
    happened to land on top of it.

    Defaults to dry_run: reports who WOULD be reminded and why, without
    sending or marking anything. Safe to hit in production."""
    _require_founder(requesting_email)
    if not dry_run:
        return await send_event_reminders_for_tomorrow()

    from zoneinfo import ZoneInfo
    tomorrow = (datetime.now(ZoneInfo("America/Sao_Paulo")).date() + timedelta(days=1)).isoformat()
    rows = db.get_rsvps_for_day(tomorrow)
    preview = []
    for r in rows:
        gid, eid = r.get("google_id"), r.get("event_id")
        if not gid or not eid:
            continue
        if db.reminder_already_sent(gid, eid):
            state = "already_sent"
        elif not _user_daily_digest_opted_in(gid):
            state = "opted_out"
        else:
            state = "would_send"
        preview.append({
            "event": r.get("event_name"),
            "event_id": eid,
            "at": r.get("event_date"),
            "state": state,
        })
    return {
        "dry_run": True,
        "date": tomorrow,
        "candidates": len(preview),
        "would_send": sum(1 for p in preview if p["state"] == "would_send"),
        "detail": preview[:50],
    }


@app.get("/push/vapid-public-key")
def push_vapid_public_key():
    """Return the VAPID public key so the frontend can subscribe."""
    return {"publicKey": VAPID_PUBLIC_KEY}


@app.get("/digests/latest")
def get_latest_digest():
    """Most recent digest, for the Home 'o que rolou hoje' entry point —
    unlike the push-tap path, Home has no digest_id handed to it. Must be
    registered before /digests/{digest_id} or FastAPI would try to look
    up a digest literally named 'latest'. 404 if none has been sent yet."""
    digest = db.get_latest_daily_digest()
    if not digest:
        raise HTTPException(status_code=404, detail="Nenhum digest ainda")
    return digest


@app.get("/digests/{digest_id}")
def get_digest(digest_id: str):
    """Return the event_ids list for a daily digest. Used by the app
    when a user taps a digest push — the URL carries only digest_id
    (kept small to fit the APNs / web push payload), and the app
    fetches the full list here. 404 if the digest expired (we prune
    after 30 days) or never existed."""
    digest = db.get_daily_digest(digest_id)
    if not digest:
        raise HTTPException(status_code=404, detail="Digest não encontrado")
    return digest


# ── Apple Sign-In ──
#
# Google Sign-In runs entirely on the client (GIS button → JWT decoded
# locally). Apple's flow is server-verified: the device returns an
# identityToken JWT signed by Apple, and we MUST validate it server-side
# against Apple's JWKs before trusting any claim. Otherwise any client
# could submit a forged token and the backend would happily mint a user.
#
# Audience handling: native iOS uses the bundle id (app.aue) as `aud`;
# web sign-ins use the Service ID configured in Apple Developer (e.g.
# "app.aue.web"). Both are accepted as long as the env vars are set —
# unset audiences just skip that branch instead of falling open.
APPLE_NATIVE_AUDIENCE = os.environ.get("APPLE_NATIVE_AUDIENCE", "app.aue").strip()
APPLE_WEB_AUDIENCE = os.environ.get("APPLE_WEB_AUDIENCE", "").strip()


def _apple_audiences() -> list[str]:
    auds = []
    if APPLE_NATIVE_AUDIENCE:
        auds.append(APPLE_NATIVE_AUDIENCE)
    if APPLE_WEB_AUDIENCE:
        auds.append(APPLE_WEB_AUDIENCE)
    return auds


class AppleSignInBody(BaseModel):
    identity_token: str
    # Apple returns the user's name + email ONLY on the first sign-in,
    # and only when the user grants those scopes. The frontend captures
    # them and forwards here so we can persist them to the users row.
    # On subsequent sign-ins these come back empty and the existing row
    # is kept untouched (register_provider_user only backfills, never
    # overwrites a non-empty field).
    given_name: str = ""
    family_name: str = ""


@app.post("/auth/apple")
def auth_apple_sign_in(body: AppleSignInBody):
    """Verify an Apple Sign-In identityToken and return a stable user
    profile. Used by the iOS native plugin AND the web JS SDK — both
    end up POSTing the JWT here.

    Returns: { user_id, display_name, email, picture, is_new_user }
    The frontend stores user_id in state.googleUser.id (legacy field
    name; refactored later) so the rest of the app's per-user fetches
    keep working without a sweep."""
    try:
        from apple_auth import verify_identity_token
    except ImportError:
        raise HTTPException(status_code=501, detail="Apple Sign-In module not loaded")

    auds = _apple_audiences()
    if not auds:
        raise HTTPException(
            status_code=500,
            detail="APPLE_NATIVE_AUDIENCE / APPLE_WEB_AUDIENCE not configured",
        )

    try:
        claims = verify_identity_token(body.identity_token, auds)
    except ValueError as exc:
        log.warning(f"Apple Sign-In verify failed: {exc}")
        raise HTTPException(status_code=401, detail=f"Token inválido: {exc}")

    apple_sub = claims["sub"]
    apple_email = (claims.get("email") or "").strip()

    # Resolve canonical user_id, creating the (users, auth_providers)
    # pair on first sign-in. Apple subs are opaque per-app strings, so
    # we generate a fresh user_id (apl_<first 12 chars of sub>) when
    # this is a new account.
    existing_user_id = db.get_user_id_for_provider("apple", apple_sub)
    is_new_user = existing_user_id is None
    user_id = existing_user_id or f"apl_{apple_sub[:24].replace('.', '_')}"

    display_name = (f"{body.given_name} {body.family_name}".strip()) or ""
    db.register_provider_user(
        provider="apple",
        provider_id=apple_sub,
        user_id=user_id,
        display_name=display_name,
        email=apple_email,
        picture="",  # Apple doesn't return profile photos
    )

    profile = db.get_user_profile(user_id) or {"id": user_id}
    return {
        "user_id": user_id,
        "display_name": profile.get("display_name") or "",
        "email": profile.get("email") or "",
        "picture": profile.get("picture") or "",
        "is_new_user": is_new_user,
    }


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

        Also handles dotfile paths here because Starlette's router does
        not reliably match explicit routes for them — we re-do the
        dispatch by hand. Same reason both AASA endpoints are listed:
        Apple fetches the .well-known one but historic apps used the
        root path.
        """
        from fastapi.responses import JSONResponse
        if path == ".well-known/assetlinks.json":
            return JSONResponse(content=_ASSET_LINKS)
        if path in ("apple-app-site-association",
                    ".well-known/apple-app-site-association"):
            return JSONResponse(content=APPLE_APP_SITE_ASSOCIATION)
        file_path = STATIC_DIR / path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(STATIC_DIR / "index.html")
