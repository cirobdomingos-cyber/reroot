"""
Meetup.com web scraper for local events.

Meetup's API (both GraphQL and REST) requires authentication now.
Instead, we scrape the public /find/ page which embeds event data
in a Next.js __NEXT_DATA__ JSON blob (Apollo cache).

Portfolio signal: this is a practical SSR scraping pattern. Many modern
sites use Next.js/Nuxt and embed their data in __NEXT_DATA__ — knowing
this trick means you can extract structured data without an API.
"""
import httpx
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from models import RawEvent

log = logging.getLogger(__name__)

FIND_URL = "https://www.meetup.com/find/"

# Location slugs for Meetup's /find/ page
CITY_SLUGS = {
    "Curitiba": "br--Curitiba",
    "São Paulo": "br--São Paulo",
    "Rio de Janeiro": "br--Rio de Janeiro",
}

# Meetup category IDs that align with Reroot's mission
REROOT_CATEGORIES = [
    "",                    # all categories (default page)
    "outdoors-adventure",
    "arts-culture",
    "health-wellbeing",
    "sports-fitness",
    "food-drink",
    "social-activities",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
}


async def fetch_events(city: str = "Curitiba", days_ahead: int = 30) -> list[RawEvent]:
    """
    Scrape Meetup's /find/ page for events near a city.

    The page embeds Apollo cache in __NEXT_DATA__ with full event objects.
    We hit multiple category pages to maximize coverage since each page
    only returns a handful of SSR'd events.
    """
    location = CITY_SLUGS.get(city, f"br--{city}")
    seen_ids: set[str] = set()
    all_events: list[RawEvent] = []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for cat in REROOT_CATEGORIES:
            params = {
                "location": location,
                "source": "EVENTS",
                "eventType": "inPerson",
            }
            if cat:
                params["categoryId"] = cat

            try:
                resp = await client.get(FIND_URL, params=params, headers=HEADERS)
                if resp.status_code != 200:
                    log.warning(f"Meetup [{cat or 'all'}] HTTP {resp.status_code}")
                    continue

                events = _extract_events(resp.text)
                new = 0
                for ev in events:
                    if ev.external_id not in seen_ids:
                        seen_ids.add(ev.external_id)
                        all_events.append(ev)
                        new += 1

                if new:
                    log.info(f"  Meetup [{cat or 'all':20s}]: {new} new events")

            except httpx.TimeoutException:
                log.warning(f"Meetup [{cat or 'all'}] timed out")
            except Exception as e:
                log.warning(f"Meetup [{cat or 'all'}] failed: {e}")

    log.info(f"Meetup: {len(all_events)} unique events scraped from {city}")
    return all_events


def _extract_events(html: str) -> list[RawEvent]:
    """Extract Event objects from the __NEXT_DATA__ Apollo cache."""
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html)
    if not match:
        return []

    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []

    apollo = data.get("props", {}).get("pageProps", {}).get("__APOLLO_STATE__", {})

    events = []
    for key, val in apollo.items():
        if isinstance(val, dict) and val.get("__typename") == "Event":
            parsed = _parse_event(val)
            if parsed:
                events.append(parsed)

    return events


def _parse_event(node: dict) -> RawEvent | None:
    """Convert an Apollo cache Event object to RawEvent."""
    try:
        title = (node.get("title") or "").strip()
        if not title:
            return None

        # Parse dates
        dt_str = node.get("dateTime", "")
        date_start = _parse_datetime(dt_str)
        if not date_start:
            return None

        date_end = _parse_datetime(node.get("endTime")) if node.get("endTime") else None

        # Venue — embedded directly in Apollo Event objects
        venue = node.get("venue") or {}
        if isinstance(venue, dict) and venue.get("__ref"):
            # Sometimes it's a reference, not inline — skip those
            venue = {}

        venue_name = venue.get("name", "") or ""
        venue_address = venue.get("address", "") or ""
        city = venue.get("city", "") or ""

        # Fee info — may or may not be present
        fee = node.get("feeSettings") or {}
        if isinstance(fee, dict) and fee.get("__ref"):
            fee = {}
        price = float(fee.get("amount", 0) or 0)
        currency = fee.get("currency", "BRL") or "BRL"

        # Group info
        group = node.get("group") or {}
        if isinstance(group, dict) and group.get("__ref"):
            group = {}

        description = _clean_text(node.get("description", "") or "")

        return RawEvent(
            source="meetup",
            external_id=str(node.get("id", "")),
            name=title,
            description=description,
            venue_name=venue_name or group.get("name", ""),
            venue_address=venue_address,
            neighborhood=None,
            city=city,
            date_start=date_start,
            date_end=date_end,
            price_min=price,
            price_max=price,
            currency=currency,
            capacity=node.get("maxTickets"),
            attendees_confirmed=node.get("going", 0) or 0,
            url=node.get("eventUrl", "") or "",
            image_url=node.get("imageUrl"),
        )
    except Exception as e:
        log.warning(f"Meetup parse error for event {node.get('id')}: {e}")
        return None


def _parse_datetime(dt_str: str | None) -> datetime | None:
    if not dt_str:
        return None
    try:
        return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
    except ValueError:
        log.warning(f"Meetup: could not parse datetime '{dt_str}'")
        return None


def _clean_text(text: str) -> str:
    """Strip markdown/HTML and normalize whitespace."""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\\n", "\n", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()[:1000]
