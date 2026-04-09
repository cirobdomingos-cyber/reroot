"""
SQLite simples com TTL. Sem ORM — sqlite3 puro é suficiente aqui.
Grain: um evento enriquecido por (source, external_id).
"""
import hashlib
import sqlite3
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from models import EnrichedEvent

DB_PATH = Path(__file__).parent / "reroot_events.db"


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
                good_for_reroot INTEGER NOT NULL DEFAULT 0,
                UNIQUE(source, external_id)
            )
        """)
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
                created_at TEXT NOT NULL
            )
        """)
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
                submitted_by    TEXT,            -- google_id, optional
                status          TEXT NOT NULL DEFAULT 'pending',    -- pending | enriched | rejected
                enriched_event_id TEXT,          -- set after successful enrichment
                created_at      TEXT NOT NULL
            )
        """)
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

def upsert_push_subscription(endpoint: str, keys_json: str) -> None:
    """Insert or replace a Web Push subscription (upsert on endpoint)."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO push_subscriptions (endpoint, keys_json, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
                keys_json  = excluded.keys_json,
                created_at = excluded.created_at
        """, (endpoint, keys_json, now))
        conn.commit()


def get_all_push_subscriptions() -> list[dict]:
    """Return all stored push subscriptions as dicts."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT endpoint, keys_json FROM push_subscriptions"
        ).fetchall()
    return [{"endpoint": r["endpoint"], "keys": json.loads(r["keys_json"])} for r in rows]


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


def insert_analytics_event(event_name: str, properties_json: str, session_id: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO analytics_events (event_name, properties_json, session_id, created_at) VALUES (?, ?, ?, ?)",
            (event_name, properties_json, session_id, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()


def get_funnel_counts() -> list[dict]:
    """Return event counts grouped by event_name, ordered by total desc."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT event_name, COUNT(*) as total FROM analytics_events GROUP BY event_name ORDER BY total DESC"
        ).fetchall()
    return [{"event_name": row["event_name"], "total": row["total"]} for row in rows]


def upsert_event(ev: EnrichedEvent):
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO events (id, source, external_id, payload, fetched_at, enriched_at, good_for_reroot)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, external_id) DO UPDATE SET
                payload         = excluded.payload,
                fetched_at      = excluded.fetched_at,
                enriched_at     = excluded.enriched_at,
                good_for_reroot = excluded.good_for_reroot
        """, (
            ev.id,
            ev.source,
            ev.external_id,
            ev.model_dump_json(),
            ev.fetched_at.isoformat(),
            ev.enriched_at.isoformat() if ev.enriched_at else None,
            1 if ev.good_for_reroot else 0,
        ))
        conn.commit()


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
        query += " AND good_for_reroot = 1"

    # date filter — só futuros
    now = datetime.now(timezone.utc).isoformat()
    query += " AND json_extract(payload, '$.date_start') >= ?"
    params.append(now[:10])  # YYYY-MM-DD

    if category and category != "all":
        query += " AND json_extract(payload, '$.reroot_category') = ?"
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


def get_event_by_id(event_id: str) -> Optional[EnrichedEvent]:
    with get_conn() as conn:
        row = conn.execute("SELECT payload FROM events WHERE id = ?", (event_id,)).fetchone()
    if not row:
        return None
    return EnrichedEvent(**json.loads(row["payload"]))


def count_events() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM events WHERE good_for_reroot = 1").fetchone()[0]


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

    # Get friendships for the requester (accepted only)
    friend_ids = set()
    with get_conn() as conn:
        friend_rows = conn.execute(
            """
            SELECT user_a, user_b FROM friendships
            WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'
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
    Create a pending friendship from requester to the user identified by code.

    Returns:
        {'status': 'ok'}             — friendship row inserted (pending)
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
            VALUES (?, ?, 'pending', ?, ?)
            """,
            (user_a, user_b, requester_google_id, now),
        )
        conn.commit()
    return {"status": "ok"}


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
    Return all accepted friends of google_id, enriched with name/picture
    from their user_states blob.

    Shape: [{ google_id, name, picture, status }]
    """
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT user_a, user_b, status FROM friendships
            WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'
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
