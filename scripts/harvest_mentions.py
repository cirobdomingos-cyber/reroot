"""Discover new Curitiba IG handles by harvesting mentions + hashtags.

Why this exists: hand-guessing handles ("teatropaiol", "memorialdecuritiba", ...)
hit ~5% accuracy in our 2026-04 trial. Two algorithmic strategies do much better:

  1. Mention harvesting — for handles ALREADY producing events, scrape recent
     post captions and extract `@mentions`. Mentions are the social graph;
     they surface real handles in our network.

  2. Hashtag harvesting — for broad+narrow Curitiba tags, list top posters.
     This deliberately reaches OUTSIDE the existing handle graph to break
     the social bubble (current top yielders skew Batel/Centro/indie/middle
     class — hashtags like #cicrolando, #funkcuritiba, #culturanegracwb pull
     in periphery, hip-hop, black culture, LGBTQIA+, etc).

Output: a ranked CSV at c:/tmp/ig_candidates.csv. Founder eyeballs it, copies
good handles into the admin UI. No automatic adds — keeping the human in the
loop while we calibrate.

Cost per run: ~$0.10 of Apify credit. Cadence: monthly.

Run from repo root:
    APIFY_TOKEN=apify_... AUE_BASE=https://reroot-production.up.railway.app \
    py -3.12 scripts/harvest_mentions.py
"""
from __future__ import annotations
import csv
import json
import os
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from typing import Optional

# ─── Config ───────────────────────────────────────────────────────────────

APIFY_TOKEN = os.environ.get("APIFY_TOKEN", "")
AUE_BASE = os.environ.get("AUE_BASE", "https://reroot-production.up.railway.app")
OUT_PATH = os.environ.get("OUT_PATH", "c:/tmp/ig_candidates.csv")

APIFY_RUN_URL = (
    "https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items"
)
APIFY_TIMEOUT_S = 300
POSTS_PER_HANDLE = 30
TOP_N_TO_VERIFY = 30
MIN_FOLLOWERS = 500  # filter out personal/dead accounts after verification

# Hashtag pool — deliberately mixed to break the social bubble.
# Broad tags surface mainstream Curitiba accounts; narrow tags reach
# underrepresented communities (periphery, black culture, LGBTQIA+, etc).
HASHTAGS_BROAD = [
    "curitibacultural", "cwbacontece", "rolescuritiba",
    "curitibanas", "agendacwb",
]
HASHTAGS_DIVERSITY = [
    # Bairros populares / periphery
    "cicrolando", "boqueirao", "sitiocercado",
    # Genres outside the current catalog skew
    "funkcuritiba", "hiphopcwb", "sertanejocwb",
    # Cultural communities
    "culturanegracwb", "cwblgbt", "evangelicoscuritiba",
    # Demographics
    "familiacuritiba", "terceiraidade",
    # Active / sports
    "peladacwb", "corredorescuritiba",
]
HASHTAGS = HASHTAGS_BROAD + HASHTAGS_DIVERSITY

# Mentions to ignore: nationally famous accounts that pollute Curitiba feeds
# without being Curitiba-specific. Trim conservatively.
NATIONAL_DENYLIST = {
    "anitta", "globo", "ig", "instagram", "natura", "boticario", "magalu",
    "spotify", "netflix", "uber", "ifood", "nubank", "petrobras", "sanepar_pr",
    "ronaldo", "neymarjr", "youtube", "tiktok", "facebookbrasil",
}

MENTION_RE = re.compile(r"@([a-zA-Z0-9._]+)")

# ─── Helpers ──────────────────────────────────────────────────────────────


