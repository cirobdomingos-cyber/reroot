"""One-shot mojibake repair for src/data/events.js.

The file accumulated double-encoded UTF-8 (UTF-8 bytes interpreted as cp1252
and re-saved as UTF-8). This walks every single-quoted string literal and, when
the contents look mojibake-y, applies the canonical fix: encode as cp1252,
decode as UTF-8.

Run from repo root: py -3.12 scripts/fix_mojibake.py
"""
from pathlib import Path
import re

p = Path("src/data/events.js")
text = p.read_text(encoding="utf-8")


def try_fix(s: str) -> str | None:
    """Round-trip cp1252 → utf-8. Returns repaired string or None on failure."""
    try:
        return s.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None


# Match single-quoted JS strings (with simple escape handling).
STRING_RE = re.compile(r"'([^'\\]*(?:\\.[^'\\]*)*)'")


def fix_string_literal(m: re.Match) -> str:
    inner = m.group(1)
    if all(ord(c) < 128 for c in inner):
        return m.group(0)
    fixed = try_fix(inner)
    if fixed is not None and fixed != inner:
        return "'" + fixed + "'"
    return m.group(0)


new_text = STRING_RE.sub(fix_string_literal, text)
p.write_text(new_text, encoding="utf-8")

# Quick health check: count chars that still look like cp1252 leftovers.
LEGIT_LATIN = set("ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ«»·")
suspicious = sum(
    1 for c in new_text if 0x80 <= ord(c) <= 0xFF and c not in LEGIT_LATIN
)
print(f"remaining suspicious latin-1 chars: {suspicious}")
print("done")
