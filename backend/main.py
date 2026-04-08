"""
Reroot Backend — FastAPI
Serve eventos reais de Curitiba enriquecidos com Claude.

Local:  uvicorn main:app --reload --port 8000
Deploy: Railway runs this via Dockerfile (PORT injected by Railway)
"""
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
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
            for src in ["sympla", "eventbrite", "meetup"]
        },
    }


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


# ── Static files + SPA fallback ──
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
