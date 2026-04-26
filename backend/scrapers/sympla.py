"""
Sympla discovery page scraper for Curitiba events.

Background: the Sympla public API v3 (/public/v3/events) only returns events
owned by the authenticated organizer — useless for discovery. The earlier
strategy parsed JSON-LD Event blocks from each page; Sympla has since removed
JSON-LD from event pages and the OG fallback was filling the database with
geographically wrong events (the curitiba-pr discovery feed itself leaks
events from Joaçaba/Videira/Lages).

Current strategy:
1. Scrape discovery pages for event URLs.
2. For each event page, parse the embedded `__NEXT_DATA__` Next.js hydration
   blob — that has authoritative city, dates, venue, and a stripped plain-text
   description. No JSON-LD, no OG fallback (both lie about location).
3. Drop anything whose city != target city, case-insensitive.
"""
import json
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx
from models import RawEvent

# Brazil is UTC-3 year-round (no DST since 2019).
BR_TZ = timezone(timedelta(hours=-3))

log = logging.getLogger(__name__)

DISCOVERY_URLS = [
    # Default discovery + chronological listing
    "https://www.sympla.com.br/eventos/curitiba-pr",
    "https://www.sympla.com.br/eventos/curitiba-pr?d=upcoming",
    # Category-specific listings — broaden coverage so the catalog isn't
    # dominated by whichever category Sympla featured that day.
    "https://www.sympla.com.br/eventos/curitiba-pr?c=festas-e-shows",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=gastronomia",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=cursos-e-workshops",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=esportes",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=teatros-espetaculos-e-cinema",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=arte-cinema-e-lazer",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=infantil",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=passeios-e-tours",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=games-e-geek",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=saude-e-bem-estar",
]

# Curitiba metro region — used to relax the city-equality check.
# Many Sympla events are tagged "Curitiba" while their venue is in another
# city, so we keep the explicit deny-list for venue/address screening.
_CURITIBA_REGION = {
    "curitiba",
    "pinhais", "são josé dos pinhais", "sao jose dos pinhais", "araucária",
    "araucaria", "colombo", "almirante tamandaré", "almirante tamandare",
    "campo largo", "piraquara", "fazenda rio grande", "lapa",
    "quatro barras", "campina grande do sul", "rio branco do sul",
    "mandirituba", "tijucas do sul", "contenda", "itaperuçu", "itaperucu",
}

