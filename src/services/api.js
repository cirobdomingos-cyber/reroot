/**
 * Camada de acesso a dados do Reroot.
 *
 * Offline-first: usa dados embutidos como fonte primária.
 * Se um backend estiver disponível, tenta buscar dados ao vivo
 * e mescla com os dados locais.
 */
import { EVENTS } from '../data/events'
import { getAnchorToday } from '../lib/dateAnchor'

// In production (single-service deploy), API is same-origin → empty string.
// In local dev, frontend runs on :5173 and backend on :8000.
const BASE_URL = import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? 'http://localhost:8000' : '')
const TIMEOUT_MS = 5000

// ── Client error reporter ─────────────────────────────────
// Fire-and-forget. Never throws. Used to surface silent failures in production.
function getSessionId() {
  const KEY = 'aue_session_id'
  let id = sessionStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)
    sessionStorage.setItem(KEY, id)
  }
  return id
}

export function reportError(errorType, message = '', context = {}, googleId = '') {
  try {
    fetch(`${BASE_URL}/errors/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error_type: errorType,
        message: String(message).slice(0, 500),
        context,
        session_id: getSessionId(),
        google_id: googleId,
      }),
    }).catch(() => {}) // truly last-resort — if error reporting fails, nothing more to do
  } catch {
    // Error reporting must never break the app
  }
}

// Sync status — observable by UI components
let _syncListeners = []
let _lastSyncStatus = { ok: true, lastSavedAt: null, lastError: null, retrying: false }

export function getSyncStatus() { return _lastSyncStatus }

export function onSyncStatusChange(fn) {
  _syncListeners.push(fn)
  return () => { _syncListeners = _syncListeners.filter(l => l !== fn) }
}

function setSyncStatus(update) {
  _lastSyncStatus = { ..._lastSyncStatus, ...update }
  _syncListeners.forEach(fn => fn(_lastSyncStatus))
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(id)
    return res
  } catch (err) {
    clearTimeout(id)
    throw err
  }
}

// Drop events whose date is before today (in the user's local timezone).
// "Today" is 6am-anchored — see lib/dateAnchor. So an event from 22:00
// yesterday is still in-window until 06:00 today, which is what users
// expect for late shows that run past midnight. After 06:00 the cutoff
// rolls forward to today and yesterday's late events drop off.
// Evergreen entries (no dateStart) are kept.
function dropPastEvents(events) {
  const cutoff = getAnchorToday().getTime()
  return events.filter(ev => {
    if (!ev.dateStart) return true
    const t = Date.parse(ev.dateStart)
    return Number.isNaN(t) || t >= cutoff
  })
}

function computeDateTag(dateStartIso) {
  if (!dateStartIso) return 'anytime'
  const now = new Date()
  const eventDate = new Date(dateStartIso)
  const diffDays = Math.floor((eventDate - now) / (1000 * 60 * 60 * 24))
  const eventDay = eventDate.getDay() // 0=Sun, 6=Sat

  if (diffDays < 0) return null // past — will be filtered
  if (diffDays <= 7) {
    if (eventDay === 0 || eventDay === 6) return 'this_weekend'
    return 'this_week'
  }
  if (diffDays <= 14) return 'next_week'
  return 'anytime'
}

function normalizeBackendEvent(ev) {
  return {
    id: ev.id,
    name: ev.name,
    category: ev.category,
    categoryLabel: ev.categoryLabel,
    categoryEmoji: ev.categoryEmoji,
    venue: ev.venue,
    date: ev.date,
    time: ev.time,
    duration: ev.duration,
    headerBg: ev.headerBg,
    icon: ev.icon,
    description: ev.description || '',
    price: ev.price,
    priceTier: ev.priceTier,
    kidsWelcome: ev.kidsWelcome ?? false,
    hasFood: ev.hasFood,
    isLowPressure: ev.isLowPressure,
    attendeesConfirmed: ev.attendeesConfirmed,
    expectedSize: ev.expectedSize,
    vibeSummary: ev.vibeSummary,
    pitch: ev.pitch,
    url: ev.url,
    source: ev.source || 'live',
    igHandle: ev.igHandle || null,
    openNow: typeof ev.openNow === 'boolean' ? ev.openNow : null,
    rating: ev.rating ?? 0,
    placeSubtype: ev.placeSubtype,
    isReal: true,
    dateStart: ev.dateStart,
    // dateEnd is null for one-off events; populated for ranges
    // (multi-day exhibitions, "Tuesday through Sunday" runs). Frontend
    // uses it to make the event surface on each day in the range.
    dateEnd: ev.dateEnd ?? null,
    dateTag: computeDateTag(ev.dateStart),
    // Recurring routines (e.g. weekly bar happy hour). The API has been
    // shipping these since the recurring-events PR, but this normalizer
    // was dropping them because they weren't on the whitelist — frontend
    // saw isRecurring=undefined and rendered cards as one-offs.
    isRecurring: ev.isRecurring ?? false,
    recurrenceLabel: ev.recurrenceLabel ?? null,
    recurrenceDays: ev.recurrenceDays ?? [],
    // Personal plans — events created with a hand-picked invitee list
    // outside any group. isGroupEvent stays true so the existing private
    // styling (sage stripe, "yours" tinted card) applies; isPersonalPlan
    // flips the label from "Grupo" to "Plano de <criador>".
    isGroupEvent: ev.isGroupEvent ?? false,
    isPersonalPlan: ev.isPersonalPlan ?? false,
    groupId: ev.groupId ?? null,
    groupName: ev.groupName ?? '',
    createdBy: ev.createdBy ?? null,
    inviteeCount: ev.inviteeCount ?? 0,
    note: ev.note ?? '',
    sourceIgHandle: ev.sourceIgHandle ?? '',
    // Pin coordinates — populated when the venue's been geocoded. Map
    // view filters out events where these are null. List view ignores.
    lat: typeof ev.lat === 'number' ? ev.lat : null,
    lng: typeof ev.lng === 'number' ? ev.lng : null,
    // Bairro from the geocoded venues cache. Frontend prefers this over
    // the legacy "Venue · Bairro" suffix split for the venue chip on
    // event cards. Empty string when the venue isn't geocoded yet.
    bairro: ev.bairro || '',
    // Destaque flag — events from a featured (paid) IG handle or
    // aue_originals. Drives a star pill on the card and top-of-list
    // sorting on the Events tab.
    featured: !!ev.featured,
    // Promo code — set only for paid Seleção auê venues. The card
    // reveals "🎁 Mostrar código no balcão" when promoCode is non-
    // empty; perk is the short user-facing copy ("primeiro chopp
    // grátis").
    promoCode: ev.promoCode || '',
    promoPerk: ev.promoPerk || '',
    // Sympla buy-link — empty when this event has no matched Sympla
    // page. Frontend renders the 🎟️ CTA only when set, and appends
    // utm_source=aue at click time so we can show venues "auê drove
    // X clicks to your Sympla event last month."
    symplaUrl: ev.symplaUrl || '',
    // Detail-only fields — present when fetched via /events/{id}
    venueAddress: ev.venueAddress,
    city: ev.city,
    // Rehosted-image URLs come back as a relative path (/event-images/<id>.jpg)
    // because in production the FastAPI backend serves both static assets
    // and the SPA from the same origin. In dev, Vite sits on :5173 while
    // the backend is on Railway / :8000, so a bare relative path tries to
    // load from :5173 and 404s. Prefix with BASE_URL when it's set so the
    // hero banner works locally without a dev-time backend running.
    imageUrl: (ev.imageUrl && ev.imageUrl.startsWith('/event-images/') && BASE_URL)
      ? `${BASE_URL}${ev.imageUrl}`
      : ev.imageUrl,
  }
}

// Mood IDs that route to Google Places (not /events). These are venue
// browsers, not scheduled events.
const PLACES_MOODS = new Set(['bars_cafes', 'parks', 'cinema', 'bookstore'])
// Old export name kept for any straggler imports
const PLACES_CATEGORIES = PLACES_MOODS

async function fetchPlaces(type) {
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/places?type=${type}&limit=20`)
    if (res.ok) {
      const data = await res.json()
      const places = data.places || []
      if (places.length > 0) {
        return { events: places, source: 'places', city: 'Curitiba' }
      }
    }
  } catch {
    // Backend unavailable or Places key not configured — fall through to static data
  }
  return null
}

