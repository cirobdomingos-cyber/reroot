"""
MON (Museu Oscar Niemeyer) exhibition scraper.

The MON site is a Next.js app served from Prismic CMS. Each exhibition page
embeds a `__NEXT_DATA__` JSON blob with structured fields: title, startDate,
endDate, description, localization. We:

1. Fetch the home page and extract `/exposicoes/<slug>` links (excluding
   `/eventos/salas/...` which are venue/room pages, not exhibitions).
2. For each slug, fetch the exhibition page and parse `__NEXT_DATA__`.
3. Filter to currently-running exhibitions (startDate <= today <= endDate).
4. Emit a RawEvent so the rest of the pipeline (enrichment, dedup, region
   filter) can decide whether it's a good Reroot fit.

Why exhibitions are great for Reroot: they're long-running, low-pressure,
go-when-you-want experiences. A perfect first solo outing.
"""
import html
import json
import logging
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://www.museuoscarniemeyer.org.br"
HOME_URL = BASE_URL + "/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
}

_NEXT_DATA_RE = re.compile(
    r'__NEXT_DATA__[^>]*>(.+?)</script>', re.DOTALL,
)
_EXPO_HREF_RE = re.compile(r'href="(/exposicoes/[^"/]+)"')


async def fetch_events(city: str = "Curitiba", days_ahead: int = 90) -> list[RawEvent]:
    """
    Pull current MON exhibitions. Returns empty list on total failure — never raises.
    days_ahead is unused (exhibitions span months) but kept for API compatibility.
    """
    if city.strip().lower() != "curitiba":
        # MON is a Curitiba-only museum
        return []

    today = datetime.now(timezone.utc)

    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        try:
            slugs = await _list_exhibition_slugs(client)
        except Exception as e:
            log.warning(f"MON home page failed: {e}")
            return []

        log.info(f"MON: found {len(slugs)} candidate exhibition slugs")
        events: list[RawEvent] = []
        for slug in slugs:
            try:
                ev = await _fetch_exhibition(client, slug, today)
                if ev:
                    events.append(ev)
            except Exception as e:
                log.warning(f"MON exhibition {slug} failed: {e}")

    log.info(f"MON: {len(events)} current exhibitions extracted")
    return events


async def _list_exhibition_slugs(client: httpx.AsyncClient) -> list[str]:
    resp = await client.get(HOME_URL, headers=HEADERS)
    resp.raise_for_status()
    seen: set[str] = set()
    slugs: list[str] = []
    for m in _EXPO_HREF_RE.finditer(resp.text):
        path = m.group(1)
        if path in seen:
            continue
        seen.add(path)
        slugs.append(path.rsplit("/", 1)[-1])
    return slugs


async def _fetch_exhibition(
    client: httpx.AsyncClient,
    slug: str,
    today: datetime,
) -> Optional[RawEvent]:
    url = f"{BASE_URL}/exposicoes/{slug}"
    resp = await client.get(url, headers=HEADERS)
    if resp.status_code != 200:
        return None

    m = _NEXT_DATA_RE.search(resp.text)
    if not m:
        return None
    try:
        data = json.loads(html.unescape(m.group(1)))
    except json.JSONDecodeError:
        return None

    page = (
        data.get("props", {})
            .get("pageProps", {})
            .get("data", {})
    )
    if not page:
        return None

    start = _parse_iso(page.get("startDate") or page.get("dataAbertura"))
    end = _parse_iso(page.get("endDate"))

    if not start:
        return None
    # An exhibition is "current" if it has started and not ended yet.
    # If it's a future opening, also include it (the date filter at API time
    # will surface it once the start date is reached).
    if end and end < today:
        return None

    title = _rich_text(page.get("title"))
    if not title:
        return None
    subtitle = _rich_text(page.get("subTitle"))
    description = _rich_text(page.get("description")) or _rich_text(page.get("longDescription"))
    name = f"{title}: {subtitle}" if subtitle and subtitle.lower() not in title.lower() else title

    image_url = (page.get("headerImage") or {}).get("url") or None
    sala = _rich_text(page.get("localization"))
    venue_name = "Museu Oscar Niemeyer" + (f" — {sala}" if sala else "")

    return RawEvent(
        source="mon",
        external_id=f"mon_{slug}",
        name=name[:200],
        description=(description or "")[:1000],
        venue_name=venue_name[:200],
        venue_address="R. Marechal Hermes, 999",  # MON's actual address
        neighborhood="Centro Cívico",
        city="Curitiba",
        date_start=start,
        date_end=end,
        price_min=0.0,   # MON has paid admission but enrichment can adjust
        price_max=0.0,
        currency="BRL",
        capacity=None,
        attendees_confirmed=None,
        url=url,
        image_url=image_url,
    )


def _rich_text(rt) -> str:
    """Flatten a Prismic rich-text array to plain text."""
    if not rt:
        return ""
    if isinstance(rt, str):
        return rt.strip()
    if isinstance(rt, list):
        parts = []
        for node in rt:
            if isinstance(node, dict) and "text" in node:
                parts.append(node["text"])
        return " ".join(p for p in parts if p).strip()
    return ""


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    # Prismic dates: "2025-11-29T13:00:00+0000"
    s = s.strip()
    # Make sure timezone offset has a colon so fromisoformat is happy on 3.10
    if re.search(r"[+-]\d{4}$", s):
        s = s[:-2] + ":" + s[-2:]
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
