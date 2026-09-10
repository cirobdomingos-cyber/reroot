"""
Tests for the IG extraction ledger — the dedup layer that stops us paying
Claude to re-extract the same Instagram posts on every scrape.

Run: py -3.12 -m pytest backend/tests/ -v   (from the repo root)

The behaviours worth pinning down:
  1. A post is extracted once; later runs skip it.
  2. Posts that were NOT events are remembered too — they are the majority,
     and forgetting them is what made the pipeline re-bill them daily.
  3. A post whose extraction errored (no answer from the model) is NOT
     recorded, so a credit outage doesn't permanently burn the backlog.
  4. Manual single-handle scrape bypasses the ledger (it's a rebuild).
  5. Handle bookkeeping still runs for handles whose posts were all skipped,
     or their last_post_shortcode freezes and the probe stops seeing them.
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "scrapers"))


@pytest.fixture()
def db(monkeypatch):
    """Fresh SQLite file per test."""
    os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp()) / "t.db")
    for mod in ("database", "scrapers.instagram_apify"):
        sys.modules.pop(mod, None)
    import database as _db
    _db.init_db()
    return _db


def _post(handle, shortcode, caption="Show da banda no bar hoje as 21h, entrada 20 reais"):
    return {
        "ownerUsername": handle,
        "url": f"https://www.instagram.com/p/{shortcode}/",
        "id": shortcode,
        "caption": caption,
        "timestamp": "2026-09-10T12:00:00Z",
        "displayUrl": None,          # no image -> no network in tests
        "likesCount": 10,
    }


def _run(coro):
    return asyncio.run(coro)


def _setup_module(monkeypatch, db, posts, extract_impl):
    """Wire a fake Apify + fake Claude into the scraper module."""
    import scrapers.instagram_apify as ig

    db.upsert_ig_account(handle="cafe", label="Cafe", category="cafe", added_by_email="t")

    async def fake_scrape(token, urls, posts_per_account):
        # probe call asks for 1 post/account; full call asks for more
        if posts_per_account == 1:
            return posts[:1]
        return posts

    monkeypatch.setattr(ig, "_run_apify_scrape", fake_scrape)
    monkeypatch.setattr(ig, "_enrich_profiles", lambda *a, **k: _noop())
    monkeypatch.setattr(ig, "_extract_event", extract_impl)
    return ig


async def _noop():
    return None


def test_second_run_skips_already_extracted_posts(db, monkeypatch):
    """The core saving: same posts back from Apify, zero Claude calls."""
    from models import RawEvent
    from datetime import datetime, timezone

    calls = []

    async def extract(client, post, today, failed_out=None):
        calls.append(post["id"])
        return RawEvent(
            source="instagram",
            external_id=f"ig_{post['ownerUsername']}_{post['id']}",
            name="Show", description="d",
            venue_name="Bar", venue_address="Centro", city="Curitiba",
            date_start=datetime(2026, 12, 1, 21, tzinfo=timezone.utc),
            price_min=20, price_max=20,
            url=post["url"],
        )

    posts = [_post("cafe", "AAA"), _post("cafe", "BBB")]
    ig = _setup_module(monkeypatch, db, posts, extract)

    ev1 = _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    assert len(ev1) == 2, "first run should extract both posts"
    assert sorted(calls) == ["AAA", "BBB"]

    calls.clear()
    ev2 = _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    assert calls == [], f"second run must make zero Claude calls, made {calls}"
    assert ev2 == []


def test_non_events_are_remembered(db, monkeypatch):
    """Posts that aren't events are the majority — they must not re-bill."""
    calls = []

    async def extract(client, post, today, failed_out=None):
        calls.append(post["id"])
        return None  # a real verdict: "not an event"

    posts = [_post("cafe", "AAA"), _post("cafe", "BBB")]
    ig = _setup_module(monkeypatch, db, posts, extract)

    _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    assert sorted(calls) == ["AAA", "BBB"]

    calls.clear()
    _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    assert calls == [], "non-event verdicts must be remembered, not re-asked"
    assert db.count_processed_ig_posts()["total"] == 2


def test_api_failures_are_retried_not_burned(db, monkeypatch):
    """A credit outage must not permanently consume the backlog."""
    calls = []

    async def failing(client, post, today, failed_out=None):
        calls.append(post["id"])
        if failed_out is not None:
            failed_out.add(post["id"])   # simulates the API-error path
        return None

    posts = [_post("cafe", "AAA"), _post("cafe", "BBB")]
    ig = _setup_module(monkeypatch, db, posts, failing)

    _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    assert sorted(calls) == ["AAA", "BBB"]
    assert db.count_processed_ig_posts()["total"] == 0, \
        "failed extractions must not be written to the ledger"

    calls.clear()
    _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    assert sorted(calls) == ["AAA", "BBB"], "failed posts must be retried next run"


def test_manual_scrape_bypasses_ledger(db, monkeypatch):
    """/admin/ig-accounts/{h}/scrape is a rebuild — it re-reads everything."""
    calls = []

    async def extract(client, post, today, failed_out=None):
        calls.append(post["id"])
        return None

    posts = [_post("cafe", "AAA")]
    ig = _setup_module(monkeypatch, db, posts, extract)

    _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    calls.clear()
    _run(ig.fetch_events(anthropic_api_key="k", apify_token="t", handles=["cafe"]))
    assert calls == ["AAA"], "manual mode must ignore the ledger"


def test_handle_bookkeeping_survives_full_skip(db, monkeypatch):
    """Handles whose posts were all skipped must still be marked scraped."""
    async def extract(client, post, today, failed_out=None):
        return None

    posts = [_post("cafe", "AAA")]
    ig = _setup_module(monkeypatch, db, posts, extract)

    _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    db.set_ig_account_last_post_shortcode("cafe", "")   # force a re-fetch
    _run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))

    acc = db.get_ig_account("cafe")
    assert acc["last_scraped_at"], "last_scraped_at must be set even on a full skip"
    assert acc["last_post_shortcode"] == "AAA", \
        "shortcode must advance, or the probe freezes this handle forever"
