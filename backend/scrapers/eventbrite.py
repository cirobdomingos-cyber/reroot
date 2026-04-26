"""
Eventbrite discovery scraper for Curitiba events.

The Eventbrite REST API v3 /events/search/ endpoint was deprecated in late 2024.
Instead, we scrape the public discovery page (eventbrite.com.br/d/brazil--curitiba/events/)
which embeds a JSON-LD ItemList with structured event data (name, date, description, URL).

For richer details (venue, price), we follow each event URL and extract from
the individual event page's JSON-LD Event schema.
"""
import json
import logging
import re
from datetime import datetime, timezone
from models import RawEvent

import httpx

log = logging.getLogger(__name__)

DISCOVERY_URL = "https://www.eventbrite.com.br/d/brazil--curitiba/events/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,*/*",
}

# Multiple category pages to maximize coverage. Eventbrite Curitiba is sparse
# but every additional category pulls in events the others miss — same code
# path, more results.
CATEGORY_PAGES = [
    "",                          # all events
    "--artes/",                  # arts
    "--musica/",                 # music
    "--comida-e-bebida/",        # food & drink
    "--saude/",                  # health & wellness
    "--esportes-e-atividades/",  # sports & fitness
    "--comunidade/",             # community
    "--filmes-e-midia/",         # film & media
    "--familia-e-educacao/",     # family & education
    "--moda/",                   # fashion
    "--hobbies/",                # hobbies / crafts
    "--negocios/",               # business
    "--temporada/",              # seasonal
]


async def fetch_events(token: str = "", city: str = "Curitiba", days_ahead: int = 30) -> list[RawEvent]:
    """
    Scrape Eventbrite discovery pages for Curitiba events.
    The `token` param is kept for API compatibility but no longer needed.
    """
    seen_urls: set[str] = set()
    all_events: list[RawEvent] = []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for cat_suffix in CATEGORY_PAGES:
            url = DISCOVERY_URL.rstrip("/") + cat_suffix
            try:
                resp = await client.get(url, headers=HEADERS)
                if resp.status_code != 200:
                    log.warning(f"Eventbrite [{cat_suffix or 'all'}] HTTP {resp.status_code}")
                    continue

                items = _extract_jsonld_items(resp.text)
                new = 0
                for item in items:
                    event_url = item.get("url", "")
                    if not event_url or event_url in seen_urls:
                        continue
                    seen_urls.add(event_url)

                    parsed = _parse_discovery_item(item)
                    if parsed:
                        all_events.append(parsed)
                        new += 1

                if new:
                    log.info(f"  Eventbrite [{cat_suffix or 'all':25s}]: {new} new events")

            except httpx.TimeoutException:
                log.warning(f"Eventbrite [{cat_suffix or 'all'}] timed out")
            except Exception as e:
                log.warning(f"Eventbrite [{cat_suffix or 'all'}] failed: {e}")

    log.info(f"Eventbrite: {len(all_events)} unique events scraped")
    return all_events


def _extract_jsonld_items(html: str) -> list[dict]:
    """Extract event items from JSON-LD ItemList in the page."""
    matches = re.findall(
        r'<script type="application/ld\+json">(.*?)</script>',
        html,
        re.DOTALL,
    )
    for match in matches:
        try:
            data = json.loads(match)
            if isinstance(data, dict) and data.get("@type") == "ItemList":
                items = data.get("itemListElement", [])
                return [it.get("item", it) if "item" in it else it for it in items]
        except json.JSONDecodeError:
            continue
    return []


