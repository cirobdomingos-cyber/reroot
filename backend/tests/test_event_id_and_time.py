"""
Tests for reading a handle out of an event id, and for what "21h" means.

Two bugs that hid each other. A lineup post appends a suffix to the second
and later events' ids, and every reader pulled the handle out by underscore
position — so those events reported the handle "changes.cwb_ABC123", matched
no tracked account, and _is_active_source dropped them from the catalog.
The venue's own Painel kept listing them (it matches by prefix), which is
exactly how it looked from the app: the events exist, just not in Eventos.

And the extractor stamped the model's answer as UTC. The flyer says 21h and
means 21h in Curitiba, so every scraped event rendered three hours early.

What must hold:
  1. The handle survives every id shape, including the suffixed ones
     already written to the database with the old separator.
  2. Handles with underscores and dots still resolve.
  3. A scraped "21:00" is 21:00 in Curitiba, and stays on its own day.
"""
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    for h in ("changes.cwb", "damarate_confeitaria", "curiti.kids"):
        _db.upsert_ig_account(handle=h, label="", category="bar", added_by_email="t")
    _main._bust_handle_cache()
    return _db, _main


def _ev(external_id, source="instagram"):
    return SimpleNamespace(source=source, external_id=external_id)


def test_the_bare_id_resolves(env):
    _, main = env
    assert main._ig_handle_from_external_id("ig_changes.cwb_ABC123") == "changes.cwb"


def test_a_suffixed_id_resolves(env):
    """The second and third nights of a lineup post."""
    _, main = env
    assert main._ig_handle_from_external_id("ig_changes.cwb_ABC123-0918") == "changes.cwb"


def test_rows_already_written_with_the_old_separator_resolve(env):
    """The first scrape after the lineup change wrote "_0918" ids. Those
    are in the database now and must not stay invisible."""
    _, main = env
    assert main._ig_handle_from_external_id("ig_changes.cwb_ABC123_0918") == "changes.cwb"


def test_handles_with_underscores_and_dots_resolve(env):
    _, main = env
    assert main._ig_handle_from_external_id(
        "ig_damarate_confeitaria_XYZ789") == "damarate_confeitaria"
    assert main._ig_handle_from_external_id(
        "ig_damarate_confeitaria_XYZ789-0918") == "damarate_confeitaria"
    assert main._ig_handle_from_external_id("ig_curiti.kids_ZZZ111") == "curiti.kids"


def test_an_untracked_handle_still_parses(env):
    """A deleted account's rows shouldn't crash the reader — they just
    won't match an enabled handle downstream."""
    _, main = env
    assert main._ig_handle_from_external_id("ig_sumiu_ABC123") == "sumiu"
    assert main._ig_handle_from_external_id("ig_sumiu_ABC123-0918") == "sumiu"


def test_garbage_ids_are_empty_not_wrong(env):
    _, main = env
    assert main._ig_handle_from_external_id("") == ""
    assert main._ig_handle_from_external_id("instagram_no_prefix") == ""
    assert main._ig_handle_from_external_id("ig_nounderscore") == ""


def test_every_night_of_a_lineup_stays_in_the_catalog(env):
    """The bug, end to end: the Painel listed them, Eventos didn't."""
    _, main = env
    for ext in ("ig_changes.cwb_ABC123",
                "ig_changes.cwb_ABC123-0918",
                "ig_changes.cwb_ABC123_0918"):
        assert main._is_active_source(_ev(ext)), f"{ext} dropped from the catalog"


def test_a_disabled_handle_is_still_dropped(env):
    """The filter has a job — don't fix the false negative by making it
    stop working."""
    db, main = env
    db.upsert_ig_account(handle="changes.cwb", label="", category="bar",
                         enabled=False, added_by_email="t")
    main._bust_handle_cache()
    assert not main._is_active_source(_ev("ig_changes.cwb_ABC123"))
    assert not main._is_active_source(_ev("ig_changes.cwb_ABC123-0918"))


# ── "21h" means 21h in Curitiba ────────────────────────────

def test_a_scraped_time_is_curitiba_wall_clock():
    import scrapers.instagram_apify as ig
    dt = ig._parse_iso("2026-09-17T21:00:00")
    assert dt.strftime("%H:%M") == "21:00"
    assert dt.utcoffset().total_seconds() == -3 * 3600, "Curitiba, not UTC"


def test_an_evening_event_stays_on_its_own_day_in_the_payload():
    """The date filters compare substr(date_start, 1, 10). A 21h show must
    not drift to the next day once serialized."""
    import json
    import scrapers.instagram_apify as ig
    from models import EnrichedEvent
    dt = ig._parse_iso("2026-09-17T21:00:00")
    ev = EnrichedEvent(
        id="x", source="instagram", external_id="x", name="n", description="",
        venue_name="v", venue_address="", neighborhood="", city="Curitiba",
        date_start=dt, date_end=None, price_min=0, price_max=0, currency="BRL",
        capacity=None, kind="community", category_label="c", category_emoji="x",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="free", vibe_summary="", expected_size="large",
        header_gradient="", url="", image_url=None, fetched_at=datetime(2026, 9, 1),
    )
    stored = json.loads(ev.model_dump_json())["date_start"]
    assert stored.startswith("2026-09-17"), f"drifted off its day: {stored}"
    assert "21:00" in stored
