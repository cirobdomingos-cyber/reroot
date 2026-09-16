"""
Tests for the group composition stat.

Context: the dashboard counted how many groups exist (5) and nothing
about what happened after. "Created and abandoned" and "a real crew" were
the same number, so there was no way to tell whether people don't
understand groups or simply never invite anyone.

What must hold:
  1. Groups with more than one member, and groups with any event, are
     counted separately — a group can be one without the other.
  2. solo_and_empty counts exactly the created-then-nothing case.
  3. An event tagged to several groups counts for each of them.
  4. No groups at all doesn't divide by zero.
"""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    sys.modules.pop("database", None)
    import database as _db
    _db.init_db()
    return _db


def test_no_groups_is_not_a_crash(db):
    assert db.get_group_composition() == {
        "total": 0, "with_more_than_one_member": 0, "with_at_least_one_event": 0,
        "solo_and_empty": 0, "avg_members": 0, "member_counts": [], "event_counts": [],
    }


def test_members_and_events_are_counted_separately(db):
    # 1: created and abandoned.
    db.create_group(google_id="ana", name="Sozinho")
    # 2: people joined, nothing planned yet.
    crew = db.create_group(google_id="ana", name="Crew")
    db.join_group(crew["id"], "bia")
    db.join_group(crew["id"], "caio")
    # 3: one person, but they're actually using it.
    solo_active = db.create_group(google_id="dani", name="Plano solo")
    db.create_group_event(group_id=solo_active["id"], google_id="dani",
                          name="Churras", date_start="2026-12-01T20:00:00")

    c = db.get_group_composition()
    assert c["total"] == 3
    assert c["with_more_than_one_member"] == 1, "only Crew has more than one member"
    assert c["with_at_least_one_event"] == 1, "only Plano solo has an event"
    assert c["solo_and_empty"] == 1, "only Sozinho is created-then-nothing"
    assert c["member_counts"] == [3, 1, 1]
    assert c["event_counts"] == [1, 0, 0]


def test_event_shared_by_two_groups_counts_for_both(db):
    a = db.create_group(google_id="ana", name="A")
    b = db.create_group(google_id="ana", name="B")
    ev = db.create_group_event(group_id=a["id"], google_id="ana", name="Festa",
                               date_start="2026-12-02T20:00:00")
    db.link_event_to_group(ev["id"], b["id"], [])

    c = db.get_group_composition()
    assert c["with_at_least_one_event"] == 2
    assert c["solo_and_empty"] == 0
