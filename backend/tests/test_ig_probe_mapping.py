"""
Tests for how scraped Instagram posts are attributed to tracked profiles.

Context: @sociedadebeneficente pins a collab post authored by
@sambacasaforte. The probe asked Apify for 1 post per profile and keyed it
by ownerUsername, so the venue never matched: every daily run marked it
"scraped" and fetched nothing — for four months, while it posted dated
event flyers every week. The post scrape also wrote a blank avatar and bio
over the ones the profile-details call had saved.

What must hold:
  1. A post belongs to the profile it was fetched for (inputUrl), even when
     another account authored it.
  2. Pinned posts don't count as the "latest" post — a pin never changes,
     so it would freeze the probe's new-content signal.
  3. A collaborator's name never overwrites the tracked profile's.
  4. Blank profile fields never overwrite saved ones.
  5. A profile the probe returned nothing for isn't stamped as scraped.
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
    os.environ["DB_PATH"] = str(Path(tempfile.mkdtemp()) / "t.db")
    for mod in ("database", "scrapers.instagram_apify"):
        sys.modules.pop(mod, None)
    import database as _db
    _db.init_db()
    return _db


def _post(profile, owner, shortcode, ts, pinned=False, full_name=""):
    return {
        "inputUrl": f"https://www.instagram.com/{profile}/",
        "ownerUsername": owner,
        "ownerFullName": full_name,
        "url": f"https://www.instagram.com/p/{shortcode}/",
        "id": shortcode,
        "isPinned": pinned,
        "timestamp": ts,
        "caption": "Forró de domingo com banda ao vivo, abertura da casa 19h, show 20h30",
        "displayUrl": None,
        "likesCount": 1,
    }


# The venue's feed as Apify returns it: the pinned collab first.
VENUE_FEED = [
    _post("sociedadebeneficente", "sambacasaforte", "PINCOLLAB",
          "2026-09-08T21:00:00Z", pinned=True, full_name="SAMBA CASA FORTE"),
    _post("sociedadebeneficente", "sociedadebeneficente", "NEWEST",
          "2026-09-12T18:00:00Z", full_name="Sociedade 13 de Maio"),
    _post("sociedadebeneficente", "sociedadebeneficente", "OLDER",
          "2026-09-05T18:00:00Z", full_name="Sociedade 13 de Maio"),
]

PROBE = 3      # probe depth used in these tests
FULL = 10      # full-scrape depth — distinct from PROBE


async def _value(v):
    return v


def _wire(monkeypatch, db, feed, extract_calls):
    """Fake Apify + fake extraction around the real attribution logic."""
    import scrapers.instagram_apify as ig
    from models import RawEvent
    from datetime import datetime, timezone

    db.upsert_ig_account(handle="sociedadebeneficente", label="Treze",
                         category="bar", added_by_email="t")
    monkeypatch.setattr(ig, "_PROBE_POSTS_PER_ACCOUNT", PROBE)

    async def fake_scrape(token, urls, posts_per_account):
        return feed[:posts_per_account]

    async def extract(client, post, today, failed_out=None):
        extract_calls.append(post["id"])
        return RawEvent(
            source="instagram",
            external_id=f"ig_{ig._tracked_handle(post)}_{post['id']}",
            name="Forró de Domingo", description="d", venue_name="13 de Maio",
            venue_address="Rua Des. Clotário Portugal, 274", city="Curitiba",
            date_start=datetime(2026, 12, 1, 21, tzinfo=timezone.utc),
            url=post["url"],
        )

    async def no_details(*a, **k):
        return None

    monkeypatch.setattr(ig, "_run_apify_scrape", fake_scrape)
    monkeypatch.setattr(ig, "_enrich_profiles", no_details)
    async def extract_list(*a, **k):
        ev = await extract(*a, **k)
        return [ev] if ev is not None else []

    monkeypatch.setattr(ig, "_extract_events", extract_list)
    return ig


def _scrape(ig):
    return asyncio.run(ig.fetch_events(anthropic_api_key="k", apify_token="t",
                                       posts_per_account=FULL))


def test_tracked_handle_prefers_the_profile_that_was_fetched(db):
    import scrapers.instagram_apify as ig
    assert ig._tracked_handle({
        "inputUrl": "https://www.instagram.com/SociedadeBeneficente/",
        "ownerUsername": "sambacasaforte",
    }) == "sociedadebeneficente"
    # Older payloads without inputUrl keep working.
    assert ig._tracked_handle({"ownerUsername": "Cafe"}) == "cafe"
    # A post URL in inputUrl isn't a profile.
    assert ig._tracked_handle({
        "inputUrl": "https://www.instagram.com/p/ABC123/", "ownerUsername": "cafe",
    }) == "cafe"


def test_profile_that_pins_a_collab_is_actually_scraped(db, monkeypatch):
    calls = []
    ig = _wire(monkeypatch, db, VENUE_FEED, calls)

    events = _scrape(ig)

    acc = db.get_ig_account("sociedadebeneficente")
    assert sorted(calls) == ["NEWEST", "OLDER", "PINCOLLAB"], \
        "the full scrape must run for a profile whose first post is a collab"
    assert acc["last_post_shortcode"] == "NEWEST", \
        "latest must be the newest unpinned post, not the pin"
    assert acc["last_scraped_at"]
    # The collab counts for the venue it was shown on.
    assert all(e.external_id.startswith("ig_sociedadebeneficente_") for e in events)
    assert acc["last_event_count"] == 3


def test_new_post_under_a_pin_is_noticed(db, monkeypatch):
    calls = []
    ig = _wire(monkeypatch, db, VENUE_FEED, calls)
    _scrape(ig)

    # Next day, same feed: nothing new, so no full scrape and no extraction.
    calls.clear()
    _scrape(ig)
    assert calls == []

    # A new post lands below the pin — it has to be picked up.
    brand_new = _post("sociedadebeneficente", "sociedadebeneficente", "BRANDNEW",
                      "2026-09-13T18:00:00Z", full_name="Sociedade 13 de Maio")
    next_feed = [VENUE_FEED[0], brand_new] + VENUE_FEED[1:]
    monkeypatch.setattr(ig, "_run_apify_scrape",
                        lambda token, urls, posts_per_account: _value(next_feed[:posts_per_account]))
    _scrape(ig)
    assert "BRANDNEW" in calls, "a new post under a pinned post must trigger a scrape"
    assert db.get_ig_account("sociedadebeneficente")["last_post_shortcode"] == "BRANDNEW"


def test_collaborator_does_not_rename_the_tracked_profile(db, monkeypatch):
    ig = _wire(monkeypatch, db, VENUE_FEED, [])
    _scrape(ig)
    assert db.get_ig_account("sociedadebeneficente")["display_name"] == "Sociedade 13 de Maio"


def test_blank_profile_fields_never_overwrite_saved_ones(db):
    db.upsert_ig_account(handle="venue", label="V", category="bar", added_by_email="t")
    db.update_ig_account_profile("venue", display_name="Venue",
                                 profile_pic_url="/event-images/avatars/venue.jpg",
                                 bio_snippet="Bio real")
    # What the post scrape sends: a name, no picture, no bio.
    db.update_ig_account_profile("venue", display_name="Venue Renomeado")
    acc = db.get_ig_account("venue")
    assert acc["display_name"] == "Venue Renomeado"
    assert acc["profile_pic_url"] == "/event-images/avatars/venue.jpg"
    assert acc["bio_snippet"] == "Bio real"


def test_profile_with_no_probe_data_is_not_stamped_scraped(db, monkeypatch):
    ig = _wire(monkeypatch, db, VENUE_FEED, [])
    # Every fake post belongs to sociedadebeneficente, so this one gets no
    # data. Two accounts, one resolved = 50% coverage, which is not the
    # rate-limit branch — it takes the plain "no data" path.
    db.upsert_ig_account(handle="contaprivada", label="P", category="bar", added_by_email="t")
    _scrape(ig)
    assert not db.get_ig_account("contaprivada")["last_scraped_at"]
    assert db.get_ig_account("sociedadebeneficente")["last_scraped_at"]
