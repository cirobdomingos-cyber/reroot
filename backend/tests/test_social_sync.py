"""
Tests for the production -> staging social sync.

Staging needs a realistic graph, because most bugs in this app are
relational and an empty staging hides them. What it does not need is
who those people actually are.

So the anonymisation happens on the PRODUCTION side, before anything
leaves. Scrubbing on arrival would mean the real data made the trip and
sat in a response body first, which protects nobody. Most of what
follows is testing that nothing real escapes.

The direction is one-way and enforced twice, because the wrong
direction overwrites production's users:
  1. env_name must not be "production" — and it defaults to
     "production", so an unconfigured service refuses.
  2. import_social rejects a payload not marked anonymised, so a
     misconfigured origin isn't enough on its own.

What is never copied at all: push subscriptions and device tokens
(staging has SMTP configured and runs the same scheduler, so a test
digest reaching a real phone is not hypothetical), auth providers
(nobody signs in as a copy), and feedback (free text written for one
reader).
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

TOKEN = "sync-token-for-tests"
FOUNDER = "founder@example.com"
REAL = [
    ("u_ana", "Ana Silva", "ana.silva@gmail.com", "https://lh3.google/ana.jpg"),
    ("u_bia", "Bia Costa", "bia@empresa.com.br", "https://lh3.google/bia.jpg"),
    ("u_f", "Ciro", FOUNDER, "https://lh3.google/ciro.jpg"),
]


@pytest.fixture()
def prod(tmp_path, monkeypatch):
    """A database standing in for production, with a small real graph."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "prod.db"))
    monkeypatch.setenv("CATALOG_SYNC_TOKEN", TOKEN)
    monkeypatch.setenv("FOUNDER_EMAIL", FOUNDER)
    monkeypatch.setenv("ENV_NAME", "production")
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        for uid, name, email, pic in REAL:
            conn.execute(
                "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
                " VALUES (?,?,?,?,?)", (uid, name, email, pic, now))
        # is_founder explicitly — add_curator only grants the curator
        # bit, and this endpoint is founder-gated.
        conn.execute(
            "INSERT OR REPLACE INTO curators (email, added_by_email, added_at,"
            " notes, is_founder, is_curator, is_feedbacker) VALUES (?,?,?,?,1,1,1)",
            (FOUNDER, "system", now, "test"))
        conn.commit()
    for uid, name, email, pic in REAL:
        _db.upsert_user_state(uid, {
            "userName": name,
            "googleUser": {"name": name, "givenName": name.split()[0],
                           "email": email, "picture": pic},
        })
    _db.request_friendship("u_ana", "u_bia")
    g = _db.create_group("u_ana", "Role do Sax", "nossa turma")
    _db.join_group(g["id"], "u_bia")
    _db.create_group_event(
        group_id=g["id"], google_id="u_ana", name="Churrasco",
        date_start="2099-01-01T20:00:00", extra_invitee_ids=["u_bia"],
    )
    _db.upsert_rsvp("u_bia", "ev1", "Show", "Pedreira", "2099-01-01", "")
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app), g["id"]


def _dump(payload):
    """Every string anywhere in the payload, for leak hunting."""
    return json.dumps(payload, ensure_ascii=False)


# -- nothing real escapes --------------------------------------------

def test_real_names_emails_and_photos_never_leave(prod):
    _db, _main, client, _gid = prod
    payload = client.get(f"/social-export?token={TOKEN}").json()
    blob = _dump(payload)
    # The founder's own row passes through by design, so this checks
    # everyone ELSE. Their photo URL is theirs to export.
    for leaked in ("Ana Silva", "ana.silva@gmail.com", "Bia Costa",
                   "bia@empresa.com.br", "ana.jpg", "bia.jpg"):
        assert leaked not in blob, f"{leaked} escaped into the export"


