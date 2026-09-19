"""
Tests for PATCH /admin/events/{id} — correcting a catalog event by hand.

Context: until now the only lever over a bad extraction was DELETE, which
throws away a real event because one field is wrong. The trigger was a
user reporting an event "in the wrong place" (Sep 2026); the bairro half
of that turned out to be systemic and is fixed elsewhere, but a wrong
venue NAME had no lever at all — production carries "Curitiba/PR" as a
venue name today.

The hard part isn't the write, it's making it stick. `upsert_event`
replaces the entire payload on every re-scrape, so a correction would
survive only until the next read of that Instagram post. `edited_fields`
records what a human set, and upsert_event replays it over the freshly
enriched payload.

What must hold:
  1. A curator can edit; a stranger can't.
  2. Derived fields follow their source — price_tier from price, and
     category label/emoji/gradient from kind — so they can't drift.
  3. Only the fields actually sent are pinned.
  4. A re-scrape keeps pinned fields and still refreshes everything else.
     This is the whole point of the feature.
  5. Invalid input is refused rather than written: bad dates, unknown
     category, unknown genre, empty name, negative or inverted price.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

CURATOR = "curator@example.com"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main", "enrichment"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    _db.add_curator(email=CURATOR, added_by_email="system", notes="test")
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _make_event(_db, **overrides):
    """Write a catalog event straight through upsert_event — the same
    path a scrape takes, so calling it twice IS a re-scrape."""
    from models import EnrichedEvent
    base = dict(
        id="instagram_ig_barfolia_ABC123",
        source="instagram",
        external_id="ig_barfolia_ABC123",
        name="Samba do Folia",
        description="Festa de samba",
        venue_name="Bar Folia",
        venue_address="",
        neighborhood="Agua Verde",
        city="Curitiba",
        date_start=datetime(2099, 9, 20, 18, 0, tzinfo=timezone.utc),
        date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="\U0001F91D",
        has_food=True, is_low_pressure=False, is_curated=True,
        pitch="", price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        url="https://instagram.com/p/ABC123/", image_url=None,
        fetched_at=datetime.now(timezone.utc),
        genre="samba_pagode",
    )
    base.update(overrides)
    ev = EnrichedEvent(**base)
    _db.upsert_event(ev)
    return ev


EVENT_ID = "instagram_ig_barfolia_ABC123"


def _patch(client, event_id, **body):
    return client.patch(
        f"/admin/events/{event_id}",
        json={"requesting_email": CURATOR, **body},
    )


# -- 1. permission ---------------------------------------------------

def test_curator_can_edit(api):
    _db, _main, client = api
    _make_event(_db)
    r = _patch(client, EVENT_ID, venue_name="Bar Folia (Reboucas)")
    assert r.status_code == 200
    assert r.json()["event"]["venue"].startswith("Bar Folia (Reboucas)")


def test_a_stranger_cannot_edit(api):
    _db, _main, client = api
    _make_event(_db)
    r = client.patch(
        f"/admin/events/{EVENT_ID}",
        json={"requesting_email": "nobody@example.com", "name": "Hijacked"},
    )
    assert r.status_code in (401, 403)
    assert _db.get_event_by_id(EVENT_ID).name == "Samba do Folia"


def test_unknown_event_is_404(api):
    _db, _main, client = api
    assert _patch(client, "instagram_ig_nope_X", name="X").status_code == 404


# -- 2. derived fields follow their source ---------------------------

@pytest.mark.parametrize("price,tier", [
    (0.0, "free"), (25.0, "low"), (50.0, "low"),
    (80.0, "medium"), (150.0, "medium"), (300.0, "high"),
])
def test_price_tier_is_derived_not_trusted(api, price, tier):
    _db, _main, client = api
    _make_event(_db)
    r = _patch(client, EVENT_ID, price_min=price, price_max=price)
    assert r.status_code == 200
    assert _db.get_event_by_id(EVENT_ID).price_tier == tier


def test_category_label_emoji_and_gradient_follow_kind(api):
    _db, _main, client = api
    _make_event(_db)
    r = _patch(client, EVENT_ID, kind="creative")
    assert r.status_code == 200
    ev = _db.get_event_by_id(EVENT_ID)
    assert ev.kind == "creative"
    assert ev.category_label == "Criativo"
    assert "E4EFE5" in ev.header_gradient


# -- 3. only what was sent gets pinned -------------------------------

def test_only_sent_fields_are_pinned(api):
    _db, _main, client = api
    _make_event(_db)
    _patch(client, EVENT_ID, venue_name="Bar Folia (Reboucas)")
    assert _db.get_catalog_edited_fields(EVENT_ID) == ["venue_name"]


def test_pins_accumulate_across_edits(api):
    _db, _main, client = api
    _make_event(_db)
    _patch(client, EVENT_ID, venue_name="Bar Folia (Reboucas)")
    _patch(client, EVENT_ID, name="Samba do Folia - edicao especial")
    assert _db.get_catalog_edited_fields(EVENT_ID) == ["name", "venue_name"]


def test_empty_body_is_refused(api):
    _db, _main, client = api
    _make_event(_db)
    assert _patch(client, EVENT_ID).status_code == 400


# -- 4. the point: edits survive a re-scrape -------------------------

def test_a_rescrape_keeps_the_correction_and_refreshes_the_rest(api):
    _db, _main, client = api
    _make_event(_db)
    _patch(client, EVENT_ID, venue_name="Bar Folia (Reboucas)")

    # The scraper reads the same post again and re-enriches from scratch:
    # it re-guesses the venue (wrongly) and picks up a real new fact.
    _make_event(_db, venue_name="Bar Folia", description="Agora com Canjao as 22h")

    ev = _db.get_event_by_id(EVENT_ID)
    assert ev.venue_name == "Bar Folia (Reboucas)", "the correction was overwritten"
    assert ev.description == "Agora com Canjao as 22h", "unedited fields must still refresh"


def test_an_untouched_event_is_fully_refreshed_by_a_rescrape(api):
    _db, _main, client = api
    _make_event(_db)
    _make_event(_db, venue_name="Bar Folia Reboucas", description="novo")
    ev = _db.get_event_by_id(EVENT_ID)
    assert ev.venue_name == "Bar Folia Reboucas"
    assert ev.description == "novo"


def test_a_pinned_field_that_no_longer_validates_does_not_lose_the_scrape(api):
    _db, _main, client = api
    _make_event(_db)
    _patch(client, EVENT_ID, name="Editado")
    # Corrupt the stored payload the way a model change would.
    with _db.get_conn() as conn:
        conn.execute(
            "UPDATE events SET payload = ? WHERE id = ?",
            (json.dumps({"name": None}), EVENT_ID),
        )
        conn.commit()
    _make_event(_db, description="scrape recente")
    ev = _db.get_event_by_id(EVENT_ID)
    assert ev is not None and ev.description == "scrape recente"


# -- 5. invalid input is refused, not written ------------------------

@pytest.mark.parametrize("body,field", [
    ({"date_start": "nao e data"}, "date_start"),
    ({"date_start": ""}, "date_start"),
    ({"name": "   "}, "name"),
    ({"venue_name": ""}, "venue_name"),
    ({"kind": "festa"}, "kind"),
    ({"genre": "axe_paulista"}, "genre"),
    ({"price_min": -5.0}, "price_min"),
    ({"price_min": 100.0, "price_max": 10.0}, "price_max"),
])
def test_invalid_input_is_refused(api, body, field):
    _db, _main, client = api
    before = _make_event(_db)
    r = _patch(client, EVENT_ID, **body)
    assert r.status_code == 400, f"{field} should have been refused"
    after = _db.get_event_by_id(EVENT_ID)
    assert after.name == before.name
    assert after.venue_name == before.venue_name


def test_genre_can_be_cleared(api):
    _db, _main, client = api
    _make_event(_db)
    assert _patch(client, EVENT_ID, genre="").status_code == 200
    assert _db.get_event_by_id(EVENT_ID).genre == ""


def test_date_end_can_be_cleared_but_date_start_cannot(api):
    _db, _main, client = api
    _make_event(_db, date_end=datetime(2099, 9, 21, 2, 0, tzinfo=timezone.utc))
    assert _patch(client, EVENT_ID, date_end="").status_code == 200
    assert _db.get_event_by_id(EVENT_ID).date_end is None
