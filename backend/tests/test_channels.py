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


def test_following_an_id_that_is_not_a_channel_at_all_is_404(api):
    """Every group IS a channel since the unification, so the 404 is now
    about the id not existing rather than about the row being the wrong
    kind. A private channel is followable — that's what puts it in your
    list and in the band, same as a public one."""
    _db, _main, client = api
    assert client.post("/channels/grp_nope/follow",
                       json={"google_id": "u_ana"}).status_code == 404


def test_a_private_channel_can_be_followed_by_its_members(api):
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    assert client.post(f"/channels/{g['id']}/follow",
                       json={"google_id": "u_ana"}).status_code == 200


def test_a_private_channel_is_still_not_discoverable(api):
    """The one thing visibility decides. Every pre-existing crew was
    migrated to private regardless of what its visibility column said —
    'public' used to mean 'anyone with the LINK', and letting that
    retroactively mean 'listed to everyone' would have published groups
    whose creators chose link-sharing."""
    _db, _main, client = api
    client.post("/groups", json={"google_id": "u_ana", "name": "Role"})
    assert client.get("/channels?google_id=u_bia").json()["channels"] == []


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


def test_a_private_channel_is_reachable_by_its_members_only(api):
    """One screen serves both now, so this endpoint gates the way the
    old group one did: a private channel is for the people in it, a
    public one is open because looking before you follow is the model."""
    _db, _main, client = api
    g = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    assert client.get(f"/channels/{g['id']}?google_id=u_ana").status_code == 200
    assert client.get(f"/channels/{g['id']}?google_id=u_bia").status_code == 403
    assert client.get(f"/channels/{g['id']}").status_code == 403


def test_the_payload_says_which_shape_to_render(api):
    _db, _main, client = api
    pub = _channel(client)
    priv = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()["id"]
    assert client.get(f"/channels/{pub}").json()["channel"]["is_public"] is True
    assert client.get(
        f"/channels/{priv}?google_id=u_ana").json()["channel"]["is_public"] is False


def test_a_private_channels_events_keep_the_invitee_rule(api):
    """An outsider invited to one specific night must not get the rest
    of the channel with it."""
    _db, _main, client = api
    priv = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()
    client.post("/groups/join", json={"google_id": "u_bia", "invite_code": priv["invite_code"]})
    client.post(f"/groups/{priv['id']}/events", json={
        "google_id": "u_ana", "name": "Só meu", "date_start": "2099-01-01T20:00:00",
        "invitee_google_ids": [],
    })
    seen = client.get(f"/channels/{priv['id']}?google_id=u_bia").json()["events"]
    assert seen == []


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


# -- 15. one model, two owners ---------------------------------------
#
# Public and private were two parallel implementations of one idea:
# different screens, different endpoints, different words for the people
# inside, and curators that existed on one side only. Now `visibility`
# decides discovery and nothing else differs — except who the owner is.
#
#     público   dono = auê,        curadores nomeados por auê
#     privado   dono = quem criou, curadores nomeados por quem criou

def _private(client, owner="u_ana", name="Role do Sax"):
    return client.post("/groups", json={"google_id": owner, "name": name}).json()["id"]


def test_the_creator_of_a_private_channel_can_appoint_curators(api):
    """The gap this closes: a private channel used to have exactly one
    person who could change anything."""
    _db, _main, client = api
    cid = _private(client)
    r = client.post(f"/channels/{cid}/curators",
                    json={"requesting_email": "ana@example.com", "google_id": "u_bia"})
    assert r.status_code == 200
    assert _db.is_channel_curator(cid, "u_bia")


def test_that_curator_can_edit_the_private_channel(api):
    _db, _main, client = api
    cid = _private(client)
    client.post(f"/channels/{cid}/curators",
                json={"requesting_email": "ana@example.com", "google_id": "u_bia"})
    r = client.put(f"/groups/{cid}", json={
        "google_id": "u_bia", "name": "Role do Sax — 2026", "description": "",
    })
    assert r.status_code == 200
    assert _db.get_group(cid)["name"] == "Role do Sax — 2026"


def test_the_founder_cannot_touch_someone_elses_private_channel(api):
    """auê owns the public channels. Letting the founder edit anyone's
    private one would make "private" mean something it doesn't — the
    unification is two owners working the same way, not one outranking
    the other."""
    _db, _main, client = api
    cid = _private(client)
    assert client.put(f"/channels/{cid}", json={
        "requesting_email": FOUNDER_EMAIL, "name": "Tomado",
    }).status_code == 403
    assert client.post(f"/channels/{cid}/curators", json={
        "requesting_email": FOUNDER_EMAIL, "google_id": "u_bia",
    }).status_code == 403


def test_the_founder_still_owns_the_public_ones(api):
    _db, _main, client = api
    cid = _channel(client)
    assert client.put(f"/channels/{cid}", json={
        "requesting_email": FOUNDER_EMAIL, "name": "Rockzão 2",
    }).status_code == 200


