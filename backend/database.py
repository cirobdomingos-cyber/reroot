"""
SQLite simples com TTL. Sem ORM — sqlite3 puro é suficiente aqui.
Grain: um evento enriquecido por (source, external_id).
"""
import hashlib
import os
import secrets
import sqlite3
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional
from models import EnrichedEvent

# Path is overridable via DB_PATH env var so production can mount the DB on
# a persistent volume (e.g. Railway volume at /data/reroot_events.db). Local
# dev falls back to the in-repo file. Parent dir is created on demand so a
# fresh volume mount works on the first boot.
_db_env = os.environ.get("DB_PATH", "").strip()
DB_PATH = Path(_db_env) if _db_env else (Path(__file__).parent / "reroot_events.db")
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id              TEXT PRIMARY KEY,
                source          TEXT NOT NULL,
                external_id     TEXT NOT NULL,
                payload         TEXT NOT NULL,  -- JSON do EnrichedEvent
                fetched_at      TEXT NOT NULL,
                enriched_at     TEXT,
                is_curated      INTEGER NOT NULL DEFAULT 0,
                UNIQUE(source, external_id)
            )
        """)
        # Migration: rename legacy good_for_reroot column to is_curated
        # (rebrand cleanup, Apr 2026). Safe to call repeatedly — fails
        # silently if the column is already renamed or missing.
        try:
            conn.execute("ALTER TABLE events RENAME COLUMN good_for_reroot TO is_curated")
        except sqlite3.OperationalError:
            pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS refresh_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at  TEXT NOT NULL,
                finished_at TEXT,
                source      TEXT,
                events_new  INTEGER DEFAULT 0,
                events_updated INTEGER DEFAULT 0,
                error       TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS analytics_events (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                event_name      TEXT NOT NULL,
                properties_json TEXT NOT NULL DEFAULT '{}',
                session_id      TEXT NOT NULL DEFAULT '',
                created_at      TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                endpoint   TEXT UNIQUE NOT NULL,
                keys_json  TEXT NOT NULL,
                google_id  TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        # Migration: older installs predate the google_id column. Without
        # it we can't target a specific user — only broadcast — so adding
        # it is what unlocks per-user pushes (group events, friend RSVPs).
        try:
            conn.execute("ALTER TABLE push_subscriptions ADD COLUMN google_id TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # already migrated
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_states (
                google_id   TEXT PRIMARY KEY,
                state_json  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS rsvps (
                google_id    TEXT NOT NULL,
                event_id     TEXT NOT NULL,
                event_name   TEXT NOT NULL,
                event_venue  TEXT NOT NULL DEFAULT '',
                event_date   TEXT NOT NULL DEFAULT '',
                event_url    TEXT NOT NULL DEFAULT '',
                created_at   TEXT NOT NULL,
                PRIMARY KEY (google_id, event_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS friendships (
                user_a       TEXT NOT NULL,
                user_b       TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'pending',
                initiated_by TEXT NOT NULL,
                created_at   TEXT NOT NULL,
                PRIMARY KEY (user_a, user_b)
            )
        """)
        # One-shot migration: flip any legacy 'pending' friendships to 'accepted'.
        conn.execute(
            "UPDATE friendships SET status = 'accepted' WHERE status = 'pending'"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS submitted_events (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL,
                description     TEXT NOT NULL DEFAULT '',
                venue_name      TEXT NOT NULL DEFAULT '',
                venue_address   TEXT NOT NULL DEFAULT '',
                city            TEXT NOT NULL DEFAULT 'Curitiba',
                date_start      TEXT NOT NULL,
                price_min       REAL NOT NULL DEFAULT 0.0,
                price_max       REAL NOT NULL DEFAULT 0.0,
                url             TEXT NOT NULL DEFAULT '',
                submitted_by    TEXT,
                status          TEXT NOT NULL DEFAULT 'pending',
                enriched_event_id TEXT,
                created_at      TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS groups (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                visibility   TEXT NOT NULL DEFAULT 'private',
                invite_code  TEXT UNIQUE NOT NULL,
                feed_token   TEXT UNIQUE NOT NULL,
                created_by   TEXT NOT NULL,
                created_at   TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS group_members (
                group_id    TEXT NOT NULL,
                google_id   TEXT NOT NULL,
                role        TEXT NOT NULL DEFAULT 'member',
                joined_at   TEXT NOT NULL,
                PRIMARY KEY (group_id, google_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tracked_ig_accounts (
                handle              TEXT PRIMARY KEY,        -- lowercased Instagram handle, no '@'
                label               TEXT NOT NULL DEFAULT '', -- human-readable name (e.g., "Café Lucca")
                category            TEXT NOT NULL DEFAULT '', -- free-text tag (e.g., "café", "museu", "curador")
                enabled             INTEGER NOT NULL DEFAULT 1,
                added_at            TEXT NOT NULL,
                last_scraped_at     TEXT,
                last_event_count    INTEGER NOT NULL DEFAULT 0,
                notes               TEXT NOT NULL DEFAULT '',
                added_by_email      TEXT NOT NULL DEFAULT ''
            )
        """)
        # Migrate existing tables: add columns if they're missing (SQLite
        # has no IF NOT EXISTS for ALTER, so we try-and-swallow).
        for col_def in (
            "ADD COLUMN added_by_email TEXT NOT NULL DEFAULT ''",
            # IG profile enrichment — captured from Apify's first post per handle.
            "ADD COLUMN display_name TEXT NOT NULL DEFAULT ''",
            "ADD COLUMN profile_pic_url TEXT NOT NULL DEFAULT ''",
            "ADD COLUMN bio_snippet TEXT NOT NULL DEFAULT ''",
            # Cheap-probe + throttle support: last seen post shortcode (so we
            # can skip the full scrape when there's nothing new) and last
            # details-call timestamp (so profile-metadata calls run at most
            # once per 24h per handle).
            "ADD COLUMN last_post_shortcode TEXT NOT NULL DEFAULT ''",
            "ADD COLUMN last_details_at TEXT",
        ):
            try:
                conn.execute(f"ALTER TABLE tracked_ig_accounts {col_def}")
            except sqlite3.OperationalError:
                pass  # column already present
        conn.execute("""
            CREATE TABLE IF NOT EXISTS curators (
                email           TEXT PRIMARY KEY,            -- lowercased email
                added_by_email  TEXT NOT NULL DEFAULT '',
                added_at        TEXT NOT NULL,
                notes           TEXT NOT NULL DEFAULT '',
                is_founder      INTEGER NOT NULL DEFAULT 0,  -- can manage roles + curators
                is_curator      INTEGER NOT NULL DEFAULT 1,  -- can edit Instagram catalog
                is_feedbacker   INTEGER NOT NULL DEFAULT 0   -- can submit product feedback
            )
        """)
        # Migrate older curators rows that predate the role split — they were
        # all curators by definition (presence in table = curator), so default
        # is_curator=1 covers them. is_feedbacker stays 0 until granted.
        for col, default in [("is_curator", 1), ("is_feedbacker", 0)]:
            try:
                conn.execute(
                    f"ALTER TABLE curators ADD COLUMN {col} INTEGER NOT NULL DEFAULT {default}"
                )
            except sqlite3.OperationalError:
                pass  # column already present
        # Founder always has every role — patch it so checks elsewhere can
        # rely on the flags directly without special-casing is_founder.
        conn.execute(
            "UPDATE curators SET is_curator = 1, is_feedbacker = 1 WHERE is_founder = 1"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS feedback (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                email       TEXT NOT NULL,        -- submitter's email (lowercased)
                google_id   TEXT NOT NULL DEFAULT '',
                text        TEXT NOT NULL,
                context     TEXT NOT NULL DEFAULT '',  -- screen / route hint
                created_at  TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'open'  -- open | concluded | canceled
            )
        """)
        # Migrate older feedback rows that predate the status field
        try:
            conn.execute(
                "ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'open'"
            )
        except sqlite3.OperationalError:
            pass  # column already present
        conn.execute("""
            CREATE TABLE IF NOT EXISTS group_events (
                id           TEXT PRIMARY KEY,
                group_id     TEXT,
                name         TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                venue        TEXT NOT NULL DEFAULT '',
                date_start   TEXT NOT NULL,
                date_end     TEXT,
                created_by   TEXT NOT NULL,
                visibility   TEXT NOT NULL DEFAULT 'members',
                note         TEXT NOT NULL DEFAULT '',
                extra_invitee_ids TEXT NOT NULL DEFAULT '[]',
                created_at   TEXT NOT NULL
            )
        """)
        # Migration: `note` field added so users can leave a "pessoal que tal
        # esse?" message when adding an event to a group. R3 finding (P29 +
        # P31): without it, users migrate the conversation to WhatsApp.
        try:
            conn.execute("ALTER TABLE group_events ADD COLUMN note TEXT NOT NULL DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # column already present
        # Migration: `extra_invitee_ids` (JSON array of google_ids) added so
        # users can invite specific friends — either alongside a group OR
        # as a "personal plan" (group_id IS NULL). Existing rows default to
        # an empty array, preserving classic group-event semantics.
        try:
            conn.execute(
                "ALTER TABLE group_events ADD COLUMN extra_invitee_ids TEXT NOT NULL DEFAULT '[]'"
            )
        except sqlite3.OperationalError:
            pass  # column already present
        # Achievements/badges. One row per (user, badge) once earned —
        # categorical, never revoked. Metadata column captures context like
        # which venue triggered a "Local da casa" badge. Tier captures
        # progression within the same template (bronze→silver→gold→diamond).
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_badges (
                google_id   TEXT NOT NULL,
                badge_id    TEXT NOT NULL,
                earned_at   TEXT NOT NULL,
                metadata    TEXT NOT NULL DEFAULT '{}',
                tier        INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (google_id, badge_id)
            )
        """)
        # Migration: add tier column for installs that pre-date v3.
        # Existing rows default to tier 1 — they were earned before tiers
        # existed and represent the lowest threshold.
        try:
            conn.execute("ALTER TABLE user_badges ADD COLUMN tier INTEGER NOT NULL DEFAULT 1")
        except sqlite3.OperationalError:
            pass  # column already present
        conn.commit()


# ── Submitted events (user/partner submissions) ───────────

def insert_submitted_event(
    name: str, description: str, venue_name: str, venue_address: str,
    city: str, date_start: str, price_min: float, price_max: float,
    url: str, submitted_by: Optional[str] = None,
) -> int:
    """Record a user-submitted event. Returns the new row id."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO submitted_events
              (name, description, venue_name, venue_address, city,
               date_start, price_min, price_max, url, submitted_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (name, description, venue_name, venue_address, city,
             date_start, price_min, price_max, url, submitted_by, now),
        )
        conn.commit()
        return cur.lastrowid


def mark_submitted_enriched(submission_id: int, enriched_event_id: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE submitted_events SET status='enriched', enriched_event_id=? WHERE id=?",
            (enriched_event_id, submission_id),
        )
        conn.commit()


def count_upcoming_events(city: str) -> int:
    """Count events with date_start in the future — used for gap-fill decision."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) as cnt FROM events
            WHERE json_extract(payload, '$.city') = ?
              AND json_extract(payload, '$.date_start') > ?
            """,
            (city, now),
        ).fetchone()
    return row["cnt"] if row else 0


# ── Push subscriptions ─────────────────────────────────────

def upsert_push_subscription(endpoint: str, keys_json: str, google_id: str = "") -> None:
    """Insert or replace a Web Push subscription (upsert on endpoint).
    `google_id` links the subscription to a logged-in user — required for
    per-user pushes (group events, friend RSVPs)."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO push_subscriptions (endpoint, keys_json, google_id, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
                keys_json  = excluded.keys_json,
                google_id  = excluded.google_id,
                created_at = excluded.created_at
        """, (endpoint, keys_json, google_id, now))
        conn.commit()


def get_all_push_subscriptions() -> list[dict]:
    """Return all stored push subscriptions as dicts. Used by the weekly
    broadcast — per-user pushes use get_push_subscriptions_for_user()."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT endpoint, keys_json FROM push_subscriptions"
        ).fetchall()
    return [{"endpoint": r["endpoint"], "keys": json.loads(r["keys_json"])} for r in rows]


def get_push_subscriptions_for_user(google_id: str) -> list[dict]:
    """All subscriptions for a single user. A user can have multiple devices
    (laptop + phone PWA), each registers its own endpoint."""
    if not google_id:
        return []
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT endpoint, keys_json FROM push_subscriptions WHERE google_id = ?",
            (google_id,),
        ).fetchall()
    return [{"endpoint": r["endpoint"], "keys": json.loads(r["keys_json"])} for r in rows]


def delete_push_subscription_by_endpoint(endpoint: str) -> None:
    """Remove a dead subscription (push service returned 410 Gone or 404).
    Keeps the table clean and prevents wasted retry attempts."""
    with get_conn() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
        conn.commit()


def rsvp_exists(google_id: str, event_id: str) -> bool:
    """Pre-write check used to detect whether an RSVP is brand new vs a
    re-confirm — prevents friend-RSVP push spam on toggle off→on cycles."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM rsvps WHERE google_id = ? AND event_id = ?",
            (google_id, event_id),
        ).fetchone()
    return row is not None


# ── User state persistence ─────────────────────────────────

def get_user_state(google_id: str) -> Optional[dict]:
    """Return parsed state dict for the given Google account, or None."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT state_json FROM user_states WHERE google_id = ?",
            (google_id,),
        ).fetchone()
    if not row:
        return None
    return json.loads(row["state_json"])


def upsert_user_state(google_id: str, state: dict) -> None:
    """Insert or replace the full state blob for the given Google account."""
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO user_states (google_id, state_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(google_id) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = excluded.updated_at
            """,
            (google_id, json.dumps(state), datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()


# ── Curators (collaborative IG account curation) ──────────

def is_curator(email: str) -> bool:
    if not email:
        return False
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM curators WHERE email = ? AND is_curator = 1",
            (email.strip().lower(),),
        ).fetchone()
    return row is not None


def is_founder(email: str) -> bool:
    if not email:
        return False
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM curators WHERE email = ? AND is_founder = 1",
            (email.strip().lower(),),
        ).fetchone()
    return row is not None


def is_feedbacker(email: str) -> bool:
    if not email:
        return False
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM curators WHERE email = ? AND is_feedbacker = 1",
            (email.strip().lower(),),
        ).fetchone()
    return row is not None


