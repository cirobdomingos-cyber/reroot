# Reroot

**A structured re-entry guide for people who've lost their social life — not another event list.**

Live demo: [reroot.up.railway.app](https://reroot.up.railway.app)

---

## The Problem

Social isolation doesn't announce itself. It sneaks in after a breakup, a move to a new city, a burnout, or two years of remote work. By the time people notice it, the idea of "just going out" feels enormous.

Existing tools don't help:
- **Dating apps** are too high-stakes
- **Event platforms** (Sympla, Eventbrite) list everything, curate nothing
- **Social media** shows everyone else's highlight reel

The gap is a product that understands *why* you're isolated and gives you a structured, low-pressure path back — not a list of things to do.

---

## What Reroot Does

Reroot treats social re-entry as a 12-week journey, not a weekend decision.

**1. Situation-aware onboarding**
Users identify which of 7 profiles fits them: recently heartbroken, transplant to a new city, burnout recovery, remote worker, trying to reconnect, introvert expanding comfort zone, or grieving. Each profile gets different recommendations, different framing, different pacing.

**2. Curated prescription — not a feed**
The home screen shows a "prescription" of 1–2 events per week chosen for the user's profile and chapter. A burnout user gets small, low-energy activities. A transplant gets community-building events. The algorithm is intentional, not engagement-driven.

**3. Real venues via Google Places**
The Bars & Cafés section pulls live data from Google Places API — real ratings, real addresses, real Google Maps links. Venues are filtered by type (café vs bar), sorted by popularity, and framed with a "why this works for you right now" angle.

**4. Cohort model**
Users aren't alone in the app. They're in a cohort — a small group of people at the same stage. Other cohort members appear on event cards, creating social proof without social pressure.

**5. Weekly rhythm**
Sunday check-ins, weekly frameworks with reflection prompts, streak tracking. The app creates accountability without judgment.

---

## Why This Is Hard to Copy

The technical pieces (React app, FastAPI backend, Google Places) are table stakes. The defensible part is the **editorial layer**: the reroot framing on every event, the 7-profile system grounded in reconnection psychology, the decision to show 2 events instead of 20.

That curation is what makes a user say "this app gets me" instead of "this is just Sympla with a nicer UI."

---

## Tech Stack

| Layer | Stack |
|---|---|
| Frontend | React 18 + Vite + Framer Motion |
| Mobile | Capacitor (Android/iOS build-ready) |
| Backend | FastAPI (Python) on Railway |
| Venue data | Google Places API (Nearby Search) |
| Auth | Google Identity Services (OAuth) |
| Notifications | Capacitor Local Notifications + Browser API |
| State | useReducer + localStorage (offline-first) |
| Deploy | Railway (single-service, backend serves React build) |

**Architecture decision:** offline-first. The app works with zero backend — embedded static events load instantly. The backend and Google Places are progressive enhancements. This matters for Capacitor native builds where network is unreliable.

---

## Key Engineering Decisions

**Single Railway service** — the FastAPI backend serves the React static build from `/static`. No separate frontend hosting, no CORS complexity in production, one deploy pipeline.

**Offline-first data layer** — `src/services/api.js` always starts from embedded data, tries the backend with a 2s timeout, falls back silently. Users never see a loading failure.

**Profile-driven rendering** — the `PROFILES` map in AppContext drives event sorting, prescription count, and copy throughout the app. Adding a new profile is one object in one file.

**Places as a category** — `bars_cafes` routes to `/places` instead of `/events`. The frontend doesn't know or care — same shape, same components. The backend handles the Google Places call, deduplication by `place_id`, and sorting by review count.

---

## Monetization Design

Not charging users. Revenue comes from the supply side:

**Venue partnerships** — local bars and cafés pay R$300–500/mo for featured placement in the Bares & Cafés section. One backend flag (`is_partner`), one badge component. The pitch: "shown to people actively trying to get out of the house, filtered by neighborhood and situation."

**Event organizer listings** — workshops, yoga studios, ceramics classes pay for curated placement with the reroot editorial framing included. R$150–300 per event.

**Corporate cohorts** — companies with remote/hybrid teams buy cohort access for employees relocating or working in isolation. Pricing per seat. No product changes needed to sell this.

---

## What's Next

**To get first users:**
Run the first cohort manually. Invite 8–12 people personally. Be the algorithm — send weekly WhatsApp check-ins, suggest events, create the group feeling. Every community product starts this way.

**To scale the content:**
Connect the Sympla/Eventbrite scrapers already in the backend (scheduler + enrichment pipeline built, just needs API tokens). The AI enrichment layer uses Claude to write the reroot framing for each scraped event automatically.

**To monetize:**
Partner badge system (one backend flag + frontend badge component). Pilot with 3–5 local venues manually before building a self-serve flow.

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
GOOGLE_PLACES_API_KEY=your_key
ANTHROPIC_API_KEY=your_key      # optional — enables event enrichment
```

The app works fully without any env vars using embedded static data.