def test_a_curator_cannot_appoint_more_curators_on_a_private_channel(api):
    """Same rule both sides: one person owns that decision."""
    _db, _main, client = api
    cid = _private(client)
    client.post(f"/channels/{cid}/curators",
                json={"requesting_email": "ana@example.com", "google_id": "u_bia"})
    r = client.post(f"/channels/{cid}/curators",
                    json={"requesting_email": "bia@example.com", "google_id": "u_founder"})
    assert r.status_code == 403


def test_an_ordinary_member_cannot_edit_the_channel(api):
    _db, _main, client = api
    cid = _private(client)
    code = _db.get_group(cid)["invite_code"]
    client.post("/groups/join", json={"google_id": "u_bia", "invite_code": code})
    r = client.put(f"/groups/{cid}", json={"google_id": "u_bia", "name": "Meu agora"})
    assert r.status_code == 403


def test_but_an_ordinary_member_can_still_publish(api):
    """Control means administration, not publishing. Only 3 of 38
    accounts have ever created an event — restricting who may add one is
    the opposite of what that number asks for."""
    _db, _main, client = api
    cid = _private(client)
    code = _db.get_group(cid)["invite_code"]
    client.post("/groups/join", json={"google_id": "u_bia", "invite_code": code})
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_bia", "name": "Churrasco", "date_start": "2099-01-01T20:00:00",
    })
    assert r.status_code == 200, r.text


def test_publishing_into_a_public_channel_is_still_curators_only(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_ana", "name": "Meu show", "date_start": "2099-01-01T20:00:00",
    })
    assert r.status_code == 403


# -- 10. "already added" has to see channels -------------------------
#
# AddToGroupSheet lists the crews you're in AND the channels you curate,
# then asks /catalog-events/{id}/groups which of them already hold the
# event. The scan ran over get_groups_for_user, whose docstring says in
# so many words that it excludes channels — so the answer was wrong for
# exactly the rows a curator uses most: an auê channel that already had
# the event kept offering to add it again.

def _add_to(client, gid, who, name="Masterclass DJ", src="instagram_ig_x_A"):
    r = client.post(f"/groups/{gid}/events", json={
        "google_id": who, "name": name, "venue": "MACRO",
        "date_start": "2099-09-24T20:00:00", "source_event_id": src,
    })
    assert r.status_code == 200, r.text
    return r.json()


def _linked(client, event_id, who):
    r = client.get(f"/catalog-events/{event_id}/groups?google_id={who}")
    assert r.status_code == 200, r.text
    return set(r.json()["linked_group_ids"])


def test_a_channel_holding_the_event_is_reported_as_linked(api):
    _db, _main, client = api
    cid = _channel(client, "auê Samba e Pagode")
    _add_to(client, cid, "u_founder")
    assert cid in _linked(client, "instagram_ig_x_A", "u_founder")


def test_a_crew_and_a_channel_are_both_reported(api):
    """The shape that showed the bug: one private, one auê, same night.
    The private one came back linked and the channel didn't, so the
    sheet showed a tick on one row and a plus on the other."""
    _db, _main, client = api
    gid = client.post("/groups", json={"google_id": "u_founder", "name": "Curitiba na real"}).json()["id"]
    cid = _channel(client, "auê Samba e Pagode")
    _add_to(client, gid, "u_founder")
    _add_to(client, cid, "u_founder")
    assert _linked(client, "instagram_ig_x_A", "u_founder") == {gid, cid}


def test_asking_with_a_fork_id_answers_for_the_catalog_event(api):
    """Once an event is in a channel, the row the user is looking at in
    Eventos IS the fork — so the sheet asks with grp_ev_…, not with the
    catalog id. Both questions have the same answer."""
    _db, _main, client = api
    gid = client.post("/groups", json={"google_id": "u_founder", "name": "Curitiba na real"}).json()["id"]
    cid = _channel(client, "auê Samba e Pagode")
    fork = _add_to(client, gid, "u_founder")
    _add_to(client, cid, "u_founder")
    assert _linked(client, fork["id"], "u_founder") == {gid, cid}


def test_a_channel_without_the_event_is_not_reported(api):
    """Guards the fix from the lazy version: returning every channel id
    would pass the tests above and tick every row in the sheet."""
    _db, _main, client = api
    cid = _channel(client, "auê Samba e Pagode")
    other = _channel(client, "auê Rockzera")
    _add_to(client, cid, "u_founder")
    linked = _linked(client, "instagram_ig_x_A", "u_founder")
    assert cid in linked and other not in linked


def test_someone_elses_private_crew_is_never_reported(api):
    """Channels are scanned for everyone because what a public channel
    holds is public. A crew is not — and the caller's own membership is
    still what decides."""
    _db, _main, client = api
    gid = client.post("/groups", json={"google_id": "u_ana", "name": "Role da Ana"}).json()["id"]
    _add_to(client, gid, "u_ana")
    assert _linked(client, "instagram_ig_x_A", "u_bia") == set()


# -- 11. a private channel gets the same two switches ----------------
#
# `following` was built for public channels, where opting in is a real
# choice. A private channel isn't found, you're let into it, so
# membership already IS that choice. With the column at 0 on every crew
# row, ChannelDetail hid both switches (it gates them on is_following)
# and both endpoints answered "Segue o canal primeiro" to people who
# were already inside.

def _crew(client, who="u_ana", name="Curitiba na real"):
    return client.post("/groups", json={"google_id": who, "name": name}).json()["id"]