def test_real_user_ids_never_leave(prod):
    _db, _main, client, _gid = prod
    blob = _dump(client.get(f"/social-export?token={TOKEN}").json())
    assert '"u_ana"' not in blob
    assert '"u_bia"' not in blob


def test_the_founders_own_row_passes_through(prod):
    """Their data, their call — and they need to sign into staging as
    themselves to test the graph at all."""
    _db, _main, client, _gid = prod
    payload = client.get(f"/social-export?token={TOKEN}").json()
    me = next(u for u in payload["users"] if u["id"] == "u_f")
    assert me["email"] == FOUNDER
    assert payload["kept_real"] == ["u_f"]


def test_user_states_are_scrubbed_to_match(prod):
    """The app reads names and pictures out of this blob. If it kept the
    real ones, staging would render real people from a clean users
    table."""
    _db, _main, client, _gid = prod
    payload = client.get(f"/social-export?token={TOKEN}").json()
    for state in payload["user_states"]:
        if state["google_id"] == "u_f":
            continue
        assert "Ana Silva" not in state["state_json"]
        assert "lh3.google" not in state["state_json"]


def test_devices_and_logins_are_not_in_the_export_at_all(prod):
    _db, _main, client, _gid = prod
    payload = client.get(f"/social-export?token={TOKEN}").json()
    for never in ("push_subscriptions", "apns_device_tokens",
                  "auth_providers", "feedback"):
        assert never not in payload


# -- the graph survives the scrubbing --------------------------------

def test_the_shape_is_preserved(prod):
    """The whole point: a realistic graph. Counts must match even though
    every identity changed."""
    _db, _main, client, _gid = prod
    payload = client.get(f"/social-export?token={TOKEN}").json()
    assert len(payload["users"]) == 3
    assert len(payload["friendships"]) == 1
    assert len(payload["groups"]) == 1
    assert len(payload["group_members"]) == 2
    assert len(payload["group_events"]) == 1
    assert len(payload["rsvps"]) == 1


def test_the_friendship_still_connects_the_same_two_people(prod):
    _db, _main, client, _gid = prod
    payload = client.get(f"/social-export?token={TOKEN}").json()
    ids = {u["id"] for u in payload["users"]}
    f = payload["friendships"][0]
    assert f["user_a"] in ids and f["user_b"] in ids
    assert f["user_a"] != f["user_b"]


def test_invitee_lists_are_remapped_not_dropped(prod):
    _db, _main, client, _gid = prod
    payload = client.get(f"/social-export?token={TOKEN}").json()
    invitees = json.loads(payload["group_events"][0]["extra_invitee_ids"])
    assert len(invitees) == 1
    assert invitees[0] != "u_bia"
    assert invitees[0] in {u["id"] for u in payload["users"]}


def test_pseudonyms_are_stable_across_pulls(prod):
    """Same person, same fake person, every time — otherwise each sync
    piles a new cast of characters onto staging."""
    _db, _main, client, _gid = prod
    first = client.get(f"/social-export?token={TOKEN}").json()
    second = client.get(f"/social-export?token={TOKEN}").json()
    assert [u["id"] for u in first["users"]] == [u["id"] for u in second["users"]]
    assert [u["display_name"] for u in first["users"]] == \
           [u["display_name"] for u in second["users"]]


def test_fake_emails_cannot_reach_anyone(prod):
    """.invalid is reserved by RFC 2606 and never resolves, so a stray
    send from staging bounces instead of arriving."""
    _db, _main, client, _gid = prod
    payload = client.get(f"/social-export?token={TOKEN}").json()
    for u in payload["users"]:
        if u["id"] == "u_f":
            continue
        assert u["email"].endswith("@staging.invalid")


# -- the token gate --------------------------------------------------

def test_a_wrong_token_looks_like_nothing_is_deployed(prod):
    _db, _main, client, _gid = prod
    assert client.get("/social-export?token=wrong").status_code == 404


