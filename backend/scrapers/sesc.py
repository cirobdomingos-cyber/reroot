"""
SESC Paraná event scraper.

SESC (Serviço Social do Comércio) is a Brazilian institution that offers free
and low-cost cultural, sports, and wellness events at its units across Paraná.
Their Curitiba units — SESC Portão, SESC Batel, SESC Caiobá, etc. — are major
community hubs with programming that aligns closely with Reroot's mission of
low-pressure social re-entry.

Scraping strategy (in priority order):
1. WordPress REST API via The Events Calendar plugin — sescpr.com.br runs
   WordPress and exposes structured JSON at /wp-json/tribe/events/v1/events.
   This is the preferred path: clean fields, no parsing needed.

2. HTML fallback — if the REST endpoint returns an error or empty results,
   we scrape the /agenda/ page using Python's stdlib html.parser. SESC's
   WordPress theme wraps events in recognisable class patterns.

Portfolio signal: the two-strategy pattern (API-first, HTML-fallback) is the
production-grade approach for scraping institutions that run standard CMS
software. Knowing that WordPress + The Events Calendar exposes a REST API
is a practical trick that saves hours of DOM analysis on hundreds of Brazilian
cultural institution sites.
"""
import httpx
import logging
import re
import unicodedata
from datetime import datetime, timezone
from html.parser import HTMLParser
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://www.sescpr.com.br"
AGENDA_URL = f"{BASE_URL}/agenda/"
REST_API_URL = f"{BASE_URL}/wp-json/tribe/events/v1/events"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# PT-BR month names → month number
PTBR_MONTHS: dict[str, int] = {
    "janeiro": 1,
    "fevereiro": 2,
    "março": 3,
    "abril": 4,
    "maio": 5,
    "junho": 6,
    "julho": 7,
    "agosto": 8,
    "setembro": 9,
    "outubro": 10,
    "novembro": 11,
    "dezembro": 12,
}


# ─── Public entry point ───────────────────────────────────────────────────────

async def fetch_events(city: str = "Curitiba", days_ahead: int = 30) -> list[RawEvent]:
    """
    Fetch upcoming SESC PR events.

    Tries the WordPress REST API first (clean structured JSON). Falls back to
    scraping the /agenda/ HTML page if the API is unavailable or returns no
    events. Returns an empty list on total failure — never raises.
    """
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        # Strategy 1: WordPress REST API (The Events Calendar plugin)
        try:
            events = await _fetch_via_rest_api(client, today_str)
            if events:
                log.info(f"SESC: {len(events)} events via REST API")
                return events
            log.info("SESC REST API returned empty — trying HTML fallback")
        except Exception as e:
            log.warning(f"SESC REST API failed: {e} — trying HTML fallback")

        # Strategy 2: HTML scrape of /agenda/
        try:
            events = await _fetch_via_html(client)
            log.info(f"SESC: {len(events)} events via HTML fallback")
            return events
        except Exception as e:
            log.warning(f"SESC HTML fallback failed: {e}")

    log.warning("SESC: all strategies failed — returning empty list")
    return []


# ─── Strategy 1: REST API ─────────────────────────────────────────────────────

async def _fetch_via_rest_api(client: httpx.AsyncClient, start_date: str) -> list[RawEvent]:
    """
    Query The Events Calendar REST endpoint exposed by SESC PR's WordPress.

    The /wp-json/tribe/events/v1/events endpoint is part of the open-source
    The Events Calendar plugin, used by thousands of WordPress event sites.
    It supports ?per_page and ?start_date query params out of the box.
    """
    resp = await client.get(
        REST_API_URL,
        params={"per_page": 20, "start_date": start_date},
        headers={**HEADERS, "Accept": "application/json"},
    )

    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code}")

    data = resp.json()
    raw_events = data.get("events", [])
    if not isinstance(raw_events, list):
        raise ValueError("Unexpected JSON structure — 'events' key missing or not a list")

    results: list[RawEvent] = []
    for item in raw_events:
        parsed = _parse_rest_event(item)
        if parsed:
            results.append(parsed)

    return results


