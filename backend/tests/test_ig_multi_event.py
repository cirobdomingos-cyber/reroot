"""
Tests for one Instagram post announcing several events.

Context: the extraction contract was one JSON object per post, and the
prompt even told the model to pick the most time-sensitive one when a post
mixed several. But the weekly-lineup post is a staple of every bar in town
— "quinta tem Live Transmission, sexta tem Drive True, sábado tem o
especial nu metal" — so two thirds of that week never reached the catalog.

What must hold:
  1. A lineup post yields one event per announced night.
  2. Ids are stable across re-scrapes: the earliest keeps the post's own
     id (what every pre-existing row uses), later ones are date-suffixed.
  3. A single-event post is unchanged, including its id.
  4. One bad night doesn't cost the others.
  5. The old single-object answer still parses — the model still returns
     that shape sometimes.
"""
import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import scrapers.instagram_apify as ig  # noqa: E402


# The extractor cross-checks the weekday it extracted against the weekdays
# the caption names, per event. So fixtures have to land on real weekdays —
# an arbitrary "two days from now" gets dropped by that gate, which would
# make these tests pass for the wrong reason.
QUI, SEX, SAB = 3, 4, 5  # Python weekday(): Mon=0


def _next(weekday, hour=21, weeks=0):
    """Next future datetime falling on `weekday`."""
    now = datetime.now(timezone.utc)
    ahead = (weekday - now.weekday()) % 7 or 7
    d = now + timedelta(days=ahead + 7 * weeks)
    return d.replace(hour=hour, minute=0, second=0, microsecond=0)


def _past(weekday, hour=21):
    now = datetime.now(timezone.utc)
    back = (now.weekday() - weekday) % 7 or 7
    d = now - timedelta(days=back + 28)
    return d.replace(hour=hour, minute=0, second=0, microsecond=0)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _event_payload(name, dt):
    return {
        "is_recurring": False, "recurrence_label": None, "recurrence_days": [],
        "name": name, "description": "d", "venue_name": "Changes",
        "venue_address": "Rua Presidente Carlos Cavalcanti, 1122",
        "neighborhood": "São Francisco",
        "date_start": _iso(dt), "date_end": None,
        "price_min": 0, "price_max": 0,
    }


class _FakeClient:
    """Stands in for AsyncAnthropic — returns a canned JSON body."""

    def __init__(self, body):
        payload = json.dumps(body)

        class _Messages:
            async def create(self_inner, **kwargs):
                self.last_kwargs = kwargs
                return SimpleNamespace(
                    content=[SimpleNamespace(text=payload)],
                    usage=SimpleNamespace(input_tokens=1, output_tokens=1),
                )

        self.messages = _Messages()
        self.last_kwargs = None


def _post(caption):
    return {
        "caption": caption,
        "url": "https://www.instagram.com/p/ABC123/",
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
        "inputUrl": "https://www.instagram.com/changes.cwb/",
        "ownerUsername": "changes.cwb",
        "likesCount": 86,
        "id": "ABC123",
    }


LINEUP_CAPTION = (
    "Semana sem tempo ruim no Changes! Quinta 17/09 tem Live Transmission "
    "com post punk e new wave, entrada free a noite toda. Sexta 18/09 e com "
    "Drive True + HeartField. Sabado 19/09, Especial Nu Metal as 21h."
)


def _run(body, caption=LINEUP_CAPTION, monkeypatch=None):
    client = _FakeClient(body)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return asyncio.run(ig._extract_events(client, _post(caption), today)), client


@pytest.fixture(autouse=True)
def _no_image_fetch(monkeypatch):
    """The post has no displayUrl in these fixtures, but pin it anyway so a
    test never reaches out to the IG CDN."""
    async def no_image(_url):
        return None
    monkeypatch.setattr(ig, "_fetch_image_b64", no_image)


def test_a_lineup_post_yields_every_night(monkeypatch):
    events, _ = _run({
        "is_event": True,
        "events": [
            _event_payload("Live Transmission", _next(QUI)),
            _event_payload("Drive True + HeartField", _next(SEX)),
            _event_payload("Especial Nu Metal", _next(SAB)),
        ],
    })
    assert [e.name for e in events] == [
        "Live Transmission", "Drive True + HeartField", "Especial Nu Metal",
    ], "all three nights, in date order"


def test_the_earliest_keeps_the_posts_own_id(monkeypatch):
    events, _ = _run({
        "is_event": True,
        "events": [
            # Deliberately out of order — ids must not depend on this.
            _event_payload("Sabado", _next(SAB)),
            _event_payload("Quinta", _next(QUI)),
            _event_payload("Sexta", _next(SEX)),
        ],
    })
    assert events[0].external_id == "ig_changes.cwb_ABC123", \
        "pre-existing rows use the bare id — the earliest event keeps it"
    suffixed = [e.external_id for e in events[1:]]
    assert all(e.startswith("ig_changes.cwb_ABC123_") for e in suffixed)
    assert len(set(e.external_id for e in events)) == 3, "ids are unique"