def test_making_a_private_channel_puts_it_in_your_list(api):
    _db, _main, client = api
    gid = _crew(client)
    assert client.get(f"/channels/{gid}?google_id=u_ana"
                      ).json()["channel"]["is_following"] is True


def test_being_let_into_one_puts_it_in_yours_too(api):
    _db, _main, client = api
    gid = _crew(client)
    code = client.get(f"/channels/{gid}?google_id=u_ana").json()["channel"]["invite_code"]
    assert client.post("/groups/join", json={"google_id": "u_bia", "invite_code": code}).status_code == 200
    assert client.get(f"/channels/{gid}?google_id=u_bia"
                      ).json()["channel"]["is_following"] is True


def test_a_member_can_set_the_two_switches(api):
    """Both used to 409. The switches exist on the same screen for both
    kinds of channel now, so they have to answer for both."""
    _db, _main, client = api
    gid = _crew(client)
    for path, key in (("notify", "notify"), ("prioritize", "prioritize")):
        r = client.put(f"/channels/{gid}/{path}",
                       json={"google_id": "u_ana", key: False})
        assert r.status_code == 200, (path, r.text)
        assert r.json()[key] is False


def test_following_a_public_channel_is_still_a_separate_act(api):
    """The fix must not reach public channels. Being listed one is not
    consent to have it in your list — that distinction is the whole
    reason the column exists."""
    _db, _main, client = api
    cid = _channel(client)
    assert client.get(f"/channels/{cid}?google_id=u_ana"
                      ).json()["channel"]["is_following"] is False


def test_the_founders_own_channel_is_not_in_the_founders_list(api):
    """Creating an auê channel writes an admin row. That's ownership,
    not a subscription — counting it opened every channel at 1 seguindo."""
    _db, _main, client = api
    cid = _channel(client)
    ch = client.get(f"/channels/{cid}?google_id=u_founder").json()["channel"]
    assert ch["is_following"] is False
    assert ch["follower_count"] == 0


# -- 12. and the switches now do something ---------------------------

def _crew_event(client, gid, who="u_ana", name="Churrasco do Ze"):
    r = client.post(f"/groups/{gid}/events", json={
        "google_id": who, "name": name, "venue": "Quintal",
        "date_start": "2099-11-01T18:00:00",
    })
    assert r.status_code == 200, r.text
    return r.json()


def _feed_names(client, who):
    return {e["name"] for e in client.get(f"/events/group?google_id={who}").json()["events"]}


def test_a_private_channels_events_reach_its_members(api):
    _db, _main, client = api
    gid = _crew(client)
    _crew_event(client, gid)
    assert "Churrasco do Ze" in _feed_names(client, "u_ana")


def test_turning_priority_off_takes_the_channel_out_of_eventos(api):
    """"Só aqui dentro — fora dos Eventos" is what the switch promises.
    Until now the flag was read only by the public-channel feed, so on a
    private channel it promised that to nobody."""
    _db, _main, client = api
    gid = _crew(client)
    _crew_event(client, gid)
    client.put(f"/channels/{gid}/prioritize",
               json={"google_id": "u_ana", "prioritize": False})
    assert "Churrasco do Ze" not in _feed_names(client, "u_ana")


def test_it_only_goes_quiet_for_the_person_who_muted_it(api):
    _db, _main, client = api
    gid = _crew(client)
    code = client.get(f"/channels/{gid}?google_id=u_ana").json()["channel"]["invite_code"]
    client.post("/groups/join", json={"google_id": "u_bia", "invite_code": code})
    _crew_event(client, gid)
    client.put(f"/channels/{gid}/prioritize",
               json={"google_id": "u_ana", "prioritize": False})
    assert "Churrasco do Ze" not in _feed_names(client, "u_ana")
    assert "Churrasco do Ze" in _feed_names(client, "u_bia")


def test_muting_one_channel_does_not_hide_what_another_says(api):
    """Any, not all. An event in a muted channel and a live one is still
    an event you asked to see."""
    _db, _main, client = api
    quiet = _crew(client, name="Canal mudo")
    loud = _crew(client, name="Canal vivo")
    ev = _crew_event(client, quiet)
    client.post(f"/groups/{loud}/events", json={
        "google_id": "u_ana", "source_event_id": ev["id"],
        "name": ev["name"], "venue": "Quintal",
        "date_start": "2099-11-01T18:00:00",
    })
    client.put(f"/channels/{quiet}/prioritize",
               json={"google_id": "u_ana", "prioritize": False})
    assert "Churrasco do Ze" in _feed_names(client, "u_ana")


# -- 13. a public channel summarises, it doesn't fire per event ------
#
# Publishing into an auê channel is editorial work and comes in bursts:
# a curator clearing a backlog sent one push per event, which is the
# shape that gets an app muted. Private channels keep the instant push —
# there the event IS the message, and holding it until evening turns it
# into news about a night that already started.

import asyncio
from models import EnrichedEvent


def _sent(monkeypatch, main):
    """Capture _send_push_to_user calls instead of sending them."""
    calls = []
    monkeypatch.setattr(main, "_send_push_to_user",
                        lambda gid, **kw: calls.append((gid, kw)))
    return calls