def _parse_rest_event(item: dict) -> RawEvent | None:
    """Convert a single The Events Calendar REST object to RawEvent."""
    try:
        title = _strip_html(item.get("title", {}).get("rendered", "") or "").strip()
        if not title:
            return None

        date_start = _parse_iso(item.get("start_date", ""))
        if not date_start:
            return None

        date_end = _parse_iso(item.get("end_date", "")) if item.get("end_date") else None

        venue: dict = item.get("venue", {}) or {}
        venue_name = venue.get("venue", "") or "SESC Paraná"
        venue_address_parts = [
            venue.get("address", ""),
            venue.get("city", ""),
            venue.get("stateprovince", ""),
        ]
        venue_address = ", ".join(p for p in venue_address_parts if p)

        # Cost field can be a string like "R$ 10,00" or "Gratuito"
        cost_raw = item.get("cost", "") or ""
        price_min, price_max = _parse_cost(cost_raw)

        description = _strip_html(
            item.get("description", {}).get("rendered", "") or ""
        )

        event_url = item.get("url", "") or ""
        slug = item.get("slug", "") or _slugify(title)
        external_id = f"sesc_{slug}" if slug else f"sesc_{_slugify(title)}"

        return RawEvent(
            source="sesc",
            external_id=external_id,
            name=title,
            description=description[:1000],
            venue_name=venue_name,
            venue_address=venue_address,
            neighborhood=None,
            city=venue.get("city", "Curitiba") or "Curitiba",
            date_start=date_start,
            date_end=date_end,
            price_min=price_min,
            price_max=price_max,
            currency="BRL",
            capacity=None,
            attendees_confirmed=None,
            url=event_url,
            image_url=_extract_image(item),
        )
    except Exception as e:
        log.warning(f"SESC REST parse error for '{item.get('slug', '?')}': {e}")
        return None


def _extract_image(item: dict) -> str | None:
    """Pull the first image URL from the REST event object."""
    # The Events Calendar embeds images under 'image' dict
    image = item.get("image") or {}
    if isinstance(image, dict):
        return image.get("url") or image.get("src") or None
    return None


# ─── Strategy 2: HTML scrape ──────────────────────────────────────────────────

async def _fetch_via_html(client: httpx.AsyncClient) -> list[RawEvent]:
    """
    Scrape the SESC /agenda/ page using Python stdlib html.parser.

    SESC PR's WordPress theme renders event cards as <article> elements with
    class patterns from The Events Calendar plugin (tribe-events-*). We collect
    title, date, and venue by walking the parse tree via a lightweight custom
    HTMLParser subclass.

    Note: stdlib html.parser is a streaming SAX-style parser. We accumulate
    tag state into a list of event dicts, then convert to RawEvent.
    """
    resp = await client.get(AGENDA_URL, headers=HEADERS)
    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code} from {AGENDA_URL}")

    parser = _SESCAgendaParser()
    parser.feed(resp.text)
    raw = parser.get_events()

    today = datetime.now(timezone.utc)
    results: list[RawEvent] = []

    for ev in raw:
        title = ev.get("title", "").strip()
        if not title:
            continue

        date_start = _parse_ptbr_date(ev.get("date", ""))
        if not date_start or date_start < today:
            continue

        venue_name = ev.get("venue", "SESC Paraná").strip() or "SESC Paraná"
        url = ev.get("url", "") or ""
        slug = url.rstrip("/").split("/")[-1] if url else _slugify(title)
        external_id = f"sesc_html_{slug}" if slug else f"sesc_html_{_slugify(title)}"

        results.append(RawEvent(
            source="sesc",
            external_id=external_id,
            name=title,
            description=ev.get("description", "").strip()[:1000],
            venue_name=venue_name,
            venue_address=ev.get("address", ""),
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
            image_url=ev.get("image_url"),
        ))

    return results


