"""
Teatro Guaíra scraper — Curitiba's main cultural center.

The original Prefeitura de Curitiba open-data endpoints are no longer live
(404/403 as of 2026-04). This scraper now targets the Centro Cultural Teatro
Guaíra (teatroguaira.pr.gov.br), which hosts concerts, ballet, theatre, and
orchestral performances — high-quality cultural events that align with Reroot.

Scraping strategy:
1. Calendar page — /calendario-eventos shows the full event listing.
2. Home page fallback — the homepage renders a shorter event grid if the
   calendar page returns an unexpected response.

The Teatro Guaíra site uses clean, semantic HTML with predictable class names:
- Event cards are <article> elements containing an <a href="/Evento/...">
- Date: <span class="data-evento">08 ABR</span>
- Title: <h3>EVENT TITLE</h3>
- Details (start, end, venue): <p><strong>Início:</strong> 08/04/2026 ...</p>

Portfolio signal: replacing a dead government data source with a more reliable
scrape target rather than silently returning zero events shows production
mindset — a pipeline should degrade gracefully but also recover when possible.
"""
import logging
import re
import unicodedata
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin

import httpx
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://www.teatroguaira.pr.gov.br"
CALENDAR_URL = f"{BASE_URL}/calendario-eventos"
HOME_URL = f"{BASE_URL}/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept": "text/html,application/xhtml+xml,*/*",
}

_PTBR_MONTHS: dict[str, int] = {
    "jan": 1, "fev": 2, "mar": 3, "abr": 4,
    "mai": 5, "jun": 6, "jul": 7, "ago": 8,
    "set": 9, "out": 10, "nov": 11, "dez": 12,
}


# ─── Public entry point ───────────────────────────────────────────────────────

async def fetch_events(city: str = "Curitiba", days_ahead: int = 60) -> list[RawEvent]:
    """
    Fetch upcoming Teatro Guaíra events.

    Tries the calendar page first (more events), then falls back to the
    homepage grid. Returns empty list on total failure — never raises.
    """
    today = datetime.now(timezone.utc)

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for url, label in [(CALENDAR_URL, "calendar"), (HOME_URL, "home")]:
            try:
                events = await _scrape_page(client, url, today)
                if events:
                    log.info(f"Teatro Guaíra: {len(events)} events via {label} page")
                    return events
                log.info(f"Teatro Guaíra: {label} page returned no events — trying next")
            except Exception as e:
                log.warning(f"Teatro Guaíra {label} page failed: {e}")

    log.warning("Teatro Guaíra: all strategies failed — returning empty list")
    return []


# ─── Scraper ─────────────────────────────────────────────────────────────────

async def _scrape_page(
    client: httpx.AsyncClient,
    url: str,
    today: datetime,
) -> list[RawEvent]:
    resp = await client.get(url, headers=HEADERS)
    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code} from {url}")

    parser = _GuairaParser()
    parser.feed(resp.text)
    raw = parser.get_events()

    results: list[RawEvent] = []
    for ev in raw:
        title = ev.get("title", "").strip()
        if not title:
            continue

        # Prefer the full DD/MM/YYYY date from <p> over the short "08 ABR" date
        date_start = (
            _parse_full_date(ev.get("date_full", ""))
            or _parse_short_date(ev.get("date_short", ""))
        )
        if not date_start:
            continue
        if date_start < today:
            continue

        date_end = _parse_full_date(ev.get("date_end_full", ""))

        href = ev.get("href", "")
        event_url = urljoin(BASE_URL, href) if href else url
        slug = href.rstrip("/").split("/")[-1] if href else _slugify(title)
        external_id = f"guaira_{slug}" if slug else f"guaira_{_slugify(title)}"

        venue_name = ev.get("venue", "").strip() or "Teatro Guaíra"
        venue_address = ev.get("address", "").strip()

        results.append(RawEvent(
            source="teatro_guaira",
            external_id=external_id,
            name=title,
            description="",
            venue_name=venue_name,
            venue_address=venue_address,
            neighborhood=None,
            city="Curitiba",
            date_start=date_start,
            date_end=date_end,
            price_min=0.0,
            price_max=0.0,
            currency="BRL",
            capacity=None,
            attendees_confirmed=None,
            url=event_url,
            image_url=ev.get("image_url"),
        ))

    return results


