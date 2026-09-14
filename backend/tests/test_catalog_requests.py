"""
Tests for the catalog review queue.

Context: events created from an Instagram link are private first. The post
behind them is suggested for the public catalog and waits for a curator,
who is notified, can edit the fields, and approves or rejects. The queue
lives in submitted_events (status='review').

What has to hold, because none of it is visible from the UI until it fails:
  1. A post is queued once — an open or approved request blocks a second
     one for the same post; a rejected request doesn't.
  2. Resolving is conditional on still being in review, so two curators
     can't both publish the same request.
  3. Curator edits touch content only, never status or review bookkeeping.
  4. Curators are found for notification by email, case-insensitively,
     even though pushes are addressed by account id.
  5. Legacy direct submissions never appear in the review queries.
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


def _request(db, shortcode="DdCsjnJALlj", **overrides):
    fields = dict(
        name="Samba Casa Forte #40", description="Roda de samba",
        venue_name="Sociedade 13 de Maio", date_start="2026-09-18T21:00:00",
        url=f"https://www.instagram.com/p/{shortcode}/", image_url="",
        ig_handle="sambacasaforte", shortcode=shortcode,
        group_event_id="grp_ev_abc", submitted_by="u_friend",
    )
    fields.update(overrides)
    return db.insert_catalog_request(**fields)


def test_open_request_blocks_a_duplicate(db):
    rid = _request(db)
    found = db.find_catalog_request_by_shortcode("DdCsjnJALlj")
    assert found and found["id"] == rid and found["status"] == "review"
    assert [r["id"] for r in db.list_catalog_requests("review")] == [rid]


def test_rejected_post_can_be_suggested_again(db):
    rid = _request(db)
    assert db.resolve_catalog_request(rid, "rejected", "curator@x.com", note="fora de CWB")
    assert db.find_catalog_request_by_shortcode("DdCsjnJALlj") is None
    assert db.list_catalog_requests("review") == []
    assert [r["id"] for r in db.list_catalog_requests("rejected")] == [rid]


def test_resolve_only_wins_once(db):
    rid = _request(db)
    assert db.resolve_catalog_request(rid, "approved", "a@x.com", catalog_event_id="submitted_igpost_DdCsjnJALlj")
    # The second curator loses — no double publish, no approve-after-reject.
    assert not db.resolve_catalog_request(rid, "approved", "b@x.com")
    assert not db.resolve_catalog_request(rid, "rejected", "b@x.com")
    row = db.get_catalog_request(rid)
    assert row["status"] == "approved" and row["reviewed_by"] == "a@x.com"
    assert row["enriched_event_id"] == "submitted_igpost_DdCsjnJALlj"
    # An approved post still blocks re-queueing.
    assert db.find_catalog_request_by_shortcode("DdCsjnJALlj")["id"] == rid


def test_reopen_puts_a_failed_publish_back_in_the_queue(db):
    rid = _request(db)
    assert db.resolve_catalog_request(rid, "approved", "a@x.com", catalog_event_id="x")
    db.reopen_catalog_request(rid)
    row = db.get_catalog_request(rid)
    assert row["status"] == "review" and row["reviewed_by"] == "" and row["enriched_event_id"] is None


def test_curator_edits_are_content_only(db):
    rid = _request(db)
    row = db.update_catalog_request(rid, {
        "name": "Samba Casa Forte — Nova Temporada",
        "status": "approved",            # must be ignored
        "reviewed_by": "sneaky@x.com",   # must be ignored
        "venue_name": None,              # None = keep
    })
    assert row["name"] == "Samba Casa Forte — Nova Temporada"
    assert row["status"] == "review" and row["reviewed_by"] == ""
    assert row["venue_name"] == "Sociedade 13 de Maio"


def test_curators_found_by_email_case_insensitively(db):
    db.add_curator("Curadora@Example.com", is_curator_flag=True)
    db.add_curator("feedback-only@example.com", is_curator_flag=False, is_feedbacker_flag=True)
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users (id, display_name, email, picture, created_at) VALUES (?,?,?,?,?)",
                     ("u_curator", "Ana", "CURADORA@example.com", "", "2026-09-13"))
        conn.execute("INSERT INTO users (id, display_name, email, picture, created_at) VALUES (?,?,?,?,?)",
                     ("u_feedback", "Bia", "feedback-only@example.com", "", "2026-09-13"))
        conn.commit()
    emails = db.list_curator_emails()
    assert emails == ["curadora@example.com"]
    assert db.user_ids_for_emails(emails) == ["u_curator"]
    assert db.user_ids_for_emails([]) == []


def test_legacy_submissions_stay_out_of_the_queue(db):
    legacy = db.insert_submitted_event(
        name="Festa antiga", description="", venue_name="Bar", venue_address="",
        city="Curitiba", date_start="2026-08-29T19:00:00", price_min=0, price_max=0,
        url="https://www.instagram.com/p/OLD/",
    )
    assert db.get_catalog_request(legacy) is None
    assert db.list_catalog_requests("review") == []


def test_private_event_can_point_at_its_catalog_event(db):
    ev = db.create_group_event(
        group_id=None, google_id="host", name="Samba com a galera",
        date_start="2026-09-18T21:00:00", extra_invitee_ids=["guest"],
    )
    assert db.set_group_event_source(ev["id"], "submitted_igpost_DdCsjnJALlj")
    assert db.get_group_event(ev["id"])["source_event_id"] == "submitted_igpost_DdCsjnJALlj"
    assert not db.set_group_event_source("grp_ev_missing", "x")
