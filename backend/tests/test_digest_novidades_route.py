"""
Tests for the /novidades/:digestId deep link (docs/NEXT.md item 3).

Context: the digest push used to send ?digest=<id> as a query string on
/events, which the app stripped from the URL the moment it read it — so a
refresh, or reopening an old notification, lost the filtered view entirely.
/#/novidades/<id> replaces that with a route param that survives a refresh.

Rollout is sequenced: old installed bundles have no route for /novidades,
so the backend keeps sending the old URL until DIGEST_URL_NOVIDADES=true is
set (after the OTA carrying the new route has had time to reach devices).

What must hold:
  1. Default (env unset) still sends the old ?digest= URL.
  2. DIGEST_URL_NOVIDADES=true switches to /#/novidades/<id>.
  3. GET /digests/latest returns the most recently inserted digest.
  4. GET /digests/latest 404s when no digest has ever been sent — and is
     not swallowed by the /digests/{digest_id} route (a literal digest
     named "latest" is not a real case, but the route order must still
     resolve to the dedicated handler).
"""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.delenv("DIGEST_URL_NOVIDADES", raising=False)
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def test_default_url_is_the_old_query_param(api):
    _db, main, _client = api
    assert main._digest_deep_link("d_123") == "/#/events?digest=d_123"


def test_flag_switches_to_the_route_param(api, monkeypatch):
    _db, main, _client = api
    monkeypatch.setenv("DIGEST_URL_NOVIDADES", "true")
    assert main._digest_deep_link("d_123") == "/#/novidades/d_123"


def test_flag_is_case_and_whitespace_tolerant(api, monkeypatch):
    _db, main, _client = api
    monkeypatch.setenv("DIGEST_URL_NOVIDADES", " True ")
    assert main._digest_deep_link("d_123") == "/#/novidades/d_123"


def test_anything_else_keeps_the_old_url(api, monkeypatch):
    _db, main, _client = api
    monkeypatch.setenv("DIGEST_URL_NOVIDADES", "1")
    assert main._digest_deep_link("d_123") == "/#/events?digest=d_123"


def test_latest_digest_is_404_when_none_sent_yet(api):
    _db, _main, client = api
    res = client.get("/digests/latest")
    assert res.status_code == 404


def test_latest_digest_returns_the_most_recent(api):
    db, _main, client = api
    db.insert_daily_digest("d_20260916T090000", ["ev1", "ev2"])
    db.insert_daily_digest("d_20260916T140000", ["ev3"])
    res = client.get("/digests/latest")
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == "d_20260916T140000"
    assert body["event_ids"] == ["ev3"]


def test_a_known_digest_id_still_resolves_normally(api):
    db, _main, client = api
    db.insert_daily_digest("d_20260916T090000", ["ev1"])
    res = client.get("/digests/d_20260916T090000")
    assert res.status_code == 200
    assert res.json()["event_ids"] == ["ev1"]


def test_unknown_digest_id_404s(api):
    _db, _main, client = api
    res = client.get("/digests/d_does_not_exist")
    assert res.status_code == 404
