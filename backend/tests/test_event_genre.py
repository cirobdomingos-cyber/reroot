"""
Tests for the per-event musical genre tag.

Context: the catalog's category (bar, música, teatro…) is a property of the
tracked Instagram account, so it can't answer "is tonight rock or pagode" —
the same bar does both on different nights. Genre is therefore extracted
per event, in the enrichment pass that already reads every caption, which
makes it free in LLM terms but puts a model's improvisation in the middle
of the data.

What must hold:
  1. Only genres from the closed vocabulary survive.
  2. "nenhum" — what the prompt asks for on non-music nights — reads as
     absent, the same as "couldn't tell". One way to say "no genre".
  3. Anything invented is dropped rather than stored; a wrong label puts
     sertanejo in a rock room, which is worse than an untagged event.
  4. The prompt and the validator don't drift apart.
"""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import enrichment  # noqa: E402


@pytest.mark.parametrize("genre", sorted(enrichment.GENRES))
def test_every_known_genre_survives(genre):
    assert enrichment._clean_genre(genre) == genre


def test_nenhum_reads_as_absent():
    """The prompt's answer for "this isn't a music night"."""
    assert enrichment._clean_genre("nenhum") == ""


def test_an_invented_genre_is_dropped():
    assert enrichment._clean_genre("axé") == ""
    assert enrichment._clean_genre("rock alternativo dos anos 90") == ""
    assert enrichment._clean_genre("rocks") == ""


def test_missing_values_are_absent():
    assert enrichment._clean_genre(None) == ""
    assert enrichment._clean_genre("") == ""
    assert enrichment._clean_genre("   ") == ""


def test_case_and_whitespace_are_normalized():
    assert enrichment._clean_genre("  ROCK ") == "rock"
    assert enrichment._clean_genre("Samba_Pagode") == "samba_pagode"


def test_the_prompt_offers_exactly_the_accepted_vocabulary():
    """Drift guard: the prompt lists what the model may answer with, and
    _clean_genre decides what's kept. If they disagree, the model gets asked
    for a value that is then silently thrown away — and nothing would fail."""
    prompt = enrichment.ENRICHMENT_PROMPT
    for genre in enrichment.GENRES:
        assert f'"{genre}"' in prompt, f"{genre} is accepted but never offered"
