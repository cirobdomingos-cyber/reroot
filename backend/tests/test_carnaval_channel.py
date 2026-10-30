"""
Tests for the Carnaval pieces (29 Oct 2026): a channel filled by the
source's category, and a handle whose caption is judged without the flyer.

Context: pré-Carnaval in Curitiba announces itself on Instagram, one
account per bloco. No tipo or genre says "bloco" — the model files one
as festa, show or outro depending on the caption — but the handle's
category is a fact we wrote ourselves. And the blocos agreed to put the
date, place and time in the caption, which makes the flyer (up to six
slides, ~2.2k tokens each) the one cost worth skipping.

What must hold:
  1. A channel with a category rule opens with every upcoming catalog
     event from a handle of that category, and nothing else. The axis
     ANDs with tipo/genre like the others.
  2. A category no tracked handle carries is refused by name.
  3. A caption-only handle sends no image to the model, never fetches
     one, and a "não é evento" on it is final (not queued for a retry
     with the flyer).
  4. The flag survives the admin screen's enable/disable re-post, which
     doesn't mention it.
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from test_channel_rules import FOUNDER, SOON, _channel, _event, _sources_in, api  # noqa: E402,F401
from test_ig_carousel import NOT_EVENT, _FakeClient, _post, _slides, _stub_fetch  # noqa: E402

import scrapers.instagram_apify as ig  # noqa: E402


def _track(_db, handle, category):
    _db.upsert_ig_account(handle=handle, label=handle, category=category)


# -- 1. the category axis --------------------------------------------

def test_a_category_rule_fills_from_the_handles_of_that_category(api):
    _db, _main, client = api
    _track(_db, "siribloco", "bloco")
    _track(_db, "garibaldisesacis", "bloco")
    _track(_db, "bardosax", "bar")
    _event(_db, "instagram_ig_siribloco_1", tipo="festa")
    _event(_db, "instagram_ig_garibaldisesacis_1", tipo="outro")
    _event(_db, "instagram_ig_bardosax_1", tipo="festa")
    _event(_db, "instagram_ig_siribloco_2", tipo="festa", when=SOON - timedelta(days=30))
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê Carnaval", "rule_categories": ["bloco"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["added"] == 2
    cid = r.json()["channel"]["id"]
    assert _sources_in(_db, cid) == ["instagram_ig_garibaldisesacis_1", "instagram_ig_siribloco_1"]
    assert r.json()["channel"]["rule_categories"] == ["bloco"]


def test_category_ands_with_the_other_axes(api):
    _db, _main, client = api
    _track(_db, "siribloco", "bloco")
    _event(_db, "instagram_ig_siribloco_1", tipo="festa")
    _event(_db, "instagram_ig_siribloco_2", tipo="kids")
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê Bloquinho das crias",
        "rule_tipos": ["kids"], "rule_categories": ["bloco"],
    })
    assert r.status_code == 200, r.text
    assert _sources_in(_db, r.json()["channel"]["id"]) == ["instagram_ig_siribloco_2"]
    m = _db.rule_matches
    assert m([], [], "festa", "", ["bloco"], "bloco") is True
    assert m([], [], "festa", "", ["bloco"], "bar") is False
    assert m([], [], "festa", "", [], "bloco") is False


def test_a_category_rule_written_later_fills_now(api):
    _db, _main, client = api
    _track(_db, "siribloco", "bloco")
    _event(_db, "instagram_ig_siribloco_1", tipo="festa")
    created = _channel(client, "auê Carnaval")
    cid = created["channel"]["id"]
    assert _sources_in(_db, cid) == []
    r = client.put(f"/channels/{cid}", json={
        "requesting_email": FOUNDER, "rule_categories": ["bloco"],
    })
    assert r.status_code == 200, r.text
    assert r.json()["added"] == 1
    assert _sources_in(_db, cid) == ["instagram_ig_siribloco_1"]


# -- 2. vocabulary -----------------------------------------------------

def test_an_unknown_category_is_refused_by_name(api):
    _db, _main, client = api
    _track(_db, "siribloco", "bloco")
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê X", "rule_categories": ["escola_de_samba"],
    })
    assert r.status_code == 400
    assert "escola_de_samba" in r.json()["detail"]


# -- 3. caption-only extraction ----------------------------------------

def _run(client, post, **kw):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return asyncio.run(ig._extract_events(client, post, today, **kw))


def test_a_caption_only_post_sends_no_image_and_fetches_none(monkeypatch):
    asked = _stub_fetch(monkeypatch)
    client = _FakeClient(NOT_EVENT)
    _run(client, _post(displayUrl="https://cdn.example/cover.jpg", childPosts=_slides(3)),
         caption_only=True)
    assert asked == []
    assert client.image_blocks() == []
    text = client.last_kwargs["messages"][0]["content"][-1]["text"]
    assert "SEM IMAGEM" in text


def test_a_caption_only_no_event_verdict_is_final(monkeypatch):
    _stub_fetch(monkeypatch)
    client = _FakeClient(NOT_EVENT)
    failed = set()
    _run(client, _post(displayUrl="https://cdn.example/cover.jpg"),
         caption_only=True, failed_out=failed)
    # Without the flag the same post would be queued for a retry with
    # the flyer (test_ig_carousel). With it, the caption was the verdict.
    assert failed == set()


# -- 4. the flag on the account ----------------------------------------

def test_caption_only_survives_a_re_post_that_omits_it(api):
    _db, _main, client = api
    r = client.post("/admin/ig-accounts", json={
        "requesting_email": FOUNDER, "handle": "siribloco", "label": "Siribloco",
        "category": "bloco", "caption_only": True,
    })
    assert r.status_code == 200, r.text
    assert r.json()["account"]["caption_only"] == 1
    # The enable/disable toggle re-posts the row without the flag.
    r = client.post("/admin/ig-accounts", json={
        "requesting_email": FOUNDER, "handle": "siribloco", "label": "Siribloco",
        "category": "bloco", "enabled": False,
    })
    assert r.status_code == 200, r.text
    assert r.json()["account"]["caption_only"] == 1
    assert r.json()["account"]["enabled"] == 0
    r = client.post("/admin/ig-accounts", json={
        "requesting_email": FOUNDER, "handle": "siribloco", "label": "Siribloco",
        "category": "bloco", "caption_only": False,
    })
    assert r.json()["account"]["caption_only"] == 0
    assert [a["handle"] for a in _db.get_enabled_ig_accounts()] == ["siribloco"]
    assert _db.get_enabled_ig_accounts()[0]["caption_only"] == 0


# -- 5. the flag reaches the extractor through the scrape -------------

def test_the_scrape_passes_caption_only_for_flagged_handles_only(monkeypatch, api):
    """The seam that broke in CI (29 Oct): the scrape loop must hand the
    extractor `caption_only` for a flagged handle and leave the call
    shape untouched for every other handle — the ledger and probe tests
    stub `_extract_events` with fakes that know nothing of the flag."""
    _db, _main, _client = api
    # The fixture swapped in a fresh `database`; the scraper imported at
    # module load still holds the old one. Re-import so both see one DB.
    import importlib
    sys.modules.pop("scrapers.instagram_apify", None)
    ig = importlib.import_module("scrapers.instagram_apify")
    _db.upsert_ig_account(handle="siribloco", label="Siribloco", category="bloco",
                          caption_only=True)
    _db.upsert_ig_account(handle="bardosax", label="Bar do Sax", category="bar")
    feed = [
        {"inputUrl": "https://www.instagram.com/siribloco/", "ownerUsername": "siribloco",
         "url": "https://www.instagram.com/p/BLOCO1/", "id": "BLOCO1",
         "timestamp": "2026-11-01T18:00:00Z", "caption": "x" * 40, "displayUrl": None},
        {"inputUrl": "https://www.instagram.com/bardosax/", "ownerUsername": "bardosax",
         "url": "https://www.instagram.com/p/BAR1/", "id": "BAR1",
         "timestamp": "2026-11-01T18:00:00Z", "caption": "x" * 40, "displayUrl": None},
    ]
    seen = {}

    async def fake_scrape(token, urls, posts_per_account):
        return feed

    async def no_details(*a, **k):
        return None

    async def extract(client, post, today, failed_out=None, **kw):
        seen[post["id"]] = kw
        return []

    monkeypatch.setattr(ig, "_run_apify_scrape", fake_scrape)
    monkeypatch.setattr(ig, "_enrich_profiles", no_details)
    monkeypatch.setattr(ig, "_extract_events", extract)
    asyncio.run(ig.fetch_events(anthropic_api_key="k", apify_token="t", posts_per_account=5))
    assert seen["BLOCO1"] == {"caption_only": True}
    assert seen["BAR1"] == {}


# -- 6. the debug tool judges a post the way the scrape would ----------

def test_extract_debug_honours_caption_only_and_the_tracked_handle(monkeypatch, api):
    """/admin/ig-extract-debug fetches a post by URL, so Apify names no
    profile and the post is the author's. Debugging a bloco repost sent
    the flyer the scrape never sends and named the author instead of the
    bloco. `handle` makes the tool judge the post as the scrape would."""
    _db, _main, client = api
    import importlib
    sys.modules.pop("scrapers.instagram_apify", None)
    ig = importlib.import_module("scrapers.instagram_apify")
    _db.upsert_ig_account(handle="siribloco", label="Siribloco", category="bloco",
                          caption_only=True)
    monkeypatch.setattr(_main.settings, "apify_api_token", "t")
    monkeypatch.setattr(_main.settings, "anthropic_api_key", "k")
    seen = {}

    async def fake_scrape(token, urls, posts_per_account):
        return [{"inputUrl": urls[0], "ownerUsername": "mst_parana",
                 "url": urls[0], "id": "ABC", "timestamp": "2026-11-01T18:00:00Z",
                 "caption": "x" * 40, "displayUrl": "https://cdn.example/f.jpg"}]

    async def extract(client_, post, today, debug_out=None, **kw):
        seen["kwargs"] = kw
        seen["tracked_handle"] = ig._tracked_handle(post)
        return []

    monkeypatch.setattr(ig, "_run_apify_scrape", fake_scrape)
    monkeypatch.setattr(ig, "_extract_events", extract)

    r = client.get("/admin/ig-extract-debug", params={
        "url": "https://www.instagram.com/p/ABC/", "handle": "@siribloco",
        "requesting_email": FOUNDER,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["handle"] == "siribloco"
    assert body["tracked"] is True
    assert body["caption_only"] is True
    assert seen["kwargs"] == {"caption_only": True}
    assert seen["tracked_handle"] == "siribloco"

    # Without `handle`, the post is the author's: untracked, flyer read.
    r = client.get("/admin/ig-extract-debug", params={
        "url": "https://www.instagram.com/p/ABC/", "requesting_email": FOUNDER,
    })
    body = r.json()
    assert body["handle"] == "mst_parana"
    assert body["tracked"] is False
    assert body["caption_only"] is False
    assert seen["kwargs"] == {}


# -- 7. the channel names the accounts it draws from --------------------

def test_a_category_channel_lists_its_tracked_handles(api):
    """"Is my bloco here?" is answered by the channel screen: a channel
    with a category rule carries its enabled handles, most active first;
    a tipo/genre channel carries none."""
    _db, _main, client = api
    _db.upsert_ig_account(handle="siribloco", label="Siribloco", category="bloco")
    _db.upsert_ig_account(handle="garibaldisesacis", label="Garibaldis", category="bloco")
    _db.upsert_ig_account(handle="blocoparado", label="Parado", category="bloco", enabled=False)
    _db.upsert_ig_account(handle="bardosax", label="Bar do Sax", category="bar")
    with _db.get_conn() as conn:
        conn.execute("UPDATE tracked_ig_accounts SET last_event_count = 3 WHERE handle = 'siribloco'")
        conn.commit()
    carnaval = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê Carnaval", "rule_categories": ["bloco"],
    }).json()["channel"]["id"]
    comedia = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê Comédia", "rule_tipos": ["comedia"],
    }).json()["channel"]["id"]
    sources = client.get(f"/channels/{carnaval}").json()["sources"]
    assert [s["handle"] for s in sources] == ["siribloco", "garibaldisesacis"]
    assert sources[0] == {"handle": "siribloco", "label": "Siribloco", "profile_pic_url": "", "event_count": 3}
    assert client.get(f"/channels/{comedia}").json()["sources"] == []
