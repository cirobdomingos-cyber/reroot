"""
Tests for sessions — the API knowing who is calling.

Context (Sep 2026): the client used to say who it was (a google_id, an
e-mail for admin routes) and the API believed it. Now a sign-in verified
on the server answers with a bearer token, and a request that names a
caller has to be that caller.

What must hold:
  1. A session resolves to its user, expires, and can be revoked one
     device at a time or all at once.
  2. /auth/google trusts Google, not the client: a verified profile opens
     a session; an unverified e-mail or a token Google refuses is a 401.
  3. A route that names its caller: the session must match (403 if not);
     with no session it passes only while REQUIRE_SESSION is off (401
     once it is on).
  4. Founder routes never take the e-mail from the query: a non-founder
     session is refused, and the query parameter alone is worth nothing.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

FOUNDER_EMAIL = "founder@example.com"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.delenv("REQUIRE_SESSION", raising=False)
    for mod in ("database", "main", "enrichment"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    _db.add_curator(email=FOUNDER_EMAIL, added_by_email="system", notes="test",
                    is_founder_flag=True)
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        for uid, email in (("u_founder", FOUNDER_EMAIL), ("u_ana", "ana@example.com")):
            conn.execute(
                "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
                " VALUES (?,?,?,?,?)", (uid, uid, email, "", now),
            )
        conn.commit()
    # The routes the tests hit read state; give both people a blob.
    _db.upsert_user_state("u_ana", {"hasJoined": True, "language": "pt", "rsvps": {}})
    _db.upsert_user_state("u_founder", {"hasJoined": True, "language": "pt", "rsvps": {}})
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _bearer(db, uid):
    return {"Authorization": f"Bearer {db.create_session(uid, 'test')}"}


# ── 1. sessions ──

def test_session_round_trip(api):
    db, _, _ = api
    token = db.create_session("u_ana", "iphone")
    assert db.resolve_session(token) == "u_ana"
    assert db.resolve_session("not-a-token") is None
    assert db.resolve_session("") is None


def test_session_expires(api):
    db, _, _ = api
    token = db.create_session("u_ana")
    past = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    with db.get_conn() as conn:
        conn.execute("UPDATE sessions SET expires_at = ?", (past,))
        conn.commit()
    assert db.resolve_session(token) is None
    with db.get_conn() as conn:
        assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0, "expired rows are dropped"


def test_session_delete_one_and_all(api):
    db, _, _ = api
    phone = db.create_session("u_ana", "phone")
    laptop = db.create_session("u_ana", "laptop")
    db.delete_session(phone)
    assert db.resolve_session(phone) is None
    assert db.resolve_session(laptop) == "u_ana"
    db.delete_user_sessions("u_ana")
    assert db.resolve_session(laptop) is None


def test_account_deletion_signs_out_every_device(api):
    db, _, _ = api
    token = db.create_session("u_ana")
    assert db.delete_user_account("u_ana")
    assert db.resolve_session(token) is None


def test_logout_revokes_the_token(api):
    db, _, client = api
    headers = _bearer(db, "u_ana")
    assert client.post("/auth/logout", headers=headers).json() == {"ok": True}
    assert client.get("/user/state/u_ana", headers=headers).status_code == 401 or \
        db.resolve_session(headers["Authorization"].split()[1]) is None


# ── 2. /auth/google ──

GOOGLE_PROFILE = {
    "sub": "1029384756", "email": "bia@gmail.com", "email_verified": True,
    "name": "Bia Souza", "given_name": "Bia", "picture": "https://lh3/bia.jpg",
}


def test_google_sign_in_opens_a_session(api, monkeypatch):
    db, main, client = api
    seen = {}
    def fake(token):
        seen["token"] = token
        return dict(GOOGLE_PROFILE)
    monkeypatch.setattr(main, "fetch_google_userinfo", fake)

    r = client.post("/auth/google", json={"access_token": "ya29.x", "device": "web"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert seen["token"] == "ya29.x"
    assert body["user_id"] == "1029384756", "the id stays the Google sub"
    assert body["is_new_user"] is True
    assert (body["display_name"], body["given_name"], body["email"]) == ("Bia Souza", "Bia", "bia@gmail.com")
    assert db.resolve_session(body["token"]) == "1029384756"
    assert db.get_user_profile("1029384756")["email"] == "bia@gmail.com"
    assert db.get_user_id_for_provider("google", "1029384756") == "1029384756"

    again = client.post("/auth/google", json={"access_token": "ya29.y"}).json()
    assert again["is_new_user"] is False
    assert again["user_id"] == "1029384756"


def test_google_sign_in_refuses_unverified_email(api, monkeypatch):
    db, main, client = api
    monkeypatch.setattr(main, "fetch_google_userinfo",
                        lambda t: {**GOOGLE_PROFILE, "email_verified": False})
    r = client.post("/auth/google", json={"access_token": "ya29.x"})
    assert r.status_code == 401
    assert db.get_user_profile("1029384756") is None


def test_google_sign_in_refuses_a_token_google_refuses(api, monkeypatch):
    _, main, client = api
    monkeypatch.setattr(main, "fetch_google_userinfo", lambda t: None)
    assert client.post("/auth/google", json={"access_token": "garbage"}).status_code == 401
    assert client.post("/auth/google", json={"access_token": ""}).status_code == 401


# ── 3. the caller assertion ──

def test_matching_session_passes(api):
    db, _, client = api
    r = client.get("/user/state/u_ana", headers=_bearer(db, "u_ana"))
    assert r.status_code == 200


def test_mismatching_session_is_refused(api):
    db, _, client = api
    headers = _bearer(db, "u_ana")
    assert client.get("/user/state/u_founder", headers=headers).status_code == 403
    assert client.delete("/user/account?google_id=u_founder", headers=headers).status_code == 403
    r = client.post("/user/state", headers=headers,
                    json={"google_id": "u_founder",
                          "state": {"hasJoined": True, "language": "pt", "rsvps": {}}})
    assert r.status_code == 403
    assert db.get_user_profile("u_founder") is not None, "nothing happened to the other account"


def test_no_session_passes_while_the_switch_is_off(api, monkeypatch):
    monkeypatch.delenv("REQUIRE_SESSION", raising=False)
    _, _, client = api
    assert client.get("/user/state/u_ana").status_code == 200


def test_no_session_is_refused_once_the_switch_is_on(api, monkeypatch):
    monkeypatch.setenv("REQUIRE_SESSION", "true")
    db, _, client = api
    assert client.get("/user/state/u_ana").status_code == 401
    assert client.get("/user/state/u_ana", headers=_bearer(db, "u_ana")).status_code == 200
    # An anonymous request names nobody, so there is nothing to prove.
    assert client.get("/channels").status_code == 200


def test_an_invalid_token_counts_as_no_session(api, monkeypatch):
    monkeypatch.setenv("REQUIRE_SESSION", "1")
    _, _, client = api
    r = client.get("/user/state/u_ana", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


# ── 4. founder routes ──

def test_admin_refuses_a_non_founder_session(api):
    db, _, client = api
    r = client.get("/admin/users", headers=_bearer(db, "u_ana"))
    assert r.status_code == 403


def test_admin_ignores_the_query_email(api):
    _, _, client = api
    r = client.get(f"/admin/users?requesting_email={FOUNDER_EMAIL}")
    assert r.status_code == 401, "the founder's e-mail is not a credential"


def test_admin_accepts_the_founder_session(api):
    db, _, client = api
    r = client.get("/admin/users?requesting_email=whoever@example.com",
                   headers=_bearer(db, "u_founder"))
    assert r.status_code == 200
