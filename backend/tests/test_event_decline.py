"""
Tests for "Não vou" on private events.

Context: the only way to turn down an invite was the trash icon in Meus
eventos, which deleted you from extra_invitee_ids. To the host you simply
vanished — no way to tell "said no" from "never invited".

What must hold:
  1. Declining removes the invite and any RSVP, and records the decline.
  2. The host sees who declined; a person who comes back (re-invited or
     RSVPed) stops showing as declined.
  3. Declining twice doesn't duplicate, and the creator is never recorded.
  4. Someone who was never invited can't create a decline.
"""
import sys
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


@pytest.fixture()
def event(db):
    ev = db.create_group_event(
        group_id=None, google_id="host", name="Churras",
        date_start="2026-12-01T20:00:00", extra_invitee_ids=["ana", "bia"],
    )
    return ev["id"]


def _ids(rows):
    return sorted(r["google_id"] for r in rows)


def _rsvp(db, gid, event_id):
    db.upsert_rsvp(google_id=gid, event_id=event_id, event_name="Churras",
                   event_venue="", event_date="2026-12-01T20:00:00", event_url="")


def test_decline_is_recorded_and_visible_to_host(db, event):
    assert db.decline_event_invite(event, "ana") is True

    ge = db.get_group_event(event)
    assert "ana" not in ge["extra_invitee_ids"]
    assert _ids(db.get_event_declined(event, "host")) == ["ana"]
    assert "ana" not in _ids(db.get_event_invitees_pending(event, "host"))


def test_decline_after_rsvp_drops_the_rsvp(db, event):
    _rsvp(db, "bia", event)
    assert db.decline_event_invite(event, "bia") is True
    assert "bia" not in _ids(db.get_event_attendees(event, "host"))
    assert _ids(db.get_event_declined(event, "host")) == ["bia"]


def test_reinvited_person_is_no_longer_declined(db, event):
    db.decline_event_invite(event, "ana")
    db.add_invitees_to_event(event, ["ana"])
    assert db.get_event_declined(event, "host") == []


def test_person_who_rsvps_later_is_no_longer_declined(db, event):
    db.decline_event_invite(event, "ana")
    _rsvp(db, "ana", event)
    assert db.get_event_declined(event, "host") == []


def test_decline_twice_does_not_duplicate(db, event):
    db.decline_event_invite(event, "ana")
    db.decline_event_invite(event, "ana")
    assert db.get_group_event(event)["declined_ids"] == ["ana"]


def test_creator_is_never_recorded_as_declined(db, event):
    _rsvp(db, "host", event)
    db.decline_event_invite(event, "host")
    assert db.get_group_event(event)["declined_ids"] == []


def test_stranger_cannot_create_a_decline(db, event):
    assert db.decline_event_invite(event, "stranger") is False
    assert db.get_group_event(event)["declined_ids"] == []
