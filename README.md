# auê

**Curitiba que acontece.** O catálogo completo de eventos da cidade — shows, exposições, feiras, oficinas, encontros pequenos — agregado de Sympla, Eventbrite, MON, SESC, Catraca Livre e Instagram, com a camada social que falta nas plataformas existentes: você vê o que **a sua galera** vai junto.

Demo ao vivo: [reroot.up.railway.app](https://reroot.up.railway.app) *(domínio `aue.app.br` em registro)*

> *Renomeado em abril/2026 — antes chamado "auê". O repositório git ainda usa o nome antigo; os artefatos de marca (manifest, README, package.json, splash) já foram migrados.*

---

## The Problem

Finding what's happening in Curitiba this weekend is a scavenger hunt across a dozen apps and hundreds of Instagram accounts. Sympla shows you concerts; Eventbrite shows business events; the museum has its own site; the café you like only posts on Instagram. There is no single place that aggregates every public event happening in the city — and the ones that try (Catraca Livre, prefeitura agenda) are dominated by big shows or institutional listings.

auê fills that gap. **It's the catalog you wish existed**: a single feed of everything happening in Curitiba, with a smart filter so you can find what fits you in 10 seconds.

---

## What auê Does

**1. One catalog, many sources**

auê continuously aggregates events from:

- **Sympla** + **Eventbrite** — paid ticketing platforms (concerts, workshops, courses)
- **MON, SESC Paraná, Teatro Guaíra, Turismo Curitiba** — institutional cultural agendas
- **Catraca Livre** — free / low-cost cultural events aggregator
- **Instagram** (via Apify) — the goldmine where small venues, cafés, curators, and coletivos publish events that never reach Sympla
- **auê Originals** — curated evergreen suggestions for venues that don't post events but always welcome you (Jardim Botânico, Café com Jogos, etc.)

**2. Two views, your choice**

A toggle on the Events screen lets users pick:

- 🌍 **Tudo** — everything happening in Curitiba (default)
- 🌿 **Curado** — the original auê lens: low-pressure, no business networking, no closed-group events. For days when you want to ease in.

**3. Real, current, in Curitiba**

Hard filters drop the noise: events outside Curitiba metro, virtual placeholders, and obviously-closed groups (Rosicrucian temple rituals, etc.) never appear. Soft filters (only on Curado mode) drop business networking, corporate training, and sales-disguised "free workshops".

**4. Smart enrichment**

Every scraped event passes through Claude Haiku, which extracts category, vibe, price tier, expected size, and a "why it might fit you" framing. Events without enough detail are dropped, not faked.

**5. Personal layer**

RSVP, calendar export (.ics + Google Calendar), week/month calendar view, friends, groups, post-event reconnect prompts. Optional — the catalog works without an account.

---

## Why This Is Hard to Copy

The technical pieces (React + FastAPI + Apify + Claude) are commodity. The defensible part is the **data pipeline plus the editorial layer**:

- The Instagram tracking list is curated by hand (one-time, ~50 accounts) — a competitor would need to rebuild it from scratch.
- The Claude enrichment prompt encodes a specific point of view about what's worth surfacing in Curitiba.
- The deny-lists for non-Curitiba cities, closed esoteric groups, virtual leakers, and corporate noise are the result of dozens of false-positive iterations.

That curation is what makes a user say "this app actually has the events I want" instead of "this is just Sympla with a worse search."

---

## Tech Stack

| Layer | Stack |
|---|---|
| Frontend | React 18 + Vite + Framer Motion |
| Mobile | Capacitor (Android/iOS build-ready) |
| Backend | FastAPI (Python 3.12) on Railway |
| Database | SQLite (dev), Postgres-ready |
| Event scraping | httpx + BeautifulSoup-light parsers, [Apify](https://apify.com) for Instagram |
| LLM enrichment | Claude Haiku 4.5 (Anthropic API) |
| Venue data | Google Places API (Nearby Search) |
| Auth | Google Identity Services (OAuth) |
| Notifications | Capacitor Local Notifications + Browser Web Push API |
| State | useReducer + localStorage (offline-first) |
| Deploy | Railway (single-service: FastAPI serves React build) |

---

## Architecture

**Offline-first** — `src/services/api.js` always starts from embedded data, tries the backend with a 5s timeout, falls back silently. The app works with zero backend.

**Single-service deploy** — FastAPI serves the React static build from `/static`. No separate frontend hosting, no CORS complexity in production, one deploy pipeline.

**Three-stage event pipeline:**
```
[10+ scrapers — Sympla, Eventbrite, Sesc, MON, Turismo Curitiba, Catraca Livre, Instagram via Apify, ...]
    ↓ raw events with messy text and missing fields
[Claude Haiku enrichment]
    ↓ structured event with category, vibe, price tier, "is good for re-entry?", reroot_reason
[API-time filters: region, content deny-list, dedup, optional curated lens]
    ↓
[Frontend: prescription on Home, broad catalog on Events]
```

**Hard vs soft filters:**

- *Hard* (always applied): wrong city, virtual placeholder venues, closed esoteric groups. These keep the catalog clean — never users' choice to see them.
- *Soft* (only when user picks "Curado"): business networking, career fairs, corporate training, and `good_for_reroot=false` events. These are real Curitiba events; just not the original auê vibe.

This split is what lets auê be both a complete aggregator AND a curated discovery tool, without picking only one.

---

## Instagram Pipeline (the goldmine)

Most of what makes Curitiba's social scene interesting — small saraus, neighborhood book clubs, niche oficinas, weekend yoga in the park — never gets listed on Sympla. It lives on Instagram.

auê uses **[Apify](https://apify.com)'s hosted Instagram scraper** to pull recent posts from a curated list of ~50 Curitiba accounts (museums, cafés, curators, communities). For each post, Claude decides "is this an upcoming Curitiba event with a date?" and either extracts structured fields or skips. The yield is roughly 5–15% of posts per scrape, but those events are the *exact* type Sympla doesn't have.

Why Apify instead of self-hosted scraping: Instagram aggressively blocks anonymous access and bans throwaway accounts within days. Apify maintains the scraping infrastructure (proxies, account rotation, anti-bot evasion); we pay $3–10/month at our scale. Production-grade, TOS-aware, no account babysitting.

Admin UI at `/admin/ig` to add, label, enable/disable, and remove tracked accounts. Each account's last scrape time and event yield is tracked, so it's easy to spot accounts that produce noise and prune them.

---

## Monetization

Not charging users. Revenue comes from the supply side:

**Venue partnerships** — local bars, cafés, and ateliers pay R$300–500/mo for featured placement and an "⭐ Parceiro auê" badge. The pitch: "shown to people actively looking for things to do, filtered by neighborhood and vibe, ranked above the noise."

**Event organizer listings** — workshops, courses, festivals pay R$150–300 per event for curated placement with the auê framing included.

**Corporate cohorts** — companies with remote/hybrid teams buy cohort access for new-hires relocating to Curitiba or working in isolation. Pricing per seat. Same product, B2B distribution.

The catalog being broad (everyone uses it) is what makes the monetization defensible — paid placement only matters if users are already searching there.

---

## Local Development

```bash
# Frontend
npm install
npm run dev          # http://localhost:5173

# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Environment variables (create `backend/.env`):
```
ANTHROPIC_API_KEY=your_key       # required for enrichment + Instagram extraction
APIFY_API_TOKEN=apify_api_xxx    # required for the Instagram pipeline
GOOGLE_PLACES_API_KEY=your_key   # optional — enables Bares & Cafés section
```

Without `ANTHROPIC_API_KEY` the app falls back to embedded static seed data (12 auê Originals). Without `APIFY_API_TOKEN` the Instagram pipeline silently no-ops.

---

## What's Next

**Supply side**:
- Self-service partner submission (`/events/submit` endpoint exists; needs public form)
- Expand Instagram tracking list as new venues are discovered
- Pilot a "Parceiro auê" badge with 3–5 local cafés

**Discovery side**:
- Mood picker (Tranquilo / Animado / Cultural / Profissional / Família) — broader than the current 4 categories
- Better search across all events
- Maps view ("eventos perto de mim")

**Distribution**:
- PWA install instructions in onboarding
- Play Store closed testing track (Capacitor APK already builds)
- First real cohort meetup as a content + acquisition flywheel
