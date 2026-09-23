"""
Tests for channel rules — the scrape fills a channel.

Context (23 Sep 2026): eight auê channels were hand-filled, and the
catalog they drew from grew by ~50 events a day. A channel is "a saved
query with a name and the right to notify" (docs/NEXT.md); this makes
the query real. A rule is a set of event tipos and/or genres; the two
axes AND together, values within an axis OR together.

What must hold:
  1. A channel with a rule opens full: every upcoming, curated, matching
     catalog event is forked in. Past, uncurated and non-matching stay
     out. The fill is idempotent.
  2. Both axes together mean AND. No rule at all means hand-filled.
  3. A rule outside the closed vocabularies is refused, naming the word.
  4. Pulling an event out of a channel is a decision: the next fill
     leaves it out. A channel's curators may pull auto-filled forks
     (owned by auê); a follower may not.
  5. Re-tagging a catalog event by hand puts it in its channel now.
  6. Merging channels carries followers and events over, and drops a
     fork the target already holds rather than duplicating it.
  7. Rebalance moves a misfiled fork to the one rule channel it fits.
  8. The scrape's tag backfill feeds the fill, and followers get one
     push per channel per run, never one per event.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

FOUNDER = "founder@example.com"
SOON = datetime.now(timezone.utc) + timedelta(days=5)
PAST = datetime.now(timezone.utc) - timedelta(days=5)


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("FOUNDER_EMAIL", FOUNDER)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-used")
    for mod in ("database", "main", "enrichment"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO curators (email, added_by_email, added_at, notes,"
            " is_founder, is_curator, is_feedbacker) VALUES (?,?,?,?,1,1,1)",
            (FOUNDER, "system", now, "test"),
        )
        for uid, email in (("u_founder", FOUNDER),
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


def _event(_db, ev_id, *, tipo="", genre="", when=SOON, curated=True, name="Noite"):
    from models import EnrichedEvent
    _db.upsert_event(EnrichedEvent(
        id=ev_id, source="instagram", external_id=ev_id.split("_", 1)[1],
        name=name, description="desc", venue_name="Bar X", venue_address="",
        neighborhood="Batel", city="Curitiba",
        date_start=when, date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="C",
        has_food=False, is_low_pressure=False, is_curated=curated, pitch="",
        price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="g", url="https://www.instagram.com/p/abc/",
        image_url="/event-images/x.jpg",
        fetched_at=datetime.now(timezone.utc), genre=genre, tipo=tipo,
    ))


def _channel(client, name, tipos=(), genres=()):
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": name,
        "rule_tipos": list(tipos), "rule_genres": list(genres),
    })
    assert r.status_code == 200, r.text
    return r.json()


def _sources_in(_db, cid):
    return sorted(e["source_event_id"] for e in _db.get_group_events(cid))


# -- 1. a channel with a rule opens full -----------------------------

def test_rule_matches_semantics(api):
    _db, _main, _client = api
    m = _db.rule_matches
    assert m(["comedia"], [], "comedia", "") is True
    assert m(["comedia"], [], "show", "") is False
    assert m([], ["rock"], "show", "rock") is True
    assert m([], ["rock"], "show", "") is False
    # Both axes: AND.
    assert m(["festa"], ["eletronica"], "festa", "eletronica") is True
    assert m(["festa"], ["eletronica"], "show", "eletronica") is False
    assert m(["festa"], ["eletronica"], "festa", "rock") is False
    # No rule: hand-filled, never matches.
    assert m([], [], "comedia", "rock") is False


def test_a_channel_with_a_rule_opens_full(api):
    _db, _main, client = api
    _event(_db, "instagram_ig_club_1", tipo="comedia")
    _event(_db, "instagram_ig_club_2", tipo="comedia", when=PAST)
    _event(_db, "instagram_ig_club_3", tipo="show")
    _event(_db, "instagram_ig_club_4", tipo="comedia", curated=False)
    created = _channel(client, "auê Comédia", tipos=["comedia"])
    assert created["added"] == 1
    cid = created["channel"]["id"]
    assert _sources_in(_db, cid) == ["instagram_ig_club_1"]
    fork = _db.get_group_events(cid)[0]
    assert fork["created_by"] == "u_founder"
    assert fork["source_ig_handle"] == "club"
    assert fork["extra_invitee_ids"] == []


def test_the_fill_is_idempotent(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="comedia")
    cid = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    assert _db.route_catalog_events_to_channels() == {}
    assert len(_db.get_group_events(cid)) == 1


def test_a_new_event_arrives_at_the_next_fill(api):
    _db, _main, client = api
    cid = _channel(client, "auê Rock", genres=["rock"])["channel"]["id"]
    _event(_db, "instagram_a", tipo="show", genre="rock")
    _event(_db, "instagram_b", tipo="festa", genre="rock")
    _event(_db, "instagram_c", tipo="show", genre="mpb")
    assert _db.route_catalog_events_to_channels() == {cid: 2}
    assert _sources_in(_db, cid) == ["instagram_a", "instagram_b"]


# -- 2. both axes, and no rule ---------------------------------------

def test_both_axes_mean_and(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="festa", genre="eletronica")
    _event(_db, "instagram_b", tipo="show", genre="eletronica")
    _event(_db, "instagram_c", tipo="festa", genre="rock")
    created = _channel(client, "auê Pista", tipos=["festa"], genres=["eletronica"])
    assert _sources_in(_db, created["channel"]["id"]) == ["instagram_a"]


def test_a_channel_without_a_rule_is_never_filled(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="comedia")
    created = _channel(client, "auê Mão")
    assert created["added"] == 0
    assert _db.route_catalog_events_to_channels() == {}


def test_rules_come_back_as_lists(api):
    _db, _main, client = api
    _channel(client, "auê Pista", tipos=["festa"], genres=["eletronica", "rock"])
    ch = client.get("/channels").json()["channels"][0]
    assert ch["rule_tipos"] == ["festa"]
    assert ch["rule_genres"] == ["eletronica", "rock"]
    detail = client.get(f"/channels/{ch['id']}").json()["channel"]
    assert detail["rule_tipos"] == ["festa"]


# -- 3. vocabulary ---------------------------------------------------

def test_an_invalid_rule_is_refused_by_name(api):
    _db, _main, client = api
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê X", "rule_tipos": ["balada"],
    })
    assert r.status_code == 400
    assert "balada" in r.json()["detail"]
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê X", "rule_genres": ["axé"],
    })
    assert r.status_code == 400


def test_a_rule_written_later_fills_now(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="teatro")
    cid = _channel(client, "auê Cultura")["channel"]["id"]
    r = client.put(f"/channels/{cid}", json={
        "requesting_email": FOUNDER, "rule_tipos": ["Teatro", "cinema"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["added"] == 1
    assert r.json()["channel"]["rule_tipos"] == ["teatro", "cinema"]


# -- 4. pulling is a decision ----------------------------------------

def test_a_pulled_event_stays_out(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="comedia")
    cid = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    fork = _db.get_group_events(cid)[0]
    r = client.delete(f"/groups/{cid}/events/{fork['id']}?google_id=u_founder")
    assert r.status_code == 200, r.text
    assert _db.route_catalog_events_to_channels() == {}
    assert _db.get_group_events(cid) == []
    assert _db.excluded_source_ids(cid) == {"instagram_a"}


def test_a_channel_curator_can_pull_an_auto_fork_a_follower_cannot(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="comedia")
    cid = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    fork = _db.get_group_events(cid)[0]
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_bia"})
    assert client.delete(
        f"/groups/{cid}/events/{fork['id']}?google_id=u_bia"
    ).status_code == 403
    _db.add_channel_curator(cid, "u_ana")
    assert client.delete(
        f"/groups/{cid}/events/{fork['id']}?google_id=u_ana"
    ).status_code == 200
    assert _db.get_group_events(cid) == []


def test_unlinking_from_a_channel_also_excludes(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="comedia")
    cid = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    # The sheet only knows the catalog id; the endpoint resolves the fork.
    r = client.delete(f"/events/instagram_a/groups/{cid}?google_id=u_founder")
    assert r.status_code == 200, r.text
    assert _db.excluded_source_ids(cid) == {"instagram_a"}
    assert _db.route_catalog_events_to_channels() == {}


# -- 5. a hand re-tag lands now --------------------------------------

def test_a_retag_adds_the_event_to_its_channel(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="")
    cid = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    assert _db.get_group_events(cid) == []
    r = client.patch("/admin/events/instagram_a",
                     json={"requesting_email": FOUNDER, "tipo": "comedia"})
    assert r.status_code == 200, r.text
    assert _sources_in(_db, cid) == ["instagram_a"]
    r = client.patch("/admin/events/instagram_a",
                     json={"requesting_email": FOUNDER, "tipo": "balada"})
    assert r.status_code == 400


# -- 6. merge --------------------------------------------------------

def test_merge_carries_followers_and_events_and_drops_duplicates(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="comedia")
    _event(_db, "instagram_b", tipo="teatro")
    a = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    b = _channel(client, "auê Cultura", tipos=["comedia", "teatro"])["channel"]["id"]
    assert _sources_in(_db, b) == ["instagram_a", "instagram_b"]
    client.post(f"/channels/{a}/follow", json={"google_id": "u_ana"})
    client.post(f"/channels/{b}/follow", json={"google_id": "u_bia"})
    r = client.post(f"/admin/channels/{a}/merge-into/{b}?requesting_email={FOUNDER}")
    assert r.status_code == 200, r.text
    assert r.json()["events_dropped"] == 1
    channels = client.get("/channels").json()["channels"]
    assert [c["id"] for c in channels] == [b]
    assert channels[0]["follower_count"] == 2
    assert _sources_in(_db, b) == ["instagram_a", "instagram_b"]


def test_merge_carries_exclusions(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="comedia")
    a = _channel(client, "auê A", tipos=["comedia"])["channel"]["id"]
    b = _channel(client, "auê B")["channel"]["id"]
    fork = _db.get_group_events(a)[0]
    client.delete(f"/groups/{a}/events/{fork['id']}?google_id=u_founder")
    client.post(f"/admin/channels/{a}/merge-into/{b}?requesting_email={FOUNDER}")
    client.put(f"/channels/{b}", json={"requesting_email": FOUNDER, "rule_tipos": ["comedia"]})
    assert _db.get_group_events(b) == []


# -- 7. rebalance ----------------------------------------------------

def test_rebalance_moves_a_misfiled_fork(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="teatro")
    a = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    b = _channel(client, "auê Cultura", tipos=["teatro"])["channel"]["id"]
    # A hand-pick into the wrong channel, then the target already has it.
    _db.create_group_event(group_id=a, google_id="u_founder", name="Peça",
                           date_start=SOON.isoformat(), source_event_id="instagram_a")
    r = client.post(f"/admin/channels/rebalance?requesting_email={FOUNDER}")
    assert r.status_code == 200, r.text
    assert r.json()["moved"] == 1 and r.json()["moves"][0]["dropped"] is True
    assert _db.get_group_events(a) == []
    assert _sources_in(_db, b) == ["instagram_a"]


def test_rebalance_moves_when_the_target_lacks_it(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="literatura", when=PAST)  # past: never auto-filled
    a = _channel(client, "auê Cultura", tipos=["teatro"])["channel"]["id"]
    b = _channel(client, "auê Livros", tipos=["literatura"])["channel"]["id"]
    _db.create_group_event(group_id=a, google_id="u_founder", name="Sarau",
                           date_start=PAST.isoformat(), source_event_id="instagram_a")
    moves = _db.rebalance_rule_channels()
    assert len(moves) == 1 and moves[0]["dropped"] is False
    assert _sources_in(_db, a) == [] and _sources_in(_db, b) == ["instagram_a"]


def test_rebalance_leaves_a_hand_pick_that_fits_nowhere_else(api):
    _db, _main, client = api
    _event(_db, "instagram_a", tipo="feira")
    a = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    _db.create_group_event(group_id=a, google_id="u_founder", name="Feira",
                           date_start=SOON.isoformat(), source_event_id="instagram_a")
    assert _db.rebalance_rule_channels() == []
    assert _sources_in(_db, a) == ["instagram_a"]


# -- 8. the pipeline step --------------------------------------------

class _FakePipeline:
    def __init__(self, tipos=None, genres=None):
        self.tipos, self.genres = tipos or {}, genres or {}
        self.asked = []

    def classify_tipos(self, events, batch_size=25):
        self.asked.append(("tipo", [e["id"] for e in events]))
        return {e["id"]: self.tipos[e["id"]] for e in events if e["id"] in self.tipos}

    def classify_genres(self, events, batch_size=25):
        self.asked.append(("genre", [e["id"] for e in events]))
        return {e["id"]: self.genres[e["id"]] for e in events if e["id"] in self.genres}


def test_backfill_tags_then_fill(api):
    _db, main, client = api
    _event(_db, "instagram_a")                       # untagged, upcoming
    _event(_db, "instagram_b", tipo="show", genre="rock")  # already tagged
    _event(_db, "instagram_c", when=PAST)            # past: not worth a call
    cid = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    fake = _FakePipeline(tipos={"instagram_a": "comedia"})
    out = main.backfill_missing_tags(fake)
    assert out["tipo"] == {"considered": 1, "tagged": 1}
    assert out["genre"] == {"considered": 1, "tagged": 0}
    assert [ids for _, ids in fake.asked] == [["instagram_a"], ["instagram_a"]]
    assert _db.get_event_by_id("instagram_a").tipo == "comedia"
    assert _db.get_catalog_edited_fields("instagram_a") == []   # machine fill: not pinned
    assert main.fill_channels_from_catalog() == {"auê Comédia": 1}
    assert _sources_in(_db, cid) == ["instagram_a"]


def test_fill_pushes_once_per_channel_to_followers_only(api, monkeypatch):
    _db, main, client = api
    cid = _channel(client, "auê Comédia", tipos=["comedia"])["channel"]["id"]
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_ana"})
    client.post(f"/channels/{cid}/follow", json={"google_id": "u_bia"})
    client.put(f"/channels/{cid}/notify", json={"google_id": "u_bia", "notify": False})
    sent = []
    monkeypatch.setattr(main, "_send_push_to_user",
                        lambda uid, **kw: sent.append((uid, kw["body"])))
    _event(_db, "instagram_a", tipo="comedia")
    _event(_db, "instagram_b", tipo="comedia")
    assert main.fill_channels_from_catalog() == {"auê Comédia": 2}
    assert sent == [("u_ana", "2 novidades no auê Comédia")]
    # Nothing new, nothing sent.
    sent.clear()
    assert main.fill_channels_from_catalog() == {}
    assert sent == []
