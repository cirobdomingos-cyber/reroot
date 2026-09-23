"""
Tests for the per-event `tipo` tag — what happens at the event.

Context (23 Sep 2026): `kind` put 129 of 167 upcoming events in
"community", the chips in Eventos group by the venue's category (a bar
posting a book launch is "Bares"), and genre covers the music half of
the catalog only. Comedy — 17 events, the most homogeneous cluster in
the catalog — had no axis at all. `tipo` is that axis, and a channel
rule is a pair (tipos, genres).

What must hold:
  1. Only tipos from the closed vocabulary survive; "outro" is one of
     them — a real event that fits no bucket is an answer, not a gap.
  2. Anything invented is dropped, so the backfill asks again.
  3. The prompt, the batch prompt and the validator don't drift apart.
  4. The batch classifier keeps only vocabulary answers for known ids.
"""
import re
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import enrichment  # noqa: E402


@pytest.mark.parametrize("tipo", sorted(enrichment.TIPOS))
def test_every_known_tipo_survives(tipo):
    assert enrichment._clean_tipo(tipo) == tipo


def test_outro_is_a_real_answer():
    assert enrichment._clean_tipo("outro") == "outro"


def test_an_invented_tipo_is_dropped():
    assert enrichment._clean_tipo("balada") == ""
    assert enrichment._clean_tipo("show de rock") == ""
    assert enrichment._clean_tipo("shows") == ""


def test_missing_values_are_absent():
    assert enrichment._clean_tipo(None) == ""
    assert enrichment._clean_tipo("") == ""
    assert enrichment._clean_tipo("   ") == ""


def test_case_and_whitespace_are_normalized():
    assert enrichment._clean_tipo("  Comedia ") == "comedia"


def _vocab_in(prompt: str, field: str) -> set[str]:
    line = next(l for l in prompt.splitlines() if l.strip().startswith(f'"{field}":'))
    return set(re.findall(r'"([a-z_]+)"', line.split(":", 1)[1]))


def test_the_prompt_offers_exactly_the_accepted_vocabulary():
    """Drift guard, same as the genre one: the enrichment prompt lists
    what the model may answer, _clean_tipo decides what's kept."""
    assert _vocab_in(enrichment.ENRICHMENT_PROMPT, "tipo") == set(enrichment.TIPOS)


def test_the_batch_prompt_offers_exactly_the_accepted_vocabulary():
    listed = re.search(r"destas palavras:\n(.+?)\n\n", enrichment.TIPO_BACKFILL_PROMPT, re.S).group(1)
    assert set(re.findall(r"[a-z_]+", listed)) == set(enrichment.TIPOS)


def test_classify_tipos_keeps_only_vocabulary_answers_for_known_ids(monkeypatch):
    class _Resp:
        content = [type("C", (), {"text": (
            '[{"id": "a", "tipo": "comedia"}, {"id": "b", "tipo": "balada"},'
            ' {"id": "zzz", "tipo": "show"}, {"id": "c", "tipo": "OUTRO"}]'
        )})()]
        usage = None

    class _Messages:
        def create(self, **kw):
            return _Resp()

    class _Client:
        messages = _Messages()

    p = enrichment.EnrichmentPipeline.__new__(enrichment.EnrichmentPipeline)
    p.client = _Client()
    out = p.classify_tipos([{"id": "a"}, {"id": "b"}, {"id": "c"}])
    assert out == {"a": "comedia", "c": "outro"}
