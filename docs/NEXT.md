# What's next

Working backlog, ranked. Every item says what justifies it, so a future
session can re-rank instead of guessing. Numbers are dated: re-measure
before trusting them (`/admin/usage-stats`, `/admin/users`,
`/admin/group-stats`, `/analytics/funnel`, `/admin/client-errors` — all
founder-only).

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

## Open right now

**`DIGEST_URL_NOVIDADES` is still unset in production.** The Novidades
screen shipped (`prod-2026-09-16-9`), but the daily digest push keeps
sending the legacy `/#/events?digest=<id>` until that var is set to
`true` on the production Railway service. It's read per call in
`_digest_deep_link`, so it takes effect on the next digest — no deploy.
Bundles older than `prod-2026-09-16-5` have no `/novidades` route and
would land on the default screen, so the OTA needs to have rolled first.

---

## 1. Genre in the UI

The tag ships per event from the enrichment pass (`genre`, closed
vocabulary in `enrichment.py`), but **nothing reads it yet** — that was
deliberate, so tags accumulate before the filter exists. The catalog has
no backfill: events are perishable, so it self-tags over a few weeks from
the first scrape after `prod-2026-09-16-9`.

Decided: genre **replaces** source-level follows rather than adding a
second mute axis — so this item also removes `lib/follows.js`,
`unfollowedSources` (AppContext + remote sync), and the "Seguindo"
toggle in Fontes. Fontes stays as the transparency surface showing what's
curated and tracked.

Open call: preference (ranking) vs. filter (exclusion). Recommendation on
file is ranking — a hard genre mute is set once, forgotten, and quietly
makes the catalog worse, which fights "tudo que tá rolando em Curitiba".

## 2. Channels ("Rockzão", "Pagodera")

Curated, auê-run collections people follow — the Spotify "This Is" shape.
Why it matters: a private group is empty until a member acts, and the
measurement says that's exactly where it stalls (3 people ever created an
event, 13 events across 2 groups). A channel is never empty because we
fill it, and with genre tags filling it becomes near-automatic.

The real prize is push economics: today push is one broadcast/day to 12
devices. A channel push is targeted and has a reason to exist — and it's
the only decent argument for re-enabling notifications for the 26 who
turned them off.

**Next step is the manual pilot, not the plumbing.** One channel, events
hand-picked, real push, two weeks. Mostly copy plus one push. If a
hand-curated Rockzão doesn't retain, the automated one won't either.

Two cautions, both recorded before building:
- Frame it as a **channel you follow**, not a group you're in. "This Is"
  works because nobody expects other humans in a playlist. Shipped as a
  group (member count, avatars, invite), people arrive expecting a crew
  and find a bot feed.
- Don't overload the `groups` table. Every group feature would need
  "…unless it's a channel" branches — admin checks, invite sheet,
  MembersSheet, and the primeiros-passos nudge would fire on an empty
  channel telling auê to invite people to its own channel. Share the
  event-attach + notify plumbing, not the group row.
- Batch channel pushes (one per channel per day). Someone in three
  channels could triple their notification volume, which is how push gets
  turned off.

## 3. IG avatars expire

Root cause is **not** storage — the Railway volume is shared with SQLite
and works for event flyers and user uploads. Instagram bot-detects
Railway's IP on the `instagram.com/<handle>/` scrape that *discovers* the
avatar URL, which is the only path available for the ~94 of 123 accounts
Apify never returned a `profile_pic_url` for. Downloading the bytes from
a known URL is not blocked — that's why the manual workaround
(`/admin/avatars/rehost-url`, founder fetches the og:image locally and
POSTs it) works.

Also found: `rehost_pending_avatars` is exposed at
`POST /admin/avatars/rehost` but **is not scheduled anywhere** — it only
ever runs when triggered by hand.

