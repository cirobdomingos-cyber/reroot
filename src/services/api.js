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
  }
}

export async function fetchEvents(category = 'all') {
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
