"""
Scheduler de refresh — APScheduler.
Roda na inicialização do FastAPI e a cada REFRESH_INTERVAL_HOURS horas.
"""
import logging
from datetime import datetime, timezone
from apscheduler.schedulers.asyncio import AsyncIOScheduler

log = logging.getLogger(__name__)
scheduler = AsyncIOScheduler(timezone="America/Sao_Paulo")


async def run_refresh(settings):
    """
    Pipeline completo:
      1. Busca eventos no Sympla + Eventbrite
      2. Enriquece com Claude
      3. Persiste no SQLite
    """
    # Imports aqui para evitar circular imports
    from scrapers.sympla import fetch_events as sympla_fetch
    from scrapers.eventbrite import fetch_events as eventbrite_fetch
    from scrapers.meetup import fetch_events as meetup_fetch
    from scrapers.instagram import fetch_events as instagram_fetch
    from enrichment import EnrichmentPipeline
    import database as db

    city = settings.city
    log.info(f"🔄 Iniciando refresh de eventos para {city}...")
    pipeline = EnrichmentPipeline(api_key=settings.anthropic_api_key)

    all_raws = []

    # ── Sympla (no city filter — API returns few results, accept all) ──
    log_id = db.log_refresh_start("sympla")
    try:
        sympla_events = await sympla_fetch(settings.sympla_token, city="")
        all_raws.extend(sympla_events)
        db.log_refresh_finish(log_id, events_new=len(sympla_events), events_updated=0)
        log.info(f"  Sympla: {len(sympla_events)} eventos brutos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Sympla falhou: {e}")

    # ── Eventbrite ──
    log_id = db.log_refresh_start("eventbrite")
    try:
        eb_events = await eventbrite_fetch(settings.eventbrite_token, city=city)
        all_raws.extend(eb_events)
        db.log_refresh_finish(log_id, events_new=len(eb_events), events_updated=0)
        log.info(f"  Eventbrite: {len(eb_events)} eventos brutos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Eventbrite falhou: {e}")

    # ── Meetup (public GraphQL API — no key needed) ──
    log_id = db.log_refresh_start("meetup")
    try:
        meetup_events = await meetup_fetch(city=city)
        all_raws.extend(meetup_events)
        db.log_refresh_finish(log_id, events_new=len(meetup_events), events_updated=0)
        log.info(f"  Meetup: {len(meetup_events)} eventos brutos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Meetup falhou: {e}")

    # ── Instagram (Claude extracts events from hashtag posts) ──
    log_id = db.log_refresh_start("instagram")
    try:
        ig_events = await instagram_fetch(
            anthropic_api_key=settings.anthropic_api_key,
            city=city,
            ig_username=settings.instagram_user,
            ig_password=settings.instagram_pass,
        )
        all_raws.extend(ig_events)
        db.log_refresh_finish(log_id, events_new=len(ig_events), events_updated=0)
        log.info(f"  Instagram: {len(ig_events)} eventos extraídos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Instagram falhou: {e}")

    if not all_raws:
        log.warning("Nenhum evento bruto encontrado — nada para enriquecer.")
        return

    # ── Enriquecimento com Claude ──
    log.info(f"  Enriquecendo {len(all_raws)} eventos com Claude Haiku...")
    enriched = pipeline.enrich_batch(all_raws, max_events=40)

    # ── Persistência ──
    saved = 0
    for ev in enriched:
        try:
            db.upsert_event(ev)
            saved += 1
        except Exception as e:
            log.warning(f"  Erro ao salvar '{ev.name}': {e}")

    total = db.count_events()
    log.info(f"✅ Refresh concluído: {saved} eventos salvos ({total} total no banco)")


def start_scheduler(settings, run_immediately: bool = True):
    interval_hours = settings.refresh_interval_hours

    scheduler.add_job(
        run_refresh,
        trigger="interval",
        hours=interval_hours,
        args=[settings],
        id="event_refresh",
        replace_existing=True,
    )
    scheduler.start()
    log.info(f"Scheduler iniciado — refresh a cada {interval_hours}h")

    if run_immediately:
        # Agenda um refresh imediato (2s de delay para o FastAPI subir)
        from apscheduler.triggers.date import DateTrigger
        from datetime import timedelta
        scheduler.add_job(
            run_refresh,
            trigger=DateTrigger(run_date=datetime.now(timezone.utc) + timedelta(seconds=2)),
            args=[settings],
            id="event_refresh_immediate",
        )


def stop_scheduler():
    if scheduler.running:
        scheduler.shutdown(wait=False)