Three paths, decision pending:
- Get `profile_pic_url` from Apify at scrape time, killing the blocked
  scrape. The scraper already tries several field paths
  (`parentData.profilePicUrl`, `ownerProfilePicUrl`, …) and still comes
  back empty for most, so confirming whether it's actor config or an
  actor limitation needs a live run that costs Apify credit.
- Route discovery through a proxy / residential IP (paid).
- Automate the local workaround in batch from a trusted machine.

## 4. Waiting on data (check after ~23 Sep)

- **Group funnel** — `group_created`, `group_joined` (code/link),
  `group_invite_opened`, `group_invite_shared`, `group_event_created`,
  all shipped 16 Sep. The pair `group_invite_opened` → `group_joined`
  shows whether invite links convert or die at the sign-in wall. **This
  is the measurement that decides whether groups become the app's
  focus** — decide with the number, not before.
- **Eventos filter rows.** `events_filter_*` (shipped 16 Sep) records
  which of the three filter rows people touch. Cut what nobody uses; the
  date row and the week strip overlap by design.

## 5. Push opt-in

26 of 38 accounts have no push device. The mechanical trap is fixed —
the Home banner used to hide itself permanently on *any* subscribe
failure, not just an explicit denial, and both permission calls are now
timeout-guarded. What's left is the product question: when the app asks
and what it says (`PushBanner` on Home, the onboarding primer).

## 6. Notification inbox

A dedicated in-app section for things that don't need a push — friend
invites received, invites accepted, new venues tracked, new events found.
Unread badge, clear-all. Moves low-urgency events out of push (where each
one costs opt-in trust) into a pull surface. Gains weight if channels
ship, since that's where channel activity goes instead of a notification.
Needs an unread/read model — a new table keyed by user + event type, or
`analytics_events` with a `seen_at` column.

## 7. Credit for community suggestions

Suggesting an @ already works end to end (`SuggestAccountForm` →
`/accounts/requests` → `account_requests` → curator push → approve), and
approval **already** pushes the suggester and writes `Sugerida por <nome>`
into the account's notes. The gap is that the credit is invisible:
- Show "sugerida por" publicly on the source (store the `google_id`
  rather than a name string, so it can link to the profile).
- Badge on approval — the badges system already has the shape
  (`BADGES` in `badges.py`, `award_badge`, tiers); this is a dict entry
  plus one call.
- **Notify when the first event from that account lands.** The approval
  push promises "os eventos aparecem depois do próximo scrape" and never
  follows up. The first event is the moment it becomes real.

## 8. Small things

- **IG avatars** — see item 3, promoted out of this list.
- **Two accounts still uncategorised**: `@visit.curitiba`,
  `@sambacasaforte`. Data entry in `/admin/ig`, not code.

---

## Decided, don't re-litigate

- **Scrape depth stays at 5 posts/account** (16 Sep). It missed a dated
  flyer once; raising it costs Apify + Claude every day.
- **Genre replaces source follows.** No second mute axis, and the
  source-level opt-out goes away — see item 1.
- **Skipped on purpose:** surfacing `request_count` as social proof, and
  a "N fontes, X da comunidade" scoreboard on Fontes.
- **No genre backfill.** Events are perishable; the catalog turns over.

---

## State of the release machinery (16 Sep 2026)

- Production tags: `prod-2026-09-15` (baseline), then `prod-2026-09-16`
  through `-9`.
- OTA published: **1.2.4** — devices get it on a cold start, sometimes
  after two launches. Perfil's bottom line shows the running bundle and
  the device id for `OTA_CANARY_DEVICES`.
- Canary is wired but has never been used: set `OTA_CANARY_VERSION` +
  `OTA_CANARY_DEVICES` to put a build on one phone before everyone.
- iOS is public on the App Store (id `6765535013`). `/install` 302s iOS
  there; `settings.testflight_invite_url`, when set, overrides that for a
  version-bump beta window.
- Staging: https://aue-staging.up.railway.app (own database, `ENV_NAME=staging`).
- No automated check can tap a push notification — that verification is
  always manual, on a real device.
