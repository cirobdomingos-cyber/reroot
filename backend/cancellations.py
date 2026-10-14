"""
Cancellation and postponement detection for the Instagram catalog.

Why this exists: each Instagram post is read once (processed_ig_posts), so
when a venue calls a night off in a LATER post, the event it announced
stayed in the catalog. On 2026-10-15 Maite Livros (@maitelivros) cancelled
"Piquenique com Livros" on its own feed; auê kept listing it and it went
into an @auecuritiba post.

Grain: one Instagram post in, zero or more catalog rows of the SAME handle
marked cancelled (hidden, row kept) or moved to a new date.

Pipeline, cheapest first:
  1. `looks_like_cancellation(caption)` — keyword pre-filter. Only posts
     that pass it get the extra prompt section and reach the matcher, so
     the 99% of posts that are ordinary announcements cost nothing extra.
  2. Signal: the extraction LLM's `cancels` field when it answered one;
     otherwise `regex_signal(caption)` (the fallback, and what tests use).
  3. `match_events()` — upcoming events (next ~30 days) of the posting
     handle, scored on name overlap and date hints. Only a confident,
     unambiguous winner is touched.
  4. `apply()` — cancel (hide) or postpone (move the date, pinned).
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)

_CWB_TZ = ZoneInfo("America/Sao_Paulo")

# How far ahead a cancellation post can reach. A venue cancels what it
# announced for the coming weeks; anything later is a different season.
MATCH_WINDOW_DAYS = 30
# Score a candidate needs, and the lead it needs over the runner-up.
MIN_SCORE = 1.0
MIN_MARGIN = 0.25


def _fold(text: str) -> str:
    """Lowercase, accents stripped — 'Não vai rolar' == 'nao vai rolar'."""
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


# Stems on accent-folded text. "cancelad" covers cancelado/a/os/as,
# "adiad" adiado/a, "suspens" suspenso/suspensão, "remarcad" remarcado.
_CANCEL_PATTERNS = [
    r"\bcancelad[oa]s?\b", r"\bcancelamos\b", r"\bcancelamento\b",
    r"\bfoi cancelad", r"\bprecisamos cancelar\b", r"\bvamos cancelar\b",
    r"\bnao vai (?:mais )?rolar\b", r"\bnao vai (?:mais )?acontecer\b",
    r"\bnao acontecera\b", r"\bnao havera\b",
    r"\bsuspens[oa]s?\b", r"\bsuspensao\b", r"\bsuspendemos\b",
]
_POSTPONE_PATTERNS = [
    r"\badiad[oa]s?\b", r"\badiamos\b", r"\badiamento\b",
    r"\bremarcad[oa]s?\b", r"\bremarcamos\b", r"\bnova data\b",
    r"\btransferid[oa] para\b",
]
_CANCEL_RE = re.compile("|".join(_CANCEL_PATTERNS))
_POSTPONE_RE = re.compile("|".join(_POSTPONE_PATTERNS))


def looks_like_cancellation(caption: str) -> bool:
    """Cheap pre-filter: does the caption use cancellation/postponement words?"""
    folded = _fold(caption)
    return bool(_CANCEL_RE.search(folded) or _POSTPONE_RE.search(folded))


# Appended to the extraction prompt ONLY when the pre-filter fires, so the
# common case pays no extra tokens. Literal braces are doubled because the
# base prompt goes through str.format.
PROMPT_ADDENDUM = """

