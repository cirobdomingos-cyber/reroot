"""
Tests for a private event staying tied to the Instagram post it came from.

Context: pasting an IG link in a group created a group_events row holding
one client-side parse of that post — often the wrong time, the handle in
the venue line, no cover image — while the catalog held the same post,
scraped and enriched. Two cards for one night out, disagreeing, with no
way for the private one to ever improve.

What must hold:
  1. The catalog's copy of a post is findable by shortcode, whichever way
     it got there (curator-approved suggestion vs. tracked-handle scrape).
  2. A field a human edited is pinned and stops following the source.
  3. Editing one field doesn't pin the others.
"""
import json
import sys
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


def _catalog_row(db, event_id, external_id, source="instagram"):
    """Insert a catalog row directly — upsert_event wants a full
    EnrichedEvent and this only needs id/source/external_id."""
    with db.get_conn() as conn:
        conn.execute(
            "INSERT INTO events (id, source, external_id, payload, fetched_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (event_id, source, external_id, json.dumps({"id": event_id}), "2026-09-01T00:00:00"),
        )
        conn.commit()


def test_finds_a_post_the_scraper_brought_in(db):
    _catalog_row(db, "ig_sambacasaforte_ABC123xyz", "ig_sambacasaforte_ABC123xyz")
    assert db.find_catalog_event_id_by_shortcode("ABC123xyz") == "ig_sambacasaforte_ABC123xyz"


def test_finds_a_post_a_curator_approved(db):
    _catalog_row(db, "submitted_igpost_ABC123xyz", "whatever")
    assert db.find_catalog_event_id_by_shortcode("ABC123xyz") == "submitted_igpost_ABC123xyz"


def test_handles_with_underscores_and_dots_still_match(db):
    """The old split-on-underscore approach mangled these."""
    _catalog_row(db, "e1", "ig_curiti.kids_ZZZ999")
    assert db.find_catalog_event_id_by_shortcode("ZZZ999") == "e1"
    _catalog_row(db, "e2", "ig_damarate_confeitaria_YYY888")
    assert db.find_catalog_event_id_by_shortcode("YYY888") == "e2"


def test_unknown_shortcode_finds_nothing(db):
    assert db.find_catalog_event_id_by_shortcode("NOPE") == ""
    assert db.find_catalog_event_id_by_shortcode("") == ""


def test_editing_a_field_pins_it(db):
    ev = db.create_group_event(
        group_id=None, google_id="host", name="Samba",
        date_start="2026-12-01T21:00:00", extra_invitee_ids=["ana"],
    )
    assert db.get_group_event(ev["id"])["edited_fields"] == []
    db.update_group_event(ev["id"], {"date_start": "2026-12-01T18:00:00"})
    row = db.get_group_event(ev["id"])
    assert row["edited_fields"] == ["date_start"], "the group's own time is theirs to keep"
    assert row["date_start"] == "2026-12-01T18:00:00"


def test_editing_one_field_leaves_the_others_following(db):
    ev = db.create_group_event(
        group_id=None, google_id="host", name="Samba",
        date_start="2026-12-01T21:00:00",
    )
    db.update_group_event(ev["id"], {"note": "levar canga"})
    db.update_group_event(ev["id"], {"venue": "Casa Forte"})
    row = db.get_group_event(ev["id"])
    assert row["edited_fields"] == ["note", "venue"]
    assert "name" not in row["edited_fields"]
    assert "date_start" not in row["edited_fields"]
