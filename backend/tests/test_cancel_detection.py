"""
Tests for cancellation detection (cancellations.py).

Context (2026-10-15): Maite Livros (@maitelivros) cancelled "Piquenique com
Livros" (Sat 17 Oct) in a NEW post on its own feed. Each post is read once,
so the event stayed in the catalog and went into an @auecuritiba post.

What must hold:
  1. A cancellation post is matched to the right event of the same venue
     and hides it from /events (the row is kept).
  2. An unrelated post from the same venue cancels nothing.
  3. A cancellation post from ANOTHER venue cancels nothing here.
  4. Ambiguity cancels nothing (two candidates, no hint to pick one).
  5. The founder sees the detection and can undo it; undo restores.
  6. A postponement with a new date moves the event; without one, it is
     treated as cancelled.
  7. The LLM's explicit "not a cancellation" wins over the keywords.
  8. Wired into extraction: the cancellation post itself does not come
     back as a fresh copy of the night it cancels.
"""
import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

CWB = ZoneInfo("America/Sao_Paulo")
FOUNDER = "ciro.b.domingos@gmail.com"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main", "enrichment", "cancellations",
                "scrapers.instagram_apify", "notifications"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    import cancellations as _c
    _db.init_db()
    _db.add_curator(email=FOUNDER, added_by_email="system", notes="founder",
                    is_founder_flag=True)
    for h in ("maitelivros", "maite", "barfolia"):
        _db.upsert_ig_account(handle=h, label=h, category="cultural")
    from _session import SessionClient
    return _db, _main, _c, SessionClient(_main.app, _db)


def _days(n, hour=15):
    d = datetime.now(CWB) + timedelta(days=n)
    return d.replace(hour=hour, minute=0, second=0, microsecond=0)


def _make_event(_db, handle, code, name, start, **over):
    from models import EnrichedEvent
    base = dict(
        id=f"instagram_ig_{handle}_{code}", source="instagram",
        external_id=f"ig_{handle}_{code}", name=name, description="d",
        venue_name=handle.title(), venue_address="", neighborhood="Centro",
        city="Curitiba", date_start=start, date_end=None,
        price_min=0.0, price_max=0.0, currency="BRL", capacity=None,
        kind="community", category_label="Comunidade", category_emoji="x",
        has_food=False, is_low_pressure=False, is_curated=True, pitch="",
        price_tier="free", vibe_summary="", expected_size="medium",
        header_gradient="linear-gradient(135deg, #FFF3E0, #FFE0B2)",
        url=f"https://www.instagram.com/p/{code}/", image_url=None,
        fetched_at=datetime.now(timezone.utc),
    )
    base.update(over)
    ev = EnrichedEvent(**base)
    _db.upsert_event(ev)
    return ev.id


def _fmt(d):
    return d.strftime("%d/%m")


def _apply(c, _db, handle, caption, **kw):
    return c.apply(
        handle, caption=caption, post_url="https://www.instagram.com/p/CANCEL1/",
        post_date=datetime.now(CWB).strftime("%Y-%m-%d"), shortcode="CANCEL1",
        db=_db, **kw,
    )


def _ids_in_events(client):
    r = client.get("/events", params={"limit": 100})
    assert r.status_code == 200
    body = r.json()
    events = body["events"] if isinstance(body, dict) else body
    return {e["id"] for e in events}