export async function fetchEvents(mood = 'all', { curated = false } = {}) {
  // Venue-type "moods" route to Google Places, not /events. They're a
  // separate browse mode — venues you can drop into anytime.
  if (mood && PLACES_MOODS.has(mood)) {
    const result = await fetchPlaces(mood)
    if (result) return result
  }

  // Static fallback: filter by event.category if it's a known kind. The
  // newer moods (cultural, familia) don't map cleanly to the static EVENTS
  // shape — we just return the unfiltered list and let the backend take
  // over when it's reachable. EVENTS is empty in production anyway.
  const filtered = mood && mood !== 'all'
    ? EVENTS.filter(e => e.category === mood)
    : EVENTS

  // Try backend as a bonus — don't block on it
  try {
    // Pull the full upcoming catalog. The Fontes screen counts every
    // future event per source; capping /events at 40 made "Tudo" show
    // a strict subset (e.g. 35 here vs. 71 in Fontes), so handles that
    // sorted late lost their events from view. Catalog is ~150 events
    // tops — one fetch handles it.
    const params = new URLSearchParams({ limit: '500' })
    if (mood && mood !== 'all') params.set('mood', mood)
    if (curated) params.set('good_only', 'true')
    const url = `${BASE_URL}/events?${params.toString()}`

    const res = await fetchWithTimeout(url)
    if (res.ok) {
      const data = await res.json()
      const liveEvents = dropPastEvents((data.events || []).map(normalizeBackendEvent))
      if (liveEvents.length > 0) {
        return { events: liveEvents, source: 'live', city: data.city || 'Curitiba' }
      }
    }
  } catch {
    // Backend unavailable — that's fine, use embedded data
  }

  return { events: dropPastEvents(filtered), source: 'local', city: 'Curitiba' }
}

