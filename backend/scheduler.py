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
      1. Busca eventos via Instagram (Apify scraper + Claude extração)
      2. Enriquece com Claude
      3. Persiste no SQLite

    Apr 2026: dropped every institutional/web scraper. The IG side covers
    the same venues with way better signal — equivalent IG handles for
    each removed source are already tracked: @museuoscarniemeyer (was MON),
    @teatroguaira (was Teatro Guaíra), @sescpr-style handles (was SESC),
    plus dozens more curated venues that the institutional sites never
    surfaced. Eventbrite/Sympla/Catraca/Ingresso/Meetup/Turismo all dropped
    over multiple PRs because the yields were near zero for our public.
    """
    # Imports aqui para evitar circular imports
    from scrapers.instagram_apify import fetch_events as instagram_fetch
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
    new_event_ids: list[str] = []
    saved = 0
    for ev in enriched:
        try:
            was_new = db.upsert_event(ev)
            if was_new:
                inserts_by_source[ev.source] += 1
                new_event_ids.append(ev.id)
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
                        new_event_ids.append(ev.id)
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

    # Seed the venues cache with any new venue names the scrape introduced.
    # Geocoding itself is async + rate-limited, so we don't run Nominatim
    # here — the curator/founder triggers /admin/venues/geocode when they
    # want pins to fill in. This call is just "make sure the rows exist".
    try:
        new_venues = db.seed_venues_from_events()
        if new_venues:
            log.info(f"  Venues cache: {new_venues} novos pendentes de geocoding")
    except Exception as e:
        log.warning(f"  seed_venues_from_events falhou: {e}")

    # Best-effort summary email (silent if RESEND_API_KEY isn't set).
    try:
        await send_scrape_summary(settings, run_started_iso, new_event_ids)
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
