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
    """Zero, not one. auê holds an admin row on its own channel, and
    counting that opened every channel at "1 seguindo" — a number both
    wrong and unearned. Following is now its own column."""
    _db, _main, client = api
    _channel(client)
    ch = client.get("/channels?google_id=u_ana").json()["channels"][0]
    assert ch["is_following"] is False
    assert ch["follower_count"] == 0


def test_follow_then_unfollow(api):
    _db, _main, client = api
    cid = _channel(client)

    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    ch = client.get("/channels?google_id=u_ana").json()["channels"][0]
    assert ch["is_following"] is True
    assert ch["follower_count"] == 1

    client.delete(f"/channels/{cid}/follow?google_id=u_ana")
    ch = client.get("/channels?google_id=u_ana").json()["channels"][0]
    assert ch["is_following"] is False
    assert ch["follower_count"] == 0


def test_following_twice_is_not_an_error(api):
    _db, _main, client = api
    cid = _channel(client)
    assert client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"}).status_code == 200
    assert client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"}).status_code == 200
    assert client.get("/channels?google_id=u_ana").json()["channels"][0]["follower_count"] == 1


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


# -- 9. the channel screen's own endpoint ----------------------------
#
# GET /channels/{id} is separate from GET /groups/{id} on purpose. The
# group endpoint answers "what is this crew" — members, roles, invite
# code, stats — and a channel needs almost none of it. Reusing it meant
# the screen either rendered crew chrome it had to hide or ignored most
# of the payload, which is how an "...unless it's a channel" branch
# spreads through a file.

def test_the_channel_endpoint_serves_the_whole_screen(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid)
    body = client.get(f"/channels/{cid}?google_id=u_ana").json()
    assert body["channel"]["name"] == "Rockzão"
    assert body["channel"]["follower_count"] == 0
    assert body["channel"]["upcoming_event_count"] == 1
    assert [e["name"] for e in body["events"]] == ["Terno Rei na Pedreira"]


def test_the_follower_count_excludes_aue_itself(api):
    """auê's admin row is ownership, not a subscription. Counting it
    would open every new channel at "1 seguindo" — a number that is
    both wrong and unearned."""
    _db, _main, client = api
    cid = _channel(client)
    assert client.get(f"/channels/{cid}").json()["channel"]["follower_count"] == 0
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    assert client.get(f"/channels/{cid}").json()["channel"]["follower_count"] == 1


def test_a_signed_out_visitor_can_read_the_whole_screen(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid)
    body = client.get(f"/channels/{cid}").json()
    assert len(body["events"]) == 1
    assert body["channel"]["is_following"] is False


def test_past_events_are_separated_newest_first(api):
    """A channel between shows should still read as alive. This is
    "what you missed", so the most recent leads."""
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid, name="Antigo", when="2020-01-01T20:00:00")
    _publish(client, cid, name="Recente", when="2021-06-01T20:00:00")
    _publish(client, cid, name="Futuro", when="2099-01-01T20:00:00")
    body = client.get(f"/channels/{cid}").json()
    assert [e["name"] for e in body["events"]] == ["Futuro"]
    assert [e["name"] for e in body["past_events"]] == ["Recente", "Antigo"]


def test_a_group_is_not_reachable_through_the_channel_endpoint(api):
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    assert client.get(f"/channels/{g['id']}").status_code == 404


# -- 10. per-follower notification preference ------------------------

def test_following_arms_notifications(api):
    """Following IS the opt-in. Someone who just tapped "seguir" and
    then gets nothing has no idea the switch exists."""
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    assert client.get(f"/channels/{cid}?google_id=u_ana").json()["channel"]["notify"] is True


def test_a_follower_can_turn_pushes_off_and_back_on(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})

    assert client.put(f"/channels/{cid}/notify",
                      json={"google_id": "u_ana", "notify": False}).status_code == 200
    assert client.get(f"/channels/{cid}?google_id=u_ana").json()["channel"]["notify"] is False
    assert _db.get_channel_followers_to_notify(cid) == []

    client.put(f"/channels/{cid}/notify", json={"google_id": "u_ana", "notify": True})
    assert _db.get_channel_followers_to_notify(cid) == ["u_ana"]


