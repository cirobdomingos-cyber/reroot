"""
The acquisition funnel: post -> bio link -> /install -> store -> app.

What must hold:
  1. Every /install visit is logged as install_visit with platform,
     client (in_app for the Instagram browser) and the ?src= tag, and the
     visitor still gets the redirect or page they always got.
  2. With APP_STORE_PROVIDER_TOKEN set, iPhones go to a campaign link
     (pt + ct=<src>); without it, to the plain listing; TestFlight still wins.
  3. App events get _platform/_client from the UA, and a client can't
     overwrite them.
  4. /analytics/funnel/daily counts per day, step, platform, client, src.
"""
import json
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
IOS_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
IOS_INSTAGRAM = IOS_APP + " Instagram 300.0.0.0 (iPhone14,2; iOS 17_0; pt_BR)"
ANDROID_APP = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36"
ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))

    def _boot(**env):
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        for mod in ("database", "main"):
            sys.modules.pop(mod, None)
        import database as _db
        import main as _main
        _db.init_db()
        from fastapi.testclient import TestClient
        return _db, _main, TestClient(_main.app)

    return _boot


def _events(db, name):
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT properties_json FROM analytics_events WHERE event_name = ?", (name,)
        ).fetchall()
    return [json.loads(r["properties_json"]) for r in rows]


@pytest.mark.parametrize("ua,platform,client", [
    (IOS_SAFARI, "ios", "browser"),
    (IOS_APP, "ios", "app"),
    (IOS_INSTAGRAM, "ios", "in_app"),
    (ANDROID_APP, "android", "app"),
    (ANDROID_CHROME, "android", "browser"),
    (ANDROID_CHROME + " Instagram 300.0", "android", "in_app"),
    (DESKTOP, "desktop", "browser"),
    ("", "desktop", "browser"),
])
def test_client_of(api, ua, platform, client):
    _, main, _ = api()
    assert main._client_of(ua) == {"platform": platform, "client": client}


def test_install_visit_is_logged_and_the_redirect_is_unchanged(api):
    db, main, client = api()
    r = client.get("/install?src=IG_Canais!<x>", headers={"user-agent": IOS_INSTAGRAM, "referer": "https://l.instagram.com/?u=x"}, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == main.APP_STORE_URL
    [visit] = _events(db, "install_visit")
    assert visit == {"platform": "ios", "client": "in_app", "src": "ig_canaisx", "referer_host": "l.instagram.com"}

    r = client.get("/install", headers={"user-agent": DESKTOP})
    assert r.status_code == 200
    assert _events(db, "install_visit")[-1]["platform"] == "desktop"


def test_ios_campaign_link_only_with_a_provider_token(api):
    _, main, client = api(APP_STORE_PROVIDER_TOKEN="123456")
    r = client.get("/install?src=ig_canais", headers={"user-agent": IOS_SAFARI}, follow_redirects=False)
    assert r.headers["location"] == f"{main.APP_STORE_URL}?pt=123456&ct=ig_canais&mt=8"
    r = client.get("/install", headers={"user-agent": IOS_SAFARI}, follow_redirects=False)
    assert r.headers["location"].endswith("ct=install&mt=8")


def test_testflight_still_wins_over_the_campaign_link(api):
    _, _, client = api(APP_STORE_PROVIDER_TOKEN="123456", TESTFLIGHT_INVITE_URL="https://testflight.apple.com/join/ABC")
    r = client.get("/install?src=ig", headers={"user-agent": IOS_SAFARI}, follow_redirects=False)
    assert r.headers["location"] == "https://testflight.apple.com/join/ABC"


def test_app_events_get_the_server_stamp_and_cannot_fake_it(api):
    db, _, client = api()
    client.post("/analytics/event", headers={"user-agent": ANDROID_APP},
                json={"event_name": "onboarding_signed_in", "properties": {"_platform": "ios", "method": "google"}})
    [ev] = _events(db, "onboarding_signed_in")
    assert ev == {"_platform": "android", "_client": "app", "method": "google"}


def test_daily_funnel_counts_by_step_platform_client_and_src(api):
    _, _, client = api()
    for _ in range(3):
        client.get("/install?src=ig_canais", headers={"user-agent": IOS_INSTAGRAM}, follow_redirects=False)
    client.get("/install?src=ig_canais", headers={"user-agent": ANDROID_CHROME + " Instagram 300"})
    client.post("/analytics/event", headers={"user-agent": IOS_APP}, json={"event_name": "onboarding_signed_in"})
    client.post("/analytics/event", headers={"user-agent": IOS_APP}, json={"event_name": "events_view_mode"})

    data = client.get("/analytics/funnel/daily?days=7").json()
    got = {(r["step"], r["platform"], r["client"], r["src"]): r["n"] for r in data["rows"]}
    assert got == {
        ("install_visit", "ios", "in_app", "ig_canais"): 3,
        ("install_visit", "android", "in_app", "ig_canais"): 1,
        ("onboarding_signed_in", "ios", "app", ""): 1,
    }
    assert data["steps"][0] == "install_visit"


def test_report_table_splits_by_platform_and_filters_src():
    sys.path.insert(0, str(BACKEND.parent / "scripts"))
    import funnel_report
    data = {"steps": ["install_visit", "onboarding_signed_in"], "rows": [
        {"day": "2026-10-17", "step": "install_visit", "platform": "ios", "client": "in_app", "src": "ig_canais", "n": 3},
        {"day": "2026-10-17", "step": "install_visit", "platform": "android", "client": "in_app", "src": "other", "n": 2},
        {"day": "2026-10-17", "step": "onboarding_signed_in", "platform": "ios", "client": "app", "src": "", "n": 1},
    ]}
    assert funnel_report.table(data) == [["day", "/install", "login"], ["2026-10-17", "5 (3/2/0)", "1 (1/0/0)"]]
    assert funnel_report.table(data, "ig_canais")[1][1] == "3 (3/0/0)"


def test_link_previews_are_not_visits(api):
    db, _, client = api()
    for ua in ("facebookexternalhit/1.1", "WhatsApp/2.23.20 A", "Googlebot/2.1", "curl/8.4"):
        r = client.get("/install", headers={"user-agent": ua}, follow_redirects=False)
        assert r.status_code in (200, 302)
    assert _events(db, "install_visit") == []
