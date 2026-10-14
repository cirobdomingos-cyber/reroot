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
    _apply(c, _db, "maitelivros",
           f"Piquenique com Livros de {_fmt(_days(3))} não vai rolar, cancelado pela chuva.")
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
    out = _apply(c, _db, "maite", f"Piquenique com Livros de {_fmt(_days(3))} cancelado!")
    assert out == []
    out = _apply(c, _db, "barfolia", f"Piquenique com Livros de {_fmt(_days(3))} cancelado!")
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
    _apply(c, _db, "maitelivros", f"Piquenique com Livros de {_fmt(_days(3))} cancelado.")
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
    assert _apply(c, _db, "maitelivros", f"Piquenique com Livros de {_fmt(_days(3))} cancelado.") == []
    assert picnic in _ids_in_events(client)


def test_postponement_with_new_date_updates_it(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    new_day = _days(10)
    out = _apply(c, _db, "maitelivros",
                 f"O Piquenique com Livros de {_fmt(_days(3))} foi adiado para "
                 f"{_fmt(new_day)} por causa da chuva.")
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


def test_postponement_without_date_is_hidden_as_postponed_no_date(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    out = _apply(c, _db, "maitelivros",
                 f"Piquenique com Livros de {_fmt(_days(3))} adiado! Em breve anunciamos a nova data.")
    assert [o["kind"] for o in out] == ["postponed_no_date"]
    assert picnic not in _ids_in_events(client)
    r = client.get("/admin/cancellations", params={"requesting_email": FOUNDER})
    assert [x["kind"] for x in r.json()["cancellations"]] == ["postponed_no_date"]
    # Undo brings it back like a cancellation.
    client.post(f"/admin/events/{picnic}/uncancel", params={"requesting_email": FOUNDER})
    assert picnic in _ids_in_events(client)


def test_llm_answer_drives_and_overrides(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    caption = "Chova ou faça sol, sem cancelamento: piquenique com livros sábado!"
    out = _apply(c, _db, "maitelivros", caption, llm_ran=True,
                 llm_cancels={"is_cancellation": False})
    assert out == []
    # The LLM names the event the caption only hints at.
    new_day = _days(9, 16)
    out = _apply(c, _db, "maitelivros", "Mudança de planos: remarcado! Detalhes no link.",
                 llm_ran=True, llm_cancels={
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
    pending = []
    events = asyncio.run(ig._extract_events(SimpleNamespace(messages=_Messages()), post, today,
                                            cancel_out=pending))
    assert events == []
    assert '"cancels"' in seen["prompt"]
    # Collected, not applied yet: the scrape applies it after saving.
    assert len(pending) == 1
    assert not (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")
    c.apply_pending(pending, db=_db)
    assert (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_ordinary_post_prompt_is_unchanged():
    import cancellations as c
    assert not c.looks_like_cancellation("Sábado 17/10 tem Piquenique com Livros às 15h!")
    assert c.looks_like_cancellation("NÃO VAI ROLAR o sarau de hoje")
    assert c.looks_like_cancellation("Show suspenso")


# ── Review fixes (PR #161) ─────────────────────────────────


def test_negations_never_cancel(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    for caption in (
        f"Sem cancelamento, chova ou faça sol: Piquenique com Livros {_fmt(_days(3))}!",
        f"Calma, o Piquenique com Livros de {_fmt(_days(3))} NÃO foi cancelado!",
        f"Nada foi cancelado: Piquenique com Livros {_fmt(_days(3))} confirmado.",
    ):
        assert not c.looks_like_cancellation(caption), caption
        assert _apply(c, _db, "maitelivros", caption) == []
    assert not (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_when_the_model_ran_only_its_answer_counts(api):
    """The model answered without a `cancels` field: the keywords don't
    get a second opinion, even on a caption the regex would accept."""
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    caption = f"Piquenique com Livros de {_fmt(_days(3))} cancelado."
    assert _apply(c, _db, "maitelivros", caption, llm_ran=True, llm_cancels=None) == []
    assert not (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_regex_needs_a_date_or_weekday_hint(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    assert _apply(c, _db, "maitelivros", "Piquenique com Livros cancelado pela chuva.") == []
    assert not (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_venue_name_alone_is_not_a_match(api):
    """'Noite de Livros' at Maite Livros: every word of that name is
    either generic or the venue's own, so a lone candidate with no date
    hint must not be cancelled however the post names it."""
    _db, _main, c, client = api
    night = _make_event(_db, "maitelivros", "N1", "Noite de Livros", _days(5, 19),
                        venue_name="Maite Livros")
    out = _apply(c, _db, "maitelivros",
                 "Aviso: a oficina foi cancelada. #maitelivros #livros",
                 llm_ran=True, llm_cancels={"is_cancellation": True, "kind": "cancelled",
                                            "event_name": "Noite de Livros na Maite Livros",
                                            "event_date": None})
    assert out == []
    # One meaningful word and no date is not enough for a lone candidate.
    picnic = _make_event(_db, "maitelivros", "P1", "Piquenique com Livros", _days(8))
    out = _apply(c, _db, "maitelivros", "O piquenique foi cancelado.",
                 llm_ran=True, llm_cancels={"is_cancellation": True, "kind": "cancelled",
                                            "event_name": "Piquenique", "event_date": None})
    assert out == []
    for eid in (night, picnic):
        assert not (_db.get_event_cancel_state(eid) or {}).get("cancelled_at")


def test_two_name_words_match_without_a_date(api):
    _db, _main, c, client = api
    club = _make_event(_db, "maitelivros", "C1", "Clube de Leitura Clarice", _days(6, 19))
    out = _apply(c, _db, "maitelivros", "Infelizmente cancelamos o clube.",
                 llm_ran=True, llm_cancels={"is_cancellation": True, "kind": "cancelled",
                                            "event_name": "Clube de Leitura", "event_date": None})
    assert [o["event_id"] for o in out] == [club]


def test_name_is_read_from_the_model_not_the_caption(api):
    """Hashtags and the rest of the caption don't vote: the model said
    which event, and it isn't this one."""
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    out = _apply(c, _db, "maitelivros",
                 "Oficina de escrita cancelada. #piquenique #piqueniquecomlivros",
                 llm_ran=True, llm_cancels={"is_cancellation": True, "kind": "cancelled",
                                            "event_name": "Oficina de escrita",
                                            "event_date": None})
    assert out == []
    assert not (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_cancellation_in_same_batch_as_announcement(api, monkeypatch):
    """Both posts first read in one scrape: the cancellation is extracted
    before the announcement is saved, and still cancels it once applied
    after the batch's inserts."""
    _db, _main, c, client = api
    import scrapers.instagram_apify as ig
    monkeypatch.setattr(ig, "db", _db)

    async def no_image(_url):
        return None
    monkeypatch.setattr(ig, "_fetch_image_b64", no_image)
    day = _days(3)
    answer = {"is_event": False, "cancels": {
        "is_cancellation": True, "kind": "cancelled", "event_name": "Piquenique com Livros",
        "event_date": day.strftime("%Y-%m-%d"), "new_date_start": None}}

    class _Messages:
        async def create(self, **kwargs):
            return SimpleNamespace(content=[SimpleNamespace(text=json.dumps(answer))],
                                   usage=SimpleNamespace(input_tokens=1, output_tokens=1))

    post = {
        "caption": f"O Piquenique com Livros de {_fmt(day)} foi cancelado.",
        "url": "https://www.instagram.com/p/CANCEL1/",
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
        "inputUrl": "https://www.instagram.com/maitelivros/",
        "ownerUsername": "maitelivros", "likesCount": 3, "id": "CANCEL1",
    }
    pending = []
    asyncio.run(ig._extract_events(SimpleNamespace(messages=_Messages()), post,
                                   datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                   cancel_out=pending))
    # The announcement from the same batch is saved only now.
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", day)
    done = c.apply_pending(pending, db=_db)
    assert [d["event_id"] for d in done] == [picnic]


def test_extractor_without_cancel_out_never_writes(api, monkeypatch):
    """The user-submission extractor calls _extract_events with neither
    cancel_out nor debug_out: it must not touch the catalog."""
    _db, _main, c, client = api
    import scrapers.instagram_apify as ig
    monkeypatch.setattr(ig, "db", _db)

    async def no_image(_url):
        return None
    monkeypatch.setattr(ig, "_fetch_image_b64", no_image)
    day = _days(3)
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", day)
    answer = {"is_event": False, "cancels": {
        "is_cancellation": True, "kind": "cancelled", "event_name": "Piquenique com Livros",
        "event_date": day.strftime("%Y-%m-%d")}}

    class _Messages:
        async def create(self, **kwargs):
            return SimpleNamespace(content=[SimpleNamespace(text=json.dumps(answer))],
                                   usage=SimpleNamespace(input_tokens=1, output_tokens=1))

    post = {"caption": f"Piquenique com Livros de {_fmt(day)} cancelado, pessoal.",
            "url": "https://www.instagram.com/p/X9/", "timestamp": "",
            "inputUrl": "https://www.instagram.com/maitelivros/",
            "ownerUsername": "maitelivros", "id": "X9"}
    asyncio.run(ig._extract_events(SimpleNamespace(messages=_Messages()), post, "2026-10-15"))
    assert not (_db.get_event_cancel_state(picnic) or {}).get("cancelled_at")


def test_rsvp_reads_leave_out_cancelled_nights(api):
    _db, _main, c, client = api
    picnic = _make_event(_db, "maitelivros", "DdZjTMNOI4T", "Piquenique com Livros", _days(3))
    other = _make_event(_db, "barfolia", "S1", "Samba de roda", _days(4, 20))
    for eid in (picnic, other):
        _db.upsert_rsvp("g_ana", eid, "x", "v", _days(3).isoformat(), "")

    def seen():
        return (
            {r["event_id"] for r in _db.get_rsvps_for_users(["g_ana"])},
            {r["event_id"] for r in _db.get_rsvps_for_user("g_ana")},
            set(_db.rsvps_as_state_map("g_ana")),
            bool(_db.get_event_rsvp_ids(picnic)),
        )

    assert seen() == ({picnic, other}, {picnic, other}, {picnic, other}, True)
    _apply(c, _db, "maitelivros", f"Piquenique com Livros de {_fmt(_days(3))} cancelado.")
    assert seen() == ({other}, {other}, {other}, False)
    # The RSVP rows are kept: undo brings every "vou" back.
    client.post(f"/admin/events/{picnic}/uncancel", params={"requesting_email": FOUNDER})
    assert seen() == ({picnic, other}, {picnic, other}, {picnic, other}, True)
