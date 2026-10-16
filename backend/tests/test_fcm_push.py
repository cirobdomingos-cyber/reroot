"""
Tests for the Android push channel (FCM HTTP v1).

Context (Oct 2026): the Android app (app.aue) had no push because the
backend only knew APNs and Web Push. Device tokens now carry a platform
and Android ones go to Firebase Cloud Messaging.

What must hold:
  1. Registering a token stores its platform; omitted = 'ios' (old
     clients), and old rows default to 'ios' after the migration.
  2. The FCM request is the v1 shape: project id from the service
     account, bearer access token, url/tag in `data`, high priority.
  3. The access token is minted once and reused until near expiry.
  4. UNREGISTERED / INVALID_ARGUMENT / 404 delete the token; a
     transient error keeps it.
  5. FIREBASE_SERVICE_ACCOUNT_B64 unset skips Android tokens and never
     raises.
  6. Fan-out: Android tokens go to FCM only, iOS tokens to APNs only,
     for per-user pushes and for the weekly digest.
"""
import asyncio
import base64
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "tests"))

from _session import SessionClient, bearer  # noqa: E402


def _service_account_b64() -> str:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    info = {
        "type": "service_account", "project_id": "aue-test",
        "client_email": "fcm@aue-test.iam.gserviceaccount.com",
        "private_key": pem, "token_uri": "https://oauth2.googleapis.com/token",
    }
    return base64.b64encode(json.dumps(info).encode()).decode()


class FakeResp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body or {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeHttp:
    """Stands in for httpx.Client: records posts, answers the token
    endpoint and the FCM endpoint separately."""
    def __init__(self, fcm_status=200, fcm_body=None):
        self.token_calls, self.sends = [], []
        self.fcm_status, self.fcm_body = fcm_status, fcm_body

