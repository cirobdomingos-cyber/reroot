"""
Tests for account suggestions (Fontes → curator queue).

What must hold:
  1. A handle waiting for review is queued once; later suggestions bump
     request_count instead of creating duplicates.
  2. Once resolved, the same handle can be suggested again.
  3. Resolving is first-come: a second curator acting on the same request
     doesn't overwrite the first decision.
  4. A failed approval can be reopened.
  5. Tracked accounts are found regardless of how the handle was typed.
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


def test_open_suggestion_is_queued_once(db):
    first, created = db.insert_account_request("Barzinho", "", "ana")
    assert created and first["handle"] == "barzinho"
    again, created = db.insert_account_request("barzinho", "samba toda sexta", "bia")
    assert not created
    assert again["id"] == first["id"]
    assert again["request_count"] == 2
    assert again["note"] == "samba toda sexta", "a blank first note is filled by a later one"
    assert len(db.list_account_requests("review")) == 1


def test_resolved_handle_can_be_suggested_again(db):
    r, _ = db.insert_account_request("barzinho", "", "ana")
    assert db.resolve_account_request(r["id"], "rejected", "cur@x") is True
    _, created = db.insert_account_request("barzinho", "", "bia")
    assert created


def test_second_curator_does_not_overwrite_the_first(db):
    r, _ = db.insert_account_request("barzinho", "", "ana")
    assert db.resolve_account_request(r["id"], "approved", "first@x") is True
    assert db.resolve_account_request(r["id"], "rejected", "second@x") is False
    stored = db.get_account_request(r["id"])
    assert (stored["status"], stored["reviewed_by"]) == ("approved", "first@x")


def test_reopen_puts_it_back_in_the_queue(db):
    r, _ = db.insert_account_request("barzinho", "", "ana")
    db.resolve_account_request(r["id"], "approved", "cur@x")
    db.reopen_account_request(r["id"])
    assert [x["id"] for x in db.list_account_requests("review")] == [r["id"]]


def test_open_count_per_user(db):
    db.insert_account_request("um", "", "ana")
    db.insert_account_request("dois", "", "ana")
    r, _ = db.insert_account_request("tres", "", "ana")
    db.resolve_account_request(r["id"], "rejected", "cur@x")
    assert db.count_open_account_requests_by("ana") == 2


def test_tracked_account_lookup_ignores_case(db):
    # upsert_ig_account normalizes to lowercase; users type any casing.
    db.upsert_ig_account(handle="SociedadeBeneficente", label="Treze", category="bar",
                         added_by_email="t")
    acc = db.find_ig_account_ci("SOCIEDADEbeneficente")
    assert acc and acc["handle"] == "sociedadebeneficente"
    assert db.find_ig_account_ci("outra") is None
