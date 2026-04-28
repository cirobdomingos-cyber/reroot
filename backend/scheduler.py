"""
Scheduler de refresh — APScheduler.
Roda diariamente às 14:00 (America/Sao_Paulo). No boot do FastAPI, dispara
um refresh imediato apenas se o último refresh foi há mais de 24h — assim
deploys frequentes no Railway não detonam o pipeline de scrape + Claude.
"""
import logging
from collections import defaultdict
from datetime import datetime, timezone
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# América/São_Paulo — timezone do scheduler. O cron diário usa este TZ.
SCHEDULER_TZ = "America/Sao_Paulo"
DAILY_REFRESH_HOUR = 14
DAILY_REFRESH_MINUTE = 0
# Janela de "frescor" para decidir se o boot dispara um refresh imediato.
# Se o último refresh foi há menos disso, o boot é silencioso.
BOOT_REFRESH_SKIP_HOURS = 24

log = logging.getLogger(__name__)
scheduler = AsyncIOScheduler(timezone=SCHEDULER_TZ)


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
    # Instagram scraping now goes through Apify, not the instaloader-based
    # scraper. The old module is kept for reference but no longer wired up.
    from scrapers.instagram_apify import fetch_events as instagram_fetch
    from scrapers.sesc import fetch_events as sesc_fetch
    from scrapers.prefeitura import fetch_events as prefeitura_fetch
    from enrichment import EnrichmentPipeline
    import database as db
    from notifications import send_scrape_summary

    # Capture the start time so the post-run email summary can scope its
    # refresh_log query to rows produced by THIS run.
    run_started_iso = datetime.now().isoformat()

    city = settings.city
    log.info(f"🔄 Iniciando refresh de eventos para {city}...")
    pipeline = EnrichmentPipeline(api_key=settings.anthropic_api_key)

    all_raws = []
    # source key (matches ev.source) -> refresh_log row id, for sources whose
    # fetch succeeded. Finalized at the end with truthful new/updated counts
    # that come from the persistence loop, not from raw fetch sizes.
    pending_log_ids: dict[str, int] = {}

    # ── Sympla (no city filter — API returns few results, accept all) ──
    log_id = db.log_refresh_start("sympla")
    try:
        sympla_events = await sympla_fetch(settings.sympla_token, city="")
        all_raws.extend(sympla_events)
        pending_log_ids["sympla"] = log_id
        log.info(f"  Sympla: {len(sympla_events)} eventos brutos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Sympla falhou: {e}")

    # ── Eventbrite ──
    log_id = db.log_refresh_start("eventbrite")
    try:
        eb_events = await eventbrite_fetch(settings.eventbrite_token, city=city)
        all_raws.extend(eb_events)
        pending_log_ids["eventbrite"] = log_id
        log.info(f"  Eventbrite: {len(eb_events)} eventos brutos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Eventbrite falhou: {e}")

    # ── Meetup (public GraphQL API — no key needed) ──
    log_id = db.log_refresh_start("meetup")
    try:
        meetup_events = await meetup_fetch(city=city)
        all_raws.extend(meetup_events)
        pending_log_ids["meetup"] = log_id
        log.info(f"  Meetup: {len(meetup_events)} eventos brutos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Meetup falhou: {e}")

    # ── Instagram via Apify (Claude extracts events from public profile posts) ──
    log_id = db.log_refresh_start("instagram")
    try:
        ig_events = await instagram_fetch(
            anthropic_api_key=settings.anthropic_api_key,
            apify_token=settings.apify_api_token,
        )
        all_raws.extend(ig_events)
        pending_log_ids["instagram"] = log_id
        log.info(f"  Instagram (Apify): {len(ig_events)} eventos extraídos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Instagram (Apify) falhou: {e}")

    # ── SESC Paraná (free/low-cost cultural events — no credentials needed) ──
    log_id = db.log_refresh_start("sesc")
    try:
        sesc_events = await sesc_fetch(city=city, anthropic_api_key=settings.anthropic_api_key)
        all_raws.extend(sesc_events)
        pending_log_ids["sesc"] = log_id
        log.info(f"  SESC: {len(sesc_events)} eventos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  SESC falhou: {e}")

    # ── Teatro Guaíra (major Curitiba cultural center — concerts, ballet, theatre) ──
    log_id = db.log_refresh_start("teatro_guaira")
    try:
        pref_events = await prefeitura_fetch(city=city)
        all_raws.extend(pref_events)
        pending_log_ids["teatro_guaira"] = log_id
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
        pending_log_ids["catraca_livre"] = log_id
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
        pending_log_ids["ingresso"] = log_id
        log.info(f"  Ingresso.com: {len(ing_events)} eventos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Ingresso.com falhou: {e}")

    # ── MON (Museu Oscar Niemeyer — long-running exhibitions, perfect Reroot fit) ──
    from scrapers.mon import fetch_events as mon_fetch
    log_id = db.log_refresh_start("mon")
    try:
        mon_events = await mon_fetch(city=city)
        all_raws.extend(mon_events)
        pending_log_ids["mon"] = log_id
        log.info(f"  MON: {len(mon_events)} exposições")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  MON falhou: {e}")

    # ── Turismo Curitiba (city tourism portal — broad mix of events) ──
    from scrapers.turismo_curitiba import fetch_events as turismo_fetch
    log_id = db.log_refresh_start("turismo_curitiba")
    try:
        tur_events = await turismo_fetch(city=city)
        all_raws.extend(tur_events)
        pending_log_ids["turismo_curitiba"] = log_id
        log.info(f"  Turismo Curitiba: {len(tur_events)} eventos")
    except Exception as e:
        db.log_refresh_finish(log_id, events_new=0, events_updated=0, error=str(e))
        log.error(f"  Turismo Curitiba falhou: {e}")

    if not all_raws:
        log.warning("Nenhum evento bruto encontrado — nada para enriquecer.")
        # Finalize remaining (successful but empty) source rows so the email
        # shows them as "ran, 0 new, 0 updated" instead of leaving started_at
        # without a finished_at.
        for log_id in pending_log_ids.values():
            db.log_refresh_finish(log_id, events_new=0, events_updated=0)
        return

    # ── Enriquecimento com Claude ──
    log.info(f"  Enriquecendo {len(all_raws)} eventos com Claude Haiku...")
    enriched = pipeline.enrich_batch(all_raws, max_events=50)

    # ── Persistência (com contagem real por fonte) ──
    inserts_by_source: dict[str, int] = defaultdict(int)
    updates_by_source: dict[str, int] = defaultdict(int)
    saved = 0
    for ev in enriched:
        try:
            was_new = db.upsert_event(ev)
            if was_new:
                inserts_by_source[ev.source] += 1
            else:
                updates_by_source[ev.source] += 1
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
                    was_new = db.upsert_event(ev)
                    if was_new:
                        inserts_by_source[ev.source] += 1
                    else:
                        updates_by_source[ev.source] += 1
                    saved += 1
                except Exception as e:
                    log.warning(f"  Erro ao salvar evento gerado '{ev.name}': {e}")
            log.info(f"  Gap-fill: {len(generated_enriched)} eventos gerados pela IA")
        except Exception as e:
            log.error(f"  Gap-fill por IA falhou: {e}")

    # ── Finalize per-source log rows with truthful counts ──
    for source_key, log_id in pending_log_ids.items():
        db.log_refresh_finish(
            log_id,
            events_new=inserts_by_source.get(source_key, 0),
            events_updated=updates_by_source.get(source_key, 0),
        )

    total = db.count_events()
    log.info(f"✅ Refresh concluído: {saved} eventos salvos ({total} total no banco)")

    # Best-effort summary email (silent if RESEND_API_KEY isn't set).
    try:
        await send_scrape_summary(settings, run_started_iso)
    except Exception as e:
        log.warning(f"Scrape summary email failed: {e}")


