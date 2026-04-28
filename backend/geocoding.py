"""
Nominatim-backed geocoding for the venues cache.

Why Nominatim: free, no API key, ToS-compliant for our scale (≤1 req/sec,
identifiable User-Agent). Mapbox/Google would be smoother but cost money
or require keys we'd rather not depend on.

Workflow:
  1. /admin/venues/geocode triggers `geocode_pending_venues` (founder-only).
  2. We pull the next N pending venues from the cache.
  3. For each, query Nominatim with "{venue}, Curitiba, PR, Brazil" plus
     the stored address as a fallback string. Sleep ≥1s between calls.
  4. Persist lat/lng + status; failures are remembered so we don't re-hit
     Nominatim for permanently-unresolvable venues every backfill pass.

Curitiba bias: we constrain results with `viewbox` + `bounded=1` so a
hit on "Bar do Cachorro" doesn't accidentally land on a São Paulo venue
with the same name. Coordinates outside ~25km of the city center are
discarded as a sanity check.
"""

import json
import logging
import time
from typing import Optional

import httpx

import database as db


log = logging.getLogger(__name__)

# Curitiba center (Praça Tiradentes) and a generous bounding box (~25 km).
# viewbox order is (left, top, right, bottom) per Nominatim docs.
_CTBA_CENTER = (-25.4284, -49.2733)
_CTBA_VIEWBOX = (-49.450, -25.300, -49.150, -25.600)
_CTBA_RADIUS_DEG = 0.30  # ~33km — pads the viewbox so edge venues don't drop


def _within_curitiba(lat: float, lng: float) -> bool:
    """Reject coordinates that fall outside our city bounding box. Catches
    Nominatim landing on a same-named venue in another city when our
    viewbox bias didn't fully constrain the result."""
    return (
        abs(lat - _CTBA_CENTER[0]) <= _CTBA_RADIUS_DEG
        and abs(lng - _CTBA_CENTER[1]) <= _CTBA_RADIUS_DEG
    )


def _query_nominatim(query: str, timeout: float = 8.0) -> Optional[tuple[float, float]]:
    """Hit Nominatim's `search` endpoint with a Curitiba-biased viewbox.
    Returns (lat, lng) on success, None if no result or out-of-bounds.

    The User-Agent is mandatory per Nominatim ToS — anonymous queries get
    rate-limited to nothing. We identify the app + a contact route so
    the OSM crew can reach out if we ever cause harm."""
    headers = {
        "User-Agent": "aue-curitiba-events/1.0 (https://reroot-production.up.railway.app)",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
    }
    params = {
        "q": query,
        "format": "json",
        "limit": "1",
        "viewbox": ",".join(str(c) for c in _CTBA_VIEWBOX),
        "bounded": "1",
        "addressdetails": "0",
    }
    try:
        with httpx.Client(timeout=timeout) as client:
            res = client.get(
                "https://nominatim.openstreetmap.org/search",
                params=params,
                headers=headers,
            )
        if res.status_code != 200:
            log.warning("Nominatim HTTP %s for %r", res.status_code, query)
            return None
        data = res.json()
        if not data:
            return None
        hit = data[0]
        lat = float(hit["lat"])
        lng = float(hit["lon"])
        if not _within_curitiba(lat, lng):
            log.info("Nominatim out-of-bounds for %r → (%s, %s)", query, lat, lng)
            return None
        return (lat, lng)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        log.warning("Nominatim error for %r: %s", query, exc)
        return None


def geocode_one(name_original: str, address: str = "") -> Optional[tuple[float, float]]:
    """Try increasingly less specific queries until something hits.

    Order matters: we want the most specific query first because broad
    queries ("Bar Curitiba") collide with too many candidates and the
    first result is rarely the one we want.
    """
    queries = []
    if address:
        queries.append(f"{name_original}, {address}, Curitiba, PR, Brazil")
        queries.append(f"{address}, Curitiba, PR, Brazil")
    queries.append(f"{name_original}, Curitiba, PR, Brazil")
    queries.append(f"{name_original}, Curitiba")
    for q in queries:
        coords = _query_nominatim(q)
        if coords:
            return coords
        # Nominatim ToS: ≥1 req/sec from a single source. Even on a miss
        # we have to wait before the next attempt or the second query
        # gets rate-limited.
        time.sleep(1.1)
    return None