export async function fetchEventDetail(eventId, googleId = '') {
  // Try backend first for richer data. Pass google_id when known so the
  // server can authorize personal-plan reads (creator + invitees only —
  // catalog events ignore the param). Returns:
  //   - { event } on success
  //   - { event: null, forbidden: true, message } on 403 (private)
  //   - { event: null, networkError: true } on timeout / fetch failure
  //     (so the caller can show "couldn't load now" vs. "doesn't exist")
  try {
    const url = googleId
      ? `${BASE_URL}/events/${eventId}?google_id=${encodeURIComponent(googleId)}`
      : `${BASE_URL}/events/${eventId}`
    const res = await fetchWithTimeout(url)
    if (res.ok) {
      const data = await res.json()
      return { event: normalizeBackendEvent(data), source: 'live' }
    }
    if (res.status === 403) {
      let msg = ''
      try { msg = (await res.json()).detail || '' } catch {}
      return { event: null, source: 'forbidden', forbidden: true, message: msg }
    }
    // 404 (or any other non-OK): fall through to embedded data — if it's
    // not in the static seed either, the caller will render "not found".
  } catch {
    // Network failure or timeout. Distinguish from a real 404 so the UI
    // can suggest a retry instead of "this event no longer exists".
    return { event: null, source: 'network-error', networkError: true }
  }

  const event = EVENTS.find(e => e.id === eventId) || null
  return { event, source: 'local' }
}

export async function checkBackendHealth() {
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/health`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

// Track whether a remote load is in-flight so saves don't race against it
let _loadInFlight = false
export function isLoadInFlight() { return _loadInFlight }

export async function loadUserState(googleId) {
  _loadInFlight = true
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/user/state/${encodeURIComponent(googleId)}`)
    if (res.ok) {
      const data = await res.json()
      return data.state
    }
    if (res.status === 404) return null // no remote state yet — not an error
    reportError('sync_load_failed', `HTTP ${res.status}`, { googleId: googleId.slice(0, 20) }, googleId)
  } catch (err) {
    reportError('sync_load_failed', err.message, { googleId: googleId.slice(0, 20) }, googleId)
  } finally {
    _loadInFlight = false
  }
  return null
}

const MAX_SAVE_RETRIES = 3

