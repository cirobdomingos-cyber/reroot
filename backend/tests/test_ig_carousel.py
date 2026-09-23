"""
Tests for carousel posts and for verdicts reached without the flyer.

Context (23 Sep 2026): @opatuscada posted its week as a carousel — one
flyer per night, seven slides. The catalog got nothing from the daily
scrape, and a manual re-scrape got five nights (the agenda slide's). Two
causes, both here:

  1. Only `displayUrl` — the first slide — went to the model. A carousel
     with one flyer per night is how venues post a week, and the model
     only extracts what it sees.
  2. A "não é evento" reached WITHOUT the image (the IG CDN 403s now and
     then) was recorded in the ledger as final, so the post was never
     asked about again. The date is usually on the art; a caption-only
     verdict on a post that has art isn't a verdict.

What must hold:
  1. Every slide of a carousel reaches the model, cover first, capped.
  2. A plain single-image post is unchanged: one image block.
  3. A no-event verdict without the image, on a post that has one, keeps
     the post out of the ledger (via failed_out) so it's retried.
  4. A no-event verdict WITH the image is final; so is one on a post
     that never had an image.
  5. The same holds when the model answered events that all fell to a
     gate — "nothing here" is just as suspect without the flyer.
"""
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import scrapers.instagram_apify as ig  # noqa: E402


class _FakeClient:
    def __init__(self, body):
        payload = json.dumps(body)
        outer = self

        class _Messages:
            async def create(self_inner, **kwargs):
                outer.last_kwargs = kwargs
                return SimpleNamespace(
                    content=[SimpleNamespace(text=payload)],
                    usage=SimpleNamespace(input_tokens=1, output_tokens=1),
                )

        self.messages = _Messages()
        self.last_kwargs = None

    def image_blocks(self):
        content = self.last_kwargs["messages"][0]["content"]
        return [b for b in content if b["type"] == "image"]


CAPTION = "Semana sensacional por aqui!!! Noite Cubana, Roda de Samba, Grooveria, Baile."


def _post(**extra):
    return {
        "caption": CAPTION,
        "url": "https://www.instagram.com/p/Ddm5NGukZGt/",
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
        "inputUrl": "https://www.instagram.com/opatuscada/",
        "ownerUsername": "opatuscada",
        "likesCount": 10,
        "id": "Ddm5NGukZGt",
        **extra,
    }


def _slides(n):
    return [{"displayUrl": f"https://cdn.example/slide{i}.jpg"} for i in range(1, n + 1)]


def _stub_fetch(monkeypatch, ok_urls=None):
    """Image fetch that succeeds for `ok_urls` (all, when None) and records
    what was asked for."""
    asked = []

    async def fetch(url):
        asked.append(url)
        if ok_urls is None or url in ok_urls:
            return ("b64data", "image/jpeg")
        return None

    monkeypatch.setattr(ig, "_fetch_image_b64", fetch)
    return asked


def _run(client, post, failed_out=None):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return asyncio.run(ig._extract_events(client, post, today, failed_out=failed_out))


NOT_EVENT = {"is_event": False}


# -- 1. every slide goes to the model ---------------------------------

def test_every_carousel_slide_reaches_the_model_cover_first(monkeypatch):
    asked = _stub_fetch(monkeypatch)
    client = _FakeClient(NOT_EVENT)
    _run(client, _post(type="Sidecar", displayUrl="https://cdn.example/cover.jpg",
                       childPosts=_slides(3)))
    assert asked == [
        "https://cdn.example/cover.jpg",
        "https://cdn.example/slide1.jpg",
        "https://cdn.example/slide2.jpg",
        "https://cdn.example/slide3.jpg",
    ]
    assert len(client.image_blocks()) == 4
    # Images first, then the prompt — the model reads the flyers before
    # the instructions that tell it what to do with them.
    assert client.last_kwargs["messages"][0]["content"][-1]["type"] == "text"


def test_the_cover_is_not_sent_twice_when_it_is_also_the_first_child(monkeypatch):
    asked = _stub_fetch(monkeypatch)
    client = _FakeClient(NOT_EVENT)
    _run(client, _post(displayUrl="https://cdn.example/slide1.jpg", childPosts=_slides(2)))
    assert asked == ["https://cdn.example/slide1.jpg", "https://cdn.example/slide2.jpg"]


def test_slides_are_capped(monkeypatch):
    asked = _stub_fetch(monkeypatch)
    client = _FakeClient(NOT_EVENT)
    _run(client, _post(displayUrl="https://cdn.example/slide1.jpg", childPosts=_slides(12)))
    assert len(asked) == ig._MAX_SLIDES
    assert len(client.image_blocks()) == ig._MAX_SLIDES


def test_images_as_plain_urls_are_read_too(monkeypatch):
    asked = _stub_fetch(monkeypatch)
    _run(_FakeClient(NOT_EVENT), _post(images=["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"]))
    assert asked == ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"]


# -- 2. a single image post is unchanged ------------------------------

def test_a_single_image_post_sends_one_image(monkeypatch):
    _stub_fetch(monkeypatch)
    client = _FakeClient(NOT_EVENT)
    _run(client, _post(displayUrl="https://cdn.example/cover.jpg"))
    assert len(client.image_blocks()) == 1


# -- 3/4. a verdict without the flyer isn't final --------------------

def test_no_event_without_the_image_is_retried(monkeypatch):
    _stub_fetch(monkeypatch, ok_urls=set())          # CDN says no
    failed = set()
    events = _run(_FakeClient(NOT_EVENT), _post(displayUrl="https://cdn.example/cover.jpg"), failed)
    assert events == []
    assert failed == {"Ddm5NGukZGt"}, "kept out of the ledger so the next run asks again"


def test_no_event_with_the_image_is_final(monkeypatch):
    _stub_fetch(monkeypatch)
    failed = set()
    _run(_FakeClient(NOT_EVENT), _post(displayUrl="https://cdn.example/cover.jpg"), failed)
    assert failed == set()


def test_no_event_on_a_post_without_any_image_is_final(monkeypatch):
    _stub_fetch(monkeypatch, ok_urls=set())
    failed = set()
    _run(_FakeClient(NOT_EVENT), _post(), failed)
    assert failed == set()


def test_a_partial_carousel_fetch_still_counts_as_having_the_image(monkeypatch):
    _stub_fetch(monkeypatch, ok_urls={"https://cdn.example/slide2.jpg"})
    failed = set()
    client = _FakeClient(NOT_EVENT)
    _run(client, _post(displayUrl="https://cdn.example/slide1.jpg", childPosts=_slides(3)), failed)
    assert len(client.image_blocks()) == 1
    assert failed == set()


# -- 5. events that all fell to a gate, without the flyer ------------

def test_gated_out_events_without_the_image_are_retried(monkeypatch):
    _stub_fetch(monkeypatch, ok_urls=set())
    failed = set()
    body = {"is_event": True, "events": [{
        "is_recurring": True, "recurrence_label": "toda quinta", "recurrence_days": [4],
        "name": "Samba", "description": "", "venue_name": "O Patuscada",
        "venue_address": "", "neighborhood": "", "date_start": "2030-01-03T20:00:00",
        "date_end": None, "price_min": 0, "price_max": 0,
    }]}
    events = _run(_FakeClient(body), _post(displayUrl="https://cdn.example/cover.jpg"), failed)
    assert events == []
    assert failed == {"Ddm5NGukZGt"}
