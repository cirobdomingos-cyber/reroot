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
const TIMEOUT_MS = 2000

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
    hasFood: ev.hasFood,
    isLowPressure: ev.isLowPressure,
    attendeesConfirmed: ev.attendeesConfirmed,
    expectedSize: ev.expectedSize,
    vibeSummary: ev.vibeSummary,
    rerootReason: ev.rerootReason,
    url: ev.url,
    source: ev.source || 'live',
    isReal: true,
    dateTag: computeDateTag(ev.dateStart),
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

export async function triggerRefresh() {
  const res = await fetch(`${BASE_URL}/events/refresh`, { method: 'POST' })
  if (!res.ok) throw new Error('Refresh falhou')
  return res.json()
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
