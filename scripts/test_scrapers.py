"""Smoke-test every scraper end-to-end against real APIs.

Goal: figure out which scrapers in backend/scrapers/ actually return events
after the `feature/fix-scrapers` rewrite. Reads tokens from backend/.env.

Run from repo root:
    py -3.12 scripts/test_scrapers.py
"""
import asyncio
import os
import sys
import traceback
from pathlib import Path

# Make the backend dir importable so `from models import RawEvent` resolves
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

# Load .env manually (no python-dotenv dependency)
env_path = ROOT / "backend" / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

from scrapers import sympla, eventbrite, meetup, sesc, prefeitura  # noqa: E402


CITY = os.environ.get("CITY", "Curitiba")
DAYS = 30


async def run_one(name: str, coro):
    print(f"\n── {name} " + "─" * (60 - len(name)))
    try:
        events = await asyncio.wait_for(coro, timeout=120)
    except asyncio.TimeoutError:
        print(f"  TIMEOUT after 120s")
        return name, 0, "timeout"
    except Exception as e:
        print(f"  ERROR: {type(e).__name__}: {e}")
        traceback.print_exc(limit=3)
        return name, 0, f"error: {type(e).__name__}"

    print(f"  events returned: {len(events)}")
    for ev in events[:3]:
        when = ev.date_start.strftime("%Y-%m-%d %H:%M") if ev.date_start else "?"
        print(f"    • [{when}] {ev.name[:60]} @ {ev.venue_name[:30]}")
    if len(events) > 3:
        print(f"    ... +{len(events) - 3} more")
    return name, len(events), "ok"


async def main():
    sympla_token = os.environ.get("SYMPLA_TOKEN", "")
    eb_token = os.environ.get("EVENTBRITE_TOKEN", "")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")

    print(f"city={CITY}  days_ahead={DAYS}")
    print(f"sympla_token={'set' if sympla_token else 'MISSING'}  "
          f"eventbrite_token={'set' if eb_token else 'MISSING'}  "
          f"anthropic_key={'set' if anthropic_key else 'MISSING'}")

    results = []
    results.append(await run_one("sympla", sympla.fetch_events(token=sympla_token, city=CITY, days_ahead=DAYS)))
    results.append(await run_one("eventbrite", eventbrite.fetch_events(token=eb_token, city=CITY, days_ahead=DAYS)))
    results.append(await run_one("meetup", meetup.fetch_events(city=CITY, days_ahead=DAYS)))
    results.append(await run_one("sesc", sesc.fetch_events(city=CITY, anthropic_api_key=anthropic_key, days_ahead=DAYS)))
    results.append(await run_one("prefeitura", prefeitura.fetch_events(city=CITY, days_ahead=DAYS)))

    print("\n── summary " + "─" * 56)
    for name, count, status in results:
        flag = "✓" if count > 0 else ("·" if status == "ok" else "✗")
        print(f"  {flag} {name:12s} {count:3d} events  ({status})")


if __name__ == "__main__":
    # Force utf-8 stdout on Windows so emojis in event names print without crashing
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    asyncio.run(main())
