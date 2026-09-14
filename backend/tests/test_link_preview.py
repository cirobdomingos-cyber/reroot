"""
Tests for the card a shared event link shows in WhatsApp.

Context: /e/<id> was a blind 302, so the crawler followed it to the app
shell and every event previewed as the same generic homepage card — no
name, no date, no photo. On a link whose domain still says "reroot", a
card with the show's flyer on it is most of what makes the link look safe
to tap.

What must hold:
  1. A catalog event gets its own title, date, venue and image.
  2. A PRIVATE event gets nothing specific. Its details are gated behind
     an invite; a preview is fetched by whoever holds the URL, with no
     account. A rich card would hand a private party's name, venue and
     date to anyone the link was forwarded to.
  3. Humans still get the plain redirect they always had.
  4. A crawler that slips past the humans check still reaches the event.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

WHATSAPP_UA = "WhatsApp/2.23.20.0"
IPHONE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1")


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    return _db, _main


@pytest.fixture()
def client(env):
    from fastapi.testclient import TestClient
    _, main = env
    return TestClient(main.app)


def _catalog_event(db, image="https://cdn.example/flyer.jpg"):
    from models import EnrichedEvent
    ev = EnrichedEvent(
        id="instagram_ig_changes.cwb_ABC123", source="instagram",
        external_id="ig_changes.cwb_ABC123",
        name="Especial Nu Metal", description="Linkin Park Concert e Steal This Band",
        venue_name="Changes", venue_address="Rua Presidente Carlos Cavalcanti, 1122",
        neighborhood="São Francisco", city="Curitiba",
        date_start=datetime(2026, 9, 19, 21, 0, tzinfo=timezone.utc), date_end=None,
        price_min=0, price_max=0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="🎉",
        has_food=False, is_low_pressure=False, is_curated=True,
        pitch="", price_tier="free", vibe_summary="Nu metal a noite toda",
        expected_size="large", header_gradient="",
        url="https://instagram.com/p/ABC123/", image_url=image,
        fetched_at=datetime(2026, 9, 1),
    )
    db.upsert_event(ev)
    return ev.id


def test_a_person_still_just_gets_redirected(env, client):
    db, _ = env
    eid = _catalog_event(db)
    r = client.get(f"/e/{eid}", headers={"user-agent": IPHONE_UA}, follow_redirects=False)
    assert r.status_code == 302, "humans keep the plain redirect — no flash, no extra render"
    assert "/events" in r.headers["location"]


def test_whatsapp_gets_the_events_own_card(env, client):
    db, _ = env
    eid = _catalog_event(db)
    r = client.get(f"/e/{eid}", headers={"user-agent": WHATSAPP_UA}, follow_redirects=False)
    assert r.status_code == 200
    html = r.text
    assert 'property="og:title" content="Especial Nu Metal · auê"' in html
    assert "Changes" in html, "the venue belongs on the card"
    assert "19/09" in html, "so does the date"
    assert 'property="og:image" content="https://cdn.example/flyer.jpg"' in html
    assert 'name="twitter:card" content="summary_large_image"' in html
    assert 'property="og:site_name" content="auê"' in html


def test_a_crawler_that_is_really_a_person_still_lands_on_the_event(env, client):
    """The UA list is deliberately broad; a false positive must cost
    nothing, so the card redirects too."""
    db, _ = env
    eid = _catalog_event(db)
    r = client.get(f"/e/{eid}", headers={"user-agent": WHATSAPP_UA})
    assert "http-equiv=\"refresh\"" in r.text
    assert "location.replace" in r.text


def test_a_private_event_leaks_nothing(env, client):
    """The whole point: /events/{id} 403s a stranger, so the preview must
    not be the way around that."""
    db, _ = env
    ge = db.create_group_event(
        group_id=None, google_id="host", name="Aniversário surpresa da Ana",
        venue="Casa do Ciro", date_start="2026-12-01T21:00:00",
        extra_invitee_ids=["bia"],
    )
    r = client.get(f"/e/{ge['id']}", headers={"user-agent": WHATSAPP_UA})
    assert r.status_code == 200
    assert "Aniversário" not in r.text, "a private event's name must not preview"
    assert "Casa do Ciro" not in r.text, "nor its venue"
    assert "auê — Curitiba que acontece" in r.text, "generic card instead"


def test_an_unknown_event_gets_the_generic_card(env, client):
    r = client.get("/e/instagram_ig_nope_XYZ", headers={"user-agent": WHATSAPP_UA})
    assert r.status_code == 200
    assert "auê" in r.text


def test_an_event_without_an_image_still_previews(env, client):
    db, _ = env
    eid = _catalog_event(db, image="")
    r = client.get(f"/e/{eid}", headers={"user-agent": WHATSAPP_UA})
    assert 'name="twitter:card" content="summary"' in r.text, "small card, not a broken big one"
    assert "og:image" not in r.text


def test_the_card_url_follows_the_host_it_was_asked_on(env, client):
    """So a real auê domain works the day it is pointed at Railway, with
    nothing to redeploy."""
    db, _ = env
    eid = _catalog_event(db)
    r = client.get(f"/e/{eid}", headers={
        "user-agent": WHATSAPP_UA,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "aue.com.br",
    })
    assert 'property="og:url" content="https://aue.com.br/e/' in r.text
