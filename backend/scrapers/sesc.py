"""
SESC Paraná event scraper.

SESC (Serviço Social do Comércio) publishes free and low-cost cultural events
at its units across Paraná. Their Curitiba units — SESC Portão, SESC Batel,
etc. — are major community hubs aligned with Reroot's low-pressure social
re-entry mission.

NOTE: sescpr.com.br runs WordPress but does NOT have The Events Calendar
plugin installed (/wp-json/tribe/events/v1/events returns 404). Events are
announced as regular WordPress posts.

Scraping strategy (in priority order):
1. WordPress posts API — fetch recent posts via /wp-json/wp/v2/posts, then
   use Claude Haiku to extract structured event data from title + content.
   Same pattern as the Instagram scraper: LLM-powered unstructured → structured.

2. HTML fallback — scrape /programacao/ if the posts API fails or returns nothing.

Portfolio signal: falling back from a broken structured API to LLM extraction
from free-text is a real-world pattern. Many institutions publish events as
news posts, not structured data.
"""
import json
import logging
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Optional

import httpx
from anthropic import Anthropic
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://www.sescpr.com.br"
WP_POSTS_URL = f"{BASE_URL}/wp-json/wp/v2/posts"
PROGRAMACAO_URL = f"{BASE_URL}/programacao/"

