"""
Tests for the weekly "novos em CWB" push.

Context (Oct 2026): the digest pushed after every daily scrape, which on
a normal day meant "✨ 25 novos em CWB" every afternoon — the app's most
frequent notification. Now the scrape only records the day's snapshot
(Novidades and Home stay daily) and one push goes out on Thursdays,
built from the week's snapshots.

What must hold:
  1. The scrape records today's digest and sends nothing.
  2. The weekly push covers the last seven days of snapshots, once per
     event, and never announces something that already happened.
  3. Its own list is a digest row the push opens, but Home's "o que
     rolou hoje" keeps showing the latest daily snapshot.
  4. It actually reaches a web-push subscriber. #91 dropped the
     `has_vapid` line and every digest since raised NameError at the
     first one.
  5. The per-user opt-out still holds.
"""
import asyncio
import json
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

SOON = datetime.now(timezone.utc) + timedelta(days=3)
PAST = datetime.now(timezone.utc) - timedelta(days=2)


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    return _db, _main


def _event(_db, ev_id, *, when=SOON, name=None):
    from models import EnrichedEvent
    _db.upsert_event(EnrichedEvent(
        id=ev_id, source="instagram", external_id=ev_id.split("_", 1)[1],
        name=name or ev_id, description="desc", venue_name="Bar X", venue_address="",
        neighborhood="Batel", city="Curitiba",
        date_start=when, date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="C",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="g", url="u", image_url=None,
        fetched_at=datetime.now(timezone.utc), genre="",
    ))


def _digest_at(_db, digest_id, event_ids, days_ago):
    """A digest row created `days_ago` days back."""
    created = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    with _db.get_conn() as conn:
        conn.execute(
            "INSERT INTO daily_digests (id, event_ids, created_at) VALUES (?, ?, ?)",
            (digest_id, json.dumps(event_ids), created),
        )
        conn.commit()


@pytest.fixture()
def webpush_sent(api, monkeypatch):
    """A fake pywebpush that records each payload, VAPID configured."""
    _db, main = api
    sent = []
    fake = types.ModuleType("pywebpush")

    class WebPushException(Exception):
        pass

    def webpush(subscription_info, data, **kw):
        sent.append((subscription_info["endpoint"], json.loads(data)))

    fake.webpush, fake.WebPushException = webpush, WebPushException
    monkeypatch.setitem(sys.modules, "pywebpush", fake)
    monkeypatch.setattr(main, "VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setattr(main, "VAPID_PUBLIC_KEY", "pub")
    return sent


# -- 1. the scrape records, never pushes -----------------------------

def test_the_scrape_records_today_and_sends_nothing(api, webpush_sent):
    _db, main = api
    _db.upsert_push_subscription("https://push/ana", json.dumps({"p256dh": "k", "auth": "a"}), "u_ana")
    _event(_db, "instagram_a")
    out = main.record_daily_digest(["instagram_a"])
    assert out["recorded"] == 1
    assert _db.get_latest_daily_digest()["event_ids"] == ["instagram_a"]
    assert webpush_sent == []


def test_ids_parked_overnight_ride_into_the_snapshot(api):
    _db, main = api
    _event(_db, "instagram_a")
    _event(_db, "instagram_b")
    _db.defer_digest_events(["instagram_a"])
    main.record_daily_digest(["instagram_b"])
    assert sorted(_db.get_latest_daily_digest()["event_ids"]) == ["instagram_a", "instagram_b"]


# -- 2. the week, once per event, upcoming only ----------------------

def test_the_week_is_collected_once_per_event_and_past_nights_are_dropped(api):
    _db, main = api
    for ev in ("instagram_a", "instagram_b", "instagram_c"):
        _event(_db, ev)
    _event(_db, "instagram_gone", when=PAST)
    _event(_db, "instagram_old")
    _digest_at(_db, "d_mon", ["instagram_a", "instagram_gone"], days_ago=3)
    _digest_at(_db, "d_wed", ["instagram_a", "instagram_b"], days_ago=1)
    _digest_at(_db, "d_today", ["instagram_c"], days_ago=0)
    _digest_at(_db, "d_lastweek", ["instagram_old"], days_ago=9)
    out = asyncio.run(main.send_weekly_digest())
    assert out["reason"] == "no subscribers"     # built, nobody to send to
    weekly = [d for d in _all_digests(_db) if d.startswith("w_")]
    assert len(weekly) == 1
    assert sorted(_db.get_daily_digest(weekly[0])["event_ids"]) == \
        ["instagram_a", "instagram_b", "instagram_c"]


def test_a_week_with_nothing_upcoming_sends_nothing(api, webpush_sent):
    _db, main = api
    _db.upsert_push_subscription("https://push/ana", json.dumps({"p256dh": "k", "auth": "a"}), "u_ana")
    _event(_db, "instagram_gone", when=PAST)
    _digest_at(_db, "d_mon", ["instagram_gone"], days_ago=3)
    out = asyncio.run(main.send_weekly_digest())
    assert out["sent"] == 0
    assert webpush_sent == []


# -- 3. Home keeps the daily snapshot --------------------------------

def test_home_keeps_showing_the_daily_snapshot_after_the_weekly_push(api):
    _db, main = api
    _event(_db, "instagram_a")
    _event(_db, "instagram_b")
    _digest_at(_db, "d_wed", ["instagram_a"], days_ago=1)
    main.record_daily_digest(["instagram_b"])
    asyncio.run(main.send_weekly_digest())
    assert _db.get_latest_daily_digest()["event_ids"] == ["instagram_b"]


# -- 4. it reaches a web-push subscriber -----------------------------

def test_the_weekly_push_reaches_a_web_push_subscriber(api, webpush_sent):
    _db, main = api
    _db.upsert_push_subscription("https://push/ana", json.dumps({"p256dh": "k", "auth": "a"}), "u_ana")
    _event(_db, "instagram_a", name="Tributo Bowie")
    _event(_db, "instagram_b", name="Samba da Vila")
    _digest_at(_db, "d_tue", ["instagram_a", "instagram_b"], days_ago=2)
    out = asyncio.run(main.send_weekly_digest())
    assert out["sent"] == 1
    endpoint, payload = webpush_sent[0]
    assert endpoint == "https://push/ana"
    assert payload["title"] == "✨ 2 novos em CWB esta semana"
    assert "Tributo Bowie" in payload["body"]
    assert payload["url"].endswith(out_digest_id(_db))
    assert payload["tag"] == "weekly-digest"


# -- 5. the opt-out still holds --------------------------------------

def test_someone_who_turned_it_off_gets_nothing(api, webpush_sent, monkeypatch):
    _db, main = api
    _db.upsert_push_subscription("https://push/ana", json.dumps({"p256dh": "k", "auth": "a"}), "u_ana")
    monkeypatch.setattr(main, "_user_daily_digest_opted_in", lambda gid: gid != "u_ana")
    _event(_db, "instagram_a")
    _digest_at(_db, "d_tue", ["instagram_a"], days_ago=2)
    out = asyncio.run(main.send_weekly_digest())
    assert out["sent"] == 0 and out["skipped"] == 1
    assert webpush_sent == []


def _all_digests(_db):
    with _db.get_conn() as conn:
        return [r["id"] for r in conn.execute("SELECT id FROM daily_digests").fetchall()]


def out_digest_id(_db):
    return next(d for d in _all_digests(_db) if d.startswith("w_"))