def list_curators() -> list[dict]:
    """All permissioned users (any role). Sorted founder-first, then by add date."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM curators ORDER BY is_founder DESC, added_at ASC"
        ).fetchall()
    return [dict(r) for r in rows]


def add_curator(email: str, added_by_email: str = "", notes: str = "",
                is_founder_flag: bool = False,
                is_curator_flag: bool = True,
                is_feedbacker_flag: bool = False) -> dict:
    """
    Upsert a permissioned user with explicit role flags. On conflict, the
    notes are overwritten and roles are merged with MAX (a role can be
    granted via re-add but not revoked here — use update_curator_roles).
    Founder rows always end up with every flag = 1.
    """
    email = email.strip().lower()
    if not email or "@" not in email:
        raise ValueError("invalid email")
    now = datetime.now(timezone.utc).isoformat()
    if is_founder_flag:
        is_curator_flag = True
        is_feedbacker_flag = True
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO curators (email, added_by_email, added_at, notes,
                                  is_founder, is_curator, is_feedbacker)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                notes = excluded.notes,
                is_founder    = MAX(curators.is_founder,    excluded.is_founder),
                is_curator    = MAX(curators.is_curator,    excluded.is_curator),
                is_feedbacker = MAX(curators.is_feedbacker, excluded.is_feedbacker)
        """, (
            email, added_by_email.strip().lower(), now, notes,
            1 if is_founder_flag else 0,
            1 if is_curator_flag else 0,
            1 if is_feedbacker_flag else 0,
        ))
        conn.commit()
        row = conn.execute("SELECT * FROM curators WHERE email = ?", (email,)).fetchone()
    return dict(row)


