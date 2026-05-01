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

import html
import logging
import os
import re
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


# IG avatars get their own subdirectory under IMAGES_DIR. Same Railway
# volume, segregated namespace so we can wipe/inspect avatars without
# touching event images.
AVATARS_DIR = IMAGES_DIR / "avatars"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)
_AVATAR_PUBLIC_PREFIX = f"{_PUBLIC_PREFIX}/avatars"


def avatar_public_url(filename: str) -> str:
    return f"{_AVATAR_PUBLIC_PREFIX}/{filename}"


def existing_avatar_path(handle: str) -> Optional[Path]:
    handle = handle.strip().lstrip("@").lower()
    for ext in _EXTS:
        candidate = AVATARS_DIR / f"{handle}.{ext}"
        if candidate.exists() and candidate.stat().st_size > 0:
            return candidate
    return None


def rehost_avatar(handle: str, source_url: str) -> Optional[str]:
    """Download the IG profile picture for `handle` and store it locally.
    Returns our public path on success; None on failure (caller keeps
    the IG CDN URL, which works until it rots).

    Same anti-hot-link rationale as event images: IG CDN URLs are signed
    and expire in ~weeks, so the avatar in /sources goes blank a few
    days after the scrape if we don't rehost. Idempotent — skip when
    an avatar file already exists for this handle (last rehost wins
    on subsequent scrapes via overwrite, see scrape pipeline)."""
    if not handle or not source_url:
        return None
    handle = handle.strip().lstrip("@").lower()
    if not handle:
        return None
    # If we already have an avatar AND the caller didn't pass a fresh
    # IG URL (i.e., the stored URL is already our local path), no-op.
    if source_url.startswith(_AVATAR_PUBLIC_PREFIX):
        return source_url
    try:
        with httpx.Client(timeout=10.0, follow_redirects=True) as client:
            res = client.get(
                source_url,
                headers={"User-Agent": "Mozilla/5.0 aue-curitiba-events/1.0"},
            )
        if res.status_code != 200:
            log.info("rehost-avatar: HTTP %s for %s", res.status_code, handle)
            return None
        if len(res.content) > _MAX_BYTES:
            log.warning("rehost-avatar: image too large for %s (%d bytes)", handle, len(res.content))
            return None
        ct = (res.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        ext = _CT_TO_EXT.get(ct, "jpg")
        # Wipe any older extension for this handle so we don't leave
        # stale .jpg behind when the new one comes back .webp.
        for old_ext in _EXTS:
            old = AVATARS_DIR / f"{handle}.{old_ext}"
            if old.exists() and old_ext != ext:
                try: old.unlink()
                except OSError: pass
        target = AVATARS_DIR / f"{handle}.{ext}"
        target.write_bytes(res.content)
        log.info("rehost-avatar: saved @%s (%d bytes, ct=%s)", handle, len(res.content), ct)
        return avatar_public_url(target.name)
    except Exception as exc:
        log.warning("rehost-avatar: failed for @%s: %s", handle, exc)
        return None


_OG_IMAGE_RE = re.compile(
    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']'
)


def fetch_ig_avatar_url(handle: str) -> Optional[str]:
    """Fetch the current IG profile picture URL for `handle` by scraping
    the public profile page's og:image meta tag. Returns the avatar
    URL on success, None if the page is unreachable / the response
    shape changed.

    Why this path: most of our 80+ tracked handles never had a
    `profile_pic_url` populated (older Apify scrapes didn't extract
    owner metadata reliably). Re-running a full Apify scrape costs
    money per call. The public profile page (`instagram.com/<handle>/`)
    serves an og:image with the avatar — same image Instagram serves
    when you share the profile link in iMessage/Slack — no login
    required. We rehost it to our /event-images/avatars path so the
    signed CDN URL doesn't rot a few weeks later."""
    handle = (handle or "").strip().lstrip("@").lower()
    if not handle:
        return None
    url = f"https://www.instagram.com/{handle}/"
    try:
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            res = client.get(url, headers={
                # Real-browser UA — IG returns a stripped login wall
                # for clearly-bot UAs but still includes og:image for
                # public profiles when the UA looks like Safari/Chrome.
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                    "Version/17.0 Safari/605.1.15"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
                "Accept-Language": "en-US,en;q=0.9",
            })
        if res.status_code != 200:
            log.info("ig-profile-page: HTTP %s for %s", res.status_code, handle)
            return None
        m = _OG_IMAGE_RE.search(res.text)
        if not m:
            return None
        og = m.group(1) or ""
        # The page serves og:image with HTML-escaped query params
        # (`&amp;` instead of `&`). Without unescape the IG CDN sees
        # `?stp=...&amp;_nc_cat=110` as a single param and the signed
        # URL fails validation → 403. The signed avatars at IG only
        # validate with the exact unescaped query string.
        og = html.unescape(og)
        # Bot-block tell: when IG's anti-scraper detection fires, the
        # profile page comes back generic and og:image points at IG's
        # static-asset CDN (the Instagram brand logo PNG) instead of
        # the real avatar on scontent.cdninstagram.com. Reject so the
        # caller treats it as a failure and we retry on the next pass.
        if "static.cdninstagram.com" in og or "/rsrc.php/" in og:
            return None
        return og or None
    except Exception as exc:
        log.warning("ig-profile-page: failed for @%s: %s", handle, exc)
        return None


def clear_bot_blocked_avatars() -> dict:
    """Cleanup: any avatar stored as `.png` is the IG-brand-logo
    fallback we got from a bot-blocked profile page (real avatars
    come back as JPEG from scontent.cdninstagram.com). Delete the
    file and reset `profile_pic_url` to empty so the next backfill
    pass re-fetches with the now-filtered fetch logic."""
    cleared = 0
    handles: list[str] = []
    for png in AVATARS_DIR.glob("*.png"):
        handle = png.stem
        try:
            png.unlink()
        except OSError:
            continue
        handles.append(handle)
        cleared += 1
    if handles:
        with db.get_conn() as conn:
            for h in handles:
                conn.execute(
                    "UPDATE tracked_ig_accounts SET profile_pic_url = '' WHERE handle = ?",
                    (h,),
                )
            conn.commit()
    return {"cleared": cleared, "handles": handles}


def rehost_pending_avatars(limit: int = 50) -> dict:
    """Backfill: walk every tracked IG account whose profile_pic_url is
    still an external URL and rehost each. Bounded by `limit`. Re-run
    until 'remaining' returns 0.

    Two passes:
      1. Handles with a stored external URL — rehost that URL.
      2. Handles with empty `profile_pic_url` — fetch the current avatar
         from Instagram's web_profile_info endpoint, then rehost.

    Pass 2 is what fills in the long tail of venues that never had a
    profile pic captured (older Apify scrapes were unreliable)."""
    candidates: list[tuple[str, str]] = []
    missing: list[str] = []
    with db.get_conn() as conn:
        rows = conn.execute(
            """SELECT handle, profile_pic_url FROM tracked_ig_accounts
               WHERE profile_pic_url != ''
                 AND profile_pic_url NOT LIKE ?""",
            (f"{_AVATAR_PUBLIC_PREFIX}%",),
        ).fetchall()
        empty_rows = conn.execute(
            """SELECT handle FROM tracked_ig_accounts
               WHERE enabled = 1
                 AND (profile_pic_url IS NULL OR profile_pic_url = '')"""
        ).fetchall()
    for r in rows:
        candidates.append((r["handle"], r["profile_pic_url"]))
        if len(candidates) >= limit:
            break
    if len(candidates) < limit:
        for r in empty_rows:
            missing.append(r["handle"])
            if len(candidates) + len(missing) >= limit:
                break

    ok = 0
    failed = 0
    fetched = 0
    for handle, source_url in candidates:
        local = rehost_avatar(handle, source_url)
        if local:
            with db.get_conn() as conn:
                conn.execute(
                    "UPDATE tracked_ig_accounts SET profile_pic_url = ? WHERE handle = ?",
                    (local, handle),
                )
                conn.commit()
            ok += 1
        else:
            failed += 1

    # Pass 2 — handles with no stored URL at all. Pull the avatar URL
    # from the public IG endpoint, then rehost it.
    for handle in missing:
        ig_url = fetch_ig_avatar_url(handle)
        if not ig_url:
            failed += 1
            continue
        fetched += 1
        local = rehost_avatar(handle, ig_url)
        if local:
            with db.get_conn() as conn:
                conn.execute(
                    "UPDATE tracked_ig_accounts SET profile_pic_url = ? WHERE handle = ?",
                    (local, handle),
                )
                conn.commit()
            ok += 1
        else:
            failed += 1

    with db.get_conn() as conn:
        remaining_external = conn.execute(
            """SELECT COUNT(*) AS c FROM tracked_ig_accounts
               WHERE profile_pic_url != ''
                 AND profile_pic_url NOT LIKE ?""",
            (f"{_AVATAR_PUBLIC_PREFIX}%",),
        ).fetchone()["c"]
        remaining_empty = conn.execute(
            """SELECT COUNT(*) AS c FROM tracked_ig_accounts
               WHERE enabled = 1
                 AND (profile_pic_url IS NULL OR profile_pic_url = '')"""
        ).fetchone()["c"]
    return {
        "processed": len(candidates) + len(missing),
        "fetched_from_ig": fetched,
        "ok": ok,
        "failed": failed,
        "remaining": int(remaining_external) + int(remaining_empty),
    }


def existing_path(event_id: str) -> Optional[Path]:
    """Return the on-disk path for an event's rehosted image, if any.
    Skips the network call when re-scraping a known event."""
    for ext in _EXTS:
        candidate = IMAGES_DIR / f"{event_id}.{ext}"
        if candidate.exists() and candidate.stat().st_size > 0:
            return candidate
    return None


def save_user_upload(event_id: str, content: bytes, content_type: str) -> Optional[str]:
    """Persist a user-uploaded image for `event_id`. Same on-disk
    naming as catalog rehosts (`{event_id}.<ext>`) so the existing
    StaticFiles mount serves both. Validates content-type and size,
    returns the public URL on success or None on rejection.

    On success, also wipes any stale extension for the same event_id
    (e.g., user replaces a .jpg with a .png) so we don't leave
    orphaned files around."""
    if not event_id or not content:
        return None
    if len(content) > _MAX_BYTES:
        log.warning("upload: image too large for %s (%d bytes)", event_id, len(content))
        return None
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    ext = _CT_TO_EXT.get(ct)
    if not ext:
        log.info("upload: rejected content-type %r for %s", ct, event_id)
        return None
    # Wipe any older extension for this event so replace doesn't
    # leave stale .jpg behind when the new one is .png.
    for old_ext in _EXTS:
        old = IMAGES_DIR / f"{event_id}.{old_ext}"
        if old.exists() and old_ext != ext:
            try: old.unlink()
            except OSError: pass
    target = IMAGES_DIR / f"{event_id}.{ext}"
    try:
        target.write_bytes(content)
    except OSError as exc:
        log.warning("upload: write failed for %s: %s", event_id, exc)
        return None
    log.info("upload: saved %s (%d bytes, ct=%s)", target.name, len(content), ct)
    return public_url(target.name)


def delete_event_image(event_id: str) -> bool:
    """Remove any on-disk image file(s) for `event_id`. Returns True if
    at least one file was deleted. Used both by explicit DELETE and as
    a cascade when the event itself is removed."""
    deleted = False
    for ext in _EXTS:
        path = IMAGES_DIR / f"{event_id}.{ext}"
        if path.exists():
            try:
                path.unlink()
                deleted = True
            except OSError as exc:
                log.warning("delete-image: unlink failed for %s: %s", path.name, exc)
    return deleted


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
