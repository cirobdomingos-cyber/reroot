"""Acquisition funnel for auê, one row per day: /install visits -> onboarding
-> sign-in -> channel follow -> first RSVP, split by platform.

Reads the public, counts-only GET /analytics/funnel/daily. Instagram's side
(reach, bio-link taps) and the stores' installs live in their own consoles;
this is the part only our backend sees.

    python scripts/funnel_report.py                 # last 14 days, production
    python scripts/funnel_report.py --days 7 --src ig_canais
    python scripts/funnel_report.py --api https://<staging host>
"""
import argparse
import json
import sys
import urllib.request
from collections import defaultdict

STEP_LABELS = {
    "install_visit": "/install",
    "onboarding_started": "onboard",
    "onboarding_signed_in": "login",
    "channel_followed": "follow",
    "first_rsvp": "rsvp",
}
PLATFORMS = ("ios", "android", "desktop")


def fetch(api: str, days: int) -> dict:
    with urllib.request.urlopen(f"{api.rstrip('/')}/analytics/funnel/daily?days={days}", timeout=20) as res:
        return json.load(res)


def table(data: dict, src: str = "") -> list[list[str]]:
    """Rows [day, then per step 'total (ios/android/desktop)']. A --src filter
    keeps install visits from that link only; the app steps carry no src."""
    cells = defaultdict(lambda: defaultdict(int))
    for r in data["rows"]:
        if src and r["step"] == "install_visit" and r["src"] != src:
            continue
        cells[(r["day"], r["step"])][r["platform"] or "?"] += r["n"]
    days = sorted({d for d, _ in cells})
    out = [["day", *(STEP_LABELS.get(s, s) for s in data["steps"])]]
    for d in days:
        row = [d]
        for s in data["steps"]:
            c = cells.get((d, s), {})
            total = sum(c.values())
            split = "/".join(str(c.get(p, 0)) for p in PLATFORMS)
            row.append(f"{total} ({split})" if total else "-")
        out.append(row)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--api", default="https://auecuritiba.com")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--src", default="", help="only /install visits with this ?src= tag")
    args = ap.parse_args(argv)
    data = fetch(args.api, args.days)
    rows = table(data, args.src)
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    for r in rows:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))
    print("\ncells: total (ios/android/desktop)" + (f"; /install filtered to src={args.src}" if args.src else ""))
    in_app = sum(r["n"] for r in data["rows"]
                 if r["step"] == "install_visit" and r["client"] == "in_app")
    print(f"/install visits from inside Instagram/WhatsApp/TikTok: {in_app}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