def test_adding_to_a_public_channel_notifies_nobody_right_now(api, monkeypatch):
    _db, main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    calls = _sent(monkeypatch, main)
    r = _add_to(client, cid, "u_founder")
    assert calls == []
    # And says so. The sheet renders "3 avisados" off this number.
    assert r["notified_count"] == 0


def test_adding_to_a_private_channel_still_notifies_at_once(api, monkeypatch):
    _db, main, client = api
    gid = _crew(client)
    code = client.get(f"/channels/{gid}?google_id=u_ana").json()["channel"]["invite_code"]
    client.post("/groups/join", json={"google_id": "u_bia", "invite_code": code})
    calls = _sent(monkeypatch, main)
    _crew_event(client, gid)
    assert "u_bia" in [gid_ for gid_, _ in calls]


def test_the_digest_headlines_the_channel_you_chose(api, monkeypatch):
    """The interesting number is not how many events the city got, it's
    how many came from a channel you picked. That differs per person,
    so the push copy is built per person."""
    _db, main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    for i in range(3):
        _add_to(client, cid, "u_founder", name=f"Show {i}", src=f"cat_{i}")
    picks = _db.channel_picks_by_follower(["cat_0", "cat_1", "cat_2"])
    assert picks == {"u_ana": {"Rockzão": 3}}


def test_someone_who_follows_nothing_is_not_in_it(api):
    _db, main, client = api
    cid = _channel(client)
    _add_to(client, cid, "u_founder", src="cat_0")
    assert _db.channel_picks_by_follower(["cat_0"]) == {}


def test_someone_who_muted_the_channel_is_not_in_it(api):
    _db, main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    client.put(f"/channels/{cid}/notify", json={"google_id": "u_ana", "notify": False})
    _add_to(client, cid, "u_founder", src="cat_0")
    assert _db.channel_picks_by_follower(["cat_0"]) == {}


def test_a_private_channel_never_reaches_the_digest(api):
    """It pushed at the time. Counting it here would be the same news
    twice, and would put a private channel's name in a summary built
    from the public catalog."""
    _db, main, client = api
    gid = _crew(client)
    client.post(f"/groups/{gid}/events", json={
        "google_id": "u_ana", "name": "Churrasco do Ze", "venue": "Quintal",
        "date_start": "2099-11-01T18:00:00", "source_event_id": "cat_0",
    })
    assert _db.channel_picks_by_follower(["cat_0"]) == {}


# -- 14. a run forked from one of its days keeps that day -------------
#
# A residency or a week-long programação is ONE catalog row, rendered on
# every day it covers. Adding it from the 18th has to fork the 18th —
# and then hold it, because _merge_source_event reads a fork's dates
# back off the catalog row, where the run still starts on the 14th.
# Reported from production: "Semana do Consumidor" at Janela Bar landed
# in the channel already over.

RUN_ID = "instagram_ig_janela_A"


def _catalog_run(_db, **overrides):
    """A catalog row covering the 14th through the 20th."""
    from models import EnrichedEvent
    base = dict(
        id=RUN_ID, source="instagram", external_id="ig_janela_A",
        name="Semana do Consumidor", description="Descontos a semana toda",
        venue_name="Janela Bar", venue_address="", neighborhood="Batel",
        city="Curitiba",
        date_start=datetime(2099, 3, 14, 19, 0, tzinfo=timezone.utc),
        date_end=datetime(2099, 3, 20, 23, 0, tzinfo=timezone.utc),
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="🤝",
        has_food=True, is_low_pressure=False, is_curated=False,
        pitch="", price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        url="https://instagram.com/p/A/", image_url=None,
        fetched_at=datetime.now(timezone.utc), genre="",
    )
    base.update(overrides)
    _db.upsert_event(EnrichedEvent(**base))


@pytest.fixture()
def run_event(api):
    _db, _main, client = api
    _catalog_run(_db)
    return _db, _main, client


def test_forking_the_18th_stores_the_18th(run_event):
    _db, main, client = run_event
    gid = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()["id"]
    r = client.post(f"/groups/{gid}/events", json={
        "google_id": "u_ana", "name": "Semana do Consumidor", "venue": "Janela Bar",
        "date_start": "2099-03-18T19:00:00", "date_end": None,
        "source_event_id": RUN_ID,
    })
    assert r.status_code == 200, r.text
    assert r.json()["date_start"][:10] == "2099-03-18"


def test_and_the_catalog_does_not_put_the_14th_back(run_event):
    """The half that made the first half useless. Without the pin the
    fork stores the 18th and every read hands back the 14th."""
    _db, main, client = run_event
    gid = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()["id"]
    client.post(f"/groups/{gid}/events", json={
        "google_id": "u_ana", "name": "Semana do Consumidor", "venue": "Janela Bar",
        "date_start": "2099-03-18T19:00:00", "date_end": None,
        "source_event_id": RUN_ID,
    })
    got = client.get("/events/group?google_id=u_ana").json()["events"]
    assert [e["dateStart"][:10] for e in got] == ["2099-03-18"]


