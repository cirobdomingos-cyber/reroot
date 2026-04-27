"""
Badge engine — derived state.

Pattern: rules are pure functions over RSVPs/friendships/groups. evaluate()
runs all rules, persists newly-earned ones via database.award_badge(), and
returns the list of newly-earned badges (rich dicts with display info) so
the caller can surface them to the frontend (toast on RSVP/friend/group
success).

Categorical model — earned once, never revoked, never decay.

Multi-instance badges (loyalty per venue, etc.) encode an instance key
into the stored badge_id with a ":" separator: "local_da_casa:cafe_lucca".
Lets us award the same template multiple times (one row per venue) without
changing the (google_id, badge_id) primary key.

Portfolio note: this is the standard "achievement engine" pattern. The
materialized user_badges table makes the "did this user earn X?" query
O(1), independent of how complex the rule is.
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from datetime import datetime, timedelta, timezone

import database as db


log = logging.getLogger(__name__)


# Catalog of all badge templates. Frontend reads this same metadata via
# /badges/catalog so labels/emojis stay in sync without a separate i18n
# table.
#
# `multi_instance: True` means the user can earn the badge multiple times,
# once per "thing" (venue, bairro, etc.). Stored badge_ids look like
# `<base_id>:<slug>` for those — see _compose_id below.
BADGES: dict[str, dict] = {
    # ── First-step (instant gratification, teach the app) ──
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

    # ── Diversity (encourage exploring the broad catalog) ──
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

    # ── Social (rewards using the friend graph) ──
    "vai_junto": {
        "label": "Vai junto",
        "emoji": "🤝",
        "desc": "Você confirmou 5 eventos onde algum amigo também foi.",
        "category": "social",
    },
    "cohort": {
        "label": "Cohort",
        "emoji": "👯",
        "desc": "3 ou mais amigos confirmaram o mesmo evento que você.",
        "category": "social",
    },

    # ── Loyalty (the bridge to partner discounts in v2) ──
    "local_da_casa": {
        "label": "Local da casa",
        "emoji": "🍻",
        "desc": "3+ RSVPs no mesmo lugar — você é da casa.",
        "category": "loyalty",
        "multi_instance": True,
    },
    "og": {
        "label": "OG",
        "emoji": "🥇",
        "desc": "10+ RSVPs no mesmo lugar — você é OG aqui.",
        "category": "loyalty",
        "multi_instance": True,
    },
}

# All 4 EnrichedEvent kinds — used by the "versátil" rule.
ALL_KINDS = {"quiet_social", "active", "creative", "community"}


# ── ID composition (multi-instance badges) ────────────────

def _venue_slug(name: str) -> str:
    """ASCII-safe slug for use as the instance key in a composite badge_id.
    "Café Lucca" → "cafe_lucca". Empty / weird inputs fall back to "venue"."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s).strip("_").lower()
    return (s[:40] or "venue")


def _compose_id(base: str, instance_label: str) -> str:
    """Build a composite badge_id from a base + an instance display label."""
    return f"{base}:{_venue_slug(instance_label)}"


def _parse_id(badge_id: str) -> tuple[str, str | None]:
    """Inverse of _compose_id. Returns (base_id, slug_or_none)."""
    if ":" in badge_id:
        base, slug = badge_id.split(":", 1)
        return base, slug
    return badge_id, None


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
    catalog or never had a kind contribute nothing."""
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
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    return dt.hour >= hour


def _venue_name(venue_full: str) -> str:
    """'Café Lucca · Centro' → 'Café Lucca'. Returns empty string for empty input."""
    return (venue_full or "").split(" · ", 1)[0].strip()


def _venue_counts(rsvps: list[dict]) -> dict[str, int]:
    """Return {venue_display_name: rsvp_count} from a user's RSVP history.
    Counts each event_id once (the rsvps table already enforces this via PK)."""
    out: dict[str, int] = {}
    for r in rsvps:
        v = _venue_name(r.get("event_venue") or "")
        if v:
            out[v] = out.get(v, 0) + 1
    return out


def _friend_event_overlap(google_id: str) -> dict[str, int]:
    """Return {event_id: friend_count} — events where the user RSVPed AND at
    least one accepted friend also RSVPed. Empty dict if no friends."""
    friends = [f["google_id"] for f in db.get_friends(google_id) if f.get("status") == "accepted"]
    if not friends:
        return {}
    placeholders = ",".join("?" * len(friends))
    with db.get_conn() as conn:
        rows = conn.execute(
            f"""SELECT my.event_id, COUNT(DISTINCT theirs.google_id) AS friend_count
                FROM rsvps my
                JOIN rsvps theirs ON theirs.event_id = my.event_id
                WHERE my.google_id = ?
                  AND theirs.google_id IN ({placeholders})
                GROUP BY my.event_id""",
            [google_id, *friends],
        ).fetchall()
    return {r["event_id"]: r["friend_count"] for r in rows}


# ── Display composition ──────────────────────────────────

def _display(base_id: str, instance_label: str | None) -> dict:
    """Build the display dict for a freshly-earned badge — pulls from
    BADGES catalog and decorates with the instance label when applicable."""
    meta = BADGES.get(base_id, {})
    label = meta.get("label", base_id)
    desc = meta.get("desc", "")
    if instance_label:
        label = f"{label} em {instance_label}"
    return {
        "label": label,
        "emoji": meta.get("emoji", "🏅"),
        "desc": desc,
        "category": meta.get("category", "other"),
        "instance": instance_label,
    }


def _award_and_record(
    out: list[dict],
    google_id: str,
    base_id: str,
    instance_label: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Persist the badge if not already awarded; append to `out` on success.
    Centralizes the duplicate-check + display-decoration so each rule stays
    a one-liner."""
    badge_id = _compose_id(base_id, instance_label) if instance_label else base_id
    if db.has_badge(google_id, badge_id):
        return
    if db.award_badge(google_id, badge_id, metadata or {}):
        out.append({
            "id": badge_id,
            "base_id": base_id,
            **_display(base_id, instance_label),
        })


