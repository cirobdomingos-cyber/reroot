"""
Tests for digest quiet hours.

Context: the "✨ N novos em CWB" digest fires after every catalog refresh.
The 14:00 cron is fine, but the boot refresh after a night-time deploy sent
it to everyone at 23:40. Night digests are now parked and sent at 09:00.

What must hold:
  1. The quiet window is 22:00–08:59 in Curitiba time, whatever the server
     timezone is.
  2. Parked events survive in the database (a redeploy overnight must not
     lose them) and several night refreshes merge into one digest.
  3. Taking the parked events empties the queue, so 09:00 sends once.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import quiet_hours  # noqa: E402


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    sys.modules.pop("database", None)
    import database as _db
    _db.init_db()
    return _db


def _utc(h, m=0):
    # Curitiba is UTC-3 all year (no DST since 2019).
    return datetime(2026, 9, 14, h, m, tzinfo=timezone.utc)


@pytest.mark.parametrize("utc_hour,utc_min,quiet", [
    (0, 59, False),   # 21:59 local — still awake time
    (1, 0, True),     # 22:00 local — window opens
    (4, 0, True),     # 01:00 local
    (11, 59, True),   # 08:59 local
    (12, 0, False),   # 09:00 local — window closes
    (17, 0, False),   # 14:00 local — the daily refresh
])
def test_quiet_window_is_curitiba_time(utc_hour, utc_min, quiet):
    assert quiet_hours.is_quiet(_utc(utc_hour, utc_min)) is quiet


def test_naive_datetime_is_read_as_utc():
    assert quiet_hours.is_quiet(datetime(2026, 9, 14, 4, 0)) is True
    assert quiet_hours.is_quiet(datetime(2026, 9, 14, 17, 0)) is False


def test_parked_events_merge_and_dedupe(db):
    db.defer_digest_events(["ev1", "ev2"])
    db.defer_digest_events(["ev2", "ev3"])   # second night refresh
    assert sorted(db.take_deferred_digest_events()) == ["ev1", "ev2", "ev3"]


def test_taking_parked_events_empties_the_queue(db):
    db.defer_digest_events(["ev1"])
    assert db.take_deferred_digest_events() == ["ev1"]
    assert db.take_deferred_digest_events() == []


def test_parked_events_survive_a_restart(db, monkeypatch):
    db.defer_digest_events(["ev1"])
    sys.modules.pop("database", None)
    import database as reloaded
    reloaded.init_db()
    assert reloaded.take_deferred_digest_events() == ["ev1"]