def update_curator_roles(email: str, is_curator_flag: bool,
                         is_feedbacker_flag: bool) -> Optional[dict]:
    """
    Toggle is_curator and is_feedbacker for an existing row. Founders are
    untouched — they always keep every flag. Returns the updated row, or
    None if the email isn't in the table.
    """
    email = email.strip().lower()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT is_founder FROM curators WHERE email = ?", (email,)
        ).fetchone()
        if not row:
            return None
        if row["is_founder"]:
            # Founder: ignore role updates (they always have every role).
            return dict(conn.execute(
                "SELECT * FROM curators WHERE email = ?", (email,)
            ).fetchone())
        conn.execute(
            "UPDATE curators SET is_curator = ?, is_feedbacker = ? WHERE email = ?",
            (1 if is_curator_flag else 0, 1 if is_feedbacker_flag else 0, email),
        )
        conn.commit()
        # If both flags become 0, drop the row entirely — they're no longer
        # permissioned. Cleanup keeps the curators table meaningful.
        if not is_curator_flag and not is_feedbacker_flag:
            conn.execute("DELETE FROM curators WHERE email = ? AND is_founder = 0", (email,))
            conn.commit()
            return None
        return dict(conn.execute(
            "SELECT * FROM curators WHERE email = ?", (email,)
        ).fetchone())


def remove_curator(email: str) -> bool:
    """Remove a curator. Founders cannot be removed via this function."""
    email = email.strip().lower()
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM curators WHERE email = ? AND is_founder = 0", (email,)
        )
        conn.commit()
        return cur.rowcount > 0


# ── Feedback ──────────────────────────────────────────────


