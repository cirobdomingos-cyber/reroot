"""
Apple Push Notification service (APNs) sender — token-based auth with the
provider authentication token (JWT signed with the .p8 ES256 key Apple
issues from Keys → APNs in the developer portal).

Why direct httpx instead of an SDK:
  - One file, no extra deps. We already use httpx + cryptography (via
    pywebpush). aioapns / apns2 would add dependencies and pin TLS
    versions we don't control.
  - APNs over HTTP/2 is a well-defined contract: POST a JSON payload to
    api.push.apple.com (production) or api.sandbox.push.apple.com (dev),
    with the JWT in the Authorization header and the device token in the
    URL path. Easy to audit and trace.

Why production by default:
  - TestFlight builds and App Store builds both route to PRODUCTION APNs.
  - Sandbox is reserved for builds you compile locally with Xcode and
    install on a wired device. Almost no one in our flow uses that.
  - Set APNS_USE_SANDBOX=true in env to flip — useful for `npx cap run ios`
    against a connected dev device, which embeds aps-environment=development.

Env vars required (load on first send, cached per process):
  APNS_AUTH_KEY    — full contents of the .p8 file (multiline string,
                     including BEGIN/END PRIVATE KEY headers)
  APNS_KEY_ID      — 10-char identifier from Apple Developer Keys page
                     (e.g. "ABCD123456")
  APNS_TEAM_ID     — 10-char team identifier (e.g. "GR8L4N89V2")
  APNS_BUNDLE_ID   — app bundle id, must match the iOS app's bundle id
                     and the .p8 key's allowed apps (default: "app.aue")
  APNS_USE_SANDBOX — "true" to route to sandbox, anything else = production

JWT lifetime / refresh:
  Apple requires the provider token JWT to be re-issued at most every
  60 minutes (and at least every 60 minutes). We cache and re-issue at
  50min to leave a 10min safety margin. Re-using the same token for too
  long returns ExpiredProviderToken from APNs.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)


# JWT cache: (token_str, issued_at_epoch). Re-signed every 50 minutes.
_JWT_CACHE: tuple[str, float] | None = None
_JWT_TTL_SECONDS = 50 * 60  # 50 min — Apple says max 60, leave headroom


def _config_from_env() -> Optional[dict]:
    """Read APNs config from env. Returns None when any required var is
    missing — caller should silently skip the APNs channel rather than
    crash the request path."""
    auth_key = os.environ.get("APNS_AUTH_KEY", "").strip()
    key_id = os.environ.get("APNS_KEY_ID", "").strip()
    team_id = os.environ.get("APNS_TEAM_ID", "").strip()
    bundle_id = os.environ.get("APNS_BUNDLE_ID", "app.aue").strip()
    use_sandbox = os.environ.get("APNS_USE_SANDBOX", "false").strip().lower() in ("1", "true", "yes")
    if not (auth_key and key_id and team_id):
        return None
    return {
        "auth_key": auth_key,
        "key_id": key_id,
        "team_id": team_id,
        "bundle_id": bundle_id,
        "use_sandbox": use_sandbox,
    }


def _is_configured() -> bool:
    return _config_from_env() is not None


def _sign_jwt(auth_key_pem: str, key_id: str, team_id: str) -> str:
    """Sign a fresh ES256 JWT with the .p8 key. APNs validates the kid
    header against the developer portal entry and the iss claim against
    the team id."""
    from base64 import urlsafe_b64encode
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    def b64url(data: bytes) -> str:
        return urlsafe_b64encode(data).rstrip(b"=").decode()

    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    claims = {"iss": team_id, "iat": int(time.time())}
    encoded_header = b64url(json.dumps(header, separators=(",", ":")).encode())
    encoded_claims = b64url(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{encoded_header}.{encoded_claims}".encode()

    private_key = serialization.load_pem_private_key(
        auth_key_pem.encode(), password=None,
    )
    if not isinstance(private_key, ec.EllipticCurvePrivateKey):
        raise ValueError("APNS_AUTH_KEY is not an EC P-256 key")

    der_sig = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    # JWT/ES256 uses raw r || s (32 bytes each), not the DER wrapper that
    # cryptography emits. Convert.
    r, s = decode_dss_signature(der_sig)
    raw_sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"{encoded_header}.{encoded_claims}.{b64url(raw_sig)}"


def _get_jwt(cfg: dict) -> str:
    """Get a fresh-or-cached JWT for APNs. Re-signs every 50 min."""
    global _JWT_CACHE
    now = time.time()
    if _JWT_CACHE and (now - _JWT_CACHE[1]) < _JWT_TTL_SECONDS:
        return _JWT_CACHE[0]
    token = _sign_jwt(cfg["auth_key"], cfg["key_id"], cfg["team_id"])
    _JWT_CACHE = (token, now)
    return token


def _host(cfg: dict) -> str:
    return ("api.sandbox.push.apple.com"
            if cfg["use_sandbox"]
            else "api.push.apple.com")


# Reused HTTP/2 client — APNs strongly prefers persistent connections so
# JWT auth + h2 framing isn't repaid on every push.
_CLIENT: httpx.Client | None = None


def _get_client() -> httpx.Client:
    global _CLIENT
    if _CLIENT is None:
        # http2=True needs the `h2` package — we depend on httpx[http2]
        # in requirements.txt. timeout 10s covers Railway → Apple latency.
        _CLIENT = httpx.Client(http2=True, timeout=10.0)
    return _CLIENT


def send_to_token(device_token: str, title: str, body: str,
                  url: str = "/", tag: str = "default") -> tuple[bool, Optional[str]]:
    """Send one APNs notification. Returns (success, error_reason).
    On 410 BadDeviceToken or 400 BadCollapseId etc., caller should drop
    the token from the DB."""
    cfg = _config_from_env()
    if not cfg:
        return False, "APNs not configured"

    # APNs payload — `aps.alert` for the system-rendered notification,
    # plus our custom `url`/`tag` fields. The Capacitor plugin emits a JS
    # event with the full payload on tap; the frontend reads `url` and
    # navigates the SPA.
    #
    # Deliberately NO `badge` field. We tried badge:1 first, but iOS
    # doesn't auto-clear the count when the user reads the notification
    # — and the @capacitor/push-notifications plugin doesn't expose
    # setBadgeCount, so the icon stuck at "1" forever after the first
    # push. iOS still shows a discreet dot indicator for unread
    # notifications (system setting), which is enough signal without
    # the stale count problem. removeAllDeliveredNotifications on app
    # foreground clears the notification tray.
    payload = {
        "aps": {
            "alert": {"title": title, "body": body},
            "sound": "default",
            # Allow the SDK to mutate the notification (e.g., download
            # images) — harmless if we don't, but keeps the door open.
            "mutable-content": 1,
        },
        "url": url,
        "tag": tag,
    }

    headers = {
        "authorization": f"bearer {_get_jwt(cfg)}",
        "apns-topic": cfg["bundle_id"],
        "apns-push-type": "alert",
        "apns-priority": "10",
    }

    api_url = f"https://{_host(cfg)}/3/device/{device_token}"

    try:
        client = _get_client()
        resp = client.post(api_url, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        return False, f"transport: {exc}"

    if resp.status_code == 200:
        return True, None
    # APNs returns a JSON {"reason": "BadDeviceToken"} body on errors.
    reason = ""
    try:
        reason = resp.json().get("reason", "")
    except Exception:
        reason = resp.text[:120]
    return False, f"{resp.status_code} {reason}"
