"""
Quiet hours for broadcast pushes.

The daily digest ("✨ 12 novos em CWB") normally fires right after the 14:00
refresh, but a refresh can also run at night — the boot refresh after a
Railway deploy, or a manual trigger — and then the whole user base got
buzzed at 23:40 for something that can wait until morning.

Rule: between 22:00 and 09:00 (America/Sao_Paulo) the digest is not sent.
Its event ids are parked in `deferred_digest_events` and a 09:00 job sends
them as one digest. Parking lives in SQLite, not in an in-memory APScheduler
job, so a redeploy during the night doesn't silently drop the digest.

Only the digest is gated. Personal pushes (an invite, a friend request, a
host changing the date) are answers to something a person just did, so
they still go out immediately.
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
QUIET_START_HOUR = 22  # inclusive
QUIET_END_HOUR = 9     # exclusive — 09:00 is when parked digests go out


def is_quiet(now: datetime | None = None) -> bool:
    """True when `now` falls inside the quiet window in Curitiba time.
    A naive datetime is read as UTC (what the server clock runs on)."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    hour = now.astimezone(TZ).hour
    return hour >= QUIET_START_HOUR or hour < QUIET_END_HOUR
