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
import base64
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


# Browser-like UA so IG's CDN doesn't 403 us. Anthropic's URL-source vision
# can't reach signed scontent.cdninstagram.com URLs (they reject the
# Anthropic crawler), so we proxy: fetch ourselves, send base64 to Claude.
_IMAGE_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}
_MAX_IMAGE_BYTES = 5 * 1024 * 1024  # Anthropic limit-friendly cap


async def _fetch_image_b64(image_url: str) -> Optional[tuple[str, str]]:
    """
    Download an IG image so we can pass it to Claude as base64. Returns
    (base64_data, media_type) on success, None on any failure.
    """
    if not image_url or not image_url.startswith("http"):
        return None
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            r = await client.get(image_url, headers=_IMAGE_FETCH_HEADERS)
        if r.status_code != 200:
            return None
        if len(r.content) > _MAX_IMAGE_BYTES:
            return None
        media_type = r.headers.get("content-type", "image/jpeg").split(";")[0].strip()
        if not media_type.startswith("image/"):
            media_type = "image/jpeg"
        return base64.b64encode(r.content).decode("ascii"), media_type
    except Exception:
        return None

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
Você está extraindo informações de eventos a partir de posts do Instagram \
de contas curitibanas (cafés, museus, espaços culturais, coletivos, curadores).

Conta: @{handle}
Data do POST: {post_date}   ← âncora pra datas relativas
Hoje (data do scrape): {today}
Legenda:
{caption}

Sua tarefa: classificar o post em UMA das três categorias:

(A) EVENTO ÚNICO — anuncia algo com data específica em Curitiba/RMC. Ex: \
"Show da Banda X no sábado 26/04 às 21h". Inclui rolês de janela curta \
amarrados a feriado/festival ("Sábado a Quarta, durante o Carnaval", \
"Programação especial de Páscoa quinta a domingo"): use date_start = \
primeiro dia, date_end = último dia, is_recurring=false.

(B) ROTINA RECORRENTE — programação semanal/diária PERPÉTUA, sem fim \
declarado. Só marque como recorrente quando a legenda traz um marcador \
EXPLÍCITO de repetição contínua: "TODA quinta", "TODO sábado", \
"TODAS as quartas", "SEMPRE às sextas", "SEMANALMENTE", "DIARIAMENTE", \
"horário fixo de…". Ex: "Toda quinta tem MPB ao vivo", "Feijoada todo \
sábado", "Happy hour de quinta a domingo das 17h às 21h" (sem janela \
amarrada a um evento específico).

⚠️ EM CASO DE DÚVIDA, PREFIRA (A). Lista de dias da semana SEM marcador \
explícito de repetição contínua (sem "toda/todo/sempre/semanalmente"), \
OU amarrada a um período específico (Carnaval, Páscoa, feriado, recesso, \
"próxima semana", "essa semana"), NÃO é rotina — é janela de evento \
único, use date_start..date_end.

(C) NÃO É EVENTO — foto pessoal, propaganda genérica, recap, lista de dicas.

⚠️ DEFAULT-NOT-EVENT (regra forte): Se a legenda NÃO contém:
  (a) uma data absoluta (ex: "25/04", "21 de abril", "sábado 26/04"), NEM
  (b) uma data relativa concreta (ex: "amanhã", "hoje", "essa quinta", \
"sábado que vem", "neste sábado"), NEM
  (c) um marcador EXPLÍCITO de rotina contínua ("toda quinta", "todos \
os sábados", "sempre às sextas", "diariamente"),

→ classifique como (C) NÃO É EVENTO, mesmo que mencione um dia da semana \
genérico. Posts que só dizem "venha no nosso sábado", "te esperamos no \
fim de semana", "rolê de quinta" SEM data específica nem marcador de \
rotina → propaganda do estabelecimento → NÃO É EVENTO.

