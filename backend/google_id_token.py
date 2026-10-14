"""
Google ID token verification (native Android sign-in).

The Android app signs in through Google's Credential Manager, which hands
the app an ID token — a JWT signed by Google with RS256 — instead of the
access token the web (GSI) and iOS (PKCE) paths end with. This module
verifies that token on the server, the same way apple_auth.py verifies
Apple's:

  1. Find Google's signing key for the token's `kid` in the JWK set at
     https://www.googleapis.com/oauth2/v3/certs (cached per process,
     refreshed when an unknown kid arrives, at most once per TTL).
  2. Verify the RS256 signature.
  3. Check the claims:
       - iss is accounts.google.com (with or without https://)
       - aud is our WEB client id (GOOGLE_WEB_CLIENT_ID). Credential
         Manager issues the token for the serverClientId the app asked
         for, which is the web client; the Android OAuth clients only
         prove the app's signing certificate to Google.
       - exp not passed (60s clock skew), iat not in the future
       - sub present; email_verified is checked by the caller, so the
         route can answer with its own message.

Returns the claims on success, raises ValueError otherwise (the route
maps it to 401). Same no-new-dependency choice as apple_auth.py: httpx
plus `cryptography`, both already installed.
"""
from __future__ import annotations

import json
import logging
import os
import time

import httpx

from apple_auth import _b64url_decode, _build_rsa_public_key

log = logging.getLogger(__name__)

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")

# The web OAuth client id, non-secret (it ships in every web bundle).
# Env overrides it so staging could use its own client.
DEFAULT_WEB_CLIENT_ID = "511485926685-9a6hihg5dn4g4qtdgs4c6i2tjscih2m6.apps.googleusercontent.com"

_jwks_cache: dict = {}
_jwks_last_fetch: float = 0.0
_JWKS_TTL_S = 3600.0


def web_client_id() -> str:
    return (os.environ.get("GOOGLE_WEB_CLIENT_ID") or "").strip() or DEFAULT_WEB_CLIENT_ID


def _refresh_jwks() -> None:
    global _jwks_last_fetch
    try:
        resp = httpx.get(GOOGLE_JWKS_URL, timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        log.warning(f"google_id_token: failed to fetch JWKs: {exc}")
        return
    fresh = {}
    for jwk in data.get("keys") or []:
        kid = jwk.get("kid")
        if not kid or jwk.get("kty") != "RSA":
            continue
        try:
            fresh[kid] = _build_rsa_public_key(jwk)
        except Exception as exc:
            log.warning(f"google_id_token: bad JWK kid={kid}: {exc}")
    if fresh:
        _jwks_cache.clear()
        _jwks_cache.update(fresh)
        _jwks_last_fetch = time.time()


def _public_key_for_kid(kid: str):
    """Module-level so tests can hand in their own key."""
    if kid in _jwks_cache:
        return _jwks_cache[kid]
    if time.time() - _jwks_last_fetch > _JWKS_TTL_S or not _jwks_cache:
        _refresh_jwks()
    return _jwks_cache.get(kid)


def verify(id_token: str, audience: str | None = None) -> dict:
    """Verify a Google ID token and return its claims (see module doc)."""
    audience = audience or web_client_id()
    parts = (id_token or "").split(".")
    if len(parts) != 3:
        raise ValueError("id_token: not a JWT")
    try:
        header = json.loads(_b64url_decode(parts[0]))
        payload = json.loads(_b64url_decode(parts[1]))
        signature = _b64url_decode(parts[2])
    except Exception as exc:
        raise ValueError(f"id_token: malformed segment: {exc}")

    if header.get("alg") != "RS256":
        raise ValueError(f"id_token: alg={header.get('alg')}, expected RS256")
    kid = header.get("kid")
    if not kid:
        raise ValueError("id_token: missing kid")
    pub_key = _public_key_for_kid(kid)
    if pub_key is None:
        raise ValueError(f"id_token: unknown signing key kid={kid}")

    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    try:
        pub_key.verify(signature, f"{parts[0]}.{parts[1]}".encode(),
                       padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        raise ValueError("id_token: signature mismatch")

    if payload.get("iss") not in GOOGLE_ISSUERS:
        raise ValueError(f"id_token: iss={payload.get('iss')}")
    if payload.get("aud") != audience:
        raise ValueError(f"id_token: aud={payload.get('aud')}, expected {audience}")
    now = time.time()
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp + 60 < now:
        raise ValueError("id_token: expired")
    iat = payload.get("iat")
    if isinstance(iat, (int, float)) and iat - 60 > now:
        raise ValueError("id_token: iat in the future")
    if not isinstance(payload.get("sub"), str) or not payload["sub"]:
        raise ValueError("id_token: missing sub")
    return payload


def email_verified(claims: dict) -> bool:
    """Google sends a JSON boolean; older tokens sent the string "true"."""
    value = claims.get("email_verified")
    return value is True or (isinstance(value, str) and value.lower() == "true")