def test_a_run_added_as_a_run_still_keeps_its_range(run_event):
    """The opposite failure, which a previous fix already caused once:
    dropping date_end unconditionally collapsed every multi-day event to
    its opening day."""
    _db, main, client = run_event
    gid = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()["id"]
    client.post(f"/groups/{gid}/events", json={
        "google_id": "u_ana", "name": "Semana do Consumidor", "venue": "Janela Bar",
        "date_start": "2099-03-14T19:00:00", "date_end": "2099-03-20T23:00:00",
        "source_event_id": RUN_ID,
    })
    got = client.get("/events/group?google_id=u_ana").json()["events"][0]
    assert got["dateStart"][:10] == "2099-03-14"
    assert (got.get("dateEnd") or "")[:10] == "2099-03-20"


def test_a_plain_fork_still_tracks_the_catalog(run_event):
    """Pinning must be narrow. An ordinary add keeps following the
    scrape, which is how a fork's time and cover stay correct."""
    _db, main, client = run_event
    gid = client.post("/groups", json={"google_id": "u_ana", "name": "Role"}).json()["id"]
    client.post(f"/groups/{gid}/events", json={
        "google_id": "u_ana", "name": "Semana do Consumidor", "venue": "Janela Bar",
        "date_start": "2099-03-14T19:00:00",
        "source_event_id": RUN_ID,
    })
    # Re-scrape moves the run.
    _catalog_run(_db, date_start=datetime(2099, 3, 15, 20, 0, tzinfo=timezone.utc))
    got = client.get("/events/group?google_id=u_ana").json()["events"][0]
    assert got["dateStart"][:10] == "2099-03-15"


# -- 15. following is not being invited ------------------------------
#
# Publishing into a channel expanded extra_invitee_ids to every member,
# and following writes a member row — so an auê channel's whole
# programme arrived as personal invitations. That list is what every
# personal surface keys off: "esperando você", "ver convite", the
# creator-or-invitee visibility rule, isPersonalPlan. Reported from
# production as "muita coisa tá caindo como convite".

