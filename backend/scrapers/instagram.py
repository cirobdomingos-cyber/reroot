"""
Instagram hashtag scraper for local events.

Uses instaloader to pull public posts from event-related hashtags,
then Claude extracts structured event data from captions.

This is an unstructured-to-structured pipeline — the interesting part
for interviews. Instagram captions are messy free text; Claude turns
them into RawEvent objects with date, venue, price, etc.

Portfolio signal: LLM-powered data extraction from unstructured sources
is a high-demand pattern in analytics engineering and AI engineering roles.
"""
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import instaloader
from anthropic import Anthropic
from models import RawEvent

log = logging.getLogger(__name__)

# Hashtags that surface events in Curitiba relevant to Reroot
DEFAULT_HASHTAGS = [
    "eventoscuritiba",
    "curitibacultural",
    "oquefazeremcuritiba",
    "curitibacriativa",
    "yogacuritiba",
    "oficinascuritiba",
    "feiracuritiba",
]

# Claude prompt to extract event details from an Instagram caption
EXTRACTION_PROMPT = """\
You are extracting structured event information from an Instagram post caption.
The post is from Curitiba, Brazil. Extract event details if the caption describes
a specific event (with date, time, place). If the caption is NOT about a specific
event (e.g., it's a personal post, ad, or generic content), respond with: {{"is_event": false}}

Caption:
{caption}

Post date: {post_date}
Hashtags: {hashtags}
Likes: {likes}

Respond ONLY with valid JSON (no markdown, no extra text):
{{
  "is_event": true,
  "name": "<event name>",
  "description": "<brief description in Portuguese, max 200 chars>",
  "venue_name": "<venue/location name or empty>",
  "venue_address": "<address if mentioned or empty>",
  "neighborhood": "<neighborhood if mentioned or empty>",
  "date_start": "<YYYY-MM-DDTHH:MM:SS or best guess based on caption and post date>",
  "date_end": "<YYYY-MM-DDTHH:MM:SS or null>",
  "price_min": <number or 0>,
  "price_max": <number or 0>,
  "currency": "BRL"
}}

Rules:
- If the caption says "sábado" or "domingo" without a specific date, calculate from the post date
- If no time is mentioned, default to 10:00 for morning events, 14:00 for afternoon, 19:00 for evening
- If the event date appears to be in the past, respond with {{"is_event": false}}
- "Gratuito" or "entrada franca" means price 0
- Extract the venue name even if informal (e.g., "no Parque Barigui" → venue_name: "Parque Barigui")
"""


