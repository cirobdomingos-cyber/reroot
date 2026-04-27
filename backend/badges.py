"""
Badge engine — derived state with tier progression.

v3 model: each badge can have a tier ladder (e.g. Local da casa I/II/III/IV
at 3/5/10/25 RSVPs). evaluate() computes the current "value" for each rule,
finds the highest reachable tier from TIERS config, and asks the DB to
award-or-upgrade the row. Each tier-up fires a fresh toast. Tiers never
downgrade.

Multi-instance badges (loyalty per venue, etc.) encode the instance into
the stored badge_id with a ":" separator: "local_da_casa:cafe_lucca". One
row per instance, each with its own tier — meaning a user can be tier IV
at Café Lucca and tier I at Bar do Cachorro simultaneously.

Tier-less badges (first_*, versatil) keep TIERS = [1] — they're binary.

Portfolio note: the materialized user_badges table stays O(1) for "did this
user earn X?" queries. The engine adds *no new state* — it stores tier on
the existing row, and the read endpoint computes "next tier in N more"
from the same TIERS config the engine uses.
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from datetime import datetime, timedelta, timezone

import database as db


log = logging.getLogger(__name__)


# Catalog of all badge templates — display metadata only. Threshold ladder
# lives in TIERS below so adding a tier is a 1-line change.
BADGES: dict[str, dict] = {
    # ── First-step (binary — "fez 1×" only) ──
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
        "desc": "Bairros diferentes em que você confirmou eventos.",
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
        "desc": "Eventos confirmados depois das 19h.",
        "category": "diversity",
    },

    # ── Social (rewards using the friend graph) ──
    "vai_junto": {
        "label": "Vai junto",
        "emoji": "🤝",
        "desc": "Eventos confirmados onde algum amigo também foi.",
        "category": "social",
    },
    "cohort": {
        "label": "Cohort",
        "emoji": "👯",
        "desc": "Maior número de amigos no mesmo evento que você.",
        "category": "social",
    },

    # ── Loyalty (the bridge to partner discounts in v2+) ──
    # "Lenda" was folded in as tier IV — same axis (loyalty per venue),
    # tiers do the work that two separate badges did before.
    "local_da_casa": {
        "label": "Local da casa",
        "emoji": "🍻",
        "desc": "RSVPs no mesmo lugar — escala por tier conforme você frequenta mais.",
        "category": "loyalty",
        "multi_instance": True,
    },
}


# Tier thresholds. Index 0 = tier 1, index 1 = tier 2, etc. The "value"
# (count of bairros, events, etc.) determines the highest tier reached.
# Roman-style label per tier is computed in _tier_label.
TIERS: dict[str, list[int]] = {
    "first_rsvp":    [1],
    "first_friend":  [1],
    "first_group":   [1],
    "versatil":      [1],
    "explorer":      [3, 5, 10],            # bairros distintos (lifetime)
    "noiteiro":      [3, 10, 25],           # eventos ≥19h (lifetime)
    "vai_junto":     [5, 15, 30],           # eventos com amigo (lifetime)
    "cohort":        [3, 5, 10],            # amigos no mesmo evento (best ever)
    "local_da_casa": [3, 5, 10, 25],        # RSVPs no mesmo venue
}

ALL_KINDS = {"quiet_social", "active", "creative", "community"}
TIER_NUMERAL = {1: "I", 2: "II", 3: "III", 4: "IV", 5: "V"}


# ── ID composition (multi-instance badges) ────────────────

def _venue_slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s).strip("_").lower()
    return (s[:40] or "venue")


def _compose_id(base: str, instance_label: str) -> str:
    return f"{base}:{_venue_slug(instance_label)}"


def _parse_id(badge_id: str) -> tuple[str, str | None]:
    if ":" in badge_id:
        base, slug = badge_id.split(":", 1)
        return base, slug
    return badge_id, None


# ── Tier helpers ──────────────────────────────────────────

def _tier_for_value(base_id: str, value: int) -> int:
    """Highest tier reached for this value. 0 = below tier 1 threshold."""
    thresholds = TIERS.get(base_id, [1])
    tier = 0
    for t in thresholds:
        if value >= t:
            tier += 1
        else:
            break
    return tier


def _next_threshold(base_id: str, current_tier: int) -> int | None:
    """Threshold for the NEXT tier above current. None if maxed out."""
    thresholds = TIERS.get(base_id, [1])
    if current_tier >= len(thresholds):
        return None
    return thresholds[current_tier]


def _tier_label(tier: int) -> str:
    """1 → 'I', 2 → 'II', etc. Falls back to digits past V."""
    return TIER_NUMERAL.get(tier, str(tier))


# ── Rule helpers ─────────────────────────────────────────

def _rsvps_for(google_id: str) -> list[dict]:
    rows = db.get_rsvps_for_user(google_id)
    return [dict(r) for r in rows]


def _accepted_friend_count(google_id: str) -> int:
    return sum(1 for f in db.get_friends(google_id) if f.get("status") == "accepted")


def _group_count(google_id: str) -> int:
    return len(db.get_groups_for_user(google_id))


def _kinds_for_event_ids(event_ids: list[str]) -> set[str]:
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
    if not iso_ts:
        return False
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    return dt.hour >= hour


def _venue_name(venue_full: str) -> str:
    return (venue_full or "").split(" · ", 1)[0].strip()


def _venue_counts(rsvps: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rsvps:
        v = _venue_name(r.get("event_venue") or "")
        if v:
            out[v] = out.get(v, 0) + 1
    return out


def _distinct_neighborhoods(rsvps: list[dict]) -> set[str]:
    out: set[str] = set()
    for r in rsvps:
        venue = r.get("event_venue") or ""
        if " · " in venue:
            out.add(venue.split(" · ", 1)[1].strip().lower())
    return out


def _friend_event_overlap(google_id: str) -> dict[str, int]:
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

def _display(base_id: str, instance_label: str | None, tier: int) -> dict:
    """Build display dict including tier numeral when applicable."""
    meta = BADGES.get(base_id, {})
    label = meta.get("label", base_id)
    if instance_label:
        label = f"{label} em {instance_label}"
    has_ladder = len(TIERS.get(base_id, [1])) > 1
    if has_ladder and tier > 0:
        label = f"{label} {_tier_label(tier)}"
    return {
        "label": label,
        "emoji": meta.get("emoji", "🏅"),
        "desc": meta.get("desc", ""),
        "category": meta.get("category", "other"),
        "instance": instance_label,
        "tier": tier,
    }


def _award_or_upgrade(
    out: list[dict],
    google_id: str,
    base_id: str,
    value: int,
    instance_label: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Compare `value` against TIERS[base_id], upsert the row at the right
    tier, append to `out` if a tier was just earned/upgraded."""
    earned_tier = _tier_for_value(base_id, value)
    if earned_tier == 0:
        return
    badge_id = _compose_id(base_id, instance_label) if instance_label else base_id
    is_new, prev_tier = db.award_or_upgrade_badge(
        google_id, badge_id, tier=earned_tier, metadata=metadata or {},
    )
    if is_new:
        out.append({
            "id": badge_id,
            "base_id": base_id,
            "previous_tier": prev_tier,
            **_display(base_id, instance_label, earned_tier),
        })


