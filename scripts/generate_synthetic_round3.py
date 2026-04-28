"""
Synthetic user testing — round 3 (post-pivot to auê).

Generates 12 unique Curitiba personas, simulates 2-week usage journeys,
and collects feedback messages. Output drops into synthetic_data/ as JSON.

Why round 3 now:
- R1 (16 personas, NPS 0) and R2 (12 personas, NPS +8) were pre-pivot.
- The product flipped from "Reroot" (wellness / social re-entry) to
  "auê" (broad Curitiba events catalog) in April/2026, plus 50+ feature
  shifts (badges v3 with tiers, anti-game mature filter, per-user push,
  /install flow, onboarding teaser, Recordes Pessoais, etc.).
- Personas calibrated to wellness positioning won't test the auê surface
  honestly — this round generates fresh Curitiba locals.

Run:
    cd c:/repo/reroot
    py -3.12 scripts/generate_synthetic_round3.py
    # ANTHROPIC_API_KEY is read from backend/.env

Cost: ~$1-2 in Claude Sonnet credits for 12 personas.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

# Load ANTHROPIC_API_KEY from backend/.env without depending on dotenv.
ENV_FILE = REPO / "backend" / ".env"
if ENV_FILE.exists() and "ANTHROPIC_API_KEY" not in os.environ:
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("ANTHROPIC_API_KEY="):
            os.environ["ANTHROPIC_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
            break

if not os.environ.get("ANTHROPIC_API_KEY"):
    print("ERROR: ANTHROPIC_API_KEY not found in env or backend/.env", file=sys.stderr)
    sys.exit(1)

from anthropic import Anthropic  # noqa: E402

CLIENT = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
MODEL = "claude-sonnet-4-6"
N_PERSONAS = 12
START_INDEX = 29  # R2 ended at P28
OUT_DIR = REPO / "synthetic_data"
OUT_DIR.mkdir(exist_ok=True)


# ── Shared app context — describes what testers are evaluating ──
APP_CONTEXT = """\
auê — catálogo de eventos de Curitiba (renomeado em abril/2026, antes "Reroot").

POSICIONAMENTO: "Curitiba que acontece" — agrega Sympla, Eventbrite, MON,
SESC, Catraca Livre, Instagram (~50 contas curadas) + 12 auê Originals
(sugestões evergreen pra cafés/parques sem agenda fixa). Voz festiva
("bora", "vai", "rola"), não terapêutica. Sem moralismo.

DISTRIBUIÇÃO: closed beta PWA-only (sem Google Play, sem App Store).
Friend instala via /install (walkthrough universal por plataforma).
URL: https://reroot-production.up.railway.app

FEATURES RELEVANTES PRO TESTE:
- /install: walkthrough detecta plataforma (iOS Safari, Android Chrome,
  in-app browser, desktop). iPhone exige instalar via Safari "Adicionar
  à Tela de Início" — sem isso não recebe push.
- Onboarding: card animado cicla 4 sample events (show, sarau, festa,
  stand-up) — vende variedade do catálogo em ~3s cada
- Eventos: feed com filtros por mood (Tudo, Tranquilo, Ativo, Criativo,
  Comunidade, Cultural, Família). Cards com vibe summary + amigos vão.
- Personalização per-event: "Bora porque…" pitch via Claude. Chips
  contextuais ("⚠ Mesma noite", "📍 Mesmo lugar") quando aplica.
- Friends: Google Sign-In + invite code de 6 chars
- Groups: privados/públicos com invite, membros adicionam eventos pro
  grupo, push notifica os outros membros
- Push notifications:
  * Amigo confirmou evento -> "🎉 [Nome] vai · [evento]"
  * Membro adicionou evento ao grupo -> "🎲 [Grupo] · [Nome] adicionou: …"
- 13 BADGES com tiers metálicos (Bronze->Prata->Ouro->Platina):
  Primeiro auê, Galera junto, Crew (binárias)
  Explorador (3/5/10 bairros), Versátil (4 kinds em janela apertada),
  Noiteiro (≥19h), Diurno (<19h), Maratonista (2+ eventos no dia),
  Vai junto (eventos com amigo), Cohort (3+ amigos no mesmo evento),
  Anfitrião (grupos próprios c/ 3+ membros), Curador (eventos adicionados
  a grupo), Local da casa (3+ RSVPs no mesmo venue, escala até Platina)