def _http_json(url: str, *, data: Optional[dict] = None, timeout: int = 30) -> dict:
    """POST JSON if data given, else GET. Returns parsed JSON. Raises on error."""
    headers = {"Content-Type": "application/json; charset=utf-8"}
    body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data else None
    req = urllib.request.Request(
        url, data=body, headers=headers, method="POST" if body else "GET"
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_productive_handles() -> list[dict]:
    """Pull handles with at least 1 future event from /sources."""
    sources = _http_json(f"{AUE_BASE}/sources")
    productive = [
        s for s in sources.get("instagram", [])
        if s.get("future_events", 0) >= 1
    ]
    productive.sort(key=lambda s: -s["future_events"])
    return productive


def fetch_tracked_handles() -> set[str]:
    """All currently-tracked handles (productive + dormant)."""
    sources = _http_json(f"{AUE_BASE}/sources")
    return {s["handle"].lower() for s in sources.get("instagram", [])}


def apify_run(payload: dict, *, timeout: int = APIFY_TIMEOUT_S) -> list[dict]:
    """Run the instagram-scraper actor synchronously, return dataset items.

    Returns [] on timeout — hashtag scrapes hit Apify's per-run sync timeout
    occasionally, and one slow batch shouldn't fail the whole harvest.
    """
    if not APIFY_TOKEN:
        print("ERROR: APIFY_TOKEN not set", file=sys.stderr)
        sys.exit(1)
    url = f"{APIFY_RUN_URL}?token={APIFY_TOKEN}"
    try:
        items = _http_json(url, data=payload, timeout=timeout)
    except (TimeoutError, OSError) as e:
        print(f"  ! Apify call timed out after {timeout}s: {e}", file=sys.stderr)
        return []
    if not isinstance(items, list):
        print(f"WARN: Apify returned {type(items).__name__}", file=sys.stderr)
        return []
    return items


def harvest_mentions(productive_handles: list[dict]) -> tuple[Counter, Counter, dict[str, str]]:
    """Mention frequency, weighted by source-handle yield AND dampened for
    cluster posts (one big "thanks @x @y @z..." post shouldn't dominate).

    Anti-bubble dampening:
      - score per mention ∝ 1 / sqrt(N) where N is the total mention count
        in that post. A post tagging 1 friend → full weight; a post tagging
        20 → each mention worth ~0.22× full. This kills the "anniversary
        post tagged 20 people" problem we saw in the first run.
      - same handle mentioned in same caption text only counts once per
        caption (de-dupes reposts and "swipe to see more" cluster posts).

    A mention from a handle that produces 4 events still counts 4× more
    than from a 1-event handle — yield-weighting is preserved.
    """
    import math
    urls = [
        f"https://www.instagram.com/{h['handle']}/" for h in productive_handles
    ]
    payload = {
        "directUrls": urls,
        "resultsType": "posts",
        "resultsLimit": POSTS_PER_HANDLE,
        "addParentData": False,
    }
    print(f"  Apify posts scrape: {len(urls)} handles × {POSTS_PER_HANDLE} posts...")
    posts = apify_run(payload)
    print(f"  → {len(posts)} posts returned")

    yield_by_owner = {h["handle"].lower(): h["future_events"] for h in productive_handles}
    weighted: Counter = Counter()
    raw: Counter = Counter()
    sample_caption_for: dict[str, str] = {}
    seen_in_caption: set[tuple[str, str]] = set()  # (caption_hash, mention)

    for p in posts:
        owner = (p.get("ownerUsername") or "").lower()
        caption = p.get("caption") or ""
        if not caption:
            continue
        caption_key = caption[:80]  # dedup near-identical reposts
        owner_weight = max(1, yield_by_owner.get(owner, 1))

        mentions_in_post = [m.lower() for m in MENTION_RE.findall(caption)]
        # Dedup per caption — a "tag everyone" post shouldn't quintuple-count
        unique_mentions = []
        for m in mentions_in_post:
            if m == owner:
                continue
            key = (caption_key, m)
            if key in seen_in_caption:
                continue
            seen_in_caption.add(key)
            unique_mentions.append(m)

        if not unique_mentions:
            continue
        # Dampen by post fan-out — sqrt makes a 20-tag post worth ~4.5× a
        # 1-tag post per mention, instead of 20× as before.
        fanout_dampener = 1.0 / math.sqrt(len(unique_mentions))

        for mention in unique_mentions:
            raw[mention] += 1
            weighted[mention] += owner_weight * fanout_dampener
            if mention not in sample_caption_for:
                sample_caption_for[mention] = caption[:200].replace("\n", " ")

    return weighted, raw, sample_caption_for


def harvest_hashtags() -> tuple[Counter, dict[str, str]]:
    """Top posters under each Curitiba hashtag, with diversity tags weighted up.

    Diversity hashtags get a 2× weight so they surface even if their post
    counts are lower than the broad tags. This is the explicit anti-bubble
    knob — turn it up if the catalog skews mainstream.

    Hashtag scraping is slower than profile scraping on Apify's side. We
    split into batches of 5 tags so a single slow batch doesn't time out
    the whole pool — partial results are still useful.
    """
    counter: Counter = Counter()
    sample_for: dict[str, str] = {}
    diversity_set = set(HASHTAGS_DIVERSITY)
    batch_size = 5

    all_posts: list[dict] = []
    for i in range(0, len(HASHTAGS), batch_size):
        batch = HASHTAGS[i:i + batch_size]
        urls = [f"https://www.instagram.com/explore/tags/{t}/" for t in batch]
        payload = {
            "directUrls": urls,
            "resultsType": "posts",
            "resultsLimit": 15,
            "addParentData": False,
        }
        print(f"  Apify hashtag batch {i // batch_size + 1}: {batch}")
        posts = apify_run(payload, timeout=240)
        print(f"    → {len(posts)} posts")
        all_posts.extend(posts)
        # Apify's instagram-scraper actor lost reliable hashtag-page support
        # when Instagram tightened unauthenticated access in 2023. If the
        # first batch returns 0 there's no point burning further timeouts.
        if i == 0 and len(posts) == 0:
            print("    (first batch empty — Apify hashtag pages likely unavailable; skipping rest)")
            break

    print(f"  Total: {len(all_posts)} posts across {len(HASHTAGS)} tags")

    for p in all_posts:
        owner = (p.get("ownerUsername") or "").lower()
        if not owner:
            continue
        src_tag = ""
        for tag in HASHTAGS:
            if tag in (p.get("inputUrl") or ""):
                src_tag = tag
                break
        weight = 2 if src_tag in diversity_set else 1
        counter[owner] += weight
        if owner not in sample_for:
            sample_for[owner] = f"#{src_tag}: {(p.get('caption') or '')[:150]}"

    return counter, sample_for


def verify_candidates(handles: list[str]) -> dict[str, dict]:
    """Apify profile-details for the candidate handles. Returns handle → metadata."""
    if not handles:
        return {}
    urls = [f"https://www.instagram.com/{h}/" for h in handles]
    payload = {
        "directUrls": urls,
        "resultsType": "details",
        "addParentData": False,
    }
    print(f"  Apify profile-details: verifying {len(handles)} candidates...")
    items = apify_run(payload)
    found = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        u = (it.get("username") or "").lower().strip()
        if not u:
            continue
        if it.get("error") or it.get("errorMessage"):
            continue
        found[u] = {
            "name": (it.get("fullName") or "").strip(),
            "bio": (it.get("biography") or "").replace("\n", " ").strip()[:200],
            "followers": it.get("followersCount") or 0,
            "posts": it.get("postsCount") or 0,
            "private": bool(it.get("private")),
        }
    print(f"  → {len(found)} verified, {len(handles) - len(found)} missing/private")
    return found


def looks_curitiba(meta: dict) -> bool:
    """Heuristic: bio mentions Curitiba/CWB/PR or location signals."""
    blob = (meta.get("bio", "") + " " + meta.get("name", "")).lower()
    if any(t in blob for t in ("curitiba", "cwb", " pr ", "/pr", "paraná", "parana")):
        return True
    return False


# Personal-account bio signals — DJs, photographers, filmmakers tend to
# get mentioned a lot but they're individuals, not venues/curators we'd
# want in the catalog. We keep them visible in the CSV but de-rank below
# venue candidates.
_PERSONAL_BIO_TERMS = (
    "filmmaker", "fotógraf", "fotograf", "photographer", "videomaker",
    "diretor", "director", "produtora visual", "creator", "creative",
    "tatuador", "tattoo", "designer", "ilustrador", "illustrator",
    "modelo", "influencer", "atriz", "ator ",
)
_VENUE_BIO_TERMS = (
    "espaço", "espaco", "casa de", "shopping", "centro cultural", "ccc ",
    "cinema", "teatro", "galeria", "livraria", "café", "cafe ", "restaurante",
    "produtora", "coletivo", "collective", "festival", "feira", "evento",
    "events ", "agenda", "guia", "rolê", "role ", "ingresso", "ingressos",
    "bar ", "boteco", "studio", "estúdio", "venue", "club ", "clube",
)


def classify_account(meta: dict) -> str:
    """Returns 'venue', 'personal', or 'unknown' based on bio + name + posts.

    Used to bias ranking: venues get score ×1.0, unknowns ×0.6, personal ×0.3.
    Not a hard filter — surfaces in CSV either way so the curator can override.
    """
    bio = meta.get("bio", "").lower()
    name = meta.get("name", "").lower()
    blob = bio + " " + name
    posts = meta.get("posts", 0)

    venue_hits = sum(1 for t in _VENUE_BIO_TERMS if t in blob)
    personal_hits = sum(1 for t in _PERSONAL_BIO_TERMS if t in blob)

    # Strong signal in either direction wins
    if venue_hits >= 1 and personal_hits == 0:
        return "venue"
    if personal_hits >= 1 and venue_hits == 0:
        return "personal"
    if venue_hits > personal_hits:
        return "venue"
    if personal_hits > venue_hits:
        return "personal"
    # Tied / unknown — use post count as weak signal: venues post more.
    if posts > 500:
        return "venue"
    if posts < 100:
        return "personal"
    return "unknown"


def diversity_audit(productive_handles: list[dict]) -> dict[str, int]:
    """Crude bucket count by category metadata on tracked handles.

    This is best-effort — the `category` field is curator-set free text. We
    just count to surface skew. The user reads the output and decides what
    bucket needs more representation in the next harvest.
    """
    buckets = Counter()
    for h in productive_handles:
        cat = (h.get("category") or "").strip().lower() or "(unset)"
        buckets[cat] += 1
    return buckets


# ─── Main ─────────────────────────────────────────────────────────────────


def main() -> int:
    print(f"Connecting to {AUE_BASE}...")
    productive = fetch_productive_handles()
    tracked = fetch_tracked_handles()
    print(f"  {len(productive)} productive handles (≥1 event), {len(tracked)} tracked total")

    if not productive:
        print("No productive handles — aborting", file=sys.stderr)
        return 1

    print("\n[1/4] Harvesting mentions from productive handles...")
    weighted, raw, mention_samples = harvest_mentions(productive)

    print("\n[2/4] Harvesting hashtags (anti-bubble pool)...")
    hashtag_counts, hashtag_samples = harvest_hashtags()

    print("\n[3/4] Combining + filtering pools...")
    # Combine: mention score + hashtag score (hashtag-only candidates are valid;
    # they're the bubble-breakers we explicitly want to surface).
    combined = Counter()
    for h, w in weighted.items():
        combined[h] += w
    for h, w in hashtag_counts.items():
        combined[h] += w

    # Filter: drop self/already-tracked/national denylist
    own_handles = {h["handle"].lower() for h in productive}
    candidates = []
    for h, score in combined.most_common():
        if h in tracked or h in own_handles or h in NATIONAL_DENYLIST:
            continue
        if not re.match(r"^[a-zA-Z0-9._]{2,30}$", h):
            continue
        candidates.append((h, score))

    print(f"  {len(candidates)} unique candidates after filters")
    print(f"  Top 5 raw: " + ", ".join(f"@{h}({s})" for h, s in candidates[:5]))

    print(f"\n[4/4] Verifying top {TOP_N_TO_VERIFY} via Apify profile-details...")
    top = candidates[:TOP_N_TO_VERIFY]
    verified = verify_candidates([h for h, _ in top])

    # Build final ranked list with kind-aware scoring
    _KIND_BIAS = {"venue": 1.0, "unknown": 0.6, "personal": 0.3}
    rows = []
    for h, score in top:
        meta = verified.get(h)
        if not meta:
            continue  # missing/private — skip
        if meta["private"]:
            continue
        if meta["followers"] < MIN_FOLLOWERS:
            continue
        is_cwb_ish = looks_curitiba(meta)
        kind = classify_account(meta)
        adjusted = round(score * _KIND_BIAS[kind], 2)
        rows.append({
            "handle": h,
            "kind": kind,
            "score": score,
            "adj_score": adjusted,
            "followers": meta["followers"],
            "posts": meta["posts"],
            "name": meta["name"],
            "bio_or_sample": meta["bio"][:120],
            "looks_curitiba": "yes" if is_cwb_ish else "?",
            "from_mentions": raw.get(h, 0),
            "from_hashtags": hashtag_counts.get(h, 0),
            "sample_caption": (
                mention_samples.get(h)
                or hashtag_samples.get(h)
                or ""
            )[:200],
        })

    # Sort: Curitiba-ish + venue first, then unknowns, then personal accounts.
    rows.sort(key=lambda r: (
        0 if r["looks_curitiba"] == "yes" else 1,
        {"venue": 0, "unknown": 1, "personal": 2}[r["kind"]],
        -r["adj_score"],
    ))

    # Diversity audit on currently-productive handles
    print("\n=== DIVERSITY AUDIT (productive handles by category) ===")
    audit = diversity_audit(productive)
    for cat, n in audit.most_common():
        bar = "█" * n
        print(f"  {cat:20s} {n:2d} {bar}")
    if audit:
        top_share = audit.most_common(1)[0][1] / sum(audit.values())
        if top_share > 0.4:
            print(f"  ⚠ top bucket {top_share:.0%} of catalog — bias next harvest toward underrepresented categories")

    # Write CSV
    print(f"\n=== WRITING {len(rows)} CANDIDATES → {OUT_PATH} ===")
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else
                                ["handle", "score", "followers", "posts", "name",
                                 "bio_or_sample", "looks_curitiba",
                                 "from_mentions", "from_hashtags", "sample_caption"])
        writer.writeheader()
        writer.writerows(rows)

    # Console preview — top 20, grouped by kind
    print(f"\n=== TOP 20 PREVIEW (venue → unknown → personal) ===")
    KIND_ICON = {"venue": "🏛", "unknown": "?", "personal": "👤"}
    for r in rows[:20]:
        flag = "✓" if r["looks_curitiba"] == "yes" else " "
        kind_icon = KIND_ICON[r["kind"]]
        print(f"  {flag}{kind_icon} @{r['handle']:25s}  {r['followers']:>7,}flw  "
              f"adj={r['adj_score']:>5}  raw={r['score']:>5}  m={r['from_mentions']:>2}  "
              f"{r['name'][:30]}")
    print(f"\nFull CSV: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
