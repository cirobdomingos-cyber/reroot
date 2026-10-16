"""
Firebase Cloud Messaging (FCM) sender for the Android app (package app.aue).

Uses the HTTP v1 API directly with httpx, mirroring apns.py: no SDK, no new
dependency. The OAuth2 access token is minted from the Firebase service
account by signing an RS256 JWT with `cryptography` (already installed via
pywebpush) and exchanging it at Google's token endpoint (the standard
"service account JWT bearer" flow).

Env var (read on every send, cached per process):
  FIREBASE_SERVICE_ACCOUNT_B64 - base64 of the service-account JSON
                                 (client_email, private_key, project_id,
                                 token_uri). project_id comes from the JSON.

Unset or malformed = the Android channel is skipped, never an exception.

Payload parity with APNs: {title, body, url, tag}. title/body go in the
`notification` block so the system tray renders it while the app is closed;
url/tag go in `data`, which @capacitor/push-notifications exposes as
action.notification.data on tap (src/lib/pushNavigation.js reads data.url).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)

_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
# Must match the channel the Android app creates / the manifest default.
ANDROID_CHANNEL_ID = "default"
# Refresh this long before Google's expiry (tokens live 3600s).
_REFRESH_MARGIN_SECONDS = 120

# (access_token, expires_at_epoch)
_TOKEN_CACHE: tuple[str, float] | None = None
_WARNED_UNCONFIGURED = False


def _config_from_env() -> Optional[dict]:
    """Parsed service account, or None when unset/invalid."""
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_B64", "").strip()
    if not raw:
        return None
    try:
        info = json.loads(base64.b64decode(raw))
        if not (info.get("client_email") and info.get("private_key") and info.get("project_id")):
            return None
        return {
            "client_email": info["client_email"],
            "private_key": info["private_key"],
            "project_id": info["project_id"],
            "token_uri": info.get("token_uri") or _DEFAULT_TOKEN_URI,
        }
    except Exception:
        return None


def _is_configured() -> bool:
    return _config_from_env() is not None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _sign_assertion(cfg: dict, now: int) -> str:
    """RS256 JWT asserting the service account, valid one hour."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    header = {"alg": "RS256", "typ": "JWT"}
    claims = {
        "iss": cfg["client_email"],
        "scope": _SCOPE,
        "aud": cfg["token_uri"],
        "iat": now,
        "exp": now + 3600,
    }
    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64url(json.dumps(claims, separators=(",", ":")).encode())
    ).encode()
    key = serialization.load_pem_private_key(cfg["private_key"].encode(), password=None)
    sig = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return signing_input.decode() + "." + _b64url(sig)


_CLIENT: httpx.Client | None = None


def _get_client() -> httpx.Client:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = httpx.Client(timeout=10.0)
    return _CLIENT


def _get_access_token(cfg: dict) -> str:
    """Cached OAuth2 access token; re-minted shortly before expiry."""
    global _TOKEN_CACHE
    now = time.time()
    if _TOKEN_CACHE and now < _TOKEN_CACHE[1] - _REFRESH_MARGIN_SECONDS:
        return _TOKEN_CACHE[0]
    resp = _get_client().post(cfg["token_uri"], data={
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": _sign_assertion(cfg, int(now)),
    })
    resp.raise_for_status()
    body = resp.json()
    token = body["access_token"]
    _TOKEN_CACHE = (token, now + int(body.get("expires_in", 3600)))
    return token


def build_message(device_token: str, title: str, body: str,
                  url: str = "/", tag: str = "default") -> dict:
    return {
        "message": {
            "token": device_token,
            "notification": {"title": title, "body": body},
            # FCM data values must be strings.
            "data": {"url": str(url), "tag": str(tag)},
            "android": {
                "priority": "HIGH",
                # Same tag collapses notifications into one slot, like the
                # web `tag` and the weekly/daily digest rely on.
                "collapse_key": str(tag),
                "notification": {
                    "channel_id": ANDROID_CHANNEL_ID,
                    "tag": str(tag),
                },
            },
        }
    }


def is_dead_token_reason(reason: Optional[str]) -> bool:
    """True when the token will never work again and should be deleted."""
    return bool(reason) and ("UNREGISTERED" in reason or "INVALID_ARGUMENT" in reason
                             or reason.startswith("404"))


def send_to_token(device_token: str, title: str, body: str,
                  url: str = "/", tag: str = "default") -> tuple[bool, Optional[str]]:
    """Send one FCM notification. Returns (success, error_reason). When the
    reason satisfies is_dead_token_reason the caller drops the token."""
    global _WARNED_UNCONFIGURED
    cfg = _config_from_env()
    if not cfg:
        if not _WARNED_UNCONFIGURED:
            _WARNED_UNCONFIGURED = True
            log.info("FCM not configured (FIREBASE_SERVICE_ACCOUNT_B64): skipping Android tokens")
        return False, "FCM not configured"

    try:
        access_token = _get_access_token(cfg)
        resp = _get_client().post(
            f"https://fcm.googleapis.com/v1/projects/{cfg['project_id']}/messages:send",
            json=build_message(device_token, title, body, url, tag),
            headers={"authorization": f"Bearer {access_token}"},
        )
    except Exception as exc:  # transport, token mint, bad key
        return False, f"transport: {exc}"

    if resp.status_code == 200:
        return True, None
    # Error body: {"error": {"status": "UNREGISTERED", "message": ...}}
    status = ""
    try:
        status = resp.json().get("error", {}).get("status", "")
    except Exception:
        status = resp.text[:120]
    if resp.status_code == 401:
        # Stale cached token: force a re-mint on the next send.
        global _TOKEN_CACHE
        _TOKEN_CACHE = None
    return False, f"{resp.status_code} {status}"