⚠️ ESTE POST PODE ANUNCIAR UM CANCELAMENTO OU ADIAMENTO de um evento que a \
conta já divulgou ("cancelado", "adiado", "não vai rolar", "suspenso", \
"remarcado", "nova data"). Neste caso, SEMPRE inclua no JSON o campo \
"cancels" (mesmo quando is_event=false):
"cancels": {{
  "is_cancellation": true | false,   ← true só se o post cancela/adia um evento específico desta conta
  "kind": "cancelled" | "postponed",
  "event_name": "<nome do evento cancelado/adiado, como a conta chamou>",
  "event_date": "<YYYY-MM-DD data ORIGINAL do evento, ou null>",
  "new_date_start": "<YYYY-MM-DDTHH:MM:SS nova data se adiado e a nova data foi dada, ou null>"
}}
O evento cancelado NÃO entra em "events". Se o post só avisa o \
cancelamento, responda {{"is_event": false, "cancels": {{...}}}}. Post que \
só usa a palavra de passagem ("sem cancelamento, chova ou faça sol") → \
"is_cancellation": false.
"""


@dataclass
class CancelSignal:
    kind: str                                   # 'cancelled' | 'postponed'
    event_name: str = ""
    dates: list = field(default_factory=list)   # date objects the post refers to
    weekdays: set = field(default_factory=set)  # 0=Mon..6=Sun
    new_start: Optional[datetime] = None
    detector: str = "regex"                     # 'llm' | 'regex'


_MONTHS = {
    "jan": 1, "fev": 2, "mar": 3, "abr": 4, "mai": 5, "jun": 6,
    "jul": 7, "ago": 8, "set": 9, "out": 10, "nov": 11, "dez": 12,
}
_WEEKDAYS = {
    0: r"\bsegunda\b", 1: r"\bterca\b", 2: r"\bquarta\b", 3: r"\bquinta\b",
    4: r"\bsexta\b", 5: r"\bsabado\b", 6: r"\bdomingo\b",
}
_NUM_DATE = re.compile(r"\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b")
_WORD_DATE = re.compile(
    r"\b(\d{1,2})\s+de\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\b"
)
# "adiado para 24/10", "nova data: 24/10", "remarcado para o dia 24 de outubro"
_NEW_DATE_LEAD = re.compile(
    r"(?:para|pra|nova data|remarcad[oa]|transferid[oa])\s*(?:[:\-]\s*)?(?:o\s+)?(?:dia\s+)?"
    r"(?:(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?,?\s*)?$"
)
_TIME = re.compile(r"\b(\d{1,2})h(\d{2})?\b|\b(\d{1,2}):(\d{2})\b")


def _date_in_year(day: int, month: int, year: Optional[int], ref: datetime):
    """dd/mm without a year: the occurrence nearest after the post (a post
    in late December saying 05/01 means next January)."""
    try:
        if year:
            year = year + 2000 if year < 100 else year
            return datetime(year, month, day).date()
        d = datetime(ref.year, month, day).date()
        if d < ref.date() - timedelta(days=60):
            d = datetime(ref.year + 1, month, day).date()
        return d
    except ValueError:
        return None


def _dates_with_pos(folded: str, ref: datetime) -> list:
    out = []
    for m in _NUM_DATE.finditer(folded):
        d = _date_in_year(int(m.group(1)), int(m.group(2)),
                          int(m.group(3)) if m.group(3) else None, ref)
        if d:
            out.append((m.start(), m.end(), d))
    for m in _WORD_DATE.finditer(folded):
        d = _date_in_year(int(m.group(1)), _MONTHS[m.group(2)], None, ref)
        if d:
            out.append((m.start(), m.end(), d))
    return sorted(out, key=lambda t: t[0])


class _DateOnly(datetime):
    """A new date the caption gave without a time: keep the event's own hour."""


def regex_signal(caption: str, post_dt: Optional[datetime] = None) -> Optional[CancelSignal]:
    """The no-LLM reading of a caption: kind, referenced dates, weekdays and,
    for a postponement, the new date when the caption gives one."""
    folded = _fold(caption)
    is_cancel = bool(_CANCEL_RE.search(folded))
    is_postpone = bool(_POSTPONE_RE.search(folded))
    if not (is_cancel or is_postpone):
        return None
    ref = post_dt or datetime.now(_CWB_TZ)
    dates = _dates_with_pos(folded, ref)
    new_start = None
    old_dates = []
    for start, end, d in dates:
        lead = folded[max(0, start - 40):start]
        if is_postpone and new_start is None and _NEW_DATE_LEAD.search(lead):
            t = _TIME.search(folded[end:end + 25])
            if t:
                hh = int(t.group(1) or t.group(3))
                mm = int(t.group(2) or t.group(4) or 0)
                new_start = datetime(d.year, d.month, d.day, hh, mm)
            else:
                new_start = _DateOnly(d.year, d.month, d.day)
        else:
            old_dates.append(d)
    weekdays = {wd for wd, pat in _WEEKDAYS.items() if re.search(pat, folded)}
    kind = "postponed" if is_postpone and not is_cancel else "cancelled"
    if is_postpone and new_start is not None:
        kind = "postponed"
    return CancelSignal(kind=kind, dates=old_dates, weekdays=weekdays,
                        new_start=new_start, detector="regex")


