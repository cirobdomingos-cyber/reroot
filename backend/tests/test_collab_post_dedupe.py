"""
A collab post is one post, whichever profile it was fetched from.

Context (23 Sep 2026): Angra on the 25th sat five times in auê Rock.
Two of the rows were the same Instagram post — `DdZOX_IKAkV` — filed
once as `ig_torkandroll_…` and once as `ig_entrelike_…`, because the
scraper files a post under the tracked profile it fetched it from and a
collab shows on both. The shortcode is unique to the post, so the tail
after the handle identifies it whoever posted it.

What must hold:
  1. The same post arriving under a second tracked handle is not
     written: route_scraped_event says 'duplicate'.
  2. A lineup suffix is part of the identity: the 26th's event of the
     post under handle B duplicates only the 26th's under handle A.
  3. Shortcodes with underscores don't confuse the handle split.
  4. A different post from the same venue is, of course, published.
"""
import sys
from datetime import datetime, timezone
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
    for h in ("torkandroll", "entrelike", "tork"):   # "tork" is a prefix of "torkandroll"
        _db.upsert_ig_account(h, added_by_email="t@example.com")
    return _db


def _scraped(handle, code, suffix=""):
    from models import EnrichedEvent
    ext = f"ig_{handle}_{code}{suffix}"
    return EnrichedEvent(
        id=f"instagram_{ext}", source="instagram", external_id=ext,
        name="Angra - Holy Land", description="", venue_name="Tork n' Roll",
        venue_address="", neighborhood="Rebouças", city="Curitiba",
        date_start=datetime(2099, 9, 25, 21, 0, tzinfo=timezone.utc), date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="C",
        has_food=True, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="free", vibe_summary="", expected_size="large",
        header_gradient="g", url=f"https://instagram.com/p/{code}/", image_url=None,
        fetched_at=datetime.now(timezone.utc), genre="rock", tipo="show",
    )


def test_the_same_post_under_a_second_handle_is_a_duplicate(db):
    assert db.route_scraped_event(_scraped("torkandroll", "DdZOX_IKAkV")) == "published"
    assert db.route_scraped_event(_scraped("entrelike", "DdZOX_IKAkV")) == "duplicate"
    assert db.count_events() == 1


def test_the_lineup_suffix_is_part_of_the_identity(db):
    db.route_scraped_event(_scraped("torkandroll", "DdZOX_IKAkV"))
    db.route_scraped_event(_scraped("torkandroll", "DdZOX_IKAkV", "-0926"))
    assert db.route_scraped_event(_scraped("entrelike", "DdZOX_IKAkV", "-0926")) == "duplicate"
    assert db.route_scraped_event(_scraped("entrelike", "DdZOX_IKAkV", "-0927")) == "published"


def test_a_shortcode_with_underscores_and_a_prefix_handle_do_not_confuse_the_split(db):
    # "tork" is tracked and is a prefix of "torkandroll": the longest
    # tracked handle that prefixes the id wins, and the tail is exactly
    # "_DdZOX_IKAkV" — not "_DdZOX" or "androll_DdZOX_IKAkV".
    assert db.find_same_post_under_other_handle("ig_torkandroll_DdZOX_IKAkV") is None
    db.route_scraped_event(_scraped("torkandroll", "DdZOX_IKAkV"))
    assert db.find_same_post_under_other_handle("ig_entrelike_DdZOX_IKAkV") == "instagram_ig_torkandroll_DdZOX_IKAkV"
    assert db.find_same_post_under_other_handle("ig_entrelike_IKAkV") is None


def test_a_different_post_from_the_same_venue_is_published(db):
    db.route_scraped_event(_scraped("torkandroll", "DdZOX_IKAkV"))
    assert db.route_scraped_event(_scraped("torkandroll", "DdomGnyC24f")) == "published"
    assert db.route_scraped_event(_scraped("entrelike", "DdomGnyC24f")) == "duplicate"
