# What's next

Working backlog, ranked. Every item says what justifies it, so a future
session can re-rank instead of guessing. Numbers are dated: re-measure
before trusting them (`/admin/usage-stats`, `/admin/users`,
`/admin/group-stats`, `/analytics/funnel` — all founder-only).

Process for anything here: `docs/RELEASE_PROCESS.md`. `main` is protected;
work goes `feat/*` → PR into `dev` → staging → release PR → production.

---

## Measured on 16 Sep 2026 (production)

| | |
|---|---|
| accounts | 38 (27 active in last 30 days) |
| in at least one group | 19 |
| with ≥1 RSVP | 17 |
| with ≥1 friend | 17 |
| with push registered | 12 |
| **who ever created an event** | **3** |
| did nothing at all (no RSVP, friend, group) | 14 |
| groups | 5 — two real crews (11 and 8 members, 8 and 5 events), one with 2 members and nothing, two created-and-abandoned |
| client errors logged | 183 uncaught JS · 145 unhandled promise · 40 failed state loads |

Caveat: `days_active` starts from 16 Sep (the activity table was created
that day and backfilled with one day per user). It means something from
~23 Sep onward.

---

## 1. Make the client errors readable — recommended next

183 uncaught errors and 145 unhandled rejections against 38 accounts, and
**not one message is readable today**: `/errors/client` stores them in
`analytics_events.properties_json`, but `/analytics/funnel` only counts by
`event_name`. Meanwhile 14 accounts did nothing at all — if some of them
crashed on first run, this is the cheapest large win available.

Build: founder-only endpoint that groups the stored messages (top message,
count, last seen, sample url/context), plus a panel in the Admin tab.
Either it finds a real bug or it rules the theory out.

## 2. Push opt-in

26 of 38 accounts have no push device. The daily digest, friend requests
and event invites all reach under a third of users — and we just spent a
release fixing where notification taps land. Look at when the app asks and
what it says (`PushBanner` on Home, the onboarding primer).

## 3. `/#/novidades/:digestId` page

Agreed, not built. The digest push currently lands on Eventos with a
filter, and the filter parameter is stripped from the URL immediately —
so a refresh loses it and there's no way back to "what was new today".

**Sequencing is load-bearing:** ship the route (and a Home entry point)
first, let the OTA bundle roll out, and only then change the backend's
digest URL. Phones run whatever bundle they last downloaded; pointing the
backend at a route an old bundle doesn't have sends those users to the
default screen — the exact bug that was just fixed.

## 4. Group "first event" nudge

19 of 38 are in a group, but only 3 people have ever created an event and
all 13 events live in 2 groups. So the gap is *creating*, not
understanding what a group is. Aim a "primeiros passos" panel at the
first event inside a group; the two solo-and-empty groups (creator never
invited anyone) are a smaller, separate problem.

Tracking shipped 16 Sep: `group_created`, `group_joined` (code/link),
`group_invite_opened`, `group_invite_shared`, `group_event_created`. The
pair `group_invite_opened` → `group_joined` shows whether invite links
convert or die at the sign-in wall.

## 5. Waiting on data (check after ~23 Sep)

- **Eventos filter rows.** Three rows of filters, and `events_filter_*`
  (shipped 16 Sep) records which ones people touch. Cut what nobody uses;
  the date row and the week strip overlap by design.
- **Group funnel**, per the events above.

## 6. Notification inbox

Idea from 16 Sep: a dedicated in-app section for things that don't need a
push — friend invites received, invites accepted, new venues added to
tracking, new events found. Unread count as a badge (e.g. on Profile or a
bell icon), clear-all action. Goal: move low-urgency events out of push
(where every one costs opt-in trust, see item 2) into a pull surface the
user checks when they want to. Needs an unread/read model — likely a new
table keyed by user + event type, or reuse `analytics_events` with a
`seen_at` column.

## 7. Small things

- **Users table fails silently.** `UsersTable` returns `null` when its
  fetch fails — no message — so "not deployed yet" and "broken" look
  identical. Show an error with a retry.
- **IG avatars expire.** Instagram CDN URLs die after a few days and
  re-hosting them fails on Railway, so venue avatars go blank over time.
- **eslint React plugin missing** — ~288 warnings, nearly all false
  "unused" flags on JSX components, which hides real ones.
- **Curators are matched by email**, so a curator signed in with Apple's
  private relay address never gets curator pushes.
- **Scrape depth is 5 posts/account**; it missed a dated flyer once
  (Baque Mulher, 16 Sep). Raising it costs Apify + Claude per day.
- **Dedupe prefers a manual submission** over the venue's own IG post.
- **Two accounts still uncategorised**: `@visit.curitiba`,
  `@sambacasaforte`.

---

## State of the release machinery (16 Sep 2026)

- Production tags: `prod-2026-09-15` (baseline), `prod-2026-09-16`,
  `-2`, `-3`, `-4`.
- OTA published: **1.2.4** — devices get it on a cold start, sometimes
  after two launches. Perfil's bottom line shows the running bundle and
  the device id for `OTA_CANARY_DEVICES`.
- Canary is wired but has never been used: set `OTA_CANARY_VERSION` +
  `OTA_CANARY_DEVICES` to put a build on one phone before everyone.
- Staging: https://aue-staging.up.railway.app (own database, `ENV_NAME=staging`).
- No automated check can tap a push notification — that verification is
  always manual, on a real device.