- ANTI-GAME: badges count-based só contam eventos JÁ acontecidos
  (mature filter). RSVP+cancela não farma. Subtítulo na seção:
  "Conquistas atualizam após o evento rolar."
- Recordes Pessoais (RSVPs total, bairros visitados, semana-streak,
  lugar predileto, mês mais ativo). Números só sobem.
- QR code no Profile -> tap pra fullscreen -> outro celular escaneia
- Privacy: shareRsvps, showInFriendSuggestions, showProfileToStrangers
- Comunidade tab: GRUPOS primário, Amigos secundário (default: Grupos)
- Companion Chat AI: chatbot lateral pra perguntar sobre eventos

LIMITAÇÕES CONHECIDAS:
- iOS PWA exige Safari (Chrome iOS / WhatsApp in-app não funcionam)
- Notificações precisam permissão explícita após login
- Sem in-app group chat (galera ainda migra pro WhatsApp pós-evento)
- Email transactional via Resend (sem Gmail SMTP — Railway bloqueia 587)
- iOS PWA não tem badge numérico no ícone (limite Apple)
"""


# ── Prompts ────────────────────────────────────────────────

PERSONA_PROMPT = """{app_context}

Você é um pesquisador UX gerando uma persona realista de morador de Curitiba
pra testar o auê. A persona DEVE ser:

- Residente atual de Curitiba (não SP, RJ, etc.) com bairro específico
- Distinta das já criadas (variar idade, lifestyle, tech, social)

DIVERSIDADE OBRIGATÓRIA neste lote — varie em:
- Idade (18-65)
- Bairro (Centro, Batel, Bigorrilho, Juvevê, Água Verde, São Francisco,
  Cabral, Mercês, Hauer, Boa Vista, Pilarzinho, Ahú, Cristo Rei, Santa
  Felicidade, Cajuru, Portão, Capão Raso, etc.)
- Lifestyle (festeiro, cultural, atlético, criativo, parente, comunitário,
  neurodivergente, recém-chegado, idoso ativo, casal vs solteiro)
- Tech savviness (alta, média, baixa)
- Conexão social (galera grande, isolado, expat brasileiro)

JÁ CRIADAS NESTE LOTE (não repetir esses perfis):
{existing_summaries}

OUTPUT — SOMENTE JSON estrito, sem markdown nem texto extra:
{{
  "persona_id": "P{idx:02d}",
  "name": "Nome Sobrenome",
  "age": <int>,
  "neighborhood": "Bairro de Curitiba",
  "life_context": "1-2 frases: trabalho, situação familiar, rotina.",
  "lifestyle": "festeiro|cultural|atletico|criativo|parente|comunitario|misto",
  "psychographic": {{
    "introvert_extrovert": "introvert|ambivert|extrovert",
    "traits": ["3-4 adjetivos curtos"],
    "social_style": "1 frase descrevendo como ela socializa"
  }},
  "tech_relationship": "tech-savvy|casual_user|low_tech",
  "motivations": ["3-4 motivos específicos pra usar app de eventos em Curitiba"],
  "frustrations_with_event_apps": ["3-4 problemas concretos com Sympla/Insta/etc."],
  "expectations_from_aue": ["3-4 coisas concretas que ela quer do auê"]
}}
"""


JOURNEY_PROMPT = """{app_context}

Persona:
{persona_json}

Simule a jornada de 2 semanas dela usando o auê. O amigo dela mandou o link
pelo WhatsApp. Seja honesto e ESPECÍFICO sobre fricções, descobertas, e
emoções — esta persona NÃO é uma fan abstrata, ela tem o lifestyle/idade/
tech-savviness descritos.

Estrutura da jornada (2 semanas, ~10 momentos):
- DIA 1: Recebe link, tenta abrir/instalar
- DIAS 2-7: Primeira semana — explora catálogo, descobre features, primeiro RSVP
- DIAS 8-14: Segunda semana — possivelmente RSVP segundo evento, badges,
  interage com amigos no app, ou desinstala/abandona

Inclua momentos onde a persona:
- Tenta instalar como PWA (sucesso ou fricção iOS Safari? in-app browser?)
- Vê o teaser de onboarding (4 cards rotativos)
- Encontra (ou não) features importantes (Recordes, Conquistas, Grupos, QR)
- Reage a notificações push (se permitiu)
- Compara com app que usa hoje (Sympla, Insta saved posts, agenda da prefeitura)
- Descobre badge / tier-up
- Pode bater no anti-game ("RSVPei mas cadê a badge?")
- Tenta convidar/conectar amigo

