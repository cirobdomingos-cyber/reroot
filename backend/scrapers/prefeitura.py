"""
Prefeitura de Curitiba cultural agenda scraper.

The Prefeitura (city government) of Curitiba publishes its cultural agenda
through two channels:
1. An open data JSON API — Curitiba is one of Brazil's most advanced cities
   for open data and publishes machine-readable event feeds.
2. A public-facing HTML agenda page — fallback when the API is unavailable.

Events from this source are typically free or very low cost (municipal
programming: theatre, concerts, exhibitions, fairs). They align strongly with
Reroot's mission of accessible, low-pressure social re-entry.

Scraping strategy (in priority order):
1. Open data JSON — try two known endpoint URLs. Parse the array of objects
   using known field names (Titulo, DataInicio, Local, etc.).

2. HTML fallback — scrape the agenda page using stdlib html.parser. City pages
   follow a consistent card/list pattern that we can walk with a custom parser.

Portfolio signal: hitting open government data endpoints before falling back to
scraping is both ethically correct (respects rate limits and ToS) and more
resilient. Curitiba's open data portal is a real production data source used by
civic tech projects — showing familiarity with it signals domain knowledge of
Brazilian public datasets.
"""
import httpx
import logging
import re
import unicodedata
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin
from models import RawEvent

log = logging.getLogger(__name__)

# Curitiba open-data JSON endpoints (try both — the canonical URL changes)
OPEN_DATA_URLS = [
    "https://mid.curitiba.pr.gov.br/dadosabertos/AgendaCultural/AgendaCultural_v3.json",
    "https://dadosabertos.curitiba.pr.gov.br/dadosabertos/AgendaCultural.json",
]

AGENDA_HTML_URL = "https://www.curitiba.pr.gov.br/agendacultural/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept": "application/json, text/html, */*",
}


# ─── Public entry point ───────────────────────────────────────────────────────

async def fetch_events(city: str = "Curitiba", days_ahead: int = 30) -> list[RawEvent]:
    """
    Fetch upcoming Prefeitura de Curitiba cultural events.

    Tries open-data JSON endpoints first (clean, structured). Falls back to
    scraping the public HTML agenda page. Returns empty list on total failure.
    """
    today = datetime.now(timezone.utc)

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        # Strategy 1: open-data JSON (try both endpoint URLs)
        for url in OPEN_DATA_URLS:
            try:
                events = await _fetch_via_json(client, url, today)
                if events:
                    log.info(f"Prefeitura: {len(events)} events via open data ({url.split('/')[-1]})")
                    return events
                log.info(f"Prefeitura: {url.split('/')[-1]} returned empty — trying next")
            except Exception as e:
                log.warning(f"Prefeitura open data {url.split('/')[-1]} failed: {e}")

        # Strategy 2: HTML fallback
        try:
            events = await _fetch_via_html(client, today)
            log.info(f"Prefeitura: {len(events)} events via HTML fallback")
            return events
        except Exception as e:
            log.warning(f"Prefeitura HTML fallback failed: {e}")

    log.warning("Prefeitura: all strategies failed — returning empty list")
    return []


# ─── Strategy 1: open-data JSON ───────────────────────────────────────────────

async def _fetch_via_json(
    client: httpx.AsyncClient,
    url: str,
    today: datetime,
) -> list[RawEvent]:
    """
    Fetch and parse a Curitiba open-data cultural agenda JSON file.

    The dataset is a flat JSON array where each object represents one event.
    Field names follow PascalCase PT-BR convention (Titulo, DataInicio, etc.).
    The feed may include past events, so we filter for date_start >= today.
    """
    resp = await client.get(url, headers=HEADERS)
    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code}")

    # Some endpoints return a JSON object wrapping the array
    payload = resp.json()
    if isinstance(payload, dict):
        # Try common wrapper keys
        items = (
            payload.get("data")
            or payload.get("eventos")
            or payload.get("eventos_culturais")
            or payload.get("results")
            or []
        )
    elif isinstance(payload, list):
        items = payload
    else:
        raise ValueError("Unexpected JSON structure — not a list or dict")

    if not isinstance(items, list):
        raise ValueError(f"Expected list of events, got {type(items).__name__}")

    results: list[RawEvent] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        parsed = _parse_json_event(item, today)
        if parsed:
            results.append(parsed)

    return results


