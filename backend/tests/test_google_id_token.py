"""
Tests for Android Google sign-in: /auth/google with an `id_token`.

The Android app gets a Google ID token from Credential Manager instead of
the access token the web and iOS paths hold. What must hold:
  1. A token signed by Google's key, for our web client, not expired and
     with a verified e-mail opens a session.
  2. Wrong audience, expired, wrong issuer, a bad signature or an
     unverified e-mail is a 401 and creates nobody.
  3. The account is keyed on Google's `sub`: someone who signed in on the
     web (access token) lands on the same user when signing in on Android.

Tokens are signed for real with a throwaway RSA key; only the lookup of
Google's public key is replaced, so the signature check itself runs.
"""
import base64
import json
import sys
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

WEB_CLIENT = "511485926685-9a6hihg5dn4g4qtdgs4c6i2tjscih2m6.apps.googleusercontent.com"
KID = "test-kid"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
SUB = "1029384756"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_token(key=KEY, **overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": "https://accounts.google.com", "aud": WEB_CLIENT,
        "azp": "511485926685-android.apps.googleusercontent.com",
        "sub": SUB, "email": "bia@gmail.com", "email_verified": True,
        "name": "Bia Souza", "given_name": "Bia", "picture": "https://lh3/bia.jpg",
        "iat": now, "exp": now + 3600,
    }
    claims.update(overrides)
    header = _b64(json.dumps({"alg": "RS256", "kid": KID, "typ": "JWT"}).encode())
    payload = _b64(json.dumps(claims).encode())
    sig = key.sign(f"{header}.{payload}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{_b64(sig)}"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.delenv("GOOGLE_WEB_CLIENT_ID", raising=False)
    for mod in ("database", "main", "enrichment", "google_id_token"):
        sys.modules.pop(mod, None)
    import database as _db
    import google_id_token
    import main as _main
    _db.init_db()
    monkeypatch.setattr(google_id_token, "_public_key_for_kid",
                        lambda kid: KEY.public_key() if kid == KID else None)
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _sign_in(client, token):
    return client.post("/auth/google", json={"id_token": token, "device": "android"})


def test_valid_id_token_opens_a_session(api):
    db, _, client = api
    r = _sign_in(client, make_token())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user_id"] == SUB
    assert body["is_new_user"] is True
    assert (body["display_name"], body["given_name"], body["email"]) == ("Bia Souza", "Bia", "bia@gmail.com")
    assert db.resolve_session(body["token"]) == SUB
    assert db.get_user_id_for_provider("google", SUB) == SUB


@pytest.mark.parametrize("token", [
    make_token(aud="511485926685-irun1c38rluvso37l9lqhbh03e35gms5.apps.googleusercontent.com"),
    make_token(exp=int(time.time()) - 600, iat=int(time.time()) - 4200),
    make_token(iss="https://evil.example.com"),
    make_token(key=OTHER_KEY),
    "not-a-jwt",
], ids=["wrong-aud", "expired", "wrong-iss", "bad-signature", "garbage"])
def test_invalid_id_tokens_are_refused(api, token):
    db, _, client = api
    r = _sign_in(client, token)
    assert r.status_code == 401
    assert r.json()["detail"] == "Token inválido"
    assert db.get_user_profile(SUB) is None


def test_unverified_email_is_refused(api):
    db, _, client = api
    r = _sign_in(client, make_token(email_verified=False))
    assert r.status_code == 401
    assert r.json()["detail"] == "E-mail do Google não verificado"
    assert db.get_user_profile(SUB) is None


def test_string_true_email_verified_is_accepted(api):
    _, _, client = api
    assert _sign_in(client, make_token(email_verified="true")).status_code == 200


def test_same_sub_maps_to_the_existing_user(api, monkeypatch):
    db, main, client = api
    # First sign-in on the web, through the access-token path.
    monkeypatch.setattr(main, "fetch_google_userinfo", lambda t: {
        "sub": SUB, "email": "bia@gmail.com", "email_verified": True,
        "name": "Bia Souza", "given_name": "Bia", "picture": "",
    })
    web = client.post("/auth/google", json={"access_token": "ya29.x", "device": "web"}).json()
    assert web["is_new_user"] is True

    android = _sign_in(client, make_token()).json()
    assert android["user_id"] == web["user_id"] == SUB
    assert android["is_new_user"] is False
    assert db.resolve_session(android["token"]) == SUB


def test_audience_follows_env(api, monkeypatch):
    _, _, client = api
    monkeypatch.setenv("GOOGLE_WEB_CLIENT_ID", "staging-client.apps.googleusercontent.com")
    assert _sign_in(client, make_token()).status_code == 401
    assert _sign_in(client, make_token(aud="staging-client.apps.googleusercontent.com")).status_code == 200


def test_no_token_at_all_is_refused(api):
    _, _, client = api
    assert client.post("/auth/google", json={}).status_code == 401