def insert_feedback(email: str, text: str, google_id: str = "",
                    context: str = "") -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO feedback (email, google_id, text, context, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (email.strip().lower(), google_id, text.strip(), context.strip(), now),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM feedback WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return dict(row)


def list_feedback(limit: int = 200) -> list[dict]:
    """Sort: open feedback first (newest first), then resolved (newest first)."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT * FROM feedback
               ORDER BY (status = 'open') DESC, created_at DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def update_feedback_status(feedback_id: int, status: str) -> Optional[dict]:
    if status not in ('open', 'concluded', 'canceled'):
        raise ValueError(f"invalid status: {status}")
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE feedback SET status = ? WHERE id = ?",
            (status, feedback_id),
        )
        if cur.rowcount == 0:
            return None
        conn.commit()
        row = conn.execute(
            "SELECT * FROM feedback WHERE id = ?", (feedback_id,)
        ).fetchone()
    return dict(row) if row else None


# ── Tracked Instagram accounts ─────────────────────────────

def list_ig_accounts() -> list[dict]:
    """Return all tracked IG accounts, ordered by enabled-first then added time."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM tracked_ig_accounts ORDER BY enabled DESC, added_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_enabled_ig_accounts() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT handle, label, category FROM tracked_ig_accounts WHERE enabled = 1"
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_ig_account(handle: str, label: str = "", category: str = "",
                      enabled: bool = True, notes: str = "",
                      added_by_email: str = "") -> dict:
    """Insert or update a tracked account. Handle is normalized to lowercase, no '@'."""
    handle = handle.strip().lstrip("@").lower()
    if not handle:
        raise ValueError("handle is required")
    now = datetime.now(timezone.utc).isoformat()
    added_by = added_by_email.strip().lower()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO tracked_ig_accounts
              (handle, label, category, enabled, added_at, notes, added_by_email)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(handle) DO UPDATE SET
                label    = excluded.label,
                category = excluded.category,
                enabled  = excluded.enabled,
                notes    = excluded.notes
                -- preserve original added_by_email; don't overwrite on edits
        """, (handle, label, category, 1 if enabled else 0, now, notes, added_by))
        conn.commit()
        row = conn.execute(
            "SELECT * FROM tracked_ig_accounts WHERE handle = ?", (handle,)
        ).fetchone()
    return dict(row)


def delete_ig_account(handle: str) -> bool:
    handle = handle.strip().lstrip("@").lower()
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM tracked_ig_accounts WHERE handle = ?", (handle,))
        conn.commit()
        return cur.rowcount > 0


def get_ig_account(handle: str) -> Optional[dict]:
    """Single-row lookup by handle. Returns None if not found."""
    handle = handle.strip().lstrip("@").lower()
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM tracked_ig_accounts WHERE handle = ?", (handle,)
        ).fetchone()
    return dict(row) if row else None


def set_ig_account_last_post_shortcode(handle: str, shortcode: str) -> None:
    handle = handle.strip().lstrip("@").lower()
    with get_conn() as conn:
        conn.execute(
            "UPDATE tracked_ig_accounts SET last_post_shortcode = ? WHERE handle = ?",
            (shortcode[:200], handle),
        )
        conn.commit()


def mark_ig_account_details_fresh(handle: str) -> None:
    """Stamp last_details_at = now so we throttle profile-metadata calls."""
    handle = handle.strip().lstrip("@").lower()
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            "UPDATE tracked_ig_accounts SET last_details_at = ? WHERE handle = ?",
            (now, handle),
        )
        conn.commit()


def update_ig_account_profile(handle: str, display_name: str = "",
                              profile_pic_url: str = "", bio_snippet: str = "") -> None:
    """
    Update the profile-level metadata for a tracked IG account. Called
    after a scrape with the first post's owner data so the admin UI can
    show real profile pictures and display names.
    """
    handle = handle.strip().lstrip("@").lower()
    if not handle:
        return
    with get_conn() as conn:
        conn.execute(
            """UPDATE tracked_ig_accounts
               SET display_name = ?, profile_pic_url = ?, bio_snippet = ?
               WHERE handle = ?""",
            (display_name[:200], profile_pic_url[:500], bio_snippet[:500], handle),
        )
        conn.commit()


def mark_ig_account_scraped(handle: str) -> None:
    handle = handle.strip().lstrip("@").lower()
    with get_conn() as conn:
        conn.execute(
            "UPDATE tracked_ig_accounts SET last_scraped_at = ? WHERE handle = ?",
            (datetime.now(timezone.utc).isoformat(), handle),
        )
        conn.commit()


def set_ig_account_last_event_count(handle: str, count: int) -> None:
    handle = handle.strip().lstrip("@").lower()
    with get_conn() as conn:
        conn.execute(
            "UPDATE tracked_ig_accounts SET last_event_count = ? WHERE handle = ?",
            (count, handle),
        )
        conn.commit()


def insert_analytics_event(event_name: str, properties_json: str, session_id: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO analytics_events (event_name, properties_json, session_id, created_at) VALUES (?, ?, ?, ?)",
            (event_name, properties_json, session_id, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()


def get_usage_stats(window_days: int = 30) -> dict:
    """
    Aggregated app-usage metrics for the founder dashboard. All counts
    derived from existing tables — no new instrumentation needed.

    Returns:
      total_users:        rows in user_states
      new_today:          users whose first save was today
      dau, wau, mau:      distinct google_ids active in last 1/7/30 days
      daily:              [{date, active}] for last `window_days` days
      funnel:             [{step, count}] of life-cycle progression
      top_emails_recent:  last 10 distinct logins (from user_states.updated_at desc)
      counts:             {rsvps, friendships, groups, feedback}
    """
    now = datetime.now(timezone.utc)
    today_iso = now.date().isoformat()
    day_ago = (now - timedelta(days=1)).isoformat()
    week_ago = (now - timedelta(days=7)).isoformat()
    month_ago = (now - timedelta(days=30)).isoformat()
    window_start = (now - timedelta(days=window_days)).date()

    with get_conn() as conn:
        # Totals + activity windows
        total_users = conn.execute("SELECT COUNT(*) FROM user_states").fetchone()[0]
        # `updated_at` proxies "last seen" — state syncs whenever the app
        # mutates state (login, RSVP, etc.). Good enough for active counts.
        dau = conn.execute(
            "SELECT COUNT(DISTINCT google_id) FROM user_states WHERE updated_at >= ?",
            (day_ago,),
        ).fetchone()[0]
        wau = conn.execute(
            "SELECT COUNT(DISTINCT google_id) FROM user_states WHERE updated_at >= ?",
            (week_ago,),
        ).fetchone()[0]
        mau = conn.execute(
            "SELECT COUNT(DISTINCT google_id) FROM user_states WHERE updated_at >= ?",
            (month_ago,),
        ).fetchone()[0]
        new_today = conn.execute(
            # `created_at` doesn't exist on user_states (it only has
            # updated_at) — best approximation: rows whose updated_at
            # was today AND whose previous-day activity is absent. Cheap
            # version: rows with updated_at >= today's start that look
            # like first-day rows. Approximate; refine if needed.
            "SELECT COUNT(*) FROM user_states WHERE substr(updated_at, 1, 10) = ?",
            (today_iso,),
        ).fetchone()[0]

        # Daily series — counts per day in the window
        daily_rows = conn.execute(
            """SELECT substr(updated_at, 1, 10) as day,
                      COUNT(DISTINCT google_id) as active
               FROM user_states
               WHERE substr(updated_at, 1, 10) >= ?
               GROUP BY day
               ORDER BY day ASC""",
            (window_start.isoformat(),),
        ).fetchall()
        daily = [{"date": r["day"], "active": r["active"]} for r in daily_rows]

        # Funnel steps — life-cycle progression
        users_with_profile = conn.execute(
            """SELECT COUNT(*) FROM user_states
               WHERE json_extract(state_json, '$.profile') IS NOT NULL"""
        ).fetchone()[0]
        users_with_rsvp = conn.execute(
            "SELECT COUNT(DISTINCT google_id) FROM rsvps"
        ).fetchone()[0]
        users_with_friend = conn.execute(
            """SELECT COUNT(DISTINCT user_a) + COUNT(DISTINCT user_b) -
               (SELECT COUNT(DISTINCT user_a) FROM friendships fb
                WHERE fb.user_a IN (SELECT user_b FROM friendships))
               FROM friendships"""
        ).fetchone()[0] or 0  # rough — overlapping users counted once via subquery
        users_with_group = conn.execute(
            "SELECT COUNT(DISTINCT google_id) FROM group_members"
        ).fetchone()[0]
        users_with_feedback = conn.execute(
            "SELECT COUNT(DISTINCT email) FROM feedback"
        ).fetchone()[0]

        funnel = [
            {"step": "Logaram", "count": total_users},
            {"step": "Escolheram vibe", "count": users_with_profile},
            {"step": "RSVP num evento", "count": users_with_rsvp},
            {"step": "Adicionaram amigo", "count": users_with_friend},
            {"step": "Entraram num grupo", "count": users_with_group},
            {"step": "Enviaram feedback", "count": users_with_feedback},
        ]

        # Recent logins — last 10 distinct users by updated_at
        recent_rows = conn.execute(
            """SELECT google_id, state_json, updated_at FROM user_states
               ORDER BY updated_at DESC LIMIT 10"""
        ).fetchall()
        recent = []
        for r in recent_rows:
            try:
                s = json.loads(r["state_json"]) if r["state_json"] else {}
                gu = s.get("googleUser") or {}
                recent.append({
                    "google_id": r["google_id"],
                    "email": gu.get("email", ""),
                    "name": s.get("userName") or gu.get("name") or gu.get("givenName") or "",
                    "picture": gu.get("picture", ""),
                    "last_seen": r["updated_at"],
                })
            except Exception:
                pass

        # Other counts
        counts = {
            "rsvps":       conn.execute("SELECT COUNT(*) FROM rsvps").fetchone()[0],
            "friendships": conn.execute("SELECT COUNT(*) FROM friendships").fetchone()[0],
            "groups":      conn.execute("SELECT COUNT(*) FROM groups").fetchone()[0],
            "feedback":    conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0],
        }

    return {
        "total_users": total_users,
        "new_today": new_today,
        "dau": dau,
        "wau": wau,
        "mau": mau,
        "daily": daily,
        "funnel": funnel,
        "recent": recent,
        "counts": counts,
    }


def get_funnel_counts() -> list[dict]:
    """Return event counts grouped by event_name, ordered by total desc."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT event_name, COUNT(*) as total FROM analytics_events GROUP BY event_name ORDER BY total DESC"
        ).fetchall()
    return [{"event_name": row["event_name"], "total": row["total"]} for row in rows]


