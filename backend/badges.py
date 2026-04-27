"""
Badge engine — derived state.

Pattern: rules are pure functions over RSVPs/friendships/groups. evaluate()
runs all rules, persists newly-earned ones via database.award_badge(), and
returns the list of newly-earned badge IDs so the caller can surface them
to the frontend (toast on RSVP/friend/group success).

Categorical model — earned once, never revoked, never decay. Future
"loyalty per venue" badges (e.g. "Local da casa") will follow the same
shape but use metadata to disambiguate (one row per venue).

Portfolio note: this is the standard "achievement engine" pattern. The
materialized user_badges table makes the "did this user earn X?" query
O(1), independent of how complex the rule is.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

import database as db


log = logging.getLogger(__name__)


# Catalog of v1 badges. Frontend reads this same metadata via /badges/catalog
# so labels/emojis stay in sync without a separate i18n table.
BADGES: dict[str, dict] = {
    "first_rsvp": {
        "label": "Primeiro auê",
        "emoji": "🎉",
        "desc": "Você confirmou seu primeiro evento.",
        "category": "first_step",
    },
    "first_friend": {
        "label": "Galera junto",
        "emoji": "👥",
        "desc": "Você adicionou seu primeiro amigo.",
        "category": "first_step",
    },
    "first_group": {
        "label": "Crew",
        "emoji": "🎲",
        "desc": "Você entrou no seu primeiro grupo.",
        "category": "first_step",
    },
    "explorer": {
        "label": "Explorador",
        "emoji": "🗺",
        "desc": "Você foi a 3 bairros diferentes em 60 dias.",
        "category": "diversity",
    },
    "versatil": {
        "label": "Versátil",
        "emoji": "🎭",
        "desc": "Você foi a 1 evento de cada tipo (tranquilo, ativo, criativo, comunidade) em 90 dias.",
        "category": "diversity",
    },
    "noiteiro": {
        "label": "Noiteiro",
        "emoji": "🌃",
        "desc": "Você confirmou 3 eventos depois das 22h.",
        "category": "diversity",
    },
}

# All 4 EnrichedEvent kinds — used by the "versátil" rule.
ALL_KINDS = {"quiet_social", "active", "creative", "community"}


# ── Rule helpers ─────────────────────────────────────────

def _rsvps_for(google_id: str) -> list[dict]:
    """Fetch RSVPs as plain dicts. Reuses the existing helper."""
    rows = db.get_rsvps_for_user(google_id)
    return [dict(r) for r in rows]


def _accepted_friend_count(google_id: str) -> int:
    return sum(1 for f in db.get_friends(google_id) if f.get("status") == "accepted")


def _group_count(google_id: str) -> int:
    return len(db.get_groups_for_user(google_id))


def _kinds_for_event_ids(event_ids: list[str]) -> set[str]:
    """Return the set of distinct `kind` values for a list of catalog event IDs.
    Pulls from events.payload (JSON) — events that have been removed from the
    catalog or never had a kind contribute nothing.
    """
    if not event_ids:
        return set()
    placeholders = ",".join("?" * len(event_ids))
    with db.get_conn() as conn:
        rows = conn.execute(
            f"SELECT payload FROM events WHERE id IN ({placeholders})",
            event_ids,
        ).fetchall()
    kinds: set[str] = set()
    for r in rows:
        try:
            kinds.add(json.loads(r["payload"]).get("kind") or "")
        except json.JSONDecodeError:
            continue
    kinds.discard("")
    return kinds


def _is_after(iso_ts: str, hour: int) -> bool:
    """True if iso_ts (ISO8601) has a clock time at or past `hour`. Treats
    parse failures as False — better to under-award than crash."""
    if not iso_ts:
        return False
    try:
        # event_date is stored as ISO; may or may not have timezone
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    return dt.hour >= hour


# ── Public API ───────────────────────────────────────────

def evaluate(google_id: str) -> list[str]:
    """Run all rules for `google_id`. Persists newly-earned via award_badge.
    Returns the list of badge_ids that were just earned (empty list if none).
    Safe to call after every write — idempotent."""
    if not google_id:
        return []

    newly = []
    rsvps = _rsvps_for(google_id)
    now = datetime.now(timezone.utc)

    # ── First-step badges ──
    if rsvps and not db.has_badge(google_id, "first_rsvp"):
        if db.award_badge(google_id, "first_rsvp"):
            newly.append("first_rsvp")

    if _accepted_friend_count(google_id) >= 1 and not db.has_badge(google_id, "first_friend"):
        if db.award_badge(google_id, "first_friend"):
            newly.append("first_friend")

    if _group_count(google_id) >= 1 and not db.has_badge(google_id, "first_group"):
        if db.award_badge(google_id, "first_group"):
            newly.append("first_group")

    # ── Explorer: 3 distinct neighborhoods in last 60 days ──
    if not db.has_badge(google_id, "explorer"):
        cutoff = (now - timedelta(days=60)).isoformat()
        recent = [r for r in rsvps if (r.get("created_at") or "") >= cutoff]
        neighborhoods: set[str] = set()
        for r in recent:
            venue = r.get("event_venue") or ""
            if " · " in venue:
                neighborhoods.add(venue.split(" · ", 1)[1].strip().lower())
        if len(neighborhoods) >= 3:
            if db.award_badge(google_id, "explorer", {"neighborhoods": sorted(neighborhoods)}):
                newly.append("explorer")

    # ── Versátil: all 4 kinds in last 90 days ──
    if not db.has_badge(google_id, "versatil"):
        cutoff = (now - timedelta(days=90)).isoformat()
        recent_ids = [r["event_id"] for r in rsvps if (r.get("created_at") or "") >= cutoff]
        kinds = _kinds_for_event_ids(recent_ids)
        if ALL_KINDS.issubset(kinds):
            if db.award_badge(google_id, "versatil", {"kinds": sorted(kinds)}):
                newly.append("versatil")

    # ── Noiteiro: 3 RSVPs at events starting at or after 22h ──
    if not db.has_badge(google_id, "noiteiro"):
        night_count = sum(1 for r in rsvps if _is_after(r.get("event_date") or "", 22))
        if night_count >= 3:
            if db.award_badge(google_id, "noiteiro", {"count": night_count}):
                newly.append("noiteiro")

    if newly:
        log.info("Awarded badges to %s: %s", google_id, ", ".join(newly))
    return newly


def catalog() -> list[dict]:
    """Return the static badge catalog for the frontend."""
    return [{"id": bid, **meta} for bid, meta in BADGES.items()]


def for_user(google_id: str) -> list[dict]:
    """Return the user's earned badges merged with catalog metadata. Newest
    earned first; not-yet-earned excluded — frontend shows the missing ones
    by diffing against the full catalog."""
    earned = db.get_badges(google_id)
    out = []
    for row in earned:
        meta = BADGES.get(row["badge_id"])
        if not meta:
            continue  # row for a badge we no longer recognize — ignore
        out.append({"id": row["badge_id"], "earned_at": row["earned_at"], **meta, **{"context": row.get("metadata") or {}}})
    return out