Exemplos claros de (C):
- "Entre um café e outro, a gente resolve seu sábado" → propaganda de \
brunch sem data específica → NÃO É EVENTO
- "Te espero no nosso quintal" → propaganda do estabelecimento → \
NÃO É EVENTO
- "Domingo de pizza no nosso forno a lenha" → genérico, sem data nem \
"todo domingo" → NÃO É EVENTO
- "Vem pro nosso jantar" → sem data → NÃO É EVENTO

Em caso de DÚVIDA entre (A) e (C), prefira (C). É melhor perder um \
evento real do que poluir o catálogo com propaganda genérica que vira \
data fantasma.

Para (C) responda {{"is_event": false}}.

Para (A) e (B) responda SOMENTE JSON válido (sem markdown, sem texto extra):
{{
  "is_event": true,
  "is_recurring": false | true,
  "recurrence_label": "<frase curta em pt-BR descrevendo a rotina, ex: 'Toda \
quinta-feira', 'Sextas e sábados, 19h-23h'. null se is_recurring=false>",
  "recurrence_days": [<lista de ISO weekdays 1=segunda...7=domingo, ex: [4] \
para quintas, [5,6] para sex+sab, [1,2,3,4,5,6,7] para diariamente. [] se \
is_recurring=false>],
  "name": "<nome do evento/rotina em português>",
  "description": "<descrição curta em português, máx 200 caracteres>",
  "venue_name": "<local específico, ou nome da conta como fallback>",
  "venue_address": "<endereço/bairro em Curitiba, ou vazio>",
  "neighborhood": "<bairro em Curitiba, ou vazio>",
  "date_start": "<YYYY-MM-DDTHH:MM:SS — ver REGRAS DE DATA abaixo>",
  "date_end": "<YYYY-MM-DDTHH:MM:SS ou null>",
  "price_min": <número, 0 se gratuito>,
  "price_max": <número, 0 se gratuito>
}}

REGRAS DE DATA:

Para EVENTO ÚNICO (is_recurring=false):
1. Se há data ABSOLUTA ("21 de abril", "25/04", "Sábado, 25 de Abril 2026"), \
use ESSA data. Inclui datas na imagem (use a imagem anexada). NÃO recompute.
2. Se há data RELATIVA na legenda ("amanhã", "sábado", "terça que vem"), \
calcule a partir da DATA DO POST ({post_date}), NUNCA da data do scrape \
({today}). Exemplo: post de 16/04 dizendo "terça que vem" → 21/04.
3. Sanity check: data deve estar entre {post_date} e {post_date}+30 dias.
4. Se a legenda menciona apenas "dezembro" ou "em breve" sem data específica, \
responda {{"is_event": false}}.

Para ROTINA RECORRENTE (is_recurring=true):
1. date_start = a PRÓXIMA OCORRÊNCIA da rotina a partir de HOJE ({today}). \
Ex: hoje é segunda e a rotina é "toda quinta" → date_start = próxima quinta \
às hora-da-rotina.
2. Se a rotina cobre múltiplos dias (ex: quinta a domingo), use o PRIMEIRO dia \
após hoje na lista.
3. Use HORÁRIO da rotina se mencionado ("17h-21h" → 17:00); senão padrão por \
tipo (shows/encontros à noite=19:00, tarde=14:00, manhã=10:00).
4. date_end pode ser null para rotinas, OU mesmo dia + horário de término.

