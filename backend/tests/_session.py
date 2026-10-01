"""
Test client that signs the caller in.

The API stopped trusting `requesting_email`: a founder or curator route
reads the e-mail from the session behind the bearer token. The older
tests still say who is calling with `requesting_email=...` in the query
or the JSON body, which is exactly the right information — so this
client turns it into a session for that person instead of every test
repeating the plumbing.

A request that already carries an Authorization header is sent as is,
so a test can still prove that the query parameter alone is worthless.
"""
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def user_id_for(db, email: str) -> str:
    """The users row for an e-mail, created when missing (u_<local part>)."""
    email = (email or "").strip().lower()
    existing = db.get_user_id_by_email(email)
    if existing:
        return existing
    uid = "u_" + re.sub(r"[^a-z0-9]+", "_", email.split("@")[0])
    with db.get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO users (id, display_name, email, picture, created_at)"
            " VALUES (?,?,?,?,?)",
            (uid, uid, email, "", datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    return uid


def bearer(db, user_id: str) -> dict:
    """Headers for a request made by `user_id`."""
    return {"Authorization": f"Bearer {db.create_session(user_id, 'test')}"}


def bearer_for_email(db, email: str) -> dict:
    return bearer(db, user_id_for(db, email))


class SessionClient(TestClient):
    def __init__(self, app, db, **kw):
        super().__init__(app, **kw)
        self._db = db

    def request(self, method, url, **kw):
        headers = dict(kw.pop("headers", None) or {})
        if not any(k.lower() == "authorization" for k in headers):
            email = _requesting_email(url, kw)
            if email:
                headers.update(bearer_for_email(self._db, email))
        return super().request(method, url, headers=headers, **kw)


def _requesting_email(url, kw) -> str:
    body = kw.get("json")
    if isinstance(body, dict) and body.get("requesting_email"):
        return str(body["requesting_email"])
    params = kw.get("params") or {}
    if isinstance(params, dict) and params.get("requesting_email"):
        return str(params["requesting_email"])
    q = parse_qs(urlsplit(str(url)).query)
    if q.get("requesting_email"):
        return q["requesting_email"][0]
    return ""
