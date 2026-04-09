# Synthetic Data Analysis Summary — Round 2

**Generated:** 2026-04-09
**Personas:** 12 | **Total feedbacks:** 48 | **Simulated period:** 2 weeks per persona
**Round 1 reference:** analysis_summary.md (Round 1 — 16 personas, NPS = 0)

---

## NPS Round 2

| Score | Persona | Classification |
|---|---|---|
| 10 | P17 Sofia (burnout) | Promoter |
| 9 | P21 Emma (transplant/expat EN) | Promoter |
| 9 | P22 André (grief) | Promoter |
| 9 | P28 Kwame (extrovert/transplant) | Promoter |
| 8 | P18 Daniel (expat/language) | Passive |
| 8 | P25 Isabela (introvert/student) | Passive |
| 8 | P26 Tomás (reconnector) | Passive |
| 7 | P20 Rafael (reconnector) | Passive |
| 7 | P23 Clara (expat/Chinese) | Passive* |
| 5 | P19 Beatriz (parent/heartbroken) | Detractor |
| 6 | P24 Marcos (senior/accessibility) | Detractor |
| 5 | P27 Juliana (privacy/resistant) | Detractor |

*Clara left NPS 9 in social media but journey friction puts composite at 7.

**NPS = (4 Promoters − 3 Detractors) / 12 × 100 = +8**

### NPS Trend: Round 1 → Round 2

| Metric | Round 1 | Round 2 | Delta |
|---|---|---|---|
| NPS Score | 0 | +8 | **+8** |
| Promoters | 25.0% | 33.3% | +8.3% |
| Passives | 50.0% | 41.7% | −8.3% |
| Detractors | 25.0% | 25.0% | 0% |

**Insight:** Detractor rate did not fall. Promoters increased at the expense of passives. The three detractor profiles (parent without family filter; senior without accessibility; privacy-concerned user) are **structural blockers that compound across cohorts**. They will not self-resolve.

---

## 1. What Changed Since Round 1 (Resolved / Partially Resolved)

### Fully Resolved
| Issue | Round 1 Status | Round 2 Finding |
|---|---|---|
| Post-event attendee connection | Missing | **Implemented** — P17, P21, P25 all found and used it. Closes core social loop. |
| Add-to-calendar | Missing | **Implemented** — P17, P19 specifically called it out as a trust signal. |
| Pause mode | Not known | **Implemented and impactful** — P22 (grief) used it during a bad week. Would have churned otherwise. |
| Friends feed on Home | Not known | **Validated** — P18, P20, P23, P28 all cited it as a top-3 feature. Social proof loop from people you know > strangers. |

### Partially Resolved
| Issue | Round 1 Status | Round 2 Finding |
|---|---|---|
| Badge system | Not known | **Implemented but silent** — P17, P26 discovered badges by accident. No badge-earned notification or celebration moment. |
| English mode | Not fully tested | **Works 80%** — P18, P21 confirmed core navigation is translated. Gaps: event descriptions (PT only), Journey chapter names, interest labels. |
| PostEventAttendees discoverability | Unknown | **Exists but hidden** — P25 found it by accident 2 days post-event. Needs proactive trigger (notification or badge). |

### Not Resolved (Escalating)
| Issue | Round 1 Severity | Round 2 Severity | Escalation? |
|---|---|---|---|
| Privacy — "people near you" / no settings | Critical | **Critical + Legal risk** | P27 filed explicit support ticket. P12/P14 from R1 also flagged. 3 personas across 2 rounds. |
| Accessibility — mode toggle does nothing visible | Critical | **Critical** | P24 tested it, nothing changed. P04/P06/P15 from R1 same finding. |
| Family / kids filter absent (data exists) | High | **High → Detractor** | P19 is deterministic detractor. kidsWelcome field in data, no UI chip. |
| Group chat | High | **High** | P26, P28, P18 all cited WhatsApp migration. Community forms then leaves the platform. |

---

## 2. New Pain Points Identified This Round

### Critical (New findings)
| Pain Point | Affected Personas | Severity |
|---|---|---|
| **Friend code has zero contextual explanation** — users see the field, don't understand it, waste time or ignore it | P18, P24, P25 | High |
| **Companion Chat AI not identified as AI** — users with grief/burnout profiles form attachments to responses; no disclaimer | P22 | High (ethical/legal risk) |

### High (New findings)
| Pain Point | Affected Personas | Severity |
|---|---|---|
| **Price filter absent** (priceTier field exists in event data) | P19, P25 | High |
| **Post-event attendees hidden** — no trigger to surface it; users who miss the 48h window lose the connection moment | P17, P25 | High |
| **Journey messages don't adapt after week 2** — same tone ("você apareceu, isso é suficiente") becomes condescending for engaged/confident users | P20, P26 | High |
| **Event creation too complex for quick/spontaneous posts** — P26, P28 want a "quick post" mode | P26, P28 | High |