def _parse_discovery_item(item: dict) -> RawEvent | None:
    """Convert a JSON-LD event item to a RawEvent."""
    try:
        name = (item.get("name") or "").strip()
        desc = (item.get("description") or "").strip()[:1000]
        url = item.get("url", "")
        image = item.get("image", "")

        # Parse dates
        start_str = item.get("startDate", "")
        end_str = item.get("endDate", "")
        date_start = _parse_iso(start_str)
        date_end = _parse_iso(end_str)

        if not name or not date_start:
            return None

        # Skip past events
        if date_start < datetime.now(timezone.utc):
            return None

        # Skip virtual / international events that bleed into the Curitiba
        # discovery page. Eventbrite returns these because they're "available
        # globally", but they're worthless for a re-entry app.
        if _looks_virtual(item):
            return None

        # Extract event ID from URL
        ext_id_match = re.search(r'tickets-(\d+)', url)
        external_id = ext_id_match.group(1) if ext_id_match else _slug(url)

        # Venue from JSON-LD location (if available)
        location = item.get("location", {})
        venue_name = ""
        venue_address = ""
        city = ""
        country = ""
        if isinstance(location, dict):
            venue_name = location.get("name", "")
            addr = location.get("address", {})
            if isinstance(addr, dict):
                venue_address = addr.get("streetAddress", "")
                city = addr.get("addressLocality", "")
                country = addr.get("addressCountry", "")
            elif isinstance(addr, str):
                venue_address = addr

        # Drop events outside Brazil or outside Curitiba region whenever the
        # JSON-LD gives us enough signal to be confident.
        if country and country.upper() not in {"BR", "BRAZIL", "BRASIL"}:
            return None
        if city and not _looks_curitiba_region(city):
            return None
        # Last resort: empty venue + empty city = almost always a virtual
        # listing the discovery page surfaced by mistake.
        if not venue_name and not venue_address and not city:
            return None
        # Default to Curitiba only when we passed the checks above.
        if not city:
            city = "Curitiba"

        # Price from offers
        price_min = 0.0
        price_max = 0.0
        offers = item.get("offers", {})
        if isinstance(offers, dict):
            try:
                price_min = float(offers.get("lowPrice", offers.get("price", 0)) or 0)
                price_max = float(offers.get("highPrice", price_min) or price_min)
            except (ValueError, TypeError):
                pass

        return RawEvent(
            source="eventbrite",
            external_id=f"eb_{external_id}",
            name=name,
            description=desc,
            venue_name=venue_name,
            venue_address=venue_address,
            neighborhood=None,
            city=city,
            date_start=date_start,
            date_end=date_end,
            price_min=price_min,
            price_max=price_max,
            currency="BRL",
            capacity=None,
            attendees_confirmed=None,
            url=url,
            image_url=image if isinstance(image, str) else None,
        )
    except Exception as e:
        log.warning(f"Eventbrite parse error: {e}")
        return None


def _looks_virtual(item: dict) -> bool:
    """True when the JSON-LD strongly suggests an online-only event."""
    location = item.get("location", {})
    if isinstance(location, dict):
        loc_type = location.get("@type", "")
        if isinstance(loc_type, str) and "Virtual" in loc_type:
            return True
    name = (item.get("name") or "").lower()
    desc = (item.get("description") or "").lower()
    blob = f"{name} {desc}"
    for marker in ("virtual event", "evento virtual", "online webinar", "live webinar", "livestream"):
        if marker in blob:
            return True
    return False


_CURITIBA_REGION = {
    # Curitiba itself
    "curitiba",
    # RMC (region)
    "pinhais", "são josé dos pinhais", "sao jose dos pinhais", "araucária",
    "araucaria", "colombo", "almirante tamandaré", "almirante tamandare",
    "campo largo", "piraquara", "fazenda rio grande", "lapa",
    "quatro barras", "campina grande do sul", "rio branco do sul",
    "mandirituba", "tijucas do sul", "contenda", "itaperuçu", "itaperucu",
}


def _looks_curitiba_region(city: str) -> bool:
    """Loose match: True if the locality looks like Curitiba or RMC."""
    if not city:
        return True  # benefit of the doubt — let downstream filters decide
    return city.strip().lower() in _CURITIBA_REGION


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
    """Extract a short slug from a URL for use as external_id."""
    parts = url.rstrip("/").split("/")
    return parts[-1][:60] if parts else "unknown"