class _SESCAgendaParser(HTMLParser):
    """
    Lightweight SAX-style parser for the SESC /agenda/ WordPress page.

    Tracks open/close tag context to collect event card data without any
    third-party dependency. Handles The Events Calendar's tribe-events-* CSS
    class conventions as well as generic WordPress title/date patterns.
    """

    def __init__(self) -> None:
        super().__init__()
        self._events: list[dict] = []
        self._current: dict | None = None
        self._capture: str | None = None  # which field we're collecting text for
        self._depth: int = 0              # nesting depth inside article/event card
        self._article_depth: int = 0

    # ── HTMLParser hooks ──────────────────────────────────────────────────────

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = {k: (v or "") for k, v in attrs}
        classes = attr_dict.get("class", "")
        href = attr_dict.get("href", "")

        # Detect start of an event card
        if tag in ("article", "div") and self._is_event_container(classes):
            if self._current is None:
                self._current = {}
                self._article_depth = self._depth
            self._depth += 1
            return

        if self._current is not None:
            self._depth += 1

            # Title: h2/h3 with title-ish class, or a-tag inside them
            if tag in ("h2", "h3") and self._has_any(classes, ("title", "entry-title", "tribe-event")):
                self._capture = "title"
            elif tag == "a" and self._capture == "title" and href:
                self._current.setdefault("url", href)

            # Date containers
            elif self._has_any(classes, ("date", "tribe-event-date", "tribe-events-schedule", "data")):
                self._capture = "date"

            # Venue/location
            elif self._has_any(classes, ("venue", "location", "tribe-venue", "local")):
                self._capture = "venue"

            # Image
            elif tag == "img" and "src" in attr_dict:
                self._current.setdefault("image_url", attr_dict["src"])

            # Anchor: capture URL if inside card and no URL yet
            elif tag == "a" and href and href.startswith("http") and "url" not in self._current:
                self._current["url"] = href

    def handle_endtag(self, tag: str) -> None:
        if self._current is None:
            return

        self._depth -= 1

        # Stop capturing field text on any closing tag
        if self._capture:
            self._capture = None

        # End of event card — save and reset
        if self._depth <= self._article_depth and tag in ("article", "div"):
            if self._current.get("title"):
                self._events.append(self._current)
            self._current = None
            self._article_depth = 0

    def handle_data(self, data: str) -> None:
        if self._current is None or not self._capture:
            return
        field = self._capture
        existing = self._current.get(field, "")
        self._current[field] = (existing + " " + data).strip()

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _is_event_container(classes: str) -> bool:
        triggers = ("tribe-event", "event-card", "evento", "events-list-item")
        return any(t in classes for t in triggers)

    @staticmethod
    def _has_any(classes: str, needles: tuple[str, ...]) -> bool:
        return any(n in classes for n in needles)

    def get_events(self) -> list[dict]:
        return list(self._events)


# ─── Date parsing ─────────────────────────────────────────────────────────────

def _parse_iso(dt_str: str | None) -> datetime | None:
    """Parse ISO 8601 date strings, coercing to UTC if no tzinfo present."""
    if not dt_str:
        return None
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        log.warning(f"SESC: could not parse ISO datetime '{dt_str}'")
        return None


def _parse_ptbr_date(raw: str) -> datetime | None:
    """
    Parse Portuguese date strings like '10 de abril de 2025' or '10/04/2025'.

    SESC pages mix formats depending on the WordPress theme and plugin version.
    We try the most common patterns before giving up.
    """
    raw = raw.strip().lower()
    if not raw:
        return None

    # Pattern: "10 de abril de 2025" or "10 de abril"
    m = re.search(r"(\d{1,2})\s+de\s+(\w+)(?:\s+de\s+(\d{4}))?", raw)
    if m:
        day = int(m.group(1))
        month_name = m.group(2).strip()
        year_str = m.group(3)
        month = PTBR_MONTHS.get(month_name)
        if month:
            year = int(year_str) if year_str else datetime.now(timezone.utc).year
            try:
                return datetime(year, month, day, 0, 0, 0, tzinfo=timezone.utc)
            except ValueError:
                pass

    # Pattern: "10/04/2025"
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
    if m:
        try:
            return datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)), 0, 0, 0, tzinfo=timezone.utc)
        except ValueError:
            pass

    # Pattern: "2025-04-10" (ISO-ish)
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 0, 0, 0, tzinfo=timezone.utc)
        except ValueError:
            pass

    log.warning(f"SESC: could not parse PT-BR date '{raw}'")
    return None


# ─── Price parsing ────────────────────────────────────────────────────────────

def _parse_cost(raw: str) -> tuple[float, float]:
    """
    Extract a numeric price range from SESC cost strings.

    Examples: "Gratuito", "R$ 10,00", "R$ 5,00 a R$ 15,00", "Free".
    SESC events are almost always free — default to (0, 0) on parse failure.
    """
    if not raw:
        return 0.0, 0.0

    lower = raw.lower()
    if any(w in lower for w in ("gratu", "free", "r$ 0", "r$0")):
        return 0.0, 0.0

    # Extract all decimal numbers from string
    amounts = re.findall(r"\d+[.,]\d{2}", raw)
    if not amounts:
        # Try integer amounts
        amounts = re.findall(r"\d+", raw)

    if not amounts:
        return 0.0, 0.0

    prices = []
    for a in amounts:
        try:
            prices.append(float(a.replace(",", ".")))
        except ValueError:
            continue

    if not prices:
        return 0.0, 0.0

    return min(prices), max(prices)


# ─── Utilities ────────────────────────────────────────────────────────────────

def _strip_html(text: str) -> str:
    """Remove HTML tags and normalize whitespace."""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&[a-z]+;", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _slugify(text: str) -> str:
    """Convert a string to a URL-safe slug for use as external_id."""
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)[:60]
