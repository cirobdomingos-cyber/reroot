/**
 * Camada de acesso a dados do Reroot.
 *
 * Offline-first: usa dados embutidos como fonte primária.
 * Se um backend estiver disponível, tenta buscar dados ao vivo
 * e mescla com os dados locais.
 */
import { EVENTS } from '../data/events'

// In production (single-service deploy), API is same-origin → empty string.
// In local dev, frontend runs on :5173 and backend on :8000.
const BASE_URL = import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? 'http://localhost:8000' : '')
const TIMEOUT_MS = 5000

// ── Client error reporter ─────────────────────────────────
// Fire-and-forget. Never throws. Used to surface silent failures in production.
function getSessionId() {
  const KEY = 'reroot_session_id'
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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(id)
    return res
  } catch (err) {
    clearTimeout(id)
    throw err
  }
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
    cohortGoing: ev.cohortGoing || [],
    price: ev.price,
    priceTier: ev.priceTier,
    kidsWelcome: ev.kidsWelcome ?? false,
    hasFood: ev.hasFood,
    isLowPressure: ev.isLowPressure,
    attendeesConfirmed: ev.attendeesConfirmed,
    expectedSize: ev.expectedSize,
    vibeSummary: ev.vibeSummary,
    rerootReason: ev.rerootReason,
    url: ev.url,
    source: ev.source || 'live',
    isReal: true,
    dateStart: ev.dateStart,
    dateTag: computeDateTag(ev.dateStart),
    // Detail-only fields — present when fetched via /events/{id}
    venueAddress: ev.venueAddress,
    city: ev.city,
    imageUrl: ev.imageUrl,
  }
}

// Categories backed by Google Places instead of the events DB
const PLACES_CATEGORIES = new Set(['bars_cafes', 'parks', 'cinema', 'bookstore'])

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

export async function fetchEvents(category = 'all') {
  // For venue-type categories, try Google Places first
  if (category && PLACES_CATEGORIES.has(category)) {
    const result = await fetchPlaces(category)
    if (result) return result
  }

  // Always start with embedded data (works offline, in native app, etc.)
  const filtered = category && category !== 'all'
    ? EVENTS.filter(e => e.category === category)
    : EVENTS

  // Try backend as a bonus — don't block on it
  try {
    const url = category && category !== 'all'
      ? `${BASE_URL}/events?category=${category}&limit=20`
      : `${BASE_URL}/events?limit=20`

    const res = await fetchWithTimeout(url)
    if (res.ok) {
      const data = await res.json()
      const liveEvents = (data.events || []).map(normalizeBackendEvent)
      if (liveEvents.length > 0) {
        return { events: liveEvents, source: 'live', city: data.city || 'Curitiba' }
      }
    }
  } catch {
    // Backend unavailable — that's fine, use embedded data
  }

  return { events: filtered, source: 'local', city: 'Curitiba' }
}

export async function fetchEventDetail(eventId) {
  // Try backend first for richer data
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/events/${eventId}`)
    if (res.ok) {
      const data = await res.json()
      return { event: normalizeBackendEvent(data), source: 'live' }
    }
  } catch {
    // Fall through to embedded data
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
            event_date: event.date,
            event_url: event.url ?? null,
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
    }
  } catch (err) {
    reportError('rsvp_sync_failed', err.message, {
      eventId: event.id, action: isRsvped ? 'add' : 'remove',
    }, googleId)
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
    if (res.ok) return await res.json()
  } catch {
    // Backend unavailable
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

/**
 * AI Companion — send a message and get back a response with optional event suggestions.
 * Sends the full event catalog so the LLM always has events to recommend
 * (works even when the scraper DB is empty — offline-first pattern).
 */
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
