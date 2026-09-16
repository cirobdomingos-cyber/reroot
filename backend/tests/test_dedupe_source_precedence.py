"""
Tests for which copy of the same event survives dedup.

Context: the same night often reaches the catalog twice — the venue posts
it on Instagram and someone also submits it by hand (or a curator approves
a suggestion). _dedupe_events keeps the first row it sees, and nothing
ordered the input by source, so whichever happened to be inserted first
won. In practice that was the submission: a curator approves it before the
next scrape runs, so its row lands first. The catalog then showed a
hand-typed snapshot instead of the venue's own post, which is re-scraped
and re-enriched daily and carries the real time and description.

What must hold:
  1. The venue's own IG post beats a manual submission of the same night,
     whichever order they arrive in.
  2. aue_original (hand-curated institutional) beats both.
  3. A curator repost still loses to the venue's post — this was already
     true via a pre-sort and must not regress.
  4. A submission with no IG counterpart survives; there is nothing for it
     to lose to.
  5. Tier 2.5 still collapses multiple sessions of one event to the
     earliest, which is what the date_start secondary sort protects.
"""
import sys
from datetime import datetime
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def main(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    # Curator status is normally a DB lookup over tracked handles; pin it
    # so these tests state their own world instead of seeding accounts.
    monkeypatch.setattr(_main, "_curator_ig_handles_cached", lambda: {"curadorx"})
    return _main


def _ev(source, external_id, name="Show da Terno Rei", hour=21, venue="MACRO"):
    from models import EnrichedEvent
    return EnrichedEvent(
        id=f"{source}_{external_id}", source=source, external_id=external_id,
        name=name, description="", venue_name=venue,
        venue_address="", neighborhood="Centro", city="Curitiba",
        date_start=datetime(2026, 9, 18, hour, 0), date_end=None,
        price_min=0, price_max=0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="🎉",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="free", vibe_summary="", expected_size="large",
        header_gradient="", url="", image_url="", fetched_at=datetime(2026, 9, 1),
    )


def test_the_venues_post_beats_a_submission(main):
    submitted = _ev("submitted", "igpost_ABC123")
    venue = _ev("instagram", "ig_bardosax_ABC123")
    kept = main._dedupe_events([submitted, venue])
    assert len(kept) == 1
    assert kept[0].source == "instagram"


def test_it_wins_from_either_arrival_order(main):
    """The bug was that insertion order decided this."""
    submitted = _ev("submitted", "igpost_ABC123")
    venue = _ev("instagram", "ig_bardosax_ABC123")
    assert main._dedupe_events([venue, submitted])[0].source == "instagram"
    assert main._dedupe_events([submitted, venue])[0].source == "instagram"


def test_aue_original_beats_the_venues_post(main):
    original = _ev("aue_original", "aue_001")
    venue = _ev("instagram", "ig_bardosax_ABC123")
    kept = main._dedupe_events([venue, original])
    assert len(kept) == 1
    assert kept[0].source == "aue_original"


def test_a_curator_repost_still_loses_to_the_venue(main):
    """Already true before via the (is_curator, date_start) pre-sort."""
    curator = _ev("instagram", "ig_curadorx_ABC123")
    venue = _ev("instagram", "ig_bardosax_ABC123")
    kept = main._dedupe_events([curator, venue])
    assert len(kept) == 1
    assert kept[0].external_id == "ig_bardosax_ABC123"


def test_a_curator_repost_still_beats_a_submission(main):
    curator = _ev("instagram", "ig_curadorx_ABC123")
    submitted = _ev("submitted", "igpost_ABC123")
    kept = main._dedupe_events([curator, submitted])
    assert len(kept) == 1, "same night, still one row"
    assert kept[0].source == "submitted", \
        "a repost is the least authoritative copy of someone else's night"


def test_a_submission_with_no_ig_post_survives(main):
    submitted = _ev("submitted", "igpost_ABC123")
    other = _ev("instagram", "ig_bardosax_ZZZ999", name="Sarau de Quinta", venue="Ateliê")
    kept = main._dedupe_events([submitted, other])
    assert len(kept) == 2
    assert {e.source for e in kept} == {"submitted", "instagram"}


def test_multiple_sessions_still_collapse_to_the_earliest(main):
    """date_start stays the secondary sort, so Tier 2.5 is unaffected."""
    late = _ev("instagram", "ig_bardosax_ABC123", name="Brasilidades 13 Anos", hour=19)
    early = _ev("instagram", "ig_bardosax_ABC124", name="Brasilidades 13 anos Festa", hour=15)
    kept = main._dedupe_events([late, early])
    assert len(kept) == 1
    assert kept[0].date_start.hour == 15
