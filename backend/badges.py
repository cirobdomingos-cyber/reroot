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
        "desc": "Quantos amigos você adicionou — escala social pura.",
        "category": "social",
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
        "desc": "Você foi a 1 evento de cada tipo (tranquilo, ativo, criativo, comunidade) numa janela de tempo. Tier maior = janela mais apertada.",
        "category": "diversity",
        "tier_unit": "d",  # tiers exibidos como "90d", "30d", etc.
    },
    "noiteiro": {
        "label": "Noiteiro",
        "emoji": "🌃",
        "desc": "Eventos confirmados depois das 19h.",
        "category": "diversity",
    },
    "diurno": {
        "label": "Diurno",
        "emoji": "☀️",
        "desc": "Eventos confirmados antes das 19h — yoga, feira, café, matinê.",
        "category": "diversity",
    },
    "maratonista": {
        "label": "Maratonista",
        "emoji": "🏃",
        "desc": "Vezes que você confirmou 2 ou mais eventos no mesmo dia.",
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
    "anfitriao": {
        "label": "Anfitrião",
        "emoji": "🎤",
        "desc": "Grupos criados por você que têm 3 ou mais membros.",
        "category": "social",
    },

    # ── Curador (rewards adding events to groups for the crew) ──
    "curador": {
        "label": "Curador",
        "emoji": "📝",
        "desc": "Eventos que você adicionou a um grupo — ajuda a galera a saber o que rola.",
        "category": "curador",
    },
    # ── Organizador (rewards hosting personal plans — pulling friends
    # together outside any group). Distinct from curador: curador feeds
    # an existing crew chat, organizador creates the crew on the fly. ──
    "organizador": {
        "label": "Organizador",
        "emoji": "🎯",
        "desc": "Planos pessoais que você criou — convidando amigos pro evento direto, sem precisar de grupo.",
        "category": "curador",
    },
    # ── Crew quente (rewards joining a group that's actually moving —
    # rather than creating it). Tier reflects the most-active group the
    # user belongs to, lifetime event count. ──
    "crew_quente": {
        "label": "Crew quente",
        "emoji": "🔥",
        "desc": "Eventos rolando no seu grupo mais ativo. Quanto mais a galera bota plano, mais sobe.",
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
    "first_group":   [1],
    "first_friend":  [1, 5, 15, 30],        # accepted friend count
    "versatil":      [1, 2, 3, 4],          # encoded tier (1=90d, 2=30d, 3=7d, 4=3d window)
    "explorer":      [3, 5, 10],            # bairros distintos (lifetime)
    "noiteiro":      [3, 10, 25],           # eventos ≥19h (lifetime)
    "diurno":        [3, 10, 25],           # eventos <19h (lifetime)
    "maratonista":   [1, 3, 5],             # distinct days with 2+ RSVPs
    "vai_junto":     [5, 15, 30],           # eventos com amigo (lifetime)
    "cohort":        [3, 5, 10],            # amigos no mesmo evento (best ever)
    "anfitriao":     [1, 3, 5],             # grupos próprios com 3+ membros
    "curador":       [1, 5, 15, 30],        # eventos adicionados a grupos (lifetime, mature)
    "organizador":   [1, 3, 10],            # planos pessoais criados (lifetime, mature)
    "crew_quente":   [5, 15, 50],           # eventos no grupo mais ativo do usuário
    "local_da_casa": [3, 5, 10, 25],        # RSVPs no mesmo venue
}

# Display thresholds shown to the user. For badges where the engine's
# internal value is a tier-num (e.g. versatil, where value=2 means "did
# it in 30 days"), this overrides what the modal/tile shows. Combined
# with `tier_unit` on the badge it renders as "90d", "30d", etc.
DISPLAY_TIERS: dict[str, list[int]] = {
    "versatil": [90, 30, 7, 3],  # days windows, widest → tightest
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
    """User-facing threshold for the NEXT tier — uses DISPLAY_TIERS when the
    engine value differs from what the UI shows (e.g. versatil: engine 1→2,
    display 90d→30d). None if maxed out."""
    thresholds = DISPLAY_TIERS.get(base_id) or TIERS.get(base_id, [1])
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


def _is_before(iso_ts: str, hour: int) -> bool:
    """Symmetric to _is_after — used by Diurno (events earlier than 19h).
    Same parse-failure semantics: under-award rather than crash."""
    if not iso_ts:
        return False
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    return dt.hour < hour


def _busy_day_count(rsvps: list[dict]) -> int:
    """Number of distinct days where the user has 2+ RSVPs. Bronze=1 such
    day, Prata=3, Ouro=5 (Maratonista)."""
    by_day: dict[str, int] = {}
    for r in rsvps:
        d = (r.get("event_date") or "")[:10]
        if d:
            by_day[d] = by_day.get(d, 0) + 1
    return sum(1 for c in by_day.values() if c >= 2)


def _hosted_group_count(google_id: str) -> int:
    """Count groups created by the user that have 3+ members (Anfitrião)."""
    if not google_id:
        return 0
    with db.get_conn() as conn:
        rows = conn.execute(
            """SELECT COUNT(*) AS c FROM (
                   SELECT g.id
                   FROM groups g
                   JOIN group_members gm ON gm.group_id = g.id
                   WHERE g.created_by = ?
                   GROUP BY g.id
                   HAVING COUNT(gm.google_id) >= 3
               )""",
            (google_id,),
        ).fetchone()
    return int(rows["c"]) if rows else 0


def _curated_count(google_id: str, mature_before_iso: str | None = None) -> int:
    """Count of events the user added to groups (group_events.created_by,
    group_id IS NOT NULL). Excludes personal plans (those have NULL
    group_id and are rewarded by `organizador` instead).

    With `mature_before_iso`, filter to past-date events — prevents the
    add-then-delete farm by waiting for the event to actually happen."""
    if not google_id:
        return 0
    sql = ("SELECT COUNT(*) AS c FROM group_events "
           "WHERE created_by = ? AND group_id IS NOT NULL")
    params: list = [google_id]
    if mature_before_iso:
        sql += " AND date_start != '' AND date_start < ?"
        params.append(mature_before_iso)
    with db.get_conn() as conn:
        row = conn.execute(sql, params).fetchone()
    return int(row["c"]) if row else 0


def _organized_count(google_id: str, mature_before_iso: str | None = None) -> int:
    """Count of personal plans the user created (group_events with
    group_id IS NULL). Symmetric to `_curated_count` but for plans
    outside any group — the "I rallied my own crew" axis.

    Same maturity filter rationale as curador: only past-date events
    contribute, so create-and-cancel doesn't farm tiers."""
    if not google_id:
        return 0
    sql = ("SELECT COUNT(*) AS c FROM group_events "
           "WHERE created_by = ? AND group_id IS NULL")
    params: list = [google_id]
    if mature_before_iso:
        sql += " AND date_start != '' AND date_start < ?"
        params.append(mature_before_iso)
    with db.get_conn() as conn:
        row = conn.execute(sql, params).fetchone()
    return int(row["c"]) if row else 0


def _hottest_group_event_count(google_id: str) -> int:
    """For each group the user belongs to, count its lifetime events;
    return the highest count. Drives the `crew_quente` ladder — being
    in an active crew matters more than being in many quiet ones.

    Counts ALL group events (past + future), not just matured ones —
    the badge rewards belonging to a hot group, not a personal action,
    so 'maturity' doesn't apply. The other members can't farm the
    user's badge either: it's bounded by genuine multi-user activity."""
    if not google_id:
        return 0
    with db.get_conn() as conn:
        row = conn.execute(
            """SELECT MAX(c) AS top FROM (
                   SELECT ge.group_id, COUNT(*) AS c
                   FROM group_members gm
                   JOIN group_events ge ON ge.group_id = gm.group_id
                   WHERE gm.google_id = ?
                   GROUP BY ge.group_id
               )""",
            (google_id,),
        ).fetchone()
    return int(row["top"]) if row and row["top"] is not None else 0


# Versatil tiers are time-window-based: widest window with all 4 kinds
# determines the tier. Same set, faster = higher tier.
_VERSATIL_WINDOWS = [(3, 4), (7, 3), (30, 2), (90, 1)]  # (days, tier)


def _versatil_tier(rsvps: list[dict], now: datetime) -> int:
    """Highest versatil tier reached. Iterates tightest→widest, returns
    first window where all 4 kinds were RSVPed. 0 if never achieved."""
    for days, tier in _VERSATIL_WINDOWS:
        cutoff = (now - timedelta(days=days)).isoformat()
        recent_ids = [r["event_id"] for r in rsvps if (r.get("created_at") or "") >= cutoff]
        if ALL_KINDS.issubset(_kinds_for_event_ids(recent_ids)):
            return tier
    return 0


def _venue_name(venue_full: str) -> str:
    return (venue_full or "").split(" · ", 1)[0].strip()


# ── Anti-game: mature-event filter ───────────────────────
# Counting only "matured" events (date already passed) makes the spike-
# and-cancel attack ineffective: you can't cancel a past event to undo a
# badge unlock. New users still get instant gratification on first_rsvp
# and first_group (welcome bonuses); everything count-based waits for
# the event to actually happen before contributing.

def _is_mature_event(event_date_iso: str, now: datetime) -> bool:
    """True if the event's date has already passed. Empty/unparseable
    dates → False (conservative; better to under-award than to count
    evergreens that the user can RSVP+cancel freely)."""
    if not event_date_iso:
        return False
    try:
        dt = datetime.fromisoformat(event_date_iso.replace("Z", "+00:00"))
    except ValueError:
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt < now


def _mature_rsvps(rsvps: list[dict], now: datetime) -> list[dict]:
    """Subset of rsvps where the event has already happened — these are
    'committed' (you can't go back and cancel something that already
    occurred). Used by every count-based badge to make spike-and-cancel
    farming ineffective."""
    return [r for r in rsvps if _is_mature_event(r.get("event_date") or "", now)]


def _venue_counts(rsvps: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in rsvps:
        v = _venue_name(r.get("event_venue") or "")
        if v:
            out[v] = out.get(v, 0) + 1
    return out


def _distinct_neighborhoods(rsvps: list[dict]) -> set[str]:
    """Distinct bairros across the user's matured RSVPs.

    Source of truth is the geocoded `venues.bairro` column, populated by
    Nominatim (`addressdetails=1`) or Claude during the auto-geocode pass.
    Replaces the older `venue_string.split(" · ")[1]` parser, which
    silently dropped any RSVP whose venue lacked the suffix and counted
    bairro typos as distinct ("Batel" vs "batel ").

    Falls back to the suffix parser when a venue isn't in the cache yet —
    keeps the badge working for users who RSVPed to events whose venues
    haven't been seeded/geocoded yet, instead of regressing to zero
    bairros while the pipeline catches up."""
    bairro_map = db.get_venue_bairro_map()
    out: set[str] = set()
    for r in rsvps:
        venue_full = r.get("event_venue") or ""
        # event_venue is "Café Lucca · Batel" — split off the venue name
        # to look it up in the cache by normalized key.
        venue_name = venue_full.split(" · ", 1)[0].strip()
        if not venue_name:
            continue
        # Use the same normalization the venues table keys on so the
        # lookup matches regardless of accents/casing variants.
        from database import _normalize_venue_key
        key = _normalize_venue_key(venue_name)
        bairro = bairro_map.get(key, "").strip().lower()
        if bairro:
            out.add(bairro)
            continue
        # Fallback: legacy venue-string suffix when the cache hasn't
        # caught up. Lower bar than the cached path so a typo'd suffix
        # ("Centro " vs "Centro") still counts as the same bairro.
        if " · " in venue_full:
            out.add(venue_full.split(" · ", 1)[1].strip().lower())
    return out


def _friend_event_overlap(google_id: str, mature_before_iso: str | None = None) -> dict[str, int]:
    """Return {event_id: friend_count} — events the user AND ≥1 accepted
    friend both RSVPed. Empty if no friends. When `mature_before_iso` is
    set, filter to events whose date already passed (anti-game guard)."""
    friends = [f["google_id"] for f in db.get_friends(google_id) if f.get("status") == "accepted"]
    if not friends:
        return {}
    placeholders = ",".join("?" * len(friends))
    extra = ""
    params: list = [google_id, *friends]
    if mature_before_iso:
        extra = " AND my.event_date != '' AND my.event_date < ?"
        params.append(mature_before_iso)
    with db.get_conn() as conn:
        rows = conn.execute(
            f"""SELECT my.event_id, COUNT(DISTINCT theirs.google_id) AS friend_count
                FROM rsvps my
                JOIN rsvps theirs ON theirs.event_id = my.event_id
                WHERE my.google_id = ?
                  AND theirs.google_id IN ({placeholders})
                  {extra}
                GROUP BY my.event_id""",
            params,
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
    now_iso = now.isoformat()
    # Anti-game: count-based badges only count "matured" RSVPs (events
    # whose date already passed). Spike-and-cancel farming has no payoff
    # because you can't cancel a past event to undo the unlock.
    mature = _mature_rsvps(rsvps, now)

    # ── First-step (binary, instant — welcome bonus) ──
    # first_rsvp + first_group skip the maturity filter so a brand-new
    # user gets the dopamine hit immediately. Both are tier-1-only and
    # cosmetically gameable but not meaningfully so.
    if rsvps:
        _award_or_upgrade(newly, google_id, "first_rsvp", value=1)
    if _group_count(google_id) >= 1:
        _award_or_upgrade(newly, google_id, "first_group", value=1)

    # ── Galera junto (friend count, tiered 1/5/15/30) ──
    # Solo-game-resistant: needs another user to accept the friendship.
    friend_count = _accepted_friend_count(google_id)
    _award_or_upgrade(newly, google_id, "first_friend", value=friend_count,
                      metadata={"count": friend_count})

    # ── Versátil (4-tier ladder by time window — wider→tighter) ──
    # Mature filter: kinds are counted from past events only.
    versatil = _versatil_tier(mature, now)
    if versatil > 0:
        _award_or_upgrade(newly, google_id, "versatil", value=versatil,
                          metadata={"window_tier": versatil, "kinds": sorted(ALL_KINDS)})

    # ── Explorer (distinct bairros from MATURED RSVPs, 3-tier ladder) ──
    bairros = _distinct_neighborhoods(mature)
    _award_or_upgrade(newly, google_id, "explorer", value=len(bairros),
                      metadata={"bairros": sorted(bairros)})

    # ── Noiteiro (matured ≥19h count, 3-tier ladder) ──
    night_count = sum(1 for r in mature if _is_after(r.get("event_date") or "", 19))
    _award_or_upgrade(newly, google_id, "noiteiro", value=night_count,
                      metadata={"count": night_count})

    # ── Diurno (matured <19h count, symmetric to Noiteiro) ──
    day_count = sum(1 for r in mature if _is_before(r.get("event_date") or "", 19))
    _award_or_upgrade(newly, google_id, "diurno", value=day_count,
                      metadata={"count": day_count})

    # ── Maratonista (distinct matured days with 2+ RSVPs) ──
    busy_days = _busy_day_count(mature)
    if busy_days > 0:
        _award_or_upgrade(newly, google_id, "maratonista", value=busy_days,
                          metadata={"count": busy_days})

    # ── Social: vai_junto + cohort, mature-only via SQL filter ──
    overlap = _friend_event_overlap(google_id, mature_before_iso=now_iso)
    if overlap:
        events_with_friend = sum(1 for c in overlap.values() if c >= 1)
        max_friends = max(overlap.values())
        _award_or_upgrade(newly, google_id, "vai_junto", value=events_with_friend,
                          metadata={"events": events_with_friend})
        _award_or_upgrade(newly, google_id, "cohort", value=max_friends,
                          metadata={"max_friends_at_event": max_friends})

    # ── Anfitrião (groups created by user with 3+ members) ──
    # Solo-game-resistant: needs 3 distinct google accounts to join.
    hosted = _hosted_group_count(google_id)
    if hosted > 0:
        _award_or_upgrade(newly, google_id, "anfitriao", value=hosted,
                          metadata={"count": hosted})

    # ── Curador (matured events added to groups by user) ──
    # Mature filter prevents add-then-delete farm — user has to wait
    # for the event to actually happen for it to count.
    curated = _curated_count(google_id, mature_before_iso=now_iso)
    if curated > 0:
        _award_or_upgrade(newly, google_id, "curador", value=curated,
                          metadata={"count": curated})

    # ── Organizador (matured personal plans the user created) ──
    # Same anti-farm guard as curador — count only past-date plans.
    organized = _organized_count(google_id, mature_before_iso=now_iso)
    if organized > 0:
        _award_or_upgrade(newly, google_id, "organizador", value=organized,
                          metadata={"count": organized})

    # ── Crew quente (lifetime events in the user's most-active group) ──
    # Solo-game-resistant: needs other members to keep a group going,
    # and the count is the MAX across the user's groups, so joining
    # five quiet groups doesn't help.
    hottest = _hottest_group_event_count(google_id)
    if hottest > 0:
        _award_or_upgrade(newly, google_id, "crew_quente", value=hottest,
                          metadata={"count": hottest})

    # ── Loyalty: local_da_casa per venue (matured RSVPs, 4-tier) ──
    for venue, count in _venue_counts(mature).items():
        _award_or_upgrade(newly, google_id, "local_da_casa", value=count,
                          instance_label=venue,
                          metadata={"venue": venue, "count": count})

    if newly:
        log.info("Awarded %d badges to %s: %s", len(newly), google_id,
                 ", ".join(b["id"] + (f"→T{b['tier']}" if b['tier'] > 1 else "") for b in newly))
    return newly


def catalog() -> list[dict]:
    """Return the static catalog with tier ladder info attached. Frontend
    uses tiers to render the progression bar / 'next tier in N' hint.
    `tiers` is the *display* threshold (e.g. days for versatil) — for the
    engine logic, callers should still use TIERS directly."""
    out = []
    for bid, meta in BADGES.items():
        engine_tiers = TIERS.get(bid, [1])
        display = DISPLAY_TIERS.get(bid, engine_tiers)
        out.append({
            "id": bid,
            **meta,
            "tiers": display,
            "max_tier": len(engine_tiers),
        })
    return out


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