# Cities the Sympla discovery feed has historically leaked. Even when Sympla
# itself tags the event "Curitiba", the venue text gives it away. Catching
# these at ingest is cheaper than re-checking on every API call.
_NON_CURITIBA_VENUE_TOKENS = (
    "vacaria", "caçador", "cacador", "joaçaba", "joacaba", "concórdia",
    "concordia", "videira", "canoinhas", "rio do sul", "toledo",
    "londrina", "maringá", "maringa", "florianópolis", "florianopolis",
    "porto alegre", "são paulo", "sao paulo", "rio de janeiro",
    "lages", "blumenau", "joinville", "chapecó", "chapeco",
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,*/*",
}

EVENT_URL_PATTERN = re.compile(
    r'href="(https://www\.sympla\.com\.br/evento/[^"]+)"'
)


async def fetch_events(token: str = "", city: str = "Curitiba", days_ahead: int = 30) -> list[RawEvent]:
    """Scrape Sympla discovery pages, then fetch JSON-LD from each event page."""
    seen_urls: set[str] = set()
    event_urls: list[str] = []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        # Phase 1: Collect event URLs from discovery pages
        for disc_url in DISCOVERY_URLS:
            try:
                resp = await client.get(disc_url, headers=HEADERS)
                if resp.status_code != 200:
                    continue
                for match in EVENT_URL_PATTERN.finditer(resp.text):
                    url = match.group(1).split("?")[0]  # strip query params
                    if url not in seen_urls:
                        seen_urls.add(url)
                        event_urls.append(url)
            except Exception as e:
                log.warning(f"Sympla discovery page failed: {e}")

        log.info(f"Sympla: found {len(event_urls)} unique event URLs")
        if not event_urls:
            return []

        # Phase 2: Fetch each event page and parse the __NEXT_DATA__ hydration blob.
        all_events: list[RawEvent] = []
        skipped_other_city = 0
        skipped_other_venue = 0
        skipped_no_data = 0
        for url in event_urls[:60]:  # cap to avoid hammering
            try:
                resp = await client.get(url, headers=HEADERS)
                if resp.status_code != 200:
                    continue
                parsed = _parse_next_data(resp.text, url)
                if not parsed:
                    skipped_no_data += 1
                    continue

                ev_city = (parsed.city or "").strip().lower()
                # First gate: when Sympla gives us a city, it must be Curitiba
                # or RMC. Empty city is allowed through to the venue gate.
                if ev_city and ev_city not in _CURITIBA_REGION:
                    skipped_other_city += 1
                    continue
                # Second gate: even if Sympla says "Curitiba", the venue text
                # often reveals the real location (e.g. "Faculdade Senac Caçador").
                venue_blob = (
                    f"{parsed.venue_name or ''} {parsed.venue_address or ''}"
                ).lower()
                if any(token in venue_blob for token in _NON_CURITIBA_VENUE_TOKENS):
                    skipped_other_venue += 1
                    continue

                all_events.append(parsed)
            except Exception as e:
                log.warning(f"Sympla event page failed ({url[:50]}): {e}")

    log.info(
        f"Sympla: {len(all_events)} events extracted "
        f"({skipped_other_city} dropped for wrong city, "
        f"{skipped_other_venue} dropped for non-Curitiba venue, "
        f"{skipped_no_data} unparseable)"
    )
    return all_events


_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.+?)</script>',
    re.DOTALL,
)


def _parse_next_data(html: str, page_url: str) -> RawEvent | None:
    """Extract event data from the __NEXT_DATA__ Next.js hydration blob.

    Schema (verified against live pages):
        props.pageProps.hydrationData.eventHydration.event
            .name, .startDate, .endDate, .strippedDetail, .id, .logoUrl
            .eventsAddress.{name, address, city}
            .paymentEventType  ('paid' | 'unpaid')
    """
    m = _NEXT_DATA_RE.search(html)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
        ev = (
            data.get("props", {})
                .get("pageProps", {})
                .get("hydrationData", {})
                .get("eventHydration", {})
                .get("event", {})
        )
        if not ev:
            return None

        name = (ev.get("name") or "").strip()
        if not name:
            return None

        date_start = _parse_sympla_date(ev.get("startDate"))
        date_end = _parse_sympla_date(ev.get("endDate"))
        if not date_start:
            return None
        # Drop past events. startDate is naive Brazil-local; we localize in
        # the parser. Compare against now() in the same TZ.
        if date_start < datetime.now(BR_TZ):
            return None

        addr = ev.get("eventsAddress") or {}
        if not isinstance(addr, dict):
            addr = {}
        venue_name = (addr.get("name") or "").strip()
        venue_address = (addr.get("address") or "").strip()
        city = (addr.get("city") or "").strip()

        # strippedDetail is the plain-text version of `detail` (which is HTML).
        # Always prefer it — saves us from running an HTML cleaner downstream.
        desc = (ev.get("strippedDetail") or "").strip()[:1000]

        external_id = str(ev.get("id") or _slug(page_url))
        is_free = (ev.get("paymentEventType") or "").lower() == "unpaid"

        image = ev.get("logoUrl") or ""

        return RawEvent(
            source="sympla",
            external_id=f"sympla_{external_id}",
            name=name,
            description=desc,
            venue_name=venue_name,
            venue_address=venue_address,
            neighborhood=None,
            city=city or "",  # leave empty if missing — caller filters
            date_start=date_start,
            date_end=date_end,
            price_min=0.0,
            price_max=0.0 if is_free else 0.0,  # Sympla doesn't expose ticket prices in __NEXT_DATA__; treat as unknown
            currency="BRL",
            capacity=None,
            attendees_confirmed=None,
            url=page_url,
            image_url=image if isinstance(image, str) and image else None,
        )
    except Exception as e:
        log.warning(f"Sympla __NEXT_DATA__ parse error for {page_url[:50]}: {e}")
        return None


def _parse_sympla_date(s) -> datetime | None:
    """Parse Sympla's '2026-04-18 15:00:00' naive timestamps as Brazil time."""
    if not s or not isinstance(s, str):
        return None
    try:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        return dt.replace(tzinfo=BR_TZ)
    except ValueError:
        return None


def _slug(url: str) -> str:
    parts = url.rstrip("/").split("/")
    return parts[-1][:60] if parts else "unknown"
