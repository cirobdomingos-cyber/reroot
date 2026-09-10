"""
Token accounting for the Claude calls in the scrape pipeline.

Why this exists: before September 2026 nothing in this codebase recorded
`response.usage`, so the only signal that the pipeline was expensive — or
had stopped working — was the Anthropic balance hitting zero. There is no
Admin API key on an individual account, so the usage/cost reports aren't
available either. This module is the measurement channel: it accumulates
per-run token counts and logs a costed summary at the end of each refresh.

Read the numbers out of the Railway logs (grep "token usage"), or from the
post-scrape summary email. If a change is supposed to cut spend, this is
what tells you whether it did.

Not thread-safe by design — the pipeline is a single asyncio loop.
"""
import logging
from collections import defaultdict

log = logging.getLogger(__name__)

# USD per 1M tokens. Snapshot — verify against
# https://claude.com/pricing before quoting these anywhere that matters.
# Unknown models fall back to the Haiku row so the estimate stays a
# lower bound rather than silently counting as free.
_PRICES = {
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-opus-5": (5.00, 25.00),
}
_DEFAULT_PRICE = _PRICES["claude-haiku-4-5"]

# stage -> {"calls", "input", "output", "model"}
_totals: dict[str, dict] = defaultdict(
    lambda: {"calls": 0, "input": 0, "output": 0, "model": ""}
)


def _price_for(model: str) -> tuple[float, float]:
    for prefix, price in _PRICES.items():
        if model.startswith(prefix):
            return price
    return _DEFAULT_PRICE


def record(stage: str, model: str, usage) -> None:
    """
    Add one API response's usage to the running totals.

    `stage` is a coarse label ("extraction", "enrichment", "geocode") so
    the summary shows which part of the pipeline the tokens went to.
    Never raises — accounting must not be able to break a scrape.
    """
    try:
        row = _totals[stage]
        row["calls"] += 1
        row["input"] += int(getattr(usage, "input_tokens", 0) or 0)
        row["output"] += int(getattr(usage, "output_tokens", 0) or 0)
        # Cache meters are recorded too: if a future change makes the
        # prompt long enough to cache, this is where it would show up.
        row["input"] += int(getattr(usage, "cache_read_input_tokens", 0) or 0)
        row["input"] += int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
        row["model"] = model or row["model"]
    except Exception:
        pass


def snapshot() -> dict:
    """Current totals plus a costed rollup, without resetting."""
    stages = {}
    total_cost = 0.0
    total_calls = 0
    for stage, row in _totals.items():
        pin, pout = _price_for(row["model"])
        cost = (row["input"] / 1e6) * pin + (row["output"] / 1e6) * pout
        total_cost += cost
        total_calls += row["calls"]
        stages[stage] = {**row, "cost_usd": round(cost, 4)}
    return {
        "stages": stages,
        "total_calls": total_calls,
        "total_cost_usd": round(total_cost, 4),
    }


def reset() -> None:
    _totals.clear()


def log_summary(prefix: str = "") -> dict:
    """Log the costed rollup and return it. Call once at end of a run."""
    snap = snapshot()
    if not snap["total_calls"]:
        return snap
    parts = [
        f"{stage}={row['calls']} calls "
        f"{row['input'] / 1000:.1f}k in / {row['output'] / 1000:.1f}k out "
        f"(${row['cost_usd']:.3f})"
        for stage, row in sorted(snap["stages"].items())
    ]
    log.info(
        f"{prefix}Claude token usage: " + "; ".join(parts)
        + f" | total ${snap['total_cost_usd']:.3f}"
    )
    return snap
