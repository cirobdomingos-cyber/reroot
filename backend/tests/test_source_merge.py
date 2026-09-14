"""
Tests for a private event reading its facts from the catalog twin.

Context: _merge_source_event overlays the catalog event's current values
onto the private event made from the same Instagram post. It reads a
second row's shape, and the first version read `src.venue` — a field
EnrichedEvent doesn't have (it's venue_name) — so every linked event
raised AttributeError and the event screen answered 500. From the phone
that looks like "sem conexão com o servidor".

These are the first tests in the suite that import main.py. Everything
until now stopped at the database layer, which is exactly why a wrong
field name on a model boundary shipped.

What must hold:
  1. A linked event shows the catalog's name, venue, date and cover.
  2. A field someone edited stays theirs.
  3. A missing or broken source degrades to the stored copy, never a 500.
"""
import sys
from datetime import datetime
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Fresh DB + fresh module pair. main.py binds `db` at import time, so
    both have to be re-imported together or main keeps writing to the
    previous test's database."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    return _db, _main


def _catalog_event(db, shortcode="ABC123", name="Samba Casa Forte #40",
                   venue="Sociedade Operária", hour=21):
    from models import EnrichedEvent
    ev = EnrichedEvent(
        id=f"ig_samba_{shortcode}", source="instagram",
        external_id=f"ig_samba_{shortcode}",
        name=name, description="Samba na Sociedade",
        venue_name=venue, venue_address="", neighborhood="", city="Curitiba",
        date_start=datetime(2026, 12, 1, hour, 0), date_end=None,
        price_min=0, price_max=0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="🎉",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="free", vibe_summary="", expected_size="large",
        header_gradient="",
        url=f"https://instagram.com/p/{shortcode}/",
        image_url="https://cdn.example/img.jpg",
        fetched_at=datetime(2026, 9, 1),
    )
    db.upsert_event(ev)
    return ev.id


def _private_event(db, source_event_id="", **kw):
    return db.create_group_event(
        group_id=None, google_id="host",
        name=kw.get("name", "Samba Casa Forte #40"),
        venue=kw.get("venue", "curitibanareal"),
        date_start=kw.get("date_start", "2026-12-01T18:00:00"),
        description=kw.get("description", ""),
        extra_invitee_ids=["ana"],
        source_event_id=source_event_id,
    )


def test_linked_event_reads_the_catalog_not_its_own_snapshot(env):
    db, main = env
    src = _catalog_event(db)
    ge = _private_event(db, source_event_id=src)
    out = main._group_event_to_frontend(db.get_group_event(ge["id"]), viewer_google_id="ana")
    assert out["venue"] == "Sociedade Operária", "the handle was sitting in the venue line"
    assert out["dateStart"].startswith("2026-12-01T21:00"), "18:00 was a bad parse"
    assert out["imageUrl"] and "img.jpg" in out["imageUrl"], "the cover never pulled"
    assert out["sourceEventId"] == src


def test_an_edited_field_stays_the_groups(env):
    db, main = env
    src = _catalog_event(db)
    ge = _private_event(db, source_event_id=src)
    db.update_group_event(ge["id"], {"date_start": "2026-12-01T18:00:00"})
    out = main._group_event_to_frontend(db.get_group_event(ge["id"]), viewer_google_id="ana")
    assert out["dateStart"].startswith("2026-12-01T18:00"), "'a gente chega 18h' is theirs"
    # Everything they didn't touch still follows the catalog.
    assert out["venue"] == "Sociedade Operária"


def test_event_with_no_source_is_untouched(env):
    db, main = env
    ge = _private_event(db)
    out = main._group_event_to_frontend(db.get_group_event(ge["id"]), viewer_google_id="ana")
    assert out["venue"] == "curitibanareal"
    assert out["dateStart"].startswith("2026-12-01T18:00")


def test_dangling_source_falls_back_to_the_stored_copy(env):
    """The catalog row can be pruned. That's a stale card, not an error."""
    db, main = env
    ge = _private_event(db, source_event_id="ig_samba_GONE")
    out = main._group_event_to_frontend(db.get_group_event(ge["id"]), viewer_google_id="ana")
    assert out["venue"] == "curitibanareal"


def test_a_broken_source_never_takes_down_the_event(env, monkeypatch):
    db, main = env
    src = _catalog_event(db)
    ge = _private_event(db, source_event_id=src)
    monkeypatch.setattr(main, "_merge_source_event",
                        lambda _ge: (_ for _ in ()).throw(RuntimeError("boom")))
    out = main._group_event_to_frontend(db.get_group_event(ge["id"]), viewer_google_id="ana")
    assert out["name"], "a bad merge must degrade, not 500"
    assert out["venue"] == "curitibanareal"


def test_old_event_links_itself_from_the_post_url(env):
    """Rows made before the link existed carry only 'Ver original: <url>'."""
    db, main = env
    src = _catalog_event(db, shortcode="XYZ789")
    ge = _private_event(
        db, description="Bora\n\nVer original: https://www.instagram.com/p/XYZ789/",
    )
    assert db.get_group_event(ge["id"])["source_event_id"] == ""
    out = main._group_event_to_frontend(db.get_group_event(ge["id"]), viewer_google_id="ana")
    assert out["venue"] == "Sociedade Operária", "should have resolved its twin"
    assert db.get_group_event(ge["id"])["source_event_id"] == src, "and written it down"


def test_the_three_screens_that_went_down(env):
    """One AttributeError took out every screen that renders a private
    event: the group ("failed to load group"), the event detail and the
    user's event list (which fails silently, so Home just went empty).
    They all serialize through _group_event_to_frontend."""
    db, main = env
    src = _catalog_event(db)
    group = db.create_group(google_id="host", name="Crew")
    db.join_group(group["id"], "ana")
    db.create_group_event(
        group_id=group["id"], google_id="host", name="Samba",
        venue="curitibanareal", date_start="2026-12-01T18:00:00",
        extra_invitee_ids=["ana"], source_event_id=src,
    )
    for viewer in ("host", "ana"):
        out = main.get_group(group["id"], viewer)
        assert out["events"], f"group screen empty for {viewer}"
        assert out["events"][0]["venue"] == "Sociedade Operária"
    listed = main.list_user_group_events("ana")["events"]
    assert len(listed) == 1
    detail = main.get_event(listed[0]["id"], "ana")
    assert detail["venue"] == "Sociedade Operária"
