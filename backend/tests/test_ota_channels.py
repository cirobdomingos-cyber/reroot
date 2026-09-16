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