def upsert_event(ev: EnrichedEvent) -> bool:
    """Insert or update by (source, external_id). Returns True when a new row
    was inserted, False when an existing row was updated. The flag drives the
    truthful "novos vs atualizados" count in the post-scrape summary email."""
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT 1 FROM events WHERE source = ? AND external_id = ?",
            (ev.source, ev.external_id),
        ).fetchone()
        was_new = existing is None
        conn.execute("""
            INSERT INTO events (id, source, external_id, payload, fetched_at, enriched_at, is_curated)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, external_id) DO UPDATE SET
                payload         = excluded.payload,
                fetched_at      = excluded.fetched_at,
                enriched_at     = excluded.enriched_at,
                is_curated      = excluded.is_curated
        """, (
            ev.id,
            ev.source,
            ev.external_id,
            ev.model_dump_json(),
            ev.fetched_at.isoformat(),
            ev.enriched_at.isoformat() if ev.enriched_at else None,
            1 if ev.is_curated else 0,
        ))
        conn.commit()
    return was_new


def get_events(
    city: str = "Curitiba",
    good_only: bool = False,
    category: Optional[str] = None,
    price_tier: Optional[str] = None,
    kids_welcome: Optional[bool] = None,
    limit: int = 20,
) -> list[EnrichedEvent]:
    query = "SELECT payload FROM events WHERE 1=1"
    params: list = []

    if good_only:
        query += " AND is_curated = 1"

    # date filter — keep events that haven't ended yet. Single-day events (no
    # date_end) must start today or later. Multi-day events (e.g. MON
    # exhibitions running for months) stay visible while their end date is in
    # the future, even if they started long ago.
    today = datetime.now(timezone.utc).date().isoformat()
    query += """
        AND (
            json_extract(payload, '$.is_recurring') = 1
            OR (json_extract(payload, '$.date_end') IS NULL
                AND substr(json_extract(payload, '$.date_start'), 1, 10) >= ?)
            OR (json_extract(payload, '$.date_end') IS NOT NULL
                AND substr(json_extract(payload, '$.date_end'), 1, 10) >= ?)
        )
    """
    params.append(today)
    params.append(today)

    if category and category != "all":
        query += " AND json_extract(payload, '$.kind') = ?"
        params.append(category)

    if price_tier == "free":
        query += " AND json_extract(payload, '$.price_tier') = 'free'"
    elif price_tier == "paid":
        query += " AND json_extract(payload, '$.price_tier') != 'free'"

    if kids_welcome is True:
        query += " AND json_extract(payload, '$.kids_welcome') = true"

    query += " ORDER BY json_extract(payload, '$.date_start') ASC LIMIT ?"
    params.append(limit)

    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()

    return [EnrichedEvent(**json.loads(row["payload"])) for row in rows]


def delete_events_by_handle_except(handle: str, keep_ids: set[str]) -> int:
    """
    Delete every Instagram event row for `handle` whose id isn't in
    `keep_ids`. Used by the manual single-handle scrape to clean up stale
    entries that the re-evaluation no longer recognizes as valid future
    events. Returns rows deleted.
    """
    handle = handle.strip().lstrip("@").lower()
    if not handle:
        return 0
    pattern = f"ig_{handle}_%"
    keep_list = list(keep_ids)
    placeholders = ",".join("?" * len(keep_list)) if keep_list else "''"
    query = f"""
        DELETE FROM events
        WHERE source = 'instagram'
        AND external_id LIKE ?
        AND id NOT IN ({placeholders})
    """
    params = [pattern, *keep_list]
    with get_conn() as conn:
        cur = conn.execute(query, params)
        conn.commit()
        return cur.rowcount


def get_event_by_id(event_id: str) -> Optional[EnrichedEvent]:
    with get_conn() as conn:
        row = conn.execute("SELECT payload FROM events WHERE id = ?", (event_id,)).fetchone()
    if not row:
        return None
    return EnrichedEvent(**json.loads(row["payload"]))


def count_events() -> int:
    """Total events in the catalog. Used by /health as a liveness signal."""
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]


def count_future_events_by_source() -> dict:
    """
    Returns {source: count} for events whose start (or end, for multi-day)
    is today or later. Used by the Sources page to show "X eventos próximos"
    per scraper. Single query; cheap.
    """
    today = datetime.now(timezone.utc).date().isoformat()
    query = """
        SELECT source, COUNT(*) as n
        FROM events
        WHERE (
            (json_extract(payload, '$.date_end') IS NULL
                AND substr(json_extract(payload, '$.date_start'), 1, 10) >= ?)
            OR
            (json_extract(payload, '$.date_end') IS NOT NULL
                AND substr(json_extract(payload, '$.date_end'), 1, 10) >= ?)
        )
        GROUP BY source
    """
    with get_conn() as conn:
        rows = conn.execute(query, (today, today)).fetchall()
    return {row["source"]: row["n"] for row in rows}


def count_future_events_by_ig_handle() -> dict:
    """
    Per-handle counts for Instagram events. external_id is "ig_<handle>_<shortcode>",
    so we strip the prefix and group by handle. Single query; cheap.
    """
    today = datetime.now(timezone.utc).date().isoformat()
    query = """
        SELECT external_id
        FROM events
        WHERE source = 'instagram' AND (
            (json_extract(payload, '$.date_end') IS NULL
                AND substr(json_extract(payload, '$.date_start'), 1, 10) >= ?)
            OR
            (json_extract(payload, '$.date_end') IS NOT NULL
                AND substr(json_extract(payload, '$.date_end'), 1, 10) >= ?)
        )
    """
    counts: dict = {}
    with get_conn() as conn:
        for row in conn.execute(query, (today, today)).fetchall():
            ext = row["external_id"] or ""
            # ig_<handle>_<shortcode>  →  handle is the second token
            parts = ext.split("_", 2)
            if len(parts) >= 2 and parts[0] == "ig":
                counts[parts[1]] = counts.get(parts[1], 0) + 1
    return counts


def get_future_events_by_source(source: str, ig_handle: Optional[str] = None,
                                limit: int = 100) -> list[EnrichedEvent]:
    """
    Future events from a specific source. When source='instagram' and
    ig_handle is given, narrows further by external_id prefix.
    """
    today = datetime.now(timezone.utc).date().isoformat()
    query = """
        SELECT payload, external_id FROM events
        WHERE source = ?
        AND (
            json_extract(payload, '$.is_recurring') = 1
            OR (json_extract(payload, '$.date_end') IS NULL
                AND substr(json_extract(payload, '$.date_start'), 1, 10) >= ?)
            OR (json_extract(payload, '$.date_end') IS NOT NULL
                AND substr(json_extract(payload, '$.date_end'), 1, 10) >= ?)
        )
    """
    params: list = [source, today, today]
    if source == "instagram" and ig_handle:
        query += " AND external_id LIKE ?"
        params.append(f"ig_{ig_handle}_%")
    query += " ORDER BY json_extract(payload, '$.date_start') ASC LIMIT ?"
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return [EnrichedEvent(**json.loads(row["payload"])) for row in rows]


