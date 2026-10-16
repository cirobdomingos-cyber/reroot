"""When two event rows are the same night out.

One rule for every place that collapses repeats: the catalog feed
(main._dedupe_events), the channel fill and the channel cleanup
(database.route_catalog_events_to_channels, dedupe_channel_forks). The
channels used to compare exact names only, so "Texas Experience", "Pay In
Cash" and "Texas Experience — Black Bulls" (one night at Tork n' Roll,
eleven posts) became eleven rows in auê Rock while the feed showed two.

Pure functions, no imports from main or database, so both can use them.
"""
import unicodedata
import re
from datetime import datetime

# Portuguese stopwords + connectors that don't carry meaning for event-name
# similarity. Tuned for the typical Curitiba event title — short, descriptive,
# often uses "no/do/da/de/em" articles and edition markers ("3ª edição").
_PT_STOPWORDS = frozenset({
    "a", "o", "as", "os", "um", "uma", "uns", "umas",
    "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
    "para", "pra", "por", "com", "sem",
    "e", "ou", "mas",
    "ao", "aos", "à", "às",
    "the", "of", "in", "at", "and", "to", "for",
    "edicao", "edição", "edition", "ed",
})

# Thresholds of the tiers in same_event.
NAME_JACCARD = 0.6
# When venue already matches, accept lower Jaccard but require at
# least 2 shared distinctive tokens. Pure Jaccard at 0.3 would
# false-positive on "Show de Música" vs "Workshop de Música" (1
# shared token); requiring ≥ 2 shared tokens fixes that.
NAME_VENUE_SHARED_MIN = 2
NAME_VENUE_JACCARD = 0.3
VENUE_JACCARD = 0.4


def _name_tokens(name: str) -> frozenset[str]:
    """
    Normalize a name to a token set for fuzzy matching:
      lowercase, strip accents, drop punctuation, split on whitespace,
      drop stopwords + tokens shorter than 3 chars (a/no/de/etc.).
    """
    if not name:
        return frozenset()
    # NFKD strips combining marks (à → a, ç → c, é → e)
    folded = unicodedata.normalize("NFKD", name)
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    folded = folded.lower()
    # Replace anything non-alphanumeric with whitespace
    folded = re.sub(r"[^a-z0-9]+", " ", folded)
    tokens = folded.split()
    return frozenset(t for t in tokens if len(t) >= 3 and t not in _PT_STOPWORDS)


def _day_hour(start) -> tuple[str, str]:
    """('2026-10-16', '21:00') from a datetime or a wall-clock ISO string."""
    if isinstance(start, datetime):
        return start.date().isoformat(), start.strftime("%H:%M")
    s = start or ""
    return s[:10], s[11:16] if len(s) >= 16 else ""


def same_event(name_a: str, venue_a: str, start_a, name_b: str, venue_b: str, start_b) -> bool:
    """Whether two rows name the same event. Tiers, in order of confidence:

      1. Same day + exact name (case-insensitive) when either name has no
         distinctive tokens.
      2. Same day + same hour + venue overlap (Jaccard ≥ 0.4 on venue
         tokens, or one venue contained in the other). Strongest signal:
         a venue rarely hosts two distinct events at the same hour.
      2.5. Same day + venue overlap + name share (≥ 2 tokens, Jaccard ≥
         0.3) — different hours but clearly the same event with multiple
         sessions or scrape variants ("Brasilidades 13 Anos - Festa de
         Dia" 15h vs "Brasilidades 13 anos" 19h, same venue).
      3. Same day + name fuzzy ≥ 0.6 (no venue/hour gate) — catches
         near-misses like "Caça à Arte no MON sem Paredes" vs "MON sem
         Paredes — Arte ao Ar Livre".
    """
    day_a, hour_a = _day_hour(start_a)
    day_b, hour_b = _day_hour(start_b)
    if day_a != day_b:
        return False

    va, vb = _name_tokens(venue_a or ""), _name_tokens(venue_b or "")
    venue_match = False
    if va and vb:
        vunion = len(va | vb)
        if (vunion and len(va & vb) / vunion >= VENUE_JACCARD) or va <= vb or vb <= va:
            venue_match = True

    if day_a and hour_a and venue_match and hour_a == hour_b:
        return True

    na, nb = _name_tokens(name_a), _name_tokens(name_b)
    if venue_match and na and nb:
        inter, union = len(na & nb), len(na | nb)
        if union and inter >= NAME_VENUE_SHARED_MIN and inter / union >= NAME_VENUE_JACCARD:
            return True

    if not na or not nb:
        return (name_a or "").strip().lower() == (name_b or "").strip().lower()
    union = len(na | nb)
    return bool(union) and len(na & nb) / union >= NAME_JACCARD


# instagram_ig_<handle>_<shortcode>[-MMDD[-n]]. A shortcode is 11
# characters and may itself hold "_" (DeNJ73_J8mo), so the handle ends
# 12 characters before the end, not at the last underscore: cutting at
# the last one gave "torkandroll_denj73", a handle nobody can be tagged as.
_CATALOG_ID_RE = re.compile(r"^instagram_ig_(?P<handle>.+)_(?P<code>[A-Za-z0-9_-]{11})(?P<dates>(?:-\d+)*)$")


def handle_from_catalog_id(event_id: str) -> str:
    """`instagram_ig_<handle>_<shortcode>` → handle, lowercased; '' for
    anything else (aue_original, group events, malformed ids)."""
    eid = (event_id or "").strip()
    if not eid.startswith("instagram_ig_"):
        return ""
    m = _CATALOG_ID_RE.match(eid)
    if m:
        return m.group("handle").lower()
    # Not an 11-char shortcode (old or hand-made ids): the old parse.
    rest = eid[len("instagram_ig_"):]
    idx = rest.rfind("_")
    return rest[:idx].lower() if idx > 0 else ""
