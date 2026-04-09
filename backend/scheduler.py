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
    from scrapers.sesc import fetch_events as sesc_fetch
    from scrapers.prefeitura import fetch_events as prefeitura_fetch
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

    # ── SESC Paraná (free/low-cost cultural events — no credentials needed) ──
    log_id = db.log_refresh_start("sesc")
    try:
        sesc_events = await sesc_fetch(city=city, anthropic_api_key=settings.anthropic_api_key)
        all_raws.extend(sesc_events)
        db.log_refresh_finish(log_id, events_new=len(sesc_events), events_updated=0)
        log.info(f"  SESC: {len(sesc_events)} eventos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  SESC falhou: {e}")

    # ── Teatro Guaíra (major Curitiba cultural center — concerts, ballet, theatre) ──
    log_id = db.log_refresh_start("teatro_guaira")
    try:
        pref_events = await prefeitura_fetch(city=city)
        all_raws.extend(pref_events)
        db.log_refresh_finish(log_id, events_new=len(pref_events), events_updated=0)
        log.info(f"  Teatro Guaíra: {len(pref_events)} eventos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Teatro Guaíra falhou: {e}")

    # ── Catraca Livre (free/low-cost event aggregator — WordPress API) ──
    from scrapers.catraca_livre import fetch_events as catraca_fetch
    log_id = db.log_refresh_start("catraca_livre")
    try:
        cl_events = await catraca_fetch(anthropic_api_key=settings.anthropic_api_key, city=city)
        all_raws.extend(cl_events)
        db.log_refresh_finish(log_id, events_new=len(cl_events), events_updated=0)
        log.info(f"  Catraca Livre: {len(cl_events)} eventos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Catraca Livre falhou: {e}")

    # ── Ingresso.com (Brazil's largest ticketing platform — JSON-LD extraction) ──
    from scrapers.ingresso import fetch_events as ingresso_fetch
    log_id = db.log_refresh_start("ingresso")
    try:
        ing_events = await ingresso_fetch(city=city)
        all_raws.extend(ing_events)
        db.log_refresh_finish(log_id, events_new=len(ing_events), events_updated=0)
        log.info(f"  Ingresso.com: {len(ing_events)} eventos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Ingresso.com falhou: {e}")

    if not all_raws:
        log.warning("Nenhum evento bruto encontrado — nada para enriquecer.")
        return

    # ── Enriquecimento com Claude ──
    log.info(f"  Enriquecendo {len(all_raws)} eventos com Claude Haiku...")
    enriched = pipeline.enrich_batch(all_raws, max_events=50)

    # ── Persistência ──
    saved = 0
    for ev in enriched:
        try:
            db.upsert_event(ev)
            saved += 1
        except Exception as e:
            log.warning(f"  Erro ao salvar '{ev.name}': {e}")

    # ── AI gap-fill: generate synthetic events when DB is sparse ──
    upcoming = db.count_upcoming_events(city)
    if upcoming < 15 and settings.anthropic_api_key:
        log.info(f"  Apenas {upcoming} eventos futuros — ativando gap-fill por IA...")
        try:
            generated_raws = pipeline.generate_events(city=city, count=15)
            generated_enriched = pipeline.enrich_batch(generated_raws, max_events=15)
            for ev in generated_enriched:
                try:
                    db.upsert_event(ev)
                    saved += 1
                except Exception as e:
                    log.warning(f"  Erro ao salvar evento gerado '{ev.name}': {e}")
            log.info(f"  Gap-fill: {len(generated_enriched)} eventos gerados pela IA")
        except Exception as e:
            log.error(f"  Gap-fill por IA falhou: {e}")

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
