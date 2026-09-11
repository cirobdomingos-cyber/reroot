"""
Tests for the day-before event reminder.

Context: the app notified you when a friend RSVP'd, when someone invited
you, and when the catalog found something new — but never that the thing
you already committed to is happening tomorrow. The README promised the
reminder since launch; it was never built.

The job is a daily cron, so the properties that matter are the ones you
cannot check by eyeballing a single run:

  1. It selects exactly the events dated tomorrow — not today, not the
     day after.
  2. It is idempotent. The scheduler is at-least-once; a redeploy landing
     mid-run must not buzz everyone twice.
  3. A host moving an event's date moves the reminder with it. The rsvps
     row denormalizes event_date, so without an explicit mirror the
     attendee gets reminded on the old date and never on the new one.
"""
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def db(tmp_path, monkeypatch):
    """A database module bound to a throwaway file, re-imported so
    DB_PATH is picked up at import time."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database",):
        sys.modules.pop(mod, None)
    import database as _db
    _db.init_db()
    return _db


def _iso(d: date, time="20:00:00"):
    return f"{d.isoformat()}T{time}"


def test_selects_only_tomorrow(db):
    today = date.today()
    tomorrow = today + timedelta(days=1)
    for gid, when in (
        ("u_today", today),
        ("u_tomorrow", tomorrow),
        ("u_later", today + timedelta(days=2)),
    ):
        db.upsert_rsvp(
            google_id=gid, event_id=f"ev_{gid}", event_name="Show",
            event_venue="Pedreira", event_date=_iso(when), event_url="",
        )

    rows = db.get_rsvps_for_day(tomorrow.isoformat())

    assert [r["google_id"] for r in rows] == ["u_tomorrow"]


def test_reminder_is_idempotent(db):
    assert db.reminder_already_sent("u1", "ev1") is False
    db.mark_reminder_sent("u1", "ev1")
    assert db.reminder_already_sent("u1", "ev1") is True
    # Re-marking must not raise — the job may retry after a partial run.
    db.mark_reminder_sent("u1", "ev1")
    assert db.reminder_already_sent("u1", "ev1") is True
    # Distinct pairs stay independent.
    assert db.reminder_already_sent("u2", "ev1") is False
    assert db.reminder_already_sent("u1", "ev2") is False


def test_rescheduling_moves_the_reminder(db):
    """A host edits the date; the attendee's reminder must follow."""
    original = date.today() + timedelta(days=5)
    moved = date.today() + timedelta(days=1)

    event = db.create_group_event(
        group_id=None, google_id="host", name="Aniversário",
        description="", venue="Bar Quermesse", date_start=_iso(original),
        date_end=None, visibility="members", note="",
        extra_invitee_ids=["guest"], source_ig_handle="", source_event_id="",
    )
    for gid in ("host", "guest"):
        db.upsert_rsvp(
            google_id=gid, event_id=event["id"], event_name="Aniversário",
            event_venue="Bar Quermesse", event_date=_iso(original), event_url="",
        )

    assert db.get_rsvps_for_day(original.isoformat())
    assert db.get_rsvps_for_day(moved.isoformat()) == []

    db.update_group_event(event["id"], {"date_start": _iso(moved)})

    # Both attendees moved with it, and nobody is left on the old date.
    assert db.get_rsvps_for_day(original.isoformat()) == []
    assert sorted(r["google_id"] for r in db.get_rsvps_for_day(moved.isoformat())) == ["guest", "host"]


def test_rename_mirrors_into_rsvps(db):
    """The reminder body reads event_name off the rsvps row, so a rename
    must reach it too — otherwise the push announces the old title."""
    when = date.today() + timedelta(days=1)
    event = db.create_group_event(
        group_id=None, google_id="host", name="Nome antigo",
        description="", venue="", date_start=_iso(when),
        date_end=None, visibility="members", note="",
        extra_invitee_ids=[], source_ig_handle="", source_event_id="",
    )
    db.upsert_rsvp(
        google_id="host", event_id=event["id"], event_name="Nome antigo",
        event_venue="", event_date=_iso(when), event_url="",
    )

    db.update_group_event(event["id"], {"name": "Nome novo"})

    rows = db.get_rsvps_for_day(when.isoformat())
    assert [r["event_name"] for r in rows] == ["Nome novo"]