def _parse_json_event(item: dict, today: datetime) -> RawEvent | None:
    """Convert a single Curitiba open-data event object to RawEvent."""
    try:
        # Field names vary between dataset versions — check alternatives
        title = (
            item.get("Titulo")
            or item.get("titulo")
            or item.get("nome")
            or item.get("Nome")
            or ""
        ).strip()

        if not title:
            return None

        # Date fields
        date_start_raw = (
            item.get("DataInicio")
            or item.get("data_inicio")
            or item.get("DataEvento")
            or item.get("data")
            or ""
        )
        date_end_raw = (
            item.get("DataFim")
            or item.get("data_fim")
            or item.get("DataFimEvento")
            or ""
        )

        date_start = _parse_br_datetime(date_start_raw)
        if not date_start:
            return None

        # Skip past events
        if date_start < today:
            return None

        date_end = _parse_br_datetime(date_end_raw) if date_end_raw else None

        # Location
        venue_name = (
            item.get("Local")
            or item.get("local")
            or item.get("Espaco")
            or item.get("espaco")
            or "Curitiba"
        ).strip()

        address_parts = [
            item.get("Endereco") or item.get("endereco") or "",
            item.get("Bairro") or item.get("bairro") or "",
        ]
        venue_address = ", ".join(p.strip() for p in address_parts if p.strip())

        neighborhood = (
            item.get("Bairro")
            or item.get("bairro")
            or None
        )

        description = (
            item.get("Descricao")
            or item.get("descricao")
            or item.get("Sinopse")
            or ""
        ).strip()

        url = (
            item.get("Link")
            or item.get("link")
            or item.get("Url")
            or item.get("url")
            or AGENDA_HTML_URL
        ).strip()

        # Price — city events are almost always free
        price_raw = (
            item.get("Preco")
            or item.get("preco")
            or item.get("Valor")
            or ""
        )
        price_min, price_max = _parse_price(str(price_raw))

        # Build a stable external_id from the item
        item_id = (
            item.get("Id")
            or item.get("id")
            or item.get("Codigo")
            or item.get("codigo")
        )
        if item_id:
            external_id = f"prefeitura_{item_id}"
        else:
            date_slug = date_start.strftime("%Y%m%d")
            external_id = f"prefeitura_{date_slug}_{_slugify(title)}"

        return RawEvent(
            source="prefeitura",
            external_id=external_id,
            name=title,
            description=description[:1000],
            venue_name=venue_name,
            venue_address=venue_address,
            neighborhood=neighborhood,
            city="Curitiba",
            date_start=date_start,
            date_end=date_end,
            price_min=price_min,
            price_max=price_max,
            currency="BRL",
            capacity=None,
            attendees_confirmed=None,
            url=url,
            image_url=(
                item.get("Imagem")
                or item.get("imagem")
                or item.get("FotoUrl")
                or None
            ),
        )
    except Exception as e:
        log.warning(f"Prefeitura JSON parse error for '{item.get('Titulo', '?')}': {e}")
        return None


# ─── Strategy 2: HTML scrape ──────────────────────────────────────────────────

