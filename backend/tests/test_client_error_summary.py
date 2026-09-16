"""
Tests for the founder-only client-error panel (docs/NEXT.md item 1).

Context: /errors/client stores every uncaught JS error and unhandled
promise rejection, but only in analytics_events.properties_json — and
/analytics/funnel counts by event_name, which collapses every distinct
"js_uncaught" message (a real bug vs. a different real bug) into one
bucket. 183 uncaught errors and 145 unhandled rejections across 38
accounts were effectively unreadable. This groups them by (type, message)
with a count, first/last seen, and one sample url + user per group.

What must hold:
  1. Same (type, message) pair collapses into one row with the right count.
  2. Different messages under the same error_type stay separate rows.
  3. Rows are ordered by count, most frequent first.
  4. The most recent url/google_id in a group is the one reported, even
     if an earlier report in that group had none.
  5. GET /admin/client-errors is founder-gated like every other /admin/* route.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    _db.add_curator("founder@example.com", is_founder_flag=True)
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


def _report(db, event_name, message, url="", google_id="", when=None):
    ts = (when or datetime.now(timezone.utc)).isoformat()
    db.insert_analytics_event(
        event_name=event_name,
        properties_json=json.dumps({"message": message, "url": url, "google_id": google_id}),
        session_id="s1",
    )
    # insert_analytics_event always stamps "now" — patch the row's
    # created_at directly so ordering-sensitive assertions (last_seen,
    # "freshest sample wins") aren't all racing the same instant.
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE analytics_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM analytics_events)",
            (ts,),
        )
        conn.commit()


def test_same_message_collapses_with_right_count(api):
    db, _main, _client = api
    _report(db, "client_error:js_uncaught", "Cannot read properties of null")
    _report(db, "client_error:js_uncaught", "Cannot read properties of null")
    _report(db, "client_error:js_uncaught", "Cannot read properties of null")
    errors = db.get_client_error_summary()
    assert len(errors) == 1
    assert errors[0]["count"] == 3
    assert errors[0]["error_type"] == "js_uncaught"


def test_different_messages_stay_separate(api):
    db, _main, _client = api
    _report(db, "client_error:js_uncaught", "Error A")
    _report(db, "client_error:js_uncaught", "Error B")
    errors = db.get_client_error_summary()
    assert len(errors) == 2
    assert {e["message"] for e in errors} == {"Error A", "Error B"}


def test_ordered_by_count_descending(api):
    db, _main, _client = api
    _report(db, "client_error:js_uncaught", "Rare")
    _report(db, "client_error:js_uncaught", "Common")
    _report(db, "client_error:js_uncaught", "Common")
    errors = db.get_client_error_summary()
    assert [e["message"] for e in errors] == ["Common", "Rare"]


def test_freshest_sample_wins_even_if_earlier_report_was_empty(api):
    db, _main, _client = api
    t0 = datetime.now(timezone.utc)
    _report(db, "client_error:js_uncaught", "Boom", url="", google_id="", when=t0)
    _report(db, "client_error:js_uncaught", "Boom", url="/events", google_id="g123", when=t0 + timedelta(minutes=5))
    errors = db.get_client_error_summary()
    assert errors[0]["sample_url"] == "/events"
    assert errors[0]["sample_google_id"] == "g123"


def test_last_seen_is_the_most_recent_report(api):
    db, _main, _client = api
    t0 = datetime.now(timezone.utc)
    _report(db, "client_error:js_uncaught", "Boom", when=t0)
    _report(db, "client_error:js_uncaught", "Boom", when=t0 + timedelta(hours=2))
    errors = db.get_client_error_summary()
    assert errors[0]["first_seen"] == t0.isoformat()
    assert errors[0]["last_seen"] == (t0 + timedelta(hours=2)).isoformat()


def test_non_error_analytics_events_are_excluded(api):
    db, _main, _client = api
    db.insert_analytics_event(event_name="events_filter_category", properties_json="{}", session_id="s1")
    _report(db, "client_error:js_uncaught", "Boom")
    errors = db.get_client_error_summary()
    assert len(errors) == 1


def test_endpoint_requires_founder(api):
    _db, _main, client = api
    res = client.get("/admin/client-errors")
    assert res.status_code == 401
    res = client.get("/admin/client-errors?requesting_email=nobody@example.com")
    assert res.status_code == 403


def test_endpoint_returns_grouped_errors_for_founder(api):
    db, _main, client = api
    _report(db, "client_error:js_uncaught", "Boom", url="/events", google_id="g123")
    res = client.get("/admin/client-errors?requesting_email=founder@example.com")
    assert res.status_code == 200
    body = res.json()
    assert body["errors"][0]["message"] == "Boom"
    assert body["errors"][0]["count"] == 1
    assert body["errors"][0]["sample_url"] == "/events"
