# auê — Design Brief for Brand & Visual System Refresh

> **Audience:** specialized design AI / agency / freelancer.
> **Output expected:** complete brand system (logo, palette, typography, iconography, illustration style, motion principles) plus 3 key screen mockups.
> **Format expected back:** design tokens (CSS variables), JSX/HTML auto-contained components, and motion/iconography spec docs.
>
> This is a **visual refresh of a mature, deployed product**, not a product redesign. Product strategy, voice, copy, and feature surface are out of scope. The current visual identity is one possible direction; you are explicitly invited to push back with reasoning if you see better.

---

## 1. Product context

**auê** ("Curitiba que acontece") — events catalog for Curitiba, Brazil. Sourced from Instagram via Apify (~80 tracked handles covering bars, cafés, theatres, museums, livrarias, comedy clubs, etc.) plus 12 hand-curated "auê Originals" for venues that don't post events.

The product pivoted from **Reroot** (wellness "social re-entry" framing) to **auê** (celebratory city catalog) in April 2026 — that pivot included a partial visual refresh (orange + ink blue + cream + honey palette). This refresh aims to take that next step: a more confident, more distinctive, more 2026-current visual identity. The repo and Railway subdomain still say `reroot` — that is legacy.

Full project context: see [`CLAUDE.md`](../CLAUDE.md) at repo root. Mandatory read.

## 2. Audience & cultural context

- **Primary user:** Curitiba residents 18–35. Goes out at least monthly. Comfortable with Instagram-coded UI patterns. Tired of generic event apps that feel like Sympla or Eventbrite.
- **Cultural lens:** Brazilian, **specifically curitibano** — auê has a strong city identity. The visual language should feel **distinctly Curitiba**, not generic-Brazilian and definitely not generic-global.
- **Secondary signal:** the user opens this app **on the bus**, **right before going out**, and **in bed at midnight wondering "tem alguma coisa rolando?"**. Every interaction is short, mobile, often one-handed.

## 3. Brand personality

### Adjectives we want
- Festive, alive, "tá rolando"
- Descriptive, never prescriptive ("show da Terno Rei na Pedreira, abertura 21h" — not "evento recomendado para você")
- Confident, slightly cocky, knowing
- Warm but never wholesome
- Distinctly Brazilian-Curitiba-modern

### Adjectives we explicitly do NOT want
- Wellness · Mindful · Re-entry · Therapeutic (that was the old Reroot framing — burned, never coming back)
- Recommended · Curated-for-you · Algorithmic
- Cute · Soft · Pastel · Wholesome
- Corporate · Sterile · SaaS-clean
- Generic-tech-startup
- "Should you go?" — auê does not judge

### One-line positioning
> "Like opening Instagram and seeing only the events from accounts you'd actually go to — but with friends, RSVPs, and a real city catalog underneath."

## 4. Anti-patterns specific to this product

These are common event-app and gamification visuals we deliberately avoid:

- ❌ "Recommended for you" badges — the catalog is curated by humans, not algorithm-personalized
- ❌ Star ratings on events
- ❌ Big "BUY TICKET" CTAs as the dominant visual element (we link out to ticketing — we are not a ticketing app)
- ❌ Calendar-grid as primary navigation (we have a week strip, but the feed is the hero)
- ❌ Map as primary view (we have a map, but list is the hero — Curitiba's geography isn't the entry point)
- ❌ Infinite scroll without temporal anchoring (our content is event-time-based)
- ❌ Sympla / Eventbrite / Meetup color coding (oranges + reds + utility blues) — that's what we want to feel different from
- ❌ Wellness / mindfulness iconography (lotus, breath, calm, sunrise gradients on cream)

## 5. Visual direction — current state + invitation

The April 2026 pivot landed on this palette as a transitional state. **Treat it as a hypothesis, not a constraint.** If you see a better direction (darker mode, different accent system, completely fresh palette), propose with reasoning.

### Current palette (in [`src/styles/globals.css`](../src/styles/globals.css))

| Token | Hex | Role |
|---|---|---|
| `--terra` (legacy name, now ink blue) | `#1E3A5F` | Anchor / primary |
| `--terra-light` | `#2E548A` | Hover / accent |
| `--sage` (legacy name, now coral) | `#E8623F` | Brand primary / CTAs |
| `--sage-light` | `#F08869` | Hover state |
| `--honey` | `#F4A623` | "Novo" badges, sparingly |
| `--cream` | `#FCF5EB` | Page background |
| `--charcoal` | `#2C2C2C` | Body text |
| `--border` | `#EBE0CD` | Card borders |

> The legacy variable names (`--sage`, `--terra`) are intentionally kept across ~30 call sites to avoid a churn refactor — feel free to propose a renaming, but the implementation will keep the bridge. New tokens you add can use semantic names freely.

### Current typography
- **Display / wordmark:** Manrope (600–800)
- **Body:** Inter (300–700)

### Open questions you should answer
- **Light mode forever, or introduce dark?** Current is light. Some users open auê at midnight in bed — case for dark or auto. Some users open on the bus in sun — case for staying light. Your call with reasoning.
- **One palette or scene-aware palettes?** Each event has a vibe (show, café, exposição). Should category coloring be louder than today (essentially monochrome cards) or stay restrained?
- **Does coral survive?** It's the most distinctive choice from the April pivot, but coral on cream reads "design-y wellness brand" to some. If you replace it, propose what and why.

