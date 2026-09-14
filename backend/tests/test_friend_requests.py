"""
Tests for friend requests.

Context: every in-app "+ amigo" (group member list, someone's profile,
post-event attendees) created an accepted friendship on the spot. Being in
the same group as someone made you their friend without them doing
anything — and friendship shows your RSVPs in their feed.

What must hold:
  1. In-app adds create a pending request; pending is not friendship.
  2. Only the person asked can accept; declining removes the request.
  3. Two people asking each other become friends without a third tap.
  4. Invite codes stay instant, and settle a pending request.
  5. friendship_status tells both sides apart (requested vs incoming).
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
    for gid, name in (("ana", "Ana"), ("bia", "Bia"), ("caio", "Caio")):
        _db.upsert_user_state(gid, {"userName": name, "googleUser": {"id": gid}})
    return _db


def _friend_ids(db, gid):
    return sorted(f["google_id"] for f in db.get_friends(gid))


def test_in_app_add_is_a_request_not_a_friendship(db):
    assert db.request_friendship("ana", "bia") == {"status": "requested"}
    assert _friend_ids(db, "ana") == []
    assert _friend_ids(db, "bia") == []
    assert db.friendship_status("ana", "bia") == "requested"
    assert db.friendship_status("bia", "ana") == "incoming"
    assert [r["google_id"] for r in db.get_incoming_friend_requests("bia")] == ["ana"]
    assert db.get_incoming_friend_requests("ana") == []
    assert db.get_outgoing_friend_request_ids("ana") == ["bia"]


def test_asking_twice_does_not_duplicate(db):
    db.request_friendship("ana", "bia")
    assert db.request_friendship("ana", "bia") == {"status": "already_requested"}
    assert len(db.get_incoming_friend_requests("bia")) == 1


def test_only_the_person_asked_can_accept(db):
    db.request_friendship("ana", "bia")
    assert db.accept_friendship("ana", "bia") is False, "requester can't accept their own request"
    assert db.accept_friendship("bia", "ana") is True
    assert _friend_ids(db, "ana") == ["bia"]
    assert db.friendship_status("ana", "bia") == "friends"
    assert db.get_incoming_friend_requests("bia") == []


def test_declining_removes_the_request(db):
    db.request_friendship("ana", "bia")
    assert db.decline_friend_request("ana", "bia") is False, "requester can't decline for the other side"
    assert db.decline_friend_request("bia", "ana") is True
    assert db.friendship_status("ana", "bia") == "none"
    # They can ask again later.
    assert db.request_friendship("ana", "bia") == {"status": "requested"}


def test_crossed_requests_become_a_friendship(db):
    db.request_friendship("ana", "bia")
    assert db.request_friendship("bia", "ana") == {"status": "accepted"}
    assert _friend_ids(db, "bia") == ["ana"]


def test_invite_code_is_instant_and_settles_a_pending_request(db):
    assert db.upsert_friendship("caio", db.get_friend_code("ana")) == {"status": "ok"}
    assert db.friendship_status("caio", "ana") == "friends"

    db.request_friendship("ana", "bia")
    assert db.upsert_friendship("bia", db.get_friend_code("ana")) == {"status": "ok"}
    assert db.friendship_status("ana", "bia") == "friends"


def test_unknown_or_self_targets(db):
    assert db.request_friendship("ana", "ghost") == {"status": "not_found"}
    assert db.request_friendship("ana", "ana") == {"status": "self"}
    assert db.request_friendship("ana", "caio")["status"] == "requested"
    db.accept_friendship("caio", "ana")
    assert db.request_friendship("ana", "caio") == {"status": "already_friends"}


def test_pending_request_does_not_mark_attendees_as_friends(db):
    ev = db.create_group_event(group_id=None, google_id="ana", name="Show",
                               date_start="2026-12-01T20:00:00", extra_invitee_ids=["bia"])
    db.upsert_rsvp(google_id="bia", event_id=ev["id"], event_name="Show",
                   event_venue="", event_date="2026-12-01T20:00:00", event_url="")
    db.request_friendship("ana", "bia")
    [bia] = db.get_event_attendees(ev["id"], "ana")
    assert bia["is_friend"] is False
