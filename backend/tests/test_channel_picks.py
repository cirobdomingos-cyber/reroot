"""
Tests for GET /channels/picks — which public channels hold which catalog
event, the "📡 auê Rock" mark on a row in Eventos.

Context (23 Sep 2026): the mark used to be read off /channels/feed,
which is capped at 40 and knows only the channels the viewer follows.
Once the rule fill put ~150 nights into channels, most rows lost their
mark, and a channel with no followers yet marked nothing at all — which
read as "the events aren't tagged".

What must hold:
  1. Every public channel, for every viewer — signed in or not, follower
     or not. Which channel a night sits in is as public as the channel.
  2. A private crew's forks never appear: that would name a private
     channel to strangers.
  3. Upcoming only, one entry per channel, and both channels when two
     picked the same night.
  4. Not capped: the whole catalog's worth comes back.
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
            (FOUNDER, "system", now, "test"),
        )
        for uid, email in (("u_founder", FOUNDER), ("u_ana", "ana@example.com")):
            conn.execute(
                "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
                " VALUES (?,?,?,?,?)",
                (uid, uid, email, "", now),
            )
        conn.commit()
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _channel(client, name):
    r = client.post("/admin/channels", json={"requesting_email": FOUNDER, "name": name})
    assert r.status_code == 200, r.text
    return r.json()["channel"]["id"]


def _fork(_db, gid, src, when=SOON, by="u_founder"):
    return _db.create_group_event(group_id=gid, google_id=by, name=src,
                                  date_start=when.isoformat(), source_event_id=src)["id"]


def test_every_public_channel_for_every_viewer(api):
    _db, _main, client = api
    rock = _channel(client, "auê Rock")
    comedia = _channel(client, "auê Comédia")
    _fork(_db, rock, "instagram_a")
    _fork(_db, comedia, "instagram_b")
    # Nobody follows anything, and the caller is anonymous.
    r = client.get("/channels/picks")
    assert r.status_code == 200
    assert r.json()["picks"] == {"instagram_a": ["auê Rock"], "instagram_b": ["auê Comédia"]}


def test_a_private_crew_is_never_named(api):
    _db, _main, client = api
    crew = client.post("/groups", json={"google_id": "u_ana", "name": "Rolê do Sax"}).json()
    gid = crew.get("id") or crew.get("group", {}).get("id")
    _fork(_db, gid, "instagram_a", by="u_ana")
    assert client.get("/channels/picks").json()["picks"] == {}


def test_upcoming_only_and_both_channels_when_two_picked_the_night(api):
    _db, _main, client = api
    rock = _channel(client, "auê Rock")
    pista = _channel(client, "auê Eletrônica")
    _fork(_db, rock, "instagram_a")
    _fork(_db, pista, "instagram_a")
    _fork(_db, rock, "instagram_old", when=PAST)
    picks = client.get("/channels/picks").json()["picks"]
    assert picks == {"instagram_a": ["auê Eletrônica", "auê Rock"]}


def test_not_capped(api):
    _db, _main, client = api
    rock = _channel(client, "auê Rock")
    for i in range(60):
        _fork(_db, rock, f"instagram_{i}")
    assert len(client.get("/channels/picks").json()["picks"]) == 60