export async function saveUserState(googleId, state) {
  // Block saves while a remote load is in flight to prevent race conditions
  if (_loadInFlight) return

  let lastError = null
  for (let attempt = 0; attempt < MAX_SAVE_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        setSyncStatus({ retrying: true })
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt))) // exponential backoff
      }
      const res = await fetchWithTimeout(`${BASE_URL}/user/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ google_id: googleId, state }),
      })
      if (res.ok) {
        const data = await res.json()
        setSyncStatus({ ok: true, lastSavedAt: data.saved_at || Date.now(), lastError: null, retrying: false })
        return // success
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err.message
    }
  }

  // All retries exhausted — report the failure
  setSyncStatus({ ok: false, lastError, retrying: false })
  reportError('sync_save_failed', lastError, {
    googleId: googleId.slice(0, 20),
    retries: MAX_SAVE_RETRIES,
    stateKeys: Object.keys(state).join(','),
  }, googleId)
}

/**
 * Sync an RSVP action to the backend.
 * Fire-and-forget — never throws, never blocks the UI.
 *
 * isRsvped=true  → POST /rsvp   (user just RSVPd)
 * isRsvped=false → DELETE /rsvp/{event_id}  (user un-RSVPd)
 */
export async function syncRsvp(googleId, event, isRsvped) {
  try {
    const res = isRsvped
      ? await fetch(`${BASE_URL}/rsvp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            google_id: googleId,
            event_id: event.id,
            event_name: event.name,
            event_venue: event.venue,
            // Send the ISO date (event.dateStart) so the backend can
            // compare it against today.isoformat() in /friends/feed.
            // event.date is the display string ("Sex, 25 Abr") and
            // breaks the lexicographic past/future filter.
            event_date: event.dateStart || event.date || '',
            // Pydantic rejects null on a string field — coerce to empty.
            event_url: event.url || '',
          }),
        })
      : await fetch(
          `${BASE_URL}/rsvp/${encodeURIComponent(event.id)}?google_id=${encodeURIComponent(googleId)}`,
          { method: 'DELETE' },
        )
    if (!res.ok) {
      reportError('rsvp_sync_failed', `HTTP ${res.status}`, {
        eventId: event.id, action: isRsvped ? 'add' : 'remove',
      }, googleId)
      return null
    }
    // POSTs return the badge eval result; DELETE doesn't. Caller can
    // ignore for DELETE (returns {ok: true} with no new_badges array).
    if (!isRsvped) return null
    const data = await res.json()
    dispatchBadgeUnlocks(data?.new_badges)
    return data
  } catch (err) {
    reportError('rsvp_sync_failed', err.message, {
      eventId: event.id, action: isRsvped ? 'add' : 'remove',
    }, googleId)
    return null
  }
}

// ── Badges ──
// Catalog is static — fetch once and cache. for-user list refreshes after
// every action that might earn one (RSVP, friend-add, group-create/join).
export async function fetchBadgesCatalog() {
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/badges/catalog`)
    if (res.ok) return (await res.json()).badges || []
  } catch {}
  return []
}

export async function fetchUserBadges(googleId) {
  if (!googleId) return []
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/user/${encodeURIComponent(googleId)}/badges`
    )
    if (res.ok) return (await res.json()).badges || []
  } catch {}
  return []
}

// Lifetime / personal-best counters (Recordes Pessoais).
export async function fetchUserStats(googleId) {
  if (!googleId) return null
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/user/${encodeURIComponent(googleId)}/stats`
    )
    if (res.ok) return await res.json()
  } catch {}
  return null
}

// Fires a window event for each newly-earned badge so BadgeUnlockToast
// (mounted at App.jsx) can surface it without needing every callsite to
// own toast UI. Backend returns rich objects {id, label, emoji, desc,
// instance, ...} so the toast renders without a catalog roundtrip.
// Safe to call with empty/null arrays.
function dispatchBadgeUnlocks(newBadges) {
  if (!Array.isArray(newBadges) || newBadges.length === 0) return
  for (const badge of newBadges) {
    try {
      window.dispatchEvent(new CustomEvent('badge-unlocked', { detail: badge }))
    } catch {}
  }
}

/**
 * Fetch the friends social feed for a given user.
 * Returns an array of events (possibly empty) each with a friends_going list.
 */
export async function fetchFriendsFeed(googleId) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/friends/feed?google_id=${encodeURIComponent(googleId)}`
    )
    if (res.ok) {
      const data = await res.json()
      return data.events ?? []
    }
  } catch {
    // Backend unavailable — silently return empty
  }
  return []
}

export async function triggerRefresh() {
  const res = await fetch(`${BASE_URL}/events/refresh`, { method: 'POST' })
  if (!res.ok) throw new Error('Refresh falhou')
  return res.json()
}

