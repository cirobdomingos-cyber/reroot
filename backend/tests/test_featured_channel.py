"""
Tests for the season takeover: a public channel featured until a date.

Context (29 Oct 2026): Carnaval wants more than a row in Canais. A
featured channel leads the list, gets a band on Home and headlines the
weekly digest. A date rather than a flag, so the season ends by itself.

What must hold:
  1. `featured` is true until the date inclusive, false after, false when
     unset — computed once, the same everywhere a channel is shaped.
  2. The list puts a featured channel first regardless of followers.
  3. Only the founder may set it, only on a public channel, and a bad
     date is refused by name. '' ends it.
  4. The digest headlines the featured channel for a follower who got
     something from it, even when other channels gave more.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from test_channel_rules import FOUNDER, _channel, api  # noqa: E402,F401

TODAY = datetime.now(timezone.utc).date()
NEXT_WEEK = (TODAY + timedelta(days=7)).isoformat()
LAST_WEEK = (TODAY - timedelta(days=7)).isoformat()


def _feature(client, cid, until, email=FOUNDER):
    return client.put(f"/channels/{cid}", json={"requesting_email": email, "featured_until": until})


# -- 1 & 2. the flag and the order -------------------------------------

def test_featured_is_a_date_question(api):
    _db, _main, client = api
    cid = _channel(client, "auê Carnaval")["channel"]["id"]
    assert _db.get_group(cid)["featured"] is False
    assert _feature(client, cid, NEXT_WEEK).status_code == 200
    assert _db.get_group(cid)["featured"] is True
    assert _feature(client, cid, TODAY.isoformat()).status_code == 200
    assert _db.get_group(cid)["featured"] is True, "until is inclusive"
    assert _feature(client, cid, LAST_WEEK).status_code == 200
    assert _db.get_group(cid)["featured"] is False, "the season ended by itself"
    assert _feature(client, cid, "").status_code == 200
    assert _db.get_group(cid)["featured_until"] == ""


def test_a_featured_channel_leads_the_list(api):
    _db, _main, client = api
    rock = _channel(client, "auê Rock")["channel"]["id"]
    carnaval = _channel(client, "auê Carnaval")["channel"]["id"]
    for uid in ("u_ana", "u_bia"):
        _db.follow_channel(rock, uid)
    names = [c["name"] for c in client.get("/channels").json()["channels"]]
    assert names[0] == "auê Rock", "followers decide when nothing is featured"
    _feature(client, carnaval, NEXT_WEEK)
    listed = client.get("/channels").json()["channels"]
    assert listed[0]["name"] == "auê Carnaval"
    assert listed[0]["featured"] is True
    assert listed[1]["featured"] is False


# -- 3. who may set it ---------------------------------------------------

def test_only_the_founder_features_and_only_a_public_channel(api):
    _db, _main, client = api
    cid = _channel(client, "auê Carnaval")["channel"]["id"]
    # A channel curator may edit the channel but not feature it.
    r = client.post(f"/channels/{cid}/curators", json={"requesting_email": FOUNDER, "google_id": "u_ana"})
    assert r.status_code == 200, r.text
    r = _feature(client, cid, NEXT_WEEK, email="ana@example.com")
    assert r.status_code == 403
    assert _db.get_group(cid)["featured"] is False, "refused whole, nothing written"
    r = _feature(client, cid, "13/02/2027")
    assert r.status_code == 400
    assert "AAAA-MM-DD" in r.json()["detail"]
    # A private channel is someone's crew; it is never the season.
    gid = _db.create_group(google_id="u_founder", name="Nossa crew")["id"]
    r = _feature(client, gid, NEXT_WEEK)
    assert r.status_code == 400


# -- 4. the digest -------------------------------------------------------

def test_the_digest_headlines_the_featured_channel(api):
    _db, _main, client = api
    carnaval = _channel(client, "auê Carnaval")["channel"]["id"]
    _feature(client, carnaval, NEXT_WEEK)
    featured_names = {c["name"] for c in _db.list_channels() if c.get("featured")}
    assert featured_names == {"auê Carnaval"}
    # The headline rule, lifted from send_weekly_digest: the featured
    # channel wins even when another gave more.
    picks = {"auê Rock": 5, "auê Carnaval": 2}
    season = next((c for c in picks if c in featured_names and picks[c]), None)
    assert season == "auê Carnaval"


def test_a_curator_can_still_save_without_touching_the_season(api):
    """The regression the review caught: a curator's ordinary save must
    not carry featured_until, and the server must accept it without."""
    _db, _main, client = api
    cid = _channel(client, "auê Carnaval")["channel"]["id"]
    r = client.post(f"/channels/{cid}/curators", json={"requesting_email": FOUNDER, "google_id": "u_ana"})
    assert r.status_code == 200, r.text
    r = client.put(f"/channels/{cid}", json={"requesting_email": "ana@example.com",
                                             "description": "Blocos, todo fim de semana."})
    assert r.status_code == 200, r.text
    assert r.json()["channel"]["description"] == "Blocos, todo fim de semana."
