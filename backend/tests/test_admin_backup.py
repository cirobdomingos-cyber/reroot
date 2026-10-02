"""
Tests for GET /admin/backup — the nightly off-site copy of the database.

Context: the Railway volume is the only copy of every user, RSVP and
friendship. A scheduled job outside Railway pulls this route and keeps
dated copies, so a bad deploy or a deleted volume can't lose them.

What must hold:
  1. BACKUP_TOKEN unset: 404, as if the route were never deployed.
  2. A missing or wrong token is refused, and so is a founder session —
     this token is for the job, and sessions expire.
  3. The right token returns a SQLite file that opens, passes
     integrity_check and carries the users that were in the live DB.
"""
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

TOKEN = "backup-secret"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("BACKUP_TOKEN", TOKEN)
    for mod in ("database", "main", "enrichment"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT INTO users (id, display_name, email, picture, created_at)"
            " VALUES (?,?,?,?,?)",
            ("u_ana", "Ana", "ana@example.com", "", datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def test_unset_token_is_404(api, monkeypatch):
    _, main, client = api
    monkeypatch.setattr(main.settings, "backup_token", "")
    r = client.get("/admin/backup", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 404


def test_wrong_missing_or_session_token_is_refused(api):
    db, _, client = api
    assert client.get("/admin/backup").status_code == 401
    assert client.get("/admin/backup", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/admin/backup", params={"token": TOKEN}).status_code == 401
    session = db.create_session("u_ana", "test")
    assert client.get("/admin/backup",
                      headers={"Authorization": f"Bearer {session}"}).status_code == 401


def test_snapshot_is_a_valid_copy_of_the_live_db(api, tmp_path):
    _, _, client = api
    r = client.get("/admin/backup", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200
    assert r.content[:16] == b"SQLite format 3\x00"
    out = tmp_path / "copy.db"
    out.write_bytes(r.content)
    with sqlite3.connect(out) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("SELECT email FROM users WHERE id='u_ana'").fetchone()[0] == "ana@example.com"
