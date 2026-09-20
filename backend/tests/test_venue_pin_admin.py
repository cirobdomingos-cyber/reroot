"""
Tests for the curator venue-pin surface.

Context: the bairro shown next to a venue comes from the geocoded
`venues` row (Sep 2026). That made a missing or wrong pin the remaining
cause of a wrong-looking event — and after a seed + geocode pass on
production, 36 venues were left that Nominatim simply can't resolve.
`PUT /admin/venues/{name_normalized}` already existed to fix those by
hand, but had no UI and no way to accept what a curator actually has on
the clipboard: a Google Maps link.

What must hold:
  1. `coords_text` parses the shapes Google Maps hands you — the bare
     pair from "copiar coordenadas", a place URL, a viewport URL, a
     ?q= link — and refuses anything else rather than guessing.
  2. A pasted value beats the numeric lat/lng fields.
  3. The Curitiba bounds still apply to a parsed pin, and the error says
     "wrong city", not "bad format".
  4. list_venues exposes `bairro`, because a pin that reverse-geocodes
     to no bairro still leaves the event showing the enrichment guess —
     a curator who can't see that can't tell the fix didn't land.
"""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

CURATOR = "curator@example.com"

# Real shapes, copied from Google Maps rather than invented.
PLACE_URL = (
    "https://www.google.com/maps/place/Bar+Folia/@-25.4253365,-49.278344,17z/"
    "data=!4m6!3m5!1s0x94dce3f0a0000001:0x0!8m2!3d-25.4253365!4d-49.278344"
)
VIEWPORT_URL = "https://www.google.com/maps/@-25.4253365,-49.278344,17z"
QUERY_URL = "https://maps.google.com/?q=-25.4253365,-49.278344"
BARE_PAIR = "-25.4253365, -49.278344"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db
    import main as _main
    _db.init_db()
    _db.add_curator(email=CURATOR, added_by_email="system", notes="test")
    _db.upsert_venue_seed(name_original="Bar Folia", address="Curitiba")
    from fastapi.testclient import TestClient
    return _db, _main, TestClient(_main.app)


# -- 1. the formats a curator actually has ---------------------------

@pytest.mark.parametrize("text", [BARE_PAIR, PLACE_URL, VIEWPORT_URL, QUERY_URL])
def test_parses_every_google_maps_shape(api, text):
    _db, main, _client = api
    assert main._parse_coords_text(text) == (-25.4253365, -49.278344)


def test_place_pin_wins_over_viewport_center(api):
    """A place URL carries both: @lat,lng is where the map was looking,
    !3d/!4d is the place itself. The place is the one we want."""
    _db, main, _client = api
    mixed = (
        "https://www.google.com/maps/place/X/@-25.1000000,-49.1000000,17z/"
        "data=!3m1!4b1!4m6!3m5!8m2!3d-25.4253365!4d-49.278344"
    )
    assert main._parse_coords_text(mixed) == (-25.4253365, -49.278344)


@pytest.mark.parametrize("text", [
    "",
    "   ",
    "Bar Folia, Rua XV de Novembro",
    "não sei onde fica",
    "-25,4253365, -49,278344",   # Brazilian decimal comma — ambiguous on purpose
    "999.0, -49.27",             # out of latitude range
    "-25.42",                    # only one number
])
def test_refuses_what_it_cannot_read(api, text):
    _db, main, _client = api
    assert main._parse_coords_text(text) is None


def test_unreadable_paste_is_a_400_not_a_silent_no_op(api):
    _db, _main, client = api
    r = client.put("/admin/venues/bar folia", json={
        "requesting_email": CURATOR, "coords_text": "onde fica isso",
    })
    assert r.status_code == 400
    assert "coordenadas" in r.json()["detail"].lower()


# -- 2. paste beats the numeric fields -------------------------------

def test_pasted_text_wins_over_lat_lng_fields(api):
    _db, _main, client = api
    r = client.put("/admin/venues/bar folia", json={
        "requesting_email": CURATOR,
        "lat": -25.0, "lng": -49.0,
        "coords_text": BARE_PAIR,
    })
    assert r.status_code == 200
    row = next(v for v in _db.list_venues() if v["name_normalized"] == "bar folia")
    assert (row["lat"], row["lng"]) == (-25.4253365, -49.278344)
    assert row["geocode_status"] == "ok"
    assert row["geocode_source"] == "manual"


def test_numeric_fields_still_work_without_a_paste(api):
    _db, _main, client = api
    r = client.put("/admin/venues/bar folia", json={
        "requesting_email": CURATOR, "lat": -25.43, "lng": -49.27,
    })
    assert r.status_code == 200
    row = next(v for v in _db.list_venues() if v["name_normalized"] == "bar folia")
    assert (row["lat"], row["lng"]) == (-25.43, -49.27)


# -- 3. bounds still apply to a parsed pin ---------------------------

def test_a_parsed_pin_outside_curitiba_is_refused_as_such(api):
    _db, _main, client = api
    # São Paulo. Parses fine; it's just the wrong city.
    r = client.put("/admin/venues/bar folia", json={
        "requesting_email": CURATOR,
        "coords_text": "https://www.google.com/maps/@-23.5505,-46.6333,17z",
    })
    assert r.status_code == 400
    assert "Curitiba" in r.json()["detail"]


def test_a_stranger_cannot_move_a_pin(api):
    _db, _main, client = api
    r = client.put("/admin/venues/bar folia", json={
        "requesting_email": "nobody@example.com", "coords_text": BARE_PAIR,
    })
    assert r.status_code in (401, 403)


# -- 4. bairro is visible to whoever is fixing the pin ----------------

def test_list_venues_exposes_bairro(api):
    _db, _main, client = api
    _db.record_geocode_result("bar folia", -25.4253365, -49.278344, bairro="São Francisco")
    row = next(v for v in _db.list_venues() if v["name_normalized"] == "bar folia")
    assert row["bairro"] == "São Francisco"


def test_bairro_is_an_empty_string_not_none_when_unknown(api):
    """The curator UI renders this directly; None would print as "None"."""
    _db, _main, client = api
    row = next(v for v in _db.list_venues() if v["name_normalized"] == "bar folia")
    assert row["bairro"] == ""


def test_the_admin_listing_carries_bairro_over_http(api):
    _db, _main, client = api
    _db.record_geocode_result("bar folia", -25.4253365, -49.278344, bairro="São Francisco")
    r = client.get(f"/admin/venues?requesting_email={CURATOR}")
    assert r.status_code == 200
    row = next(v for v in r.json()["venues"] if v["name_normalized"] == "bar folia")
    assert row["bairro"] == "São Francisco"