async def fetch_events(
    anthropic_api_key: str,
    city: str = "Curitiba",
    hashtags: list[str] | None = None,
    max_posts_per_hashtag: int = 10,
    max_events: int = 20,
    ig_username: str = "",
    ig_password: str = "",
) -> list[RawEvent]:
    """
    Scrape Instagram hashtags and extract events using Claude.

    Flow:
      1. instaloader pulls recent posts from each hashtag (login required)
      2. Claude analyzes each caption → is it an event? extract details
      3. Valid events become RawEvent objects
    """
    if not anthropic_api_key:
        log.warning("ANTHROPIC_API_KEY required for Instagram extraction — skipping.")
        return []

    tags = hashtags or DEFAULT_HASHTAGS
    client = Anthropic(api_key=anthropic_api_key)
    loader = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        quiet=True,
    )

    # Instagram requires login for hashtag browsing
    if ig_username and ig_password:
        try:
            loader.login(ig_username, ig_password)
            log.info(f"Instagram: logged in as {ig_username}")
        except instaloader.exceptions.BadCredentialsException:
            log.error("Instagram: bad credentials — check INSTAGRAM_USER/INSTAGRAM_PASS")
            return []
        except instaloader.exceptions.TwoFactorAuthRequiredException:
            log.error("Instagram: 2FA required — disable 2FA or use a session file")
            return []
        except Exception as e:
            log.error(f"Instagram: login failed — {e}")
            return []
    else:
        log.warning(
            "Instagram: INSTAGRAM_USER/INSTAGRAM_PASS not set — "
            "login is required for hashtag search. Skipping."
        )
        return []

    # Collect unique posts across all hashtags
    seen_shortcodes: set[str] = set()
    captions: list[dict] = []

    for tag in tags:
        log.info(f"Instagram: fetching #{tag}...")
        try:
            hashtag = instaloader.Hashtag.from_name(loader.context, tag)
            count = 0
            for post in hashtag.get_posts():
                if post.shortcode in seen_shortcodes:
                    continue
                seen_shortcodes.add(post.shortcode)

                # Skip posts older than 60 days
                if post.date_utc < datetime.now(timezone.utc) - timedelta(days=60):
                    continue

                caption = post.caption or ""
                if len(caption) < 30:
                    continue  # Too short to be an event post

                captions.append({
                    "shortcode": post.shortcode,
                    "caption": caption[:1500],
                    "post_date": post.date_utc.isoformat(),
                    "hashtags": " ".join(f"#{t}" for t in (post.caption_hashtags or [])),
                    "likes": post.likes,
                    "url": f"https://www.instagram.com/p/{post.shortcode}/",
                    "image_url": post.url,
                    "owner": post.owner_username,
                })

                count += 1
                if count >= max_posts_per_hashtag:
                    break

            log.info(f"  #{tag}: {count} posts collected")

        except instaloader.exceptions.QueryReturnedNotFoundException:
            log.warning(f"  #{tag}: hashtag not found")
        except instaloader.exceptions.ConnectionException as e:
            log.warning(f"  #{tag}: connection error — {e}")
            break  # Likely rate-limited, stop trying more hashtags
        except Exception as e:
            log.warning(f"  #{tag}: unexpected error — {e}")

    log.info(f"Instagram: {len(captions)} candidate posts collected, extracting events with Claude...")

    # Extract events from captions using Claude
    events: list[RawEvent] = []
    for item in captions[:max_events * 2]:  # Process extra since many won't be events
        if len(events) >= max_events:
            break

        raw = _extract_event(client, item)
        if raw:
            events.append(raw)

    log.info(f"Instagram: {len(events)} events extracted from {len(captions)} posts")
    return events


def _extract_event(client: Anthropic, post: dict) -> Optional[RawEvent]:
    """Use Claude to extract event details from a single post caption."""
    prompt = EXTRACTION_PROMPT.format(
        caption=post["caption"],
        post_date=post["post_date"],
        hashtags=post["hashtags"],
        likes=post["likes"],
    )

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        raw_json = response.content[0].text.strip()
        data = json.loads(raw_json)
    except json.JSONDecodeError as e:
        log.warning(f"Claude returned invalid JSON for post {post['shortcode']}: {e}")
        return None
    except Exception as e:
        log.error(f"Claude API error for post {post['shortcode']}: {e}")
        return None

    if not data.get("is_event", False):
        return None

    # Parse dates
    try:
        date_start = datetime.fromisoformat(data["date_start"])
        if date_start.tzinfo is None:
            date_start = date_start.replace(tzinfo=timezone.utc)
    except (ValueError, KeyError):
        log.warning(f"Invalid date for post {post['shortcode']}: {data.get('date_start')}")
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

    return RawEvent(
        source="instagram",
        external_id=post["shortcode"],
        name=data.get("name", "")[:200],
        description=data.get("description", "")[:1000],
        venue_name=data.get("venue_name", "") or post.get("owner", ""),
        venue_address=data.get("venue_address", ""),
        neighborhood=data.get("neighborhood"),
        city="Curitiba",
        date_start=date_start,
        date_end=date_end,
        price_min=float(data.get("price_min", 0)),
        price_max=float(data.get("price_max", 0)),
        currency=data.get("currency", "BRL"),
        capacity=None,
        attendees_confirmed=post.get("likes"),
        url=post["url"],
        image_url=post.get("image_url"),
    )
