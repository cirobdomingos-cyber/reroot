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
from datetime import date
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
    good_only: bool = False,
    price_tier: Optional[str] = None,
    kids_welcome: Optional[bool] = None,
    limit: int = 20,
):
    """
    Retorna eventos enriquecidos prontos para o frontend.
    category: quiet_social | active | creative | community | all
    price_tier: free | paid (paid = anything that is not free)
    kids_welcome: true to filter only family-friendly events
    """
    events = db.get_events(
        city=settings.city,
        good_only=good_only,
        category=category if category != "all" else None,
        price_tier=price_tier,
        kids_welcome=kids_welcome,
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
        "kidsWelcome": ev.kids_welcome,
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
        "dateStart": ev.date_start.isoformat(),
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
6. ALSO suggest custom activity ideas the user could create as private events \
   with friends. These are personalized suggestions NOT in the catalog — things \
   like "wine night with friends", "movie marathon", "picnic in the park". \
   Always suggest 1-3 custom ideas that fit the user's mood/request. \
   Each suggestion needs a name, emoji, short description, and category.

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


# ── Web Push Notifications ──
#
# VAPID key pair — in production, generate your own and store in env vars.
# These test keys are safe to commit for development only.
# Generate production keys: py -m py_vapid --gen
VAPID_PRIVATE_KEY = "nOAa5iExKg1EvBMkLblGvg"
VAPID_PUBLIC_KEY  = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBZuhbr6lT5E12OwvTPrBa5ygw"
VAPID_CLAIMS = {"sub": "mailto:admin@reroot.app"}
WEEKLY_PUSH_MESSAGE = "Hora do check-in semanal no Reroot! Como foi sua semana? 🌿"


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
