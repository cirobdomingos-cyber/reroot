"""
Tests for the staging → production catalog sync.

Context: staging runs on its own Railway volume, so it starts empty and
every test there runs against three fake events. export_catalog and
import_catalog move the catalog — events, venues, tracked handles — so
what you test on staging looks like what people actually see.

The thing these tests exist to protect is what does NOT move. The same
database holds users, friendships, RSVPs and, worst of all, push tokens.
Push tokens are not scoped to an environment: the send path has no
environment check, so a copy of them into staging means a test there
notifies real phones. The export is an allowlist for exactly this
reason, and a denylist would have leaked added_by_email the day someone
added it.

What must hold:
  1. Events, venues and handles survive the round trip intact, including
     geocoded coordinates (they cost API calls and don't differ by env).
  2. No personal column is ever in the export — checked against the live
     table schema, so a column added tomorrow fails this test rather
     than shipping.
  3. An event whose payload doesn't parse is skipped and reported, not
     written for something downstream to choke on.
  4. Import is an upsert: a coordinate fixed locally isn't erased by a
     production row that has none.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    sys.modules.pop("database", None)
    import database as _db
    _db.init_db()
    return _db


@pytest.fixture()
def other_db(tmp_path, monkeypatch):
    """A second, independent database — the staging side of the sync."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "staging.db"))
    sys.modules.pop("database", None)
    import database as _db
    _db.init_db()
    return _db


def _event(shortcode="ABC123", name="Samba na Sociedade"):
    from models import EnrichedEvent
    return EnrichedEvent(
        id=f"ig_samba_{shortcode}", source="instagram",
        external_id=f"ig_samba_{shortcode}",
        name=name, description="Samba toda sexta",
        venue_name="Sociedade Operária", venue_address="Rua X, 100",
        neighborhood="Centro", city="Curitiba",
        date_start=datetime(2026, 12, 1, 21, 0), date_end=None,
        price_min=30, price_max=30, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="🎉",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="low", vibe_summary="", expected_size="large",
        header_gradient="",
        url=f"https://instagram.com/p/{shortcode}/",
        image_url="https://cdn.example/img.jpg",
        fetched_at=datetime(2026, 9, 1),
    )


# ── 1. the round trip ────────────────────────────────────────────────

def test_catalog_survives_the_round_trip(db, tmp_path, monkeypatch):
    db.upsert_event(_event())
    key = db.upsert_venue_seed("Sociedade Operária", "Rua X, 100")
    db.update_venue_manual(key, lat=-25.43, lng=-49.27, bairro="Centro")
    db.upsert_ig_account("samba.cwb", label="Samba CWB", category="música")

    exported = db.export_catalog()
    assert len(exported["events"]) == 1
    assert len(exported["ig_accounts"]) == 1

    # Re-import into a genuinely separate database.
    monkeypatch.setenv("DB_PATH", str(tmp_path / "staging.db"))
    sys.modules.pop("database", None)
    import database as staging
    staging.init_db()

    result = staging.import_catalog(exported)
    assert result["events"] == 1
    assert result["skipped"] == []

    got = staging.get_events(limit=10)
    assert len(got) == 1
    assert got[0].name == "Samba na Sociedade"
    assert got[0].price_min == 30

    # Coordinates come along — regeocoding costs API calls and a venue
    # doesn't move between environments.
    coords = staging.get_venue_coords_map()
    assert coords[key]["lat"] == -25.43

    handles = {a["handle"]: a for a in staging.list_ig_accounts()}
    assert handles["samba.cwb"]["label"] == "Samba CWB"


# ── 2. what must never be exported ───────────────────────────────────

def test_export_carries_no_personal_columns(db):
    """The guard that matters. Read against the live schema so a personal
    column added later fails here instead of reaching staging."""
    db.upsert_ig_account(
        "bar.do.sax", label="Bar do Sax",
        notes="dono é amigo do João, cobrar depois",
        added_by_email="ciro@example.com",
    )
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE tracked_ig_accounts SET claimed_by_email = ? WHERE handle = ?",
            ("dono@bardosax.com", "bar.do.sax"),
        )
        conn.commit()

    exported = db.export_catalog()
    blob = json.dumps(exported)

    assert "ciro@example.com" not in blob
    assert "dono@bardosax.com" not in blob
    assert "cobrar depois" not in blob

    account = exported["ig_accounts"][0]
    for forbidden in ("added_by_email", "claimed_by_email", "notes"):
        assert forbidden not in account


def test_export_has_only_catalog_tables(db):
    """Users, friendships, RSVPs, analytics and — above all — push
    subscriptions are not in the payload at all."""
    assert set(db.export_catalog()) == {
        "exported_at", "events", "venues", "ig_accounts",
    }


