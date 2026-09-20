"""
Tests for GET /notifications — the inbox and the number on its badge.

The design decision under test: everything countable is DERIVED from
existing state rather than written as a row when something happens.

Two consequences, and both are the point:

  1. It can't drift. No producer to forget to call, no backfill for
     things that happened before this shipped, and no way for the badge
     to disagree with the screen it opens — they're one query.

  2. It clears for the right reason. A derived count goes down when the
     person ACTS, not when they look. A badge you can clear by glancing
     teaches people that glancing is enough, and then it stops being
     read at all.

And the rule the badge follows: count only what needs YOU. "There is
new stuff" never reaches zero, and a badge that never reaches zero is
one people stop seeing within a week.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

CURATOR = "curator@example.com"
SOON = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
GONE = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        for uid, email in (("u_ana", "ana@example.com"),
                           ("u_bia", "bia@example.com"),
                           ("u_cur", CURATOR)):
            conn.execute(
                "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
                " VALUES (?,?,?,?,?)", (uid, uid, email, "", now))
        conn.commit()
    # request_friendship checks get_user_state on the target, so a users
    # row alone isn't enough to be findable.
    for uid in ("u_ana", "u_bia", "u_cur"):
        _db.upsert_user_state(uid, {})
    _db.add_curator(email=CURATOR, added_by_email="system", notes="")
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _invite(_db, *, invitee="u_ana", host="u_bia", when=SOON, name="Show do Terno Rei"):
    return _db.create_group_event(
        group_id=None, google_id=host, name=name, venue="Pedreira",
        date_start=when, extra_invitee_ids=[invitee],
    )


def _get(client, google_id="u_ana", email=""):
    return client.get(
        f"/notifications?google_id={google_id}&email={email}"
    ).json()


# -- the badge counts what needs you ---------------------------------

def test_an_unanswered_invite_counts(api):
    _db, _main, client = api
    _invite(_db)
    body = _get(client)
    assert body["unread_count"] == 1
    assert body["items"][0]["kind"] == "event_invite"
    assert body["items"][0]["title"] == "Show do Terno Rei"


def test_a_friend_request_counts(api):
    _db, _main, client = api
    _db.request_friendship("u_bia", "u_ana")
    assert _get(client)["unread_count"] == 1


def test_nothing_waiting_is_a_zero(api):
    _db, _main, client = api
    assert _get(client)["unread_count"] == 0


# -- it clears when you act, not when you look -----------------------

def test_answering_an_invite_clears_it(api):
    _db, _main, client = api
    ev = _invite(_db)
    assert _get(client)["unread_count"] == 1
    _db.upsert_rsvp("u_ana", ev["id"], ev["name"], "Pedreira", SOON, "")
    assert _get(client)["unread_count"] == 0


def test_declining_an_invite_clears_it_too(api):
    """Declining is an answer. It should not sit there as a pending item
    reminding someone of a decision they already made."""
    _db, _main, client = api
    ev = _invite(_db)
    _db.decline_event_invite(ev["id"], "u_ana")
    assert _get(client)["unread_count"] == 0


def test_reading_the_list_does_not_clear_the_count(api):
    """The behaviour that makes the number trustworthy."""
    _db, _main, client = api
    _invite(_db)
    _get(client)
    _get(client)
    assert _get(client)["unread_count"] == 1


# -- what must never count -------------------------------------------

def test_a_digest_appears_but_does_not_count(api):
    _db, _main, client = api
    _db.insert_daily_digest("dg_1", ["instagram_a", "instagram_b"])
    body = _get(client)
    kinds = [i["kind"] for i in body["items"]]
    assert "digest" in kinds
    assert body["unread_count"] == 0, '"there is new stuff" never reaches zero'


def test_an_invite_to_something_already_past_does_not_count(api):
    _db, _main, client = api
    _invite(_db, when=GONE)
    assert _get(client)["unread_count"] == 0


def test_your_own_event_is_not_an_invite_to_yourself(api):
    _db, _main, client = api
    _db.create_group_event(
        group_id=None, google_id="u_ana", name="Meu plano", venue="",
        date_start=SOON, extra_invitee_ids=["u_bia"],
    )
    assert _get(client)["unread_count"] == 0


def test_an_invite_to_someone_else_is_not_yours(api):
    _db, _main, client = api
    _invite(_db, invitee="u_bia", host="u_cur")
    assert _get(client, google_id="u_ana")["unread_count"] == 0


def test_a_google_id_that_is_a_substring_of_another_is_not_matched(api):
    """extra_invitee_ids is a JSON column and the query prefilters with
    LIKE. Membership is confirmed properly afterwards, or "u_an" would
    inherit every invite sent to "u_ana"."""
    _db, _main, client = api
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
            " VALUES (?,?,?,?,?)", ("u_an", "u_an", "an@example.com", "", now))
        conn.commit()
    _invite(_db, invitee="u_ana")
    assert _get(client, google_id="u_an")["unread_count"] == 0


# -- curation is curator-only, and silent otherwise ------------------

def test_a_curator_sees_the_review_queue(api):
    _db, _main, client = api
    _db.insert_catalog_request(
        name="Festa", description="", venue_name="Bar", date_start=SOON,
        url="", image_url="", ig_handle="bar", shortcode="ABC",
        group_event_id="", submitted_by="u_ana",
    )
    body = _get(client, google_id="u_cur", email=CURATOR)
    assert any(i["kind"] == "curation_events" for i in body["items"])
    assert body["unread_count"] >= 1


def test_a_non_curator_gets_silence_not_a_403(api):
    """From the inbox, "nothing pending" and "not yours to see" should
    look identical — the tab must not hint the área exists."""
    _db, _main, client = api
    _db.insert_catalog_request(
        name="Festa", description="", venue_name="Bar", date_start=SOON,
        url="", image_url="", ig_handle="bar", shortcode="ABC",
        group_event_id="", submitted_by="u_ana",
    )
    r = client.get("/notifications?google_id=u_ana&email=ana@example.com")
    assert r.status_code == 200
    assert not any(i["kind"].startswith("curation") for i in r.json()["items"])


# -- shape -----------------------------------------------------------

def test_actionable_items_sort_above_informational(api):
    _db, _main, client = api
    _db.insert_daily_digest("dg_1", ["instagram_a"])
    _invite(_db)
    items = _get(client)["items"]
    assert items[0]["actionable"] is True
    assert items[-1]["actionable"] is False


def test_the_count_always_matches_the_list_it_opens(api):
    """One query serves both, so they can't disagree — asserted rather
    than assumed, because this is the property the whole design buys."""
    _db, _main, client = api
    _invite(_db)
    _db.request_friendship("u_bia", "u_ana")
    _db.insert_daily_digest("dg_1", ["instagram_a"])
    body = _get(client)
    assert body["unread_count"] == sum(1 for i in body["items"] if i["actionable"])


def test_a_signed_out_visitor_gets_an_empty_inbox(api):
    _db, _main, client = api
    _invite(_db)
    body = client.get("/notifications").json()
    assert body["unread_count"] == 0
