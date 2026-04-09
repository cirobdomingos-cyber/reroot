"""
Catraca Livre Curitiba scraper.

Catraca Livre é o maior agregador brasileiro de eventos gratuitos e
acessíveis, com forte curadoria cultural. Excelente fit para o Reroot:
foco em cultura, arte, natureza e eventos comunitários de baixo custo.

Strategy:
1. Try WordPress REST API (posts endpoint filtered by Curitiba)
2. Use Claude Haiku to extract event data from post title + content
3. HTML fallback: scrape /curitiba/ directly
"""
import json
import logging
import re
from datetime import datetime, timezone
from html.parser import HTMLParser

from anthropic import Anthropic
import httpx
from models import RawEvent

log = logging.getLogger(__name__)

BASE_URL = "https://catracalivre.com.br"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept": "application/json, text/html, */*",
}

# WordPress API — posts tagged or categorized as Curitiba events
WP_API_URLS = [
    f"{BASE_URL}/curitiba/wp-json/wp/v2/posts?per_page=20&_fields=id,title,content,date,link",
    f"{BASE_URL}/wp-json/wp/v2/posts?per_page=30&search=curitiba&_fields=id,title,content,date,link",
]

EXTRACTION_PROMPT = """\
Analise o conteúdo abaixo e extraia informações do evento. \
Se não for um evento real com data (ex: artigo de lista, dica geral, notícia), retorne null.

Título: {title}
Conteúdo: {content}
URL: {url}

Retorne SOMENTE JSON válido ou null (sem markdown, sem texto extra):
{{
  "is_event": true | false,
  "name": "Nome do evento em português",
  "description": "Descrição em até 200 caracteres",
  "venue_name": "Nome do local",
  "venue_address": "Endereço ou bairro em Curitiba",
  "date_start": "YYYY-MM-DDTHH:MM:SS",
  "price_min": 0.0,
  "price_max": 0.0
}}

Regras:
- Se não for evento único com data específica → {{"is_event": false}}
- date_start deve ser data futura ou nos últimos 7 dias
- Eventos gratuitos: price_min=0, price_max=0
- Se data não mencionada → {{"is_event": false}}
"""


async def fetch_events(
    anthropic_api_key: str,
    city: str = "Curitiba",
) -> list[RawEvent]:
    """Fetch events from Catraca Livre via WordPress API + LLM extraction."""
    posts: list[dict] = []

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        for wp_url in WP_API_URLS:
            try:
                resp = await client.get(wp_url, headers=HEADERS)
                if resp.status_code == 200:
                    batch = resp.json()
                    if isinstance(batch, list) and batch:
                        posts.extend(batch)
                        log.info(f"Catraca Livre WP API ({wp_url[-40:]}): {len(batch)} posts")
                        break  # first successful source is enough
            except Exception as e:
                log.warning(f"Catraca Livre WP API failed: {e}")

        # HTML fallback if API returned nothing
        if not posts:
            posts = await _scrape_html(client, city)

    if not posts:
        log.warning("Catraca Livre: nenhum post encontrado")
        return []

    # Filter posts that look like they could be events (naive keyword check)
    candidate_posts = _filter_event_candidates(posts)
    log.info(f"Catraca Livre: {len(candidate_posts)} posts candidatos para extração")

    # Extract events via Claude
    if not anthropic_api_key:
        return []

    client_ai = Anthropic(api_key=anthropic_api_key)
    events: list[RawEvent] = []

    for post in candidate_posts[:20]:  # cap Claude calls
        raw = _extract_event(client_ai, post)
        if raw:
            events.append(raw)

    log.info(f"Catraca Livre: {len(events)} eventos extraídos")
    return events


async def _scrape_html(client: httpx.AsyncClient, city: str) -> list[dict]:
    """Fallback: scrape /curitiba/ HTML page for article data."""
    url = f"{BASE_URL}/curitiba/"
    try:
        resp = await client.get(url, headers={**HEADERS, "Accept": "text/html"})
        if resp.status_code != 200:
            return []
        return _parse_html_articles(resp.text, url)
    except Exception as e:
        log.warning(f"Catraca Livre HTML fallback failed: {e}")
        return []


def _parse_html_articles(html: str, base_url: str) -> list[dict]:
    """Extract article titles + links from Catraca Livre listing HTML."""
    posts = []
    # Look for article elements with headline + link
    article_pattern = re.compile(
        r'<article[^>]*>.*?<(?:h[1-4]|a)[^>]*href="(/[^"]+)"[^>]*>\s*([^<]{5,150})\s*<',
        re.DOTALL,
    )
    seen = set()
    for m in article_pattern.finditer(html):
        href, title = m.group(1).strip(), m.group(2).strip()
        if href in seen or not title:
            continue
        seen.add(href)
        posts.append({"title": {"rendered": title}, "link": f"https://catracalivre.com.br{href}", "content": {"rendered": ""}})
    return posts[:30]


def _filter_event_candidates(posts: list[dict]) -> list[dict]:
    """Keep only posts whose titles suggest they might be events."""
    EVENT_KEYWORDS = re.compile(
        r"(festival|oficina|workshop|feira|show|teatro|semin[aá]rio|curso|"
        r"exposi[çc][aã]o|encontro|caminhada|yoga|reuni[aã]o|apresenta[çc][aã]o|"
        r"sarau|cin[eé]|palestra|evento|concerto|gratuito|entrada livre)",
        re.IGNORECASE,
    )
    return [p for p in posts if EVENT_KEYWORDS.search(_get_title(p))]


def _get_title(post: dict) -> str:
    t = post.get("title", {})
    if isinstance(t, dict):
        return t.get("rendered", "")
    return str(t)


def _get_content(post: dict) -> str:
    c = post.get("content", {})
    if isinstance(c, dict):
        raw = c.get("rendered", "")
    else:
        raw = str(c)
    # Strip HTML tags
    return re.sub(r"<[^>]+>", " ", raw).strip()[:800]


def _extract_event(client: Anthropic, post: dict) -> RawEvent | None:
    """Call Claude to extract structured event data from a post."""
    title = _get_title(post)
    content = _get_content(post)
    url = post.get("link", "")

    if not title:
        return None

    prompt = EXTRACTION_PROMPT.format(
        title=title, content=content[:600], url=url,
    )
    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        raw_text = resp.content[0].text.strip()
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
        raw_text = re.sub(r"\s*```$", "", raw_text)

        if raw_text.lower() in ("null", "none", ""):
            return None

        data = json.loads(raw_text)
        if not data.get("is_event"):
            return None

        date_start = _parse_iso(data.get("date_start", ""))
        if not date_start:
            return None

        ext_slug = re.sub(r"[^a-z0-9]", "_", title.lower())[:40]
        return RawEvent(
            source="catraca_livre",
            external_id=f"cl_{ext_slug}",
            name=data.get("name", title)[:200],
            description=data.get("description", "")[:1000],
            venue_name=data.get("venue_name", "Curitiba")[:200],
            venue_address=data.get("venue_address", "Curitiba")[:300],
            city="Curitiba",
            date_start=date_start,
            price_min=float(data.get("price_min", 0)),
            price_max=float(data.get("price_max", 0)),
            url=url,
        )
    except (json.JSONDecodeError, Exception) as e:
        log.debug(f"Catraca Livre extraction failed for '{title[:40]}': {e}")
        return None


def _parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            if dt < datetime.now(timezone.utc):
                return None  # past events ignored
            return dt
        except ValueError:
            continue
    return None
