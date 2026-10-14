"""
Tests for live-update channels (published + canary).

What must hold:
  1. Without a canary, behaviour is unchanged: devices not on the published
     version are offered it.
  2. A canary reaches only the listed devices, case-insensitively.
  3. While a canary is out nobody else is offered anything, and the old
     number can't be downloaded — the bundle on disk is the canary build,
     so serving it under the old number would strand devices on it.
  4. Promoting (published = canary, canary cleared) offers it to everyone.
  5. Android is offered only OTA_ANDROID_BUNDLE_VERSION (empty = nothing);
     iOS keeps OTA_BUNDLE_VERSION.
"""
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import ota  # noqa: E402

PHONE = "AAAA-1111"
NONE = frozenset()


def test_published_only_is_unchanged():
    assert ota.decide("1.1.6", "x", "1.1.7", "", NONE) == ota.Offer("1.1.7", "published")
    assert ota.decide("1.1.7", "x", "1.1.7", "", NONE).version is None
    assert ota.decide("1.1.6", "x", "", "", NONE).reason == "disabled"


def test_canary_reaches_only_listed_devices():
    devices = ota.parse_devices(f" {PHONE.lower()} , other ")
    assert ota.decide("1.1.7", PHONE, "1.1.7", "1.1.8", devices) == ota.Offer("1.1.8", "canary")
    assert ota.decide("1.1.8", PHONE, "1.1.7", "1.1.8", devices).version is None


def test_nobody_else_is_offered_anything_during_a_canary():
    devices = ota.parse_devices(PHONE)
    offer = ota.decide("1.1.6", "someone-else", "1.1.7", "1.1.8", devices)
    assert offer == ota.Offer(None, "canary in progress")
    assert ota.servable_versions("1.1.7", "1.1.8") == {"1.1.8"}


def test_promotion_offers_it_to_everyone():
    assert ota.decide("1.1.7", "someone-else", "1.1.8", "", NONE) == ota.Offer("1.1.8", "published")
    assert ota.servable_versions("1.1.8", "") == {"1.1.8"}
    assert ota.servable_versions("", "") == frozenset()


# ── Platform split (Android has its own published number) ──────────────
# The web bundle used to be offered to every device. On Android, applying
# it under a page the PWA service worker kept alive broke lazy chunks
# ("Failed to fetch dynamically imported module", ota.py). Android gets a
# bundle only once OTA_ANDROID_BUNDLE_VERSION is set on purpose.

def test_android_is_offered_nothing_by_default():
    offer = ota.decide("builtin", "x", "1.2.25", "", NONE, platform="android")
    assert offer == ota.Offer(None, "disabled")


def test_ios_keeps_the_published_version():
    assert ota.decide("1.2.24", "x", "1.2.25", "", NONE, platform="ios") == ota.Offer("1.2.25", "published")
    # Clients that omit the platform are old iOS builds: unchanged.
    assert ota.decide("1.2.24", "x", "1.2.25", "", NONE, platform="") == ota.Offer("1.2.25", "published")


def test_android_gets_only_its_own_published_version():
    assert ota.decide("builtin", "x", "1.2.25", "", NONE, platform="Android",
                      android_published="1.3.0") == ota.Offer("1.3.0", "published")
    assert ota.decide("1.3.0", "x", "1.2.25", "", NONE, platform="android",
                      android_published="1.3.0").version is None
    # iOS does not follow Android's number.
    assert ota.decide("1.2.25", "x", "1.2.25", "", NONE, platform="ios",
                      android_published="1.3.0").version is None


def test_unknown_platform_is_offered_nothing():
    assert ota.decide("1.0", "x", "1.2.25", "", NONE, platform="electron").reason == "unknown platform"


def test_listed_android_canary_device_gets_the_canary():
    devices = ota.parse_devices(PHONE)
    assert ota.decide("builtin", PHONE, "1.2.25", "1.2.26", devices,
                      platform="android") == ota.Offer("1.2.26", "canary")
    assert ota.decide("builtin", "other", "1.2.25", "1.2.26", devices, platform="android",
                      android_published="1.2.25").version is None


def test_servable_includes_android_version():
    assert ota.servable_versions("1.2.25", "", "1.3.0") == {"1.2.25", "1.3.0"}
    assert ota.servable_versions("", "", "1.3.0") == {"1.3.0"}
    assert ota.servable_versions("1.2.25", "1.2.26", "1.3.0") == {"1.2.26"}


# ── The endpoint reads the platform from the plugin's request ──────────

def _client(tmp_path, monkeypatch, **env):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    for key in ("OTA_BUNDLE_VERSION", "OTA_ANDROID_BUNDLE_VERSION",
                "OTA_CANARY_VERSION", "OTA_CANARY_DEVICES"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    for mod in ("database", "main", "enrichment"):
        sys.modules.pop(mod, None)
    import main as _main
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<html></html>")
    (static / "assets" / "index-abc.js").write_text("console.log(1)")
    monkeypatch.setattr(_main, "STATIC_DIR", static)
    _main._OTA_ZIP_CACHE.clear()
    from fastapi.testclient import TestClient
    return TestClient(_main.app)


def _check(client, platform):
    return client.post("/updates/check", json={
        "platform": platform, "version_name": "builtin",
        "version_build": "1.1.2", "device_id": "dev-1",
    }).json()


def test_check_endpoint_withholds_the_bundle_from_android(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, OTA_BUNDLE_VERSION="1.2.25")
    assert _check(client, "ios")["version"] == "1.2.25"
    android = _check(client, "android")
    assert "version" not in android and "url" not in android


def test_check_endpoint_offers_android_its_version(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, OTA_BUNDLE_VERSION="1.2.25",
                     OTA_ANDROID_BUNDLE_VERSION="1.3.0")
    body = _check(client, "android")
    assert body["version"] == "1.3.0"
    assert body["url"].endswith("/updates/bundle/1.3.0.zip")
    assert client.get("/updates/bundle/1.3.0.zip").status_code == 200


def test_android_only_publish_does_not_disable_the_endpoint(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch, OTA_ANDROID_BUNDLE_VERSION="1.3.0")
    assert _check(client, "android")["version"] == "1.3.0"
    assert "version" not in _check(client, "ios")