OUTPUT — SOMENTE array JSON de 8-12 momentos, cada um com:
[
  {{
    "day": <1-14>,
    "moment": "Frase curta descrevendo o que aconteceu",
    "action_taken": "O que ela tentou fazer concretamente",
    "friction_encountered": "Problema, ou null se nenhum",
    "emotion": "Sentimento dominante (ex: 'curiosa', 'frustrada', 'animada', 'cética')",
    "outcome": "won|partial|failed"
  }}
]
"""


FEEDBACK_PROMPT = """{app_context}

Persona:
{persona_json}

Resumo da jornada:
{journey_summary}

Gere 4 feedback messages que essa persona escreveria sobre o auê após 2
semanas. Use a voz autêntica dela — vocabulário, nível formal, sotaque
regional implícito. NÃO seja genérica.

Os 4 feedbacks devem ser:
1. **Review estilo Play Store** (mesmo que app não está lá ainda) — positivo
   se a persona gostou (NPS 8-10), crítico se frustrou (NPS 0-6). Escolha
   baseado no que a journey mostrou.
2. **Mensagem in-app de feedback** (botão "Enviar feedback" no Profile) —
   o que ela manda direto pro time.
3. **Email pro Ciro (founder)** — tom mais pessoal, talvez agradecendo ou
   reclamando direto.
4. **Resposta a um amigo no WhatsApp** ("e aí, gostou do auê?") — voz
   coloquial, 1-3 frases, brasileiro real.

Cada feedback DEVE ter:
- type: review|in_app|email|whatsapp
- sentiment: positive|neutral|negative
- themes: array de 1-3 (eventos, ui_ux, install, badges, push, conexoes,
  amigos, grupos, privacidade, recordes, voz_marca, anti_game, etc.)
- text: o feedback completo em pt-BR
- nps_score: 0-10
- frustration_level: low|medium|high|critical