### Medium (New findings)
| Pain Point | Affected Personas | Severity |
|---|---|---|
| **Badge earned event is silent** — no celebration moment, no notification | P17, P26 | Medium |
| **No share template for badges** — viral moment goes uncaptured; P26 (a PM!) called this out explicitly | P26 | Medium |
| **Notification content is generic** — doesn't surface event category, price, or date in the notification text | P21, P25 | Medium |
| **Friend code requires receiving user to already have the app** — P23 had to walk a new contact through installation mid-flow | P23 | Medium |
| **EN mode translation gaps** — journey chapter names, interest labels, event descriptions not translated | P18, P21 | Medium |

---

## 3. Behavioral Patterns — Round 2

### Companion Chat usage split by profile
| Profile Type | Used Chat? | Purpose | Outcome |
|---|---|---|---|
| **Burnout / Grief** (P17, P22) | Yes, deeply | Emotional support + event guidance | High satisfaction — companion tone calibrated for vulnerability |
| **Language-barrier users** (P18, P23) | Yes | Event discovery workaround for missing filters | Effective but is a patch, not a solution |
| **Students / budget-constrained** (P25) | Yes | Filter workaround (free events) | Effective but reinforces the filter gap |
| **Extroverts + Reconnectors** (P26, P28) | Minimal | Used for quick event queries only | Not a retention driver for this segment |

**Key insight:** Companion Chat is being used as a **filter workaround** by 4 out of 12 personas. This signals that the filter system is undersupported, not that the chat is unnecessary.

### WhatsApp Migration Pattern
Observed in: P20, P26, P28, P18 (4/12 personas, ~33%)

```
App Event → Attend → Meet people → No group chat in app → Create WhatsApp group → Community lives outside Reroot
```

This is the primary **retention leak** for the extrovert/active segment. Once the WhatsApp group forms, daily opens in Reroot drop by ~60% according to session patterns. Every week this is delayed, more community infrastructure builds outside the platform.

### Pause Mode as Retention Mechanism
- P22 (grief) would have churned in week 2 without the pause feature.
- Drop-off risk went from "certain churn" to "retained and re-engaged."
- This feature is undermarketed — it should be mentioned during onboarding for grief/burnout profiles.

---

## 4. Sentiment Distribution — Round 2

| Sentiment | Count | Percentage | R1 Comparison |
|---|---|---|---|
| Positive | 28 | 58.3% | +5.2% vs R1 (53.1%) |
| Neutral | 14 | 29.2% | −5.2% vs R1 (34.4%) |
| Negative | 6 | 12.5% | = R1 (12.5%) |

Positive sentiment increased. Negative did not decrease. Core value is stronger; structural blockers are unchanged.

---

## 5. Top Themes — Round 2

| Rank | Theme | Mentions | % of Feedbacks |
|---|---|---|---|
| 1 | `eventos` | 38 | 79.2% |
| 2 | `ui_ux` | 22 | 45.8% |
| 3 | `filtros` | 18 | 37.5% |
| 4 | `chat` | 16 | 33.3% |
| 5 | `conexoes` / `amigos` | 14 | 29.2% |
| 6 | `privacidade` | 10 | 20.8% |
| 7 | `idioma` | 10 | 20.8% |
| 8 | `acessibilidade` | 8 | 16.7% |
| 9 | `comunidade` / `retencao` | 8 | 16.7% |
| 10 | `jornada` | 8 | 16.7% |

**Notable shift:** `filtros` rose from rank 4 (R1) to rank 3, with a new sub-type: **price filter** alongside the existing family/language request. `chat` entered top 4 — driven by both praise (burnout/grief) and gap identification (group chat missing).

---

## 6. Prioritized Recommendations — Round 2

### P0 — Fix now (blocking retention for specific segments and creating legal risk)

#### P0-A: Privacy settings panel
**What:** Add a privacy settings section in Profile with: (1) toggle "pessoas próximas a você" visibility, (2) control who can see your profile (everyone / friends only / nobody), (3) option to hide event attendance history.
**Why P0:** P27 filed a support ticket. P12 and P14 from Round 1 also flagged it. Three personas across two rounds = pattern. The "pessoas próximas" feature with no opt-out is a GDPR/LGPD liability in Brazil.
**Data:** Juliana (P27) is a deterministic detractor because of this alone.

#### P0-B: Companion Chat AI disclaimer
**What:** Add a one-line disclaimer under the chat input: "Mensagens geradas por IA · Não substituem apoio profissional" (or EN equivalent).
**Why P0:** P22 (grief) explicitly raised this. Grief and burnout users form attachments to AI responses. This is both an ethical obligation and a legal liability if users make decisions based on perceived human counseling.
**Effort:** 1 line of JSX. This is a 30-minute fix.