def test_ids_survive_a_rescrape_in_a_different_order(monkeypatch):
    first, _ = _run({"is_event": True, "events": [
        _event_payload("Quinta", _next(QUI)), _event_payload("Sexta", _next(SEX)),
    ]})
    again, _ = _run({"is_event": True, "events": [
        _event_payload("Sexta", _next(SEX)), _event_payload("Quinta", _next(QUI)),
    ]})
    assert [e.external_id for e in first] == [e.external_id for e in again], \
        "a re-scrape must not duplicate the post under shuffled ids"


SINGLE_CAPTION = (
    "Quinta 17/09 tem Live Transmission no Changes, entrada free a noite "
    "toda, a partir das 21h. Chegue cedo e garanta o melhor lugar."
)


def test_a_single_event_post_is_unchanged(monkeypatch):
    events, _ = _run({"is_event": True, "events": [_event_payload("Show", _next(QUI))]},
                     caption=SINGLE_CAPTION)
    assert len(events) == 1
    assert events[0].external_id == "ig_changes.cwb_ABC123"


def test_the_old_single_object_answer_still_works(monkeypatch):
    """The model drops back to this shape sometimes; losing the post to a
    contract change would be worse than accepting both."""
    body = {"is_event": True, **_event_payload("Show", _next(QUI))}
    events, _ = _run(body, caption=SINGLE_CAPTION)
    assert len(events) == 1
    assert events[0].name == "Show"
    assert events[0].external_id == "ig_changes.cwb_ABC123"


def test_one_bad_night_does_not_cost_the_others(monkeypatch):
    """A date in the past is dropped on its own, not with the whole post."""
    events, _ = _run({"is_event": True, "events": [
        _event_payload("Ja passou", _past(SAB)),
        _event_payload("Quinta", _next(QUI)),
        _event_payload("Sexta", _next(SEX)),
    ]})
    assert [e.name for e in events] == ["Quinta", "Sexta"]


def test_not_an_event_stays_empty(monkeypatch):
    events, _ = _run({"is_event": False})
    assert events == []


def test_two_events_on_the_same_day_do_not_collide(monkeypatch):
    """Same-day pairs would share a suffix and silently overwrite on upsert."""
    events, _ = _run({"is_event": True, "events": [
        _event_payload("Primeiro", _next(QUI, hour=20)),
        _event_payload("Segundo", _next(QUI, hour=23)),
    ]})
    assert len(set(e.external_id for e in events)) == len(events)


def test_output_budget_fits_a_lineup(monkeypatch):
    """512 tokens truncates a three-event answer into invalid JSON, which
    drops the entire post."""
    _, client = _run({"is_event": True, "events": [_event_payload("Show", _next(QUI))]},
                     caption=SINGLE_CAPTION)
    assert client.last_kwargs["max_tokens"] >= 2048


# ── Why did this post produce nothing? ─────────────────────
# Until now that was answerable only by reading Railway logs, so every
# investigation started with a guess. debug_out records the model's raw
# answer and the reason each event was rejected.


def _run_debug(body, caption=LINEUP_CAPTION):
    client = _FakeClient(body)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    debug: dict = {}
    events = asyncio.run(
        ig._extract_events(client, _post(caption), today, debug_out=debug)
    )
    return events, debug


def test_debug_reports_a_not_an_event_verdict():
    events, debug = _run_debug({"is_event": False})
    assert events == []
    assert debug["drops"], "a silent zero is the thing this exists to prevent"
    assert "NÃO É EVENTO" in debug["drops"][0]["reason"]
    assert debug["model_answer"] == {"is_event": False}


def test_debug_names_the_gate_that_dropped_each_event():
    events, debug = _run_debug({"is_event": True, "events": [
        _event_payload("Ja passou", _past(SAB)),
        _event_payload("Quinta", _next(QUI)),
    ]})
    assert [e.name for e in events] == ["Quinta"]
    dropped = {d["name"]: d["reason"] for d in debug["drops"]}
    assert "Ja passou" in dropped
    assert "passado" in dropped["Ja passou"]


def test_debug_reports_a_weekday_mismatch():
    """The gate that would silently eat a lineup post if the model read the
    flyer wrong — it should say so, not just vanish."""
    events, debug = _run_debug({"is_event": True, "events": [
        # Caption says quinta/sexta/sábado; this lands on a Monday.
        _event_payload("Segunda estranha", _next(0)),
    ]})
    assert events == []
    assert "legenda cita" in debug["drops"][0]["reason"]


def test_debug_carries_the_caption_and_whether_the_flyer_was_sent():
    _, debug = _run_debug({"is_event": True, "events": [_event_payload("X", _next(QUI))]})
    assert debug["caption"].startswith("Semana sem tempo ruim")
    # These fixtures have no displayUrl, so no image reaches the model.
    assert debug.get("image_sent_to_model") is None


def test_the_city_is_not_a_neighbourhood():
    """The model answers "Curitiba" in the neighbourhood field often enough,
    and a Curitiba-only catalog rendering a "Curitiba" chip is noise."""
    payload = _event_payload("Show", _next(QUI))
    payload["neighborhood"] = "Curitiba"
    events, _ = _run({"is_event": True, "events": [payload]}, caption=SINGLE_CAPTION)
    assert events[0].neighborhood is None

    payload["neighborhood"] = "São Francisco"
    events, _ = _run({"is_event": True, "events": [payload]}, caption=SINGLE_CAPTION)
    assert events[0].neighborhood == "São Francisco", "a real bairro survives"