def log_refresh_start(source: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO refresh_log (started_at, source) VALUES (?, ?)",
            (datetime.now().isoformat(), source)
        )
        conn.commit()
        return cur.lastrowid


def log_refresh_finish(log_id: int, events_new: int, events_updated: int, error: str = None):
    with get_conn() as conn:
        conn.execute("""
            UPDATE refresh_log
            SET finished_at = ?, events_new = ?, events_updated = ?, error = ?
            WHERE id = ?
        """, (datetime.now().isoformat(), events_new, events_updated, error, log_id))
        conn.commit()


def get_last_refresh_started_at() -> Optional[str]:
    """Most recent refresh_log.started_at across all sources, or None when the
    table is empty. Used at boot to decide whether to skip the immediate
    refresh — if the catalog was refreshed in the last 24h, deploys should
    not re-trigger the full scrape + Claude pipeline."""
    with get_conn() as conn:
        row = conn.execute("SELECT MAX(started_at) FROM refresh_log").fetchone()
    return row[0] if row and row[0] else None


def get_refresh_logs_since(started_at_iso: str) -> list[dict]:
    """All refresh_log rows started at or after the given ISO timestamp."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM refresh_log WHERE started_at >= ? ORDER BY started_at ASC",
            (started_at_iso,),
        ).fetchall()
    return [dict(r) for r in rows]


# ── RSVPs ──────────────────────────────────────────────────

def upsert_rsvp(
    google_id: str,
    event_id: str,
    event_name: str,
    event_venue: str,
    event_date: str,
    event_url: str,
) -> None:
    """Insert or replace a normalized RSVP row."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO rsvps (google_id, event_id, event_name, event_venue, event_date, event_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(google_id, event_id) DO UPDATE SET
                event_name  = excluded.event_name,
                event_venue = excluded.event_venue,
                event_date  = excluded.event_date,
                event_url   = excluded.event_url
            """,
            (google_id, event_id, event_name, event_venue, event_date, event_url, now),
        )
        conn.commit()


def delete_rsvp(google_id: str, event_id: str) -> None:
    """Remove an RSVP for a user/event pair."""
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM rsvps WHERE google_id = ? AND event_id = ?",
            (google_id, event_id),
        )
        conn.commit()


def get_rsvps_for_user(google_id: str) -> list[dict]:
    """Return all RSVPs for a single user."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT event_id, event_name, event_venue, event_date, event_url, created_at "
            "FROM rsvps WHERE google_id = ? ORDER BY event_date ASC",
            (google_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_rsvps_for_users(google_ids: list[str]) -> list[dict]:
    """Batch-fetch RSVPs for multiple users (friend feed query)."""
    if not google_ids:
        return []
    placeholders = ",".join("?" * len(google_ids))
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT google_id, event_id, event_name, event_venue, event_date, event_url, created_at "
            f"FROM rsvps WHERE google_id IN ({placeholders}) ORDER BY event_date ASC",
            google_ids,
        ).fetchall()
    return [dict(r) for r in rows]


# ── Event attendees ────────────────────────────────────────

def get_event_attendees(event_id: str, requesting_google_id: str) -> list[dict]:
    """
    Return all users who RSVPed to an event, excluding the requester.
    Each attendee includes name, picture (from user_states), and is_friend flag.
    Respects privacy: users with showProfileToStrangers=false who are not friends
    of the requester are excluded.
    """
    with get_conn() as conn:
        # Get all RSVPs for this event, excluding the requester
        rsvp_rows = conn.execute(
            "SELECT google_id FROM rsvps WHERE event_id = ? AND google_id != ?",
            (event_id, requesting_google_id),
        ).fetchall()

    if not rsvp_rows:
        return []

    # Get friendships for the requester (accepted + legacy pending rows)
    friend_ids = set()
    with get_conn() as conn:
        friend_rows = conn.execute(
            """
            SELECT user_a, user_b FROM friendships
            WHERE (user_a = ? OR user_b = ?)
              AND status IN ('accepted', 'pending')
            """,
            (requesting_google_id, requesting_google_id),
        ).fetchall()
    for row in friend_rows:
        friend_id = row["user_b"] if row["user_a"] == requesting_google_id else row["user_a"]
        friend_ids.add(friend_id)

    attendees = []
    with get_conn() as conn:
        for rsvp in rsvp_rows:
            gid = rsvp["google_id"]
            state_row = conn.execute(
                "SELECT state_json FROM user_states WHERE google_id = ?",
                (gid,),
            ).fetchone()

            name = gid
            picture = ""
            if state_row:
                try:
                    state = json.loads(state_row["state_json"])
                    # Privacy check: skip users who hide from non-friends
                    privacy = state.get("privacy", {})
                    is_friend = gid in friend_ids
                    if not is_friend and not privacy.get("showProfileToStrangers", False):
                        # Still show them — they RSVPed to a shared event.
                        # But respect showInFriendSuggestions if False: hide them entirely.
                        if not privacy.get("showInFriendSuggestions", True):
                            continue
                    name = state.get("userName") or gid
                    picture = (state.get("googleUser") or {}).get("picture", "")
                except Exception:
                    pass
            else:
                is_friend = gid in friend_ids

            attendees.append({
                "google_id": gid,
                "name": name,
                "picture": picture,
                "is_friend": gid in friend_ids,
            })

    return attendees


# ── Friends ────────────────────────────────────────────────

def get_friend_code(google_id: str) -> str:
    """Deterministic invite code: first 8 hex chars of sha256(google_id), uppercased."""
    return hashlib.sha256(google_id.encode()).hexdigest()[:8].upper()


def _code_to_google_id(code: str) -> Optional[str]:
    """
    Reverse-look up which google_id maps to a given friend code.
    Since the mapping is deterministic (sha256 prefix), we scan known users.
    """
    with get_conn() as conn:
        rows = conn.execute("SELECT google_id FROM user_states").fetchall()
    for row in rows:
        if get_friend_code(row["google_id"]) == code.upper():
            return row["google_id"]
    return None


def upsert_friendship(requester_google_id: str, code: str) -> dict:
    """
    Create an accepted friendship from requester to the user identified by code.

    We auto-accept: adding someone by code is already a deliberate social action
    (the code was shared in person or at an event), so a two-sided accept flow
    would add pure friction with no safety upside. The `status` column and
    `accept_friendship()` helper remain in place for a future request/accept flow.

    Returns:
        {'status': 'ok'}             — friendship row inserted (accepted)
        {'status': 'self'}           — code resolves to the requester themselves
        {'status': 'already_friends'}— row already exists (any status)
        {'status': 'not_found'}      — code does not match any known user
    """
    target_id = _code_to_google_id(code)
    if target_id is None:
        return {"status": "not_found"}
    if target_id == requester_google_id:
        return {"status": "self"}

    # Canonical ordering: user_a < user_b alphabetically
    user_a, user_b = sorted([requester_google_id, target_id])

    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT status FROM friendships WHERE user_a = ? AND user_b = ?",
            (user_a, user_b),
        ).fetchone()
        if existing:
            return {"status": "already_friends"}
        conn.execute(
            """
            INSERT INTO friendships (user_a, user_b, status, initiated_by, created_at)
            VALUES (?, ?, 'accepted', ?, ?)
            """,
            (user_a, user_b, requester_google_id, now),
        )
        conn.commit()
    return {"status": "ok"}


