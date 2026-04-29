"""
Match Sympla CWB events against existing IG-sourced catalog events.

Each match writes a `sympla_url` field onto the catalog event's payload
so the frontend can render a "🎟️ Comprar ingresso" CTA. We never add
unmatched Sympla events to the catalog — IG remains the source of truth
for what shows up in the app.

Matching axis:
1. Venue label fuzzy match against tracked_ig_accounts (handle / label /
   display_name). Picks the top-N candidate handles per Sympla event.
2. Within each candidate handle's catalog events, find the row with:
   - dateStart within ±24h of the Sympla event's start
   - name fuzzy similarity > NAME_THRESHOLD

If multiple candidates qualify, keep the highest combined score.

Uses stdlib `difflib.SequenceMatcher` for similarity — no extra deps,
fast enough for the ~100 IG events × ~60 Sympla events per run.
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

import database as db

log = logging.getLogger(__name__)

# Thresholds — tuned conservative so we never attach a wrong URL. False
# negatives (we miss a real match) are fine; false positives (wrong URL
# on the wrong event) corrode user trust.
VENUE_THRESHOLD = 0.55
NAME_THRESHOLD = 0.55
DATE_TOLERANCE_HOURS = 24

BR_TZ = timezone(timedelta(hours=-3))


def _normalize(s: str) -> str:
    """Strip accents, lowercase, collapse non-alphanumerics. Cheap and
    enough for our match — venue names like 'Bar do Café' and 'bar do
    cafe' should compare equal."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-zA-Z0-9]+", " ", s).strip().lower()
    return s


def _ratio(a: str, b: str) -> float:
    a_n, b_n = _normalize(a), _normalize(b)
    if not a_n or not b_n:
        return 0.0
    return SequenceMatcher(None, a_n, b_n).ratio()


def _venue_candidates(sympla_venue: str, accounts: list[dict], top_n: int = 5) -> list[dict]:
    """Return the top-N tracked_ig_accounts whose label/handle/display_name
    most closely matches the Sympla venue text."""
    scored = []
    for a in accounts:
        labels = [a.get("label"), a.get("display_name"), a.get("handle")]
        score = max((_ratio(sympla_venue, lab) for lab in labels if lab), default=0.0)
        if score >= VENUE_THRESHOLD:
            scored.append((score, a))
    scored.sort(key=lambda x: -x[0])
    return [a for _, a in scored[:top_n]]


def _ig_events_for_handle(handle: str) -> list[dict]:
    """Pull every catalog event for an IG handle, parse its payload, and
    return [(id, payload_dict)]. Excludes events without a parseable
    dateStart — those can't be matched to a Sympla startDate."""
    out = []
    prefix = f"instagram_ig_{handle}_"
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT id, payload FROM events WHERE id LIKE ?",
            (f"{prefix}%",),
        ).fetchall()
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except (json.JSONDecodeError, TypeError):
            continue
        ds = payload.get("date_start") or payload.get("dateStart") or ""
        if not ds:
            continue
        try:
            dt = datetime.fromisoformat(ds.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=BR_TZ)
        except (ValueError, TypeError):
            continue
        out.append({"id": r["id"], "payload": payload, "dt": dt})
    return out


def _save_sympla_url(event_id: str, payload: dict, sympla_url: str) -> bool:
    """Idempotent write — only updates when the stored URL is missing or
    different. Returns True on actual write."""
    existing = (payload.get("sympla_url") or "").strip()
    if existing == sympla_url:
        return False
    payload = dict(payload)
    payload["sympla_url"] = sympla_url
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE events SET payload = ? WHERE id = ?",
            (json.dumps(payload, ensure_ascii=False), event_id),
        )
        conn.commit()
    return True


def match_and_enrich(sympla_events: list[dict]) -> dict:
    """Run the matcher across the supplied list of Sympla events. Mutates
    catalog event payloads in place. Returns a summary dict for logging
    and the admin endpoint."""
    if not sympla_events:
        return {"sympla_events": 0, "matched": 0, "wrote": 0, "skipped_no_handle": 0}

    # Pull the full handle list once — re-using across all sympla events.
    accounts = db.list_ig_accounts(enabled_only=True)

    # Cache per-handle event pulls so we don't re-query for repeat venues.
    by_handle_cache: dict[str, list[dict]] = {}

    matched = 0
    wrote = 0
    skipped_no_handle = 0
    samples: list[dict] = []
    for sym in sympla_events:
        venue_text = sym.get("venue_name") or ""
        cands = _venue_candidates(venue_text, accounts)
        if not cands:
            skipped_no_handle += 1
            continue

        sym_dt = sym["date_start"]
        sym_name = sym.get("name") or ""
        best = None  # (score, handle, event_id, payload)
        for cand in cands:
            h = cand["handle"]
            evs = by_handle_cache.get(h)
            if evs is None:
                evs = _ig_events_for_handle(h)
                by_handle_cache[h] = evs
            for ev in evs:
                hours_off = abs((sym_dt - ev["dt"]).total_seconds()) / 3600.0
                if hours_off > DATE_TOLERANCE_HOURS:
                    continue
                name_score = _ratio(sym_name, ev["payload"].get("name", ""))
                if name_score < NAME_THRESHOLD:
                    continue
                # Combined: penalize date drift modestly so a perfect-name
                # but 22h-off match loses to a slightly-weaker-name 2h-off.
                combined = name_score - (hours_off / DATE_TOLERANCE_HOURS) * 0.15
                if best is None or combined > best[0]:
                    best = (combined, h, ev["id"], ev["payload"])
        if best is None:
            continue
        matched += 1
        if _save_sympla_url(best[2], best[3], sym["url"]):
            wrote += 1
            if len(samples) < 10:
                samples.append({
                    "handle": best[1],
                    "event_id": best[2],
                    "ig_name": best[3].get("name", ""),
                    "sympla_name": sym_name,
                    "sympla_url": sym["url"],
                    "score": round(best[0], 3),
                })
    return {
        "sympla_events": len(sympla_events),
        "matched": matched,
        "wrote": wrote,
        "skipped_no_handle": skipped_no_handle,
        "samples": samples,
    }
