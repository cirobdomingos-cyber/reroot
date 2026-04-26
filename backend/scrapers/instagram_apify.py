"""
Instagram scraper backed by Apify (https://apify.com).

Why Apify: scraping Instagram from a self-hosted account is a losing fight in
2026 — accounts get banned within days, login flows break monthly, and
maintaining residential proxies is full-time work. Apify runs the scraping
infrastructure for us; we just call their REST API.

Pipeline:
  1. Read enabled handles from the `tracked_ig_accounts` table.
  2. Run the `apify/instagram-scraper` actor with those URLs.
  3. For each returned post, ask Claude Haiku: is this a Curitiba event with
     a date? If yes, return structured fields. Same unstructured-to-structured
     pattern as the SESC scraper.
  4. Emit `RawEvent` objects so the rest of the pipeline (enrichment, region
     filter, dedup) handles them just like any other source.

Cost ballpark (Apify free tier = $5/mo credit):
  ~30 handles × 10 posts each = 300 posts/day → roughly $0.10–0.20/day.
  Comfortably inside the free tier for development.
"""
import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

import httpx
from anthropic import AsyncAnthropic
from models import RawEvent

import database as db

# Cap concurrent Claude calls so a 150-post run doesn't fan out 150 in flight.
# The Anthropic API tolerates this fine, but a semaphore keeps memory + open
# sockets predictable. 8 is empirically safe — total run for ~150 posts drops
# from ~3min serial to ~25s, well under Apify's per-run timeout.
_CLAUDE_CONCURRENCY = 8

log = logging.getLogger(__name__)

APIFY_ACTOR_ID = "apify~instagram-scraper"
APIFY_RUN_URL = (
    f"https://api.apify.com/v2/acts/{APIFY_ACTOR_ID}/run-sync-get-dataset-items"
)
# Long timeout because Apify cold-starts can take 60s+ on the free tier.
APIFY_TIMEOUT_S = 240

EXTRACTION_PROMPT = """\
Você está extraindo informações de eventos a partir de legendas do Instagram \
de contas curitibanas (cafés, museus, espaços culturais, coletivos, curadores).
Hoje é {today}. A pessoa que vai usar essa informação está em Curitiba (PR, Brasil).

Conta: @{handle}
Data do post: {post_date}
Legenda:
{caption}

Sua tarefa: decidir se a legenda anuncia um evento ESPECÍFICO em Curitiba ou \
região metropolitana com uma data identificável (próxima ou recém-passada por \
até 1 dia). Se NÃO for um evento específico (foto pessoal, propaganda genérica, \
"passou aqui hoje", lista de dicas, recap), responda {{"is_event": false}}.

Responda SOMENTE JSON válido (sem markdown, sem texto extra):
{{
  "is_event": true,
  "name": "<nome do evento em português>",
  "description": "<descrição curta em português, máx 200 caracteres>",
  "venue_name": "<local específico, ou nome da conta como fallback>",
  "venue_address": "<endereço/bairro em Curitiba, ou vazio>",
  "neighborhood": "<bairro em Curitiba, ou vazio>",
  "date_start": "<YYYY-MM-DDTHH:MM:SS — combine com a data do post quando o \
post diz 'sábado', 'amanhã', etc.>",
  "date_end": "<YYYY-MM-DDTHH:MM:SS ou null>",
  "price_min": <número, 0 se gratuito>,
  "price_max": <número, 0 se gratuito>
}}

Regras:
- Se a legenda diz "sábado 18h" ou "amanhã às 20h", calcule a data absoluta a \
  partir da data do post.
- Se NÃO há horário específico, use 19:00 para shows/encontros à noite, 14:00 \
  para tarde, 10:00 para manhã.
- Se a legenda menciona apenas "dezembro" ou "em breve" sem data específica, \
  responda {{"is_event": false}}.
- Eventos fora de Curitiba ou da Região Metropolitana → {{"is_event": false}}.
- "Gratuito", "entrada franca", "rolê livre" → preço 0.
- O fallback do venue_name deve ser o próprio nome da conta (ex: "Café Lucca") \
  porque muitas postagens são "venha ao nosso lugar" sem repetir o local.
"""