# ── Public API ───────────────────────────────────────────

def evaluate(google_id: str) -> list[dict]:
    """Run all rules for `google_id`. Persists newly-earned badges. Returns
    a list of dicts with full display info for each newly-earned badge —
    safe for the frontend to render directly without a catalog roundtrip.

    Idempotent: rerun after every write, only newly-passed thresholds yield
    awards on each call."""
    if not google_id:
        return []

    newly: list[dict] = []
    rsvps = _rsvps_for(google_id)
    now = datetime.now(timezone.utc)

    # ── First-step ──
    if rsvps:
        _award_and_record(newly, google_id, "first_rsvp")

    if _accepted_friend_count(google_id) >= 1:
        _award_and_record(newly, google_id, "first_friend")

    if _group_count(google_id) >= 1:
        _award_and_record(newly, google_id, "first_group")

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
            _award_and_record(newly, google_id, "explorer",
                              metadata={"neighborhoods": sorted(neighborhoods)})

    # ── Versátil: all 4 kinds in last 90 days ──
    if not db.has_badge(google_id, "versatil"):
        cutoff = (now - timedelta(days=90)).isoformat()
        recent_ids = [r["event_id"] for r in rsvps if (r.get("created_at") or "") >= cutoff]
        kinds = _kinds_for_event_ids(recent_ids)
        if ALL_KINDS.issubset(kinds):
            _award_and_record(newly, google_id, "versatil",
                              metadata={"kinds": sorted(kinds)})

    # ── Noiteiro: 3 RSVPs at events starting at/after 22h ──
    if not db.has_badge(google_id, "noiteiro"):
        night_count = sum(1 for r in rsvps if _is_after(r.get("event_date") or "", 22))
        if night_count >= 3:
            _award_and_record(newly, google_id, "noiteiro",
                              metadata={"count": night_count})

    # ── Social: vai_junto + cohort (single overlap query, two rules) ──
    overlap = _friend_event_overlap(google_id)
    if overlap:
        events_with_friend = sum(1 for c in overlap.values() if c >= 1)
        max_friends = max(overlap.values())
        if events_with_friend >= 5:
            _award_and_record(newly, google_id, "vai_junto",
                              metadata={"events": events_with_friend})
        if max_friends >= 3:
            _award_and_record(newly, google_id, "cohort",
                              metadata={"max_friends_at_event": max_friends})

    # ── Loyalty: local_da_casa (3+) and og (10+), per venue ──
    for venue, count in _venue_counts(rsvps).items():
        if count >= 3:
            _award_and_record(newly, google_id, "local_da_casa",
                              instance_label=venue,
                              metadata={"venue": venue, "count": count})
        if count >= 10:
            _award_and_record(newly, google_id, "og",
                              instance_label=venue,
                              metadata={"venue": venue, "count": count})

    if newly:
        log.info("Awarded %d badges to %s: %s", len(newly), google_id,
                 ", ".join(b["id"] for b in newly))
    return newly


def catalog() -> list[dict]:
    """Return the static catalog. Frontend uses this to render the full
    Conquistas grid with locked/earned states."""
    return [{"id": bid, **meta} for bid, meta in BADGES.items()]


def for_user(google_id: str) -> list[dict]:
    """Return a user's earned badges merged with display metadata. Each:
        {id, base_id, instance, label, emoji, desc, category, earned_at, context}
    Multi-instance badges (e.g. local_da_casa) appear once per venue earned."""
    earned = db.get_badges(google_id)
    out = []
    for row in earned:
        base_id, slug = _parse_id(row["badge_id"])
        meta = BADGES.get(base_id)
        if not meta:
            continue  # forgotten or removed badge — skip
        instance = (row.get("metadata") or {}).get("venue") if slug else None
        display = _display(base_id, instance)
        out.append({
            "id": row["badge_id"],
            "base_id": base_id,
            "earned_at": row["earned_at"],
            "context": row.get("metadata") or {},
            **display,
        })
    return out