# ── Public API ───────────────────────────────────────────

def evaluate(google_id: str) -> list[dict]:
    """Run all rules. Persists newly-earned/upgraded badges. Returns list
    of rich dicts for each tier-up so the frontend toast can render them
    directly. Idempotent — no-op when nothing crossed a new threshold."""
    if not google_id:
        return []

    newly: list[dict] = []
    rsvps = _rsvps_for(google_id)
    now = datetime.now(timezone.utc)

    # ── First-step (binary) ──
    if rsvps:
        _award_or_upgrade(newly, google_id, "first_rsvp", value=1)
    if _accepted_friend_count(google_id) >= 1:
        _award_or_upgrade(newly, google_id, "first_friend", value=1)
    if _group_count(google_id) >= 1:
        _award_or_upgrade(newly, google_id, "first_group", value=1)

    # ── Versátil (binary — tier 1 if all 4 kinds in 90d) ──
    cutoff_90 = (now - timedelta(days=90)).isoformat()
    recent_ids = [r["event_id"] for r in rsvps if (r.get("created_at") or "") >= cutoff_90]
    if ALL_KINDS.issubset(_kinds_for_event_ids(recent_ids)):
        _award_or_upgrade(newly, google_id, "versatil", value=1,
                          metadata={"kinds": sorted(ALL_KINDS)})

    # ── Explorer (lifetime distinct bairros, 3-tier ladder) ──
    bairros = _distinct_neighborhoods(rsvps)
    _award_or_upgrade(newly, google_id, "explorer", value=len(bairros),
                      metadata={"bairros": sorted(bairros)})

    # ── Noiteiro (lifetime ≥19h count, 3-tier ladder) ──
    night_count = sum(1 for r in rsvps if _is_after(r.get("event_date") or "", 19))
    _award_or_upgrade(newly, google_id, "noiteiro", value=night_count,
                      metadata={"count": night_count})

    # ── Social: vai_junto (overlap event count) + cohort (max friends ever) ──
    overlap = _friend_event_overlap(google_id)
    if overlap:
        events_with_friend = sum(1 for c in overlap.values() if c >= 1)
        max_friends = max(overlap.values())
        _award_or_upgrade(newly, google_id, "vai_junto", value=events_with_friend,
                          metadata={"events": events_with_friend})
        _award_or_upgrade(newly, google_id, "cohort", value=max_friends,
                          metadata={"max_friends_at_event": max_friends})

    # ── Loyalty: local_da_casa per venue, 4-tier ladder (3/5/10/25) ──
    for venue, count in _venue_counts(rsvps).items():
        _award_or_upgrade(newly, google_id, "local_da_casa", value=count,
                          instance_label=venue,
                          metadata={"venue": venue, "count": count})

    if newly:
        log.info("Awarded %d badges to %s: %s", len(newly), google_id,
                 ", ".join(b["id"] + (f"→T{b['tier']}" if b['tier'] > 1 else "") for b in newly))
    return newly