async def fetch_events(
    anthropic_api_key: str,
    apify_token: str,
    posts_per_account: int = 10,
) -> list[RawEvent]:
    """
    Run the Apify Instagram scraper for every enabled tracked account, then
    use Claude to extract events from captions.

    Never raises — failures degrade gracefully to an empty list, so a broken
    Instagram run can't take down the whole refresh pipeline.
    """
    if not apify_token:
        log.warning("Instagram (Apify): APIFY_API_TOKEN não configurado — pulando")
        return []
    if not anthropic_api_key:
        log.warning("Instagram (Apify): ANTHROPIC_API_KEY não configurado — pulando")
        return []

    accounts = db.get_enabled_ig_accounts()
    if not accounts:
        log.info("Instagram (Apify): nenhuma conta cadastrada — pulando")
        return []

    direct_urls = [f"https://www.instagram.com/{a['handle']}/" for a in accounts]
    log.info(f"Instagram (Apify): scraping {len(direct_urls)} accounts...")

    posts = await _run_apify_scrape(apify_token, direct_urls, posts_per_account)
    if not posts:
        log.warning("Instagram (Apify): scraper retornou 0 posts")
        return []

    log.info(f"Instagram (Apify): {len(posts)} posts coletados, extraindo eventos...")

    # Update last_scraped_at + cached profile metadata for each handle that
    # returned at least one post. Apify's instagram-scraper actor varies
    # field naming across versions — handle both flat (ownerProfilePicUrl)
    # and nested ({owner: {profile_pic_url}}) shapes so the enrichment
    # works regardless. First-occurrence-per-handle wins.
    def _pick(post: dict, *paths) -> str:
        for p in paths:
            if not p:
                continue
            keys = p.split(".")
            cur = post
            for k in keys:
                if not isinstance(cur, dict):
                    cur = None
                    break
                cur = cur.get(k)
            if isinstance(cur, str) and cur.strip():
                return cur.strip()
        return ""

    handles_with_data: set[str] = set()
    profile_seen: dict[str, dict] = {}
    for p in posts:
        h = (p.get("ownerUsername") or "").lower()
        if not h:
            continue
        handles_with_data.add(h)
        if h not in profile_seen:
            profile_seen[h] = {
                "display_name": _pick(p,
                    "ownerFullName", "ownerFullname",
                    "owner.full_name", "owner.fullName",
                ),
                "profile_pic_url": _pick(p,
                    "ownerProfilePicUrl", "ownerProfilePicURL", "ownerProfilePicture",
                    "owner.profile_pic_url", "owner.profilePicUrl", "owner.profilePicture",
                ),
            }
    for handle in handles_with_data:
        db.mark_ig_account_scraped(handle)
        meta = profile_seen.get(handle, {})
        if meta.get("display_name") or meta.get("profile_pic_url"):
            db.update_ig_account_profile(
                handle=handle,
                display_name=meta.get("display_name", ""),
                profile_pic_url=meta.get("profile_pic_url", ""),
            )
        else:
            # Log once per handle when we got posts but no profile fields
            # so the founder can debug schema drift on Apify's side.
            log.info(f"IG enrich: no profile fields found in {handle} posts")

    client = AsyncAnthropic(api_key=anthropic_api_key)
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sem = asyncio.Semaphore(_CLAUDE_CONCURRENCY)

    async def _bounded_extract(post):
        async with sem:
            return await _extract_event(client, post, today_str)

    results = await asyncio.gather(
        *[_bounded_extract(p) for p in posts],
        return_exceptions=False,
    )
    events: list[RawEvent] = [ev for ev in results if ev is not None]

    log.info(f"Instagram (Apify): {len(events)} eventos extraídos de {len(posts)} posts")

    # Update event-yield stats per account so the admin UI can show which
    # handles are producing real events vs. just consuming Apify quota.
    yields_by_handle: dict[str, int] = {}
    for ev in events:
        h = ev.external_id.split("_", 1)[0]  # "ig_{handle}_{shortcode}" → handle
        yields_by_handle[h] = yields_by_handle.get(h, 0) + 1
    for handle in handles_with_data:
        db.set_ig_account_last_event_count(handle, yields_by_handle.get(handle, 0))

    return events