def test_publishing_into_an_aue_channel_invites_nobody(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_bia"})
    ev = _add_to(client, cid, "u_founder")
    assert _db.get_group_event(ev["id"])["extra_invitee_ids"] == []


def test_a_channel_event_is_not_in_a_followers_personal_feed(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    _add_to(client, cid, "u_founder")
    assert client.get("/events/group?google_id=u_ana").json()["events"] == []


def test_the_channel_still_shows_it_to_that_follower(api):
    """The events have to keep reaching people — just not as invitations.
    The channel screen lists them without consulting the invitee list."""
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    _add_to(client, cid, "u_founder")
    got = client.get(f"/channels/{cid}?google_id=u_ana").json()["events"]
    assert [e["name"] for e in got] == ["Masterclass DJ"]


def test_a_private_channel_still_invites_its_members(api):
    """The opposite failure. A crew's event IS an invitation, and
    emptying the list here would make it invisible to everyone but its
    creator."""
    _db, _main, client = api
    gid = _crew(client)
    code = client.get(f"/channels/{gid}?google_id=u_ana").json()["channel"]["invite_code"]
    client.post("/groups/join", json={"google_id": "u_bia", "invite_code": code})
    ev = _crew_event(client, gid)
    assert "u_bia" in _db.get_group_event(ev["id"])["extra_invitee_ids"]
    assert [e["name"] for e in
            client.get("/events/group?google_id=u_bia").json()["events"]] == ["Churrasco do Ze"]


def test_followers_already_written_in_are_cleaned_up(api):
    """The rows that already exist in production. Nothing else reads
    that list to mean anything but "was invited", so leaving them would
    leave the symptom in place for every event added so far."""
    _db, _main, client = api
    cid = _channel(client)
    ev = _add_to(client, cid, "u_founder")
    with _db.get_conn() as conn:
        conn.execute(
            "UPDATE group_events SET extra_invitee_ids = ? WHERE id = ?",
            ('["u_ana","u_bia"]', ev["id"]),
        )
        conn.commit()
    _db.init_db()          # re-run migrations, as a deploy does
    assert _db.get_group_event(ev["id"])["extra_invitee_ids"] == []


# -- 16. a curator reads their own channel like anyone else ------------
#
# Running a channel is about what you may do to it, not what your
# Eventos shows. For one round the channel feed also admitted admin and
# curator rows, so a curator's channels sat at the top of their Eventos
# whether they followed or not — "a ordenação está travada só pro
# admin". Following is the only thing that puts a channel in your list,
# for the founder as for everyone.

def test_a_curator_who_does_not_follow_sees_no_marks(api):
    _db, _main, client = api
    cid = _channel(client)
    _add_to(client, cid, "u_founder")
    assert _db.get_followed_channel_events("u_founder") == []


def test_a_curator_who_follows_sees_them_like_anyone(api):
    _db, _main, client = api
    cid = _channel(client)
    _add_to(client, cid, "u_founder")
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_founder"})
    assert [e["name"] for e in _db.get_followed_channel_events("u_founder")] == ["Masterclass DJ"]


def test_and_unfollowing_takes_them_out_again(api):
    """The half that was stuck: an admin's unfollow cleared `following`
    and the feed ignored it."""
    _db, _main, client = api
    cid = _channel(client)
    _add_to(client, cid, "u_founder")
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_founder"})
    client.delete(f"/channels/{cid}/follow?google_id=u_founder")
    assert _db.get_followed_channel_events("u_founder") == []
    # ...without costing them the channel they run.
    assert _db.get_group_member_role(cid, "u_founder") == "admin"


def test_an_admin_row_alone_is_not_a_follower(api):
    """Ownership isn't a subscription: the founder's admin row must not
    open every channel at "1 seguindo"."""
    _db, _main, client = api
    cid = _channel(client)
    ch = client.get(f"/channels/{cid}?google_id=u_founder").json()["channel"]
    assert ch["follower_count"] == 0
    assert ch["is_following"] is False


def test_a_stranger_still_gets_nothing(api):
    _db, _main, client = api
    cid = _channel(client)
    _add_to(client, cid, "u_founder")
    assert _db.get_followed_channel_events("u_bia") == []


# -- 17. taking a night out of a channel leaves no ghost --------------
#
# unlink_event_from_group nulls the group and keeps the row, which
# leaves a copy of a catalog event belonging to no channel and invited
# to by nobody. Every personal surface reads a group-less event as a
# plan its creator made — so removing a night from a channel turned it
# into a private plan, with a padlock, on an event anyone can see in the
# catalog. Reported from production: "ainda aparece como plano".

def _orphan(client, _db, cid):
    ev = _add_to(client, cid, "u_founder")
    _db.unlink_event_from_group(ev["id"], cid)
    return ev


def test_an_orphaned_fork_is_not_shown_as_a_plan(api):
    _db, _main, client = api
    cid = _channel(client)
    _orphan(client, _db, cid)
    assert client.get("/events/group?google_id=u_founder").json()["events"] == []


def test_the_row_survives_so_the_rsvp_does(api):
    """Adding to a channel auto-RSVPs the creator. Deleting the row on
    unlink would throw that away, so it is suppressed, not destroyed."""
    _db, _main, client = api
    cid = _channel(client)
    ev = _orphan(client, _db, cid)
    assert _db.get_group_event(ev["id"]) is not None


def test_re_adding_relinks_it_instead_of_writing_a_second_row(api):
    """The duplicate check looks for a fork in THIS group, and an orphan
    is in none — so remove-and-re-add used to leave two rows for one
    night with nothing saying they were the same."""
    _db, _main, client = api
    cid = _channel(client)
    ev = _orphan(client, _db, cid)
    again = _add_to(client, cid, "u_founder")
    assert again["id"] == ev["id"]


def test_and_it_comes_back_as_the_channels_event(api):
    _db, _main, client = api
    cid = _channel(client)
    _orphan(client, _db, cid)
    _add_to(client, cid, "u_founder")
    got = client.get(f"/channels/{cid}?google_id=u_founder").json()["events"]
    assert [e["name"] for e in got] == ["Masterclass DJ"]


def test_relinking_into_a_public_channel_invites_nobody(api):
    _db, _main, client = api
    cid = _channel(client)
    ev = _orphan(client, _db, cid)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    _add_to(client, cid, "u_founder")
    assert _db.get_group_event(ev["id"])["extra_invitee_ids"] == []


def test_a_fork_someone_built_on_is_still_a_plan(api):
    """Narrow on purpose. A note or an invitee list means a person made
    something out of the catalog row, and that survives as a plan."""
    _db, _main, client = api
    cid = _channel(client)
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_founder", "name": "Masterclass DJ", "venue": "MACRO",
        "date_start": "2099-09-24T20:00:00", "source_event_id": "instagram_ig_x_A",
        "note": "bora nessa",
    })
    _db.unlink_event_from_group(r.json()["id"], cid)
    names = [e["name"] for e in
             client.get("/events/group?google_id=u_founder").json()["events"]]
    assert names == ["Masterclass DJ"]


# -- 18. and the ghosts already written are cleared -------------------

def test_the_migration_removes_an_orphan(api):
    _db, _main, client = api
    cid = _channel(client)
    ev = _orphan(client, _db, cid)
    _db.init_db()                      # re-run migrations, as a deploy does
    assert _db.get_group_event(ev["id"]) is None


def test_the_rsvp_moves_to_the_catalog_event(api):
    """Adding to a PRIVATE channel auto-RSVPs the creator, and that
    "vou" was about the night — which still exists in the catalog.
    Deleting the row without moving it would quietly un-confirm them.

    Private, because publishing into a public channel is editorial work
    and no longer RSVPs anyone."""
    _db, _main, client = api
    gid = _crew(client, "u_founder")
    ev = _add_to(client, gid, "u_founder")
    _db.unlink_event_from_group(ev["id"], gid)
    def _rsvped(event_id):
        with _db.get_conn() as conn:
            return conn.execute(
                "SELECT 1 FROM rsvps WHERE google_id = ? AND event_id = ?",
                ("u_founder", event_id),
            ).fetchone() is not None

    assert _rsvped(ev["id"])
    _db.init_db()
    assert _rsvped("instagram_ig_x_A")
    assert not _rsvped(ev["id"])