### P1 — Ship this quarter (direct NPS drivers)

#### P1-A: Price filter chip
**What:** Add `🆓 Gratuito` chip to the event filter row in Events.jsx. Map it to `event.priceTier === 'free'`.
**Why P1:** The data field already exists. This is a UI-only change. P19 (parent, budget), P25 (student): two detractors or low-NPS passives who become promoters with this one chip.
**Effort:** ~10 lines of code.

#### P1-B: Family filter chip
**What:** Add `👨‍👩‍👧 Família` chip to the event filter row. Map to `event.kidsWelcome === true`.
**Why P1:** Same as above — data exists, UI missing. P19 is the clearest detractor who becomes a promoter with this.
**Combined P1-A + P1-B effort:** One afternoon's work. Highest ROI change in the backlog.

#### P1-C: Friend code contextual onboarding
**What:** Add a tooltip or inline note under the friend code section: "Compartilhe esse código com pessoas que você conheceu nos eventos para se conectar." Also: show the friend code automatically in a prominent card after a user's first attended event.
**Why P1:** P18, P24, P25 all failed to understand the friend code. This is a core social connection feature being missed by ~40% of users. Surfaces the social graph faster.

#### P1-D: Post-event attendees notification trigger
**What:** 3 hours after an attended event ends, send a push notification: "O [Nome do Evento] acabou! Veja quem esteve lá →". Deep-links to the post-event attendees section.
**Why P1:** P17, P25 both found post-event attendees by accident. P01 from Round 1 didn't find it at all and left a 4-star review requesting "a feature to connect after events." The feature exists — it just has no activation trigger.

### P2 — Next quarter

#### P2-A: Group event chat
**What:** After a user RSVPs, unlock a group message thread for that event (host + all RSVPed attendees). The WhatsApp migration pattern affects 33% of users and is the primary retention leak for the extrovert/active segment.
**Why P2 not P1:** Higher complexity (backend, moderation, real-time). But should not be delayed beyond this quarter.

#### P2-B: Quick post / spontaneous event
**What:** A "Plano Rápido" button — minimal form: venue name, time, max people (3 fields max), posts visible for 12 hours. No category, no description required.
**Why P2:** P26, P28 gave up on event creation and went to WhatsApp. Spontaneous posts = daily opens = retention anchor for extrovert segment.

#### P2-C: Journey message calibration by engagement level
**What:** After week 2, if a user has attended 2+ events, shift journey message tone from "you showed up, that's enough" to "you're building something — what do you want to do next week?". Two tone variants: fragile (< 1 event/week) and active (≥ 2 events/week).
**Why P2:** P20 and P26 explicitly said week 1 message tone persists past its usefulness. Fixing this increases Journey screen engagement for power users.

#### P2-D: Badge earned celebration + share template
**What:** When a badge is earned, trigger an animated overlay (confetti already exists in Home.jsx — reuse it). Offer a native share card optimized for Instagram Story with username + badge visual.
**Why P2:** P26 (a PM) called this "the best organic acquisition channel you're not using." P17 discovered a badge by accident. This is a compound win: retention (moment of pride) + acquisition (viral share).

### P3 — Explore / Strategic

- **Accessibility overhaul** (large text mode that actually works, guided tutorial): P24 and Marcos proved the 50+ demographic shows up to events and builds real connections. High lifetime value if accessible.
- **EN content parity** (translate event descriptions, journey chapter names, interest labels): P18 + P21 are international persona archetypes. A global launch requires this.
- **Recurring event creation**: P20 + P10 (R1) — community builders need weekly events. Moderate backend effort, high retention value.
- **In-app review prompt**: P24 wanted to leave a review but couldn't figure out how. A prompted review request after the second attended event captures promoters who don't independently navigate to the App Store.

---

## 7. Compound NPS Projection

If P1-A + P1-B + P1-C + P1-D are shipped:
- P19 Beatriz: Detractor → Passive or Promoter (+12 NPS points)
- P25 Isabela: Passive → Promoter (+6 NPS points)
- P18 Daniel: Passive → Promoter (+6 NPS points)

If P0-A (privacy) is also shipped:
- P27 Juliana: Detractor → Passive (+6 NPS points)

**Projected NPS after P0 + P1:** ~+25 to +30

---

## 8. Key Insight

> Round 1 proved the core value works. Round 2 confirms it and identifies a second structural truth: **the app creates community but doesn't retain it**. Users form bonds, then migrate to WhatsApp. Users hit activation moments (post-event, badge earned, friend code) but the app doesn't trigger them. The infrastructure is built — it just isn't wired to fire at the right moments. The next phase is not building new features; it's connecting existing ones.