async def _run_apify_scrape(
    apify_token: str,
    direct_urls: list[str],
    posts_per_account: int,
) -> list[dict]:
    """POST to Apify, return list of post dicts. Catches all exceptions."""
    payload = {
        "directUrls": direct_urls,
        "resultsType": "posts",
        # `resultsLimit` is *per profile* in this actor.
        "resultsLimit": posts_per_account,
        "addParentData": False,
    }
    try:
        async with httpx.AsyncClient(timeout=APIFY_TIMEOUT_S) as client:
            r = await client.post(
                f"{APIFY_RUN_URL}?token={apify_token}",
                json=payload,
            )
        # Apify returns 201 for successful run-sync calls.
        if r.status_code not in (200, 201):
            log.warning(f"Apify scraper HTTP {r.status_code}: {r.text[:200]}")
            return []
        items = r.json()
        if not isinstance(items, list):
            log.warning(f"Apify scraper returned {type(items).__name__}, expected list")
            return []
        return items
    except httpx.TimeoutException:
        log.warning(f"Apify scraper timed out after {APIFY_TIMEOUT_S}s")
        return []
    except Exception as e:
        log.warning(f"Apify scraper failed: {e}")
        return []


async def _extract_event(client: AsyncAnthropic, post: dict, today_str: str) -> Optional[RawEvent]:
    """
    Send a single post's caption to Claude Haiku for structured extraction.
    Returns None if Claude judges it not an event, or on any error. Async so
    the calling fan-out (asyncio.gather) can run many in parallel.
    """
    caption = (post.get("caption") or "").strip()
    if len(caption) < 30:
        return None  # selfies, emoji posts, etc. — not events

    handle = (post.get("ownerUsername") or "").strip()
    post_date = (post.get("timestamp") or "")[:10]
    post_url = post.get("url") or ""
    image_url = post.get("displayUrl") or None
    likes = post.get("likesCount") or 0
    shortcode = _extract_shortcode(post_url) or post.get("id", "")

    prompt = EXTRACTION_PROMPT.format(
        today=today_str,
        handle=handle,
        post_date=post_date,
        caption=caption[:1500],
    )

    try:
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        raw_text = response.content[0].text.strip()
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
        raw_text = re.sub(r"\s*```$", "", raw_text)
        data = json.loads(raw_text)
    except json.JSONDecodeError as e:
        log.debug(f"IG: invalid JSON for @{handle}/{shortcode}: {e}")
        return None
    except Exception as e:
        log.warning(f"IG Claude error for @{handle}/{shortcode}: {e}")
        return None

    if not data.get("is_event", False):
        return None

    date_start = _parse_iso(data.get("date_start"))
    if not date_start:
        return None
    # Only future events (allowing 12h grace for "happening now" posts)
    from datetime import timedelta
    if date_start < datetime.now(timezone.utc) - timedelta(hours=12):
        return None

    date_end = _parse_iso(data.get("date_end"))

    name = (data.get("name") or "").strip()[:200]
    if not name:
        return None

    venue_name = (data.get("venue_name") or "").strip() or handle.title()
    venue_address = (data.get("venue_address") or "").strip()
    neighborhood = (data.get("neighborhood") or "").strip() or None

    return RawEvent(
        source="instagram",
        external_id=f"ig_{handle}_{shortcode}",
        name=name,
        description=(data.get("description") or "")[:1000],
        venue_name=venue_name[:200],
        venue_address=venue_address[:300],
        neighborhood=neighborhood,
        city="Curitiba",
        date_start=date_start,
        date_end=date_end,
        price_min=float(data.get("price_min", 0) or 0),
        price_max=float(data.get("price_max", 0) or 0),
        currency="BRL",
        capacity=None,
        attendees_confirmed=likes,  # likes as a popularity proxy
        url=post_url,
        image_url=image_url,
    )


def _extract_shortcode(url: str) -> str:
    """Pull the shortcode out of an instagram.com/p/<code>/ URL."""
    m = re.search(r"/p/([A-Za-z0-9_-]+)", url)
    return m.group(1) if m else ""


def _parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s[:19], fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None
