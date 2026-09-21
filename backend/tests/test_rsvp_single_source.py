"""
RSVPs have one source of truth: the rsvps table. The user-state blob
used to carry its own map, written by the client on every save and
never reconciled — which is how a "vou" could be invisible to you and
visible to everyone else.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    from fastapi.testclient import TestClient
    return TestClient(_main.app)


BASE_STATE = {"hasJoined": True, "language": "pt", "rsvps": {}}


def _rsvp(client, event_id="ev_1", name="Show Pitty"):
    r = client.post("/rsvp", json={
        "google_id": "u_ana", "event_id": event_id, "event_name": name,
        "event_venue": "Igloo", "event_date": "2099-10-14T19:00:00", "event_url": "",
    })
    assert r.status_code == 200, r.text


def _state(client):
    return client.get("/user/state/u_ana").json()["state"]


def test_the_state_carries_what_the_table_has(client):
    client.post("/user/state", json={"google_id": "u_ana", "state": BASE_STATE})
    _rsvp(client)
    got = _state(client)["rsvps"]
    assert got == {"ev_1": {"dateStart": "2099-10-14T19:00:00", "name": "Show Pitty", "venue": "Igloo"}}


def test_a_blob_cannot_claim_an_rsvp_the_table_lacks(client):
    """The stale-device case: a save arrives carrying an RSVP the server
    already removed. It must not come back."""
    client.post("/user/state", json={"google_id": "u_ana", "state": {
        **BASE_STATE, "rsvps": {"ghost": {"dateStart": "2099-01-01", "name": "Fantasma", "venue": ""}},
    }})
    assert _state(client)["rsvps"] == {}


def test_deleting_the_rsvp_deletes_it_from_the_state_too(client):
    client.post("/user/state", json={"google_id": "u_ana", "state": BASE_STATE})
    _rsvp(client)
    assert "ev_1" in _state(client)["rsvps"]
    assert client.delete("/rsvp/ev_1?google_id=u_ana").status_code == 200
    assert _state(client)["rsvps"] == {}


def test_the_rest_of_the_state_is_untouched(client):
    client.post("/user/state", json={"google_id": "u_ana", "state": {**BASE_STATE, "userName": "Beduschi"}})
    st = _state(client)
    assert st["userName"] == "Beduschi"
    assert st["hasJoined"] is True