class _GuairaParser(HTMLParser):
    """
    SAX-style parser for Teatro Guaíra event cards.

    Card structure (from live HTML inspection):
      <article>
        <a href="/Evento/slug">
          <span class="data-evento">08 ABR</span>
          <h3>TITLE</h3>
          <p>
            <strong>Início:</strong> 08/04/2026<br>
            <strong>Término:</strong> 09/04/2026<br>
            <strong>Local:</strong> Venue name, address
          </p>
          <span class="saiba-mais">Saiba mais ›></span>
        </a>
      </article>
    """

    def __init__(self) -> None:
        super().__init__()
        self._events: list[dict] = []
        self._current: dict | None = None
        self._capture: str | None = None
        self._in_strong: bool = False
        self._strong_text: str = ""
        self._detail_key: str | None = None  # which detail field is next
        self._depth: int = 0
        self._article_depth: int = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = {k: (v or "") for k, v in attrs}
        classes = attr_dict.get("class", "")

        if tag == "article":
            if self._current is None:
                self._current = {}
                self._article_depth = self._depth
            self._depth += 1
            return

        if self._current is not None:
            self._depth += 1

            if tag == "a" and attr_dict.get("href", "").startswith("/Evento/"):
                self._current.setdefault("href", attr_dict["href"])

            elif tag == "span" and "data-evento" in classes:
                self._capture = "date_short"

            elif tag == "h3":
                self._capture = "title"

            elif tag == "p" and not self._capture:
                self._capture = "details"

            elif tag == "strong" and self._capture == "details":
                self._in_strong = True
                self._strong_text = ""

            elif tag == "img" and attr_dict.get("src"):
                self._current.setdefault("image_url", attr_dict["src"])

    def handle_endtag(self, tag: str) -> None:
        if self._current is None:
            return

        self._depth -= 1

        if tag == "strong" and self._in_strong:
            self._in_strong = False
            label = self._strong_text.strip().lower().rstrip(":")
            if "início" in label or "inicio" in label:
                self._detail_key = "date_full"
            elif "término" in label or "termino" in label:
                self._detail_key = "date_end_full"
            elif "local" in label:
                self._detail_key = "venue_raw"
            else:
                self._detail_key = None

        elif tag in ("span", "h3") and self._capture in ("date_short", "title"):
            self._capture = None

        elif tag == "p" and self._capture == "details":
            self._capture = None
            self._detail_key = None

        elif tag == "article" and self._depth <= self._article_depth:
            if self._current.get("title"):
                # Parse venue/address from venue_raw: "Name, address, city"
                venue_raw = self._current.pop("venue_raw", "")
                parts = [p.strip() for p in venue_raw.split(",") if p.strip()]
                if parts:
                    self._current["venue"] = parts[0]
                    if len(parts) > 1:
                        self._current["address"] = ", ".join(parts[1:])
                self._events.append(self._current)
            self._current = None
            self._article_depth = 0

    def handle_data(self, data: str) -> None:
        if self._current is None:
            return
        text = data.strip()
        if not text:
            return

        if self._in_strong:
            self._strong_text += text
            return

        if self._capture in ("date_short", "title"):
            field = self._capture
            self._current[field] = (self._current.get(field, "") + " " + text).strip()

        elif self._capture == "details" and self._detail_key:
            # First non-empty text after a <strong> label is the value
            if self._detail_key not in self._current:
                self._current[self._detail_key] = text
            self._detail_key = None  # consume only first text node per label

    def get_events(self) -> list[dict]:
        return list(self._events)


# ─── Date parsing ─────────────────────────────────────────────────────────────

def _parse_full_date(raw: str) -> datetime | None:
    """Parse 'DD/MM/YYYY' or 'DD/MM/YYYY HH:MM' date strings."""
    if not raw:
        return None
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?", raw)
    if m:
        try:
            day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
            hour = int(m.group(4)) if m.group(4) else 0
            minute = int(m.group(5)) if m.group(5) else 0
            return datetime(year, month, day, hour, minute, 0, tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def _parse_short_date(raw: str) -> datetime | None:
    """
    Parse 'DD ABR' (day + 3-letter PT-BR month abbreviation) date strings.

    Year is inferred: if the resulting date is in the past, assume next year.
    """
    if not raw:
        return None
    m = re.match(r"(\d{1,2})\s+([A-Za-zÀ-ú]{3})", raw.strip())
    if not m:
        return None
    try:
        day = int(m.group(1))
        month_abbr = m.group(2).lower()[:3]
        month = _PTBR_MONTHS.get(month_abbr)
        if not month:
            return None
        now = datetime.now(timezone.utc)
        year = now.year
        dt = datetime(year, month, day, 0, 0, 0, tzinfo=timezone.utc)
        # If the date is in the past, try next year
        if dt < now:
            dt = datetime(year + 1, month, day, 0, 0, 0, tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


# ─── Utilities ────────────────────────────────────────────────────────────────

def _slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)[:60]
