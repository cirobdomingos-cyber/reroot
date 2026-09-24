"""
Tests for the "🎉 Ana vai" push — a friend confirming an event.

Context (Sep 2026): the push only reached friends already on the event
(RSVPed, invited, or hosting), which made it useless for the one thing
it's for: "Ana vai" is the reason to look at a night you hadn't
considered. Now every accepted friend hears, with three brakes instead
of that gate — the sender's share toggle, the recipient's alerts toggle,
and quiet hours — and one push slot per day with a count.

What must hold:
  1. A friend hears about a catalog RSVP they had nothing to do with;
     a non-friend or a pending request doesn't.
  2. Either side's toggle silences it. A past night is not news.
  3. Quiet hours park the alert; the 09:00 job sends one push per
     recipient naming every friend, once. A withdrawn RSVP is dropped.
  4. An invitee who is also a friend gets exactly one push — and during
     quiet hours still gets it now, through the roster path.
  5. The body says where and when; a second alert of the day carries
     the count, because the tag collapses the day into one slot.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main", "enrichment"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    for gid, name in (("u_ana", "Ana"), ("u_bia", "Bia"), ("u_ciro", "Ciro"), ("u_dani", "Dani")):
        _db.upsert_user_state(gid, {"userName": name})
    # Daytime unless a test says otherwise — CI runs at night too.
    monkeypatch.setattr(_main.quiet_hours, "is_quiet", lambda now=None: False)
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _friends(_db, a, b, status="accepted"):
    now = datetime.now(timezone.utc).isoformat()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO friendships (user_a, user_b, status, initiated_by, created_at)"
            " VALUES (?,?,?,?,?)", (a, b, status, a, now),
        )
        conn.commit()


def _sent(monkeypatch, main):
    calls = []
    monkeypatch.setattr(main, "_send_push_to_user",
                        lambda gid, **kw: (calls.append((gid, kw)), 1)[1])
    return calls


def _rsvp(client, gid, event_id="instagram_ig_pedreira_X1", name="Terno Rei",
          venue="Pedreira", date="2099-09-26T21:00:00"):
    r = client.post("/rsvp", json={
        "google_id": gid, "event_id": event_id, "event_name": name,
        "event_venue": venue, "event_date": date, "event_url": "",
    })
    assert r.status_code == 200, r.text


# ── 1. Who hears ────────────────────────────────────────────────────

def test_friend_hears_about_a_catalog_rsvp_they_had_not_considered(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    calls = _sent(monkeypatch, main)

    _rsvp(client, "u_ana")

    assert [gid for gid, _ in calls] == ["u_ciro"]
    kw = calls[0][1]
    assert kw["title"] == "🎉 Ana vai"
    assert kw["body"] == "Terno Rei · Pedreira · 26/09 21h"
    assert kw["tag"].startswith("friend-rsvp-")


def test_non_friend_and_pending_request_hear_nothing(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_bia", status="pending")
    calls = _sent(monkeypatch, main)

    _rsvp(client, "u_ana")

    assert calls == []


def test_reconfirming_does_not_repeat(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    calls = _sent(monkeypatch, main)

    _rsvp(client, "u_ana")
    _rsvp(client, "u_ana")

    assert len(calls) == 1


# ── 2. The brakes ───────────────────────────────────────────────────

def test_recipient_toggle_off_silences(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    _db.upsert_user_state("u_ciro", {"userName": "Ciro", "privacy": {"friendRsvpAlerts": False}})
    calls = _sent(monkeypatch, main)

    _rsvp(client, "u_ana")

    assert calls == []


def test_sender_share_toggle_off_silences(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    _db.upsert_user_state("u_ana", {"userName": "Ana", "privacy": {"shareRsvps": False}})
    calls = _sent(monkeypatch, main)

    _rsvp(client, "u_ana")

    assert calls == []


def test_past_night_is_not_news(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    calls = _sent(monkeypatch, main)

    _rsvp(client, "u_ana", event_id="instagram_ig_old_1", date="2020-01-01T21:00:00")

    assert calls == []


# ── 3. Quiet hours ──────────────────────────────────────────────────

def test_quiet_hours_park_and_morning_sends_one_push_per_recipient(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    _friends(_db, "u_bia", "u_ciro")
    _friends(_db, "u_bia", "u_dani")
    calls = _sent(monkeypatch, main)

    monkeypatch.setattr(main.quiet_hours, "is_quiet", lambda now=None: True)
    _rsvp(client, "u_ana")
    _rsvp(client, "u_bia", event_id="instagram_ig_folia_Y2", name="Samba do Folia", venue="Bar Folia")
    assert calls == []

    monkeypatch.setattr(main.quiet_hours, "is_quiet", lambda now=None: False)
    result = main.send_deferred_friend_rsvps()

    assert result == {"recipients": 2, "sent": 2}
    by_recipient = {gid: kw for gid, kw in calls}
    assert set(by_recipient) == {"u_ciro", "u_dani"}
    assert by_recipient["u_ciro"]["title"] == "🎉 Enquanto você dormia"
    assert by_recipient["u_ciro"]["body"] == "Ana vai · Terno Rei; Bia vai · Samba do Folia"
    assert by_recipient["u_dani"]["body"] == "Bia vai · Samba do Folia"

    # Once.
    assert main.send_deferred_friend_rsvps() == {"recipients": 0, "sent": 0}
    assert len(calls) == 2


def test_morning_drops_a_withdrawn_rsvp(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    calls = _sent(monkeypatch, main)

    monkeypatch.setattr(main.quiet_hours, "is_quiet", lambda now=None: True)
    _rsvp(client, "u_ana")
    client.delete("/rsvp/instagram_ig_pedreira_X1?google_id=u_ana")

    monkeypatch.setattr(main.quiet_hours, "is_quiet", lambda now=None: False)
    assert main.send_deferred_friend_rsvps()["sent"] == 0
    assert calls == []


# ── 4. Private events: one push, and now ────────────────────────────

def _plan(_db, invitees):
    ev = _db.create_group_event(
        group_id=None, google_id="u_ciro", name="Churras",
        date_start="2099-12-01T20:00:00", extra_invitee_ids=list(invitees),
    )
    return ev["id"]


def test_invitee_who_is_also_a_friend_gets_one_push(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    event_id = _plan(_db, ["u_ana", "u_bia"])
    calls = _sent(monkeypatch, main)

    _rsvp(client, "u_ana", event_id=event_id, name="Churras", venue="", date="2099-12-01T20:00:00")

    recipients = sorted(gid for gid, _ in calls)
    assert recipients == ["u_bia", "u_ciro"]     # host + other invitee, each once


def test_quiet_hours_guest_still_hears_now(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    event_id = _plan(_db, ["u_ana"])
    calls = _sent(monkeypatch, main)
    monkeypatch.setattr(main.quiet_hours, "is_quiet", lambda now=None: True)

    _rsvp(client, "u_ana", event_id=event_id, name="Churras", venue="", date="2099-12-01T20:00:00")

    assert [gid for gid, _ in calls] == ["u_ciro"]   # the host, through the roster path
    assert _db.take_deferred_friend_rsvps() == {}     # nothing parked twice


# ── 5. Body and count ───────────────────────────────────────────────

def test_second_alert_of_the_day_carries_the_count(api, monkeypatch):
    _db, main, client = api
    _friends(_db, "u_ana", "u_ciro")
    _friends(_db, "u_bia", "u_ciro")
    calls = _sent(monkeypatch, main)

    _rsvp(client, "u_ana")
    _rsvp(client, "u_bia", event_id="instagram_ig_folia_Y2", name="Samba do Folia", venue="Bar Folia",
          date="2099-09-27T19:30:00")

    assert calls[0][1]["body"] == "Terno Rei · Pedreira · 26/09 21h"
    assert calls[1][1]["body"] == "Samba do Folia · Bar Folia · 27/09 19h30 · +1 amigo hoje"
    assert calls[0][1]["tag"] == calls[1][1]["tag"]   # one slot per day