def test_new_ig_column_is_not_exported_by_default(db):
    """An allowlist, not a denylist: a column nobody thought about stays
    home until someone decides otherwise."""
    with db.get_conn() as conn:
        try:
            conn.execute(
                "ALTER TABLE tracked_ig_accounts ADD COLUMN owner_phone TEXT "
                "NOT NULL DEFAULT ''"
            )
        except Exception:
            pytest.skip("column already present")
        conn.execute(
            "INSERT INTO tracked_ig_accounts (handle, added_at, owner_phone) "
            "VALUES (?, ?, ?)",
            ("novo.bar", "2026-01-01T00:00:00+00:00", "+5541999999999"),
        )
        conn.commit()

    blob = json.dumps(db.export_catalog())
    assert "+5541999999999" not in blob


# ── 3. a bad payload is reported, not written ────────────────────────

def test_unparseable_event_is_skipped_and_named(other_db):
    result = other_db.import_catalog({
        "events": [
            {"id": "ig_bad_1", "payload": '{"nope": true}'},
            {"id": "ig_bad_2", "payload": "not even json"},
        ],
    })
    assert result["events"] == 0
    assert len(result["skipped"]) == 2
    # The report names the row, so a partial import says what it dropped.
    assert any("ig_bad_1" in s for s in result["skipped"])
    assert other_db.get_events(limit=10) == []


# ── 4. import is an upsert, not a replace ────────────────────────────

def test_local_coordinates_survive_an_ungeocoded_production_row(other_db):
    key = other_db.upsert_venue_seed("Bar do Sax", "Rua Y, 20")
    other_db.update_venue_manual(key, lat=-25.42, lng=-49.26, bairro="Batel")

    other_db.import_catalog({
        "venues": [{
            "name_normalized": key, "name_original": "Bar do Sax",
            "address": "Rua Y, 20", "lat": None, "lng": None,
            "bairro": "Batel", "geocode_status": "pending",
        }],
    })

    coords = other_db.get_venue_coords_map()
    assert coords[key]["lat"] == -25.42


def test_import_updates_an_existing_event_instead_of_duplicating(other_db):
    other_db.upsert_event(_event(name="Nome antigo"))
    exported_style = {
        "events": [{
            "id": "ig_samba_ABC123",
            "payload": _event(name="Nome novo").model_dump_json(),
        }],
    }
    other_db.import_catalog(exported_style)

    got = other_db.get_events(limit=10)
    assert len(got) == 1
    assert got[0].name == "Nome novo"


# ── 5. the endpoint gates ────────────────────────────────────────────

