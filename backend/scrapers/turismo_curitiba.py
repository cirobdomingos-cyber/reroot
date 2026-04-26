"""
Turismo Curitiba scraper — the city's official tourism portal.

The /eventos/ index page is server-rendered ASP.NET WebForms. Each event
appears in a `<div class="itemEventoConteudo">` block with day + month +
category + title link. Sample structure:

    <div class="itemEventoConteudo">
      <span class="dataEvento dataEventoMenor">25</span>
      <span class="dataEvento dataEventoMenor">04</span>
      <span class="categoria">Lazer</span>
      <h4>
        <a id="..." href="/evento/shen-yun/3942">Shen Yun</a>
      </h4>
    </div>

We don't need to fetch each individual event page — the index has everything
useful (day, month, category, title, URL). Year is inferred (current; bump to
next year if the resulting date is in the past).

This portal aggregates a lot of city-curated events: feiras, shows, festivais,
cultural happenings. Mix is broader than SESC / MON — quality varies, so the
existing Reroot-fit filters in main.py do the heavy lifting downstream.
"""
import logging
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin

import httpx
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://turismo.curitiba.pr.gov.br"
EVENTS_URL = f"{BASE_URL}/eventos/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
}


async def fetch_events(city: str = "Curitiba", days_ahead: int = 90) -> list[RawEvent]:
    """Fetch upcoming events from Turismo Curitiba. Never raises."""
    if city.strip().lower() != "curitiba":
        return []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        try:
            resp = await client.get(EVENTS_URL, headers=HEADERS)
            resp.raise_for_status()
        except Exception as e:
            log.warning(f"Turismo Curitiba index failed: {e}")
            return []

        parser = _IndexParser()
        parser.feed(resp.text)
        items = parser.get_events()

    today = datetime.now(timezone.utc)
    today_start = today.replace(hour=0, minute=0, second=0, microsecond=0)
    events: list[RawEvent] = []

    for item in items:
        title = item.get("title", "").strip()
        href = item.get("href", "").strip()
        day_str = item.get("day", "").strip()
        month_str = item.get("month", "").strip()
        category = item.get("category", "").strip()
        if not title or not href or not day_str or not month_str:
            continue

        date_start = _build_date(day_str, month_str, today)
        if not date_start or date_start < today_start:
            continue

        ext_id = href.rstrip("/").split("/")[-1] or _slug(title)
        url = urljoin(BASE_URL, href)

        # The index page doesn't expose a venue, but every event on this portal
        # is in Curitiba by definition (it's the city tourism site). Use a
        # category-driven placeholder so the API region filter (which drops
        # empty-venue events as virtual placeholders) doesn't reject them.
        venue_placeholder = f"Curitiba — {category}" if category else "Curitiba"

        events.append(RawEvent(
            source="turismo_curitiba",
            external_id=f"turismocwb_{ext_id}",
            name=title[:200],
            description=(f"Categoria: {category}" if category else "")[:1000],
            venue_name=venue_placeholder,
            venue_address="Curitiba",
            neighborhood=None,
            city="Curitiba",
            date_start=date_start,
            date_end=None,
            price_min=0.0,
            price_max=0.0,
            currency="BRL",
            capacity=None,
            attendees_confirmed=None,
            url=url,
            image_url=None,
        ))

    log.info(f"Turismo Curitiba: {len(events)} upcoming events")
    return events


class _IndexParser(HTMLParser):
    """
    SAX-style parser for the Turismo Curitiba /eventos/ index.

    State machine:
      - On <div class="itemEventoConteudo">: open a new event dict
      - Inside, capture <span class="dataEvento">: first → day, second → month
      - Inside, capture <span class="categoria">
      - Inside, capture <a href="/evento/...">: href + link text
    """

    def __init__(self) -> None:
        super().__init__()
        self._events: list[dict] = []
        self._cur: dict | None = None
        self._cur_depth: int = 0
        self._depth: int = 0
        self._capture: str | None = None
        self._date_part_count: int = 0

    def handle_starttag(self, tag: str, attrs):
        attr_dict = {k: (v or "") for k, v in attrs}
        classes = attr_dict.get("class", "")

        if tag == "div" and "itemEventoConteudo" in classes:
            self._cur = {"day": "", "month": "", "title": "", "href": "", "category": ""}
            self._cur_depth = self._depth
            self._date_part_count = 0
            self._depth += 1
            return

        if self._cur is not None:
            self._depth += 1
            if tag == "span" and "dataEvento" in classes:
                # First dataEvento span is day, second is month
                self._capture = "day" if self._date_part_count == 0 else "month"
                self._date_part_count += 1
            elif tag == "span" and "categoria" in classes:
                self._capture = "category"
            elif tag == "a" and attr_dict.get("href", "").startswith("/evento/"):
                self._cur["href"] = attr_dict["href"]
                self._capture = "title"

    def handle_endtag(self, tag: str):
        if self._cur is None:
            return
        self._depth -= 1
        if self._capture and tag in ("span", "a"):
            self._capture = None
        if tag == "div" and self._depth <= self._cur_depth:
            if self._cur.get("title") and self._cur.get("href"):
                self._events.append(self._cur)
            self._cur = None
            self._cur_depth = 0
            self._date_part_count = 0

    def handle_data(self, data: str):
        if self._cur is None or not self._capture:
            return
        text = data.strip()
        if not text:
            return
        existing = self._cur.get(self._capture, "")
        self._cur[self._capture] = (existing + " " + text).strip() if existing else text

    def get_events(self) -> list[dict]:
        return list(self._events)


def _build_date(day_str: str, month_str: str, today: datetime) -> datetime | None:
    try:
        day = int(day_str)
        month = int(month_str)
    except ValueError:
        return None
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return None
    year = today.year
    try:
        dt = datetime(year, month, day, 0, 0, 0, tzinfo=timezone.utc)
    except ValueError:
        return None
    # If the date already passed this year, assume it's next year (rolling calendar)
    if dt < today.replace(hour=0, minute=0, second=0, microsecond=0):
        try:
            dt = datetime(year + 1, month, day, 0, 0, 0, tzinfo=timezone.utc)
        except ValueError:
            return None
    return dt


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]