## 6. Anti-patterns from the *April 2026 pivot* still to avoid

The pivot dropped wellness framing but the visual still has some carry-over:

- ❌ Sunrise / dawn gradients (Reroot used those for "social re-entry" — gone)
- ❌ Lotus, leaf, dove icons (wellness coding — gone)
- ❌ Soft drop-shadows on every card (over-padded UI feels yoga-app)
- ❌ Sage green ANYWHERE — `--sage` token is now coral; the legacy color is dead

## 7. Deliverables

Produce the same handoff structure that worked for [`c:/repo/aura`](../../aura/) (a sister project we briefed you on previously). Specifically:

### Brand
1. **Wordmark / logotype** for "auê" (lowercase is non-negotiable — it's the brand) — primary, stacked, monogram (single glyph) variants
2. **App icon** (1024×1024, masked-circle and square variants for iOS/Android — auê is distributed via TWA on Android and Add-to-Home-Screen on iOS)

### Visual system
3. **Full color palette** as design tokens (CSS variables): backgrounds (multi-level), text (primary/secondary/disabled), brand (primary/secondary), semantic (success/warning/error/info), and any category accents you propose
4. **Typography system** — display, heading levels, body, label. Sizes, weights, line-heights, letter-spacing. Free Google Fonts only (Manrope and Inter are current; you can switch)
5. **Iconography style** — outline / filled / duotone? Pick one and produce a starter set: home, events, friends, calendar, map, profile, settings, plus icons for: bar, café, show, exposição, oficina, livraria, teatro
6. **Illustration style** — for empty states, onboarding, and venue-type headers. 2–3 sample illustrations
7. **Component starting points** — design specs for: primary button, secondary button, **event card** (the most-rendered surface in the app), event chip/badge, week-strip day, RSVP button (3 states: undecided / going / not going), bottom-nav, modal/bottom-sheet
8. **Avatar treatment** — currently we use Google profile pictures fetched at sign-in; propose how to frame them (ring? badge? plain?)

### Motion
9. **Motion principles document** — easing language, timing tokens, when things animate (the auê app has minimal animation today; what should it have?). Don't produce videos; written principles + key keyframes are enough.

### Screens
10. **3 key screen mockups** at mobile resolution (390×844 baseline — iPhone 14):
    - **Home** — landing screen after open. Today's vibes, week ahead, friends activity glance
    - **Events feed** — the main browse view. Filterable, scrollable, with the week-strip
    - **Event detail** — the conversion screen. Title, venue, time, going-friends, RSVP, link out to ticket

## 8. Constraints

- **Mobile-first.** All work must read perfectly at 390×844 portrait. Tablet/desktop are post-MVP.
- **Performance.** SVG over PNG wherever possible. Illustrations under 50 KB compressed. No video backgrounds.
- **PWA + TWA reality.** auê is installed as a PWA on iOS (Add to Home Screen) and as a TWA on Android (Play Store Internal Testing). Design must look good as an installed app on the home screen — the icon and splash matter.
- **Accessibility.** WCAG AA contrast. Touch targets 44×44pt minimum.
- **Localization.** Single locale pt-BR. Copy in mockups should be Portuguese, in the auê voice (see §3 and `CLAUDE.md`).
- **Engineering reality.** Output as plain CSS variables + JSX components — no proprietary design tools or runtime dependencies beyond what we already use (React 18, Vite, Framer Motion is OK).
- **Service worker constraint.** auê has a custom service worker with a navigation fallback. Visual changes are safe, but anything that adds new server-rendered HTML routes needs a denylist update — flag if your design implies one.

## 9. Reference inspiration (attach as samples)

Pull from these directions, do not copy:

- **Resy** — restaurant booking UI: dense, confident, descriptive
- **Apple Music / Spotify "concerts" tab** — event-list density done right
- **Figma's marketing site** — typography precision on warm neutrals
- **Editorial design from brazilian indie magazines** — Vista, Piauí, Quatro Cinco Um — for the typographic energy we want
- **TimeOut Lisbon / TimeOut London apps** — city-catalog category we are in
- **The website of Pedreira Paulo Leminski** (Curitiba's main concert venue) — for very local visual codes if you want a Curitiba reference

Avoid pulling from:
- Sympla / Eventbrite / Ingresso (utility ticketing apps — opposite of what we want to feel like)
- Wellness / meditation apps (Calm, Headspace — that was the old Reroot)
- Generic Material Design event templates

## 10. Output format

Please return a zip with:

1. `design-tokens.css` — all variables
2. `aura-handoff.md` style document (call it `aue-handoff.md`) — typography, motion, iconography, illustration principles
3. JSX components for the items in §7 deliverables
4. HTML mockups of the 3 specified screens at 390×844 (and a 2x retina variant)
5. SVG exports of the logo system and icon set
6. (Optional) Figma file with everything organized

If you can't produce all of these, return what you can and call out gaps explicitly. Same convention as the Aura handoff package.

## 11. Out of scope (do NOT produce)

- Marketing landing page design
- Email templates
- Print collateral
- Animations as actual video files
- Localization beyond pt-BR
- Admin / venue dashboard design (the screens at `/admin/*` — those stay utilitarian)
- **Anything that changes the product surface, voice, or copy** — this is a visual refresh, not a product redesign

---

**End of brief.** Questions back to me before starting are welcome and encouraged — better one round of clarification than three rounds of revision.
