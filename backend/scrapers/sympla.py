"""
Sympla discovery page scraper for Curitiba events.

The Sympla public API v3 (/public/v3/events) only returns events owned by the
authenticated organizer — useless for discovery. The website is a client-side
SPA with no __NEXT_DATA__ or JSON-LD, but event links are embedded in the HTML.

Strategy:
1. Scrape the discovery page for event URLs
2. Fetch each event page and extract the JSON-LD Event schema
"""
import json
import logging
import re
from datetime import datetime, timezone

import httpx
from models import RawEvent

log = logging.getLogger(__name__)

DISCOVERY_URLS = [
    "https://www.sympla.com.br/eventos/curitiba-pr",
    "https://www.sympla.com.br/eventos/curitiba-pr?d=upcoming",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=festas-e-shows",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=gastronomia",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=cursos-e-workshops",
    "https://www.sympla.com.br/eventos/curitiba-pr?c=esportes",
]

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

        # Phase 2: Fetch individual event pages for structured data
        all_events: list[RawEvent] = []
        for url in event_urls[:30]:  # cap to avoid hammering
            try:
                resp = await client.get(url, headers=HEADERS)
                if resp.status_code != 200:
                    continue
                parsed = _extract_event_from_page(resp.text, url)
                if parsed:
                    all_events.append(parsed)
            except Exception as e:
                log.warning(f"Sympla event page failed ({url[:50]}): {e}")

    log.info(f"Sympla: {len(all_events)} events extracted")
    return all_events


def _extract_event_from_page(html: str, page_url: str) -> RawEvent | None:
    """Extract event data from a Sympla event page using JSON-LD or Open Graph tags."""
    # Try JSON-LD first
    ld_matches = re.findall(
        r'<script type="application/ld\+json">(.*?)</script>',
        html, re.DOTALL,
    )
    for ld_text in ld_matches:
        try:
            data = json.loads(ld_text)
            if isinstance(data, dict) and data.get("@type") == "Event":
                return _parse_jsonld_event(data, page_url)
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and item.get("@type") == "Event":
                        return _parse_jsonld_event(item, page_url)
        except json.JSONDecodeError:
            continue

    # Fallback: Open Graph tags
    return _parse_opengraph(html, page_url)


def _parse_jsonld_event(data: dict, page_url: str) -> RawEvent | None:
    """Parse a JSON-LD Event object."""
    try:
        name = (data.get("name") or "").strip()
        desc = (data.get("description") or "").strip()[:1000]
        url = data.get("url") or page_url
        image = data.get("image", "")

        date_start = _parse_iso(data.get("startDate", ""))
        date_end = _parse_iso(data.get("endDate", ""))

        if not name or not date_start:
            return None
        if date_start < datetime.now(timezone.utc):
            return None

        # Extract external ID from URL
        ext_match = re.search(r'/(\d+)$', url)
        external_id = ext_match.group(1) if ext_match else _slug(url)

        location = data.get("location", {})
        venue_name = ""
        venue_address = ""
        city = ""
        if isinstance(location, dict):
            venue_name = location.get("name", "")
            addr = location.get("address", {})
            if isinstance(addr, dict):
                venue_address = addr.get("streetAddress", "")
                city = addr.get("addressLocality", "")

        price_min = 0.0
        offers = data.get("offers", {})
        if isinstance(offers, dict):
            try:
                price_min = float(offers.get("lowPrice", offers.get("price", 0)) or 0)
            except (ValueError, TypeError):
                pass
        elif isinstance(offers, list):
            prices = []
            for o in offers:
                try:
                    prices.append(float(o.get("price", 0) or 0))
                except (ValueError, TypeError):
                    pass
            if prices:
                price_min = min(prices)

        return RawEvent(
            source="sympla",
            external_id=f"sympla_{external_id}",
            name=name,
            description=desc,
            venue_name=venue_name,
            venue_address=venue_address,
            neighborhood=None,
            city=city or "Curitiba",
            date_start=date_start,
            date_end=date_end,
            price_min=price_min,
            price_max=price_min,
            currency="BRL",
            capacity=None,
            attendees_confirmed=None,
            url=url,
            image_url=image if isinstance(image, str) else None,
        )
    except Exception as e:
        log.warning(f"Sympla JSON-LD parse error: {e}")
        return None


def _parse_opengraph(html: str, page_url: str) -> RawEvent | None:
    """Fallback: extract event from Open Graph meta tags."""
    def og(prop):
        m = re.search(rf'<meta\s+property="og:{prop}"\s+content="([^"]*)"', html)
        return m.group(1).strip() if m else ""

    name = og("title")
    desc = og("description")[:1000]
    image = og("image")

    if not name:
        return None

    # Extract ID from URL
    ext_match = re.search(r'/(\d+)$', page_url)
    external_id = ext_match.group(1) if ext_match else _slug(page_url)

    return RawEvent(
        source="sympla",
        external_id=f"sympla_{external_id}",
        name=name,
        description=desc,
        venue_name="",
        venue_address="",
        neighborhood=None,
        city="Curitiba",
        date_start=datetime.now(timezone.utc),  # no date from OG — will be filtered later
        date_end=None,
        price_min=0.0,
        price_max=0.0,
        currency="BRL",
        capacity=None,
        attendees_confirmed=None,
        url=page_url,
        image_url=image or None,
    )


def _parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _slug(url: str) -> str:
    parts = url.rstrip("/").split("/")
    return parts[-1][:60] if parts else "unknown"