def test_you_cannot_set_a_preference_without_following(api):
    _db, _main, client = api
    cid = _channel(client)
    r = client.put(f"/channels/{cid}/notify", json={"google_id": "u_ana", "notify": False})
    assert r.status_code == 409


def test_aue_is_never_a_recipient_of_its_own_channel(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    assert "u_founder" not in _db.get_channel_followers_to_notify(cid)


def test_unfollowing_removes_you_from_the_push_list(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    client.delete(f"/channels/{cid}/follow?google_id=u_ana")
    assert _db.get_channel_followers_to_notify(cid) == []


def test_the_toggle_reads_pre_armed_before_you_follow(api):
    """So tapping "seguir" doesn't drop someone into a state they never
    chose — the switch shows what following will actually do."""
    _db, _main, client = api
    cid = _channel(client)
    assert client.get(f"/channels/{cid}?google_id=u_ana").json()["channel"]["notify"] is True


# -- 11. following is separate from what you ARE to the channel ------
#
# Reported from a real session: "não consigo unfollow" and "o seguir
# dentro não funciona". Both were the founder testing their own channel.
#
# role is one column and can't hold "admin AND in my list", so auê's own
# admin row made both calls inert — follow was INSERT OR IGNORE against
# the primary key, unfollow deleted only rows with role='follower'. And
# the two screens disagreed: the list counted any membership row, the
# detail counted followers, so the same channel read "Seguindo" in one
# place and "Seguir" in the other.
#
# `following` is now its own column. Same trap would have hit every
# per-channel curator.

def _follow_state(client, db_, cid, who):
    listed = next(c for c in client.get(f"/channels?google_id={who}").json()["channels"]
                  if c["id"] == cid)
    detail = client.get(f"/channels/{cid}?google_id={who}").json()["channel"]
    return listed["is_following"], detail["is_following"], db_.get_group_member_role(cid, who)


def test_the_founder_can_follow_and_unfollow_its_own_channel(api):
    _db, _main, client = api
    cid = _channel(client)

    assert _follow_state(client, _db, cid, "u_founder") == (False, False, "admin")

    client.post(f"/channels/{cid}/follow", json={"google_id": "u_founder"})
    assert _follow_state(client, _db, cid, "u_founder") == (True, True, "admin")

    client.delete(f"/channels/{cid}/follow?google_id=u_founder")
    assert _follow_state(client, _db, cid, "u_founder") == (False, False, "admin")


def test_unfollowing_does_not_cost_you_the_channel_you_run(api):
    """Stepping out of the audience is not resigning from the job."""
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_founder"})
    client.delete(f"/channels/{cid}/follow?google_id=u_founder")
    assert _db.get_group_member_role(cid, "u_founder") == "admin"


def test_the_list_and_the_detail_never_disagree(api):
    """They read one column now. Asserted directly because the bug was
    exactly this: two definitions of the same word."""
    _db, _main, client = api
    cid = _channel(client)
    for who in ("u_founder", "u_ana"):
        for action in (None, "follow", "unfollow"):
            if action == "follow":
                client.post(f"/channels/{cid}/follow", json={"google_id": who})
            elif action == "unfollow":
                client.delete(f"/channels/{cid}/follow?google_id={who}")
            listed, detail, _ = _follow_state(client, _db, cid, who)
            assert listed == detail, f"{who} after {action}: {listed} vs {detail}"


def test_a_plain_followers_row_disappears_on_unfollow(api):
    """No orphan rows for people who just changed their mind."""
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    client.delete(f"/channels/{cid}/follow?google_id=u_ana")
    assert _db.get_group_member_role(cid, "u_ana") is None


# -- 12. per-channel curators ----------------------------------------
#
# A different permission from the global curator role. That one is "can
# touch the catalog" — approve suggestions, edit events, add IG handles.
# Running Rockzão is a different job, and the whole point is handing out
# the second without the first.

def _make_curator(client, cid, google_id):
    return client.post(f"/channels/{cid}/curators",
                       json={"requesting_email": FOUNDER_EMAIL, "google_id": google_id})


def test_a_channel_curator_can_publish_into_it(api):
    _db, _main, client = api
    cid = _channel(client)
    assert _make_curator(client, cid, "u_ana").status_code == 200
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_ana", "name": "Roda de samba", "date_start": "2099-01-01T20:00:00",
    })
    assert r.status_code == 200, r.text


