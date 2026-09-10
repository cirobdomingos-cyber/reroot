"""
Tests for Apify request chunking.

Context: the daily scrape sent all 122 tracked handles in one run-sync
request. When that request exceeded APIFY_TIMEOUT_S the helper returned []
and the entire run produced nothing — no posts, and (because the code
returned before the bookkeeping loop) no last_scraped_at either, so the
freeze was invisible in the admin UI. Eight days of empty catalog.

Chunking bounds each request and isolates failure. What must hold:
  1. A large URL list is split; every URL is requested exactly once.
  2. Results from all chunks are concatenated.
  3. One failing chunk does not zero the run — partial results survive.
  4. A list that fits in one chunk takes the single-request path.
"""
import asyncio
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "scrapers"))

import scrapers.instagram_apify as ig  # noqa: E402


def _urls(n):
    return [f"https://www.instagram.com/h{i}/" for i in range(n)]


def test_large_list_is_chunked_and_fully_covered(monkeypatch):
    seen = []

    async def fake_chunk(token, urls, posts_per_account):
        seen.append(list(urls))
        return [{"u": u} for u in urls]

    monkeypatch.setattr(ig, "_run_apify_chunk", fake_chunk)
    out = asyncio.run(ig._run_apify_scrape("t", _urls(50), 5))

    sizes = sorted(len(c) for c in seen)
    assert sizes == [10, 20, 20], f"expected 20/20/10 split, got {sizes}"
    flat = [u for c in seen for u in c]
    assert sorted(flat) == sorted(_urls(50)), "every URL must be requested exactly once"
    assert len(out) == 50, "results from all chunks must be concatenated"


def test_one_failing_chunk_does_not_zero_the_run(monkeypatch):
    """The whole point: a slow chunk costs its handles, not the catalog."""
    async def flaky(token, urls, posts_per_account):
        if any(u.endswith("/h0/") for u in urls):
            raise TimeoutError("simulated Apify timeout")
        return [{"u": u} for u in urls]

    monkeypatch.setattr(ig, "_run_apify_chunk", flaky)
    out = asyncio.run(ig._run_apify_scrape("t", _urls(50), 5))

    assert len(out) == 30, f"expected the 2 healthy chunks to survive, got {len(out)}"


def test_small_list_uses_single_request(monkeypatch):
    calls = []

    async def fake_chunk(token, urls, posts_per_account):
        calls.append(list(urls))
        return []

    monkeypatch.setattr(ig, "_run_apify_chunk", fake_chunk)
    asyncio.run(ig._run_apify_scrape("t", _urls(5), 1))
    assert len(calls) == 1 and len(calls[0]) == 5


def test_empty_input_makes_no_request(monkeypatch):
    async def boom(*a, **k):
        raise AssertionError("should not be called")

    monkeypatch.setattr(ig, "_run_apify_chunk", boom)
    assert asyncio.run(ig._run_apify_scrape("t", [], 5)) == []


def test_concurrency_is_bounded(monkeypatch):
    """Free-tier Apify limits concurrent actor runs; don't fire all at once."""
    inflight = 0
    peak = 0

    async def slow(token, urls, posts_per_account):
        nonlocal inflight, peak
        inflight += 1
        peak = max(peak, inflight)
        await asyncio.sleep(0.01)
        inflight -= 1
        return []

    monkeypatch.setattr(ig, "_run_apify_chunk", slow)
    asyncio.run(ig._run_apify_scrape("t", _urls(200), 5))
    assert peak <= ig._APIFY_CHUNK_CONCURRENCY, f"peak concurrency {peak}"
