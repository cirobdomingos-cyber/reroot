"""
/install for Android during the Google Play closed test.

A new personal Play account needs 12 opted-in testers for 14 days. Testers
arrive from the Instagram bio link, mostly inside Instagram's webview where
Google sign-in is blocked, so the page must send them to Chrome first and
then walk them through: join the Google Group, opt in, install.

What must hold:
  1. Android with nothing set -> today's PWA walkthrough, byte-identical.
  2. PLAY_BETA_GROUP_URL set -> beta section with group, opt-in, store URLs.
  3. Instagram (or other webview) Android UA -> "Abre no Chrome" block.
  4. PLAY_STORE_URL set -> 302 to the public listing, beating the beta.
  5. iOS is unchanged (App Store 302).
  6. Env URLs are escaped and non-http values are refused.
  7. Every tap (chrome, group, opt-in, store, web) is tagged for the funnel
     with the visit's ?src=, and the Chrome hand-off keeps the ?src=.
"""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

ANDROID_CHROME_UA = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36"
)
ANDROID_INSTAGRAM_UA = (
    "Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 "
    "Mobile Safari/537.36 Instagram 350.0.0.42.89 Android"
)
ANDROID_WEBVIEW_UA = (
    "Mozilla/5.0 (Linux; Android 13; moto g; wv) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36"
)
IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
GROUP = "https://groups.google.com/g/aue-testers"
OPTIN = "https://play.google.com/apps/testing/app.aue"
STORE = "https://play.google.com/store/apps/details?id=app.aue"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for k in ("PLAY_STORE_URL", "PLAY_BETA_GROUP_URL", "PLAY_BETA_OPTIN_URL",
              "PLAY_STORE_INTERNAL_URL", "TESTFLIGHT_INVITE_URL"):
        monkeypatch.delenv(k, raising=False)

    def _boot(**env):
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        for mod in ("database", "main"):
            sys.modules.pop(mod, None)
        import database as _db
        import main as _main
        _db.init_db()
        from fastapi.testclient import TestClient
        return _main, TestClient(_main.app)

    return _boot


def _get(client, ua):
    return client.get("/install", headers={"user-agent": ua}, follow_redirects=False)


def test_android_without_settings_keeps_the_old_page(api):
    main, client = api()
    r = _get(client, ANDROID_CHROME_UA)
    assert r.status_code == 200
    assert r.text == main._INSTALL_HTML
    assert 'id="android-beta"' not in r.text


def test_group_set_serves_the_beta_section_with_three_urls(api):
    _, client = api(PLAY_BETA_GROUP_URL=GROUP)
    r = _get(client, ANDROID_CHROME_UA)
    assert r.status_code == 200
    assert 'id="android-beta"' in r.text
    assert "Testa o auê no Android antes de todo mundo" in r.text
    assert f'id="beta-step-1" href="{GROUP}"' in r.text
    assert f'id="beta-step-2" href="{OPTIN}"' in r.text
    assert f'id="beta-step-3" href="{STORE}"' in r.text
    assert "mesma conta Google" in r.text
    assert 'which = "android-beta"' in r.text
    # Chrome itself gets no "open in Chrome" block.
    assert 'id="beta-open-chrome"' not in r.text


def test_optin_url_override(api):
    _, client = api(PLAY_BETA_GROUP_URL=GROUP,
                    PLAY_BETA_OPTIN_URL="https://play.google.com/apps/testing/other")
    r = _get(client, ANDROID_CHROME_UA)
    assert 'href="https://play.google.com/apps/testing/other"' in r.text


@pytest.mark.parametrize("ua", [ANDROID_INSTAGRAM_UA, ANDROID_WEBVIEW_UA])
def test_in_app_android_gets_the_open_in_chrome_block_first(api, ua):
    _, client = api(PLAY_BETA_GROUP_URL=GROUP)
    r = _get(client, ua)
    assert r.status_code == 200
    assert 'id="beta-open-chrome"' in r.text
    assert "iabAction()" in r.text and "intent://" in r.text
    assert r.text.index('id="beta-open-chrome"') < r.text.index('id="beta-step-1"')


def test_play_store_url_redirects_and_beats_the_beta(api):
    _, client = api(PLAY_STORE_URL=STORE, PLAY_BETA_GROUP_URL=GROUP,
                    PLAY_STORE_INTERNAL_URL="https://play.google.com/apps/internaltest/x")
    r = _get(client, ANDROID_INSTAGRAM_UA)
    assert r.status_code == 302
    assert r.headers["location"] == STORE


def test_beta_beats_the_legacy_internal_link(api):
    _, client = api(PLAY_BETA_GROUP_URL=GROUP,
                    PLAY_STORE_INTERNAL_URL="https://play.google.com/apps/internaltest/x")
    assert _get(client, ANDROID_CHROME_UA).status_code == 200


def test_ios_unchanged(api):
    main, client = api(PLAY_BETA_GROUP_URL=GROUP, PLAY_STORE_URL=STORE)
    r = _get(client, IOS_UA)
    assert r.status_code == 302
    assert r.headers["location"] == main.APP_STORE_URL


def test_urls_are_escaped_and_non_http_refused(api):
    _, client = api(PLAY_BETA_GROUP_URL='https://groups.google.com/g/x"><script>alert(1)</script>')
    r = _get(client, ANDROID_CHROME_UA)
    assert "<script>alert(1)</script>" not in r.text
    assert "&quot;&gt;&lt;script&gt;" in r.text

    _, client = api(PLAY_BETA_GROUP_URL="javascript:alert(1)")
    r = _get(client, ANDROID_CHROME_UA)
    assert 'id="android-beta"' not in r.text


def test_each_tap_is_tagged_and_carries_the_src(api):
    _, client = api(PLAY_BETA_GROUP_URL=GROUP)
    r = client.get("/install?src=IG_Canais", headers={"user-agent": ANDROID_INSTAGRAM_UA})
    for step in ("chrome", "group", "optin", "store", "web"):
        assert f'data-tap="{step}"' in r.text
    assert 'var __aueSrcQuery = "?src=ig_canais";' in r.text
    assert '"install_tap_" + step' in r.text and '{src: "ig_canais"}' in r.text
    # Chrome and the copied link reopen /install with the same tag.
    assert 'origin + "/install" + __aueSrcQuery;' in r.text
    assert r.text.index("var __aueSrcQuery") < r.text.index("function iabAction")


def test_no_src_reopens_plain_install(api):
    _, client = api(PLAY_BETA_GROUP_URL=GROUP)
    r = _get(client, ANDROID_CHROME_UA)
    assert 'var __aueSrcQuery = "";' in r.text


def test_taps_show_up_in_the_daily_funnel(api):
    _, client = api()
    for step in ("chrome", "group", "store"):
        client.post("/analytics/event", headers={"user-agent": ANDROID_CHROME_UA},
                    json={"event_name": f"install_tap_{step}", "properties": {"src": "ig_canais"}})
    data = client.get("/analytics/funnel/daily?days=7").json()
    got = {(r["step"], r["platform"], r["src"]): r["n"] for r in data["rows"]}
    assert got == {
        ("install_tap_chrome", "android", "ig_canais"): 1,
        ("install_tap_group", "android", "ig_canais"): 1,
        ("install_tap_store", "android", "ig_canais"): 1,
    }
    assert data["steps"][:6] == ["install_visit", "install_tap_chrome", "install_tap_group",
                                 "install_tap_optin", "install_tap_store", "install_tap_web"]