async def _fetch_via_html(client: httpx.AsyncClient, today: datetime) -> list[RawEvent]:
    """
    Scrape the Prefeitura agenda page using Python stdlib html.parser.

    The page renders event listings as <div> or <li> cards. We extract title,
    date, and optional venue by tracking class context through the parse tree.
    Uses only stdlib — no BeautifulSoup or lxml dependency.
    """
    resp = await client.get(AGENDA_HTML_URL, headers=HEADERS)
    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code} from {AGENDA_HTML_URL}")

    parser = _AgendaHTMLParser(base_url=AGENDA_HTML_URL)
    parser.feed(resp.text)
    raw = parser.get_events()

    results: list[RawEvent] = []
    for ev in raw:
        title = ev.get("title", "").strip()
        if not title:
            continue

        date_start = _parse_br_datetime(ev.get("date", ""))
        if not date_start or date_start < today:
            continue

        url = ev.get("url", "") or AGENDA_HTML_URL
        slug = url.rstrip("/").split("/")[-1] or _slugify(title)
        date_slug = date_start.strftime("%Y%m%d")
        external_id = f"prefeitura_html_{date_slug}_{slug}"

        results.append(RawEvent(
            source="prefeitura",
            external_id=external_id,
            name=title,
            description=ev.get("description", "").strip()[:1000],
            venue_name=ev.get("venue", "Curitiba").strip() or "Curitiba",
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


class _AgendaHTMLParser(HTMLParser):
    """
    Lightweight SAX-style parser for the Prefeitura cultural agenda page.

    Prefeitura pages vary in markup, so we cast a wide net: look for any
    repeated card-like container (<article>, <li>, <div>) that holds a title
    (h2/h3) and a date string. This approach is deliberately permissive —
    false positives are filtered downstream by date validation.
    """

    def __init__(self, base_url: str = "") -> None:
        super().__init__()
        self._base_url = base_url
        self._events: list[dict] = []
        self._current: dict | None = None
        self._capture: str | None = None
        self._depth: int = 0
        self._card_depth: int = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = {k: (v or "") for k, v in attrs}
        classes = attr_dict.get("class", "")
        href = attr_dict.get("href", "")

        # Detect event card start
        if tag in ("article", "li", "div") and self._is_card(classes):
            if self._current is None:
                self._current = {}
                self._card_depth = self._depth
            self._depth += 1
            return

        if self._current is not None:
            self._depth += 1

            # Title tags
            if tag in ("h2", "h3", "h4") and self._has_any(classes, ("title", "nome", "evento", "item")):
                self._capture = "title"
            elif tag == "a" and self._capture == "title" and href:
                full_url = urljoin(self._base_url, href) if href.startswith("/") else href
                self._current.setdefault("url", full_url)

            # Date
            elif self._has_any(classes, ("date", "data", "periodo", "quando", "calendar")):
                self._capture = "date"

            # Venue / location
            elif self._has_any(classes, ("local", "venue", "onde", "location")):
                self._capture = "venue"

            # Description snippet
            elif self._has_any(classes, ("descricao", "description", "resumo", "excerpt", "summary")):
                self._capture = "description"

            # Image
            elif tag == "img" and attr_dict.get("src"):
                src = attr_dict["src"]
                full_src = urljoin(self._base_url, src) if src.startswith("/") else src
                self._current.setdefault("image_url", full_src)

            # Bare link — capture URL if none yet
            elif tag == "a" and href and not href.startswith("#"):
                full_url = urljoin(self._base_url, href) if href.startswith("/") else href
                self._current.setdefault("url", full_url)

    def handle_endtag(self, tag: str) -> None:
        if self._current is None:
            return

        self._depth -= 1

        if self._capture and tag in ("h2", "h3", "h4", "span", "p", "time", "div"):
            self._capture = None

        # End of card
        if self._depth <= self._card_depth and tag in ("article", "li", "div"):
            if self._current.get("title"):
                self._events.append(self._current)
            self._current = None
            self._card_depth = 0

    def handle_data(self, data: str) -> None:
        if self._current is None or not self._capture:
            return
        text = data.strip()
        if not text:
            return
        field = self._capture
        existing = self._current.get(field, "")
        self._current[field] = (existing + " " + text).strip()

    @staticmethod
    def _is_card(classes: str) -> bool:
        triggers = (
            "evento", "event", "agenda-item", "card-evento",
            "lista-evento", "resultado", "noticia-agenda",
        )
        return any(t in classes for t in triggers)

    @staticmethod
    def _has_any(classes: str, needles: tuple[str, ...]) -> bool:
        return any(n in classes for n in needles)

    def get_events(self) -> list[dict]:
        return list(self._events)


# ─── Date parsing ─────────────────────────────────────────────────────────────

# PT-BR month names and abbreviations
_PTBR_MONTHS: dict[str, int] = {
    "jan": 1, "janeiro": 1,
    "fev": 2, "fevereiro": 2,
    "mar": 3, "março": 3, "marco": 3,
    "abr": 4, "abril": 4,
    "mai": 5, "maio": 5,
    "jun": 6, "junho": 6,
    "jul": 7, "julho": 7,
    "ago": 8, "agosto": 8,
    "set": 9, "setembro": 9,
    "out": 10, "outubro": 10,
    "nov": 11, "novembro": 11,
    "dez": 12, "dezembro": 12,
}


def _parse_br_datetime(raw: str | None) -> datetime | None:
    """
    Parse Brazilian date strings into timezone-aware datetimes (UTC).

    Handles multiple real-world formats from Curitiba's open-data portal:
    - ISO 8601:  "2025-04-10T19:00:00" / "2025-04-10T19:00:00Z"
    - BR numeric: "10/04/2025", "10/04/2025 19:00"
    - PT-BR text: "10 de abril de 2025", "10 de abr. de 2025"
    - Date-only:  "2025-04-10"
    """
    if not raw:
        return None
    s = str(raw).strip()

    # ISO 8601
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        pass

    s_lower = s.lower()

    # "10 de abril de 2025" or "10 de abr. de 2025"
    m = re.search(r"(\d{1,2})\s+de\s+(\w+)\.?\s*(?:de\s+)?(\d{4})?", s_lower)
    if m:
        day = int(m.group(1))
        month_key = m.group(2).rstrip(".")
        year_str = m.group(3)
        month = _PTBR_MONTHS.get(month_key)
        if month:
            year = int(year_str) if year_str else datetime.now(timezone.utc).year
            try:
                return datetime(year, month, day, 0, 0, 0, tzinfo=timezone.utc)
            except ValueError:
                pass

    # "10/04/2025" or "10/04/2025 19:00"
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?", s)
    if m:
        try:
            day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
            hour = int(m.group(4)) if m.group(4) else 0
            minute = int(m.group(5)) if m.group(5) else 0
            return datetime(year, month, day, hour, minute, 0, tzinfo=timezone.utc)
        except ValueError:
            pass

    # Plain "2025-04-10"
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 0, 0, 0, tzinfo=timezone.utc)
        except ValueError:
            pass

    log.warning(f"Prefeitura: could not parse date '{raw}'")
    return None


# ─── Price parsing ────────────────────────────────────────────────────────────

def _parse_price(raw: str) -> tuple[float, float]:
    """
    Extract a price range from Prefeitura event price strings.

    Municipality-funded events are almost always free. Default is (0, 0).
    """
    if not raw:
        return 0.0, 0.0

    lower = raw.lower().strip()
    if not lower or any(w in lower for w in ("gratu", "free", "0,00", "r$ 0")):
        return 0.0, 0.0

    # Find all monetary amounts
    amounts = re.findall(r"\d+[.,]\d{2}", raw)
    if not amounts:
        amounts = re.findall(r"\d+", raw)

    prices: list[float] = []
    for a in amounts:
        try:
            prices.append(float(a.replace(",", ".")))
        except ValueError:
            continue

    if not prices:
        return 0.0, 0.0

    return min(prices), max(prices)


# ─── Utilities ────────────────────────────────────────────────────────────────

def _slugify(text: str) -> str:
    """Convert a string to a URL-safe slug for stable external_id generation."""
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)[:60]
