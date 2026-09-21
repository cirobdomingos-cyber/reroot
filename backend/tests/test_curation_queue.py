"""
The daily scrape publishes, and curators pass over it afterwards.

A day of the blocking queue (first real run: 12 events waiting) showed
the gate is daily mandatory work for whoever curates, and a trip stops
the catalog. So: the scrape publishes as before AND queues every new
event as "not curated yet"; approving is "tá certo", rejecting pulls
the event from the catalog. Rows parked under the blocking model (not
yet public) still publish on approval.
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


EID = "instagram_ig_barfolia_ABC123"


def _queue(client):
    return client.get(f"/admin/catalog-requests?status=review&requesting_email={FOUNDER_EMAIL}").json()["requests"]


def _approve(client, rid, **edits):
    return client.post(f"/admin/catalog-requests/{rid}/approve",
                       json={"requesting_email": FOUNDER_EMAIL, **edits})


# -- 1. the scrape publishes AND queues ---------------------------------

def test_a_new_scraped_event_is_public_now_and_queued_for_curation(api):
    _db, _main, client = api
    assert _db.route_scraped_event(_scraped()) == "published"
    assert _db.get_event_by_id(EID) is not None          # public
    q = _queue(client)
    assert [r["name"] for r in q] == ["Samba do Folia"]  # and queued
    assert q[0]["source"] == "scrape"
    assert q[0]["in_catalog"] is True
    assert q[0]["catalog_event_id"] == EID


def test_a_re_scrape_refreshes_in_place_and_does_not_queue_again(api):
    _db, _main, client = api
    assert _db.route_scraped_event(_scraped()) == "published"
    assert _db.route_scraped_event(_scraped(name="Samba do Folia (nova data)")) == "updated"
    assert _db.get_event_by_id(EID).name == "Samba do Folia (nova data)"
    assert len(_queue(client)) == 1


# -- 2. approve = "tá certo" ---------------------------------------------

def test_approving_a_public_event_keeps_it_and_applies_the_edits_to_the_live_row(api):
    _db, _main, client = api
    _db.route_scraped_event(_scraped())
    # A later re-scrape changed the live row; edits must land on THAT.
    _db.route_scraped_event(_scraped(pitch="Roda de samba, agora no salão"))
    rid = _queue(client)[0]["id"]
    r = _approve(client, rid, name="Samba do Folia — edição especial")
    assert r.status_code == 200, r.text
    ev = _db.get_event_by_id(EID)
    assert ev.name == "Samba do Folia — edição especial"
    assert ev.pitch == "Roda de samba, agora no salão"     # live row, not the snapshot
    assert ev.genre == "samba_pagode"
    assert _queue(client) == []


def test_approving_a_public_event_does_not_park_it_for_the_digest_again(api):
    """The scrape's digest already carried it."""
    _db, _main, client = api
    _db.route_scraped_event(_scraped())
    rid = _queue(client)[0]["id"]
    _approve(client, rid)
    assert _db.take_deferred_digest_events() == []


def test_a_row_parked_before_this_model_still_publishes_on_approval(api):
    """Queued but not public — the blocking model's leftovers. Approving
    publishes the stored enrichment under the scraper's id and parks it
    for the digest, since no scrape announced it."""
    _db, _main, client = api
    _db.insert_scraped_request(_scraped())
    assert _db.get_event_by_id(EID) is None
    q = _queue(client)
    assert q[0]["in_catalog"] is False
    r = _approve(client, q[0]["id"])
    assert r.status_code == 200, r.text
    assert r.json()["catalog_event_id"] == EID
    ev = _db.get_event_by_id(EID)
    assert ev is not None and ev.genre == "samba_pagode"
    assert _db.take_deferred_digest_events() == [EID]


# -- 3. reject = "tirar do catálogo" -------------------------------------

def test_rejecting_a_scraped_event_pulls_it_from_the_catalog(api):
    _db, _main, client = api
    _db.route_scraped_event(_scraped())
    rid = _queue(client)[0]["id"]
    r = client.post(f"/admin/catalog-requests/{rid}/reject", json={"requesting_email": "ana@example.com"})
    assert r.status_code == 200, r.text
    assert r.json()["removed_from_catalog"] is True
    assert _db.get_event_by_id(EID) is None
    assert _queue(client) == []


def test_rejecting_a_human_suggestion_touches_no_catalog_event(api):
    _db, _main, client = api
    _db.route_scraped_event(_scraped())                    # an unrelated public event
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT INTO submitted_events (name, date_start, url, status, created_at, shortcode, ig_handle)"
            " VALUES (?,?,?,?,?,?,?)",
            ("Feira do Passeio", "2099-10-05T10:00:00", "https://instagram.com/p/XYZ/", "review", now, "XYZ", "passeio"),
        )
        conn.commit()
    rid = [r for r in _queue(client) if r["source"] == "suggestion"][0]["id"]
    r = client.post(f"/admin/catalog-requests/{rid}/reject", json={"requesting_email": FOUNDER_EMAIL})
    assert r.status_code == 200
    assert r.json()["removed_from_catalog"] is False
    assert _db.get_event_by_id(EID) is not None


# -- 4. bulk ------------------------------------------------------------

def test_approve_many_clears_what_it_can_and_names_what_it_cannot(api):
    _db, _main, client = api
    for code in ("A1", "B2", "C3"):
        _db.route_scraped_event(_scraped(code=code, name=f"Show {code}"))
    ids = [r["id"] for r in _queue(client)]
    client.post(f"/admin/catalog-requests/{ids[1]}/reject", json={"requesting_email": "ana@example.com"})
    r = client.post("/admin/catalog-requests/approve-many",
                    json={"requesting_email": FOUNDER_EMAIL, "ids": ids})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["approved"] == 2
    failed = [x for x in out["results"] if not x["ok"]]
    assert [x["id"] for x in failed] == [ids[1]] and failed[0]["status"] == 409
    assert _queue(client) == []
    # The two approved stay public; the rejected one is gone.
    assert _db.get_event_by_id("instagram_ig_barfolia_A1") is not None
    assert _db.get_event_by_id("instagram_ig_barfolia_B2") is None
    assert _db.get_event_by_id("instagram_ig_barfolia_C3") is not None


def test_approve_many_is_curators_only(api):
    _db, _main, client = api
    r = client.post("/admin/catalog-requests/approve-many",
                    json={"requesting_email": "nobody@example.com", "ids": [1]})
    assert r.status_code in (401, 403)


# -- 5. one push per refresh ------------------------------------------

def test_curators_get_one_push_per_refresh_saying_the_events_are_already_public(api, monkeypatch):
    _db, main, client = api
    sent = []
    monkeypatch.setattr(main, "_send_push_to_user", lambda uid, **kw: sent.append((uid, kw)))
    main.notify_curators_of_scrape(23)
    assert sorted(u for u, _ in sent) == ["u_ana", "u_founder"]
    assert all(kw["body"] == "23 eventos novos no catálogo, sem curadoria ainda" for _, kw in sent)
    assert all(kw["url"] == "/#/curadoria" for _, kw in sent)


def test_no_push_when_nothing_was_new(api, monkeypatch):
    _db, main, client = api
    sent = []
    monkeypatch.setattr(main, "_send_push_to_user", lambda uid, **kw: sent.append(uid))
    main.notify_curators_of_scrape(0)
    assert sent == []
