"""
Tests for PATCH /events/{id} — the founder editing other people's private
events, and connecting an event to its Instagram post after the fact.

Context (Sep 2026): a wrong time or a plan with no flyer reaches the
founder, and fixing it meant asking the host for co-host powers first.
Now the founder edits any private event they can see. The same edit
sheet gained a "link do Instagram" field for events created by hand:
the link gives the event its "Ver no Instagram" button and cover, and
binds it to the catalog's copy of the post when there is one.

What must hold:
  1. Creator and co-host edit as before; a stranger still can't.
  2. The founder edits an event they can see (invited, or a fork in a
     public channel) — and not a private plan they aren't invited to.
     Delete stays the host's.
  3. Editing the description keeps an existing Instagram link — the
     sheet sends the description without the "Ver original:" suffix,
     and saving used to drop the link.
  4. Attaching a link: only Instagram links; the link shows as the
     event's url; the description is not pinned by it; the row binds
     to the catalog twin when the catalog already has the post; the
     account is credited when the event had none.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

FOUNDER_EMAIL = "founder@example.com"
POST_URL = "https://www.instagram.com/p/ABC123/"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main", "enrichment"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    _db.add_curator(email=FOUNDER_EMAIL, added_by_email="system", notes="test",
                    is_founder_flag=True)
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        # The founder and three ordinary people, all signed in at least
        # once — the founder check goes google_id → users.email → curators.
        for uid, email in (("u_founder", FOUNDER_EMAIL),
                           ("u_host", "host@example.com"),
                           ("u_cohost", "cohost@example.com"),
                           ("u_ana", "ana@example.com")):
            conn.execute(
                "INSERT OR REPLACE INTO users (id, display_name, email, picture, created_at)"
                " VALUES (?,?,?,?,?)",
                (uid, uid, email, "", now),
            )
        conn.commit()
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _plan(_db, invitees=("u_ana",), description="Churras na laje", **overrides):
    ev = _db.create_group_event(
        group_id=None, google_id="u_host", name="Churras",
        description=description, venue="Laje do Zé",
        date_start="2099-12-01T20:00:00", extra_invitee_ids=list(invitees),
        **overrides,
    )
    return ev["id"]


def _patch(client, event_id, google_id, **body):
    return client.patch(f"/events/{event_id}", json={"google_id": google_id, **body})


def _catalog_post(_db):
    """The catalog's copy of POST_URL, written the way the scrape writes
    it (external_id ig_<handle>_<shortcode>)."""
    from models import EnrichedEvent
    ev = EnrichedEvent(
        id="instagram_ig_barfolia_ABC123", source="instagram",
        external_id="ig_barfolia_ABC123", name="Samba do Folia",
        description="Festa de samba", venue_name="Bar Folia", venue_address="",
        neighborhood="Agua Verde", city="Curitiba",
        date_start=datetime(2099, 9, 20, 18, 0, tzinfo=timezone.utc), date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="\U0001F91D",
        has_food=True, is_low_pressure=False, is_curated=True,
        pitch="", price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        url=POST_URL, image_url=None, fetched_at=datetime.now(timezone.utc),
        genre="samba_pagode",
    )
    _db.upsert_event(ev)
    return ev.id


# ── 1. The old role set still holds ─────────────────────────────────

def test_creator_and_co_host_edit_stranger_cannot(api):
    _db, _main, client = api
    event_id = _plan(_db)
    _db.add_co_host(event_id, "u_cohost")

    assert _patch(client, event_id, "u_host", name="Churras 2").status_code == 200
    assert _patch(client, event_id, "u_cohost", venue="Laje da Ana").status_code == 200
    assert _patch(client, event_id, "u_ana", name="Hacked").status_code == 403

    ge = _db.get_group_event(event_id)
    assert (ge["name"], ge["venue"]) == ("Churras 2", "Laje da Ana")


# ── 2. The founder edits what they can see ──────────────────────────

def test_founder_edits_an_event_they_are_invited_to(api):
    _db, _main, client = api
    event_id = _plan(_db, invitees=("u_ana", "u_founder"))

    r = _patch(client, event_id, "u_founder", name="Churras (horário certo)",
               date_start="2099-12-01T21:00:00")
    assert r.status_code == 200, r.text
    ge = _db.get_group_event(event_id)
    assert ge["name"] == "Churras (horário certo)"
    assert ge["date_start"] == "2099-12-01T21:00:00"
    # The response carries the screen's shape too, so the edit sheet can
    # mirror it without a second request.
    assert r.json()["view"]["name"] == "Churras (horário certo)"


def test_founder_edits_a_public_channel_fork(api):
    _db, _main, client = api
    channel = _db.create_group(google_id="u_host", name="Rockzão", description="",
                               visibility="public", kind="channel")
    ev = _db.create_group_event(
        group_id=channel["id"], google_id="u_host", name="Show",
        date_start="2099-12-01T20:00:00", extra_invitee_ids=[],
    )
    # Nobody invited the founder; a public fork is visible to everyone.
    assert client.get(f"/events/{ev['id']}?google_id=u_founder").status_code == 200
    assert _patch(client, ev["id"], "u_founder", venue="Pedreira").status_code == 200
    assert _db.get_group_event(ev["id"])["venue"] == "Pedreira"


def test_founder_cannot_edit_a_plan_they_cannot_see(api):
    _db, _main, client = api
    event_id = _plan(_db, invitees=("u_ana",))

    # Same line GET /events/{id} draws.
    assert client.get(f"/events/{event_id}?google_id=u_founder").status_code == 403
    assert _patch(client, event_id, "u_founder", name="Nope").status_code == 403
    assert _db.get_group_event(event_id)["name"] == "Churras"


def test_founder_still_cannot_delete(api):
    _db, _main, client = api
    event_id = _plan(_db, invitees=("u_ana", "u_founder"))
    r = client.delete(f"/events/private/{event_id}?google_id=u_founder")
    assert r.status_code == 403
    assert _db.get_group_event(event_id) is not None


# ── 3. Editing the description keeps the link ───────────────────────

def test_editing_description_keeps_the_instagram_link(api):
    _db, _main, client = api
    event_id = _plan(_db, description=f"Churras na laje\n\nVer original: {POST_URL}")
    before = client.get(f"/events/{event_id}?google_id=u_host").json()
    assert before["url"] == POST_URL

    # What the sheet sends: the description as displayed, link stripped.
    r = _patch(client, event_id, "u_host", description="Churras na laje, traz gelo")
    assert r.status_code == 200
    after = client.get(f"/events/{event_id}?google_id=u_host").json()
    assert after["url"] == POST_URL
    assert after["description"] == "Churras na laje, traz gelo"


# ── 4. Attaching a link ─────────────────────────────────────────────

def test_attach_link_rejects_non_instagram(api):
    _db, _main, client = api
    event_id = _plan(_db)
    r = _patch(client, event_id, "u_host", source_url="https://www.sympla.com.br/evento/x")
    assert r.status_code == 400
    assert client.get(f"/events/{event_id}?google_id=u_host").json()["url"] == ""


def test_attach_link_shows_as_url_without_pinning_description(api):
    _db, _main, client = api
    event_id = _plan(_db)

    r = _patch(client, event_id, "u_host", source_url=POST_URL, source_ig_handle="barfolia")
    assert r.status_code == 200, r.text
    assert r.json()["view"]["url"] == POST_URL

    ge = _db.get_group_event(event_id)
    assert ge["description"].endswith(f"Ver original: {POST_URL}")
    assert ge["source_ig_handle"] == "barfolia"
    # A link is metadata, not prose: the catalog twin may still improve
    # the description later.
    assert "description" not in (ge.get("edited_fields") or [])

    shown = client.get(f"/events/{event_id}?google_id=u_host").json()
    assert shown["url"] == POST_URL
    assert shown["description"] == "Churras na laje"


def test_attach_link_binds_to_the_catalog_twin(api):
    _db, _main, client = api
    catalog_id = _catalog_post(_db)
    event_id = _plan(_db, description="")

    r = _patch(client, event_id, "u_host", source_url=POST_URL)
    assert r.status_code == 200, r.text
    assert _db.get_group_event(event_id)["source_event_id"] == catalog_id
    # One post, one set of facts: the fork now reads the catalog's
    # description, keeping its own link.
    shown = client.get(f"/events/{event_id}?google_id=u_host").json()
    assert shown["description"] == "Festa de samba"
    assert shown["url"] == POST_URL


def test_attach_link_by_founder_and_description_edit_in_one_save(api):
    _db, _main, client = api
    event_id = _plan(_db, invitees=("u_ana", "u_founder"))

    r = _patch(client, event_id, "u_founder", description="Agora com flyer",
               source_url=POST_URL)
    assert r.status_code == 200, r.text
    shown = client.get(f"/events/{event_id}?google_id=u_founder").json()
    assert shown["description"] == "Agora com flyer"
    assert shown["url"] == POST_URL
    # The person wrote this description: it is pinned.
    assert "description" in _db.get_group_event(event_id)["edited_fields"]


# ── 5. Picking the catalog event ────────────────────────────────────

def test_link_catalog_event_reads_its_facts_and_link(api):
    _db, _main, client = api
    catalog_id = _catalog_post(_db)
    event_id = _plan(_db, description="")

    r = _patch(client, event_id, "u_host", source_event_id=catalog_id)
    assert r.status_code == 200, r.text
    ge = _db.get_group_event(event_id)
    assert ge["source_event_id"] == catalog_id
    assert ge["source_ig_handle"] == "barfolia"
    view = r.json()["view"]
    assert view["name"] == "Samba do Folia"
    assert view["venue"] == "Bar Folia"
    assert view["description"] == "Festa de samba"
    assert view["url"] == POST_URL
    assert view["sourceEventId"] == catalog_id


def test_link_catalog_event_keeps_a_hand_edited_field(api):
    _db, _main, client = api
    catalog_id = _catalog_post(_db)
    event_id = _plan(_db)

    r = _patch(client, event_id, "u_host", name="Samba (a nossa mesa)", source_event_id=catalog_id)
    assert r.status_code == 200, r.text
    view = r.json()["view"]
    assert view["name"] == "Samba (a nossa mesa)"   # pinned by this edit
    assert view["venue"] == "Bar Folia"             # the catalog's


def test_link_catalog_event_refuses_unknown_and_empty(api):
    _db, _main, client = api
    event_id = _plan(_db)
    assert _patch(client, event_id, "u_host", source_event_id="instagram_ig_nope_ZZZ").status_code == 404
    assert _patch(client, event_id, "u_host", source_event_id="").status_code == 400
    assert not _db.get_group_event(event_id).get("source_event_id")
