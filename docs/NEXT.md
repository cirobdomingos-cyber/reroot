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

Both of these are Railway env vars, read per request — no deploy, no
code. There is no Railway CLI on this machine; they're set by hand in
the dashboard.

**`TESTFLIGHT_INVITE_URL` is still set in production**, left over from a
beta window. `/install` reads `settings.testflight_invite_url or
APP_STORE_URL`, so the override is silent: every iOS visitor sent to
`/install` lands on a TestFlight invite instead of the public App Store
listing. Verified 19 Sep — `GET /install` with an iPhone UA returns
`302 → testflight.apple.com/join/…`. Clear the var.

**`DIGEST_URL_NOVIDADES` is still unset in production.** The Novidades
screen shipped (`prod-2026-09-16-9`), but the daily digest push keeps
sending the legacy `/#/events?digest=<id>` until that var is set to
`true` on the production Railway service. It's read per call in
`_digest_deep_link`, so it takes effect on the next digest — no deploy.
Bundles older than `prod-2026-09-16-5` have no `/novidades` route and
would land on the default screen, so the OTA needs to have rolled first.

---

## 1. Editing a catalog event

There is no way to edit a catalog event. `PATCH /events/{id}` checks
creator-or-co-host and serves group events only; the catalog has just
`DELETE /admin/events/{id}`. When the extraction gets a fact wrong, the
only lever is deleting the event.

What forced this up the list: a user reported an event "in the wrong
place", and the investigation (19 Sep) found the bairro was an LLM guess
re-rolled per event — 100 of 123 events disagreed with the geocoded
`venues.bairro`. That part is fixed in its own PR by preferring the
geocoded value, no editor needed. What the fix can't reach is a venue
*name* that is itself wrong: the catalog currently carries `"Curitiba/PR"`
as a venue.

Scope: founder/curator `PATCH /admin/events/{id}` over name, venue, date,
price, category, genre — plus the pin, which is a different store. A
wrong pin is already fixable through `PUT /admin/venues/{name_normalized}`
(validates the coords land in Curitiba), but **that endpoint has no UI at
all**; the only frontend caller of `/admin/venues` is the leaderboard.

Free consequence: the group-event merge layer (`_merge_group_event_with_
catalog`) already reads facts from the catalog row and pins only fields a
human edited, in `edited_fields`. So fixing the catalog propagates into
every group that forked that event, with no extra work.

Related and cheap: a catalog event gives no sign it's already in one of
your channels. `GET /catalog-events/{id}/groups` returns
`linked_group_ids` today and only `AddToGroupSheet` reads it — nothing
renders it on the card.

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

**Naming, decided 19 Sep: everything is a "canal".** A user-created
channel would be private, and a private channel is what a group already
is — so rather than carry two words for one structure, groups are renamed
to channels and the auê-curated ones are channels with a badge.

That reopens the risk the original caution was guarding against, so it
gets solved by shape instead of by vocabulary: **same word, opposite
affordances.**

|  | canal privado | canal do auê |
|---|---|---|
| people in it | membros, com convite | seguidores |
| how you get in | invite code | tap "Seguir" from a public list |
| invite nudge | yes | **never** |

Showing *who* is in a channel is fine and wanted (19 Sep) — social proof.
The thing that reads wrong is asking someone to **invite** their friends
into a channel auê runs, so the primeiros-passos nudge must not fire
there.

Nobody is ever auto-enrolled. A curated channel is discoverable and
opt-in; today a group is invisible without an invite code, because
`GET /groups` only returns groups you already belong to. Discovery is the
actual missing piece — `groups.visibility` already accepts `'public'`,
and `GET /groups/{id}` already serves a public group to a non-member.

One caution still stands as written:
- Don't overload the `groups` table. Every group feature would need
  "…unless it's a channel" branches — admin checks, invite sheet,
  MembersSheet, and the primeiros-passos nudge would fire on an empty
  channel telling auê to invite people to its own channel. Share the
  event-attach + notify plumbing, not the group row.
- Batch channel pushes (one per channel per day). Someone in three
  channels could triple their notification volume, which is how push gets
  turned off.

### Genre is the ingredient, the channel is the dish

Genre used to be item 1 on its own — a filter or ranking axis in Eventos.
Decided 19 Sep that it isn't: **genre and channels are the same
personalization idea at two layers**, and shipping both means building
two systems, explaining two surfaces and measuring two things.

| | genre | channel |
|---|---|---|
| what it is | machine attribute on an event | container a human follows |
| cost | already paid in enrichment | curation |
| has a name and a voice | no | yes |
| can push you | no | yes |

A channel is, at its simplest, a saved genre query with a name, a cover
and the right to notify — then hand-tuned. So:

- **Don't build the genre chip row in Eventos.** The open call this list
  carried ("preference vs. filter") is void; neither ships. Genre stays
  invisible to the user and becomes curation infrastructure.
- Genre also stops being the thing that replaces source-level follows —
  channels are. `lib/follows.js` and `unfollowedSources` still go away,
  but as part of channels, not as part of a genre filter.
- ~~Start channels **hand-picked**, with genre as a suggestion tool for the
  curator.~~ **Shipped 23 Sep: channels carry a rule and the scrape fills
  them.** A rule is a set of event `tipo`s and/or `genre`s (AND across the
  two axes, OR within one); every scrape ends by backfilling missing tags,
  forking every matching upcoming catalog event into every rule channel,
  and sending one push per channel that gained something. The fill only
  adds — a curator pulling an event writes a `channel_exclusions` row and
  it stays out. `scripts/reshape_channels.py` applied the 23 Sep plan
  (Comédia and Livros created, Balada → Eletrônica, MPB + Jazz merged,
  Cultura narrowed to teatro/cinema/exposição/oficina).