def test_a_fork_someone_built_on_survives_the_migration(api):
    _db, _main, client = api
    cid = _channel(client)
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_founder", "name": "Masterclass DJ", "venue": "MACRO",
        "date_start": "2099-09-24T20:00:00", "source_event_id": "instagram_ig_x_A",
        "note": "bora nessa",
    })
    _db.unlink_event_from_group(r.json()["id"], cid)
    _db.init_db()
    assert _db.get_group_event(r.json()["id"]) is not None


def test_an_event_still_in_a_channel_is_untouched(api):
    _db, _main, client = api
    cid = _channel(client)
    ev = _add_to(client, cid, "u_founder")
    _db.init_db()
    assert _db.get_group_event(ev["id"]) is not None


# -- 19. deleting a channel leaves nothing behind ----------------------

def test_deleting_a_channel_takes_its_forks_and_their_rsvps(api):
    _db, _main, client = api
    gid = _crew(client, "u_founder")           # private: auto-RSVPs
    ev = _add_to(client, gid, "u_founder")
    with _db.get_conn() as conn:
        assert conn.execute("SELECT 1 FROM rsvps WHERE event_id = ?", (ev["id"],)).fetchone()
    out = _db.delete_group(gid)
    assert out["events_deleted"] == 1
    assert _db.get_group_event(ev["id"]) is None
    with _db.get_conn() as conn:
        assert conn.execute("SELECT 1 FROM rsvps WHERE event_id = ?", (ev["id"],)).fetchone() is None
        assert conn.execute("SELECT 1 FROM group_members WHERE group_id = ?", (gid,)).fetchone() is None


def test_an_event_also_in_another_group_is_unlinked_not_deleted(api):
    _db, _main, client = api
    a = _crew(client, "u_ana", "A")
    b = _crew(client, "u_ana", "B")
    ev = _crew_event(client, a)
    client.post(f"/groups/{b}/events", json={
        "google_id": "u_ana", "source_event_id": ev["id"], "name": ev["name"],
        "venue": "Quintal", "date_start": "2099-11-01T18:00:00",
    })
    out = _db.delete_group(a)
    assert out == {"events_deleted": 0, "events_unlinked": 1,
                   "members_removed": 1, "curators_removed": 0}
    row = _db.get_group_event(ev["id"])
    assert row is not None and row["group_id"] == b and row["group_ids"] == [b]


def test_the_admin_endpoint_is_founder_only_and_public_only(api):
    _db, _main, client = api
    cid = _channel(client)
    gid = _crew(client)
    assert client.delete(f"/admin/channels/{cid}?requesting_email=ana@example.com").status_code in (401, 403)
    assert client.delete(f"/admin/channels/{gid}?requesting_email={FOUNDER_EMAIL}").status_code == 404
    r = client.delete(f"/admin/channels/{cid}?requesting_email={FOUNDER_EMAIL}")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert client.get("/channels").json()["channels"] == []
    assert _db.get_group(gid) is not None


# -- 20. a fork of a public channel is a public event -----------------
#
# The creator-or-invitee rule on GET /events/{id} is for private plans.
# It admitted followers by accident while publishing wrote every follower
# onto the invitee list; once that stopped, every public-channel fork
# 403'd for everyone but its curator.

