"""
Tests for the "N avisados" count the add-to-group sheet reports back.

Context: adding an event to a group already pushed to every member, but
nothing in the UI said so — which is a large part of why groups sit
unused. The sheet now tells the user how many people it reached.

The number has to be what actually went out. That is not the group's
size: create_group_event has four exits and only ONE of them sends a
push. A count computed on the client from member_count would claim
"3 avisados" on the three exits that notify nobody — the same class of
confident-but-wrong claim as the "Grátis" label. So the backend reports
it, and these tests hold that contract.

What must hold:
  1. A fresh add reports exactly the invitees it queued pushes for.
  2. Re-adding the same catalog event (dedup exit) reports zero — the
     push went out on the first tap, not this one.
  3. A solo group reports zero rather than counting the creator.
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def api(tmp_path, monkeypatch):
    """Fresh DB + fresh module pair, with the push transport stubbed so
    the tests never depend on VAPID keys or the network."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    sent = []
    monkeypatch.setattr(
        _main, "_send_push_to_user",
        lambda uid, **kw: sent.append((uid, kw)),
    )
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app), sent


def _future():
    return (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()


def _crew(db, members=("bia", "caio", "dani")):
    group = db.create_group(google_id="ana", name="Crew")
    for m in members:
        db.join_group(group["id"], m)
    return group


def test_fresh_add_reports_who_it_reached(api):
    db, _, client, sent = api
    group = _crew(db)

    r = client.post(f"/groups/{group['id']}/events", json={
        "google_id": "ana", "name": "Samba na Sociedade",
        "venue": "Sociedade Operária", "date_start": _future(),
        "description": "", "note": "", "source_event_id": "instagram_ig_samba_ABC",
    })
    assert r.status_code == 200
    # Three members besides the creator — the creator is going by
    # definition and is auto-RSVP'd, never pushed.
    assert r.json()["notified_count"] == 3
    assert {uid for uid, _ in sent} == {"bia", "caio", "dani"}


def test_readding_the_same_event_reports_zero(api):
    """The dedup exit returns the existing row without pushing. Claiming
    "3 avisados" a second time would be telling the user their crew was
    pinged again when nobody's phone made a sound."""
    db, _, client, sent = api
    group = _crew(db)
    payload = {
        "google_id": "ana", "name": "Samba na Sociedade",
        "venue": "Sociedade Operária", "date_start": _future(),
        "description": "", "note": "", "source_event_id": "instagram_ig_samba_ABC",
    }
    client.post(f"/groups/{group['id']}/events", json=payload)
    sent.clear()

    r = client.post(f"/groups/{group['id']}/events", json=payload)
    assert r.status_code == 200
    assert r.json()["notified_count"] == 0
    assert sent == []


def test_solo_group_reports_zero_not_one(api):
    """member_count is 1 and the only member is the creator. The sheet
    must not say "1 avisado" about the person who just tapped."""
    db, _, client, _ = api
    group = db.create_group(google_id="ana", name="Sozinho")

    r = client.post(f"/groups/{group['id']}/events", json={
        "google_id": "ana", "name": "Cinema sozinho",
        "venue": "Sala 1", "date_start": _future(),
        "description": "", "note": "", "source_event_id": "instagram_ig_solo_XYZ",
    })
    assert r.status_code == 200
    assert r.json()["notified_count"] == 0


# ── the multi-group link path ────────────────────────────────────────

def test_linking_your_own_plan_notifies_the_group(api):
    """Adding a plan you already made to a group used to send nothing:
    the members became invitees and the event showed up in their
    Pendências, but no push ever left. "Fiz um plano, quero chamar a
    galera" is the most group-shaped action in the app, so it gets the
    same push the catalog path gets."""
    db, _, client, sent = api
    plan = db.create_group_event(
        group_id="", google_id="ana", name="Cerveja depois do trampo",
        description="", venue="Bar do Sax", date_start=_future(),
        date_end=None, visibility="members", note="",
        extra_invitee_ids=[],
    )
    group = _crew(db, members=("bia", "caio"))
    sent.clear()

    r = client.post(f"/groups/{group['id']}/events", json={
        "google_id": "ana", "name": plan["name"], "venue": plan["venue"],
        "date_start": plan["date_start"], "description": "", "note": "",
        "source_event_id": plan["id"],
    })
    assert r.status_code == 200
    # Prove this went through the LINK path and not the create path: the
    # same row came back, no second event was forked. Without this the
    # test would pass either way — both paths notify two people here.
    assert r.json()["id"] == plan["id"]
    assert len(db.get_group_events(group["id"], viewer_google_id="ana")) == 1

    assert r.json()["notified_count"] == 2
    assert {uid for uid, _ in sent} == {"bia", "caio"}
    # Members, so they get the group framing and a link into the group.
    assert all(kw["url"] == f"/#/channels/{group['id']}" for _, kw in sent)


def test_linking_does_not_re_notify_people_already_invited(api):
    """Someone already on the invitee list was pushed when the event was
    created. Pinging them again for a link they cannot even see would be
    noise, and would inflate the "N avisados" the sheet reports."""
    db, _, client, sent = api
    group = _crew(db, members=("bia", "caio"))
    plan = db.create_group_event(
        group_id="", google_id="ana", name="Cerveja depois do trampo",
        description="", venue="Bar do Sax", date_start=_future(),
        date_end=None, visibility="members", note="",
        # bia was invited by hand when the plan was made.
        extra_invitee_ids=["bia"],
    )
    sent.clear()

    r = client.post(f"/groups/{group['id']}/events", json={
        "google_id": "ana", "name": plan["name"], "venue": plan["venue"],
        "date_start": plan["date_start"], "description": "", "note": "",
        "source_event_id": plan["id"],
    })
    assert r.status_code == 200
    # Only caio is new to this event.
    assert r.json()["notified_count"] == 1
    assert {uid for uid, _ in sent} == {"caio"}


def test_relinking_the_same_group_still_reports_zero(api):
    """The "already in group_ids" exit. Nothing is added, so nothing is
    sent, and the sheet must not claim otherwise."""
    db, _, client, sent = api
    group = _crew(db, members=("bia",))
    plan = db.create_group_event(
        group_id="", google_id="ana", name="Cerveja depois do trampo",
        description="", venue="Bar do Sax", date_start=_future(),
        date_end=None, visibility="members", note="", extra_invitee_ids=[],
    )
    payload = {
        "google_id": "ana", "name": plan["name"], "venue": plan["venue"],
        "date_start": plan["date_start"], "description": "", "note": "",
        "source_event_id": plan["id"],
    }
    client.post(f"/groups/{group['id']}/events", json=payload)
    sent.clear()

    r = client.post(f"/groups/{group['id']}/events", json=payload)
    assert r.status_code == 200
    assert r.json()["notified_count"] == 0
    assert sent == []
