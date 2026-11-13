"""
Scrape cost controls: the cheap-skip path and adaptive probe frequency.

What must hold:
  1. get_enabled_ig_accounts returns last_post_shortcode / last_details_at,
     so an unchanged handle skips the full scrape and fresh profiles skip
     the details call (both were re-run daily: ~US$75/month of Apify).
  2. scrape_cadence: quiet handles slow to every 3 then 7 days; blocos stay
     daily until 2027-02-17; featured and never-probed handles stay daily.
  3. A handle that yields an event is reset to daily.
"""
import asyncio
import os
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "scrapers"))


@pytest.fixture()
def db():
    os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp()) / "t.db")
    for mod in ("database", "scrapers.instagram_apify", "scrape_cadence"):
        sys.modules.pop(mod, None)
    import database as _db
    _db.init_db()
    return _db


NOW = datetime(2026, 11, 13, 17, 0, tzinfo=timezone.utc)


def _acc(**kw):
    base = {"category": "bar", "featured": 0, "quiet_runs": 0, "last_probed_at": None}
    base.update(kw)
    return base


def test_enabled_accounts_expose_skip_state(db):
    db.upsert_ig_account(handle="casa", label="Casa", category="bar", added_by_email="t")
    db.set_ig_account_last_post_shortcode("casa", "ABC123")
    db.mark_ig_account_details_fresh("casa")
    acc = db.get_enabled_ig_accounts()[0]
    assert acc["last_post_shortcode"] == "ABC123"
    assert acc["last_details_at"]
    assert acc["quiet_runs"] == 0 and acc["last_probed_at"] is None


def test_interval_steps_with_quiet_runs(db):
    import scrape_cadence as c
    d = date(2026, 11, 13)
    assert c.interval_days(_acc(quiet_runs=0), d) == 1
    assert c.interval_days(_acc(quiet_runs=6), d) == 1
    assert c.interval_days(_acc(quiet_runs=7), d) == 3
    assert c.interval_days(_acc(quiet_runs=13), d) == 3
    assert c.interval_days(_acc(quiet_runs=14), d) == 7


def test_blocos_and_featured_stay_daily(db):
    import scrape_cadence as c
    assert c.interval_days(_acc(category="bloco", quiet_runs=30), date(2027, 2, 17)) == 1
    assert c.interval_days(_acc(category="bloco", quiet_runs=30), date(2027, 2, 18)) == 7
    assert c.interval_days(_acc(featured=1, quiet_runs=30), date(2026, 11, 13)) == 1


def test_is_due_respects_last_probe(db):
    import scrape_cadence as c
    quiet = _acc(quiet_runs=14)
    assert c.is_due(quiet, NOW)  # never probed
    quiet["last_probed_at"] = (NOW - timedelta(days=2)).isoformat()
    assert not c.is_due(quiet, NOW)
    quiet["last_probed_at"] = (NOW - timedelta(days=7)).isoformat()
    assert c.is_due(quiet, NOW)
    # daily handles are always due
    assert c.is_due(_acc(last_probed_at=NOW.isoformat()), NOW)


def test_record_probe_streak_and_reset(db):
    db.upsert_ig_account(handle="casa", label="Casa", category="bar", added_by_email="t")
    for _ in range(3):
        db.record_ig_probe("casa", False)
    acc = db.get_enabled_ig_accounts()[0]
    assert acc["quiet_runs"] == 3 and acc["last_probed_at"]
    db.record_ig_probe("casa", True)
    assert db.get_enabled_ig_accounts()[0]["quiet_runs"] == 0


def _wire(monkeypatch, ig, feed, scrape_calls, details_calls):
    async def fake_scrape(token, urls, posts_per_account):
        scrape_calls.append((list(urls), posts_per_account))
        return [p for p in feed if p["inputUrl"] in urls][: posts_per_account * len(urls)]

    async def fake_details(token, urls):
        details_calls.append(list(urls))

    async def no_events(*a, **k):
        return []

    monkeypatch.setattr(ig, "_run_apify_scrape", fake_scrape)
    monkeypatch.setattr(ig, "_enrich_profiles", fake_details)
    monkeypatch.setattr(ig, "_extract_events", no_events)


def _post(handle, code):
    return {
        "inputUrl": f"https://www.instagram.com/{handle}/", "ownerUsername": handle,
        "url": f"https://www.instagram.com/p/{code}/", "id": code, "isPinned": False,
        "timestamp": "2026-11-12T18:00:00Z", "caption": "x" * 40, "displayUrl": None,
    }


def test_second_run_skips_details_and_full_scrape_and_quiet_handle_slows(db, monkeypatch):
    import scrapers.instagram_apify as ig
    db.upsert_ig_account(handle="casa", label="Casa", category="bar", added_by_email="t")
    scrape_calls, details_calls = [], []
    _wire(monkeypatch, ig, [_post("casa", "AAA")], scrape_calls, details_calls)

    def run():
        asyncio.run(ig.fetch_events(anthropic_api_key="k", apify_token="t", posts_per_account=5))

    run()  # first sight: details + probe + full scrape
    assert len(details_calls) == 1 and len(scrape_calls) == 2

    scrape_calls.clear(); details_calls.clear()
    run()  # unchanged: probe only, no details, no full scrape
    assert details_calls == []
    assert len(scrape_calls) == 1 and scrape_calls[0][1] == ig._PROBE_POSTS_PER_ACCOUNT

    # After enough quiet probes the handle is no longer probed daily.
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE tracked_ig_accounts SET quiet_runs = 14, last_probed_at = ? WHERE handle = 'casa'",
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.commit()
    scrape_calls.clear()
    run()
    assert scrape_calls == []


def test_failed_extraction_is_retried_with_skip_path_on(db, monkeypatch):
    import scrapers.instagram_apify as ig
    db.upsert_ig_account(handle="casa", label="Casa", category="bar", added_by_email="t")
    scrape_calls, details_calls = [], []
    _wire(monkeypatch, ig, [_post("casa", "AAA")], scrape_calls, details_calls)
    seen = []

    async def failing(client, post, today, failed_out=None, **k):
        seen.append(post["id"])
        failed_out.add(post["id"])
        return []

    monkeypatch.setattr(ig, "_extract_events", failing)
    for _ in range(2):
        asyncio.run(ig.fetch_events(anthropic_api_key="k", apify_token="t"))
    assert seen == ["AAA", "AAA"]
    assert db.get_enabled_ig_accounts()[0]["quiet_runs"] == 0  # failures are not "quiet"