def llm_signal(cancels: dict, caption: str,
               post_dt: Optional[datetime] = None) -> Optional[CancelSignal]:
    """Signal from the extraction model's `cancels` field. None when the
    model said it is not a cancellation (trusted over the keywords)."""
    if not isinstance(cancels, dict) or not cancels.get("is_cancellation"):
        return None
    kind = "postponed" if cancels.get("kind") == "postponed" else "cancelled"
    rx = regex_signal(caption, post_dt)
    dates = []
    ed = (cancels.get("event_date") or "")
    if isinstance(ed, str) and ed:
        try:
            dates.append(datetime.strptime(ed[:10], "%Y-%m-%d").date())
        except ValueError:
            pass
    if rx:
        dates.extend(d for d in rx.dates if d not in dates)
    new_start = None
    nd = cancels.get("new_date_start")
    if kind == "postponed" and isinstance(nd, str) and nd:
        for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime(nd[:19] if "T" in nd else nd[:10], fmt)
            except ValueError:
                continue
            new_start = (_DateOnly(parsed.year, parsed.month, parsed.day)
                         if fmt == "%Y-%m-%d" else parsed)
            break
    if new_start is not None and new_start.date() in dates:
        dates.remove(new_start.date())
    return CancelSignal(
        kind=kind,
        event_name=str(cancels.get("event_name") or "")[:200],
        dates=dates,
        weekdays=rx.weekdays if rx else set(),
        new_start=new_start,
        detector="llm",
    )


# Words that say nothing about WHICH event: articles, prepositions, and
# the generic nouns every venue uses ("show", "festa", "evento").
_STOP = {
    "com", "para", "pra", "dos", "das", "nos", "nas", "uma", "por", "que",
    "the", "and", "sua", "seu", "nosso", "nossa", "deste", "desta",
    "neste", "nesta", "esse", "essa", "este", "esta", "show", "festa",
    "evento", "edicao", "especial", "noite", "dia", "aqui", "ate",
}


def _tokens(text: str) -> set:
    words = re.findall(r"[a-z0-9]+", _fold(text))
    return {w for w in words if len(w) >= 3 and w not in _STOP}


def _name_similarity(event_name: str, text: str) -> float:
    """Share of the event name's meaningful words found in `text`."""
    name_tokens = _tokens(event_name)
    if not name_tokens:
        name_tokens = {w for w in re.findall(r"[a-z0-9]+", _fold(event_name)) if len(w) >= 3}
    if not name_tokens:
        return 0.0
    text_words = set(re.findall(r"[a-z0-9]+", _fold(text)))
    return len(name_tokens & text_words) / len(name_tokens)


def _event_local_dt(iso: str) -> Optional[datetime]:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(_CWB_TZ).replace(tzinfo=None)
    return dt


def score_candidate(cand: dict, signal: CancelSignal, caption: str) -> float:
    """Name overlap (0..1) plus date evidence: the exact date 1.0, only the
    weekday 0.5. A named date that ISN'T this event's is evidence against."""
    text = f"{signal.event_name} {caption}"
    score = _name_similarity(cand.get("name") or "", text)
    dt = _event_local_dt(cand.get("date_start") or "")
    if dt is not None:
        if signal.dates:
            score += 1.0 if dt.date() in signal.dates else -0.5
        elif signal.weekdays:
            score += 0.5 if dt.weekday() in signal.weekdays else -0.25
    return score


