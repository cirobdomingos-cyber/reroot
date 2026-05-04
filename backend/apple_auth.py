"""
Apple Sign-In identity token verification.

When a user signs in with Apple (native iOS plugin or web JS SDK),
the device returns an `identityToken` — a JWT signed by Apple with
RS256 against one of Apple's rotating signing keys.

This module verifies that token end-to-end:
  1. Fetch Apple's JWKs from https://appleid.apple.com/auth/keys
  2. Cache the JWK set per process (Apple rotates keys ~daily; the
     cached set is refreshed lazily when an unknown kid arrives,
     which catches both rotations and key additions without a
     polling loop).
  3. Find the JWK matching the JWT's `kid` header.
  4. Reconstruct the RSA public key from (n, e) and verify the
     signature with RS256.
  5. Validate claims:
       - iss == "https://appleid.apple.com"
       - aud == our expected audience (bundle id for native,
         service id for web)
       - exp not expired (with 60s clock-skew grace)
       - iat reasonable (not in the future, not too old)

Returns the decoded claims when valid (caller uses .sub as the
provider_id and .email if present), or raises ValueError with a
human-readable message that the API layer maps to 401.

No third-party deps beyond `httpx` (already vendored) and
`cryptography` (vendored via pywebpush). PyJWT was tempting but
brings its own algorithm matrix and would be the only place we
use it, so the manual path is small enough to be worth keeping
explicit.
"""
from __future__ import annotations

import base64
import json
import logging
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)


# JWKs are cached for the life of the process. _jwks_cache[kid] = pub_key.
# When a token arrives with a kid we don't have, we re-fetch (catches
# Apple key rotations without a polling cron).
_jwks_cache: dict[str, "RSAPublicKey"] = {}  # type: ignore[name-defined]
_jwks_last_fetch: float = 0.0
_JWKS_TTL_S = 3600.0  # refresh at most once per hour, even on miss


_APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
_APPLE_ISSUER = "https://appleid.apple.com"


def _b64url_decode(s: str) -> bytes:
    """Apple JWKs use URL-safe base64 without padding."""
    pad = (-len(s)) % 4
    return base64.urlsafe_b64decode(s + ("=" * pad))


def _build_rsa_public_key(jwk: dict):
    """Reconstruct an RSA public key from a JWK's n (modulus) and e
    (exponent) fields. Returns a cryptography RSAPublicKey ready for
    .verify()."""
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
    n = int.from_bytes(_b64url_decode(jwk["n"]), "big")
    e = int.from_bytes(_b64url_decode(jwk["e"]), "big")
    return RSAPublicNumbers(e, n).public_key()


def _refresh_jwks() -> None:
    """Pull the current JWK set from Apple. Replaces the in-memory cache
    on success; leaves it untouched on failure (last good keys still
    work for tokens signed before Apple rotated)."""
    global _jwks_last_fetch
    try:
        resp = httpx.get(_APPLE_JWKS_URL, timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        log.warning(f"apple_auth: failed to fetch JWKs: {exc}")
        return
    new_cache: dict[str, "RSAPublicKey"] = {}  # type: ignore[name-defined]
    for jwk in data.get("keys") or []:
        kid = jwk.get("kid")
        if not kid or jwk.get("kty") != "RSA":
            continue
        try:
            new_cache[kid] = _build_rsa_public_key(jwk)
        except Exception as exc:
            log.warning(f"apple_auth: bad JWK kid={kid}: {exc}")
    if new_cache:
        _jwks_cache.clear()
        _jwks_cache.update(new_cache)
        _jwks_last_fetch = time.time()
        log.info(f"apple_auth: cached {len(new_cache)} Apple JWKs")


def _get_public_key_for_kid(kid: str):
    """Return cached public key for `kid`, refreshing the JWK set on
    miss (rate-limited by _JWKS_TTL_S to avoid hammering Apple on a
    bad token storm)."""
    if kid in _jwks_cache:
        return _jwks_cache[kid]
    if time.time() - _jwks_last_fetch > _JWKS_TTL_S or not _jwks_cache:
        _refresh_jwks()
    return _jwks_cache.get(kid)


def verify_identity_token(
    identity_token: str,
    expected_audiences: list[str],
) -> dict:
    """Verify an Apple Sign-In identityToken and return its claims.

    `expected_audiences` is the list of acceptable `aud` values — for
    auê that's [bundle_id, service_id], so the same backend handles
    native iOS sign-ins (aud=app.aue) and web sign-ins (aud=auê's
    Service ID, e.g. "app.aue.web").

    Raises ValueError with a clear message on:
      - malformed JWT structure
      - unknown signing key (after a JWK refresh)
      - bad signature
      - wrong issuer
      - audience mismatch
      - expired or future-dated token
    """
    parts = identity_token.split(".")
    if len(parts) != 3:
        raise ValueError("identity_token: not a JWT (expected three segments)")

    try:
        header = json.loads(_b64url_decode(parts[0]))
        payload = json.loads(_b64url_decode(parts[1]))
        signature = _b64url_decode(parts[2])
    except Exception as exc:
        raise ValueError(f"identity_token: malformed segment: {exc}")

    if header.get("alg") != "RS256":
        raise ValueError(f"identity_token: alg={header.get('alg')}, expected RS256")
    kid = header.get("kid")
    if not kid:
        raise ValueError("identity_token: missing kid in header")

    pub_key = _get_public_key_for_kid(kid)
    if pub_key is None:
        raise ValueError(f"identity_token: unknown signing key kid={kid}")

    # Verify signature: RS256 = RSA-PKCS1v15 over SHA-256 of "header.payload".
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.exceptions import InvalidSignature
    signing_input = f"{parts[0]}.{parts[1]}".encode()
    try:
        pub_key.verify(
            signature,
            signing_input,
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except InvalidSignature:
        raise ValueError("identity_token: signature mismatch")
    except Exception as exc:
        raise ValueError(f"identity_token: verify error: {exc}")

    # Claims validation.
    if payload.get("iss") != _APPLE_ISSUER:
        raise ValueError(f"identity_token: iss={payload.get('iss')}, expected {_APPLE_ISSUER}")
    aud = payload.get("aud")
    if aud not in expected_audiences:
        raise ValueError(
            f"identity_token: aud={aud}, expected one of {expected_audiences}"
        )

    now = time.time()
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp + 60 < now:
        raise ValueError("identity_token: expired")
    iat = payload.get("iat")
    if isinstance(iat, (int, float)) and iat - 60 > now:
        raise ValueError("identity_token: iat in the future")

    sub = payload.get("sub")
    if not sub or not isinstance(sub, str):
        raise ValueError("identity_token: missing sub claim")

    return payload