@pytest.fixture()
def api(tmp_path, monkeypatch):
    """Fresh DB + fresh module pair. main.py binds `db` and reads settings
    at import time, so env vars have to be set before the import."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))

    def _boot(**env):
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        for mod in ("database", "main"):
            sys.modules.pop(mod, None)
        import database as _db
        import main as _main
        _db.init_db()
        from fastapi.testclient import TestClient
        return _db, _main, TestClient(_main.app)

    return _boot


def test_export_is_404_when_no_token_is_configured(api, monkeypatch):
    """Fails closed. An unconfigured service must not serve the catalog,
    and it 404s rather than 401 so the endpoint's existence isn't news."""
    monkeypatch.delenv("CATALOG_SYNC_TOKEN", raising=False)
    _, _, client = api()
    assert client.get("/catalog-export").status_code == 404
    assert client.get("/catalog-export?token=guess").status_code == 404


def test_export_rejects_a_wrong_token(api):
    _, _, client = api(CATALOG_SYNC_TOKEN="right-token")
    assert client.get("/catalog-export?token=wrong").status_code == 404
    assert client.get("/catalog-export?token=").status_code == 404
    r = client.get("/catalog-export?token=right-token")
    assert r.status_code == 200
    assert set(r.json()) == {"exported_at", "events", "venues", "ig_accounts"}


def test_sync_refuses_to_run_in_production(api):
    """Production is the source, never a target. env_name defaults to
    "production" when the var is missing, so a service nobody configured
    refuses instead of importing over the real catalog."""
    db_, _, client = api(CATALOG_SYNC_TOKEN="t", ENV_NAME="production")
    db_.add_curator("ciro@example.com")
    r = client.post("/admin/sync-catalog?requesting_email=ciro@example.com")
    assert r.status_code == 400
    assert "produção" in r.json()["detail"]


def test_sync_refuses_an_unconfigured_env_the_same_way(api, monkeypatch):
    monkeypatch.delenv("ENV_NAME", raising=False)
    db_, _, client = api(CATALOG_SYNC_TOKEN="t")
    db_.add_curator("ciro@example.com")
    r = client.post("/admin/sync-catalog?requesting_email=ciro@example.com")
    assert r.status_code == 400


def test_sync_needs_a_curator(api):
    _, _, client = api(CATALOG_SYNC_TOKEN="t", ENV_NAME="staging")
    assert client.post("/admin/sync-catalog").status_code == 401
    r = client.post("/admin/sync-catalog?requesting_email=qualquer@example.com")
    assert r.status_code == 403


# ── 6. one commit for the whole payload ──────────────────────────────

def test_import_writes_events_in_one_connection(other_db, monkeypatch):
    """The bug behind 'clicked the button, nothing happened': the first
    cut of this function called upsert_event() per row, which opens and
    commits its own sqlite3.connect() each time. A few hundred events is
    a few hundred sequential fsyncs on a network volume — slow enough to
    read as a hang. Import must do the whole payload in one connection."""
    seen = []
    real_connect = other_db.sqlite3.connect

    def counting_connect(*a, **kw):
        seen.append(1)
        return real_connect(*a, **kw)

    monkeypatch.setattr(other_db.sqlite3, "connect", counting_connect)

    events = [
        {"id": f"ig_x_{i}", "payload": _event(shortcode=f"X{i}").model_dump_json()}
        for i in range(20)
    ]
    other_db.import_catalog({"events": events})

    # One connection for the run, not one per event — check before the
    # next db call (get_events) would add one of its own.
    assert len(seen) == 1, f"expected 1 connection, opened {len(seen)}"

    monkeypatch.setattr(other_db.sqlite3, "connect", real_connect)
    assert len(other_db.get_events(limit=100)) == 20


# ── 7. one bad row doesn't take the whole import down ────────────────

def test_a_row_that_raises_is_skipped_not_fatal(other_db):
    """The bug behind the first real run: events.id is the PRIMARY KEY,
    but the ON CONFLICT target above is the (source, external_id) unique
    index. A row that collides on id without colliding on that pair —
    plausible in a catalog with months of history — isn't caught by
    ON CONFLICT and used to raise straight out of the shared
    transaction, losing every other row in the same request."""
    good_a = _event(shortcode="GOOD1", name="Evento bom 1")
    bad = _event(shortcode="GOOD1", name="Evento colidido")
    object.__setattr__(bad, "id", good_a.id)  # same PK, different (source, external_id) below
    bad.external_id = "ig_samba_OTHERCODE"
    good_b = _event(shortcode="GOOD2", name="Evento bom 2")

    result = other_db.import_catalog({"events": [
        {"id": good_a.id, "payload": good_a.model_dump_json()},
        {"id": bad.id, "payload": bad.model_dump_json()},
        {"id": good_b.id, "payload": good_b.model_dump_json()},
    ]})

    assert result["events"] == 2
    assert len(result["skipped"]) == 1
    names = {e.name for e in other_db.get_events(limit=10)}
    assert names == {"Evento bom 1", "Evento bom 2"}


# ── 8. production hasn't shipped this endpoint yet ───────────────────

class _FakeResponse:
    """Just enough of an httpx.Response to drive admin_sync_catalog."""
    def __init__(self, status_code, content_type, body):
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self._body = body

    def json(self):
        import json as _json
        return _json.loads(self._body)


def test_sync_explains_when_production_has_no_export_route_yet(api, monkeypatch):
    """This app has no real 404 — spa_fallback serves index.html (200)
    for any unmatched route, which is exactly what happens when this
    endpoint has shipped to dev but production hasn't gotten the release
    yet. A bare JSON-parse error ('Expecting value: line 1 column 1')
    told the user nothing; the content-type check names the real cause."""
    db_, main_, client = api(CATALOG_SYNC_TOKEN="t", ENV_NAME="staging")
    db_.add_curator("ciro@example.com")

    monkeypatch.setattr(
        main_.httpx, "get",
        lambda *a, **kw: _FakeResponse(200, "text/html; charset=utf-8", "<!doctype html>..."),
    )
    r = client.post("/admin/sync-catalog?requesting_email=ciro@example.com")
    assert r.status_code == 502
    assert "/catalog-export" in r.json()["detail"]
    assert "release" in r.json()["detail"]


def test_sync_end_to_end_against_a_mocked_production(api, monkeypatch):
    """The happy path, mocked at the network boundary: a valid catalog
    JSON response gets parsed and imported exactly like the direct
    import_catalog tests already cover."""
    db_, main_, client = api(CATALOG_SYNC_TOKEN="t", ENV_NAME="staging")
    db_.add_curator("ciro@example.com")

    body = json.dumps({
        "events": [{"id": "ig_x_1", "payload": _event(shortcode="X1").model_dump_json()}],
        "venues": [], "ig_accounts": [],
    })
    monkeypatch.setattr(
        main_.httpx, "get",
        lambda *a, **kw: _FakeResponse(200, "application/json", body),
    )
    r = client.post("/admin/sync-catalog?requesting_email=ciro@example.com")
    assert r.status_code == 200
    assert r.json()["events"] == 1
    assert len(db_.get_events(limit=10)) == 1
