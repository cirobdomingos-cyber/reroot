"""
Tests for the bairro shown next to a venue (docs/NEXT.md).

Context: the enrichment prompt asks Claude for a `neighborhood_guess`, and
`_to_frontend` used to paste that answer straight into the `venue` string
the app renders. The model answers even when it has nothing to go on, so
the same venue came back with a different bairro per event — one
@barfolia post produced "Bar Folia · Centro" (19 Sep) and "Bar Folia ·
Água Verde" (20 Sep). Measured against production on 2026-09-19: 15 of 89
venues carried conflicting bairros, and 100 of 123 events disagreed with
the geocoded `venues.bairro`. Spot-checking the disagreements, the
geocoder was right every time (MON is Centro Cívico, not Água Verde).

The geocoded bairro was already in the payload as a separate `bairro`
field — just never used to build the label.

What must hold:
  1. A geocoded bairro wins over the enrichment guess.
  2. The guess is still used when the venue was never geocoded — it's
     better than nothing for a venue Nominatim hasn't resolved.
  3. A guess that reads as a hedge ("Centro ou Mercês"), names the city
     ("Curitiba"), or runs on into prose is dropped entirely. Showing no
     bairro beats showing a confident wrong one.
  4. A venue with no bairro from either source renders as the bare name,
     with no dangling separator — several readers split on " · ".
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


# ── 1. geocoded wins ────────────────────────────────────────────────

def test_geocoded_bairro_beats_the_enrichment_guess(main):
    # The real MON case: Nominatim says Centro Cívico, Claude guessed
    # Água Verde, which is across town.
    assert main._venue_label(
        "Museu Oscar Niemeyer", "Centro Cívico", "Água Verde"
    ) == "Museu Oscar Niemeyer · Centro Cívico"


# ── 2. guess survives when there's no pin ───────────────────────────

def test_guess_is_used_when_the_venue_was_never_geocoded(main):
    assert main._venue_label("Bar do Sax", "", "Batel") == "Bar do Sax · Batel"


# ── 3. hedges and non-answers are dropped ───────────────────────────

@pytest.mark.parametrize("guess", [
    "Centro ou Mercês",                        # hedge, real production value
    "Centro ou Água Verde",                    # hedge
    "Curitiba",                                # the city, not a bairro
    "Centro ou região central de Curitiba",    # hedge + city
    "Centro/Batel",                            # slash hedge
    "Centro Histórico / Entorno Parque Jaime Lerner",  # prose
    "Centro, Curitiba",                        # comma
    "",
    "   ",
])
def test_unusable_guesses_are_dropped(main, guess):
    assert main._clean_neighborhood_guess(guess) == ""
    assert main._venue_label("Patuscada", "", guess) == "Patuscada"


@pytest.mark.parametrize("guess", [
    "Batel",
    "Água Verde",
    "Centro Cívico",
    "Alto da Glória",
    "Boqueirão",        # contains "ou" INSIDE a word — must not trip the hedge
])
def test_real_bairros_survive(main, guess):
    assert main._clean_neighborhood_guess(guess) == guess


# ── 4. no dangling separator ────────────────────────────────────────

def test_no_bairro_at_all_renders_the_bare_name(main):
    # Readers split on " · " to recover the venue name (badges.py,
    # Events.jsx). A trailing separator would hand them an empty bairro.
    assert main._venue_label("Teatro Guaíra", "", "") == "Teatro Guaíra"
    assert " · " not in main._venue_label("Teatro Guaíra", "", "Curitiba")


def test_blank_venue_name_does_not_lead_with_a_separator(main):
    assert main._venue_label("", "Batel", "") == "Batel"
    assert main._venue_label("", "", "") == ""