# SESC has units across all of Paraná. We only want Curitiba metro events.
# Match against the venue text after extraction; even if Claude misjudges,
# this catches unit names that obviously belong to other cities.
_NON_CURITIBA_SESC_UNITS = (
    "sesc toledo", "sesc londrina", "sesc maringá", "sesc maringa",
    "sesc cascavel", "sesc foz", "sesc ponta grossa", "sesc guarapuava",
    "sesc paranaguá", "sesc paranagua", "sesc caiobá", "sesc caioba",
    "sesc são josé do rio preto", "sesc apucarana", "sesc umuarama",
    "etapa toledo", "etapa londrina", "etapa maringá", "etapa cascavel",
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# PT-BR month names → month number
PTBR_MONTHS: dict[str, int] = {
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

EXTRACTION_PROMPT = """\
You are extracting structured event information from a SESC Paraná WordPress post.
SESC is a Brazilian cultural institution that hosts free and low-cost events
(concerts, workshops, cinema, exhibitions, dance, theatre) at its units across
Paraná state. We ONLY want events that happen at SESC units in Curitiba or its
metropolitan region (Pinhais, São José dos Pinhais, Araucária, Colombo, etc.).

Post title: {title}
Post date: {post_date}
Post content:
{content}

If this post is announcing an upcoming event AT A SESC UNIT IN CURITIBA OR RMC
(with a specific date in the future), extract the details.

Respond with {{"is_event": false}} if ANY of the following are true:
- Event happens at SESC Toledo, SESC Londrina, SESC Maringá, SESC Cascavel,
  SESC Foz do Iguaçu, SESC Ponta Grossa, SESC Guarapuava, SESC Paranaguá,
  SESC Caiobá, or any other unit OUTSIDE Curitiba metropolitan region.
- Post is a news article about a past event.
- General announcement without a specific date.
- Not about an event.

Respond ONLY with valid JSON (no markdown, no extra text):
{{
  "is_event": true,
  "name": "<event name in Portuguese>",
  "description": "<brief description in Portuguese, max 200 chars>",
  "venue_name": "<SESC unit name, e.g. SESC Portão or SESC Água Verde, or empty>",
  "venue_address": "<address if mentioned or empty>",
  "neighborhood": "<neighborhood if mentioned or empty>",
  "date_start": "<YYYY-MM-DDTHH:MM:SS — best guess from content and post date>",
  "date_end": "<YYYY-MM-DDTHH:MM:SS or null>",
  "price_min": <number — 0 for free/gratuito>,
  "price_max": <number — 0 for free/gratuito>,
  "currency": "BRL"
}}

Rules:
- SESC events are almost always free (gratuito) — default to 0 if price not explicit
- If the event date appears to be in the past relative to today ({today}), respond with {{"is_event": false}}
- If no time is mentioned, use 10:00 for workshops/exhibitions, 19:00 for shows/concerts
- Prefer the specific Curitiba-region SESC unit name (SESC Portão, SESC Água Verde,
  SESC Paço da Liberdade, SESC Esquina, SESC Hauer, SESC Pinhais)
"""


# ─── Public entry point ───────────────────────────────────────────────────────

async def fetch_events(
    city: str = "Curitiba",
    anthropic_api_key: str = "",
    days_ahead: int = 30,
) -> list[RawEvent]:
    """
    Fetch upcoming SESC PR events.

    Strategy 1: WordPress posts API + Claude extraction.
    Strategy 2: HTML scrape of /programacao/.
    Returns empty list on total failure — never raises.
    """
    today = datetime.now(timezone.utc)
    # Fetch posts from last 30 days (SESC announces events close to the date)
    after = (today - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")

    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        # Strategy 1: WordPress posts + Claude extraction
        if anthropic_api_key:
            try:
                events = await _fetch_via_wp_posts(client, anthropic_api_key, after, today)
                if events:
                    log.info(f"SESC: {len(events)} events via WP posts + Claude")
                    return events
                log.info("SESC WP posts returned no events — trying HTML fallback")
            except Exception as e:
                log.warning(f"SESC WP posts strategy failed: {e} — trying HTML fallback")
        else:
            log.warning("SESC: no ANTHROPIC_API_KEY — skipping WP posts strategy")

        # Strategy 2: HTML scrape of /programacao/
        try:
            events = await _fetch_via_html(client, today)
            log.info(f"SESC: {len(events)} events via HTML fallback")
            return events
        except Exception as e:
            log.warning(f"SESC HTML fallback failed: {e}")

    log.warning("SESC: all strategies failed — returning empty list")
    return []


# ─── Strategy 1: WordPress posts + Claude extraction ─────────────────────────

async def _fetch_via_wp_posts(
    client: httpx.AsyncClient,
    anthropic_api_key: str,
    after: str,
    today: datetime,
    max_posts: int = 25,
) -> list[RawEvent]:
    """
    Fetch recent WordPress posts and use Claude to extract event data.

    SESC announces upcoming events as news posts. The WP REST API exposes them
    at /wp-json/wp/v2/posts. We strip HTML from content and feed it to Claude.
    """
    resp = await client.get(
        WP_POSTS_URL,
        params={
            "per_page": max_posts,
            "orderby": "date",
            "order": "desc",
            "after": after,
            "_fields": "id,title,excerpt,content,date,link",
        },
        headers={**HEADERS, "Accept": "application/json"},
    )

    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code} from WP posts API")

    posts = resp.json()
    if not isinstance(posts, list):
        raise ValueError(f"WP posts API returned {type(posts).__name__}, expected list")

    log.info(f"SESC: {len(posts)} WP posts fetched, extracting events with Claude...")

    anthropic_client = Anthropic(api_key=anthropic_api_key)
    today_str = today.strftime("%Y-%m-%d")
    events: list[RawEvent] = []

    for post in posts:
        raw = _extract_event_from_post(anthropic_client, post, today_str)
        if raw:
            events.append(raw)

    return events


def _extract_event_from_post(
    client: Anthropic,
    post: dict,
    today_str: str,
) -> Optional[RawEvent]:
    """Use Claude to extract a single event from a WP post."""
    title = _strip_html(post.get("title", {}).get("rendered", "") or "").strip()
    if not title:
        return None

    # Use excerpt first (shorter), fall back to first 800 chars of content
    excerpt = _strip_html(post.get("excerpt", {}).get("rendered", "") or "").strip()
    content_raw = _strip_html(post.get("content", {}).get("rendered", "") or "").strip()
    content = excerpt if len(excerpt) > 50 else content_raw[:800]

    post_date = post.get("date", "")[:10]  # "YYYY-MM-DD"
    post_url = post.get("link", "") or BASE_URL
    post_id = str(post.get("id", ""))

    prompt = EXTRACTION_PROMPT.format(
        title=title,
        post_date=post_date,
        content=content,
        today=today_str,
    )

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        raw_json = response.content[0].text.strip()
        # Strip markdown code fences if present
        raw_json = re.sub(r"^```(?:json)?\s*", "", raw_json)
        raw_json = re.sub(r"\s*```$", "", raw_json)
        data = json.loads(raw_json)
    except json.JSONDecodeError as e:
        log.warning(f"SESC: Claude returned invalid JSON for post '{title[:40]}': {e}")
        return None
    except Exception as e:
        log.error(f"SESC: Claude API error for post '{title[:40]}': {e}")
        return None

    if not data.get("is_event", False):
        return None

    # Defensive check: even if Claude judged this an event, drop anything
    # whose extracted venue or title points to a non-Curitiba SESC unit.
    venue_blob = (
        f"{data.get('venue_name', '')} {data.get('venue_address', '')} "
        f"{data.get('neighborhood', '')} {data.get('name', title)}"
    ).lower()
    if any(unit in venue_blob for unit in _NON_CURITIBA_SESC_UNITS):
        log.debug(f"SESC: dropped non-Curitiba unit event '{title[:50]}'")
        return None

    try:
        date_start = datetime.fromisoformat(data["date_start"])
        if date_start.tzinfo is None:
            date_start = date_start.replace(tzinfo=timezone.utc)
    except (ValueError, KeyError):
        log.warning(f"SESC: invalid date for post '{title[:40]}': {data.get('date_start')}")
        return None

    # Skip past events
    if date_start < datetime.now(timezone.utc):
        return None

    date_end = None
    if data.get("date_end"):
        try:
            date_end = datetime.fromisoformat(data["date_end"])
            if date_end.tzinfo is None:
                date_end = date_end.replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    external_id = f"sesc_wp_{post_id}" if post_id else f"sesc_wp_{_slugify(title)}"

    return RawEvent(
        source="sesc",
        external_id=external_id,
        name=data.get("name", title)[:200],
        description=data.get("description", "")[:1000],
        venue_name=data.get("venue_name", "") or "SESC Paraná",
        venue_address=data.get("venue_address", ""),
        neighborhood=data.get("neighborhood") or None,
        city="Curitiba",
        date_start=date_start,
        date_end=date_end,
        price_min=float(data.get("price_min", 0)),
        price_max=float(data.get("price_max", 0)),
        currency="BRL",
        capacity=None,
        attendees_confirmed=None,
        url=post_url,
        image_url=None,
    )


# ─── Strategy 2: HTML scrape ──────────────────────────────────────────────────

async def _fetch_via_html(client: httpx.AsyncClient, today: datetime) -> list[RawEvent]:
    """
    Scrape the SESC /programacao/ page using stdlib html.parser.

    /programacao/ is the correct programming page (not /agenda/ which 404s).
    """
    resp = await client.get(PROGRAMACAO_URL, headers=HEADERS)
    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code} from {PROGRAMACAO_URL}")

    parser = _SESCHTMLParser()
    parser.feed(resp.text)
    raw = parser.get_events()

    results: list[RawEvent] = []
    for ev in raw:
        title = ev.get("title", "").strip()
        if not title:
            continue

        date_start = _parse_ptbr_date(ev.get("date", ""))
        if not date_start or date_start < today:
            continue

        # Skip non-Curitiba SESC units
        venue_blob = f"{ev.get('venue', '')} {title}".lower()
        if any(unit in venue_blob for unit in _NON_CURITIBA_SESC_UNITS):
            continue

        url = ev.get("url", "") or PROGRAMACAO_URL
        slug = url.rstrip("/").split("/")[-1] if url != PROGRAMACAO_URL else _slugify(title)
        external_id = f"sesc_html_{slug}" if slug else f"sesc_html_{_slugify(title)}"

        results.append(RawEvent(
            source="sesc",
            external_id=external_id,
            name=title,
            description=ev.get("description", "").strip()[:1000],
            venue_name=ev.get("venue", "SESC Paraná").strip() or "SESC Paraná",
            venue_address="",
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


class _SESCHTMLParser(HTMLParser):
    """
    SAX-style parser for the SESC /programacao/ WordPress page.

    Looks for article/div containers with event-related classes, then
    extracts title, date, venue, and URL. Permissive by design — date
    validation filters false positives downstream.
    """

    def __init__(self) -> None:
        super().__init__()
        self._events: list[dict] = []
        self._current: dict | None = None
        self._capture: str | None = None
        self._depth: int = 0
        self._card_depth: int = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = {k: (v or "") for k, v in attrs}
        classes = attr_dict.get("class", "")
        href = attr_dict.get("href", "")

        if tag in ("article", "div") and self._is_event_container(classes):
            if self._current is None:
                self._current = {}
                self._card_depth = self._depth
            self._depth += 1
            return

        if self._current is not None:
            self._depth += 1

            if tag in ("h2", "h3") and self._has_any(classes, ("title", "entry-title", "post-title")):
                self._capture = "title"
            elif tag == "a" and self._capture == "title" and href:
                self._current.setdefault("url", href)

            elif self._has_any(classes, ("date", "data", "periodo", "tribe-event-date")):
                self._capture = "date"

            elif self._has_any(classes, ("venue", "local", "location")):
                self._capture = "venue"

            elif self._has_any(classes, ("excerpt", "description", "summary", "resumo")):
                self._capture = "description"

            elif tag == "img" and attr_dict.get("src"):
                self._current.setdefault("image_url", attr_dict["src"])

            elif tag == "a" and href and href.startswith("http") and "url" not in self._current:
                self._current["url"] = href

    def handle_endtag(self, tag: str) -> None:
        if self._current is None:
            return
        self._depth -= 1
        if self._capture:
            self._capture = None
        if self._depth <= self._card_depth and tag in ("article", "div"):
            if self._current.get("title"):
                self._events.append(self._current)
            self._current = None
            self._card_depth = 0

    def handle_data(self, data: str) -> None:
        if self._current is None or not self._capture:
            return
        field = self._capture
        existing = self._current.get(field, "")
        self._current[field] = (existing + " " + data).strip()

    @staticmethod
    def _is_event_container(classes: str) -> bool:
        triggers = ("event", "evento", "programacao", "tribe-event", "card-post", "post-card")
        return any(t in classes for t in triggers)

    @staticmethod
    def _has_any(classes: str, needles: tuple[str, ...]) -> bool:
        return any(n in classes for n in needles)

    def get_events(self) -> list[dict]:
        return list(self._events)


# ─── Date parsing ─────────────────────────────────────────────────────────────

def _parse_ptbr_date(raw: str) -> datetime | None:
    """Parse Portuguese date strings like '10 de abril de 2025' or '10/04/2025'."""
    raw = raw.strip().lower()
    if not raw:
        return None

    m = re.search(r"(\d{1,2})\s+de\s+(\w+)(?:\s+de\s+(\d{4}))?", raw)
    if m:
        day = int(m.group(1))
        month_name = m.group(2).strip().rstrip(".")
        year_str = m.group(3)
        month = PTBR_MONTHS.get(month_name)
        if month:
            year = int(year_str) if year_str else datetime.now(timezone.utc).year
            try:
                return datetime(year, month, day, 0, 0, 0, tzinfo=timezone.utc)
            except ValueError:
                pass

    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", raw)
    if m:
        try:
            return datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)), 0, 0, 0, tzinfo=timezone.utc)
        except ValueError:
            pass

    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 0, 0, 0, tzinfo=timezone.utc)
        except ValueError:
            pass

    return None


# ─── Utilities ────────────────────────────────────────────────────────────────

def _strip_html(text: str) -> str:
    """Remove HTML tags and normalize whitespace."""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&[a-z]+;", " ", text)
    text = re.sub(r"&#\d+;", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _slugify(text: str) -> str:
    """Convert a string to a URL-safe slug for use as external_id."""
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)[:60]
