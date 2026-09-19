"""
Tests for POST /admin/events/backfill-genre.

Context: `genre` ships per event from the enrichment pass, but events
scraped before the field existed carry nothing, and the catalog only
re-tags as it turns over. Measured 19 Sep 2026: 32 of 128 upcoming
events had a tag. A channel assembled from tags alone would have opened
with six events, which is why this reverses the earlier "no genre
backfill" decision — for upcoming events only. History stays untouched,
because that part of the original reasoning still holds.

What must hold:
  1. Only upcoming, untagged events are considered. Past events and
     already-tagged ones cost money for nothing.
  2. A genre a curator set by hand is never reconsidered.
  3. The fill does NOT pin. edited_fields means "a human decided this";
     freezing a machine guess would block a future enrichment pass from
     improving it — and would make the curator's own pin meaningless.
  4. Only vocabulary genres are written, and an id the model didn't
     answer for is left alone rather than blanked.
  5. dry_run spends nothing.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

FOUNDER = "founder@example.com"
SOON = datetime.now(timezone.utc) + timedelta(days=10)
LONG_PAST = datetime.now(timezone.utc) - timedelta(days=60)


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-used")
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
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _event(_db, ev_id, *, name="Show", genre="", when=SOON, description="rock a noite toda"):
    from models import EnrichedEvent
    _db.upsert_event(EnrichedEvent(
        id=ev_id, source="instagram", external_id=ev_id.split("_", 1)[1],
        name=name, description=description, venue_name="Bar X", venue_address="",
        neighborhood="Batel", city="Curitiba",
        date_start=when, date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="C",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="g", url="u", image_url=None,
        fetched_at=datetime.now(timezone.utc), genre=genre,
    ))


def _stub_classifier(main, mapping, calls=None):
    """Replace the Claude call with a fixed answer."""
    import enrichment

    class _Fake(enrichment.EnrichmentPipeline):
        def __init__(self, *a, **kw):
            pass

        def classify_genres(self, events, batch_size=25):
            if calls is not None:
                calls.append([e["id"] for e in events])
            return {e["id"]: mapping[e["id"]] for e in events if e["id"] in mapping}

    enrichment.EnrichmentPipeline = _Fake
    return _Fake


# -- 1. only upcoming and untagged are considered --------------------

def test_only_untagged_upcoming_events_are_considered(api):
    _db, _main, _client = api
    _event(_db, "instagram_a")                                  # in
    _event(_db, "instagram_b", genre="rock")                    # already tagged
    _event(_db, "instagram_c", when=LONG_PAST)                  # past
    ids = {e["id"] for e in _db.list_events_needing_genre()}
    assert ids == {"instagram_a"}


def test_dry_run_reports_without_spending(api):
    _db, main, client = api
    _event(_db, "instagram_a", name="Baile do Rock")
    calls = []
    _stub_classifier(main, {}, calls)
    r = client.post(f"/admin/events/backfill-genre?requesting_email={FOUNDER}&dry_run=true")
    assert r.status_code == 200
    assert r.json()["would_tag"] == 1
    assert "Baile do Rock" in r.json()["sample"]
    assert calls == [], "dry_run must not call the model"


# -- 2. a curator's genre is never reconsidered ----------------------

def test_a_hand_set_genre_is_left_alone(api):
    _db, _main, client = api
    _event(_db, "instagram_a")
    # A curator sets it, then clears it — genre is now pinned as "".
    client.patch("/admin/events/instagram_a",
                 json={"requesting_email": FOUNDER, "genre": "mpb"})
    client.patch("/admin/events/instagram_a",
                 json={"requesting_email": FOUNDER, "genre": ""})
    assert "genre" in _db.get_catalog_edited_fields("instagram_a")
    assert _db.list_events_needing_genre() == []


# -- 3. the fill does not pin ----------------------------------------

def test_backfill_does_not_pin_the_value(api):
    _db, main, client = api
    _event(_db, "instagram_a")
    _stub_classifier(main, {"instagram_a": "rock"})
    r = client.post(f"/admin/events/backfill-genre?requesting_email={FOUNDER}")
    assert r.status_code == 200
    assert _db.get_event_by_id("instagram_a").genre == "rock"
    assert _db.get_catalog_edited_fields("instagram_a") == [], \
        "a machine fill must not look like a human decision"


def test_a_backfilled_genre_still_refreshes_on_a_rescrape(api):
    """The consequence of not pinning, stated as a behaviour."""
    _db, main, client = api
    _event(_db, "instagram_a")
    _stub_classifier(main, {"instagram_a": "rock"})
    client.post(f"/admin/events/backfill-genre?requesting_email={FOUNDER}")
    _event(_db, "instagram_a", genre="samba_pagode")   # re-scrape knows better
    assert _db.get_event_by_id("instagram_a").genre == "samba_pagode"


# -- 4. only real genres, and silence means "leave it" ---------------

def test_an_event_the_model_skipped_is_left_untagged(api):
    _db, main, client = api
    _event(_db, "instagram_a")
    _event(_db, "instagram_b")
    _stub_classifier(main, {"instagram_a": "rock"})     # b unanswered
    r = client.post(f"/admin/events/backfill-genre?requesting_email={FOUNDER}")
    body = r.json()
    assert body["tagged"] == 1
    assert body["considered"] == 2
    assert body["left_untagged"] == 1
    assert _db.get_event_by_id("instagram_b").genre == ""


def test_invented_genres_never_reach_the_database(api):
    """classify_genres runs every answer through _clean_genre, so an
    improvised label is dropped rather than stored. One wrong label puts
    sertanejo in Rockzão, which is the failure the tag exists to avoid."""
    _db, _main, _client = api
    import enrichment
    assert enrichment._clean_genre("axé paulista") == ""
    assert enrichment._clean_genre("nenhum") == ""
    assert enrichment._clean_genre("ROCK") == "rock"


def test_counts_are_reported_by_genre(api):
    _db, main, client = api
    _event(_db, "instagram_a")
    _event(_db, "instagram_b")
    _event(_db, "instagram_c")
    _stub_classifier(main, {
        "instagram_a": "rock", "instagram_b": "rock", "instagram_c": "forro",
    })
    body = client.post(f"/admin/events/backfill-genre?requesting_email={FOUNDER}").json()
    assert body["by_genre"] == {"rock": 2, "forro": 1}


# -- 5. permission and bounds ----------------------------------------

def test_a_curator_who_is_not_founder_cannot_spend_money(api):
    _db, main, client = api
    _db.add_curator(email="c@e.com", added_by_email=FOUNDER, notes="")
    _event(_db, "instagram_a")
    r = client.post("/admin/events/backfill-genre?requesting_email=c@e.com")
    assert r.status_code in (401, 403)


def test_limit_bounds_the_spend(api):
    _db, main, client = api
    for i in range(5):
        _event(_db, f"instagram_e{i}")
    assert len(_db.list_events_needing_genre(limit=2)) == 2


# -- classify_genres itself: parsing, batching, id guard -------------
#
# The endpoint tests above stub this method out, so the parsing it does
# on the model's reply is only covered here. That reply is the untrusted
# part: it arrives as text, may be fenced in markdown, may invent a
# genre, and may name an id from another batch.

class _FakeResponse:
    def __init__(self, text):
        self.content = [type("Block", (), {"text": text})()]
        self.usage = type("Usage", (), {"input_tokens": 1, "output_tokens": 1})()


def _pipeline_returning(*replies):
    """An EnrichmentPipeline whose Claude client replies with the given
    texts, one per batch, in order."""
    import enrichment
    pipeline = enrichment.EnrichmentPipeline.__new__(enrichment.EnrichmentPipeline)
    remaining = list(replies)
    sent = []

    class _Messages:
        def create(self, **kw):
            sent.append(kw)
            return _FakeResponse(remaining.pop(0))

    pipeline.client = type("Client", (), {"messages": _Messages()})()
    return pipeline, sent


def _events(*ids):
    return [{"id": i, "name": i, "description": "", "venue_name": ""} for i in ids]


def test_classify_parses_a_plain_json_array(api):
    pipeline, _ = _pipeline_returning(
        '[{"id": "a", "genre": "rock"}, {"id": "b", "genre": "forro"}]'
    )
    assert pipeline.classify_genres(_events("a", "b")) == {"a": "rock", "b": "forro"}


def test_classify_survives_a_markdown_fence(api):
    pipeline, _ = _pipeline_returning('```json\n[{"id": "a", "genre": "mpb"}]\n```')
    assert pipeline.classify_genres(_events("a")) == {"a": "mpb"}


def test_classify_drops_nenhum_and_invented_genres(api):
    pipeline, _ = _pipeline_returning(
        '[{"id": "a", "genre": "nenhum"}, {"id": "b", "genre": "axé paulista"},'
        ' {"id": "c", "genre": "pop"}]'
    )
    assert pipeline.classify_genres(_events("a", "b", "c")) == {"c": "pop"}


def test_classify_ignores_an_id_that_was_not_in_the_batch(api):
    """A model that echoes an id from an earlier batch would otherwise
    retag an unrelated event."""
    pipeline, _ = _pipeline_returning(
        '[{"id": "a", "genre": "rock"}, {"id": "intruso", "genre": "sertanejo"}]'
    )
    assert pipeline.classify_genres(_events("a")) == {"a": "rock"}


def test_classify_skips_a_broken_batch_without_losing_the_others(api):
    pipeline, _ = _pipeline_returning(
        "desculpa, não consegui",                      # batch 1: not JSON
        '[{"id": "c", "genre": "rock"}]',              # batch 2: fine
    )
    out = pipeline.classify_genres(_events("a", "b", "c"), batch_size=2)
    assert out == {"c": "rock"}


def test_classify_batches_by_the_given_size(api):
    pipeline, sent = _pipeline_returning("[]", "[]", "[]")
    pipeline.classify_genres(_events("a", "b", "c", "d", "e"), batch_size=2)
    assert len(sent) == 3, "5 events at batch_size=2 should be 3 requests"


def test_classify_makes_no_call_for_an_empty_list(api):
    pipeline, sent = _pipeline_returning()
    assert pipeline.classify_genres([]) == {}
    assert sent == []