def test_a_channel_curator_can_rename_it(api):
    _db, _main, client = api
    cid = _channel(client)
    _make_curator(client, cid, "u_ana")
    r = client.put(f"/channels/{cid}", json={
        "requesting_email": "ana@example.com", "name": "Samba e Pagode",
        "description": "Roda toda semana",
    })
    assert r.status_code == 200
    assert _db.get_group(cid)["name"] == "Samba e Pagode"


def test_curating_one_channel_grants_nothing_anywhere_else(api):
    """The reason this role exists at all. A samba curator must not
    inherit the catalog."""
    _db, _main, client = api
    cid = _channel(client)
    other = _channel(client, name="Rockzão 2")
    _make_curator(client, cid, "u_ana")

    # Not the other channel.
    assert client.put(f"/channels/{other}", json={
        "requesting_email": "ana@example.com", "name": "Tomado",
    }).status_code == 403
    # Not the catalog.
    assert not _db.is_curator("ana@example.com")


def test_a_channel_curator_cannot_appoint_more_curators(api):
    """Founder-only. A curator who can appoint curators makes the roster
    ungovernable, and one person owns that decision."""
    _db, _main, client = api
    cid = _channel(client)
    _make_curator(client, cid, "u_ana")
    r = client.post(f"/channels/{cid}/curators",
                    json={"requesting_email": "ana@example.com", "google_id": "u_bia"})
    assert r.status_code in (401, 403)


def test_a_follower_cannot_edit_the_channel(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    r = client.put(f"/channels/{cid}", json={
        "requesting_email": "ana@example.com", "name": "Meu agora",
    })
    assert r.status_code == 403


def test_stepping_a_curator_down_takes_the_permission_with_it(api):
    _db, _main, client = api
    cid = _channel(client)
    _make_curator(client, cid, "u_ana")
    client.delete(f"/channels/{cid}/curators/u_ana?requesting_email={FOUNDER_EMAIL}")
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_ana", "name": "Não devia", "date_start": "2099-01-01T20:00:00",
    })
    assert r.status_code == 403


def test_stepping_down_cannot_remove_aue_from_its_own_channel(api):
    _db, _main, client = api
    cid = _channel(client)
    client.delete(f"/channels/{cid}/curators/u_founder?requesting_email={FOUNDER_EMAIL}")
    assert _db.get_group_member_role(cid, "u_founder") == "admin"


def test_promoting_a_follower_keeps_the_channel_in_their_list(api):
    """Curating a channel has nothing to do with whether it's in your
    list — the exact confusion `following` was split out to prevent."""
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    _make_curator(client, cid, "u_ana")
    detail = client.get(f"/channels/{cid}?google_id=u_ana").json()["channel"]
    assert detail["is_following"] is True
    assert detail["can_curate"] is True


def test_can_curate_is_false_for_everyone_else(api):
    _db, _main, client = api
    cid = _channel(client)
    assert client.get(f"/channels/{cid}?google_id=u_ana").json()["channel"]["can_curate"] is False
    assert client.get(f"/channels/{cid}").json()["channel"]["can_curate"] is False


def test_the_roster_is_founder_only(api):
    _db, _main, client = api
    cid = _channel(client)
    _make_curator(client, cid, "u_ana")
    assert client.get(f"/channels/{cid}/curators?requesting_email={FOUNDER_EMAIL}").status_code == 200
    assert client.get(f"/channels/{cid}/curators?requesting_email=ana@example.com").status_code in (401, 403)


# -- 13. the band above Eventos --------------------------------------
#
# The ask was for a followed channel's events to sort first. Mixing them
# into the main list and floating them to the top does that and buries
# the city for anyone following three channels — the first screenful
# stops being Curitiba. A band gets the same prominence for a fixed
# amount of room, and the catalog below stays what it was.
#
# It needs its own query: channel events have no invitee list, so the
# main feed's creator-or-invitee rule drops every one of them.

def test_the_band_carries_events_from_channels_you_follow(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid, name="Terno Rei")
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    events = client.get("/channels/feed?google_id=u_ana").json()["events"]
    assert [e["name"] for e in events] == ["Terno Rei"]


