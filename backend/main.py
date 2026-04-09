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
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
from anthropic import Anthropic
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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
log = logging.getLogger("reroot")


# ── Settings (lê do .env) ──
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    anthropic_api_key: str = ""
    sympla_token: str = ""
    eventbrite_token: str = ""
    instagram_user: str = ""
    instagram_pass: str = ""
    google_places_api_key: str = ""
    city: str = "Curitiba"
    refresh_interval_hours: int = 6


settings = Settings()


# ── App lifecycle ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    log.info(f"DB inicializado em {db.DB_PATH}")

    if settings.anthropic_api_key:
        start_scheduler(settings, run_immediately=True)
    else:
        log.warning(
            "ANTHROPIC_API_KEY não configurada — scheduler desativado. "
            "O app vai usar dados estáticos de fallback."
        )

    yield  # ← app rodando

    stop_scheduler()


app = FastAPI(
    title="Reroot API",
    description="Eventos sociais de Curitiba para re-entrada social",
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
        "anthropic_configured": bool(settings.anthropic_api_key),
        "sympla_configured": bool(settings.sympla_token),
        "eventbrite_configured": bool(settings.eventbrite_token),
        "instagram_configured": bool(settings.instagram_user and settings.instagram_pass),
        "sesc_configured": True,
        "teatro_guaira_configured": True,
        "google_places_configured": bool(settings.google_places_api_key),
    }


@app.get("/events")
def list_events(
    category: Optional[str] = None,
    good_only: bool = True,
    limit: int = 20,
):
    """
    Retorna eventos enriquecidos prontos para o frontend.
    category: quiet_social | active | creative | community | all
    """
    events = db.get_events(
        city=settings.city,
        good_only=good_only,
        category=category if category != "all" else None,
        limit=limit,
    )

    return {
        "events": [_to_frontend(ev) for ev in events],
        "total": len(events),
        "city": settings.city,
    }


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
        by_cat[ev.reroot_category] = by_cat.get(ev.reroot_category, 0) + 1

    return {
        "total": len(events),
        "good_for_reroot": sum(1 for e in events if e.good_for_reroot),
        "by_category": by_cat,
        "sources": {
            src: sum(1 for e in events if e.source == src)
            for src in ["sympla", "eventbrite", "meetup", "instagram", "sesc", "teatro_guaira"]
        },
    }


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

    _price_labels = {0: "Gratuito", 1: "R$ até 30", 2: "R$ 30–60", 3: "R$ 60–100", 4: "R$ 100+"}
    _price_tiers  = {0: "free", 1: "low", 2: "mid", 3: "high", 4: "high"}

    has_food = any(t in types for t in ["restaurant", "food", "meal_takeaway", "bakery", "cafe"])
    is_cafe = "cafe" in types or "café" in name.lower() or "coffee" in name.lower()
    is_low_pressure = is_cafe or price_level <= 1

    vibe = f"⭐ {rating}" if rating else ""
    if ratings_total:
        vibe += f" · {ratings_total:,} avaliações".replace(",", ".")

    reroot_reason = _places_reroot_reason(category, is_cafe)
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
        "rerootReason": reroot_reason,
        "url": maps_url,
        "cohortGoing": [],
        "source": "places",
        "isReal": True,
        "rating": rating,
        "placeSubtype": "cafe" if is_cafe else "bar",
    }


def _places_reroot_reason(category: str, is_cafe: bool) -> str:
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

    out = {
        "id": ev.id,
        "name": ev.name,
        "category": ev.reroot_category,
        "categoryLabel": ev.category_label,
        "categoryEmoji": ev.category_emoji,
        "venue": f"{ev.venue_name} · {ev.neighborhood}",
        "date": ev.date_start.strftime("%d de %b").lstrip("0"),   # "12 de Abr"
        "time": ev.date_start.strftime("%H:%M"),
        "duration": _duration(ev),
        "headerBg": ev.header_gradient,
        "icon": _category_icon(ev.reroot_category),
        "price": price_label,
        "priceTier": ev.price_tier,
        "hasFood": ev.has_food,
        "isLowPressure": ev.is_low_pressure,
        "attendeesConfirmed": member_count,
        "expectedSize": ev.expected_size,
        "vibeSummary": ev.vibe_summary,
        "rerootReason": ev.reroot_reason,
        "url": ev.url,
        # cohortGoing simulado — em produção viria de uma tabela de RSVPs
        "cohortGoing": [],
        "source": ev.source,
    }

    if detail:
        out["description"] = ev.description
        out["venueAddress"] = ev.venue_address
        out["imageUrl"] = ev.image_url

    return out


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
You are the Reroot Companion — a warm, direct AI guide inside a social re-entry \
app for people rebuilding their social life after isolation.

CRITICAL RULES:
1. ALWAYS recommend events from the catalog when remotely relevant. Be generous \
   with matching — yoga request matches any active/wellness event, "board games" \
   matches quiet_social/community events, "dancing" matches active events, etc.
2. NEVER ask follow-up questions. NEVER say "what kind of X do you prefer?" — \
   just pick the best matches and recommend them immediately.
3. Keep it SHORT: 1-2 sentences max, then the events speak for themselves.
4. Be warm but brief. Think friendly text message, not therapy session.
5. If truly nothing matches, say so in one sentence and suggest what's closest.

USER CONTEXT:
- Situation: {situation}
- Goal: {goal}
- Week {week}/12
- Language: {language}

AVAILABLE EVENTS:
{events}

RESPONSE FORMAT — return ONLY valid JSON (no markdown):
{{
  "message": "<1-2 sentences in {language_name}, warm and direct>",
  "event_ids": ["id1", "id2"],
  "tone": "encouraging" | "gentle" | "excited" | "practical"
}}

event_ids MUST be exact IDs from the catalog. Always respond in {language_name}.
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
            model="claude-haiku-4-5-20251001",
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
        "tone": data.get("tone", "encouraging"),
    }


# ── Static files + SPA fallback ──
# Digital Asset Links — required for TWA (Play Store) domain verification.
# Served explicitly because starlette StaticFiles may reject dotfile directories.
@app.get("/.well-known/assetlinks.json")
async def asset_links():
    asset_links_path = STATIC_DIR / ".well-known" / "assetlinks.json"
    if asset_links_path.is_file():
        return FileResponse(asset_links_path, media_type="application/json")
    return FileResponse(Path(__file__).parent.parent / "public" / ".well-known" / "assetlinks.json", media_type="application/json")


# Must be registered AFTER all API routes so /events, /health etc. take priority

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa_fallback(request: Request, path: str):
        """Serve static files or fall back to index.html for SPA routing."""
        file_path = STATIC_DIR / path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(STATIC_DIR / "index.html")
