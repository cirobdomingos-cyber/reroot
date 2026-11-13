"""
How often each tracked Instagram handle is probed.

Grain: one decision per handle per daily refresh.

Apify bills per result, and the probe reads 4 posts per handle. A venue
that has produced no event for weeks costs the same as one that posts
every night, so quiet handles are checked less often:

    quiet_runs < 7   -> every day
    7 <= quiet_runs < 14 -> every 3 days
    quiet_runs >= 14 -> every 7 days

`quiet_runs` counts consecutive probes of a handle that produced no event.
A new event resets it to 0, so a venue that wakes up is back on a daily
check at its next probe.

Never slowed down:
  - category `bloco` until BLOCO_DAILY_UNTIL (Carnaval; featured season
    ends 2027-02-17, set by Ciro on production),
  - handles flagged `featured` (paid placement),
  - handles never probed (new handles start daily).
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

BLOCO_DAILY_UNTIL = date(2027, 2, 17)

QUIET_RUNS_EVERY_3_DAYS = 7
QUIET_RUNS_EVERY_7_DAYS = 14

# A refresh that starts a little early must not skip a handle that is
# "due tomorrow": the cron fires at the same minute daily, jitter is small.
_DUE_SLACK = timedelta(hours=2)


def interval_days(account: dict, today: Optional[date] = None) -> int:
    """Days between probes for this handle (1 = every daily refresh)."""
    today = today or datetime.now(timezone.utc).date()
    category = (account.get("category") or "").strip().lower()
    if category == "bloco" and today <= BLOCO_DAILY_UNTIL:
        return 1
    if account.get("featured"):
        return 1
    quiet = int(account.get("quiet_runs") or 0)
    if quiet >= QUIET_RUNS_EVERY_7_DAYS:
        return 7
    if quiet >= QUIET_RUNS_EVERY_3_DAYS:
        return 3
    return 1


def is_due(account: dict, now: Optional[datetime] = None) -> bool:
    """True when the handle should be probed in this refresh."""
    now = now or datetime.now(timezone.utc)
    days = interval_days(account, now.date())
    if days == 1:
        return True
    raw = account.get("last_probed_at")
    if not raw:
        return True
    try:
        last = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return now - last >= timedelta(days=days) - _DUE_SLACK