export async function trackEvent(eventName, properties = {}) {
  try {
    await fetch(`${BASE_URL}/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_name: eventName,
        properties,
        session_id: getSessionId(),
      }),
    })
  } catch {
    // Swallow all errors — analytics must never break the product
  }
}

// ── Event attendees API ───────────────────────────────────

/**
 * Fetch attendees for a past event (post-event "People you met" flow).
 * Returns array of { google_id, name, picture, is_friend, friend_code }.
 * Graceful fallback: returns empty array if backend is unavailable.
 */
export async function fetchEventAttendees(eventId, googleId) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/events/${encodeURIComponent(eventId)}/attendees?google_id=${encodeURIComponent(googleId)}`
    )
    if (res.ok) {
      const data = await res.json()
      return data.attendees ?? []
    }
  } catch {
    // Backend unavailable — silently return empty
  }
  return []
}

// ── Friends API ────────────────────────────────────────────

export async function lookupFriendInvite(code) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/friends/lookup?code=${encodeURIComponent(code)}`
    )
    if (res.ok) return await res.json()
  } catch {
    // Backend unavailable
  }
  return null
}

export async function lookupGroupInvite(inviteCode) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/groups/by-invite/${encodeURIComponent(inviteCode)}`
    )
    if (res.ok) return await res.json()
  } catch {
    // Backend unavailable
  }
  return null
}

export async function getMyFriendCode(googleId) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/friends/my-code?google_id=${encodeURIComponent(googleId)}`
    )
    if (res.ok) return (await res.json()).code
  } catch {
    // Backend unavailable
  }
  return null
}

export async function addFriend(googleId, code) {
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/friends/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ google_id: googleId, code }),
    })
    if (res.ok) {
      const data = await res.json()
      dispatchBadgeUnlocks(data?.new_badges)
      return data
    }
  } catch {
    // Backend unavailable
  }
  return null
}

export async function removeFriend(googleId, friendGoogleId) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/friends/${encodeURIComponent(friendGoogleId)}?google_id=${encodeURIComponent(googleId)}`,
      { method: 'DELETE' },
    )
    if (res.ok) return await res.json()
  } catch {
    // Backend unavailable — caller can show a generic error
  }
  return null
}


export async function getFriends(googleId) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/friends?google_id=${encodeURIComponent(googleId)}`
    )
    if (res.ok) return (await res.json()).friends
  } catch {
    // Backend unavailable
  }
  return []
}

// ── Sources catalog (transparency surface) ───────────────

// Prefix BASE_URL when a path is one of our rehosted-image routes.
// Same dev-vs-prod logic as the event imageUrl normalizer: in prod
// BASE_URL is empty (same-origin SPA + backend) so this is a no-op;
// in dev Vite is on :5173 and the static images live on Railway, so
// without the prefix the <img> tries to fetch from :5173 and 404s.
export function absoluteImageUrl(url) {
  if (!url) return url
  if (BASE_URL && url.startsWith('/event-images/')) {
    return `${BASE_URL}${url}`
  }
  return url
}

export async function fetchSources() {
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/sources`)
    if (!res.ok) return { institutional: [], instagram: [] }
    const data = await res.json()
    // Rehosted IG avatars come back as a relative /event-images/avatars
    // path. Normalize them to absolute in dev so the <img> doesn't 404
    // against Vite. Production keeps the relative path (same origin).
    const fix = (rows) => (rows || []).map(r => ({
      ...r,
      profile_pic_url: absoluteImageUrl(r.profile_pic_url),
    }))
    return {
      institutional: fix(data.institutional),
      instagram: fix(data.instagram),
    }
  } catch {
    // Backend unavailable — silently return empty buckets
  }
  return { institutional: [], instagram: [] }
}