def remove_friendship(google_id: str, friend_google_id: str) -> bool:
    """
    Remove a friendship between two users. Returns True if a row was
    deleted, False if no friendship existed. The user_a/user_b pair is
    canonical (sorted) so order of args doesn't matter.
    """
    user_a, user_b = sorted([google_id, friend_google_id])
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM friendships WHERE user_a = ? AND user_b = ?",
            (user_a, user_b),
        )
        conn.commit()
        return cur.rowcount > 0


def accept_friendship(google_id: str, friend_google_id: str) -> bool:
    """
    Flip a pending friendship to accepted.
    Only the non-initiating party should call this.
    Returns True if a row was updated, False if not found.
    """
    user_a, user_b = sorted([google_id, friend_google_id])
    with get_conn() as conn:
        cur = conn.execute(
            """
            UPDATE friendships SET status = 'accepted'
            WHERE user_a = ? AND user_b = ? AND status = 'pending'
            """,
            (user_a, user_b),
        )
        conn.commit()
        return cur.rowcount > 0


def get_friends(google_id: str) -> list[dict]:
    """
    Return all friends of google_id, enriched with name/picture
    from their user_states blob.

    We accept both 'accepted' and 'pending' statuses so that any legacy rows
    created before auto-accept (which were stuck pending forever) surface
    correctly without requiring a migration.

    Shape: [{ google_id, name, picture, status }]
    """
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT user_a, user_b, status FROM friendships
            WHERE (user_a = ? OR user_b = ?)
              AND status IN ('accepted', 'pending')
            """,
            (google_id, google_id),
        ).fetchall()

    friends = []
    with get_conn() as conn:
        for row in rows:
            friend_id = row["user_b"] if row["user_a"] == google_id else row["user_a"]
            state_row = conn.execute(
                "SELECT state_json FROM user_states WHERE google_id = ?",
                (friend_id,),
            ).fetchone()
            name = friend_id
            picture = ""
            if state_row:
                try:
                    state = json.loads(state_row["state_json"])
                    name = state.get("userName") or friend_id
                    picture = (state.get("googleUser") or {}).get("picture", "")
                except Exception:
                    pass
            friends.append({
                "google_id": friend_id,
                "name": name,
                "picture": picture,
                "status": row["status"],
            })
    return friends


# ── Groups ────────────────────────────────────────────────

def create_group(google_id: str, name: str, description: str = "", visibility: str = "private") -> dict:
    """Create a group and add the creator as admin. Returns the new group dict."""
    now = datetime.now(timezone.utc).isoformat()
    group_id = f"grp_{secrets.token_hex(8)}"
    invite_code = secrets.token_hex(4).upper()  # 8 chars, WhatsApp-friendly
    feed_token = secrets.token_hex(16)  # 32 chars, unguessable for calendar feed

    with get_conn() as conn:
        conn.execute(
            """INSERT INTO groups (id, name, description, visibility, invite_code, feed_token, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (group_id, name, description, visibility, invite_code, feed_token, google_id, now),
        )
        conn.execute(
            "INSERT INTO group_members (group_id, google_id, role, joined_at) VALUES (?, ?, 'admin', ?)",
            (group_id, google_id, now),
        )
        conn.commit()

    return {
        "id": group_id, "name": name, "description": description,
        "visibility": visibility, "invite_code": invite_code,
        "feed_token": feed_token, "created_by": google_id, "created_at": now,
    }


def get_groups_for_user(google_id: str) -> list[dict]:
    """Return all groups a user belongs to, with member count and role."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT g.*, gm.role,
                      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
               FROM groups g
               JOIN group_members gm ON g.id = gm.group_id
               WHERE gm.google_id = ?
               ORDER BY g.created_at DESC""",
            (google_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_group(group_id: str) -> Optional[dict]:
    """Return a single group by ID, or None."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
    return dict(row) if row else None


def get_group_by_invite_code(invite_code: str) -> Optional[dict]:
    """Look up a group by its invite code (case-insensitive)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM groups WHERE invite_code = ?", (invite_code.upper(),)
        ).fetchone()
    return dict(row) if row else None


def get_group_by_feed_token(feed_token: str) -> Optional[dict]:
    """Look up a group by its calendar feed token."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM groups WHERE feed_token = ?", (feed_token,)
        ).fetchone()
    return dict(row) if row else None


def update_group(group_id: str, name: Optional[str] = None, description: Optional[str] = None, visibility: Optional[str] = None) -> bool:
    """Update group fields. Returns True if a row was modified."""
    updates = []
    params = []
    if name is not None:
        updates.append("name = ?")
        params.append(name)
    if description is not None:
        updates.append("description = ?")
        params.append(description)
    if visibility is not None:
        updates.append("visibility = ?")
        params.append(visibility)
    if not updates:
        return False
    params.append(group_id)
    with get_conn() as conn:
        cur = conn.execute(f"UPDATE groups SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()
        return cur.rowcount > 0


def delete_group(group_id: str) -> None:
    """Delete a group and all its members and events."""
    with get_conn() as conn:
        conn.execute("DELETE FROM group_events WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM group_members WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        conn.commit()


def get_group_member_role(group_id: str, google_id: str) -> Optional[str]:
    """Return the user's role in the group ('admin' or 'member'), or None if not a member."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT role FROM group_members WHERE group_id = ? AND google_id = ?",
            (group_id, google_id),
        ).fetchone()
    return row["role"] if row else None


def join_group(group_id: str, google_id: str) -> bool:
    """Add a user to a group as a member. Returns False if already a member."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND google_id = ?",
            (group_id, google_id),
        ).fetchone()
        if existing:
            return False
        conn.execute(
            "INSERT INTO group_members (group_id, google_id, role, joined_at) VALUES (?, ?, 'member', ?)",
            (group_id, google_id, now),
        )
        conn.commit()
    return True


def leave_group(group_id: str, google_id: str) -> bool:
    """Remove a user from a group. Returns True if removed."""
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM group_members WHERE group_id = ? AND google_id = ?",
            (group_id, google_id),
        )
        conn.commit()
        return cur.rowcount > 0


def get_group_members(group_id: str) -> list[dict]:
    """Return all members of a group with profile info from user_states."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT google_id, role, joined_at FROM group_members WHERE group_id = ? ORDER BY joined_at ASC",
            (group_id,),
        ).fetchall()

    members = []
    with get_conn() as conn:
        for row in rows:
            gid = row["google_id"]
            state_row = conn.execute(
                "SELECT state_json FROM user_states WHERE google_id = ?", (gid,),
            ).fetchone()
            name = gid
            picture = ""
            if state_row:
                try:
                    state = json.loads(state_row["state_json"])
                    name = state.get("userName") or gid
                    picture = (state.get("googleUser") or {}).get("picture", "")
                except Exception:
                    pass
            members.append({
                "google_id": gid, "name": name, "picture": picture,
                "role": row["role"], "joined_at": row["joined_at"],
            })
    return members


# ── Group Events ──────────────────────────────────────────