def test_the_band_is_empty_for_channels_you_do_not_follow(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid)
    assert client.get("/channels/feed?google_id=u_ana").json()["events"] == []


def test_turning_a_channel_off_takes_it_out_of_the_band(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    assert len(client.get("/channels/feed?google_id=u_ana").json()["events"]) == 1

    client.put(f"/channels/{cid}/prioritize", json={"google_id": "u_ana", "prioritize": False})
    assert client.get("/channels/feed?google_id=u_ana").json()["events"] == []
    # Still following — the switch is about where it shows, not whether
    # you're in.
    assert client.get(f"/channels/{cid}?google_id=u_ana").json()["channel"]["is_following"] is True


def test_prioritize_defaults_on(api):
    """Following a channel and then seeing nothing from it anywhere but
    its own screen is a follow that did nothing, which is how people
    conclude a feature is broken rather than off."""
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    assert client.get(f"/channels/{cid}?google_id=u_ana").json()["channel"]["prioritize"] is True


def test_you_cannot_set_it_without_following(api):
    _db, _main, client = api
    cid = _channel(client)
    r = client.put(f"/channels/{cid}/prioritize",
                   json={"google_id": "u_ana", "prioritize": False})
    assert r.status_code == 409


def test_past_channel_events_stay_out_of_the_band(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid, name="Já rolou", when="2020-01-01T20:00:00")
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    assert client.get("/channels/feed?google_id=u_ana").json()["events"] == []


def test_a_private_channels_events_never_reach_the_band(api):
    """The band is for auê channels. A private one's events already
    reach their members through the ordinary feed."""
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    client.post(f"/groups/{g['id']}/events", json={
        "google_id": "u_ana", "name": "Cerveja", "date_start": "2099-01-01T20:00:00",
    })
    assert client.get("/channels/feed?google_id=u_ana").json()["events"] == []


def test_the_feed_route_is_not_shadowed_by_the_id_route(api):
    """FastAPI matches in declaration order, so /channels/{group_id}
    declared first resolves this as a channel literally named "feed"
    and 404s. It did, until the route moved."""
    _db, _main, client = api
    r = client.get("/channels/feed?google_id=u_ana")
    assert r.status_code == 200
    assert "events" in r.json()


def test_a_signed_out_visitor_gets_no_band(api):
    _db, _main, client = api
    assert client.get("/channels/feed").json()["events"] == []


# -- 14. a channel's events are not the curator's personal plans ------
#
# Reported: "no perfil que sou admin, o evento aparece com banner e em
# primeiro; no perfil que não sou, aparece como card normal."
#
# The curator created the row, so /events/group handed it back as one of
# their own — which puts it in the group tier, above the whole catalog,
# with the "your plan" treatment. Everyone else got an ordinary card.
# Same event, two completely different screens, decided by who published
# it.

def test_a_channels_event_stays_out_of_the_curators_private_feed(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid, name="Corrida JCI")
    feed = client.get("/events/group?google_id=u_founder").json()["events"]
    assert [e["name"] for e in feed] == []


def test_it_stays_out_for_a_follower_too(api):
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid, name="Corrida JCI")
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    assert client.get("/events/group?google_id=u_ana").json()["events"] == []


def test_the_channel_still_shows_it_everywhere_it_should(api):
    """Excluding it from the private feed must not hide it — the band,
    the channel screen and the follower's view all still carry it."""
    _db, _main, client = api
    cid = _channel(client)
    _publish(client, cid, name="Corrida JCI")
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})

    assert len(client.get(f"/channels/{cid}?google_id=u_ana").json()["events"]) == 1
    assert len(client.get("/channels/feed?google_id=u_ana").json()["events"]) == 1


def test_a_real_private_plan_still_reaches_its_creator(api):
    """The exclusion is channels only. A personal plan is still yours."""
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    client.post(f"/groups/{g['id']}/events", json={
        "google_id": "u_ana", "name": "Churrasco", "date_start": "2099-01-01T20:00:00",
    })
    feed = client.get("/events/group?google_id=u_ana").json()["events"]
    assert [e["name"] for e in feed] == ["Churrasco"]