OUTPUT — SOMENTE array JSON de 4 objetos.
"""


# ── Helpers ────────────────────────────────────────────────

def call_claude(prompt: str, max_tokens: int = 2048, attempt: int = 1) -> any:
    """Call Claude with simple retry + JSON extraction."""
    try:
        msg = CLIENT.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        text = msg.content[0].text.strip()
        # Strip markdown code fences if Claude wrapped despite instructions
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        return json.loads(text)
    except json.JSONDecodeError as e:
        if attempt < 2:
            print(f"    JSON parse failed (attempt {attempt}): {e}. Retrying with reformat instruction...")
            return call_claude(
                prompt + "\n\nIMPORTANTE: retorne APENAS o JSON, sem texto explicativo, sem markdown.",
                max_tokens=max_tokens,
                attempt=attempt + 1,
            )
        raise
    except Exception as e:
        if attempt < 3:
            wait = 2 ** attempt
            print(f"    API error (attempt {attempt}): {e}. Retrying in {wait}s...")
            time.sleep(wait)
            return call_claude(prompt, max_tokens, attempt + 1)
        raise


def short_summary(p: dict) -> str:
    """One-liner used to deduplicate against already-generated personas."""
    return (
        f"- {p['persona_id']} {p['name']} ({p['age']}, {p['neighborhood']}, "
        f"{p['lifestyle']}, {p['tech_relationship']})"
    )


# ── Runner ─────────────────────────────────────────────────

def main() -> None:
    # Force UTF-8 stdout so non-ASCII names (Curitiba accents, arrows) don't
    # crash the script on Windows cp1252 consoles.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    print(f"=== aue synthetic round 3 -- generating {N_PERSONAS} personas ===\n")

    personas_file = OUT_DIR / "personas_round3.json"
    journeys_file = OUT_DIR / "journeys_round3.json"
    feedbacks_file = OUT_DIR / "feedbacks_round3.json"

    # ── Phase 1: personas ── (skipped if already on disk — resumable)
    if personas_file.exists():
        personas = json.loads(personas_file.read_text(encoding="utf-8"))
        print(f"Phase 1/3 -- Personas: reusing {len(personas)} saved personas\n")
    else:
        print("Phase 1/3 -- Personas")
        personas = []
        for i in range(N_PERSONAS):
            idx = START_INDEX + i
            existing = "\n".join(short_summary(p) for p in personas) or "(nenhuma ainda)"
            prompt = PERSONA_PROMPT.format(
                app_context=APP_CONTEXT,
                existing_summaries=existing,
                idx=idx,
            )
            persona = call_claude(prompt, max_tokens=1024)
            personas.append(persona)
            print(f"  [{i+1:2d}/{N_PERSONAS}] {persona['persona_id']} {persona['name']} "
                  f"({persona['age']}, {persona['neighborhood']}, {persona['lifestyle']})")
        personas_file.write_text(
            json.dumps(personas, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"  -> saved personas_round3.json\n")

    # ── Phase 2: journeys ── (resumable)
    if journeys_file.exists():
        journeys = json.loads(journeys_file.read_text(encoding="utf-8"))
        print(f"Phase 2/3 -- Journeys: reusing {len(journeys)} saved journeys\n")
    else:
        print("Phase 2/3 -- Journeys (2-week simulation per persona)")
        journeys = []
        for i, p in enumerate(personas, 1):
            prompt = JOURNEY_PROMPT.format(
                app_context=APP_CONTEXT,
                persona_json=json.dumps(p, ensure_ascii=False, indent=2),
            )
            moments = call_claude(prompt, max_tokens=3072)
            journeys.append({"persona_id": p["persona_id"], "moments": moments})
            wins = sum(1 for m in moments if m.get("outcome") == "won")
            fails = sum(1 for m in moments if m.get("outcome") == "failed")
            print(f"  [{i:2d}/{N_PERSONAS}] {p['persona_id']} -> {len(moments)} moments "
                  f"({wins} won, {fails} failed)")
        journeys_file.write_text(
            json.dumps(journeys, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"  -> saved journeys_round3.json\n")

    # ── Phase 3: feedbacks ── (resumable)
    if feedbacks_file.exists():
        feedbacks = json.loads(feedbacks_file.read_text(encoding="utf-8"))
        print(f"Phase 3/3 -- Feedbacks: reusing {len(feedbacks)} saved feedbacks\n")
    else:
        print("Phase 3/3 -- Feedbacks (4 messages per persona)")
        feedbacks = []
        for i, (p, j) in enumerate(zip(personas, journeys), 1):
            journey_summary = "\n".join(
                f"D{m['day']}: {m['moment']} -> {m.get('outcome', '?')}"
                for m in j["moments"]
            )
            prompt = FEEDBACK_PROMPT.format(
                app_context=APP_CONTEXT,
                persona_json=json.dumps(p, ensure_ascii=False, indent=2),
                journey_summary=journey_summary,
            )
            msgs = call_claude(prompt, max_tokens=2048)
            feedbacks.append({"persona_id": p["persona_id"], "messages": msgs})
            nps_avg = sum(m.get("nps_score", 0) for m in msgs) / max(len(msgs), 1)
            print(f"  [{i:2d}/{N_PERSONAS}] {p['persona_id']} -> {len(msgs)} feedbacks "
                  f"(avg NPS {nps_avg:.1f})")
        feedbacks_file.write_text(
            json.dumps(feedbacks, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"  -> saved feedbacks_round3.json\n")

    # ── Quick stats ──
    all_msgs = [m for f in feedbacks for m in f["messages"]]
    nps_scores = [m["nps_score"] for m in all_msgs if "nps_score" in m]
    promoters = sum(1 for s in nps_scores if s >= 9)
    detractors = sum(1 for s in nps_scores if s <= 6)
    passives = len(nps_scores) - promoters - detractors
    nps = (promoters - detractors) / len(nps_scores) * 100 if nps_scores else 0

    print("=== Done ===")
    print(f"Personas:  {len(personas)}")
    print(f"Journeys:  {sum(len(j['moments']) for j in journeys)} moments total")
    print(f"Feedbacks: {len(all_msgs)} messages total")
    print(f"NPS (across all messages): {nps:+.0f}")
    print(f"  Promoters:  {promoters} ({promoters/len(nps_scores)*100:.0f}%)")
    print(f"  Passives:   {passives} ({passives/len(nps_scores)*100:.0f}%)")
    print(f"  Detractors: {detractors} ({detractors/len(nps_scores)*100:.0f}%)")
    print(f"\nNext: read the JSONs and write analysis_summary_round3.md")


if __name__ == "__main__":
    main()