def test_no_token_configured_means_the_endpoint_does_not_exist(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "p.db"))
    monkeypatch.delenv("CATALOG_SYNC_TOKEN", raising=False)
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    from fastapi.testclient import TestClient
    assert TestClient(_main.app).get("/social-export?token=x").status_code == 404


# -- direction is one-way, enforced twice ----------------------------

def test_production_refuses_to_import(prod):
    """env_name defaults to "production", so a service with the variable
    missing refuses rather than overwriting real people."""
    _db, _main, client, _gid = prod
    r = client.post(f"/admin/sync-social?requesting_email={FOUNDER}")
    assert r.status_code == 400
    assert "produção" in r.json()["detail"].lower()


def test_a_non_anonymised_payload_is_refused_on_arrival(prod):
    """Second guard. One misconfigured origin should not be enough to
    write real identities into a weaker environment."""
    _db, _main, _client, _gid = prod
    with pytest.raises(ValueError):
        _db.import_social({"users": [{"id": "x", "display_name": "Real Person",
                                      "email": "real@gmail.com", "picture": "",
                                      "created_at": "2026-01-01"}]})


def test_importing_replaces_rather_than_merges(tmp_path, monkeypatch, prod):
    """Overwrite, not merge — otherwise staging keeps whatever the last
    round of manual testing left behind, and you're looking at
    production plus residue."""
    _pdb, _pmain, pclient, _gid = prod
    payload = pclient.get(f"/social-export?token={TOKEN}").json()

    monkeypatch.setenv("DB_PATH", str(tmp_path / "staging.db"))
    monkeypatch.setenv("ENV_NAME", "staging")
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as sdb
    sdb.init_db()
    now = datetime.now(timezone.utc).isoformat()
    with sdb.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
            " VALUES (?,?,?,?,?)", ("leftover", "Teste Antigo", "t@t.com", "", now))
        conn.commit()

    sdb.import_social(payload)
    with sdb.get_conn() as conn:
        ids = {r["id"] for r in conn.execute("SELECT id FROM users")}
    assert "leftover" not in ids, "staging kept residue from before the pull"
    assert len(ids) == 3


def test_importing_clears_any_device_registered_here(tmp_path, monkeypatch, prod):
    """A copied graph must never inherit a way to reach someone."""
    _pdb, _pmain, pclient, _gid = prod
    payload = pclient.get(f"/social-export?token={TOKEN}").json()

    monkeypatch.setenv("DB_PATH", str(tmp_path / "staging2.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as sdb
    sdb.init_db()
    now = datetime.now(timezone.utc).isoformat()
    with sdb.get_conn() as conn:
        conn.execute(
            "INSERT INTO push_subscriptions (endpoint, keys_json, google_id, created_at)"
            " VALUES (?,?,?,?)", ("https://push/endpoint", "{}", "u_ana", now))
        conn.commit()

    sdb.import_social(payload)
    with sdb.get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM push_subscriptions").fetchone()["n"] == 0


def test_the_graph_arrives_intact(tmp_path, monkeypatch, prod):
    _pdb, _pmain, pclient, _gid = prod
    payload = pclient.get(f"/social-export?token={TOKEN}").json()

    monkeypatch.setenv("DB_PATH", str(tmp_path / "staging3.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as sdb
    sdb.init_db()
    counts = sdb.import_social(payload)

    assert counts["users"] == 3
    assert counts["friendships"] == 1
    assert counts["group_members"] == 2
    with sdb.get_conn() as conn:
        group = conn.execute("SELECT * FROM groups").fetchone()
        assert group["name"] == "Role do Sax"
        members = conn.execute(
            "SELECT google_id FROM group_members WHERE group_id = ?", (group["id"],)
        ).fetchall()
    assert len(members) == 2
    # And the members are the pseudonyms, not the originals.
    assert all(m["google_id"] in {u["id"] for u in payload["users"]} for m in members)