export async function fetchVenueLeaderboard(requestingEmail, windowDays = 30) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/admin/venues/leaderboard?requesting_email=${encodeURIComponent(requestingEmail || '')}&window_days=${windowDays}`,
    )
    if (!res.ok) return { venues: [] }
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('application/json')) return { venues: [] }
    const data = await res.json()
    return {
      venues: (data.venues || []).map(v => ({
        ...v,
        profile_pic_url: absoluteImageUrl(v.profile_pic_url),
      })),
    }
  } catch {
    return { venues: [] }
  }
}

export async function fetchVenueDashboard(handle, requestingEmail) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/venue/${encodeURIComponent(handle)}/stats?requesting_email=${encodeURIComponent(requestingEmail || '')}`,
    )
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.json()).detail || '' } catch {}
      return { error: detail || `HTTP ${res.status}`, status: res.status }
    }
    // Defensive content-type check. When the backend hasn't deployed
    // the /venue/{handle}/stats route yet, the SPA fallback at /
    // returns index.html with a 200, and res.json() blows up with
    // "Unexpected token '<', '<!DOCTYPE'…". Treat that as "endpoint
    // not available yet" rather than a parse error.
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('application/json')) {
      return {
        error: 'O painel ainda não está disponível neste servidor. Aguarde o deploy ou recarregue.',
        status: 503,
      }
    }
    const data = await res.json()
    if (data?.profile_pic_url) {
      data.profile_pic_url = absoluteImageUrl(data.profile_pic_url)
    }
    // events_breakdown rows carry rehosted IG post images. Apply the
    // same dev-prefix so the thumbnails load against the Railway
    // backend instead of Vite's :5173.
    if (Array.isArray(data?.events_breakdown)) {
      data.events_breakdown = data.events_breakdown.map(e => ({
        ...e,
        image_url: absoluteImageUrl(e.image_url),
      }))
    }
    return data
  } catch (e) {
    return { error: e?.message || 'fetch failed', status: 0 }
  }
}

export async function fetchSourceDetail(sourceId) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/sources/${encodeURIComponent(sourceId)}`
    )
    if (!res.ok) return null
    const data = await res.json()
    // Same dev-prefix logic as fetchSources — rehosted avatars come
    // back as relative paths and 404 against Vite without the prefix.
    if (data?.source?.profile_pic_url) {
      data.source.profile_pic_url = absoluteImageUrl(data.source.profile_pic_url)
    }
    return data
  } catch {
    // Backend unavailable
  }
  return null
}


/**
 * AI Companion — send a message and get back a response with optional event suggestions.
 * Sends the full event catalog so the LLM always has events to recommend
 * (works even when the scraper DB is empty — offline-first pattern).
 */
// ── Groups API ────────────────────────────────────────────

export async function createGroup(googleId, { name, description = '', visibility = 'private' }) {
  const res = await fetchWithTimeout(`${BASE_URL}/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ google_id: googleId, name, description, visibility }),
  })
  if (!res.ok) throw new Error(`Create group failed: ${res.status}`)
  const data = await res.json()
  dispatchBadgeUnlocks(data?.new_badges)
  return data
}

export async function fetchGroups(googleId) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/groups?google_id=${encodeURIComponent(googleId)}`
    )
    if (res.ok) return (await res.json()).groups
  } catch {
    // Backend unavailable
  }
  return []
}

export async function fetchGroupDetail(groupId, googleId) {
  const res = await fetchWithTimeout(
    `${BASE_URL}/groups/${encodeURIComponent(groupId)}?google_id=${encodeURIComponent(googleId)}`
  )
  if (!res.ok) throw new Error(`Group detail failed: ${res.status}`)
  return res.json()
}

export async function updateGroup(groupId, googleId, fields) {
  // fields: { name?, description?, visibility? } — admin-only on backend
  const res = await fetchWithTimeout(
    `${BASE_URL}/groups/${encodeURIComponent(groupId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ google_id: googleId, ...fields }),
    },
  )
  if (!res.ok) throw new Error(`Update group failed: ${res.status}`)
  return res.json()
}

export async function joinGroup(googleId, inviteCode) {
  const res = await fetchWithTimeout(`${BASE_URL}/groups/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ google_id: googleId, invite_code: inviteCode }),
  })
  if (!res.ok) throw new Error(`Join group failed: ${res.status}`)
  const data = await res.json()
  dispatchBadgeUnlocks(data?.new_badges)
  return data
}

export async function leaveGroup(groupId, googleId) {
  const res = await fetchWithTimeout(
    `${BASE_URL}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(googleId)}?google_id=${encodeURIComponent(googleId)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) throw new Error(`Leave group failed: ${res.status}`)
  return res.json()
}