def test_cancellation_post_matches_the_right_event(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    club = _make_event(_db, "maitelivros", "OTHER1", "Clube de Leitura: Clarice", _days(6, 19))
    caption = (f"Infelizmente o Piquenique com Livros deste sábado ({_fmt(_days(3))}) "
               "foi cancelado por causa da previsão de chuva. Logo trazemos nova edição!")
    out = _apply(c, _db, "maitelivros", caption)
    assert [o["event_id"] for o in out] == [picnic]
    assert out[0]["kind"] == "cancelled"
    assert (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")
    assert not (_db.get_event_cancel_state(club) or {}).get("cancelled_at")
    # Idempotent: the same post read again changes nothing.
    assert _apply(c, _db, "maitelivros", caption) == []


def test_cancelled_event_hidden_from_events_but_row_kept(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    assert picnic in _ids_in_events(client)
    _apply(c, _db, "maitelivros", "Piquenique com Livros não vai rolar, cancelado pela chuva.")
    assert picnic not in _ids_in_events(client)
    assert _db.get_event_by_id(picnic) is not None
    detail = client.get(f"/events/{picnic}")
    assert detail.status_code == 200 and detail.json().get("cancelledAt")
    assert picnic not in {e.id for e in _db.get_future_events_by_source(
        "instagram", ig_handle="maitelivros")}


def test_unrelated_post_from_same_venue_does_not_cancel(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    out = _apply(c, _db, "maitelivros",
                 "Chegaram livros novos na Maite! Venha conhecer a vitrine de outubro.")
    assert out == []
    # Cancellation words about something that is NOT a catalog event.
    out = _apply(c, _db, "maitelivros",
                 "O frete grátis da loja online foi cancelado; agora só retirada.")
    assert out == []
    assert not (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_post_from_another_venue_does_not_cancel(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    # @maite is a prefix of @maitelivros: its LIKE pattern must not leak.
    out = _apply(c, _db, "maite", "Piquenique com Livros cancelado!")
    assert out == []
    out = _apply(c, _db, "barfolia", "Piquenique com Livros cancelado!")
    assert out == []
    assert not (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_ambiguous_post_cancels_nothing(api):
    _db, _main, c, client = api
    a = _make_event(_db, "barfolia", "A1", "Samba de roda", _days(2, 20))
    b = _make_event(_db, "barfolia", "B1", "Roda de choro", _days(4, 20))
    out = _apply(c, _db, "barfolia", "Pessoal, o evento foi cancelado. Desculpem!")
    assert out == []
    for eid in (a, b):
        assert not (_db.get_event_cancel_state(eid) or {}).get("cancelled_at")


def test_founder_lists_and_uncancel_restores(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    _apply(c, _db, "maitelivros", "Piquenique com Livros cancelado.")
    # Strangers can't see or undo.
    assert client.get("/admin/cancellations").status_code == 401
    r = client.get("/admin/cancellations", params={"requesting_email": FOUNDER})
    assert r.status_code == 200
    rows = r.json()["cancellations"]
    assert [x["event_id"] for x in rows] == [picnic]
    assert rows[0]["source_url"].endswith("/CANCEL1/")
    r = client.post(f"/admin/events/{picnic}/uncancel", params={"requesting_email": FOUNDER})
    assert r.status_code == 200, r.text
    assert picnic in _ids_in_events(client)
    # Nothing left to undo.
    r = client.post(f"/admin/events/{picnic}/uncancel", params={"requesting_email": FOUNDER})
    assert r.status_code == 404
    # The undo sticks: re-reading the same post (a manual rebuild) does
    # not cancel it again.
    assert _apply(c, _db, "maitelivros", "Piquenique com Livros cancelado.") == []
    assert picnic in _ids_in_events(client)


def test_postponement_with_new_date_updates_it(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    new_day = _days(10)
    out = _apply(c, _db, "maitelivros",
                 f"O Piquenique com Livros foi adiado para {_fmt(new_day)} por causa da chuva.")
    assert [o["kind"] for o in out] == ["postponed"]
    ev = _db.get_event_by_id(picnic)
    assert ev.date_start.astimezone(CWB).date() == new_day.date()
    assert ev.date_start.astimezone(CWB).hour == 15   # keeps its own time
    assert picnic in _ids_in_events(client)
    # A re-read of the ORIGINAL post can't move it back (date pinned).
    assert "date_start" in _db.get_catalog_edited_fields(picnic)
    # Undo returns it to the old date.
    r = client.post(f"/admin/events/{picnic}/uncancel", params={"requesting_email": FOUNDER})
    assert r.status_code == 200
    assert _db.get_event_by_id(picnic).date_start.astimezone(CWB).date() == _days(3).date()


def test_postponement_without_date_is_cancelled(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    out = _apply(c, _db, "maitelivros",
                 "Piquenique com Livros adiado! Em breve anunciamos a nova data.")
    assert [o["kind"] for o in out] == ["cancelled"]
    assert picnic not in _ids_in_events(client)


def test_llm_answer_drives_and_overrides(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    caption = "Chova ou faça sol, sem cancelamento: piquenique com livros sábado!"
    out = _apply(c, _db, "maitelivros", caption, llm_answered=True,
                 llm_cancels={"is_cancellation": False})
    assert out == []
    # The LLM names the event the caption only hints at.
    new_day = _days(9, 16)
    out = _apply(c, _db, "maitelivros", "Mudança de planos: remarcado! Detalhes no link.",
                 llm_answered=True, llm_cancels={
                     "is_cancellation": True, "kind": "postponed",
                     "event_name": "Piquenique com Livros",
                     "event_date": _days(3).strftime("%Y-%m-%d"),
                     "new_date_start": new_day.strftime("%Y-%m-%dT%H:%M:%S"),
                 })
    assert [o["kind"] for o in out] == ["postponed"]
    assert _db.get_event_by_id(picnic).date_start.astimezone(CWB) == new_day


def test_extraction_hook_cancels_and_drops_the_copy(api, monkeypatch):
    """End to end through _extract_events: the prompt gets the extra
    section, the model's `cancels` field cancels the row, and an event the
    model still listed for the same night is not re-created."""
    _db, _main, c, client = api
    import scrapers.instagram_apify as ig
    monkeypatch.setattr(ig, "db", _db)

    async def no_image(_url):
        return None
    monkeypatch.setattr(ig, "_fetch_image_b64", no_image)

    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    day = _days(3)
    answer = {
        "is_event": True,
        "events": [{
            "is_recurring": False, "recurrence_label": None, "recurrence_days": [],
            "name": "Piquenique com Livros (cancelado)", "description": "d",
            "venue_name": "Maite", "venue_address": "", "neighborhood": "",
            "date_start": day.strftime("%Y-%m-%dT%H:%M:%S"), "date_end": None,
            "price_min": 0, "price_max": 0,
        }],
        "cancels": {"is_cancellation": True, "kind": "cancelled",
                    "event_name": "Piquenique com Livros",
                    "event_date": day.strftime("%Y-%m-%d"), "new_date_start": None},
    }
    seen = {}

    class _Messages:
        async def create(self, **kwargs):
            seen["prompt"] = kwargs["messages"][0]["content"][-1]["text"]
            return SimpleNamespace(content=[SimpleNamespace(text=json.dumps(answer))],
                                   usage=SimpleNamespace(input_tokens=1, output_tokens=1))

    post = {
        "caption": f"Aviso: o Piquenique com Livros de {_fmt(day)} foi cancelado por causa da chuva.",
        "url": "https://www.instagram.com/p/CANCEL1/",
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
        "inputUrl": "https://www.instagram.com/maitelivros/",
        "ownerUsername": "maitelivros", "likesCount": 3, "id": "CANCEL1",
    }
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    events = asyncio.run(ig._extract_events(SimpleNamespace(messages=_Messages()), post, today))
    assert events == []
    assert '"cancels"' in seen["prompt"]
    assert (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_ordinary_post_prompt_is_unchanged():
    import cancellations as c
    assert not c.looks_like_cancellation("Sábado 17/10 tem Piquenique com Livros às 15h!")
    assert c.looks_like_cancellation("NÃO VAI ROLAR o sarau de hoje")
    assert c.looks_like_cancellation("Show suspenso")