Outras regras:
- Eventos/rotinas fora de Curitiba ou RMC → {{"is_event": false}}.
- "Gratuito", "entrada franca", "rolê livre" → preço 0.
- venue_name fallback: nome da conta quando post diz "venha ao nosso lugar" \
sem repetir o local.
- Prefira EVENTO ÚNICO se o post mistura ambos (ex: "esta sexta show da X, e \
toda terça tem open mic"). O evento único é mais time-sensitive.
"""


# Debug capture — top-level keys + a sample of values from the first post
# of the most recent scrape. Surfaced via /admin/apify-debug so we can see
# the actual Apify payload shape without poking through Railway logs.
LAST_POST_DEBUG: dict = {}


async def fetch_events(
    anthropic_api_key: str,
    apify_token: str,
    posts_per_account: int = 5,
    handles: Optional[list[str]] = None,
) -> list[RawEvent]:
    """
    Run the Apify Instagram scraper for every enabled tracked account
    (or just `handles` if given — used by the manual single-handle endpoint),
    then use Claude to extract events from captions.

    Cost-aware pipeline:
      1. Profile-details call — only for handles whose `last_details_at`
         is older than 24h. Skipped entirely when nothing's stale.
      2. Cheap 1-post probe — fetches just the latest post per handle to
         check if there's anything new (compares shortcode to
         last_post_shortcode). Costs ~N results regardless of fanout.
      3. Full posts scrape — only for handles whose latest shortcode
         differs from what we have stored. New handles get a full scrape.

    Never raises — failures degrade gracefully to an empty list.
    """
    if not apify_token:
        log.warning("Instagram (Apify): APIFY_API_TOKEN não configurado — pulando")
        return []
    if not anthropic_api_key:
        log.warning("Instagram (Apify): ANTHROPIC_API_KEY não configurado — pulando")
        return []

    if handles:
        # Manual mode — caller specified a subset
        wanted = {h.strip().lstrip("@").lower() for h in handles if h.strip()}
        accounts = [a for a in db.get_enabled_ig_accounts() if a["handle"] in wanted]
    else:
        accounts = db.get_enabled_ig_accounts()
    if not accounts:
        log.info("Instagram (Apify): nenhuma conta a scrapear")
        return []

    log.info(f"Instagram (Apify): {len(accounts)} accounts no batch...")

    # ── (1) profile-details — only for handles stale > 24h ──
    stale_details = [
        a for a in accounts
        if _details_is_stale(a.get("last_details_at"))
    ]
    if stale_details:
        stale_urls = [f"https://www.instagram.com/{a['handle']}/" for a in stale_details]
        try:
            await _enrich_profiles(apify_token, stale_urls)
            for a in stale_details:
                db.mark_ig_account_details_fresh(a["handle"])
        except Exception as e:
            log.warning(f"Apify profile enrichment failed: {e}")
    else:
        log.info("Instagram (Apify): todos os perfis enriquecidos nas últimas 24h, skip details")

    # ── (2) cheap probe — 1 post per handle to detect new content ──
    probe_urls = [f"https://www.instagram.com/{a['handle']}/" for a in accounts]
    probe_posts = await _run_apify_scrape(apify_token, probe_urls, posts_per_account=1)
    latest_by_handle: dict[str, str] = {}  # handle → shortcode of latest post
    for p in probe_posts:
        h = (p.get("ownerUsername") or "").lower()
        if not h or h in latest_by_handle:
            continue
        sc = _extract_shortcode(p.get("url") or "") or (p.get("id") or "")
        if sc:
            latest_by_handle[h] = sc

    # Decide which handles need a full scrape: shortcode changed vs stored,
    # or we never stored one. Forced scrape (manual mode) refetches all.
    handles_to_fetch: list[str] = []
    for a in accounts:
        h = a["handle"]
        latest = latest_by_handle.get(h)
        prev = (a.get("last_post_shortcode") or "").strip()
        if handles:  # manual mode — always full fetch
            handles_to_fetch.append(h)
            continue
        if not latest:
            # Probe didn't return anything for this handle (private? rate limit?)
            # Skip the full fetch but still mark as scraped so the count stays fresh.
            db.mark_ig_account_scraped(h)
            continue
        if latest != prev:
            handles_to_fetch.append(h)
        else:
            db.mark_ig_account_scraped(h)  # nothing new but we did look

    if not handles_to_fetch:
        log.info("Instagram (Apify): probe encontrou 0 handles com novo conteúdo")
        return []

    log.info(
        f"Instagram (Apify): probe → {len(handles_to_fetch)}/{len(accounts)} "
        f"com posts novos. Buscando {posts_per_account} posts cada..."
    )

    full_urls = [f"https://www.instagram.com/{h}/" for h in handles_to_fetch]
    posts = await _run_apify_scrape(apify_token, full_urls, posts_per_account)
    if not posts:
        log.warning("Instagram (Apify): full scrape retornou 0 posts")
        return []

    log.info(f"Instagram (Apify): {len(posts)} posts coletados, extraindo eventos...")

    # Debug capture: stash a redacted view of the first post so we can
    # introspect actor schema via /admin/apify-debug. Strings are
    # truncated; nested objects keep only their top-level keys.
    if posts:
        sample = posts[0]
        captured = {}
        for k, v in sample.items():
            if isinstance(v, str):
                captured[k] = v[:100] + ("…" if len(v) > 100 else "")
            elif isinstance(v, dict):
                captured[k] = {"<dict-keys>": list(v.keys())[:30]}
            elif isinstance(v, list):
                captured[k] = f"<list len={len(v)}>"
            else:
                captured[k] = v
        LAST_POST_DEBUG.clear()
        LAST_POST_DEBUG.update({
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "top_level_keys": list(sample.keys()),
            "sample": captured,
        })


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
                    # parentData.* fields are added when addParentData=True
                    "parentData.fullName", "parentData.full_name",
                    "ownerFullName", "ownerFullname",
                    "owner.full_name", "owner.fullName",
                ),
                "profile_pic_url": _pick(p,
                    "parentData.profilePicUrl", "parentData.profile_pic_url",
                    "parentData.profilePicUrlHD",
                    "ownerProfilePicUrl", "ownerProfilePicURL", "ownerProfilePicture",
                    "owner.profile_pic_url", "owner.profilePicUrl", "owner.profilePicture",
                ),
            }
    for handle in handles_with_data:
        db.mark_ig_account_scraped(handle)
        # Persist the latest shortcode we saw so the next probe can detect
        # whether anything new shows up — drives the cheap-skip path above.
        if handle in latest_by_handle:
            db.set_ig_account_last_post_shortcode(handle, latest_by_handle[handle])
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
    # external_id is "ig_{handle}_{shortcode}" — but {handle} can contain
    # underscores ("damarate_confeitaria") AND dots ("curiti.kids"), and
    # shortcodes are alphanumeric+dashes. Naive splits get either truncated
    # ("damarate" instead of "damarate_confeitaria") or wrong-handle hits.
    # Match by prefix against the known set of handles we just scraped —
    # robust against any handle character set.
    # (Old code used split("_", 1)[0] which always returned "ig" — so every
    # handle's last_event_count was stuck at 0 since adoption.)
    yields_by_handle: dict[str, int] = {}
    for ev in events:
        if not ev.external_id.startswith("ig_"):
            continue
        tail = ev.external_id[3:]  # strip "ig_" prefix
        for h in handles_with_data:
            if tail.startswith(f"{h}_"):
                yields_by_handle[h] = yields_by_handle.get(h, 0) + 1
                break
    for handle in handles_with_data:
        db.set_ig_account_last_event_count(handle, yields_by_handle.get(handle, 0))

    return events


async def _enrich_profiles(apify_token: str, direct_urls: list[str]) -> None:
    """
    Fetch profile-level data (full name, avatar, bio) via the same
    instagram-scraper actor in `details` mode. Persists to the
    tracked_ig_accounts table. Best-effort — silent on failure.
    """
    payload = {
        "directUrls": direct_urls,
        "resultsType": "details",  # one item per profile, no posts
        "addParentData": False,
    }
    try:
        async with httpx.AsyncClient(timeout=APIFY_TIMEOUT_S) as client:
            r = await client.post(
                f"{APIFY_RUN_URL}?token={apify_token}",
                json=payload,
            )
        if r.status_code not in (200, 201):
            log.warning(f"Apify profile-details HTTP {r.status_code}: {r.text[:200]}")
            return
        items = r.json()
        if not isinstance(items, list):
            return
    except Exception as e:
        log.warning(f"Apify profile-details failed: {e}")
        return

    log.info(f"Apify profile-details: got {len(items)} profile records")

    # Update debug capture with the profile sample so we can verify shape
    if items:
        sample = items[0]
        captured = {}
        for k, v in list(sample.items())[:40]:
            if isinstance(v, str):
                captured[k] = v[:100]
            elif isinstance(v, dict):
                captured[k] = {"<dict-keys>": list(v.keys())[:20]}
            elif isinstance(v, list):
                captured[k] = f"<list len={len(v)}>"
            else:
                captured[k] = v
        LAST_POST_DEBUG["profile_sample"] = captured
        LAST_POST_DEBUG["profile_top_level_keys"] = list(sample.keys())

    def _pick(obj: dict, *paths) -> str:
        for p in paths:
            cur = obj
            for k in p.split("."):
                if not isinstance(cur, dict):
                    cur = None
                    break
                cur = cur.get(k)
            if isinstance(cur, str) and cur.strip():
                return cur.strip()
        return ""

    for item in items:
        handle = (
            (item.get("username") or item.get("ownerUsername") or "")
            .strip().lstrip("@").lower()
        )
        if not handle:
            continue
        display_name = _pick(item, "fullName", "full_name", "ownerFullName")
        profile_pic_url = _pick(
            item,
            "profilePicUrl", "profile_pic_url", "profilePicUrlHD", "profile_pic_url_hd",
            "ownerProfilePicUrl",
        )
        bio_snippet = _pick(item, "biography", "bio")[:500]
        if display_name or profile_pic_url or bio_snippet:
            try:
                db.update_ig_account_profile(
                    handle=handle,
                    display_name=display_name,
                    profile_pic_url=profile_pic_url,
                    bio_snippet=bio_snippet,
                )
            except Exception as e:
                log.warning(f"DB profile update failed for @{handle}: {e}")


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
        # Kept false because addParentData=true blows up the payload
        # enough to bust our 240s sync timeout on 25+ handles. We pull
        # profile metadata via a separate `details` call below.
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

    # Build a multimodal user message — the post image is essential when
    # the date is printed on the poster (extremely common on IG event
    # flyers) and the caption alone is ambiguous ("hoje carai!", etc.).
    # IG's CDN 403s Anthropic's URL fetcher, so we proxy: fetch ourselves
    # with a browser UA and send as base64. Falls back to text-only when
    # the image fetch fails.
    content_blocks: list = [{"type": "text", "text": prompt}]
    if image_url:
        img = await _fetch_image_b64(image_url)
        if img:
            b64, media_type = img
            content_blocks.insert(0, {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": b64,
                },
            })

    try:
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": content_blocks}],
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

    is_recurring = bool(data.get("is_recurring", False))
    recurrence_label = data.get("recurrence_label") or None
    raw_days = data.get("recurrence_days") or []
    recurrence_days = [
        int(d) for d in raw_days
        if isinstance(d, (int, str)) and str(d).strip().isdigit() and 1 <= int(d) <= 7
    ]
    if is_recurring and not recurrence_days:
        # Claude said is_recurring=true but didn't give days — the prompt was
        # ambiguous on this post; treat as one-off so we don't ship a routine
        # we can't roll forward.
        log.debug(f"IG: @{handle}/{shortcode} marked recurring but no days — demoting to one-off")
        is_recurring = False
        recurrence_label = None

    date_start = _parse_iso(data.get("date_start"))
    if not date_start:
        return None
    # Only future events (allowing 12h grace for "happening now" posts).
    # Recurring routines need a future-or-today next-occurrence by definition,
    # so the same filter is correct for both.
    from datetime import timedelta
    if date_start < datetime.now(timezone.utc) - timedelta(hours=12):
        return None

    # Sanity bound: for ONE-OFF events, a post almost never announces something
    # more than ~2 months out. Drop on anchor-mismatch suspicion. Recurring
    # routines are exempt — their next-occurrence is always within 7 days, so
    # the same bound would just be redundant.
    post_dt = _parse_iso(post_date) if post_date else None
    if post_dt and not is_recurring:
        max_window = post_dt + timedelta(days=60)
        if date_start > max_window:
            log.warning(
                f"IG: dropping @{handle}/{shortcode} — date_start {date_start.date()} "
                f"is >60d after post_date {post_dt.date()} (anchor mismatch?)"
            )
            return None

    # ── Post-LLM validation gates ────────────────────────────────
    # The prompt asks for date markers but Claude Haiku occasionally
    # hallucinates a date for venue-promo posts that should have been
    # classified as (C) NÃO É EVENTO. Drop two failure modes the prompt
    # alone can't catch reliably:
    #
    #  (1) ONE-OFF without a date marker in the caption — every
    #      legitimate one-off announcement names a specific day
    #      ("sábado 10/05", "amanhã 19h", "neste sábado", "26/04"
    #      etc.). If neither a numeric date nor a "next-Saturday-ish"
    #      relative phrase appears, Claude is guessing.
    #
    #  (2) Caption mentions ONE weekday (e.g. "sábado") but the
    #      extracted date_start lands on a DIFFERENT weekday. That's
    #      a clear hallucination — drop.
    #
    # Logged at WARNING so the founder can spot patterns in Railway
    # logs ("@letseggs keeps producing one-offs without date markers"
    # → review the source's content style).
    caption_lower = (caption or "").lower()
    if not is_recurring:
        # (1) Date-marker presence check. Cheap regex set covering the
        #     concrete patterns the prompt enumerates.
        DATE_MARKERS = [
            r"\b\d{1,2}[/.-]\d{1,2}",                             # 25/04, 25.04, 25-04
            r"\b\d{1,2}\s+de\s+(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)",
            r"\bamanh[aã]\b",
            r"\bhoje\b",
            r"\b(?:nesse|neste|essa|esta|este|nessa)\s+(?:s[aá]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta)\b",
            r"\b(?:s[aá]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta)\s+que\s+vem\b",
            r"\b(?:s[aá]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta)\s+\d{1,2}",  # "sábado 10"
            r"\b\d{1,2}h\b",  # at-least-a-time anchors a same-day post
        ]
        if not any(re.search(p, caption_lower) for p in DATE_MARKERS):
            log.warning(
                f"IG: dropping @{handle}/{shortcode} — one-off w/o date marker in caption "
                f"(LLM picked {date_start.date()} {date_start.strftime('%H:%M')} "
                f"but caption has no concrete date)"
            )
            return None

        # (2) Weekday cross-check.
        WEEKDAY_RE = {
            0: r"\bsegunda[-\s]?(?:feira)?\b",
            1: r"\bter[cç]a[-\s]?(?:feira)?\b",
            2: r"\bquarta[-\s]?(?:feira)?\b",
            3: r"\bquinta[-\s]?(?:feira)?\b",
            4: r"\bsexta[-\s]?(?:feira)?\b",
            5: r"\bs[aá]bado\b",
            6: r"\bdomingo\b",
        }
        mentioned = {wd for wd, pat in WEEKDAY_RE.items() if re.search(pat, caption_lower)}
        if mentioned:
            ds_weekday = date_start.weekday()  # 0=Mon..6=Sun
            if ds_weekday not in mentioned:
                names = {0: "seg", 1: "ter", 2: "qua", 3: "qui", 4: "sex", 5: "sáb", 6: "dom"}
                log.warning(
                    f"IG: dropping @{handle}/{shortcode} — weekday mismatch: caption mentions "
                    f"{[names[w] for w in sorted(mentioned)]} but LLM extracted "
                    f"{names[ds_weekday]} ({date_start.date()})"
                )
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
        is_recurring=is_recurring,
        recurrence_label=recurrence_label,
        recurrence_days=recurrence_days,
    )


def _extract_shortcode(url: str) -> str:
    """Pull the shortcode out of an instagram.com/p/<code>/ URL."""
    m = re.search(r"/p/([A-Za-z0-9_-]+)", url)
    return m.group(1) if m else ""


def _details_is_stale(iso_str: Optional[str]) -> bool:
    """Profile-details counts as stale when it was never run or > 24h ago."""
    if not iso_str:
        return True
    try:
        last = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    from datetime import timedelta
    return (datetime.now(timezone.utc) - last) > timedelta(hours=24)


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
