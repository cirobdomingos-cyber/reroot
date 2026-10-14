"""
Which live-update bundle a device is offered.

Railway variables:
  OTA_BUNDLE_VERSION          the version every iOS device gets
  OTA_ANDROID_BUNDLE_VERSION  the version every Android device gets; empty
                              (the default) offers Android nothing
  OTA_CANARY_VERSION          a newer version for the devices in OTA_CANARY_DEVICES
                              (comma-separated Capgo device ids, shown in Perfil),
                              on either platform: listing a device is deliberate

Why Android has its own number: the bundle is the web build of this deploy,
and until 2026-10 it was offered to every device that asked. Android's
plugin applies an update by pointing the WebView's local server at the new
folder and reloading, but on Android the page is also controlled by the PWA
service worker (WKWebView on iOS has none), which answers that reload with
the OLD precached index.html. The old page then lazy-loads a chunk that no
longer exists on disk: "Failed to fetch dynamically imported module:
https://localhost/assets/index-....js" on "Continuar com Google" (Android
1.1.2, offered 1.2.25). An Android bundle is published only after it has
been tested on an Android device.

A canary gets a new build onto a tester's phone before anyone else's. The
server only ever packs one bundle — whatever this deploy holds — so while
a canary is out, the published number no longer describes the content on
disk. Offering it then would ship the canary build under the old number,
and versions are immutable on the device (see _ota_bundle_zip in main.py).
So during a canary, everyone else is simply not offered anything; they
stay on what they have until the canary is promoted.

Promote: set OTA_BUNDLE_VERSION to the canary version, clear the canary.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Offer:
    version: str | None  # None = offer nothing
    reason: str


def parse_devices(raw: str | None) -> frozenset[str]:
    return frozenset(d.strip().lower() for d in (raw or "").split(",") if d.strip())


def published_for(platform: str | None, published: str, android_published: str) -> str | None:
    """The published version for a platform, or None when the platform is
    not one we ship bundles for. A missing platform is treated as iOS: the
    iOS plugin has always sent "ios", so only very old clients omit it, and
    those are iOS builds (Android shipped after the plugin sent it)."""
    p = (platform or "").strip().lower()
    if p in ("", "ios"):
        return published
    if p == "android":
        return android_published
    return None


def decide(
    current: str,
    device_id: str,
    published: str,
    canary: str,
    canary_devices: frozenset[str],
    platform: str | None = "ios",
    android_published: str = "",
) -> Offer:
    resolved = published_for(platform, published, android_published)
    if resolved is None:
        return Offer(None, "unknown platform")
    current, published, canary = current.strip(), resolved.strip(), canary.strip()
    if canary:
        if device_id.strip().lower() in canary_devices:
            if current == canary:
                return Offer(None, "up to date")
            return Offer(canary, "canary")
        return Offer(None, "canary in progress")
    if not published:
        return Offer(None, "disabled")
    if current == published:
        return Offer(None, "up to date")
    return Offer(published, "published")


def servable_versions(published: str, canary: str, android_published: str = "") -> frozenset[str]:
    """Bundle versions the download endpoint may serve right now. Only the
    canary while one is out, for the same reason decide() withholds the
    published numbers."""
    if canary.strip():
        return frozenset({canary.strip()})
    return frozenset(v.strip() for v in (published, android_published) if v.strip())
