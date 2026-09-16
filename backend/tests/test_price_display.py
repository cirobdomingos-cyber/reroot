"""
Tests for what the catalog says about how much an event costs.

Context: the app showed "Grátis" whenever price_min and price_max were
both zero. But zero is what the extractor leaves behind when a caption
says nothing about money, which is most captions — so a pile of events
that charge at the door were listed as free. That is the one listing
error that costs the reader something real: they show up with no money.

What must hold:
  1. No price read => no price shown. Not "Grátis", not "?".
  2. A price we did read still shows, single value or range.
"""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


@pytest.fixture()
def main(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    return _main


def test_no_price_read_says_nothing(main):
    assert main._format_price(0, 0, "BRL") == "", \
        "zero is 'the caption was silent', not 'free'"


def test_a_single_price_still_shows(main):
    assert main._format_price(30, 30, "BRL") == "R$ 30"


def test_a_range_still_shows(main):
    assert main._format_price(30, 60, "BRL") == "R$ 30 – 60"


def test_a_free_event_we_actually_read_is_not_claimed_either(main):
    """Today a real zero and an unknown zero are the same value, so the
    honest answer for both is silence. If the extractor ever learns to
    say 'I read that it's free', this is the test that changes."""
    assert main._format_price(0.0, 0.0, "BRL") == ""


def test_other_currencies_keep_their_symbol(main):
    assert main._format_price(10, 10, "USD") == "$ 10"