def ai_lookup_venue(name: str, address: str = "", anthropic_api_key: str = "") -> Optional[dict]:
    """Ask Claude for a venue's address + coordinates in Curitiba.

    Why this exists: Nominatim (OSM) is great for addresses but weak for
    venue *names* — "Bar do Sax" doesn't resolve, but Claude knows the
    Curitiba live-music scene well enough to give a street + coords for
    most established venues. Hallucination guard:
      - Prompt instructs Claude to return null when uncertain.
      - We re-validate the lat/lng against the Curitiba bounding box on
        our side anyway (same check `_within_curitiba` enforces).
      - Curator reviews the prefilled values before saving — IA doesn't
        commit to the venues table directly.

    Returns dict {address, lat, lng, confidence, notes} or None on
    failure / when Claude declines."""
    if not anthropic_api_key:
        return None
    try:
        from anthropic import Anthropic
    except ImportError:
        log.warning("anthropic SDK not installed — IA venue lookup disabled")
        return None

    user_msg = (
        f"Venue name: {name}\n"
        f"Optional address hint: {address or '(none)'}\n\n"
        "Return JSON with the venue's street address and coordinates IF "
        "you have high confidence based on your training data. If you're "
        "uncertain or don't recognize the venue, return null for those "
        "fields — DO NOT GUESS.\n\n"
        "Required JSON shape:\n"
        "{\n"
        '  "address": "Rua XV de Novembro, 123, Centro, Curitiba" | null,\n'
        '  "lat": number (between -26.5 and -24.5) | null,\n'
        '  "lng": number (between -50.5 and -48.0) | null,\n'
        '  "confidence": "high" | "medium" | "low",\n'
        '  "notes": "short note explaining why you\'re sure or unsure"\n'
        "}\n\n"
        "Rules:\n"
        "- For famous venues (museums, theatres, parks, well-known bars/"
        "cafés/livrarias), high confidence is fine.\n"
        "- For generic names that could exist in many cities ('Café X', "
        "'Bar Y') with no other signal — low confidence, null coords.\n"
        "- Never invent a street number you don't know. If you only know "
        "the street, set address to the street + 's/n' and still null "
        "the lat/lng unless you're sure of the location.\n"
        "- Coordinates must be within Curitiba metro.\n\n"
        "Return ONLY valid JSON, no markdown fences, no prose around it."
    )
    try:
        client = Anthropic(api_key=anthropic_api_key)
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            system=(
                "You help locate venues in Curitiba, PR, Brazil for a city "
                "events catalog. Honesty matters more than coverage — "
                "returning null when uncertain is correct behavior."
            ),
            messages=[{"role": "user", "content": user_msg}],
        )
        text = msg.content[0].text.strip() if msg.content else ""
        # Strip code fences if Claude added them despite instructions.
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
        data = json.loads(text)
    except (json.JSONDecodeError, KeyError, IndexError, AttributeError) as exc:
        log.warning("AI venue lookup parse failed for %r: %s", name, exc)
        return None
    except Exception as exc:
        log.warning("AI venue lookup error for %r: %s", name, exc)
        return None

    # Defensive coordinate validation — Claude can ignore the bounding
    # box even when prompted; we trust nothing.
    lat = data.get("lat")
    lng = data.get("lng")
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        if not _within_curitiba(float(lat), float(lng)):
            data["lat"] = None
            data["lng"] = None
            data["notes"] = (data.get("notes") or "") + " [coords rejected: outside Curitiba bbox]"
    return data


def geocode_pending_venues(limit: int = 25) -> dict:
    """Process up to `limit` pending venues, querying Nominatim for each.
    Returns counts so the admin endpoint can render a verdict. Bounded by
    `limit` so a single HTTP call doesn't run for minutes."""
    pending = db.list_venues_pending_geocode(limit=limit)
    ok = 0
    failed = 0
    for v in pending:
        coords = geocode_one(v["name_original"], v.get("address") or "")
        if coords:
            db.record_geocode_result(v["name_normalized"], coords[0], coords[1])
            ok += 1
            log.info("Geocoded %r → (%.4f, %.4f)",
                     v["name_original"], coords[0], coords[1])
        else:
            db.record_geocode_result(v["name_normalized"], None, None)
            failed += 1
            log.info("Geocode failed for %r", v["name_original"])
    return {"processed": len(pending), "ok": ok, "failed": failed}