def test_a_follower_can_open_a_public_channels_event(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    ev = _add_to(client, cid, "u_founder")
    assert client.get(f"/events/{ev['id']}?google_id=u_ana").status_code == 200


def test_so_can_someone_who_follows_nothing(api):
    """Public means public. The channel is listed to everyone and its
    events are catalog events; the fork inherits that."""
    _db, _main, client = api
    cid = _channel(client)
    ev = _add_to(client, cid, "u_founder")
    assert client.get(f"/events/{ev['id']}?google_id=u_bia").status_code == 200
    assert client.get(f"/events/{ev['id']}").status_code == 200


def test_a_private_channels_event_is_still_private(api):
    _db, _main, client = api
    gid = _crew(client, "u_ana")
    ev = _crew_event(client, gid)
    assert client.get(f"/events/{ev['id']}?google_id=u_bia").status_code == 403


# -- 21. one curator role ----------------------------------------------
#
# A general curator has every power, channels included. You don't have
# to be the rock specialist to add a show to Rockzera, and a curator who
# wants to help another channel along is welcome. Per-channel
# appointment still exists underneath — the founder's tool for handing
# one channel to someone who isn't a curator.

def _make_general_curator(_db, email):
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO curators (email, added_by_email, added_at, notes,"
            " is_founder, is_curator, is_feedbacker) VALUES (?,?,?,?,0,1,0)",
            (email, FOUNDER_EMAIL, datetime.now(timezone.utc).isoformat(), "test"),
        )
        conn.commit()


def test_a_curator_can_publish_into_any_channel(api):
    _db, _main, client = api
    _make_general_curator(_db, "ana@example.com")
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    r = client.post(f"/groups/{cid}/events", json={
        "google_id": "u_ana", "name": "Show Pitty", "venue": "Igloo",
        "date_start": "2099-10-14T19:00:00", "source_event_id": "cat_pitty",
    })
    assert r.status_code == 200, r.text


def test_a_curator_can_edit_any_channel(api):
    _db, _main, client = api
    _make_general_curator(_db, "ana@example.com")
    cid = _channel(client)
    r = client.put(f"/channels/{cid}", json={
        "requesting_email": "ana@example.com", "name": "auê Rock", "description": "Tudo com guitarra",
    })
    assert r.status_code == 200, r.text
    assert client.get(f"/channels/{cid}").json()["channel"]["name"] == "auê Rock"


def test_a_curator_is_told_they_can_curate(api):
    _db, _main, client = api
    _make_general_curator(_db, "ana@example.com")
    cid = _channel(client)
    ch = client.get(f"/channels/{cid}?google_id=u_ana").json()["channel"]
    assert ch["can_curate"] is True
    assert ch["viewer_is_founder"] is False


def test_the_founder_is_told_they_are(api):
    _db, _main, client = api
    cid = _channel(client)
    ch = client.get(f"/channels/{cid}?google_id=u_founder").json()["channel"]
    assert ch["can_curate"] is True and ch["viewer_is_founder"] is True


def test_a_plain_follower_still_cannot(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_bia"})
    ch = client.get(f"/channels/{cid}?google_id=u_bia").json()["channel"]
    assert ch["can_curate"] is False
    assert client.put(f"/channels/{cid}", json={
        "requesting_email": "bia@example.com", "name": "x", "description": "",
    }).status_code == 403


def test_appointing_per_channel_curators_stays_the_founders(api):
    """The tool for handing ONE channel to a non-curator. A curator may
    run every channel; they may not hand one out."""
    _db, _main, client = api
    _make_general_curator(_db, "ana@example.com")
    cid = _channel(client)
    r = client.post(f"/channels/{cid}/curators",
                    json={"requesting_email": "ana@example.com", "google_id": "u_bia"})
    assert r.status_code == 403


def test_a_curator_does_not_get_someones_private_crew(api):
    """Every power, over auê's channels. A private crew is its members'
    — for the founder (who is a curator too) as much as for anyone."""
    _db, _main, client = api
    _make_general_curator(_db, "bia@example.com")
    gid = _crew(client, "u_ana")
    assert client.put(f"/channels/{gid}", json={
        "requesting_email": "bia@example.com", "name": "x", "description": "",
    }).status_code == 403
    # Not even told they could: the screen would show edit affordances
    # on a channel they can't touch.
    code = client.get(f"/channels/{gid}?google_id=u_ana").json()["channel"]["invite_code"]
    client.post("/groups/join", json={"google_id": "u_bia", "invite_code": code})
    assert client.get(f"/channels/{gid}?google_id=u_bia").json()["channel"]["can_curate"] is False


# -- 22. a boot must not re-invite followers ----------------------------
#
# The May-2026 invitee backfill ran on every boot and snapshotted group
# members into any event with an empty invitee list — public channels
# included, whose lists are empty on purpose. Every deploy re-invited
# every follower to every channel event.

def test_a_second_boot_does_not_reinvite_followers(api):
    _db, _main, client = api
    cid = _channel(client)
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    ev = _add_to(client, cid, "u_founder")
    assert _db.get_group_event(ev["id"])["extra_invitee_ids"] == []
    _db.init_db()                      # a deploy
    assert _db.get_group_event(ev["id"])["extra_invitee_ids"] == []


def test_a_private_crews_legacy_event_still_gets_its_members(api):
    """The backfill's actual job: a crew event written before invitee
    snapshots existed gets the crew's members on the next boot."""
    _db, _main, client = api
    gid = _crew(client, "u_ana")
    code = client.get(f"/channels/{gid}?google_id=u_ana").json()["channel"]["invite_code"]
    client.post("/groups/join", json={"google_id": "u_bia", "invite_code": code})
    ev = _crew_event(client, gid)
    with _db.get_conn() as conn:
        conn.execute("UPDATE group_events SET extra_invitee_ids = '[]' WHERE id = ?", (ev["id"],))
        conn.commit()
    _db.init_db()
    assert _db.get_group_event(ev["id"])["extra_invitee_ids"] == ["u_bia"]


# -- 23. re-adding to a public channel does not RSVP the curator ------

def test_re_adding_the_same_event_to_a_channel_does_not_rsvp(api):
    """The dedup branch of POST /groups/{id}/events kept the old
    auto-RSVP. Three duplicate handles in the rebuild went through it."""
    _db, _main, client = api
    cid = _channel(client)
    first = _add_to(client, cid, "u_founder")
    again = _add_to(client, cid, "u_founder")
    assert again["id"] == first["id"]
    with _db.get_conn() as conn:
        assert conn.execute("SELECT 1 FROM rsvps WHERE google_id = ? AND event_id = ?",
                            ("u_founder", first["id"])).fetchone() is None


def test_re_adding_to_a_private_crew_still_rsvps_the_creator(api):
    _db, _main, client = api
    gid = _crew(client, "u_ana")
    first = _add_to(client, gid, "u_ana")
    _add_to(client, gid, "u_ana")
    with _db.get_conn() as conn:
        assert conn.execute("SELECT 1 FROM rsvps WHERE google_id = ? AND event_id = ?",
                            ("u_ana", first["id"])).fetchone() is not None
