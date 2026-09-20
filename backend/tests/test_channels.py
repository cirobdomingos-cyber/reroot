"""
Tests for auê channels.

A channel is a row in `groups` with kind='channel' — same table as a
private crew, because a channel is structurally the same thing (a
container of events with people attached) and forking the schema would
fork every event-attach and notify path that already works.

docs/NEXT.md recorded the risk before any of this was built: a curated
channel must not read as a crew, or people arrive expecting humans and
find a bot feed. Both are now called "canal" (decided 19 Sep), so that
distinction can't live in the vocabulary — it has to be enforced:

    canal privado  ->  membros, convite, nudge pra convidar
    canal do auê   ->  seguidores, descoberta aberta, nunca um nudge

These tests are that enforcement. Specifically:
  1. Channels are discoverable without an invite; groups are not.
  2. Following is opt-in and idempotent. Nobody is ever enrolled.
  3. Following does NOT grant the right to publish into the channel.
  4. A channel never shows up under "meus grupos", even though
     following one writes the same group_members row joining does.
  5. A channel can't be joined by invite code, even though every row
     carries one.
  6. Only the founder creates channels (user-created ones are deferred).
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

FOUNDER_EMAIL = "founder@example.com"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("FOUNDER_EMAIL", FOUNDER_EMAIL)
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO curators (email, added_by_email, added_at, notes,"
            " is_founder, is_curator, is_feedbacker) VALUES (?,?,?,?,1,1,1)",
            (FOUNDER_EMAIL, "system", now, "test"),
        )
        # The founder and two ordinary people, all signed in at least once.
        for uid, email in (("u_founder", FOUNDER_EMAIL),
                           ("u_ana", "ana@example.com"),
                           ("u_bia", "bia@example.com")):
            conn.execute(
                "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
                " VALUES (?,?,?,?,?)",
                (uid, uid, email, "", now),
            )
        conn.commit()
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _channel(client, name="Rockzão"):
    r = client.post("/admin/channels",
                    json={"requesting_email": FOUNDER_EMAIL, "name": name})
    assert r.status_code == 200, r.text
    return r.json()["channel"]["id"]


# -- 1. discovery ----------------------------------------------------

def test_a_channel_is_listed_to_everyone(api):
    _db, _main, client = api
    _channel(client)
    r = client.get("/channels?google_id=u_ana")
    assert r.status_code == 200
    names = [c["name"] for c in r.json()["channels"]]
    assert names == ["Rockzão"]


def test_a_channel_is_listed_even_to_a_signed_out_visitor(api):
    _db, _main, client = api
    _channel(client)
    assert len(client.get("/channels").json()["channels"]) == 1


def test_a_private_group_never_appears_in_the_channel_list(api):
    _db, _main, client = api
    client.post("/groups", json={"google_id": "u_ana", "name": "Role do Sax"})
    assert client.get("/channels?google_id=u_bia").json()["channels"] == []


# -- 2. following is opt-in and idempotent ---------------------------

def test_nobody_is_following_a_new_channel(api):
    _db, _main, client = api
    _channel(client)
    ch = client.get("/channels?google_id=u_ana").json()["channels"][0]
    assert ch["is_following"] is False
    # The founder's own admin row is not a follow, but it is a member row.
    assert ch["follower_count"] == 1


def test_follow_then_unfollow(api):
    _db, _main, client = api
    cid = _channel(client)

    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    ch = client.get("/channels?google_id=u_ana").json()["channels"][0]
    assert ch["is_following"] is True
    assert ch["follower_count"] == 2

    client.delete(f"/channels/{cid}/follow?google_id=u_ana")
    ch = client.get("/channels?google_id=u_ana").json()["channels"][0]
    assert ch["is_following"] is False
    assert ch["follower_count"] == 1


def test_following_twice_is_not_an_error(api):
    _db, _main, client = api
    cid = _channel(client)
    assert client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"}).status_code == 200
    assert client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"}).status_code == 200
    assert client.get("/channels?google_id=u_ana").json()["channels"][0]["follower_count"] == 2


def test_unfollowing_cannot_remove_aues_own_ownership(api):
    """An unfollow only deletes a 'follower' row. Otherwise the founder
    could be removed from their own channel by calling the endpoint."""
    _db, _main, client = api
    cid = _channel(client)
    client.delete(f"/channels/{cid}/follow?google_id=u_founder")
    assert _db.get_group_member_role(cid, "u_founder") == "admin"


def test_following_something_that_is_not_a_channel_is_404(api):
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    r = client.post(f"/channels/{g['id']}/follow", json={"google_id": "u_bia"})
    assert r.status_code == 404


# -- 3. following is not a write permission --------------------------

def test_a_follower_cannot_publish_into_the_channel(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_ana", "name": "Meu show", "date_start": "2099-01-01T20:00:00",
    })
    assert r.status_code == 403
    assert "curadoria" in r.json()["detail"].lower()


def test_the_curation_team_can_publish_into_the_channel(api):
    _db, _main, client = api
    cid = _channel(client)
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_founder", "name": "Terno Rei na Pedreira",
        "date_start": "2099-01-01T20:00:00",
    })
    assert r.status_code == 200, r.text


def test_a_group_member_can_still_publish_into_their_own_group(api):
    """The channel guard must not have broken ordinary groups."""
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    r = client.post(f"/groups/{g['id']}/events", json={
        "google_id": "u_ana", "name": "Cerveja", "date_start": "2099-01-01T20:00:00",
    })
    assert r.status_code == 200, r.text


# -- 4. a channel is never "one of my groups" ------------------------

def test_a_followed_channel_does_not_appear_under_my_groups(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    groups = client.get("/groups?google_id=u_ana").json()["groups"]
    assert groups == [], "a channel you follow is not a crew you joined"


def test_the_founders_own_channel_does_not_appear_under_their_groups(api):
    _db, _main, client = api
    _channel(client)
    assert client.get("/groups?google_id=u_founder").json()["groups"] == []


# -- 5. no invite path into a channel --------------------------------

def test_a_channel_cannot_be_joined_by_invite_code(api):
    _db, _main, client = api
    cid = _channel(client)
    code = _db.get_group(cid)["invite_code"]
    r = client.post("/groups/join", json={"google_id": "u_ana", "invite_code": code})
    assert r.json()["status"] == "not_found"
    assert _db.get_group_member_role(cid, "u_ana") is None


def test_a_group_can_still_be_joined_by_invite_code(api):
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    r = client.post("/groups/join",
                    json={"google_id": "u_bia", "invite_code": g["invite_code"]})
    assert r.json()["status"] == "ok"


# -- 6. only the founder creates channels ----------------------------

def test_a_stranger_cannot_create_a_channel(api):
    _db, _main, client = api
    r = client.post("/admin/channels",
                    json={"requesting_email": "ana@example.com", "name": "Meu canal"})
    assert r.status_code in (401, 403)


def test_a_channel_needs_a_name(api):
    _db, _main, client = api
    r = client.post("/admin/channels",
                    json={"requesting_email": FOUNDER_EMAIL, "name": "   "})
    assert r.status_code == 400


def test_creating_a_channel_before_the_founder_has_ever_signed_in_explains_itself(api):
    """Fresh environment: curators is seeded from settings at boot, but
    `users` only gets a row on first login. A 500 here would look like a
    bug; it's a setup step."""
    _db, _main, client = api
    with _db.get_conn() as conn:
        conn.execute("DELETE FROM users WHERE email = ?", (FOUNDER_EMAIL,))
        conn.commit()
    r = client.post("/admin/channels",
                    json={"requesting_email": FOUNDER_EMAIL, "name": "Rockzão"})
    assert r.status_code == 409
    assert "entra" in r.json()["detail"].lower()


