"""
Tests for how an event that belongs to several channels is labelled.

An event can be linked to more than one channel at a time — "adicionar
a um canal" broadens an existing event rather than forking it. One row,
one card, no duplication. What was wrong was the label.

_group_event_to_frontend decided it from `group_id` alone, the primary
channel, and never looked at `group_ids`. So a member of a SECOND
channel failed the membership check and got the event rendered as a
personal invite — no channel named, not even inside that channel's own
screen, which is where they were looking at it from.

The viewer-aware gate itself is correct and deliberate: an outsider
added to the invitee list must NOT learn which channel the event came
from. That's what these tests protect while fixing the other half.

What must hold:
  1. The label names a channel the VIEWER is in, whichever it is.
  2. A channel's own screen names itself, not whichever channel was
     tagged first.
  3. An outsider still sees a plain personal invite, with no channel
     name and no channel ids.
  4. groupIds carries only the viewer's own channels — the full list
     used to ship to everyone, handing outsiders the very ids the
     label logic goes out of its way to hide.
  5. Nothing duplicates.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

SOON = "2099-01-01T20:00:00"


@pytest.fixture()
def world(tmp_path, monkeypatch):
    """Ana is in A and B. Caio is only in A, Bia only in B, Dudu is in
    neither but is on the invitee list. The event is created in A and
    then also added to B."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    now = datetime.now(timezone.utc).isoformat()
    for uid in ("ana", "bia", "caio", "dudu"):
        with _db.get_conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
                " VALUES (?,?,?,?,?)", (uid, uid.title(), f"{uid}@e.com", "", now))
            conn.commit()
        _db.upsert_user_state(uid, {"userName": uid.title()})

    from fastapi.testclient import TestClient
    client = TestClient(_main.app)
    a = client.post("/groups", json={"google_id": "ana", "name": "Turma A"}).json()
    b = client.post("/groups", json={"google_id": "ana", "name": "Turma B"}).json()
    client.post("/groups/join", json={"google_id": "caio", "invite_code": a["invite_code"]})
    client.post("/groups/join", json={"google_id": "bia", "invite_code": b["invite_code"]})

    created = client.post(f"/groups/{a['id']}/events", json={
        "google_id": "ana", "name": "Churrasco", "date_start": SOON,
        "invitee_google_ids": ["caio", "dudu"],
    }).json()
    event_id = created.get("event", {}).get("id") or created.get("id")
    # The "adicionar a um canal" path, not the low-level linker.
    client.post(f"/groups/{b['id']}/events", json={
        "google_id": "ana", "name": "Churrasco", "date_start": SOON,
        "source_event_id": event_id,
    })
    return _db, client, {"A": a["id"], "B": b["id"], "event": event_id}


def _feed(client, who):
    events = client.get(f"/events/group?google_id={who}").json()["events"]
    return events[0] if events else None


def _on_screen(client, who, group_id):
    events = client.get(f"/groups/{group_id}?google_id={who}").json()["events"]
    return events[0] if events else None


# -- 1. the label names a channel the viewer is in -------------------

def test_a_member_of_the_second_channel_sees_that_channel(world):
    """The bug: Bia is in B, the event is in B, she's looking at it
    because of B — and it rendered as a personal invite from Ana."""
    _db, client, ids = world
    ev = _feed(client, "bia")
    assert ev["groupName"] == "Turma B"
    assert ev["isPersonalPlan"] is False


def test_a_member_of_the_primary_channel_still_sees_it(world):
    _db, client, ids = world
    ev = _feed(client, "caio")
    assert ev["groupName"] == "Turma A"
    assert ev["isPersonalPlan"] is False


def test_someone_in_both_gets_a_name_and_a_count(world):
    """Naming one channel implies the event lives in one place. The
    count is what lets the card say "Turma A +1"."""
    _db, client, ids = world
    ev = _feed(client, "ana")
    assert ev["groupName"] in ("Turma A", "Turma B")
    assert ev["viewerGroupCount"] == 2


