"""
Reroot Backend — FastAPI
Serve eventos reais de Curitiba enriquecidos com Claude.

Local:  uvicorn main:app --reload --port 8000
Deploy: Railway runs this via Dockerfile (PORT injected by Railway)
"""
import json
import logging
import os
import re
import unicodedata
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
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
    sympla_token: str = ""
    eventbrite_token: str = ""
    instagram_user: str = ""
    instagram_pass: str = ""
    apify_api_token: str = ""
    google_places_api_key: str = ""
    city: str = "Curitiba"
    refresh_interval_hours: int = 24
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
        "sympla_configured": bool(settings.sympla_token),
        "eventbrite_configured": bool(settings.eventbrite_token),
        "instagram_configured": bool(settings.apify_api_token),
        "apify_configured": bool(settings.apify_api_token),
        "sesc_configured": True,
        "teatro_guaira_configured": True,
        "catraca_livre_configured": True,
        "ingresso_configured": True,
        "ai_gap_fill_configured": bool(_anthropic_key_status.get("valid")),
        "google_places_configured": bool(settings.google_places_api_key),
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
    "cultural": {"mon", "sesc", "teatro_guaira", "ingresso", "catraca_livre"},
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
    cleaned = [
        ev for ev in raw
        if _is_in_curitiba(ev)
        and _passes_content_filter(ev, curated=good_only)
        and mood_pred(ev)
    ]
    deduped = _dedupe_events(cleaned)[:limit]

    return {
        "events": [_to_frontend(ev) for ev in deduped],
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

    Three-tier dedup, in order of confidence:
      1. Exact match on (normalized name, day) — fast.
      2. Same day + same hour + venue overlap (Jaccard ≥ 0.4 on venue
         tokens, or one venue contained in the other). Strongest signal:
         a museum/theatre is unlikely to host two distinct events at the
         same hour. Catches the MON-Orquestra-Cordas case where 5 scraper
         flavors of the same concert had wildly different name strings
         ("Concerto Especial", "Concerto com Cláudio Cruz", etc.).
      3. Name fuzzy: token-set Jaccard ≥ 0.6 between names AND same day
         (or both undated). Catches near-misses like "Caça à Arte no MON
         sem Paredes" vs "MON sem Paredes — Arte ao Ar Livre".

    First occurrence wins; downstream sources are dropped silently. Sources
    are typically ordered upstream so that canonical sources (museum site)
    arrive before secondary mentions (Instagram), keeping the better record.
    """
    NAME_JACCARD = 0.6
    VENUE_JACCARD = 0.4  # lower bar: venue strings often differ in suffixes
    out = []
    for ev in events:
        ev_day = ev.date_start.date().isoformat() if ev.date_start else ""
        ev_hour = ev.date_start.strftime("%H:%M") if ev.date_start else ""
        ev_name_tokens = _name_tokens(ev.name)
        ev_venue_tokens = _name_tokens(ev.venue_name or "")
        is_dup = False
        for kept in out:
            kept_day = kept.date_start.date().isoformat() if kept.date_start else ""
            # Date gate — must share a day (or both be undated programs)
            if ev_day != kept_day:
                continue

            # Tier 2: same hour + venue overlap → very confident dup
            if ev_day and ev_hour:
                kept_hour = kept.date_start.strftime("%H:%M") if kept.date_start else ""
                if ev_hour == kept_hour:
                    kept_venue_tokens = _name_tokens(kept.venue_name or "")
                    venue_match = False
                    if ev_venue_tokens and kept_venue_tokens:
                        vinter = len(ev_venue_tokens & kept_venue_tokens)
                        vunion = len(ev_venue_tokens | kept_venue_tokens)
                        if vunion and vinter / vunion >= VENUE_JACCARD:
                            venue_match = True
                        # Also accept "one is a subset of the other" — handles
                        # "MON" vs "Auditório Poty Lazzarotto Museu Oscar Niemeyer"
                        elif ev_venue_tokens.issubset(kept_venue_tokens) or kept_venue_tokens.issubset(ev_venue_tokens):
                            venue_match = True
                    if venue_match:
                        is_dup = True
                        break

            # Tier 3: name fuzzy on the same day
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


@app.get("/events/{event_id}")
def get_event(event_id: str):
    ev = db.get_event_by_id(event_id)
    if not ev:
        raise HTTPException(status_code=404, detail="Evento não encontrado")
    return _to_frontend(ev, detail=True)


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
                "sympla", "eventbrite", "meetup", "instagram",
                "sesc", "teatro_guaira", "catraca_livre", "ingresso",
                "mon", "turismo_curitiba",
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
_INSTITUTIONAL_SOURCES = {
    "mon": {
        "label": "MON — Museu Oscar Niemeyer",
        "url": "https://www.museuoscarniemeyer.org.br/programacao/",
        "icon": "🖼",
        "blurb": "Maior museu do Sul do Brasil. Exposições, oficinas e o programa MON sem Paredes.",
    },
    "sesc": {
        "label": "SESC Paraná",
        "url": "https://www.sescpr.com.br/",
        "icon": "🎭",
        "blurb": "Programação cultural acessível em diversas unidades de Curitiba.",
    },
    "teatro_guaira": {
        "label": "Teatro Guaíra",
        "url": "https://www.teatroguaira.pr.gov.br/",
        "icon": "🎭",
        "blurb": "Teatro estatal do Paraná: concertos, balé, ópera, peças.",
    },
    "ingresso": {
        "label": "Ingresso.com",
        "url": "https://www.ingresso.com/",
        "icon": "🎫",
        "blurb": "Eventos com ingressos comerciais em Curitiba.",
    },
    "catraca_livre": {
        "label": "Catraca Livre",
        "url": "https://catracalivre.com.br/",
        "icon": "🎟",
        "blurb": "Eventos gratuitos e de baixo custo em Curitiba.",
    },
    "sympla": {
        "label": "Sympla",
        "url": "https://www.sympla.com.br/eventos/curitiba-pr",
        "icon": "🎟",
        "blurb": "Plataforma brasileira de venda de ingressos.",
    },
    "eventbrite": {
        "label": "Eventbrite",
        "url": "https://www.eventbrite.com.br/d/brazil--curitiba/events/",
        "icon": "🎫",
        "blurb": "Plataforma global de eventos e ingressos.",
    },
    "turismo_curitiba": {
        "label": "Turismo Curitiba",
        "url": "https://turismo.curitiba.pr.gov.br/",
        "icon": "🏙",
        "blurb": "Site oficial de turismo da Prefeitura de Curitiba.",
    },
    "aue_original": {
        "label": "Original auê",
        "url": "",
        "icon": "⭐",
        "blurb": "Eventos curados pela equipe do auê.",
    },
    "meetup": {
        "label": "Meetup",
        "url": "https://www.meetup.com/find/?location=br--82--Curitiba",
        "icon": "👥",
        "blurb": "Encontros de comunidades e grupos de interesse.",
    },
}


@app.get("/sources")
def list_sources():
    """
    Catalog of every monitored source with a future-event count. The
    frontend uses this for the Sources screen — transparency surface that
    shows users where the catalog comes from.
    """
    by_source = db.count_future_events_by_source()
    by_handle = db.count_future_events_by_ig_handle()

    institutional = []
    for src_id, meta in _INSTITUTIONAL_SOURCES.items():
        institutional.append({
            "id": src_id,
            "label": meta["label"],
            "url": meta["url"],
            "icon": meta["icon"],
            "blurb": meta["blurb"],
            "future_events": by_source.get(src_id, 0),
        })
    institutional.sort(key=lambda s: (-s["future_events"], s["label"]))

    instagram = []
    for acc in db.list_ig_accounts():
        if not acc.get("enabled"):
            continue
        instagram.append({
            "handle": acc["handle"],
            "label": acc.get("display_name") or acc.get("label") or f"@{acc['handle']}",
            "category": acc.get("category", ""),
            "url": f"https://www.instagram.com/{acc['handle']}/",
            "last_scraped_at": acc.get("last_scraped_at"),
            "future_events": by_handle.get(acc["handle"], 0),
            "profile_pic_url": acc.get("profile_pic_url") or "",
        })
    instagram.sort(key=lambda s: (-s["future_events"], s["label"]))

    return {"institutional": institutional, "instagram": instagram}


@app.get("/sources/{source_id}")
def source_detail(source_id: str):
    """
    Detail for a single source: metadata + upcoming events.
    `source_id` can be an institutional key ("mon", "sympla", ...) or
    "ig:<handle>" for an Instagram handle.
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
    # Apply the same content filters as /events so the detail view doesn't
    # surface events the catalog already hides.
    cleaned = [
        ev for ev in events
        if _passes_content_filter(ev, curated=False) and _is_in_curitiba(ev)
    ]
    return {
        "source": meta,
        "events": [_to_frontend(ev) for ev in cleaned],
        "total": len(cleaned),
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
    """Record that a user is going to an event (normalized, queryable)."""
    db.upsert_rsvp(
        google_id=req.google_id,
        event_id=req.event_id,
        event_name=req.event_name,
        event_venue=req.event_venue,
        event_date=req.event_date,
        event_url=req.event_url,
    )
    return {"ok": True}


@app.delete("/rsvp/{event_id}")
def rsvp_delete(event_id: str, google_id: str):
    """Remove an RSVP for the given user/event pair."""
    db.delete_rsvp(google_id=google_id, event_id=event_id)
    return {"ok": True}


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

    # Group by event_id, filter to future events
    grouped: dict[str, dict] = {}
    for rsvp in rsvps:
        if rsvp["event_date"] and rsvp["event_date"] < today:
            continue
        eid = rsvp["event_id"]
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

    # Sort by event_date ascending, nulls last
    events = sorted(
        grouped.values(),
        key=lambda e: e["event_date"] or "9999-99-99",
    )
    return {"events": events}


# ── Google Places ──

_CURITIBA_LAT = -25.4290
_CURITIBA_LNG = -49.2671
_PLACES_BASE = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"

_PLACES_TYPE_MAP: dict[str, list[str]] = {
    "bars_cafes": ["bar", "cafe"],
    "parks":      ["park"],
    "cinema":     ["movie_theater"],
    "bookstore":  ["book_store"],
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
async def list_places(type: str = "bars_cafes", limit: int = 20):
    """
    Busca locais reais no Google Places por tipo e retorna no formato frontend.
    type: bars_cafes | parks | cinema | bookstore
    """
    if not settings.google_places_api_key:
        raise HTTPException(status_code=503, detail="GOOGLE_PLACES_API_KEY não configurada")

    place_types = _PLACES_TYPE_MAP.get(type, ["bar"])
    meta = _PLACES_META.get(type, _PLACES_META["bars_cafes"])

    all_places: list[dict] = []
    seen_ids: set[str] = set()

    google_statuses: list[str] = []

    async with httpx.AsyncClient(timeout=10) as client:
        for place_type in place_types:
            params = {
                "location": f"{_CURITIBA_LAT},{_CURITIBA_LNG}",
                "radius": 8000,
                "type": place_type,
                "key": settings.google_places_api_key,
                "language": "pt-BR",
            }
            r = await client.get(_PLACES_BASE, params=params)
            if r.status_code != 200:
                log.warning(f"Places API erro {r.status_code} para type={place_type}")
                google_statuses.append(f"{place_type}:http_{r.status_code}")
                continue
            body = r.json()
            g_status = body.get("status", "UNKNOWN")
            google_statuses.append(f"{place_type}:{g_status}")
            if g_status not in ("OK", "ZERO_RESULTS"):
                log.warning(f"Places API status={g_status} para type={place_type}: {body.get('error_message', '')}")
            raw_results = body.get("results", [])
            google_statuses[-1] += f"({len(raw_results)} raw)"
            for place in raw_results:
                pid = place.get("place_id", "")
                if not pid:
                    continue
                if pid not in seen_ids:
                    seen_ids.add(pid)
                    try:
                        all_places.append(_place_to_frontend(place, type, meta))
                    except Exception as e:
                        log.warning(f"Places parse error for {pid}: {e}")

    # Sort by number of ratings (popularity proxy), cap at limit
    all_places.sort(key=lambda p: p["attendeesConfirmed"], reverse=True)
    top = all_places[:limit]

    return {"places": top, "total": len(all_places), "type": type}


def _place_to_frontend(place: dict, category: str, meta: dict) -> dict:
    rating = place.get("rating", 0)
    ratings_total = place.get("user_ratings_total", 0)
    price_level = place.get("price_level", 1)
    vicinity = place.get("vicinity", "Curitiba")
    name = place["name"]
    place_id = place["place_id"]
    types = place.get("types", [])
    # Google's nearbysearch returns opening_hours.open_now as a boolean
    # (when the venue has hours data registered). It's present today —
    # absent for parks and some institutions. Surface it as `openNow` so
    # the frontend can show an "Aberto agora" pill.
    opening = place.get("opening_hours") or {}
    open_now = opening.get("open_now") if isinstance(opening, dict) else None

    _price_labels = {0: "Gratuito", 1: "R$ até 30", 2: "R$ 30–60", 3: "R$ 60–100", 4: "R$ 100+"}
    _price_tiers  = {0: "free", 1: "low", 2: "mid", 3: "high", 4: "high"}

    has_food = any(t in types for t in ["restaurant", "food", "meal_takeaway", "bakery", "cafe"])
    is_cafe = "cafe" in types or "café" in name.lower() or "coffee" in name.lower()
    is_low_pressure = is_cafe or price_level <= 1

    vibe = f"⭐ {rating}" if rating else ""
    if ratings_total:
        vibe += f" · {ratings_total:,} avaliações".replace(",", ".")

    pitch = _places_pitch(category, is_cafe)
    maps_url = f"https://www.google.com/maps/place/?q=place_id:{place_id}"

    return {
        "id": place_id,
        "name": name,
        "category": category,
        "categoryLabel": meta["label"],
        "categoryEmoji": meta["emoji"],
        "venue": f"{name} · {vicinity}",
        "date": "Sempre disponível",
        "time": "",
        "duration": "",
        "headerBg": meta["headerBg"],
        "icon": meta["icon"],
        "price": _price_labels.get(price_level, "R$ 30–60"),
        "priceTier": _price_tiers.get(price_level, "mid"),
        "hasFood": has_food,
        "isLowPressure": is_low_pressure,
        "attendeesConfirmed": ratings_total,
        "expectedSize": "intimate" if price_level <= 1 else "medium",
        "vibeSummary": vibe.strip(" ·"),
        "pitch": pitch,
        "url": maps_url,
        "cohortGoing": [],
        "source": "places",
        "isReal": True,
        "rating": rating,
        "placeSubtype": "cafe" if is_cafe else "bar",
        "openNow": open_now,  # True | False | None (None = unknown / not registered)
    }


def _places_pitch(category: str, is_cafe: bool) -> str:
    reasons = {
        "bars_cafes": (
            "Um café solo é o primeiro passo. Lugar com movimento, sem compromisso."
            if is_cafe else
            "Ambiente animado, fácil de entrar e sair. Bom para quebrar o isolamento."
        ),
        "parks": "Contato com natureza reduz cortisol. Caminhada solo ou com alguém — ambos valem.",
        "cinema": "Programa solo sem pressão social. Ótimo para sair de casa com propósito claro.",
        "bookstore": "Livraria é espaço de pertencimento silencioso. Fácil de ficar, fácil de ir.",
    }
    return reasons.get(category, "Lugar real, energia real.")


# ── Serialização para o frontend ──

def _to_frontend(ev, detail: bool = False) -> dict:
    """
    Converte EnrichedEvent para o formato que o React espera.
    Mantém consistência com o shape do data/events.js existente.
    """
    price_label = _format_price(ev.price_min, ev.price_max, ev.currency)
    member_count = ev.attendees_confirmed  # "popularidade real"

    # Reroot Originals are evergreen suggestions, not scheduled events.
    is_original = ev.source == "aue_original"

    # Long-running events (museum exhibitions, programs) often started months
    # ago but are still on. Showing their start date misleads — surface the
    # END date as "Em cartaz até …" instead.
    today = datetime.now(timezone.utc).date()
    is_ongoing = (
        not is_original
        and ev.date_end is not None
        and ev.date_start.date() < today
        and ev.date_end.date() >= today
    )

    if is_original:
        date_label = "Sempre disponível"
    elif is_ongoing:
        date_label = f"Em cartaz até {_format_event_date(ev.date_end)}"
    else:
        date_label = _format_event_date(ev.date_start)

    out = {
        "id": ev.id,
        "name": ev.name,
        "category": ev.kind,
        "categoryLabel": ev.category_label,
        "categoryEmoji": ev.category_emoji,
        "venue": f"{ev.venue_name} · {ev.neighborhood}",
        "date": date_label,
        "time": "" if (is_original or is_ongoing) else ev.date_start.strftime("%H:%M"),
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
        "dateStart": ev.date_start.isoformat(),
    }

    if detail:
        out["description"] = ev.description
        out["venueAddress"] = ev.venue_address
        out["city"] = ev.city
        out["imageUrl"] = ev.image_url

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
    return group


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
    """Delete a group. Requires admin role."""
    group = db.get_group(group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    if group["created_by"] != google_id:
        raise HTTPException(status_code=403, detail="Only the group creator can delete it")
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
    return {"status": "ok", "group": group}


@app.delete("/groups/{group_id}/members/{member_google_id}")
def remove_group_member(group_id: str, member_google_id: str, google_id: str):
    """Remove a member from a group (admin) or leave (self)."""
    if google_id != member_google_id:
        role = db.get_group_member_role(group_id, google_id)
        if role != "admin":
            raise HTTPException(status_code=403, detail="Only admins can remove members")
    db.leave_group(group_id, member_google_id)
    return {"ok": True}


@app.post("/groups/{group_id}/events")
def create_group_event(group_id: str, req: GroupEventCreateRequest):
    """Create an event within a group. Any member can create events."""
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
    )
    return event


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
    Each row is enriched with `future_events` so the admin UI can show
    real-time yield per handle and link to that handle's source page.
    """
    accounts = db.list_ig_accounts()
    counts = db.count_future_events_by_ig_handle()
    enriched = [{**a, "future_events": counts.get(a["handle"], 0)} for a in accounts]
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
    return {"account": db.upsert_ig_account(
        handle=handle, label=req.label.strip(), category=req.category.strip(),
        enabled=req.enabled, notes=req.notes.strip(),
        added_by_email=email,
    )}


@app.delete("/admin/ig-accounts/{handle}")
def admin_delete_ig_account(handle: str, requesting_email: str = ""):
    _require_curator(requesting_email)
    ok = db.delete_ig_account(handle)
    if not ok:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    return {"ok": True}


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
    return {"inserted": inserted, "total_defaults": len(_DEFAULT_IG_ACCOUNTS)}


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
    email = _require_feedbacker(req.requesting_email)
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


@app.post("/push/subscribe")
def push_subscribe(body: PushSubscriptionBody):
    """Store or update a Web Push subscription from the browser."""
    db.upsert_push_subscription(body.endpoint, json.dumps(body.keys))
    log.info(f"Push subscription saved: {body.endpoint[:60]}…")
    return {"status": "subscribed"}


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
