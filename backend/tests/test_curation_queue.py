"""
The daily scrape goes through curators before the catalog.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FOUNDER_EMAIL = "founder@example.com"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("FOUNDER_EMAIL", FOUNDER_EMAIL)
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO curators (email, added_by_email, added_at, notes,"
            " is_founder, is_curator, is_feedbacker) VALUES (?,?,?,?,1,1,1)",
            (FOUNDER_EMAIL, "system", now, "test"),
        )
        conn.execute(
            "INSERT OR REPLACE INTO curators (email, added_by_email, added_at, notes,"
            " is_founder, is_curator, is_feedbacker) VALUES (?,?,?,?,0,1,0)",
            ("ana@example.com", FOUNDER_EMAIL, now, "test"),
        )
        for uid, email in (("u_founder", FOUNDER_EMAIL), ("u_ana", "ana@example.com")):
            conn.execute(
                "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
                " VALUES (?,?,?,?,?)", (uid, uid, email, "", now),
            )
        conn.commit()
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _scraped(code="ABC123", handle="barfolia", **over):
    from models import EnrichedEvent
    base = dict(
        id=f"instagram_ig_{handle}_{code}", source="instagram", external_id=f"ig_{handle}_{code}",
        name="Samba do Folia", description="Festa de samba", venue_name="Bar Folia",
        venue_address="", neighborhood="Agua Verde", city="Curitiba",
        date_start=datetime(2099, 9, 20, 18, 0, tzinfo=timezone.utc), date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="\U0001F91D",
        has_food=True, is_low_pressure=False, is_curated=False,
        pitch="Roda de samba no quintal", price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        url=f"https://instagram.com/p/{code}/", image_url=None,
        fetched_at=datetime.now(timezone.utc), genre="samba_pagode",
    )
    base.update(over)
    return EnrichedEvent(**base)


def _queue(client):
    return client.get(f"/admin/catalog-requests?status=review&requesting_email={FOUNDER_EMAIL}").json()["requests"]


# -- 1. the scrape queues, it does not publish ------------------------

def test_a_new_scraped_event_waits_for_a_curator(api):
    _db, _main, client = api
    assert _db.route_scraped_event(_scraped()) == "queued"
    assert _db.get_event_by_id("instagram_ig_barfolia_ABC123") is None
    q = _queue(client)
    assert [r["name"] for r in q] == ["Samba do Folia"]
    assert q[0]["source"] == "scrape"


def test_the_same_post_is_not_queued_twice(api):
    _db, _main, client = api
    assert _db.route_scraped_event(_scraped()) == "queued"
    assert _db.route_scraped_event(_scraped()) == "skipped"
    assert len(_queue(client)) == 1


def test_an_event_a_curator_already_published_is_refreshed_in_place(api):
    """A re-scrape of a published event is not a new decision."""
    _db, _main, client = api
    _db.upsert_event(_scraped())
    assert _db.route_scraped_event(_scraped(name="Samba do Folia (nova data)")) == "updated"
    assert _db.get_event_by_id("instagram_ig_barfolia_ABC123").name == "Samba do Folia (nova data)"
    assert _queue(client) == []


# -- 2. approving publishes the scrape's own enrichment -----------------

def test_approving_publishes_the_stored_enrichment_under_the_scrapers_id(api):
    _db, _main, client = api
    _db.route_scraped_event(_scraped())
    rid = _queue(client)[0]["id"]
    r = client.post(f"/admin/catalog-requests/{rid}/approve", json={"requesting_email": FOUNDER_EMAIL})
    assert r.status_code == 200, r.text
    # The scraper's id, so the next re-scrape updates this row.
    assert r.json()["catalog_event_id"] == "instagram_ig_barfolia_ABC123"
    ev = _db.get_event_by_id("instagram_ig_barfolia_ABC123")
    assert ev is not None
    assert ev.genre == "samba_pagode" and ev.pitch == "Roda de samba no quintal"
    assert _queue(client) == []


def test_curator_edits_ride_on_top_of_the_enrichment(api):
    _db, _main, client = api
    _db.route_scraped_event(_scraped())
    rid = _queue(client)[0]["id"]
    client.post(f"/admin/catalog-requests/{rid}/approve",
                json={"requesting_email": FOUNDER_EMAIL, "name": "Samba do Folia — edição especial"})
    ev = _db.get_event_by_id("instagram_ig_barfolia_ABC123")
    assert ev.name == "Samba do Folia — edição especial"
    assert ev.genre == "samba_pagode"          # kept


def test_approval_is_what_novidades_announces(api):
    """The id is parked for the 09:00 digest — the scrape itself no
    longer announces anything, since nothing it found is public yet."""
    _db, _main, client = api
    _db.route_scraped_event(_scraped())
    rid = _queue(client)[0]["id"]
    client.post(f"/admin/catalog-requests/{rid}/approve", json={"requesting_email": FOUNDER_EMAIL})
    assert _db.take_deferred_digest_events() == ["instagram_ig_barfolia_ABC123"]


# -- 3. bulk ------------------------------------------------------------

def test_approve_many_clears_what_it_can_and_names_what_it_cannot(api):
    _db, _main, client = api
    for code in ("A1", "B2", "C3"):
        _db.route_scraped_event(_scraped(code=code, name=f"Show {code}"))
    ids = [r["id"] for r in _queue(client)]
    # A curator resolves one of them first.
    client.post(f"/admin/catalog-requests/{ids[1]}/reject", json={"requesting_email": "ana@example.com"})
    r = client.post("/admin/catalog-requests/approve-many",
                    json={"requesting_email": FOUNDER_EMAIL, "ids": ids})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["approved"] == 2
    failed = [x for x in out["results"] if not x["ok"]]
    assert [x["id"] for x in failed] == [ids[1]] and failed[0]["status"] == 409
    assert _queue(client) == []


def test_approve_many_is_curators_only(api):
    _db, _main, client = api
    r = client.post("/admin/catalog-requests/approve-many",
                    json={"requesting_email": "nobody@example.com", "ids": [1]})
    assert r.status_code in (401, 403)


# -- 4. one push per refresh ------------------------------------------

def test_curators_get_one_push_per_refresh_with_the_count(api, monkeypatch):
    _db, main, client = api
    sent = []
    monkeypatch.setattr(main, "_send_push_to_user", lambda uid, **kw: sent.append((uid, kw)))
    main.notify_curators_of_scrape(23)
    assert sorted(u for u, _ in sent) == ["u_ana", "u_founder"]
    assert all("23 eventos novos" in kw["body"] for _, kw in sent)
    assert all(kw["url"] == "/#/curadoria" for _, kw in sent)


def test_no_push_when_nothing_was_queued(api, monkeypatch):
    _db, main, client = api
    sent = []
    monkeypatch.setattr(main, "_send_push_to_user", lambda uid, **kw: sent.append(uid))
    main.notify_curators_of_scrape(0)
    assert sent == []