def match_events(handle: str, signal: CancelSignal, caption: str,
                 post_dt: Optional[datetime], exclude_shortcode: str = "",
                 db=None) -> list[tuple[dict, float]]:
    """The catalog rows this post cancels: the single best-scoring upcoming
    event of the same handle, when it clears MIN_SCORE with a MIN_MARGIN
    lead. Ambiguity cancels nothing — the founder sees nothing wrong
    sooner than a wrong night disappearing."""
    if db is None:
        import database as db
    now = datetime.now(_CWB_TZ).replace(tzinfo=None)
    start = now - timedelta(hours=12)
    anchor = post_dt.replace(tzinfo=None) if post_dt else now
    end = max(anchor, now) + timedelta(days=MATCH_WINDOW_DAYS)
    cands = db.list_cancel_candidates(
        handle, start.strftime("%Y-%m-%dT%H:%M:%S"), end.strftime("%Y-%m-%dT%H:%M:%S"),
    )
    if exclude_shortcode:
        cands = [c for c in cands
                 if f"_{exclude_shortcode}" not in (c.get("external_id") or "")]
    scored = sorted(((c, score_candidate(c, signal, caption)) for c in cands),
                    key=lambda t: t[1], reverse=True)
    if not scored:
        return []
    best, best_score = scored[0]
    runner_up = scored[1][1] if len(scored) > 1 else float("-inf")
    if best_score < MIN_SCORE or best_score - runner_up < MIN_MARGIN:
        log.info(
            f"Cancel: @{handle} post looks like a cancellation but no confident "
            f"match (best {best_score:.2f}, runner-up {runner_up:.2f}, {len(scored)} candidates)"
        )
        return []
    return [(best, best_score)]


def apply(handle: str, *, caption: str, post_url: str, post_date: str,
          shortcode: str = "", llm_cancels: Optional[dict] = None,
          llm_answered: bool = False, dry_run: bool = False,
          db=None) -> list[dict]:
    """Run detection + matching for one post and write the outcome.

    `llm_answered`: the model saw the cancellation section of the prompt
    and answered. Its `cancels` verdict then wins; the regex only stands
    in when there was no answer field (old shape, tests, LLM-less runs).
    `dry_run` matches without writing (the admin extraction debugger).
    Returns one dict per touched event: {event_id, kind, score, ...}."""
    if db is None:
        import database as db
    if not handle or not looks_like_cancellation(caption):
        return []
    if post_url and db.cancellation_logged_for(post_url):
        return []
    post_dt = None
    if post_date:
        try:
            post_dt = datetime.strptime(post_date[:10], "%Y-%m-%d")
        except ValueError:
            post_dt = None
    if llm_answered and isinstance(llm_cancels, dict):
        signal = llm_signal(llm_cancels, caption, post_dt)
    else:
        signal = regex_signal(caption, post_dt)
    if signal is None:
        return []
    out = []
    for cand, score in match_events(handle, signal, caption, post_dt,
                                    exclude_shortcode=shortcode, db=db):
        eid = cand["id"]
        if dry_run:
            out.append({"event_id": eid, "kind": signal.kind, "score": score,
                        "name": cand.get("name"), "dry_run": True})
            continue
        if signal.kind == "postponed" and signal.new_start is not None:
            new_start = signal.new_start
            if isinstance(new_start, _DateOnly):
                old = _event_local_dt(cand.get("date_start") or "")
                hh, mm = (old.hour, old.minute) if old else (19, 0)
                new_start = datetime(new_start.year, new_start.month, new_start.day, hh, mm)
            new_start = new_start.replace(tzinfo=_CWB_TZ)
            if new_start > datetime.now(_CWB_TZ):
                updated = db.postpone_event(
                    eid, new_start, source_url=post_url, ig_handle=handle,
                    caption=caption, score=score, detector=signal.detector,
                )
                if updated is not None:
                    log.warning(f"Cancel: {eid} postponed to {new_start.isoformat()} by {post_url}")
                    out.append({"event_id": eid, "kind": "postponed", "score": score,
                                "name": cand.get("name"), "new_date_start": new_start.isoformat()})
                continue
        # Cancelled, or postponed with no (usable) new date: hide it.
        if db.cancel_event(eid, source_url=post_url, ig_handle=handle,
                           caption=caption, score=score, detector=signal.detector):
            log.warning(f"Cancel: {eid} cancelled by {post_url} (score {score:.2f})")
            out.append({"event_id": eid, "kind": "cancelled", "score": score,
                        "name": cand.get("name")})
    return out
