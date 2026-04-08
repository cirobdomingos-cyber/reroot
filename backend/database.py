"""
SQLite simples com TTL. Sem ORM — sqlite3 puro é suficiente aqui.
Grain: um evento enriquecido por (source, external_id).
"""
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
        conn.commit()


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
    good_only: bool = True,
    category: Optional[str] = None,
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