// Aggregate stats for a group's "Mural" panel. Member-only on the backend
// — non-members get a 403, in which case we return null so the caller can
// hide the section without a console scream.
export async function fetchGroupStats(groupId, googleId) {
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/groups/${encodeURIComponent(groupId)}/stats?google_id=${encodeURIComponent(googleId)}`,
    )
    if (res.ok) return await res.json()
  } catch {
    // Backend unavailable — silently no-op
  }
  return null
}

// Promote a member to admin or demote them. Admin-only on the backend.
// `role` must be 'admin' or 'member'. Throws on the last-admin guard so
// the caller can show an inline error.
export async function setGroupMemberRole(groupId, memberGoogleId, googleId, role) {
  const res = await fetchWithTimeout(
    `${BASE_URL}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberGoogleId)}/role`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ google_id: googleId, role }),
    },
  )
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).detail || '' } catch {}
    throw new Error(detail || `Set role failed: ${res.status}`)
  }
  return res.json()
}

export async function deleteGroup(groupId, googleId) {
  const res = await fetchWithTimeout(
    `${BASE_URL}/groups/${encodeURIComponent(groupId)}?google_id=${encodeURIComponent(googleId)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) throw new Error(`Delete group failed: ${res.status}`)
  return res.json()
}

export async function createGroupEvent(groupId, googleId, eventData) {
  const res = await fetchWithTimeout(
    `${BASE_URL}/groups/${encodeURIComponent(groupId)}/events`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ google_id: googleId, ...eventData }),
    },
  )
  if (!res.ok) throw new Error(`Create group event failed: ${res.status}`)
  return res.json()
}

export async function deleteGroupEvent(groupId, eventId, googleId) {
  const res = await fetchWithTimeout(
    `${BASE_URL}/groups/${encodeURIComponent(groupId)}/events/${encodeURIComponent(eventId)}?google_id=${encodeURIComponent(googleId)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) throw new Error(`Delete group event failed: ${res.status}`)
  return res.json()
}

// Personal plan = event with hand-picked invitees, no group attached.
// Backend stores it in group_events with group_id NULL + extra_invitee_ids.
// Returns the created event row (not the frontend-shaped catalog event —
// the next /events/group fetch will surface it shaped properly).
export async function createPersonalPlan(googleId, { name, description = '', venue = '', date_start, date_end = null, note = '', invitee_google_ids = [] }) {
  // 15s timeout (vs the 5s default) so cold-start + the brief synchronous
  // DB writes have headroom. Push fan-out is BackgroundTask on the backend
  // so the response itself is fast; this is just defense in depth.
  const res = await fetchWithTimeout(
    `${BASE_URL}/events/private`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        google_id: googleId,
        name, description, venue, date_start, date_end, note,
        invitee_google_ids,
      }),
    },
    15000,
  )
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json()).detail || '' } catch {}
    throw new Error(detail || `Create personal plan failed: ${res.status}`)
  }
  return res.json()
}

export async function deletePersonalPlan(eventId, googleId) {
  const res = await fetchWithTimeout(
    `${BASE_URL}/events/private/${encodeURIComponent(eventId)}?google_id=${encodeURIComponent(googleId)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) throw new Error(`Delete personal plan failed: ${res.status}`)
  return res.json()
}

// Aggregated upcoming events from every group the user belongs to,
// shaped like catalog events. Server-gated by membership — users only
// ever see events from their own groups. Returns [] for signed-out users
// or backend failures (events should never block on optional layers).
export async function fetchUserGroupEvents(googleId) {
  if (!googleId) return []
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/events/group?google_id=${encodeURIComponent(googleId)}`,
    )
    if (!res.ok) return []
    const { events } = await res.json()
    return events || []
  } catch {
    return []
  }
}

export function getGroupCalendarFeedUrl(feedToken) {
  const base = BASE_URL || window.location.origin
  return `${base}/groups/feed/${feedToken}.ics`
}


export async function askCompanion({ message, situation, goal, week, language, history = [], eventsContext = [] }) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), 15_000) // 15s timeout for LLM

  // Send compact event data — only fields the LLM needs for matching + display
  const compactEvents = eventsContext.map(ev => ({
    id: ev.id, name: ev.name, category: ev.category,
    categoryLabel: ev.categoryLabel, categoryEmoji: ev.categoryEmoji,
    venue: ev.venue, date: ev.date, time: ev.time,
    price: ev.price, isLowPressure: ev.isLowPressure,
    vibeSummary: ev.vibeSummary, headerBg: ev.headerBg,
    icon: ev.icon, url: ev.url,
  }))

  try {
    const res = await fetch(`${BASE_URL}/companion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        message, situation, goal, week, language, history,
        events_context: compactEvents,
      }),
    })
    clearTimeout(id)
    if (!res.ok) throw new Error(`Companion error: ${res.status}`)
    return await res.json()
  } catch (err) {
    clearTimeout(id)
    throw err
  }
}
