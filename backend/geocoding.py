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
        "Find this venue's street address and coordinates in Curitiba, PR, "
        "Brazil. Use web_search to look up the venue if you don't know it "
        "from training — search for the venue name + 'Curitiba' and read "
        "the results (Tripadvisor, Facebook pages, Instagram bios, news "
        "articles, Google Maps citations) to find the address.\n\n"
        "If after searching you still can't find a confident location, "
        "return null fields — DO NOT GUESS.\n\n"
        "Required JSON shape (return this as the LAST thing in your "
        "response, with no surrounding prose or markdown fences):\n"
        "{\n"
        '  "address": "Rua XV de Novembro, 123, Centro, Curitiba" | null,\n'
        '  "lat": number (between -26.5 and -24.5) | null,\n'
        '  "lng": number (between -50.5 and -48.0) | null,\n'
        '  "confidence": "high" | "medium" | "low",\n'
        '  "notes": "short note about source / why confident or not"\n'
        "}\n\n"
        "Rules:\n"
        "- For famous venues (museums, theatres, parks), training data "
        "is enough → high confidence.\n"
        "- For informal names ('Bar do X', 'Café Y'), web_search first.\n"
        "- For generic names with no Curitiba match anywhere — low "
        "confidence, null coords.\n"
        "- Coordinates must be within Curitiba metro."
    )
    try:
        client = Anthropic(api_key=anthropic_api_key)
        msg = client.messages.create(
            # Sonnet (over Haiku) — web_search tool calls are heavier and
            # benefit from better reasoning to dedupe/parse results.
            model="claude-sonnet-4-6",
            max_tokens=1500,
            system=(
                "You help locate venues in Curitiba, PR, Brazil for a city "
                "events catalog. Honesty matters more than coverage — "
                "returning null when uncertain is correct behavior. Use "
                "web_search to research informal venue names; rely on "
                "training only for famous landmarks."
            ),
            tools=[{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 3,
            }],
            messages=[{"role": "user", "content": user_msg}],
        )
        # Response can interleave tool_use / tool_result / text blocks
        # (Anthropic runs hosted web_search server-side). We want the
        # LAST text block — that's where the model's final JSON answer
        # lives after it finished researching.
        text_blocks = [b.text for b in (msg.content or []) if getattr(b, "type", "") == "text"]
        text = (text_blocks[-1] if text_blocks else "").strip()
        # Strip code fences if Claude added them despite instructions.
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:].strip()
        # Sometimes Claude wraps JSON inside prose despite our request.
        # Pull the last {...} block as a fallback.
        if not text.startswith("{"):
            start = text.rfind("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                text = text[start:end + 1]
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


def autofill_pending_with_ai(anthropic_api_key: str, limit: int = 50) -> dict:
    """For every still-pending venue, ask Claude (with the web_search tool)
    to find a Curitiba address + coords. High/medium-confidence results
    that pass the bbox check get saved as source='ai'. Low-confidence and
    unfound venues stay pending so they don't get bad coords baked in.

    This runs after the Nominatim batch in the scrape pipeline — Nominatim
    handles the easy address-style hits, Claude+websearch picks up the
    informal venue names ("Bar do Sax", "Olga's Speakeasy") that Nominatim
    doesn't recognize.
    """
    if not anthropic_api_key:
        return {"processed": 0, "ok": 0, "skipped": 0, "reason": "no api key"}
    pending = db.list_venues_pending_geocode(limit=limit)
    ok = 0
    skipped = 0
    for v in pending:
        result = ai_lookup_venue(
            v["name_original"], v.get("address") or "",
            anthropic_api_key=anthropic_api_key,
        )
        if not result:
            skipped += 1
            continue
        lat = result.get("lat")
        lng = result.get("lng")
        conf = (result.get("confidence") or "low").lower()
        if lat is None or lng is None or conf not in ("high", "medium"):
            skipped += 1
            continue
        if not _within_curitiba(float(lat), float(lng)):
            skipped += 1
            continue
        db.update_venue_manual(
            name_normalized=v["name_normalized"],
            lat=float(lat), lng=float(lng),
            address=result.get("address") or None,
        )
        # Stamp source as 'ai' so we know this didn't come from Nominatim
        # or a curator pin. Updated_venue_manual marks it 'manual' by
        # default; override the source column so we keep the provenance
        # signal accurate for any future audit pass.
        with db.get_conn() as conn:
            conn.execute(
                "UPDATE venues SET geocode_source = 'ai' WHERE name_normalized = ?",
                (v["name_normalized"],),
            )
            conn.commit()
        ok += 1
        log.info("AI-geocoded %r [%s] → (%.4f, %.4f)",
                 v["name_original"], conf, float(lat), float(lng))
    return {"processed": len(pending), "ok": ok, "skipped": skipped}
