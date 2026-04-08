"""
Eventbrite API v3
Docs: https://www.eventbrite.com/platform/api
Token gratuito: eventbrite.com/platform/api → "Get a Free API Key"

Endpoint:
  GET https://www.eventbriteapi.com/v3/events/search/
  Params: location.address, location.within, token, expand, start_date.range_start
"""
import httpx
import logging
from datetime import datetime, timedelta, timezone
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://www.eventbriteapi.com/v3"

# Bounding box de Curitiba (aprox.)
CURITIBA_LAT = -25.4284
CURITIBA_LON = -49.2733


async def fetch_events(token: str, city: str = "Curitiba", days_ahead: int = 30) -> list[RawEvent]:
    if not token:
        log.warning("EVENTBRITE_TOKEN não configurado — pulando Eventbrite.")
        return []

    now = datetime.now(timezone.utc)
    end = now + timedelta(days=days_ahead)

    location = f"{city}, Brazil" if city else "Brazil"
    all_events: list[RawEvent] = []
    page = 1

    async with httpx.AsyncClient(timeout=15) as client:
        while True:
            try:
                resp = await client.get(
                    f"{BASE_URL}/events/search/",
                    params={
                        "token": token,
                        "location.address": location,
                        "location.within": "50km",
                        "start_date.range_start": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "start_date.range_end":   end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "expand": "venue,ticket_availability",
                        "sort_by": "date",
                        "page": page,
                    },
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                log.error(f"Eventbrite HTTP error: {e.response.status_code}")
                break
            except Exception as e:
                log.error(f"Eventbrite request failed: {e}")
                break

            data = resp.json()
            items = data.get("events", [])
            if not items:
                break

            for item in items:
                parsed = _parse(item)
                if parsed:
                    all_events.append(parsed)

            pagination = data.get("pagination", {})
            if not pagination.get("has_more_items", False):
                break
            page += 1

    log.info(f"Eventbrite: {len(all_events)} eventos encontrados (location: {location})")
    return all_events


def _parse(item: dict) -> RawEvent | None:
    try:
        venue = item.get("venue") or {}
        address = venue.get("address") or {}
        ta = item.get("ticket_availability") or {}

        start_str = item.get("start", {}).get("utc", "")
        end_str   = item.get("end",   {}).get("utc", "")

        start_dt = datetime.fromisoformat(start_str.replace("Z", "+00:00")) if start_str else None
        end_dt   = datetime.fromisoformat(end_str.replace("Z", "+00:00"))   if end_str   else None

        if not start_dt:
            return None

        # Preço
        min_price = ta.get("minimum_ticket_price", {})
        max_price = ta.get("maximum_ticket_price", {})
        price_min = float(min_price.get("major_value", 0)) if min_price else 0.0
        price_max = float(max_price.get("major_value", 0)) if max_price else 0.0
        currency  = min_price.get("currency", "BRL") if min_price else "BRL"

        desc = item.get("description", {}).get("text", "") or ""
        desc = desc[:1000]

        city = address.get("city", "") or ""

        return RawEvent(
            source="eventbrite",
            external_id=str(item["id"]),
            name=item.get("name", {}).get("text", "").strip(),
            description=desc,
            venue_name=venue.get("name", "") or "",
            venue_address=address.get("localized_address_display", ""),
            neighborhood=None,
            city=city,
            date_start=start_dt,
            date_end=end_dt,
            price_min=price_min,
            price_max=price_max,
            currency=currency,
            capacity=venue.get("capacity"),
            attendees_confirmed=None,
            url=item.get("url", ""),
            image_url=(item.get("logo") or {}).get("original", {}).get("url"),
        )
    except Exception as e:
        log.warning(f"Eventbrite parse error for item {item.get('id')}: {e}")
        return None
