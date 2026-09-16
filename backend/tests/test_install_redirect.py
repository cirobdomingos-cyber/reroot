"""
Tests for /install's iOS redirect (docs CLAUDE.md "TWA / PWA distribution").

Context: auê went public on the App Store (id 6765535013) — /install used
to 302 iOS UAs to TestFlight only when TESTFLIGHT_INVITE_URL was set, and
fall through to the generic "Adicionar à Tela de Início" HTML walkthrough
otherwise. That walkthrough is stale now that a real store listing exists
for anyone landing on this link cold. iOS should always land somewhere
real: the App Store by default, TestFlight only during an explicit
version-bump testing window.

What must hold:
  1. An iOS UA with no TESTFLIGHT_INVITE_URL set goes to the App Store.
  2. An iOS UA with TESTFLIGHT_INVITE_URL set goes there instead (override).
  3. A non-iOS, non-Android UA still gets the HTML walkthrough (unchanged).
  4. Android behavior is unchanged (Play Store internal link, or the HTML
     walkthrough when unset).
"""
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36"
DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


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


def test_ios_defaults_to_the_app_store(api):
    _, main, client = api()
    r = client.get("/install", headers={"user-agent": IOS_UA}, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "https://apps.apple.com/app/id6765535013"
    assert r.headers["location"] == main.APP_STORE_URL


def test_testflight_override_takes_priority(api):
    _, _, client = api(TESTFLIGHT_INVITE_URL="https://testflight.apple.com/join/ABC123")
    r = client.get("/install", headers={"user-agent": IOS_UA}, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "https://testflight.apple.com/join/ABC123"


def test_desktop_gets_the_html_walkthrough(api):
    _, _, client = api()
    r = client.get("/install", headers={"user-agent": DESKTOP_UA}, follow_redirects=False)
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


def test_android_falls_through_to_walkthrough_when_unset(api):
    _, _, client = api()
    r = client.get("/install", headers={"user-agent": ANDROID_UA}, follow_redirects=False)
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


def test_android_redirects_when_play_store_url_set(api):
    _, _, client = api(PLAY_STORE_INTERNAL_URL="https://play.google.com/apps/internaltest/XYZ")
    r = client.get("/install", headers={"user-agent": ANDROID_UA}, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "https://play.google.com/apps/internaltest/XYZ"
