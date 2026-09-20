"""
/install is what the app hands out when you share auê itself. An
unfurler (WhatsApp, iMessage, Slack) fetches it server-side, so the
card it draws comes from this HTML — not from the app.
"""
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

WHATSAPP = "WhatsApp/2.23.20.0 A"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for mod in ("database", "main"):
        sys.modules.pop(mod, None)
    import database as _db, main as _main
    _db.init_db()
    from fastapi.testclient import TestClient
    return TestClient(_main.app)


def test_an_unfurler_gets_a_full_card(client):
    r = client.get("/install", headers={"User-Agent": WHATSAPP})
    assert r.status_code == 200
    html = r.text
    for tag in (
        'property="og:title"', 'property="og:description"',
        'property="og:image" content="https://auecuritiba.com/og-image.png"',
        'property="og:url" content="https://auecuritiba.com/install"',
        'name="twitter:card" content="summary_large_image"',
    ):
        assert tag in html, tag


def test_the_image_is_absolute_and_a_png(client):
    """Unfurlers won't resolve a relative og:image and don't render SVG."""
    html = client.get("/install", headers={"User-Agent": WHATSAPP}).text
    assert 'content="https://auecuritiba.com/og-image.png"' in html
    assert "og-image.svg" not in html


def test_an_iphone_is_still_sent_to_the_store(client):
    r = client.get("/install", headers={"User-Agent": IPHONE}, follow_redirects=False)
    assert r.status_code == 302
    assert "apps.apple.com" in r.headers["location"] or "testflight" in r.headers["location"]