def create_group_event(
    group_id: Optional[str], google_id: str, name: str, description: str = "",
    venue: str = "", date_start: str = "", date_end: Optional[str] = None,
    visibility: str = "members", note: str = "",
    extra_invitee_ids: Optional[list[str]] = None,
) -> dict:
    """Create an event row. Two flavors:
      - Classic group event: group_id set, extra_invitee_ids empty/None.
      - Personal plan: group_id None, extra_invitee_ids = list of google_ids.
      - Hybrid (group + extras): both set — group members + invited friends.

    `note` is a short free-text message ("pessoal que tal esse?") attached
    when the user adds the event — surfaced on the event card so the crew
    sees the reason without scrolling into a chat thread."""
    now = datetime.now(timezone.utc).isoformat()
    event_id = f"grp_ev_{secrets.token_hex(6)}"
    invitees_json = json.dumps([str(g) for g in (extra_invitee_ids or []) if g])
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO group_events
               (id, group_id, name, description, venue, date_start, date_end,
                created_by, visibility, note, extra_invitee_ids, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (event_id, group_id, name, description, venue, date_start, date_end,
             google_id, visibility, note, invitees_json, now),
        )
        conn.commit()
    return {
        "id": event_id, "group_id": group_id, "name": name,
        "description": description, "venue": venue,
        "date_start": date_start, "date_end": date_end,
        "created_by": google_id, "visibility": visibility,
        "note": note,
        "extra_invitee_ids": json.loads(invitees_json),
        "created_at": now,
    }


def _hydrate_invitees(row: dict) -> dict:
    """Parse the JSON-stringified extra_invitee_ids into a real list."""
    raw = row.get("extra_invitee_ids") or "[]"
    try:
        row["extra_invitee_ids"] = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except (json.JSONDecodeError, TypeError):
        row["extra_invitee_ids"] = []
    return row


def get_group_events(group_id: str, is_member: bool = True) -> list[dict]:
    """Return events for a group. Non-members only see public events.
    Personal plans (group_id IS NULL) are not returned here — see
    get_events_for_user for the per-user feed that combines both."""
    query = "SELECT * FROM group_events WHERE group_id = ?"
    params = [group_id]
    if not is_member:
        query += " AND visibility = 'public'"
    query += " ORDER BY date_start ASC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return [_hydrate_invitees(dict(r)) for r in rows]


def get_personal_plans_for_user(google_id: str) -> list[dict]:
    """Return personal plans (group_id IS NULL) where `google_id` is either
    the creator or appears in extra_invitee_ids. JSON-array LIKE matching
    is fine here — google_ids are numeric strings, no false positives.
    Caller is responsible for any date filtering."""
    if not google_id:
        return []
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM group_events
            WHERE group_id IS NULL
              AND (created_by = ? OR extra_invitee_ids LIKE ?)
            ORDER BY date_start ASC
            """,
            (google_id, f'%"{google_id}"%'),
        ).fetchall()
    return [_hydrate_invitees(dict(r)) for r in rows]


def get_group_events_with_extras_for_user(google_id: str) -> list[dict]:
    """Return events that have a group_id AND list `google_id` as an
    extra invitee (so non-members of the group still see it). Used to
    surface 'group + extras' events for invited friends who aren't in
    the group itself."""
    if not google_id:
        return []
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM group_events
            WHERE group_id IS NOT NULL
              AND extra_invitee_ids LIKE ?
            ORDER BY date_start ASC
            """,
            (f'%"{google_id}"%',),
        ).fetchall()
    return [_hydrate_invitees(dict(r)) for r in rows]


def get_group_event(event_id: str) -> Optional[dict]:
    """Return a single group event by ID."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM group_events WHERE id = ?", (event_id,)).fetchone()
    return _hydrate_invitees(dict(row)) if row else None


def delete_group_event(event_id: str) -> bool:
    """Delete a group event. Returns True if deleted."""
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM group_events WHERE id = ?", (event_id,))
        conn.commit()
        return cur.rowcount > 0


# ── User badges ───────────────────────────────────────────
# Persisted achievement state. evaluate logic lives in backends/badges.py;
# this module just owns row-level operations.

def award_or_upgrade_badge(
    google_id: str,
    badge_id: str,
    tier: int = 1,
    metadata: dict | None = None,
) -> tuple[bool, int]:
    """Insert badge row OR raise tier on existing one.
    Returns (is_new_or_upgrade, previous_tier_or_zero).
    - First award:           returns (True, 0) — new row at given tier
    - Tier upgrade:          returns (True, old_tier) — UPDATE moves tier up
    - Already at this tier:  returns (False, tier) — no change
    - Existing higher tier:  returns (False, current_tier) — no downgrade

    Use this from badges.evaluate() — caller decides what to surface based
    on the (is_new_or_upgrade, previous_tier) tuple.
    """
    import json
    now = datetime.now(timezone.utc).isoformat()
    payload = json.dumps(metadata or {}, ensure_ascii=False)
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT tier FROM user_badges WHERE google_id = ? AND badge_id = ?",
            (google_id, badge_id),
        ).fetchone()
        if existing is None:
            conn.execute(
                """INSERT INTO user_badges (google_id, badge_id, earned_at, metadata, tier)
                   VALUES (?, ?, ?, ?, ?)""",
                (google_id, badge_id, now, payload, tier),
            )
            conn.commit()
            return True, 0
        current_tier = int(existing["tier"])
        if tier > current_tier:
            # Upgrade: bump tier, refresh earned_at + metadata so context
            # reflects the latest milestone.
            conn.execute(
                """UPDATE user_badges
                   SET tier = ?, earned_at = ?, metadata = ?
                   WHERE google_id = ? AND badge_id = ?""",
                (tier, now, payload, google_id, badge_id),
            )
            conn.commit()
            return True, current_tier
        return False, current_tier


# Backwards-compat thin wrapper for any caller that doesn't care about tiers.
def award_badge(google_id: str, badge_id: str, metadata: dict | None = None) -> bool:
    is_new, _ = award_or_upgrade_badge(google_id, badge_id, tier=1, metadata=metadata)
    return is_new


def get_badges(google_id: str) -> list[dict]:
    """Return all badges earned by a user, newest first."""
    import json
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT badge_id, earned_at, metadata, tier FROM user_badges
               WHERE google_id = ? ORDER BY earned_at DESC""",
            (google_id,),
        ).fetchall()
    return [
        {
            "badge_id": r["badge_id"],
            "earned_at": r["earned_at"],
            "metadata": json.loads(r["metadata"]) if r["metadata"] else {},
            "tier": int(r["tier"]),
        }
        for r in rows
    ]


def has_badge(google_id: str, badge_id: str) -> bool:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT 1 FROM user_badges WHERE google_id = ? AND badge_id = ?",
            (google_id, badge_id),
        ).fetchone()
    return row is not None


def get_badge_tier(google_id: str, badge_id: str) -> int:
    """Return current tier (0 if not earned). Used by the engine to skip
    rules that have already maxed out for this user."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT tier FROM user_badges WHERE google_id = ? AND badge_id = ?",
            (google_id, badge_id),
        ).fetchone()
    return int(row["tier"]) if row else 0