### `tipo` is the axis `kind` never was (23 Sep)

Measured 23 Sep on 167 upcoming events: `kind` put 129 in "community";
the chips in Eventos group by the *venue's* category (a bar posting a
book launch is "Bares"); genre covers the music half only. Comedy — 17
events, the most homogeneous cluster in the catalog — had no axis at
all. `tipo` (show, festa, comedia, teatro, cinema, literatura, exposicao,
gastronomia, oficina, esporte, kids, feira, outro) says *what happens*;
genre says *what sound*; the handle category says *where*. One dimension
per question.

Still open, in order:
- **Eventos chips by `tipo`, not by handle category.** "Comédia · 17"
  is a question people ask; "Bares · 40" isn't. Same `CATEGORY_META`
  pattern, different source field.
- **Aggregator handles leak other cities.** @corridasparana, @eventimbrasil,
  @shotgun.br, @bilheteriadigital post Paranavaí, Cascavel, Vila Velha,
  Leblon; `neighborhood_guess` then invents a Curitiba bairro and the
  region rule in the prompt never fires. Hotfix-shaped: guard on the
  extracted city, not the guessed bairro.
- **Dedup across posts of one event** (Semana Kids ×4, Piquenique com
  Livros ×2). Part of why "too many events arrive".
- `kind` is now dead weight; remove with the `RerootCategory` cleanup.

**Backfill: reversed, on purpose.** The "no genre backfill" call was
right when genre was a filter — events are perishable, the catalog turns
over. It's wrong now: on 19 Sep only 32 of 128 upcoming events carried a
tag, so a Rockzão assembled from tags alone would open with six events.
Backfill **future untagged events only**, once, on a cheap model. That is
a different thing from reprocessing history, which stays off the table.

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

## 6. Navigation: Home dissolves, Notificações arrives

Decided 19 Sep, from watching how it's actually used: people want the
full catalog on open and go to community second, and the RSVPs tab isn't
earning its slot.

```
before:  Home · Eventos · RSVPs · Comunidade
after:   Eventos · Notificações · Comunidade · Perfil
         (start route → /events)
```

`Home.jsx` is 1301 lines and holds things that exist nowhere else —
pendências, the friends activity feed, the digest card, the push banner.
Dissolving it without a destination is how those die quietly. The
destination is the new Notificações tab, which is item 6 of the previous
backlog (the notification inbox) promoted: it stops being a nice-to-have
and becomes the load-bearing piece that makes the rest of this possible.
RSVPs and the friends feed go to Comunidade.

**Badge rule, decided up front:** the bubble counts only what needs *you*.

| counts | shows in the tab, doesn't count |
|---|---|
| event invite with no answer | daily novidades |
| friend request | newly tracked venue |
| channel invite | new event in a channel you follow |
| pending curation (founder) | a friend RSVPed |

A badge that never reaches zero is one people stop reading within a week,
and "there is new stuff" never reaches zero.

Needs a real read/unread model — a `notifications` table keyed by user +
type + ref with `seen_at`, and one cheap count endpoint, not N queries.
`hasSeenDigest` in `Novidades.jsx` is localStorage per device; it's right
for the digest card and wrong for this.

This is the most invasive item in the list, so it goes last.

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
- **No Open Graph tags anywhere.** `index.html` carries `description` and
  nothing else — no `og:title`, `og:image` or `twitter:card` — so a
  shared auê link renders as a bare URL in WhatsApp. Sharing the App
  Store link instead doesn't rescue it: Apple forces the `au%C3%AA` slug
  (verified 19 Sep, `/br/app/aue/id6765535013` redirects back to the
  percent-encoded form), so the preview shows an unreadable URL. Fix is
  og tags on our own page, then share `auecuritiba.com` rather than the
  Apple link — the `apple-itunes-app` meta already handles the Safari
  banner and `/install` handles the redirect.

---

## Decided, don't re-litigate

- **Scrape depth stays at 5 posts/account** (16 Sep). It missed a dated
  flyer once; raising it costs Apify + Claude every day.
- **Skipped on purpose:** surfacing `request_count` as social proof, and
  a "N fontes, X da comunidade" scoreboard on Fontes.
- **Genre is not a user-facing filter** (19 Sep). It feeds channels; the
  "preference vs. filter" question is void. See item 2.
- **Genre backfill: future untagged events only** (19 Sep) — reverses the
  16 Sep "no backfill" call, because channels need density that perishable
  tagging won't reach in time. History stays untouched.
- **Everything is called a "canal"** (19 Sep). Groups are renamed; the
  auê-curated ones are channels with a badge. Distinguished by
  affordances, not by vocabulary — see item 2.
- **Followers are visible on a channel** (19 Sep). What doesn't ship is
  the invite nudge inside an auê-curated one.
- **User-created public channels are deferred.** A user channel is
  private, i.e. today's group. Curated first, prove retention, then open
  creation.
- **The bairro shown next to a venue comes from `venues.bairro`, not the
  enrichment guess** (19 Sep). `neighborhood_guess` is a guess and was
  wrong on 100 of 123 events.

---

## State of the release machinery (16 Sep 2026)

- Production tags: `prod-2026-09-15` (baseline), then `prod-2026-09-16`
  through `-9`.
- OTA published: **1.2.11** as of 19 Sep — devices get it on a cold start, sometimes
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