def start_scheduler(settings, run_immediately: bool = True):
    """Daily refresh at 14:00 America/Sao_Paulo. The boot-time refresh fires
    only when the catalog hasn't been refreshed in the last 24h — protects
    Anthropic + Apify quotas against deploy-induced re-scrapes."""
    import database as db

    scheduler.add_job(
        run_refresh,
        trigger="cron",
        hour=DAILY_REFRESH_HOUR,
        minute=DAILY_REFRESH_MINUTE,
        args=[settings],
        id="event_refresh",
        replace_existing=True,
    )
    scheduler.start()
    log.info(
        f"Scheduler iniciado — refresh diário às "
        f"{DAILY_REFRESH_HOUR:02d}:{DAILY_REFRESH_MINUTE:02d} ({SCHEDULER_TZ})"
    )

    if not run_immediately:
        return

    # Decide whether to fire an immediate refresh on boot. Skip when the
    # most recent refresh_log row is fresh — every Railway redeploy runs
    # this code, and we don't want each deploy to repay the full pipeline.
    last_started = db.get_last_refresh_started_at()
    if last_started:
        try:
            last_dt = datetime.fromisoformat(last_started)
            if last_dt.tzinfo is None:
                # log_refresh_start writes datetime.now().isoformat() (naive
                # local time on the server). Treat it as UTC for the age
                # comparison — Railway runs in UTC, so this is accurate
                # there; on dev boxes the worst case is a slightly off skip
                # window, never a false skip after the cron has actually
                # run on prod.
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            age_hours = (
                datetime.now(timezone.utc) - last_dt.astimezone(timezone.utc)
            ).total_seconds() / 3600
            if age_hours < BOOT_REFRESH_SKIP_HOURS:
                log.info(
                    f"Último refresh foi há {age_hours:.1f}h — pulando "
                    f"refresh de boot (cron diário cuidará do próximo)."
                )
                return
        except Exception as e:
            log.warning(f"Não foi possível avaliar último refresh ({e}) — disparando refresh de boot mesmo assim.")

    # No fresh refresh on record — kick off a one-shot in 2s so FastAPI
    # finishes booting first.
    from apscheduler.triggers.date import DateTrigger
    from datetime import timedelta
    scheduler.add_job(
        run_refresh,
        trigger=DateTrigger(run_date=datetime.now(timezone.utc) + timedelta(seconds=2)),
        args=[settings],
        id="event_refresh_immediate",
    )
    log.info("Refresh de boot disparado (último refresh ausente ou >24h).")


def stop_scheduler():
    if scheduler.running:
        scheduler.shutdown(wait=False)
