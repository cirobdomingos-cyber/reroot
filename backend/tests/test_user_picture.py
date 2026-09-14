"""
Tests for custom profile photos.

Context: avatars came only from the Google account (Apple sign-in has
none), and the app state overwrote googleUser.picture on every login, so a
user had no way to set their own photo.

What must hold:
  1. An uploaded photo (`customPicture`) wins over the account picture.
  2. Without one, the account picture is used; with neither, "".
  3. Readers that other users see — the friends list and event attendees —
     use the custom photo.
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


GOOGLE = "https://lh3.googleusercontent.com/a/abc"
CUSTOM = "/event-images/useravatar_x.jpg?v=1"


def test_custom_photo_wins(db):
    assert db.user_picture({"customPicture": CUSTOM, "googleUser": {"picture": GOOGLE}}) == CUSTOM
    assert db.user_picture({"customPicture": "", "googleUser": {"picture": GOOGLE}}) == GOOGLE
    assert db.user_picture({"googleUser": {}}) == ""
    assert db.user_picture(None) == ""


def test_friends_and_attendees_see_the_custom_photo(db):
    db.upsert_user_state("ana", {"userName": "Ana", "googleUser": {"id": "ana", "picture": GOOGLE}})
    db.upsert_user_state("bia", {"userName": "Bia", "customPicture": CUSTOM,
                                 "googleUser": {"id": "bia", "picture": GOOGLE}})
    db.upsert_friendship("ana", db.get_friend_code("bia"))

    [friend] = db.get_friends("ana")
    assert friend["picture"] == CUSTOM

    ev = db.create_group_event(group_id=None, google_id="ana", name="Show",
                               date_start="2026-12-01T20:00:00", extra_invitee_ids=["bia"])
    [pending] = db.get_event_invitees_pending(ev["id"], "ana")
    assert pending["picture"] == CUSTOM
