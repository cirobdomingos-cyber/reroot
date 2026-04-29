"""
Sympla enrichment scraper.

Different shape from the discovery scrapers we removed in Apr 2026: this
module never adds events to the catalog. It walks Sympla's Curitiba
discovery feed, parses each event page's __NEXT_DATA__ Next.js hydration
blob, and returns raw dicts that the matching layer (sympla_match) joins
against existing IG-sourced catalog events to attach a `sympla_url`
buy-link.

Why this is fine even though the discovery feed is noisy:
- We never store unmatched Sympla events. False positives can't pollute
  the catalog because no rows are written from this path.
- We only need the events that do match an IG event we already track —
  those are the ones a user might click "🎟️ Comprar ingresso" on.

Sympla blocks aggressive scraping; the cap of 60 event-page fetches
protects us from getting rate-limited and from runaway runtime.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx

# Brazil is UTC-3 year-round (no DST since 2019).
BR_TZ = timezone(timedelta(hours=-3))

log = logging.getLogger(__name__)

# Discovery pages we crawl for event URLs. The same set we used in the
# original scraper — broad coverage prevents one category dominating.
DISCOVERY_URLS = [
    "https://www.sympla.com.br/eventos/curitiba-pr",
    "https://www.sympla.com.br/eventos/curitiba-pr?d=upcoming",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=festas-e-shows",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=gastronomia",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=teatros-espetaculos-e-cinema",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=arte-cinema-e-lazer",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=infantil",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=passeios-e-tours",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=games-e-geek",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=saude-e-bem-estar",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=cursos-e-workshops",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=esportes",
]

# Curitiba metro region — the city gate accepts these so a Pinhais show
# isn't dropped just because the venue is technically outside CWB proper.
_CURITIBA_REGION = {
    "curitiba",
    "pinhais", "são josé dos pinhais", "sao jose dos pinhais",
    "araucária", "araucaria", "colombo",
    "almirante tamandaré", "almirante tamandare",
    "campo largo", "piraquara", "fazenda rio grande", "lapa",
    "quatro barras", "campina grande do sul", "rio branco do sul",
    "mandirituba", "tijucas do sul", "contenda", "itaperuçu", "itaperucu",
}

# Cities the Sympla discovery feed has historically leaked. Even when
# the event is tagged "Curitiba", the venue text often gives away that
# it's in Joaçaba/Florianópolis/etc. Catching at ingest is cheaper than
# re-checking on every match attempt downstream.
_NON_CURITIBA_VENUE_TOKENS = (
    "vacaria", "caçador", "cacador", "joaçaba", "joacaba",
    "concórdia", "concordia", "videira", "canoinhas", "rio do sul",
    "toledo", "londrina", "maringá", "maringa",
    "florianópolis", "florianopolis", "porto alegre",
    "são paulo", "sao paulo", "rio de janeiro",
    "lages", "blumenau", "joinville", "chapecó", "chapeco",
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
    ),
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,*/*",
}

EVENT_URL_PATTERN = re.compile(
    r'href="(https://www\.sympla\.com\.br/evento/[^"]+)"'
)

_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.+?)</script>',
    re.DOTALL,
)

# Cap fetches per run so a slow cold start can't burn five minutes
# scraping. 60 event pages × ~1s each = 60s ceiling.
_MAX_EVENT_PAGES = 60


def fetch_curitiba_events(max_pages: int = _MAX_EVENT_PAGES) -> list[dict]:
    """Walk Sympla's CWB discovery feed and return event dicts shaped for
    the matching layer:

        {
            "name": str,
            "date_start": datetime (BR_TZ aware),
            "date_end": datetime | None,
            "venue_name": str,
            "venue_address": str,
            "city": str,
            "url": str,         # canonical sympla.com.br/evento/<slug> URL
            "image_url": str,
        }

    Returns only events that pass the Curitiba-region city + venue gates.
    Past events (start < now) are dropped — we never want to attach a
    buy-link to a show that already happened.
    """
    seen_urls: set[str] = set()
    event_urls: list[str] = []

    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        # Phase 1 — collect event URLs from discovery pages.
        for disc_url in DISCOVERY_URLS:
            try:
                resp = client.get(disc_url, headers=HEADERS)
                if resp.status_code != 200:
                    continue
                for match in EVENT_URL_PATTERN.finditer(resp.text):
                    url = match.group(1).split("?", 1)[0]
                    if url not in seen_urls:
                        seen_urls.add(url)
                        event_urls.append(url)
            except Exception as e:
                log.warning("sympla discovery page failed (%s): %s", disc_url, e)

        log.info("sympla: %d unique event URLs from discovery feed", len(event_urls))
        if not event_urls:
            return []

        # Phase 2 — fetch each event page, parse __NEXT_DATA__.
        out: list[dict] = []
        skipped_other_city = 0
        skipped_other_venue = 0
        skipped_no_data = 0
        skipped_past = 0
        now_br = datetime.now(BR_TZ)
        for url in event_urls[:max_pages]:
            try:
                resp = client.get(url, headers=HEADERS)
                if resp.status_code != 200:
                    continue
                parsed = _parse_next_data(resp.text, url)
                if not parsed:
                    skipped_no_data += 1
                    continue
                if parsed["date_start"] < now_br:
                    skipped_past += 1
                    continue
                ev_city = (parsed.get("city") or "").strip().lower()
                if ev_city and ev_city not in _CURITIBA_REGION:
                    skipped_other_city += 1
                    continue
                venue_blob = (
                    f"{parsed.get('venue_name', '')} {parsed.get('venue_address', '')}"
                ).lower()
                if any(tok in venue_blob for tok in _NON_CURITIBA_VENUE_TOKENS):
                    skipped_other_venue += 1
                    continue
                out.append(parsed)
            except Exception as e:
                log.warning("sympla event page failed (%s): %s", url[:60], e)

    log.info(
        "sympla: %d events extracted (%d wrong city, %d wrong venue, %d unparseable, %d past)",
        len(out), skipped_other_city, skipped_other_venue, skipped_no_data, skipped_past,
    )
    return out


def _parse_next_data(html: str, page_url: str) -> dict | None:
    """Extract event data from the Next.js __NEXT_DATA__ hydration blob.

    Schema (verified against live Sympla event pages):
        props.pageProps.hydrationData.eventHydration.event
            .name, .startDate, .endDate, .strippedDetail, .id, .logoUrl
            .eventsAddress.{name, address, city}
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
        if not date_start:
            return None
        date_end = _parse_sympla_date(ev.get("endDate"))
        addr = ev.get("eventsAddress") or {}
        if not isinstance(addr, dict):
            addr = {}
        return {
            "name": name,
            "date_start": date_start,
            "date_end": date_end,
            "venue_name": (addr.get("name") or "").strip(),
            "venue_address": (addr.get("address") or "").strip(),
            "city": (addr.get("city") or "").strip(),
            "url": page_url,
            "image_url": ev.get("logoUrl") or "",
        }
    except Exception as e:
        log.warning("sympla __NEXT_DATA__ parse error (%s): %s", page_url[:60], e)
        return None


def _parse_sympla_date(s) -> datetime | None:
    """Parse '2026-04-18 15:00:00' naive timestamps as Brazil-local."""
    if not s or not isinstance(s, str):
        return None
    try:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
        return dt.replace(tzinfo=BR_TZ)
    except ValueError:
        return None
