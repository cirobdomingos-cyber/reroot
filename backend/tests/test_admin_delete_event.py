"""
Tests for DELETE /admin/events/{id} — the founder removing a catalog event.

The app's "Excluir evento do auê" action (event detail, "Mais" menu) calls
this route. It mutates the catalog every user sees, so it is founder-only:
a curator (who can correct an event) and a stranger must both be refused,
and the event must still be there after a refused call.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

FOUNDER = "founder@example.com"
CURATOR = "curator@example.com"
EVENT_ID = "instagram_ig_barfolia_DEL1"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main", "enrichment"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO curators (email, added_by_email, added_at, notes,"
            " is_founder, is_curator, is_feedbacker) VALUES (?,?,?,?,1,1,1)",
            (FOUNDER, "system", datetime.now(timezone.utc).isoformat(), "test"),
        )
        conn.commit()
    _db.add_curator(email=CURATOR, added_by_email=FOUNDER, notes="test")
    from _session import SessionClient
    return _db, SessionClient(_main.app, _db)


def _make_event(_db):
    from models import EnrichedEvent
    _db.upsert_event(EnrichedEvent(
        id=EVENT_ID, source="instagram", external_id="ig_barfolia_DEL1",
        name="Samba do Folia", description="Festa de samba",
        venue_name="Bar Folia", venue_address="", neighborhood="Agua Verde",
        city="Curitiba",
        date_start=datetime.now(timezone.utc) + timedelta(days=10), date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="\U0001F91D",
        has_food=True, is_low_pressure=False, is_curated=True,
        pitch="", price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        url="https://instagram.com/p/DEL1/", image_url=None,
        fetched_at=datetime.now(timezone.utc),
    ))


def _delete(client, email, event_id=EVENT_ID):
    return client.delete(f"/admin/events/{event_id}?requesting_email={email}")


def test_founder_deletes_catalog_event(api):
    _db, client = api
    _make_event(_db)
    r = _delete(client, FOUNDER)
    assert r.status_code == 200
    assert r.json() == {"ok": True, "event_id": EVENT_ID}
    assert _db.get_event_by_id(EVENT_ID) is None


def test_curator_cannot_delete(api):
    _db, client = api
    _make_event(_db)
    assert _delete(client, CURATOR).status_code == 403
    assert _db.get_event_by_id(EVENT_ID) is not None


def test_stranger_cannot_delete(api):
    _db, client = api
    _make_event(_db)
    assert _delete(client, "nobody@example.com").status_code == 403
    assert _db.get_event_by_id(EVENT_ID) is not None


def test_anonymous_cannot_delete(api):
    _db, client = api
    _make_event(_db)
    assert client.delete(f"/admin/events/{EVENT_ID}").status_code == 401
    assert _db.get_event_by_id(EVENT_ID) is not None


def test_unknown_event_is_404(api):
    _db, client = api
    assert _delete(client, FOUNDER, "instagram_ig_nope_X").status_code == 404
