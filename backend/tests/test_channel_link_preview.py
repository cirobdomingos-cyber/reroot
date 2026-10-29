"""
Tests for the card a shared channel link shows in WhatsApp.

Context (29 Oct 2026): the channel screen shared `/#/channels/<id>`.
Nothing after `#` reaches the server, so every channel — the Carnaval
one included, the first built to be passed around — previewed as the
same generic homepage card. `/c/<id>` is the `/e/<id>` pattern for
channels.

What must hold:
  1. Humans get the plain 302 into the hash route.
  2. A crawler gets the public channel's name, how much is coming up and
     the next event's flyer as the cover.
  3. A PRIVATE channel gets the generic card: its link is the invite
     code, and a channel id forwarded on its own is a locked door.
  4. An unknown id gets the generic card and still redirects.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from test_channel_rules import FOUNDER, SOON, _channel, _event, api  # noqa: E402,F401

WHATSAPP_UA = "WhatsApp/2.23.20.0"
IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1")


def _carnaval(_db, client):
    _db.upsert_ig_account(handle="siribloco", label="Siribloco", category="bloco")
    _event(_db, "instagram_ig_siribloco_1", tipo="festa", name="Saída do Siribloco")
    _event(_db, "instagram_ig_siribloco_2", tipo="festa", name="Ensaio", when=SOON + timedelta(days=2))
    _event(_db, "instagram_ig_siribloco_3", tipo="festa", name="Ano passado",
           when=datetime.now(timezone.utc) - timedelta(days=200))
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê Carnaval",
        "description": "Todos os blocos de Curitiba.", "rule_categories": ["bloco"],
    })
    assert r.status_code == 200, r.text
    return r.json()["channel"]["id"]


def test_a_person_is_redirected_into_the_channel(api):
    _db, _main, client = api
    cid = _carnaval(_db, client)
    r = client.get(f"/c/{cid}", headers={"user-agent": IPHONE_UA}, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == f"/#/channels/{cid}"


def test_whatsapp_gets_the_channels_own_card(api):
    _db, _main, client = api
    cid = _carnaval(_db, client)
    r = client.get(f"/c/{cid}", headers={"user-agent": WHATSAPP_UA, "host": "auecuritiba.com"},
                   follow_redirects=False)
    assert r.status_code == 200
    html = r.text
    assert 'property="og:title" content="auê Carnaval · auê"' in html
    assert "Todos os blocos de Curitiba. — 2 rolês marcados" in html, "the past one doesn't count"
    assert 'property="og:image" content="https://auecuritiba.com/event-images/x.jpg"' in html
    assert 'property="og:url" content="https://auecuritiba.com/c/' in html
    assert f"/#/channels/{cid}" in html, "a crawler that is really a person still lands on it"


def test_a_private_channel_gets_the_generic_card(api):
    _db, _main, client = api
    gid = _db.create_group(google_id="u_ana", name="Nossa crew")["id"]
    r = client.get(f"/c/{gid}", headers={"user-agent": WHATSAPP_UA}, follow_redirects=False)
    assert r.status_code == 200
    assert "Nossa crew" not in r.text
    assert 'property="og:title" content="auê — Curitiba que acontece"' in r.text


def test_an_unknown_channel_gets_the_generic_card(api):
    _db, _main, client = api
    r = client.get("/c/grp_nope", headers={"user-agent": WHATSAPP_UA}, follow_redirects=False)
    assert r.status_code == 200
    assert "Curitiba que acontece" in r.text
    assert "/#/channels/grp_nope" in r.text


def test_the_cover_skips_instagram_cdn_links_for_a_rehosted_one(api):
    """The nearest night may only carry an Instagram CDN link, which a
    crawler can't fetch; the card takes the first cover it can show."""
    _db, _main, client = api
    _db.upsert_ig_account(handle="siribloco", label="Siribloco", category="bloco")
    _event(_db, "instagram_ig_siribloco_1", tipo="festa", name="Amanhã",
           image="https://instagram.fbne9-1.fna.fbcdn.net/v/t51/x.webp?oe=6AE9A173")
    _event(_db, "instagram_ig_siribloco_2", tipo="festa", name="Depois",
           when=SOON + timedelta(days=3), image="/event-images/rehosted.jpg")
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê Carnaval", "rule_categories": ["bloco"],
    })
    cid = r.json()["channel"]["id"]
    r = client.get(f"/c/{cid}", headers={"user-agent": WHATSAPP_UA, "host": "auecuritiba.com"},
                   follow_redirects=False)
    assert 'property="og:image" content="https://auecuritiba.com/event-images/rehosted.jpg"' in r.text


def test_a_channel_with_only_instagram_covers_keeps_the_nearest_one(api):
    """No rehosted copy anywhere: the Instagram link is still a flyer, and
    on WhatsApp it renders. The icon is only for a channel with no cover."""
    _db, _main, client = api
    _db.upsert_ig_account(handle="siribloco", label="Siribloco", category="bloco")
    _event(_db, "instagram_ig_siribloco_1", tipo="festa",
           image="https://scontent.cdninstagram.com/v/t51/x.jpg")
    _event(_db, "instagram_ig_siribloco_2", tipo="festa", when=SOON + timedelta(days=3),
           image="https://scontent.cdninstagram.com/v/t51/later.jpg")
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê Carnaval", "rule_categories": ["bloco"],
    })
    cid = r.json()["channel"]["id"]
    r = client.get(f"/c/{cid}", headers={"user-agent": WHATSAPP_UA, "host": "auecuritiba.com"},
                   follow_redirects=False)
    assert 'property="og:image" content="https://scontent.cdninstagram.com/v/t51/x.jpg"' in r.text


def test_a_channel_with_no_covers_uses_the_icon(api):
    _db, _main, client = api
    _db.upsert_ig_account(handle="siribloco", label="Siribloco", category="bloco")
    _event(_db, "instagram_ig_siribloco_1", tipo="festa", image="")
    r = client.post("/admin/channels", json={
        "requesting_email": FOUNDER, "name": "auê Carnaval", "rule_categories": ["bloco"],
    })
    cid = r.json()["channel"]["id"]
    r = client.get(f"/c/{cid}", headers={"user-agent": WHATSAPP_UA, "host": "auecuritiba.com"},
                   follow_redirects=False)
    assert 'property="og:image" content="https://auecuritiba.com/icon-512x512.png"' in r.text
