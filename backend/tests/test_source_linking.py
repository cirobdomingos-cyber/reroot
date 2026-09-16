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
    """Submission-only: nothing else claims this post, so it resolves."""
    _catalog_row(db, "submitted_igpost_ABC123xyz", "whatever")
    assert db.find_catalog_event_id_by_shortcode("ABC123xyz") == "submitted_igpost_ABC123xyz"


def test_the_venues_own_post_wins_when_both_exist(db):
    """The same post can be in the catalog twice: approved from a
    suggestion AND picked up by the scrape of the tracked handle. The
    scraped row is the one that keeps getting refreshed, so a private
    event linked to it follows the real time and description instead of
    whatever the snapshot said once."""
    _catalog_row(db, "submitted_igpost_ABC123xyz", "whatever")
    _catalog_row(db, "ig_bardosax_ABC123xyz", "ig_bardosax_ABC123xyz")
    assert db.find_catalog_event_id_by_shortcode("ABC123xyz") == "ig_bardosax_ABC123xyz"


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


# ── "Adicionado" tem que ser sobre ESTE evento ──────────────
# find_group_event_by_source's legacy fallback matched any event from the
# same venue handle in the same group, ignoring the date. Its docstring
# claimed handle + date the whole time. A bar posts a dozen events and a
# group collects them, so every later event from a venue already in the
# group showed "Adicionado · toque pra remover" for a fork that was never
# there — and the remove button sent you to the group to delete nothing.


def _ig_catalog_event(db, handle, shortcode, day):
    from datetime import datetime
    from models import EnrichedEvent
    ev = EnrichedEvent(
        id=f"instagram_ig_{handle}_{shortcode}", source="instagram",
        external_id=f"ig_{handle}_{shortcode}",
        name=f"Show {shortcode}", description="", venue_name="MACRO",
        venue_address="", neighborhood="Centro", city="Curitiba",
        date_start=datetime.fromisoformat(f"{day}T21:00:00"), date_end=None,
        price_min=0, price_max=0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="🎉",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="free", vibe_summary="", expected_size="large",
        header_gradient="", url=f"https://instagram.com/p/{shortcode}/",
        image_url="", fetched_at=datetime(2026, 9, 1),
    )
    db.upsert_event(ev)
    return ev.id


def test_another_night_at_the_same_bar_is_not_already_added(db):
    """The bug: adding Friday's show marked Saturday's as added too."""
    group = db.create_group(google_id="host", name="Curitiba na real")
    friday = _ig_catalog_event(db, "macrobarepista", "AAA111", "2026-09-18")
    saturday = _ig_catalog_event(db, "macrobarepista", "BBB222", "2026-09-19")
    # A legacy fork: same handle, no source_event_id (pre-migration row).
    db.create_group_event(
        group_id=group["id"], google_id="host", name="Show AAA111",
        date_start="2026-09-18T21:00:00", source_ig_handle="macrobarepista",
    )
    assert db.find_group_event_by_source(group["id"], friday), "that one IS in the group"
    assert not db.find_group_event_by_source(group["id"], saturday), \
        "a different night at the same bar was never added"


def test_the_same_night_still_matches_a_legacy_fork(db):
    """The fallback still has to do its job for pre-migration rows."""
    group = db.create_group(google_id="host", name="Crew")
    src = _ig_catalog_event(db, "macrobarepista", "AAA111", "2026-09-18")
    db.create_group_event(
        group_id=group["id"], google_id="host", name="Show AAA111",
        date_start="2026-09-18T23:30:00", source_ig_handle="macrobarepista",
    )
    assert db.find_group_event_by_source(group["id"], src)


def test_a_group_without_the_venue_at_all_is_not_linked(db):
    group = db.create_group(google_id="host", name="Vazio")
    src = _ig_catalog_event(db, "macrobarepista", "AAA111", "2026-09-18")
    assert not db.find_group_event_by_source(group["id"], src)


def test_link_resolves_to_a_later_night_once_the_first_is_gone(db):
    """A lineup post produces one row per night: the earliest keeps the bare
    id, the rest are date-suffixed. After the first night passes and is
    pruned, pasting that post's link must still find the event."""
    _catalog_row(db, "e_sex", "ig_changes.cwb_ABC123-0918")
    _catalog_row(db, "e_sab", "ig_changes.cwb_ABC123-0919")
    assert db.find_catalog_event_id_by_shortcode("ABC123") == "e_sex", \
        "falls back to the earliest surviving night"


def test_the_bare_id_still_wins_when_it_exists(db):
    _catalog_row(db, "e_qui", "ig_changes.cwb_ABC123")
    _catalog_row(db, "e_sex", "ig_changes.cwb_ABC123-0918")
    assert db.find_catalog_event_id_by_shortcode("ABC123") == "e_qui"