    def post(self, url, **kw):
        if "oauth2" in url:
            self.token_calls.append(kw["data"])
            return FakeResp(200, {"access_token": "ya29.fake", "expires_in": 3600})
        self.sends.append((url, kw))
        return FakeResp(self.fcm_status, self.fcm_body)


@pytest.fixture()
def fcm_mod(monkeypatch):
    sys.modules.pop("fcm", None)
    import fcm
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_B64", _service_account_b64())
    http = FakeHttp()
    monkeypatch.setattr(fcm, "_CLIENT", http)
    monkeypatch.setattr(fcm, "_TOKEN_CACHE", None)
    return fcm, http


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main", "fcm"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    for gid in ("u_ana", "u_bia"):
        _db.upsert_user_state(gid, {"userName": gid})
    return _db, _main


def _platform_of(_db, token):
    with _db.get_conn() as conn:
        row = conn.execute(
            "SELECT platform FROM apns_device_tokens WHERE token = ?", (token,)).fetchone()
    return row["platform"] if row else None


# -- 1. registration stores the platform -----------------------------

def test_registration_stores_the_platform(api):
    _db, main = api
    client = SessionClient(main.app, _db)
    h = bearer(_db, "u_ana")
    for body in (
        {"token": "droid-1", "google_id": "u_ana", "bundle_id": "app.aue", "platform": "android"},
        {"token": "ios-1", "google_id": "u_ana", "bundle_id": "app.aue"},   # old client
    ):
        assert client.post("/push/register-device-token", json=body, headers=h).status_code == 200
    assert _platform_of(_db, "droid-1") == "android"
    assert _platform_of(_db, "ios-1") == "ios"
    bad = client.post("/push/register-device-token", headers=h,
                      json={"token": "x", "google_id": "u_ana", "platform": "palm"})
    assert bad.status_code == 422


def test_migration_defaults_old_rows_to_ios(tmp_path, monkeypatch):
    import sqlite3
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE apns_device_tokens (token TEXT PRIMARY KEY,
        google_id TEXT NOT NULL DEFAULT '', bundle_id TEXT NOT NULL DEFAULT '',
        env TEXT NOT NULL DEFAULT 'production', created_at TEXT NOT NULL)""")
    conn.execute("INSERT INTO apns_device_tokens VALUES ('old','u_ana','app.aue','production','x')")
    conn.commit()
    conn.close()
    monkeypatch.setenv("DB_PATH", str(path))
    sys.modules.pop("database", None)
    import database as _db
    _db.init_db()
    _db.init_db()  # idempotent
    assert _platform_of(_db, "old") == "ios"
    assert [t["token"] for t in _db.get_apns_tokens_for_user("u_ana")] == ["old"]
    assert _db.get_apns_tokens_for_user("u_ana", platform="android") == []


# -- 2/3. request shape and token cache ------------------------------

def test_payload_shape_and_endpoint(fcm_mod):
    fcm, http = fcm_mod
    ok, reason = fcm.send_to_token("tok-1", "Título", "Corpo", url="/#/e/1", tag="weekly-digest")
    assert (ok, reason) == (True, None)
    url, kw = http.sends[0]
    assert url == "https://fcm.googleapis.com/v1/projects/aue-test/messages:send"
    assert kw["headers"]["authorization"] == "Bearer ya29.fake"
    msg = kw["json"]["message"]
    assert msg["token"] == "tok-1"
    assert msg["notification"] == {"title": "Título", "body": "Corpo"}
    assert msg["data"] == {"url": "/#/e/1", "tag": "weekly-digest"}
    assert msg["android"]["priority"] == "HIGH"
    assert msg["android"]["notification"]["channel_id"] == "default"


def test_access_token_is_minted_once_and_reused(fcm_mod):
    fcm, http = fcm_mod
    fcm.send_to_token("a", "t", "b")
    fcm.send_to_token("b", "t", "b")
    assert len(http.token_calls) == 1
    grant = http.token_calls[0]
    assert grant["grant_type"].endswith("jwt-bearer")
    header, claims, _sig = grant["assertion"].split(".")
    pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
    assert json.loads(base64.urlsafe_b64decode(pad(claims)))["scope"].endswith("firebase.messaging")
    # near expiry: minted again
    fcm._TOKEN_CACHE = ("old", __import__("time").time() + 30)
    fcm.send_to_token("c", "t", "b")
    assert len(http.token_calls) == 2


# -- 4. dead tokens ---------------------------------------------------

@pytest.mark.parametrize("status,body,dead", [
    (404, {"error": {"status": "UNREGISTERED"}}, True),
    (400, {"error": {"status": "INVALID_ARGUMENT"}}, True),
    (404, {}, True),
    (503, {"error": {"status": "UNAVAILABLE"}}, False),
])
def test_dead_tokens_are_deleted_and_transient_errors_kept(api, monkeypatch, status, body, dead):
    _db, main = api
    sys.modules.pop("fcm", None)
    import fcm
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_B64", _service_account_b64())
    monkeypatch.setattr(fcm, "_CLIENT", FakeHttp(status, body))
    monkeypatch.setattr(fcm, "_TOKEN_CACHE", None)
    _db.upsert_apns_token("droid-1", "u_ana", "app.aue", platform="android")
    sent = main._send_fcm_to_user("u_ana", "t", "b", "/", "x")
    assert sent == 0
    assert (_platform_of(_db, "droid-1") is None) is dead


# -- 5. unconfigured --------------------------------------------------

def test_missing_env_skips_without_raising(api, monkeypatch):
    _db, main = api
    monkeypatch.delenv("FIREBASE_SERVICE_ACCOUNT_B64", raising=False)
    import fcm
    monkeypatch.setattr(fcm, "_CLIENT", None)  # a real client would be a bug here
    _db.upsert_apns_token("droid-1", "u_ana", "app.aue", platform="android")
    assert main._send_fcm_to_user("u_ana", "t", "b", "/", "x") == 0
    assert _platform_of(_db, "droid-1") == "android"   # kept, not deleted
    monkeypatch.setenv("FIREBASE_SERVICE_ACCOUNT_B64", "not-base64-json")
    assert fcm.send_to_token("x", "t", "b") == (False, "FCM not configured")


# -- 6. fan-out routing -----------------------------------------------

@pytest.fixture()
def senders(api, monkeypatch):
    """Record what APNs and FCM each receive."""
    _db, main = api
    apns_calls, fcm_calls = [], []
    import apns
    import fcm
    monkeypatch.setattr(apns, "send_to_token",
                        lambda tok, *a, **kw: (apns_calls.append(tok), (True, None))[1])
    monkeypatch.setattr(apns, "_is_configured", lambda: True)
    monkeypatch.setattr(fcm, "send_to_token",
                        lambda tok, *a, **kw: (fcm_calls.append(tok), (True, None))[1])
    monkeypatch.setattr(fcm, "_is_configured", lambda: True)
    _db.upsert_apns_token("ios-1", "u_ana", "app.aue", platform="ios")
    _db.upsert_apns_token("droid-1", "u_ana", "app.aue", platform="android")
    return apns_calls, fcm_calls


def test_per_user_push_routes_by_platform(api, senders):
    _db, main = api
    apns_calls, fcm_calls = senders
    assert main._send_push_to_user("u_ana", "t", "b") == 2
    assert apns_calls == ["ios-1"]
    assert fcm_calls == ["droid-1"]


def test_weekly_digest_routes_by_platform(api, senders):
    _db, main = api
    apns_calls, fcm_calls = senders
    from models import EnrichedEvent
    when = datetime.now(timezone.utc) + timedelta(days=3)
    _db.upsert_event(EnrichedEvent(
        id="instagram_a", source="instagram", external_id="a", name="Show", description="d",
        venue_name="Bar", venue_address="", neighborhood="Batel", city="Curitiba",
        date_start=when, date_end=None, price_min=0.0, price_max=0.0, currency="BRL",
        capacity=None, kind="community", category_label="C", category_emoji="C",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="", price_tier="free",
        vibe_summary="", expected_size="medium", header_gradient="g", url="u", image_url=None,
        fetched_at=datetime.now(timezone.utc), genre="",
    ))
    with _db.get_conn() as conn:
        conn.execute("INSERT INTO daily_digests (id, event_ids, created_at) VALUES (?,?,?)",
                     ("d1", json.dumps(["instagram_a"]), datetime.now(timezone.utc).isoformat()))
        conn.commit()
    out = asyncio.run(main.send_weekly_digest())
    assert out["sent"] == 2
    assert apns_calls == ["ios-1"] and fcm_calls == ["droid-1"]