# -- 7. the frontend needs `kind` to gate the crew machinery ---------
#
# GroupDetail renders channels and groups from the same payload. It
# hides the invite button, the "convida a galera" nudge and the
# "membros" label for a channel — all of which hang off this one field.
# If the detail payload ever stopped carrying it, every one of those
# would silently come back.

def test_group_detail_reports_its_kind(api):
    _db, _main, client = api
    cid = _channel(client)
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()

    channel = client.get(f"/groups/{cid}?google_id=u_ana").json()
    group = client.get(f"/groups/{g['id']}?google_id=u_ana").json()

    assert channel["kind"] == "channel"
    assert group["kind"] == "group"


def test_a_non_follower_can_still_open_a_channel(api):
    """Discovery means you can look before you follow. A private group
    refuses a non-member; a channel must not."""
    _db, _main, client = api
    cid = _channel(client)
    assert client.get(f"/groups/{cid}?google_id=u_bia").status_code == 200


def test_a_private_group_still_refuses_a_non_member(api):
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    r = client.get(f"/groups/{g['id']}?google_id=u_bia")
    assert r.status_code in (403, 404)


# -- 8. a channel is a published feed, not a private crew ------------
#
# Shipped broken in the first channels PR and caught while building the
# landing copy for the tab. get_group_events filters to creator-or-
# invitee, and auê creates channel events with NO invitees — so the
# crew gate showed an empty channel to its own followers. "Seguir"
# looked like it did nothing.

def _publish(client, cid, name="Terno Rei na Pedreira", when="2099-01-01T20:00:00"):
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_founder", "name": name, "date_start": when,
    })
    assert r.status_code == 200, r.text
    return r


def test_a_follower_sees_the_channels_events(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    body = client.get(f"/groups/{cid}?google_id=u_ana").json()
    assert [e["name"] for e in body["events"]] == ["Terno Rei na Pedreira"]


def test_someone_who_does_not_follow_yet_still_sees_them(api):
    """You have to be able to look before you follow, or the follow is a
    blind purchase."""
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid)
    body = client.get(f"/groups/{cid}?google_id=u_bia").json()
    assert len(body["events"]) == 1


def test_a_signed_out_visitor_sees_them_too(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid)
    assert len(client.get(f"/groups/{cid}?google_id=").json()["events"]) == 1


def test_a_private_group_still_hides_events_from_outsiders(api):
    """The channel exception must not have opened up ordinary groups."""
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    client.post(f"/groups/{g['id']}/events", json={
        "google_id": "u_ana", "name": "Segredo", "date_start": "2099-01-01T20:00:00",
    })
    r = client.get(f"/groups/{g['id']}?google_id=u_bia")
    assert r.status_code in (403, 404) or r.json()["events"] == []


def test_channel_followers_are_public(api):
    """The count is social proof; you should see it before deciding."""
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    body = client.get(f"/groups/{cid}?google_id=u_bia").json()
    assert len(body["members"]) == 2   # auê + ana


def test_the_channel_list_reports_what_is_actually_in_it(api):
    """A channel advertised as "12 seguindo" with nothing scheduled is
    worse than one that admits it's empty — the tab's empty state
    depends on this number."""
    _db, _main, client = api
    cid = _channel(client)
    assert client.get("/channels").json()["channels"][0]["upcoming_event_count"] == 0
    _publish(client, cid)
    _publish(client, cid, name="Outro show")
    assert client.get("/channels").json()["channels"][0]["upcoming_event_count"] == 2


def test_a_past_event_does_not_pad_the_count(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid, name="Já rolou", when="2020-01-01T20:00:00")
    assert client.get("/channels").json()["channels"][0]["upcoming_event_count"] == 0
