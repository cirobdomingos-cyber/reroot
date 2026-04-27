# auê — Project Guide for Claude

Quick orientation for future Claude/agent sessions. The full product README lives in [README.md](README.md); this file is intentionally short — it covers what's not derivable from the code itself.

## What this is

**auê** ("Curitiba que acontece") — events catalog for Curitiba, Brazil. Aggregates Sympla, Eventbrite, MON, SESC, Catraca Livre, Instagram (via Apify), plus 12 hand-curated "auê Originals" for venues that don't post events.

The repo and Railway subdomain still say `reroot` — that's the old product name. **Always say "auê" in user-facing copy and code comments going forward.**

## Architecture in 3 lines

- **Backend**: FastAPI (Python 3.12) + SQLite — single-file ~2700 lines at [backend/main.py](backend/main.py).
- **Frontend**: React 18 + Vite + HashRouter — main screens in [src/screens/](src/screens/).
- **Deploy**: Railway, multi-stage Dockerfile builds the frontend and the backend serves it from `/static`.

## Branching model

- `main` → Railway production (`reroot-production.up.railway.app`)
- `dev` → Railway staging
- [.github/workflows/sync-staging.yml](.github/workflows/sync-staging.yml) auto-merges `main → dev` on every push to main, so staging tracks prod by default. Commits that exist only on `dev` are intentional staging-only experiments.
- Behavior differences between envs come from env vars (`ENV_NAME`), **never** from divergent code branches.

## Voice & branding (post-pivot, April 2026)

The product pivoted from **Reroot** (wellness "social re-entry" framing) to **auê** (celebratory city catalog). When writing copy, prompts, or pitches:

- ✅ Casual, festive: "bora", "vai", "rola", "acontece"
- ✅ Descriptive over prescriptive: "show da Terno Rei na Pedreira, abertura 21h"
- ❌ No "recomendado" / "não recomendado" — just descriptive or "Bora porque..."
- ❌ No "baixa pressão", "introvertido", "ambiente acolhedor", "social re-entry"
- ❌ No moralism — auê doesn't judge whether the user "should" go

The Claude enrichment prompt in [backend/enrichment.py](backend/enrichment.py) already encodes this voice. Mirror it in any new user-facing text.

## Service Worker gotcha

The Workbox-generated SW has a navigation fallback that serves the cached `index.html` for any in-scope navigation — perfect for SPA offline support, but **it intercepts server-rendered routes too**. When adding a new server-side HTML endpoint (like `/ios`, `/privacy`, `/.well-known/foo`), add the path to the denylist regex in [src/sw.js](src/sw.js#L20-L31) or it will silently render the React shell instead.

## Personalization: shared content + per-user signals

The LLM enrichment is **per-event, not per-user** — N calls per N events, not N×M. User-specific affordances (friends going, RSVP conflicts, same-venue echoes) are computed at render time from already-loaded state — zero extra LLM calls. See `getPersonalChip` in [src/screens/Events.jsx](src/screens/Events.jsx) for the pattern.

Don't add per-user LLM calls without a strong reason — it doesn't scale.

## TWA / PWA distribution

- **Android**: TWA via PWABuilder.com → Play Store Internal Testing (no App Review for ≤100 testers). Backend serves `/.well-known/assetlinks.json` reading `TWA_SHA256_FINGERPRINT` env var.
- **iOS**: Safari "Adicionar à Tela de Início" walkthrough at `/ios`. TestFlight deferred until app proves traction (avoids $99/yr + Mac dependency + Review rejection risk for thin wrappers).
- Privacy policy at `/privacy` (LGPD-compliant, pt-BR).

## Pending cleanups (deliberately deferred)

These are real but not urgent — flag in PRs, don't auto-fix unless the task is explicitly cleanup:

1. **`is_low_pressure` rename** — semantically it's "is_intimate" now (small + conversational format). Field name kept for backward compat across ~12 files; rename touches model, db payload, frontend, prompts.
2. **`RerootCategory` class** in [backend/models.py](backend/models.py) — class still named after old product. Renaming touches imports across backend.
3. **Reroot-era voice in seed events** — the 12 auê Originals in [backend/seed_events.py](backend/seed_events.py) still have copy like "primeira saída", "voltando a socializar". Should be rewritten in auê voice.
4. **Hardcoded `_ASSET_LINKS` block** in [backend/main.py](backend/main.py) (~line 2630) — old hardcoded fingerprint with `com.reroot.app` package, now superseded by the env-driven endpoint at the top of the file. Dead code.
5. **Inline "Reroot" references in code comments** — many scrapers and module docstrings still mention Reroot. Cosmetic.

## Conventions worth knowing

- **HashRouter** — all client routes are `/#/foo`. Server only sees `/`. When sharing links, include the `#`.
- **Offline-first** — `src/services/api.js` always starts from embedded data and tries the backend with a 5s timeout. New features should degrade gracefully when the backend is unavailable.
- **Single i18n locale** (pt-BR) in [src/i18n/index.js](src/i18n/index.js). When adding strings, add to that file rather than hardcoding.
- **No CLAUDE.md drift** — keep this file under ~150 lines. Anything code-derivable belongs in code, not here.