def test_someone_in_both_gets_both_names(world):
    """A count answers "how many", not "which". The Eventos list shows
    one row per night and names every channel it came from, so it needs
    the names — and it can't look them up itself, because the whole
    point of viewer-scoping is that it never sees the other channel."""
    _db, client, ids = world
    ev = _feed(client, "ana")
    assert sorted(ev["groupNames"]) == ["Turma A", "Turma B"]
    # The visible one leads, so a screen that shows a single name and a
    # list that shows all of them agree on which comes first.
    assert ev["groupNames"][0] == ev["groupName"]


def test_a_member_of_one_channel_is_told_about_that_one_only(world):
    """The names carry the same viewer-scoping as the ids. Leaking the
    full list here would hand an outsider the name of a private channel
    they were never in — the exact leak groupIds was narrowed to fix."""
    _db, client, ids = world
    assert _feed(client, "bia")["groupNames"] == ["Turma B"]
    assert _feed(client, "caio")["groupNames"] == ["Turma A"]


# -- 2. a channel's screen names itself ------------------------------

@pytest.mark.parametrize("who,key,expected", [
    ("ana", "A", "Turma A"),
    ("ana", "B", "Turma B"),
    ("bia", "B", "Turma B"),
    ("caio", "A", "Turma A"),
])
def test_the_screen_you_are_on_is_the_one_named(world, who, key, expected):
    _db, client, ids = world
    ev = _on_screen(client, who, ids[key])
    assert ev["groupName"] == expected
    assert ev["isPersonalPlan"] is False


# -- 3. outsiders still learn nothing --------------------------------

def test_an_outsider_invitee_sees_a_plain_personal_invite(world):
    """The whole point of the viewer-aware gate: Dudu was invited to a
    channel event without being in the channel, and must not find out
    which channel it came from."""
    _db, client, ids = world
    ev = _feed(client, "dudu")
    assert ev is not None, "the outsider should still see the event"
    assert ev["groupName"] == ""
    assert ev["groupId"] is None
    assert ev["isPersonalPlan"] is True


def test_an_outsider_cannot_open_the_channel_screen(world):
    _db, client, ids = world
    assert client.get(f"/groups/{ids['A']}?google_id=dudu").status_code in (403, 404)


# -- 4. groupIds is the viewer's own, not the event's reach ----------

@pytest.mark.parametrize("who,expected", [
    ("ana", 2), ("caio", 1), ("bia", 1), ("dudu", 0),
])
def test_group_ids_carries_only_the_viewers_channels(world, who, expected):
    _db, client, ids = world
    ev = _feed(client, who)
    assert len(ev["groupIds"]) == expected
    assert ev["viewerGroupCount"] == expected


def test_a_single_group_member_never_receives_the_other_groups_id(world):
    _db, client, ids = world
    assert _feed(client, "caio")["groupIds"] == [ids["A"]]
    assert _feed(client, "bia")["groupIds"] == [ids["B"]]


# -- 5. one event, one row -------------------------------------------

def test_the_event_appears_once_even_in_two_channels(world):
    _db, client, ids = world
    for who in ("ana", "caio", "bia", "dudu"):
        events = client.get(f"/events/group?google_id={who}").json()["events"]
        assert len(events) == 1, f"{who} saw {len(events)} copies"


def test_linking_did_not_fork_the_row(world):
    _db, client, ids = world
    row = _db.get_group_event(ids["event"])
    assert sorted(row["group_ids"]) == sorted([ids["A"], ids["B"]])


def test_linking_kept_everyone_already_invited(world):
    """link_event_to_group REPLACES the invitee list rather than merging
    — the union is the caller's job. Getting that wrong silently
    un-invites people, and nothing downstream would flag it."""
    _db, client, ids = world
    invitees = set(_db.get_group_event(ids["event"])["extra_invitee_ids"])
    assert {"caio", "dudu"} <= invitees, "the original invitees survived the link"
    assert "bia" in invitees, "the new channel's members were added"
