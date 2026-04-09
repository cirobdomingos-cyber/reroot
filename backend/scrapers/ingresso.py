"""
Ingresso.com Curitiba scraper.

Ingresso.com é a maior plataforma de ingressos do Brasil. Foco em
teatro, shows, cinema e eventos culturais — bom fit com as categorias
Reroot (creative, active, community).

Strategy:
1. Scrape discovery page for event page URLs (regex on href)
2. For each event page: extract JSON-LD (schema.org/Event)
3. Fallback: parse Open Graph meta tags
"""
import json
import logging
import re
from datetime import datetime, timezone

import httpx
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://www.ingresso.com"

DISCOVERY_URLS = [
    f"{BASE_URL}/curitiba",
    f"{BASE_URL}/curitiba/teatro",
    f"{BASE_URL}/curitiba/shows-e-festivais",
    f"{BASE_URL}/curitiba/esportes",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept": "text/html,application/xhtml+xml,*/*",
}

# Match event page URLs like /curitiba/evento/slug-123 or /ingresso/slug
EVENT_URL_PATTERNS = [
    re.compile(r'href="(https://www\.ingresso\.com/[a-z\-]+/(?:evento|e)/[^"?#]+)"'),
    re.compile(r'href="(/[a-z\-]+/(?:evento|e)/[^"?#]{5,})"'),
]


async def fetch_events(
    token: str = "",
    city: str = "Curitiba",
    days_ahead: int = 30,
) -> list[RawEvent]:
    """Scrape Ingresso.com discovery pages, then fetch JSON-LD from event pages."""
    seen: set[str] = set()
    event_urls: list[str] = []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        # Phase 1 — collect event page URLs from discovery
        for disc_url in DISCOVERY_URLS:
            try:
                resp = await client.get(disc_url, headers=HEADERS)
                if resp.status_code != 200:
                    continue
                html = resp.text
                for pattern in EVENT_URL_PATTERNS:
                    for m in pattern.finditer(html):
                        url = m.group(1)
                        if not url.startswith("http"):
                            url = BASE_URL + url
                        url = url.split("?")[0]
                        if url not in seen:
                            seen.add(url)
                            event_urls.append(url)
            except Exception as e:
                log.warning(f"Ingresso discovery failed ({disc_url}): {e}")

        log.info(f"Ingresso.com: {len(event_urls)} URLs coletadas")
        if not event_urls:
            return []

        # Phase 2 — fetch individual event pages and extract structured data
        events: list[RawEvent] = []
        for url in event_urls[:25]:  # cap to avoid hammering
            try:
                resp = await client.get(url, headers=HEADERS)
                if resp.status_code != 200:
                    continue
                ev = _extract_event(resp.text, url, city)
                if ev:
                    events.append(ev)
            except Exception as e:
                log.debug(f"Ingresso event page failed ({url[:50]}): {e}")

    log.info(f"Ingresso.com: {len(events)} eventos extraídos")
    return events


def _extract_event(html: str, page_url: str, city: str) -> RawEvent | None:
    """Try JSON-LD first, then Open Graph fallback."""
    ev = _from_jsonld(html, page_url, city)
    if ev:
        return ev
    return _from_opengraph(html, page_url, city)


def _from_jsonld(html: str, page_url: str, city: str) -> RawEvent | None:
    """Extract event data from JSON-LD script tags."""
    for m in re.finditer(
        r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>',
        html, re.DOTALL,
    ):
        try:
            data = json.loads(m.group(1))
            items = data if isinstance(data, list) else [data]
            for item in items:
                if not isinstance(item, dict):
                    continue
                if item.get("@type") not in ("Event", "MusicEvent", "TheaterEvent",
                                              "SportsEvent", "VisualArtsEvent"):
                    continue
                return _parse_jsonld_event(item, page_url, city)
        except (json.JSONDecodeError, Exception):
            continue
    return None


def _parse_jsonld_event(data: dict, page_url: str, city: str) -> RawEvent | None:
    name = (data.get("name") or "").strip()
    if not name or len(name) < 3:
        return None

    date_start = _parse_iso(data.get("startDate", ""))
    if not date_start:
        return None

    # Reject past events
    if date_start < datetime.now(timezone.utc):
        return None

    url = data.get("url") or page_url
    desc = _clean_text(data.get("description") or "")[:1000]

    location = data.get("location") or {}
    if isinstance(location, list):
        location = location[0] if location else {}
    venue_name = ""
    venue_address = ""
    ev_city = ""
    if isinstance(location, dict):
        venue_name = _clean_text(location.get("name", ""))
        addr = location.get("address") or {}
        if isinstance(addr, dict):
            venue_address = _clean_text(addr.get("streetAddress", ""))
            ev_city = _clean_text(addr.get("addressLocality", ""))
        elif isinstance(addr, str):
            venue_address = _clean_text(addr)

    # Geographic filter: drop events from other cities if city is explicit
    if ev_city and city and ev_city.lower() != city.lower():
        return None

    offers = data.get("offers") or {}
    price_min, price_max = _extract_price(offers)

    ext_id_match = re.search(r"/([a-zA-Z0-9\-]{4,60})/?$", url)
    external_id = ext_id_match.group(1) if ext_id_match else _slug(name)

    image = data.get("image")
    if isinstance(image, list):
        image = image[0] if image else None
    if isinstance(image, dict):
        image = image.get("url", "")

    return RawEvent(
        source="ingresso",
        external_id=f"ig_{external_id}",
        name=name[:200],
        description=desc,
        venue_name=venue_name[:200] or "Curitiba",
        venue_address=venue_address[:300],
        city=ev_city or city,
        date_start=date_start,
        date_end=_parse_iso(data.get("endDate", "")),
        price_min=price_min,
        price_max=price_max,
        url=url,
        image_url=str(image) if image else None,
    )


def _from_opengraph(html: str, page_url: str, city: str) -> RawEvent | None:
    """Last-resort fallback: extract basic info from Open Graph meta tags."""
    def og(prop: str) -> str:
        m = re.search(
            r'<meta[^>]+property=["\']og:' + prop + r'["\'][^>]+content=["\']([^"\']+)',
            html, re.IGNORECASE,
        )
        return m.group(1).strip() if m else ""

    name = og("title")
    if not name or len(name) < 5:
        return None

    # OG fallback has no structured date — skip to avoid bad data
    return None


def _extract_price(offers) -> tuple[float, float]:
    if not offers:
        return 0.0, 0.0
    if isinstance(offers, dict):
        offers = [offers]
    prices = []
    for o in offers if isinstance(offers, list) else []:
        try:
            p = float(str(o.get("price", "0")).replace(",", "."))
            prices.append(p)
        except (ValueError, TypeError):
            pass
    if not prices:
        return 0.0, 0.0
    return min(prices), max(prices)


def _parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    s = s.strip()
    # Remove milliseconds if present
    s = re.sub(r"\.\d+", "", s)
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M%z",
                "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def _clean_text(s: str) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s)).strip()


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", s.lower())[:40]