def catalog() -> list[dict]:
    """Return the static catalog with tier ladder info attached. Frontend
    uses tiers to render the progression bar / 'next tier in N' hint."""
    return [
        {
            "id": bid,
            **meta,
            "tiers": TIERS.get(bid, [1]),
            "max_tier": len(TIERS.get(bid, [1])),
        }
        for bid, meta in BADGES.items()
    ]


def for_user(google_id: str) -> list[dict]:
    """Return the user's earned badges with tier + display metadata."""
    earned = db.get_badges(google_id)
    out = []
    for row in earned:
        base_id, slug = _parse_id(row["badge_id"])
        meta = BADGES.get(base_id)
        if not meta:
            continue
        instance = (row.get("metadata") or {}).get("venue") if slug else None
        tier = row.get("tier", 1)
        display = _display(base_id, instance, tier)
        out.append({
            "id": row["badge_id"],
            "base_id": base_id,
            "earned_at": row["earned_at"],
            "context": row.get("metadata") or {},
            "next_threshold": _next_threshold(base_id, tier),
            **display,
        })
    return out


# ── Personal bests / lifetime stats ───────────────────────
# Not badges — just computed counters surfaced on Profile. They give the
# user "number goes up" feedback even when no new badge is unlocked,
# without the anxiety of streaks (the longest-week-run only tracks the
# all-time best, never the current that could break).

def stats(google_id: str) -> dict:
    """Compute lifetime/personal-best counters. Cheap aggregations, run
    on Profile load."""
    if not google_id:
        return _empty_stats()

    rsvps = _rsvps_for(google_id)
    if not rsvps:
        return _empty_stats()

    venues = _venue_counts(rsvps)
    bairros = _distinct_neighborhoods(rsvps)
    friend_count = _accepted_friend_count(google_id)
    group_count = _group_count(google_id)

    # Best week-streak: walk ISO weeks containing at least one RSVP, take
    # the longest consecutive run. Anxiety-free because we only show the
    # all-time max — never "current streak" that could break.
    weeks_with_rsvp = sorted({
        _iso_week(r.get("event_date") or r.get("created_at") or "")
        for r in rsvps
        if (r.get("event_date") or r.get("created_at"))
    } - {None})
    best_week_streak = _longest_consecutive_run(weeks_with_rsvp)

    # Most active month — date string YYYY-MM with the max RSVP count.
    by_month: dict[str, int] = {}
    for r in rsvps:
        d = (r.get("event_date") or r.get("created_at") or "")[:7]
        if d:
            by_month[d] = by_month.get(d, 0) + 1
    top_month, top_month_count = max(by_month.items(), key=lambda kv: kv[1]) if by_month else ("", 0)

    # Top venue (most-frequented).
    top_venue, top_venue_count = max(venues.items(), key=lambda kv: kv[1]) if venues else ("", 0)

    return {
        "total_rsvps":          len(rsvps),
        "distinct_venues":      len(venues),
        "distinct_bairros":     len(bairros),
        "friend_count":         friend_count,
        "group_count":          group_count,
        "best_week_streak":     best_week_streak,
        "top_venue":            top_venue,
        "top_venue_count":      top_venue_count,
        "top_month":            top_month,
        "top_month_count":      top_month_count,
    }


def _empty_stats() -> dict:
    return {
        "total_rsvps": 0, "distinct_venues": 0, "distinct_bairros": 0,
        "friend_count": 0, "group_count": 0, "best_week_streak": 0,
        "top_venue": "", "top_venue_count": 0,
        "top_month": "", "top_month_count": 0,
    }


def _iso_week(iso_ts: str) -> str | None:
    """ISO 8601 'YYYY-Www' for a date or datetime string. None on parse fail."""
    if not iso_ts:
        return None
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = datetime.fromisoformat(iso_ts[:10])
        except ValueError:
            return None
    y, w, _ = dt.isocalendar()
    return f"{y:04d}-W{w:02d}"


def _longest_consecutive_run(sorted_weeks: list[str]) -> int:
    """Given sorted ISO-week strings, return longest run of consecutive
    weeks. Treats year boundaries via parsing."""
    if not sorted_weeks:
        return 0
    longest = current = 1
    prev_year, prev_week = _parse_iso_week(sorted_weeks[0])
    for w in sorted_weeks[1:]:
        y, wk = _parse_iso_week(w)
        # Consecutive: same year + week+1, OR new year + week 1 after last week of prev year
        is_consecutive = (
            (y == prev_year and wk == prev_week + 1)
            or (y == prev_year + 1 and wk == 1)
        )
        current = current + 1 if is_consecutive else 1
        longest = max(longest, current)
        prev_year, prev_week = y, wk
    return longest


def _parse_iso_week(s: str) -> tuple[int, int]:
    """'2026-W17' → (2026, 17). Caller guarantees valid format."""
    y, w = s.split("-W")
    return int(y), int(w)
