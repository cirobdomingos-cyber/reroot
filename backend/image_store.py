"""
Image rehosting — download IG-CDN-served event images at scrape time and
serve them from our own /event-images path.

Why: Instagram CDN URLs are signed and expire in ~weeks. Hot-linking them
means the event hero shows a broken image as soon as the URL rots — even
if the event itself is still upcoming. Rehosting once at scrape time
moves the image off IG's CDN and onto a path we control, so it stays
viewable as long as the event is in the catalog.

Storage: writes to IMAGES_DIR (env-overridable, defaults to a sibling of
the SQLite DB so the same Railway volume holds both). Files are named
`<event_id>.<ext>` so re-scrapes are idempotent: same id → same file →
no second download.

Public URL: `/event-images/<filename>`. main.py mounts a StaticFiles
handler on that path pointing at IMAGES_DIR.
"""

import logging
import os
from pathlib import Path
from typing import Optional

import httpx

import database as db


log = logging.getLogger(__name__)

# Directory to store rehosted images. In production this lives on the
# same Railway volume as DB_PATH so it survives redeploys; locally it
# sits next to the dev SQLite file.
_env = os.environ.get("IMAGES_DIR", "").strip()
if _env:
    IMAGES_DIR = Path(_env)
else:
    IMAGES_DIR = db.DB_PATH.parent / "event_images"
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

# IG CDN responses are typically image/jpeg, sometimes webp. We map the
# Content-Type to a known extension so the saved file has the right
# suffix for browser rendering.
_CT_TO_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}
_EXTS = ("jpg", "jpeg", "png", "webp", "gif")
_PUBLIC_PREFIX = "/event-images"

# Reasonable cap so a malicious or broken upstream can't fill the disk
# with one giant image. ~5MB covers IG's high-res posts comfortably.
_MAX_BYTES = 5 * 1024 * 1024


def public_url(filename: str) -> str:
    return f"{_PUBLIC_PREFIX}/{filename}"


def existing_path(event_id: str) -> Optional[Path]:
    """Return the on-disk path for an event's rehosted image, if any.
    Skips the network call when re-scraping a known event."""
    for ext in _EXTS:
        candidate = IMAGES_DIR / f"{event_id}.{ext}"
        if candidate.exists() and candidate.stat().st_size > 0:
            return candidate
    return None


def rehost_image(event_id: str, source_url: str) -> Optional[str]:
    """Download `source_url` (typically an IG CDN URL) to the local store
    and return our public path. Returns None on any failure — the caller
    keeps the original URL, which works until it rots, and will get
    rehosted on the next scrape."""
    if not event_id or not source_url:
        return None
    # Idempotency: skip download when we already have a copy.
    existing = existing_path(event_id)
    if existing:
        return public_url(existing.name)
    try:
        with httpx.Client(timeout=10.0, follow_redirects=True) as client:
            res = client.get(
                source_url,
                # User-Agent that looks like a browser — IG sometimes
                # returns a 403 for clearly-bot UAs even on signed URLs.
                headers={"User-Agent": "Mozilla/5.0 aue-curitiba-events/1.0"},
            )
        if res.status_code != 200:
            log.info("rehost: source returned HTTP %s for %s", res.status_code, event_id)
            return None
        if len(res.content) > _MAX_BYTES:
            log.warning("rehost: image too large for %s (%d bytes)", event_id, len(res.content))
            return None
        ct = (res.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        ext = _CT_TO_EXT.get(ct, "jpg")
        target = IMAGES_DIR / f"{event_id}.{ext}"
        target.write_bytes(res.content)
        log.info("rehost: saved %s (%d bytes, ct=%s)", target.name, len(res.content), ct)
        return public_url(target.name)
    except Exception as exc:
        log.warning("rehost: failed for %s: %s", event_id, exc)
        return None


def rehost_pending_events(limit: int = 100) -> dict:
    """One-shot backfill: walk events whose image_url still points at an
    external host (anything that doesn't start with our public prefix)
    and rehost each. Bounded by `limit` so a single admin call doesn't
    sit for minutes — re-run until ok+failed equals processed.

    Reads payloads, mutates image_url in place, writes them back via
    the same upsert path so other side-effects (timestamp updates,
    is_curated re-eval, etc.) don't fire."""
    import json
    candidates: list[tuple[str, str, dict]] = []
    with db.get_conn() as conn:
        rows = conn.execute("SELECT id, payload FROM events").fetchall()
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except (json.JSONDecodeError, TypeError):
            continue
        url = payload.get("image_url") or ""
        if not url:
            continue
        if url.startswith(_PUBLIC_PREFIX):
            continue
        candidates.append((r["id"], url, payload))
        if len(candidates) >= limit:
            break

    ok = 0
    failed = 0
    for event_id, source_url, payload in candidates:
        rehosted = rehost_image(event_id, source_url)
        if rehosted:
            payload["image_url"] = rehosted
            with db.get_conn() as conn:
                conn.execute(
                    "UPDATE events SET payload = ? WHERE id = ?",
                    (json.dumps(payload), event_id),
                )
                conn.commit()
            ok += 1
        else:
            failed += 1

    # How many still need rehosting after this batch — caller knows
    # whether to run again.
    with db.get_conn() as conn:
        remaining = 0
        for r in conn.execute("SELECT payload FROM events").fetchall():
            try:
                p = json.loads(r["payload"])
            except (json.JSONDecodeError, TypeError):
                continue
            u = p.get("image_url") or ""
            if u and not u.startswith(_PUBLIC_PREFIX):
                remaining += 1
    return {"processed": len(candidates), "ok": ok, "failed": failed, "remaining": remaining}
