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
