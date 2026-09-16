"""
Which live-update bundle a device is offered.

Two Railway variables:
  OTA_BUNDLE_VERSION   the version everyone gets
  OTA_CANARY_VERSION   a newer version for the devices in OTA_CANARY_DEVICES
                       (comma-separated Capgo device ids, shown in Perfil)

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


def decide(current: str, device_id: str, published: str, canary: str, canary_devices: frozenset[str]) -> Offer:
    current, published, canary = current.strip(), published.strip(), canary.strip()
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


def servable_versions(published: str, canary: str) -> frozenset[str]:
    """Bundle versions the download endpoint may serve right now. Only the
    canary while one is out, for the same reason decide() withholds the
    published number."""
    if canary.strip():
        return frozenset({canary.strip()})
    return frozenset({published.strip()}) if published.strip() else frozenset()
