"""
Tests for user analytics.

Context: the founder dashboard showed DAU/WAU/MAU, a 30-day "active users
per day" chart, and the last 10 logins. Two of those were wrong:

  - The daily chart grouped user_states.updated_at by day, but that column
    is overwritten on every save, so each user could only ever appear on
    their most recent day — every earlier day looked empty.
  - "New today" counted rows whose state was saved today, which is DAU,
    not signups. user_states had no created_at at all.

What must hold:
  1. Activity is recorded per user per day and survives repeat saves.
  2. created_at is stamped once and never moves on later saves.
  3. The daily series splits first-day users from returning ones.
  4. The user directory reports real per-user counts, and sorts/filters.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    sys.modules.pop("database", None)
    import database as _db
    _db.init_db()
    return _db


def _state(name, email=""):
    return {"userName": name, "googleUser": {"id": name.lower(), "email": email}}


def test_activity_is_one_row_per_user_per_day(db):
    db.upsert_user_state("ana", _state("Ana"))
    db.upsert_user_state("ana", _state("Ana"))  # same day, second save
    db.upsert_user_state("bia", _state("Bia"))

    with db.get_conn() as conn:
        rows = conn.execute("SELECT google_id, day FROM user_activity ORDER BY google_id").fetchall()
    today = datetime.now(timezone.utc).date().isoformat()
    assert [(r["google_id"], r["day"]) for r in rows] == [("ana", today), ("bia", today)]


def test_created_at_is_stamped_once(db):
    db.upsert_user_state("ana", _state("Ana"))
    with db.get_conn() as conn:
        first = conn.execute("SELECT created_at FROM user_states WHERE google_id='ana'").fetchone()[0]
    db.upsert_user_state("ana", _state("Ana Maria"))
    with db.get_conn() as conn:
        row = conn.execute(
            "SELECT created_at, updated_at FROM user_states WHERE google_id='ana'").fetchone()
    assert row["created_at"] == first, "first-seen must not move"
    assert row["updated_at"] >= first


def test_daily_series_separates_new_from_returning(db):
    today = datetime.now(timezone.utc).date().isoformat()
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()

    db.upsert_user_state("ana", _state("Ana"))   # joined today
    db.upsert_user_state("bia", _state("Bia"))
    # Bia is an older user who came back today.
    with db.get_conn() as conn:
        conn.execute("UPDATE user_states SET created_at = ? WHERE google_id = 'bia'",
                     (yesterday + "T10:00:00+00:00",))
        conn.execute("INSERT OR IGNORE INTO user_activity (google_id, day) VALUES ('bia', ?)",
                     (yesterday,))
        conn.commit()

    stats = db.get_usage_stats(window_days=30)
    by_day = {d["date"]: d for d in stats["daily"]}
    assert by_day[today]["active"] == 2
    assert by_day[today]["new"] == 1, "only Ana is new today"
    assert by_day[today]["returning"] == 1
    assert by_day[yesterday]["active"] == 1, "past days must survive a later save"
    assert stats["new_today"] == 1, "new_today counts signups, not activity"


def test_users_from_before_the_table_keep_their_last_seen_day(db):
    """Otherwise every existing user reads "0 dias ativos" until they next
    open the app — a column of zeros that reads as a bug."""
    with db.get_conn() as conn:
        conn.execute(
            """INSERT INTO user_states (google_id, state_json, updated_at, created_at)
               VALUES ('old', '{}', ?, ?)""",
            ("2026-09-01T10:00:00+00:00", "2026-09-01T10:00:00+00:00"),
        )
        conn.execute("DELETE FROM user_activity WHERE google_id = 'old'")
        conn.commit()

    db.init_db()  # migrations run on every boot

    with db.get_conn() as conn:
        days = [r["day"] for r in conn.execute(
            "SELECT day FROM user_activity WHERE google_id = 'old'").fetchall()]
    assert days == ["2026-09-01"]
    old = next(u for u in db.get_user_directory()["users"] if u["google_id"] == "old")
    assert old["days_active"] == 1


def test_user_directory_counts_what_people_did(db):
    db.upsert_user_state("ana", _state("Ana", "ana@x.com"))
    db.upsert_user_state("bia", _state("Bia", "bia@x.com"))
    db.upsert_friendship("ana", db.get_friend_code("bia"))
    db.upsert_rsvp(google_id="ana", event_id="e1", event_name="Show",
                   event_venue="", event_date="2026-12-01T20:00:00", event_url="")
    group = db.create_group(google_id="ana", name="Crew")
    db.create_group_event(group_id=group["id"], google_id="ana", name="Churras",
                          date_start="2026-12-01T20:00:00")

    directory = db.get_user_directory()
    assert directory["total"] == 2
    ana = next(u for u in directory["users"] if u["google_id"] == "ana")
    assert (ana["rsvps"], ana["friends"], ana["groups"], ana["events_created"]) == (1, 1, 1, 1)
    assert ana["days_active"] == 1
    assert ana["email"] == "ana@x.com"

    assert [u["google_id"] for u in db.get_user_directory(query="bia")["users"]] == ["bia"]
    assert [u["name"] for u in db.get_user_directory(sort="name")["users"]] == ["Ana", "Bia"]
