"""
GET /channels/feed is read by Eventos as a lookup — which catalog rows
come from a channel you follow — so it has to be complete.

Context (23 Sep 2026): the default limit was 40, capped at 100, from
when the feed drew a horizontal band. Once the rule fill put ~30 nights
into each channel, following three of them overflowed the cap and every
row past it lost its "Dos teus canais" mark — reported as "muito evento
não aparece como taggado".

What must hold:
  1. Following channels that together hold more than the old cap
     returns every one of their upcoming events.
  2. The client's limit is honoured up to a sane ceiling.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

FOUNDER = "founder@example.com"
SOON = datetime.now(timezone.utc) + timedelta(days=5)


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


def test_the_feed_is_not_truncated_at_the_old_cap(api):
    _db, _main, client = api
    ids = []
    for name in ("auê Rock", "auê Eletrônica", "auê Cultura"):
        r = client.post("/admin/channels", json={"requesting_email": FOUNDER, "name": name})
        ids.append(r.json()["channel"]["id"])
        client.post(f"/channels/{ids[-1]}/follow", json={"google_id": "u_ana"})
    n = 0
    for gid in ids:
        for _ in range(45):   # 135 in total: past 40, past 100
            n += 1
            _db.create_group_event(group_id=gid, google_id="u_founder", name=f"Noite {n}",
                                   date_start=SOON.isoformat(), source_event_id=f"instagram_{n}")
    r = client.get("/channels/feed?google_id=u_ana")
    assert r.status_code == 200
    assert len(r.json()["events"]) == 135


def test_the_client_limit_is_honoured_up_to_the_ceiling(api):
    _db, _main, client = api
    r = client.post("/admin/channels", json={"requesting_email": FOUNDER, "name": "auê Rock"})
    gid = r.json()["channel"]["id"]
    client.post(f"/channels/{gid}/follow", json={"google_id": "u_ana"})
    for i in range(12):
        _db.create_group_event(group_id=gid, google_id="u_founder", name=f"Noite {i}",
                               date_start=SOON.isoformat(), source_event_id=f"instagram_{i}")
    assert len(client.get("/channels/feed?google_id=u_ana&limit=5").json()["events"]) == 5
    assert len(client.get("/channels/feed?google_id=u_ana&limit=5000").json()["events"]) == 12
