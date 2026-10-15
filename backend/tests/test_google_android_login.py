"""
Tests for the Android Google sign-in through the system browser:
GET /auth/google/android/start, GET .../callback, POST .../ticket.

What must hold:
  1. start redirects to Google with the WEB client, the callback URL built
     from the request's forwarded origin, the code flow and a signed state.
  2. callback refuses a missing/forged/expired state, never creates a user
     for a refused code or token, and on success bounces to app.aue://auth
     with a ticket.
  3. a ticket buys the same JSON /auth/google returns, exactly once, and
     not after 60 seconds.
  4. without GOOGLE_WEB_CLIENT_SECRET every leg that needs it answers 503.

The Google token endpoint is stubbed (exchange_google_code); the ID token is
signed for real with a throwaway key so the shared verifier runs unchanged.
"""
import base64
import json
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

WEB_CLIENT = "511485926685-9a6hihg5dn4g4qtdgs4c6i2tjscih2m6.apps.googleusercontent.com"
KID = "test-kid"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
SUB = "55501234"
HEADERS = {"x-forwarded-proto": "https", "x-forwarded-host": "auecuritiba.com"}
CALLBACK = "https://auecuritiba.com/auth/google/android/callback"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_token(**overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": "https://accounts.google.com", "aud": WEB_CLIENT,
        "sub": SUB, "email": "bia@gmail.com", "email_verified": True,
        "name": "Bia Souza", "given_name": "Bia", "picture": "https://lh3/bia.jpg",
        "iat": now, "exp": now + 3600,
    }
    claims.update(overrides)
    header = _b64(json.dumps({"alg": "RS256", "kid": KID, "typ": "JWT"}).encode())
    payload = _b64(json.dumps(claims).encode())
    sig = KEY.sign(f"{header}.{payload}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{_b64(sig)}"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("GOOGLE_WEB_CLIENT_SECRET", "test-secret")
    monkeypatch.delenv("GOOGLE_WEB_CLIENT_ID", raising=False)
    for mod in ("database", "main", "enrichment", "google_id_token"):
        sys.modules.pop(mod, None)
    import database as _db
    import google_id_token
    import main as _main
    _db.init_db()
    monkeypatch.setattr(google_id_token, "_public_key_for_kid",
                        lambda kid: KEY.public_key() if kid == KID else None)
    exchanges = []

    def fake_exchange(code, redirect_uri):
        exchanges.append((code, redirect_uri))
        return make_token() if code == "good-code" else None

    monkeypatch.setattr(_main, "exchange_google_code", fake_exchange)
    from fastapi.testclient import TestClient
    client = TestClient(_main.app, follow_redirects=False)
    return _db, _main, client, exchanges


def _state(client) -> str:
    loc = client.get("/auth/google/android/start", headers=HEADERS).headers["location"]
    return parse_qs(urlparse(loc).query)["state"][0]


def _callback(client, code="good-code", state=None, **extra):
    params = {"code": code, "state": state if state is not None else _state(client), **extra}
    return client.get("/auth/google/android/callback", params=params, headers=HEADERS)


def _app_params(resp) -> dict:
    assert resp.status_code == 302
    loc = resp.headers["location"]
    assert loc.startswith("app.aue://auth?"), loc
    return {k: v[0] for k, v in parse_qs(urlparse(loc).query).items()}


# ── start ──

def test_start_redirects_to_google_with_the_web_client(api):
    _, _, client, _ = api
    r = client.get("/auth/google/android/start", headers=HEADERS)
    assert r.status_code == 302
    url = urlparse(r.headers["location"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://accounts.google.com/o/oauth2/v2/auth"
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert q["client_id"] == WEB_CLIENT
    assert q["redirect_uri"] == CALLBACK
    assert q["response_type"] == "code"
    assert q["scope"] == "openid email profile"
    assert q["prompt"] == "select_account"
    assert len(q["state"]) > 20


def test_start_state_is_different_every_time(api):
    _, _, client, _ = api
    assert _state(client) != _state(client)


def test_start_without_secret_is_503(api, monkeypatch):
    _, main, client, _ = api
    monkeypatch.setattr(main.settings, "google_web_client_secret", "")
    assert client.get("/auth/google/android/start", headers=HEADERS).status_code == 503


# ── callback ──

def test_callback_success_hands_a_ticket_to_the_app(api):
    db, _, client, exchanges = api
    params = _app_params(_callback(client))
    assert set(params) == {"ticket"} and len(params["ticket"]) >= 32
    assert exchanges == [("good-code", CALLBACK)]
    # The account exists, but no session is open until the ticket is redeemed.
    assert db.get_user_id_for_provider("google", SUB) == SUB


@pytest.mark.parametrize("state", ["", "garbage", "a.9999999999.deadbeef"])
def test_callback_refuses_a_bad_state(api, state):
    db, _, client, exchanges = api
    r = client.get("/auth/google/android/callback",
                   params={"code": "good-code", "state": state}, headers=HEADERS)
    assert _app_params(r) == {"error": "bad_state"}
    assert exchanges == []
    assert db.get_user_profile(SUB) is None


def test_callback_refuses_an_expired_state(api, monkeypatch):
    db, main, client, exchanges = api
    state = _state(client)
    real = time.time
    monkeypatch.setattr(main.time, "time", lambda: real() + main._ANDROID_STATE_TTL_S + 5)
    assert _app_params(_callback(client, state=state)) == {"error": "bad_state"}
    assert exchanges == []


def test_callback_user_cancelled(api):
    _, _, client, exchanges = api
    r = client.get("/auth/google/android/callback",
                   params={"error": "access_denied", "state": _state(client)}, headers=HEADERS)
    assert _app_params(r) == {"error": "cancelled"}
    assert exchanges == []


def test_callback_code_refused_by_google(api):
    db, _, client, _ = api
    assert _app_params(_callback(client, code="bad-code")) == {"error": "exchange_failed"}
    assert db.get_user_profile(SUB) is None


@pytest.mark.parametrize("overrides,error", [
    ({"aud": "someone-else.apps.googleusercontent.com"}, "invalid_token"),
    ({"iss": "https://evil.example.com"}, "invalid_token"),
    ({"email_verified": False}, "email_unverified"),
])
def test_callback_bad_id_token_creates_nobody(api, monkeypatch, overrides, error):
    db, main, client, _ = api
    monkeypatch.setattr(main, "exchange_google_code", lambda c, r: make_token(**overrides))
    assert _app_params(_callback(client)) == {"error": error}
    assert db.get_user_profile(SUB) is None


def test_callback_without_secret_is_503(api, monkeypatch):
    _, main, client, _ = api
    state = _state(client)
    monkeypatch.setattr(main.settings, "google_web_client_secret", "")
    assert _callback(client, state=state).status_code == 503


# ── ticket ──

def test_ticket_returns_the_same_json_as_auth_google(api):
    db, _, client, _ = api
    ticket = _app_params(_callback(client))["ticket"]
    r = client.post("/auth/google/android/ticket", json={"ticket": ticket})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"user_id", "display_name", "given_name", "email",
                         "picture", "is_new_user", "token"}
    assert body["user_id"] == SUB
    assert (body["display_name"], body["given_name"], body["email"]) == ("Bia Souza", "Bia", "bia@gmail.com")
    assert body["is_new_user"] is True
    assert db.resolve_session(body["token"]) == SUB


def test_ticket_is_single_use(api):
    _, _, client, _ = api
    ticket = _app_params(_callback(client))["ticket"]
    assert client.post("/auth/google/android/ticket", json={"ticket": ticket}).status_code == 200
    again = client.post("/auth/google/android/ticket", json={"ticket": ticket})
    assert again.status_code == 400


def test_ticket_expires_after_60_seconds(api, monkeypatch):
    db, _, client, _ = api
    ticket = _app_params(_callback(client))["ticket"]
    real_now = db.datetime.now
    class Later(db.datetime):
        @classmethod
        def now(cls, tz=None):
            return real_now(tz) + db.timedelta(seconds=db.LOGIN_TICKET_TTL_S + 1)
    monkeypatch.setattr(db, "datetime", Later)
    assert client.post("/auth/google/android/ticket", json={"ticket": ticket}).status_code == 400


@pytest.mark.parametrize("ticket", ["", "nope", "x" * 43])
def test_unknown_ticket_is_400(api, ticket):
    _, _, client, _ = api
    assert client.post("/auth/google/android/ticket", json={"ticket": ticket}).status_code == 400


def test_second_sign_in_is_not_a_new_user(api):
    _, _, client, _ = api
    for expected_new in (True, False):
        ticket = _app_params(_callback(client))["ticket"]
        body = client.post("/auth/google/android/ticket", json={"ticket": ticket}).json()
        assert body["is_new_user"] is expected_new
