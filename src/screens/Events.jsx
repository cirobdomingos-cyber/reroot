import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import { CATEGORY_META, CATEGORY_ORDER, INST_CATEGORY } from '../data/categories'
import { fetchEvents, fetchEventDetail, trackEvent, syncRsvp, fetchFriendsFeed, fetchUserGroupEvents, fetchSources, deletePersonalPlan } from '../services/api'
import { scheduleEventReminder, cancelEventReminder, schedulePostEventNotification } from '../lib/notifications'
import AddToCalendar from '../components/AddToCalendar'
import PostEventAttendees from '../components/PostEventAttendees'
import EventsWeekStrip from '../components/EventsWeekStrip'
import Avatar from '../components/Avatar'
import AddToGroupSheet from '../components/AddToGroupSheet'
import PersonalPlanSheet from '../components/PersonalPlanSheet'
import AttendeesRow from '../components/AttendeesRow'
import EventsMap from '../components/EventsMap'
import { shareLink, appLink } from '../lib/share'

const VENUE_CATEGORIES = new Set(['bars_cafes', 'parks', 'cinema', 'bookstore'])

// Source provenance config — drives the badge label/style for every event origin.
// Add new entries here when new scrapers go live.
const SOURCE_CONFIG = {
  aue_original:     { label: 'Original auê',     icon: '⭐', bg: 'linear-gradient(135deg, #FFF8E1, #FFECB3)', border: '#FFD54F', color: '#8D6E10' },
  aue_ai:           { label: 'auê IA',           icon: '✦', bg: 'linear-gradient(135deg, #EDE7F6, #D1C4E9)', border: '#CE93D8', color: '#6A1B9A' },
  instagram:        { label: 'Instagram',          icon: '📷', bg: 'linear-gradient(135deg, #FCE4EC, #F8BBD0)', border: '#F48FB1', color: '#AD1457' },
}

const VENUE_SUBTYPES = [
  { id: 'all',  label: 'Todos' },
  { id: 'cafe', label: '☕ Cafés' },
  { id: 'bar',  label: '🍺 Bares' },
]

function getSubtype(ev) {
  if (ev.placeSubtype) return ev.placeSubtype
  return ev.icon === '☕' ? 'cafe' : 'bar'
}

// Some scraped descriptions arrive as escaped HTML (e.g. Sympla returns
// `&lt;p&gt;...&lt;/p&gt;`). Decode entities up to twice (for double-escaping),
// strip tags, collapse whitespace. Pure text out — safe to render directly.
function cleanDescription(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const decode = s => s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  let text = decode(raw)
  if (/&(lt|gt|amp|quot|#\d+);/.test(text)) text = decode(text)
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim()
  return text
}

// ── Personalization chips ────────────────────────────────────────────────────
// Returns at most one personal-context chip for an event, computed purely
// from the user's existing RSVPs (already in memory — zero extra LLM/API cost).
// Conflict beats same-venue: a date clash is more actionable than a venue echo.
function getPersonalChip(ev, rsvps) {
  if (!ev.dateStart) return null
  const myDay = ev.dateStart.slice(0, 10)
  const myVenue = (ev.venue?.split(' · ')[0] || '').trim().toLowerCase()
  let conflictName = null
  let sameVenueName = null
  for (const [otherId, info] of Object.entries(rsvps)) {
    if (!info || otherId === ev.id) continue
    if (!conflictName && info.dateStart?.slice(0, 10) === myDay) {
      conflictName = info.name
    }
    if (!sameVenueName && myVenue) {
      const otherVenue = (info.venue?.split(' · ')[0] || '').trim().toLowerCase()
      if (otherVenue && otherVenue === myVenue) sameVenueName = info.name
    }
    if (conflictName && sameVenueName) break
  }
  if (conflictName) return { kind: 'conflict', other: conflictName }
  if (sameVenueName) return { kind: 'same_venue', other: sameVenueName }
  return null
}

// ── Skeleton loaders ──────────────────────────────────────────────────────────

// True when `dayIso` (YYYY-MM-DD) falls within an event's coverage:
//   - One-off: strict equality on dateStart's day.
//   - Range:   dateStart ≤ dayIso ≤ dateEnd (inclusive both ends).
//   - Recurring: dayIso's weekday matches one of recurrenceDays
//     (ISO 1=Mon..7=Sun) AND dayIso isn't before the next occurrence.
//
// Used by both the per-day pick filter and the week-strip count so a
// "Quinta, sexta e sábado" residency shows up on each Thu/Fri/Sat in
// view, not just the next single occurrence the backend computed.
function eventCoversDay(ev, dayIso) {
  if (!dayIso) return false
  // Recurring branch — week-strip should highlight every covered weekday
  // from today onward, not just the rolled-forward "next occurrence".
  if (ev.isRecurring && Array.isArray(ev.recurrenceDays) && ev.recurrenceDays.length) {
    const d = new Date(`${dayIso}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) return false
    // JS getUTCDay: 0=Sun..6=Sat. Convert to ISO 1=Mon..7=Sun.
    const isoDow = ((d.getUTCDay() + 6) % 7) + 1
    if (!ev.recurrenceDays.includes(isoDow)) return false
    // Hide past days even for recurring — we don't want Saturday to
    // light up before the user's "today" gets there.
    const todayIso = new Date().toISOString().slice(0, 10)
    return dayIso >= todayIso
  }
  const start = (ev.dateStart || '').slice(0, 10)
  if (!start) return false
  const end = (ev.dateEnd || '').slice(0, 10) || start
  return dayIso >= start && dayIso <= end
}

// True when the event's [dateStart..dateEnd] interval overlaps with the
// time window [startTs, endTs). Used by the date-range pills (Hoje, Fim
// de semana, Próx 7d) so a multi-day festival surfaces in every range
// it touches, not just the one its dateStart falls into. Recurring
// events bypass — they're evergreen and rolled forward upstream.
function eventOverlapsRange(ev, startTs, endTs) {
  if (ev.isRecurring) return true
  if (!ev.dateStart) return false
  const evStart = Date.parse(ev.dateStart)
  if (Number.isNaN(evStart)) return false
  const evEnd = ev.dateEnd ? Date.parse(ev.dateEnd) : evStart
  const evEndSafe = Number.isNaN(evEnd) || evEnd < evStart ? evStart : evEnd
  return evStart < endTs && evEndSafe >= startTs
}

function EventCardSkeleton() {
  return (
    <div style={{
      background: 'white', borderRadius: 16, margin: '0 16px 9px',
      padding: '12px 13px', border: '1px solid var(--border)',
      display: 'flex', gap: 12,
    }}>
      <div style={{ width: 48, height: 48, borderRadius: 13, background: '#f0ede8', flexShrink: 0, animation: 'shimmer 1.4s infinite', backgroundSize: '200% 100%' }}/>
      <div style={{ flex: 1 }}>
        <div style={{ height: 14, width: '75%', background: '#f0ede8', borderRadius: 6, marginBottom: 8 }}/>
        <div style={{ height: 11, width: '50%', background: '#f0ede8', borderRadius: 6, marginBottom: 8 }}/>
        <div style={{ height: 11, width: '35%', background: '#f0ede8', borderRadius: 6, marginBottom: 10 }}/>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={{ height: 20, width: 80, background: '#f0ede8', borderRadius: 6 }}/>
          <div style={{ height: 30, width: 80, background: '#f0ede8', borderRadius: 10 }}/>
        </div>
      </div>
    </div>
  )
}

function VenueSkeletonRow() {
  return (
    <div style={{
      background: 'white', borderRadius: 16, margin: '0 16px 8px',
      padding: '13px 14px', border: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, background: '#f0ede8', flexShrink: 0, animation: 'shimmer 1.4s infinite', backgroundSize: '200% 100%' }}/>
      <div style={{ flex: 1 }}>
        <div style={{ height: 14, width: '60%', background: '#f0ede8', borderRadius: 6, marginBottom: 7 }}/>
        <div style={{ height: 11, width: '40%', background: '#f0ede8', borderRadius: 6 }}/>
      </div>
      <div style={{ height: 32, width: 64, background: '#f0ede8', borderRadius: 10 }}/>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function Events() {
  const { state, dispatch } = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const t = useT()

  const [activeFilter, setActiveFilter]     = useState('all')
  // List vs. Map view. Filters/search apply to both — only the
  // presentation changes. Map view drops events without lat/lng (they
  // exist in the catalog but haven't been geocoded yet) and shows a
  // banner when the active filter yields zero pinnable events.
  const [viewMode, setViewMode]             = useState('list')
  // Chip strip collapse — default to ~2 rows worth of chips so the strip
  // doesn't eat the whole top of the screen on phones with 18+ tracked
  // categories. User can expand to see everything.
  const [chipsExpanded, setChipsExpanded]   = useState(false)
  // Specific-day filter from the week strip (events mode). null = all days.
  const [selectedDay, setSelectedDay]       = useState(null)
  const [venueSubFilter, setVenueSubFilter] = useState('all')
  const [events, setEvents]                 = useState([])
  const [loading, setLoading]               = useState(true)
  const [dataSource, setDataSource]         = useState('static')
  const [selectedEventId, setSelectedEventId] = useState(null)
  const [detailEvent, setDetailEvent]       = useState(null)
  const [detailLoading, setDetailLoading]   = useState(false)
  const [searchQuery, setSearchQuery]       = useState('')
  const [searchOpen, setSearchOpen]         = useState(false)
  const [notifToast, setNotifToast]         = useState(null)
  const [priceFilter, setPriceFilter]       = useState('all')
  const [kidsFilter, setKidsFilter]         = useState(false)
  // Personal-plan creation sheet — invite friends to a hand-picked event.
  const [showPlanSheet, setShowPlanSheet]   = useState(false)
  // Recurring routines (e.g. "every Thursday MPB") show alongside one-off
  // events with distinct styling. 'all' (default) shows both, 'events' hides
  // routines, 'routines' hides one-offs. The chip toggles cycle through.
  // Date-range filter shared by Lista + Mapa. Replaces the per-day week
  // strip in Mapa mode (where day-by-day pinning rarely matches user
  // intent — "what's this weekend" beats "what's specifically Saturday").
  // List mode shows BOTH (range pills above, week strip below) so the
  // user can either zoom by range or pick a specific day.
  const [dateRange, setDateRange] = useState('all')  // 'today' | 'weekend' | 'week' | 'all'
  // Map of IG handle → tracked category. Built from /sources on mount so
  // the chip filter on top of the catalog can use the same taxonomy as
  // the Sources page (bar, cafe, restaurante, musica, …).
  const [handleCategoryMap, setHandleCategoryMap] = useState({})
  // Friends' RSVPs — feeds the friend-dot in the week strip. Only fetched
  // when the user is signed in.
  const [friendsFeed, setFriendsFeed]       = useState([])
  // Upcoming events from groups the signed-in user belongs to. Server-gated
  // by membership, so this is empty for signed-out users by construction.
  const [groupEvents, setGroupEvents]       = useState([])
  // Settled once the groupEvents fetch has resolved (or skipped because the
  // user is signed out). Used to gate deep-link openDetail so a recipient
  // tapping a share link doesn't race the membership-events load and end
  // up hitting only the public /events/{id} fallback.
  const [groupEventsReady, setGroupEventsReady] = useState(false)
  // Add-to-group sheet target. null = sheet closed.
  const [addToGroupEvent, setAddToGroupEvent] = useState(null)

  useEffect(() => {
    const googleId = state.googleUser?.id
    if (!googleId) { setFriendsFeed([]); setGroupEvents([]); setGroupEventsReady(true); return }
    let cancelled = false
    setGroupEventsReady(false)
    fetchFriendsFeed(googleId).then(events => {
      if (!cancelled) setFriendsFeed(events || [])
    })
    fetchUserGroupEvents(googleId).then(events => {
      if (cancelled) return
      setGroupEvents(events || [])
      setGroupEventsReady(true)
    })
    return () => { cancelled = true }
  }, [state.googleUser?.id])

  // Build the IG handle → category map once so the filter chips below
  // can use the same source taxonomy the Sources page uses.
  useEffect(() => {
    let cancelled = false
    fetchSources().then(d => {
      if (cancelled) return
      const map = {}
      for (const ig of (d?.instagram || [])) {
        if (ig.handle && ig.category) map[ig.handle.toLowerCase()] = ig.category.toLowerCase()
      }
      setHandleCategoryMap(map)
    })
    return () => { cancelled = true }
  }, [])

  // Returns the source-taxonomy category for an event, or null. IG events
  // pull from the handle map; non-IG (aue_original, ai_generated,
  // submitted) check INST_CATEGORY (currently only aue_original=cultural).
  function categoryFor(ev) {
    if (ev.igHandle) return handleCategoryMap[ev.igHandle.toLowerCase()] || null
    return INST_CATEGORY[ev.source] || null
  }

  const isVenueMode = VENUE_CATEGORIES.has(activeFilter)

  const loadEvents = useCallback(async () => {
    // Single fetch on mount — backend mood-filter has been replaced by
    // client-side source-category filter (see filteredEvents below).
    setLoading(true)
    const { events: evs, source } = await fetchEvents('all')
    setEvents(evs)
    setDataSource(source)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  useEffect(() => {
    // Two ways to deep-link into a specific event:
    //   1. In-app navigation: navigate('/events', { state: { openEventId } })
    //   2. Shareable link: /#/events?event=<id> (from share buttons)
    // The URL form lets a recipient land here cold from a copied link;
    // backend's GET /events/{id} handles both catalog and group_events
    // (ids prefixed `grp_ev_`), so the same drawer renders either.
    const stateId = location.state?.openEventId
    const params = new URLSearchParams(location.search)
    const queryId = params.get('event')
    const openId = stateId || queryId
    // Wait for both the public catalog AND the user's group events to be
    // loaded — group event share links land here too, and matching against
    // local state is more reliable than the round-trip (esp. on flaky
    // mobile data, where the 5s fetch was timing out and rendering
    // 'evento não está mais no catálogo').
    if (openId && !loading && groupEventsReady) {
      openDetail(openId)
      if (queryId) {
        // Strip ?event= so the URL doesn't re-fire the effect on close
        // and so the back button doesn't reopen the same drawer.
        navigate('/events', { replace: true })
      } else if (stateId) {
        window.history.replaceState({}, '')
      }
    }
  }, [location.state?.openEventId, location.search, loading, groupEventsReady, navigate])

  async function openDetail(eventId) {
    setSelectedEventId(eventId)
    // Check custom events first — they don't exist in the backend
    const customMatch = (state.customEvents || []).find(e => e.id === eventId)
    if (customMatch) {
      setDetailEvent(customMatch)
      return
    }
    // Group events the user belongs to are already loaded locally — match
    // there before hitting the backend so a recipient who taps a friend's
    // share link renders the drawer instantly even on slow networks, and
    // doesn't get the false "evento não está mais no catálogo" message
    // when the fetch times out.
    const groupMatch = groupEvents.find(e => e.id === eventId)
    if (groupMatch) {
      setDetailEvent(groupMatch)
      return
    }
    // Catalog events that are already in the loaded list also don't need
    // a round-trip — same survivability win for shared catalog links.
    const catalogMatch = events.find(e => e.id === eventId)
    if (catalogMatch) {
      setDetailEvent(catalogMatch)
      return
    }
    setDetailLoading(true)
    const { event, forbidden, networkError, message } = await fetchEventDetail(eventId, state.googleUser?.id || '')
    if (forbidden) {
      // Backend returned 403 (private plan / private group event). Render
      // a friendly 'this is private' panel instead of the silent-empty
      // state that masquerades as "link is broken".
      setDetailEvent({ _forbidden: true, _message: message, id: eventId })
      setDetailLoading(false)
      return
    }
    if (networkError) {
      // Couldn't reach the backend (timeout, offline, etc.). Don't pretend
      // the event was deleted — surface a retry-friendly state instead.
      setDetailEvent({ _networkError: true, id: eventId })
      setDetailLoading(false)
      return
    }
    // Reconcile: if the backend doesn't know this event AND the user has
    // a stale RSVP for it (group event was deleted out from under them,
    // typically by the creator/admin), purge the local state.rsvps entry.
    // Otherwise the row haunts My RSVPs forever.
    if (!event && state.rsvps[eventId]) {
      const stale = state.rsvps[eventId]
      dispatch({
        type: 'TOGGLE_RSVP',
        payload: {
          eventId,
          dateStart: stale.dateStart,
          name: stale.name,
          venue: stale.venue,
        },
      })
    }
    setDetailEvent(event)
    setDetailLoading(false)
  }

  function closeDetail() {
    setSelectedEventId(null)
    setDetailEvent(null)
  }

  function handleCategoryChange(id) {
    setActiveFilter(id)
    setSearchQuery('')
    setSearchOpen(false)
  }

  // Merge user-created custom events into the list, then sort the whole
  // thing by date_start ASC so closest-future events appear at the top.
  // Items without a parseable date sink to the bottom (custom events
  // without a date, anytime venues without dateStart). Events the
  // backend already returns in this order, but customs need merging.
  // Full union of everything we'll ever display — used both as the source
  // of truth for chip counts (so "Tudo" doesn't fluctuate as the user
  // filters) and as the input list to filter for the actual rendering.
  const allDisplayEvents = [...(state.customEvents || []), ...groupEvents, ...events].sort((a, b) => {
    const ta = a.dateStart ? Date.parse(a.dateStart) : NaN
    const tb = b.dateStart ? Date.parse(b.dateStart) : NaN
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
    if (Number.isNaN(ta)) return 1
    if (Number.isNaN(tb)) return -1
    const dayA = a.dateStart.slice(0, 10)
    const dayB = b.dateStart.slice(0, 10)
    if (dayA === dayB) {
      // Same day: pin group events to the top so the user's own crew
      // shows above the public catalog. The day strip says "you have
      // plans on Saturday" — opening Saturday should surface those
      // plans first, not bury them under 30 public events.
      if (a.isGroupEvent && !b.isGroupEvent) return -1
      if (!a.isGroupEvent && b.isGroupEvent) return 1
    }
    return ta - tb
  })

  // Apply search + source-category + date/venue filter
  let filteredEvents = allDisplayEvents
  // Source-category filter — uses the same taxonomy as the Sources page
  // (bar / cafe / restaurante / musica / …). 'all' bypasses; 'group'
  // narrows to private events from the user's groups + personal plans;
  // any other chip narrows by the IG handle's tracked category (or
  // aue_original's INST_CATEGORY mapping). Events whose source we can't
  // classify just fall out of every specific bucket — matches Sources.
  if (activeFilter === 'group') {
    filteredEvents = filteredEvents.filter(ev => ev.isGroupEvent)
  } else if (activeFilter !== 'all') {
    filteredEvents = filteredEvents.filter(ev => !ev.isGroupEvent && categoryFor(ev) === activeFilter)
  }
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    filteredEvents = filteredEvents.filter(ev =>
      ev.name.toLowerCase().includes(q) ||
      ev.venue?.toLowerCase().includes(q)
    )
  }
  if (isVenueMode && venueSubFilter !== 'all') {
    filteredEvents = filteredEvents.filter(ev => getSubtype(ev) === venueSubFilter)
  }
  // Price filter — additive (AND logic)
  if (priceFilter === 'free') {
    filteredEvents = filteredEvents.filter(ev =>
      ev.priceTier === 'free' || ev.price === 'Gratuito' || ev.price === 'Free'
    )
  } else if (priceFilter === 'paid') {
    filteredEvents = filteredEvents.filter(ev =>
      ev.priceTier !== 'free' && ev.price !== 'Gratuito' && ev.price !== 'Free'
    )
  }
  // Kids Welcome filter — additive
  if (kidsFilter) {
    filteredEvents = filteredEvents.filter(ev => ev.kidsWelcome)
  }
  // Date-range filter: applies to both Lista and Mapa. "Hoje" is the
  // user's local day; "Fim de semana" is the next Saturday + Sunday;
  // "Próx 7 dias" is a rolling window. Recurring events bypass the
  // range filter — they're evergreen by definition and the next
  // occurrence is always rolled forward upstream.
  if (dateRange !== 'all') {
    const now = new Date()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    let rangeEnd  // Date — events strictly before this survive
    if (dateRange === 'today') {
      rangeEnd = new Date(startOfToday)
      rangeEnd.setDate(rangeEnd.getDate() + 1)
    } else if (dateRange === 'weekend') {
      // Sat 00:00 → Mon 00:00 of the upcoming weekend (or this one if
      // today is already Sat/Sun).
      const dow = startOfToday.getDay()  // 0=Sun … 6=Sat
      const daysUntilSat = (6 - dow + 7) % 7
      const sat = new Date(startOfToday)
      sat.setDate(sat.getDate() + daysUntilSat)
      const monAfter = new Date(sat)
      monAfter.setDate(monAfter.getDate() + 2)
      filteredEvents = filteredEvents.filter(ev =>
        eventOverlapsRange(ev, sat.getTime(), monAfter.getTime())
      )
      rangeEnd = null  // already filtered above
    } else if (dateRange === 'week') {
      rangeEnd = new Date(startOfToday)
      rangeEnd.setDate(rangeEnd.getDate() + 7)
    }
    if (rangeEnd) {
      const endTs = rangeEnd.getTime()
      const startTs = startOfToday.getTime()
      filteredEvents = filteredEvents.filter(ev =>
        eventOverlapsRange(ev, startTs, endTs)
      )
    }
  }

  // A bairro filter was prototyped here but reverted — venue→bairro from
  // the scrapers is too noisy to be trustworthy ("Curitiba" appearing as
  // a bairro, same venue mapped inconsistently across enrichment runs).
  // Re-enable after a canonical venue→bairro lookup + re-enrichment.
  // AI-curated/made-up events never surface in the Events tab — they're
  // reserved for a separate discovery surface (chatbot or dedicated tab,
  // TBD). The Events tab is the catalog of real, scraped Curitiba events.
  filteredEvents = filteredEvents.filter(ev => !ev.isCurated)
  // Snapshot for the week strip's count badges — reflects every active
  // filter *except* the per-day pick, so picking a day doesn't zero out
  // the other days' counts.
  const eventsForStrip = filteredEvents
  if (!isVenueMode && selectedDay) {
    // Range events ("terça a domingo", multi-day exhibitions) cover every
    // day between dateStart and dateEnd inclusive — they should show up
    // when ANY of those days is selected, not just the start day. One-offs
    // (no dateEnd) keep the simple equality check.
    filteredEvents = filteredEvents.filter(ev => eventCoversDay(ev, selectedDay))
  }

  // Day-keyed sets for the strip's social signals. RSVP set comes from
  // local state.rsvps (which stores dateStart per RSVP). Friend set comes
  // from the live friends_feed (event_date is ISO).
  const rsvpDays = new Set(
    Object.values(state.rsvps)
      .map(info => info?.dateStart?.slice(0, 10))
      .filter(Boolean)
  )
  const friendDays = new Set(
    friendsFeed
      .map(ev => ev.event_date?.slice(0, 10))
      .filter(Boolean)
  )
  // Per-event friend lookup, used by the cards/detail drawer to show
  // "Maria + 2 amigos vão" with avatars on each event row.
  const friendsByEventId = {}
  for (const ev of friendsFeed) {
    if (ev.event_id) friendsByEventId[ev.event_id] = ev.friends_going || []
  }

  async function handleRsvpToggle(ev) {
    // Venues (cafés, bares, parques, livrarias, cinemas) don't have a date —
    // "saving" them is favoriting, not RSVPing. Route to the favorites state.
    if (VENUE_CATEGORIES.has(ev.category)) {
      dispatch({
        type: 'TOGGLE_FAVORITE',
        payload: {
          placeId: ev.id, name: ev.name, venue: ev.venue,
          icon: ev.icon, headerBg: ev.headerBg,
        },
      })
      return
    }
    const wasRsvped = !!state.rsvps[ev.id]
    dispatch({
      type: 'TOGGLE_RSVP',
      payload: { eventId: ev.id, dateStart: ev.dateStart, name: ev.name, venue: ev.venue },
    })

    // Sync to backend social layer — only when user is logged in and sharing is enabled
    if (state.googleUser?.id && (state.privacy?.shareRsvps ?? state.shareRsvps)) {
      syncRsvp(state.googleUser.id, ev, !wasRsvped)
    }

    // Fire first_rsvp only on the very first RSVP the user makes
    if (!wasRsvped) {
      const existingRsvps = Object.values(state.rsvps).filter(Boolean).length
      if (existingRsvps === 0) {
        trackEvent('first_rsvp', { event_id: ev.id, event_name: ev.name, category: ev.category })
      }
    }
    if (!wasRsvped && !isVenueMode) {
      const ok = await scheduleEventReminder(ev)
      if (ok) {
        setNotifToast(ev.name)
        setTimeout(() => setNotifToast(null), 3000)
      }
      // Schedule post-event reconnect nudge (native only, fires 3h after event start)
      schedulePostEventNotification(ev)
    } else if (wasRsvped) {
      cancelEventReminder(ev.id)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <style>{`
        @keyframes shimmer {
          0%   { background-position: -200% 0; }
          100% { background-position:  200% 0; }
        }
      `}</style>

      {/* ── Sticky zone: title + search + category chips ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'var(--cream)',
        borderBottom: '1px solid var(--border)',
        paddingBottom: 0,
      }}>
        {/* Title row */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px 10px',
        }}>
          <div>
            <div className="screen-header__title">{t.events_title}</div>
            <div className="screen-header__sub">{t.events_sub}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Sources entry — was a 36px icon-only button that read as
                a settings cog. Promoted to a labeled pill so it reads as
                "browse where this catalog comes from" — the canonical
                venue/curator browser, especially after we dropped the
                Bares & Cafés / Parques / Cinema / Livrarias chips. */}
            <button
              onClick={() => navigate('/sources')}
              title="Fontes monitoradas"
              style={{
                height: 36, padding: '0 12px',
                borderRadius: 999,
                background: 'white', border: '1.5px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12, fontWeight: 700, cursor: 'pointer',
                color: 'var(--charcoal)',
              }}
            >
              <span style={{ fontSize: 14 }}>📡</span>
              <span>Fontes</span>
            </button>
            <button
              onClick={() => setSearchOpen(o => !o)}
              style={{
                width: 36, height: 36, borderRadius: 12,
                background: searchOpen ? 'var(--charcoal)' : 'white',
                border: searchOpen ? 'none' : '1.5px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 15, cursor: 'pointer', transition: 'all 0.15s',
                color: searchOpen ? 'white' : 'var(--charcoal-mid)',
              }}
            >🔍</button>
          </div>
        </div>

        {/* Collapsible search */}
        <AnimatePresence>
          {searchOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{ padding: '0 16px 8px' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: 'white', borderRadius: 12,
                  border: '1.5px solid var(--border)',
                  padding: '8px 12px', boxShadow: 'var(--shadow-sm)',
                }}>
                  <span style={{ fontSize: 13, color: 'var(--charcoal-light)' }}>🔍</span>
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder={t.events_search}
                    style={{
                      flex: 1, border: 'none', outline: 'none',
                      fontSize: 13, color: 'var(--charcoal)', background: 'transparent',
                    }}
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--charcoal-light)', padding: 0 }}
                    >✕</button>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Category chips — counts are computed from the FULL union
            (catalog + custom + group), independent of the active
            filter, so 'Tudo · N' doesn't shrink the moment the user
            picks a category and stops showing custom/group events.
            'Grupo' is a synthetic bucket for private/group/personal
            plans; the IG-handle categories drop those automatically. */}
        {(() => {
          const eventCounts = {}
          let groupCount = 0
          for (const ev of allDisplayEvents) {
            if (ev.isGroupEvent) { groupCount += 1; continue }
            const c = categoryFor(ev)
            if (c) eventCounts[c] = (eventCounts[c] || 0) + 1
          }
          // Sort categories by event count DESC — the busiest buckets
          // float to the top so the visible-by-default rows always show
          // the chips users actually want. Ties broken by CATEGORY_ORDER
          // so the strip is stable scrape-to-scrape when counts match.
          const orderedCats = Object.keys(eventCounts).sort((a, b) => {
            const diff = eventCounts[b] - eventCounts[a]
            if (diff !== 0) return diff
            const ai = CATEGORY_ORDER.indexOf(a)
            const bi = CATEGORY_ORDER.indexOf(b)
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
          })
          const chips = [
            { id: 'all', emoji: '🌍', label: 'Tudo', count: allDisplayEvents.length },
            ...(groupCount > 0 ? [{ id: 'group', emoji: '🎲', label: 'Grupo', count: groupCount }] : []),
            ...orderedCats.map(c => ({
              id: c,
              emoji: CATEGORY_META[c]?.emoji || '🔗',
              label: CATEGORY_META[c]?.label || c,
              count: eventCounts[c] || 0,
            })),
          ]
          // Default-collapsed cap: shows roughly 2 rows on a 360-380px
          // viewport (the typical small Android). Always include the
          // active chip in the visible set even when it would otherwise
          // be in the overflow tail — otherwise picking "Cinema · 1"
          // and then collapsing would hide what the user just selected.
          const COLLAPSED_CAP = 10
          let visible = chips
          let hidden = 0
          if (!chipsExpanded && chips.length > COLLAPSED_CAP) {
            const head = chips.slice(0, COLLAPSED_CAP)
            const activeChip = chips.find(c => c.id === activeFilter)
            const includesActive = head.some(c => c.id === activeFilter)
            visible = includesActive || !activeChip
              ? head
              : [...head.slice(0, COLLAPSED_CAP - 1), activeChip]
            hidden = chips.length - visible.length
          }
          return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 16px 10px' }}>
              {visible.map(chip => {
                const active = activeFilter === chip.id
                return (
                  <button
                    key={chip.id}
                    onClick={() => handleCategoryChange(chip.id)}
                    style={{
                      padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
                      fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      transition: 'all 0.15s',
                      border: active ? 'none' : '1px solid var(--border)',
                      background: active ? 'var(--charcoal)' : 'transparent',
                      color: active ? 'white' : 'var(--charcoal-light)',
                    }}
                  >
                    {chip.emoji} {chip.label}{chip.count > 0 ? ` · ${chip.count}` : ''}
                  </button>
                )
              })}
              {(hidden > 0 || chipsExpanded) && chips.length > COLLAPSED_CAP && (
                <button
                  onClick={() => setChipsExpanded(v => !v)}
                  style={{
                    padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
                    fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    border: '1px dashed var(--border)',
                    background: 'transparent', color: 'var(--charcoal-mid)',
                  }}
                >
                  {chipsExpanded ? '− Ver menos' : `+ Ver mais (${hidden})`}
                </button>
              )}
            </div>
          )
        })()}

      </div>

      {/* ── Lista / Mapa toggle. Same filters drive both — only the
          presentation flips. We hide the week strip in Mapa mode
          because day-of-week filtering doesn't add much when you're
          looking at "what's nearby"; users can still narrow by
          category and search. */}
      {!isVenueMode && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0 16px 8px' }}>
          <div style={{
            display: 'inline-flex', background: 'var(--cream)',
            border: '1px solid var(--border)', borderRadius: 999,
            padding: 3,
          }}>
            {[
              { id: 'list', emoji: '📋', label: 'Lista' },
              { id: 'map',  emoji: '🗺️', label: 'Mapa' },
            ].map(opt => {
              const active = viewMode === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => setViewMode(opt.id)}
                  style={{
                    padding: '6px 14px', borderRadius: 999,
                    border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 600,
                    background: active ? 'var(--terra)' : 'transparent',
                    color: active ? 'white' : 'var(--charcoal-mid)',
                    transition: 'all 0.15s',
                  }}
                >
                  {opt.emoji} {opt.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Week strip with per-day event counts (events mode only) ── */}
      {!isVenueMode && viewMode === 'list' && (
        <EventsWeekStrip
          events={eventsForStrip}
          selectedDay={selectedDay}
          onSelectDay={setSelectedDay}
          rsvpDays={rsvpDays}
          friendDays={friendDays}
        />
      )}

      {/* ── Venue sub-filter (venue mode only — events use the week strip) ── */}
      {isVenueMode && (
        <div style={{ display: 'flex', gap: 6, padding: '10px 16px 8px', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {VENUE_SUBTYPES.map(sub => (
            <button
              key={sub.id}
              onClick={() => setVenueSubFilter(sub.id)}
              style={{
                padding: '5px 14px', borderRadius: 16, whiteSpace: 'nowrap',
                fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
                transition: 'all 0.15s',
                border: venueSubFilter === sub.id ? 'none' : '1px solid var(--border)',
                background: venueSubFilter === sub.id ? 'var(--terra)' : 'transparent',
                color: venueSubFilter === sub.id ? 'white' : 'var(--charcoal-light)',
              }}
            >
              {sub.label}
            </button>
          ))}
          {dataSource === 'places' && (
            <span style={{
              marginLeft: 'auto', flexShrink: 0, alignSelf: 'center',
              fontSize: 10, color: 'var(--charcoal-light)', paddingRight: 4,
            }}>
              {filteredEvents.length} locais
            </span>
          )}
        </div>
      )}

      {/* ── Price + Kids Welcome filter chips ── */}
      <div style={{ display: 'flex', gap: 6, padding: '0 16px 8px', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {/* "Todas as datas" pill removed — duplicated "Tudo" on the
            date-range row, and the week strip already toggles a picked
            day off when tapped a second time, so the path back to the
            full catalog stayed accessible. */}
        {[
          { id: 'all',  label: t.filter_all_prices },
          { id: 'free', label: `🆓 ${t.filter_free}` },
          { id: 'paid', label: `💰 ${t.filter_paid}` },
        ].map(pf => (
          <button
            key={pf.id}
            onClick={() => setPriceFilter(pf.id)}
            style={{
              padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
              fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
              transition: 'all 0.15s',
              border: priceFilter === pf.id ? 'none' : '1px solid var(--border)',
              background: priceFilter === pf.id ? 'var(--sage)' : 'transparent',
              color: priceFilter === pf.id ? 'white' : 'var(--charcoal-light)',
            }}
          >
            {pf.label}
          </button>
        ))}
        <button
          onClick={() => setKidsFilter(k => !k)}
          style={{
            padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
            fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
            transition: 'all 0.15s',
            border: kidsFilter ? 'none' : '1px solid var(--border)',
            background: kidsFilter ? 'var(--honey)' : 'transparent',
            color: kidsFilter ? 'white' : 'var(--charcoal-light)',
          }}
        >
          👶 {t.filter_kids_welcome}
        </button>
      </div>

      {/* ── Date-range pills — shared by Lista + Mapa. Mapa loses the
          per-day week strip below (it's noisy on a city-wide pin map),
          so this row is the primary date-narrowing surface there.
          List mode shows BOTH: range pills here, week strip below for
          per-day picking. */}
      {!isVenueMode && (
        <div style={{ display: 'flex', gap: 6, padding: '0 16px 10px', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {[
            { id: 'all',     label: 'Tudo' },
            { id: 'today',   label: '📅 Hoje' },
            { id: 'weekend', label: '🎉 Fim de semana' },
            { id: 'week',    label: '🗓 Próx 7 dias' },
          ].map(r => {
            const active = dateRange === r.id
            return (
              <button
                key={r.id}
                onClick={() => setDateRange(r.id)}
                style={{
                  padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
                  fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
                  transition: 'all 0.15s',
                  border: active ? 'none' : '1px solid var(--border)',
                  background: active ? 'var(--terra)' : 'transparent',
                  color: active ? 'white' : 'var(--charcoal-light)',
                }}
              >
                {r.label}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Inline CTA — "Criar um evento com amigos" (creates a personal
          plan with hand-picked invitees). Sole survivor of the previous
          two-CTA row; the AI suggestion pill was dropped to declutter. */}
      {!loading && !isVenueMode && state.googleUser?.id && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 16px 10px' }}>
          <button
            onClick={() => setShowPlanSheet(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 12px',
              background: '#FFFAF3',
              border: '1px solid #C8E6C9',
              borderRadius: 999, cursor: 'pointer',
              fontSize: 12, fontWeight: 600, color: 'var(--sage)',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 14 }}>🎲</span>
            <span>Criar um evento com amigos</span>
            <span style={{ opacity: 0.6 }}>→</span>
          </button>
        </div>
      )}

      {/* ── Loading skeletons ── */}
      {loading && (
        isVenueMode
          ? <>{[0,1,2,3,4].map(i => <VenueSkeletonRow key={i} />)}</>
          : <>{[0,1,2,3,4].map(i => <EventCardSkeleton key={i} />)}</>
      )}

      {/* ── Map view ── */}
      {!loading && !isVenueMode && viewMode === 'map' && (
        <EventsMap events={filteredEvents} onPinTap={(ev) => openDetail(ev.id)} />
      )}

      {/* ── List ── */}
      {!loading && viewMode === 'list' && (
        <AnimatePresence mode="popLayout">
          {filteredEvents.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ textAlign: 'center', padding: '52px 28px' }}
            >
              <div style={{ fontSize: 40, marginBottom: 12 }}>
                {searchQuery ? '🔍' : isVenueMode ? '🗺️' : '📅'}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 6 }}>
                {searchQuery ? 'Nenhum resultado' : 'Nada por aqui'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.6 }}>
                {searchQuery
                  ? `Sem resultados para "${searchQuery}"`
                  : 'Tente outra categoria ou período'}
              </div>
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); setSearchOpen(false) }}
                  style={{
                    marginTop: 18, padding: '8px 20px', borderRadius: 12,
                    background: 'var(--terra)', color: 'white',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none',
                  }}
                >
                  Limpar busca
                </button>
              )}
            </motion.div>
          ) : (
            filteredEvents.map(ev => {
              const rsvped = !!state.rsvps[ev.id]
              const isVenue = VENUE_CATEGORIES.has(ev.category)

              if (isVenue) {
                return (
                  <motion.div
                    key={ev.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.15 }}
                  >
                    <VenueRow
                      ev={ev}
                      favorited={!!state.favorites?.[ev.id]}
                      onFavorite={() => dispatch({
                        type: 'TOGGLE_FAVORITE',
                        payload: {
                          placeId: ev.id, name: ev.name, venue: ev.venue,
                          icon: ev.icon, headerBg: ev.headerBg,
                        },
                      })}
                      onOpen={() => {
                        // Tracked-IG venues: open the source page (shows
                        // recent events from this handle's posts). Falls
                        // back to the generic detail panel if igHandle
                        // isn't present (defensive — shouldn't happen
                        // since /places now always returns IG-backed venues).
                        if (ev.igHandle) {
                          navigate(`/sources/${encodeURIComponent('ig:' + ev.igHandle)}`)
                        } else {
                          openDetail(ev.id)
                        }
                      }}
                      t={t}
                    />
                  </motion.div>
                )
              }

              return (
                <motion.div
                  key={ev.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.15 }}
                >
                  <EventCard
                    ev={ev}
                    rsvped={rsvped}
                    friendsGoing={friendsByEventId[ev.id] || []}
                    personalChip={getPersonalChip(ev, state.rsvps)}
                    onOpen={() => openDetail(ev.id)}
                    onFriend={(gid) => navigate(`/friends/${encodeURIComponent(gid)}`)}
                    onSourceTap={(sid) => navigate(`/sources/${encodeURIComponent(sid)}`)}
                    onOpenGroup={(gid) => navigate(`/groups/${encodeURIComponent(gid)}`)}
                    t={t}
                  />
                </motion.div>
              )
            })
          )}
        </AnimatePresence>
      )}


      {/* ── Notification toast ── */}
      <AnimatePresence>
        {notifToast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.2 }}
            style={{
              position: 'absolute', bottom: 16, left: 16, right: 16, zIndex: 100,
              background: 'var(--charcoal)', color: 'white',
              borderRadius: 14, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            }}
          >
            <span style={{ fontSize: 18 }}>🔔</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>✓ Confirmado</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 1 }}>{notifToast}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Detail drawer ──
          Fixed-positioned so it pins to the phone-shell (which has
          `transform: translateZ(0)` to act as a containing block). If we
          used `absolute`, the drawer would scale to the parent scroll
          content height — making it thousands of pixels tall on a long
          catalog and leaving big blank areas after the content. */}
      <AnimatePresence>
        {selectedEventId && (
          <motion.div
            key="drawer"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            style={{
              position: 'fixed', inset: 0,
              background: 'var(--cream)',
              // Above Leaflet's panes (popup pane is z-index 700 by
              // default) AND any framer-motion page transform that
              // re-localizes z-index. 9999 is the conventional max-
              // window mark and stays under modals (10000+) elsewhere.
              zIndex: 9999,
              overflowY: 'auto', scrollbarWidth: 'none',
            }}
          >
            {/* Drag handle */}
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(44,44,44,0.18)' }}/>
            </div>

            {detailLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80%' }}>
                <div style={{ fontSize: 14, color: 'var(--charcoal-mid)' }}>{t.events_loading}</div>
              </div>
            ) : detailEvent?._forbidden ? (
              // Backend returned 403 — show 'this is private' instead of
              // the empty/silent state that masquerades as 'link broken'.
              // Triggered for personal plans where the user isn't on the
              // invitee list, or members-only group events the user
              // isn't a member of.
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '70%', padding: 32 }}>
                <div style={{ fontSize: 44, marginBottom: 12 }}>🔒</div>
                <div style={{
                  fontSize: 15, fontWeight: 700, color: 'var(--charcoal)',
                  textAlign: 'center', marginBottom: 8,
                }}>
                  Evento privado
                </div>
                <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', textAlign: 'center', marginBottom: 18, lineHeight: 1.5, maxWidth: 280 }}>
                  {detailEvent._message || 'Só convidados podem ver os detalhes desse evento.'}
                </div>
                <button
                  onClick={closeDetail}
                  style={{
                    padding: '10px 22px', borderRadius: 12, border: 'none',
                    background: 'var(--sage)', color: 'white',
                    fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Voltar
                </button>
              </div>
            ) : detailEvent?._networkError ? (
              // Couldn't reach the backend (timeout, offline, flaky link).
              // Don't claim the event was deleted — let the user retry.
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '70%', padding: 32 }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>📡</div>
                <div style={{
                  fontSize: 15, fontWeight: 700, color: 'var(--charcoal)',
                  textAlign: 'center', marginBottom: 8,
                }}>
                  Sem conexão com o servidor
                </div>
                <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', textAlign: 'center', marginBottom: 18, lineHeight: 1.5, maxWidth: 280 }}>
                  Não consegui carregar esse evento agora. Bora tentar de novo?
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    onClick={() => openDetail(detailEvent.id)}
                    style={{
                      padding: '10px 22px', borderRadius: 12, border: 'none',
                      background: 'var(--terra)', color: 'white',
                      fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    Tentar de novo
                  </button>
                  <button
                    onClick={closeDetail}
                    style={{
                      padding: '10px 22px', borderRadius: 12, border: '1px solid var(--border)',
                      background: 'white', color: 'var(--charcoal)',
                      fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    Voltar
                  </button>
                </div>
              </div>
            ) : !detailEvent ? (
              // Backend returned 404 — show a friendly fallback rather than
              // looping on the spinner. Common when an old RSVP points at
              // an event that's no longer in the catalog (deleted, etc.).
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '70%', padding: 32 }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>🤔</div>
                <div style={{ fontSize: 14, color: 'var(--charcoal-mid)', textAlign: 'center', marginBottom: 18, lineHeight: 1.5 }}>
                  Esse evento não está mais no catálogo.<br/>
                  Pode ter sido removido ou substituído.
                </div>
                <button
                  onClick={closeDetail}
                  style={{
                    padding: '10px 22px', borderRadius: 12, border: 'none',
                    background: 'var(--sage)', color: 'white',
                    fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Voltar
                </button>
              </div>
            ) : (
              <DetailPanel
                event={detailEvent}
                googleId={state.googleUser?.id || ''}
                viewerName={state.googleUser?.given_name || state.googleUser?.name || 'Você'}
                viewerPicture={state.googleUser?.picture}
                rsvped={
                  VENUE_CATEGORIES.has(detailEvent.category)
                    ? !!state.favorites?.[detailEvent.id]
                    : !!state.rsvps[detailEvent.id]
                }
                friendsGoing={friendsByEventId[detailEvent.id] || []}
                onFriend={(gid) => navigate(`/friends/${encodeURIComponent(gid)}`)}
                onSourceTap={(sid) => { closeDetail(); navigate(`/sources/${encodeURIComponent(sid)}`) }}
                onAddToGroup={state.googleUser?.id ? () => setAddToGroupEvent(detailEvent) : null}
                onDelete={
                  // Phase 1: only personal plans get a delete affordance
                  // here. Group events have their own delete in GroupDetail
                  // (admin or creator). createdBy is camelCase from
                  // _group_event_to_frontend; the comparison is the source
                  // of truth for "is this my plan".
                  state.googleUser?.id &&
                  detailEvent.isPersonalPlan &&
                  detailEvent.createdBy === state.googleUser.id
                    ? async () => {
                        if (!confirm(`Apagar o plano "${detailEvent.name}"? Os convidados também perdem acesso.`)) return
                        try {
                          await deletePersonalPlan(detailEvent.id, state.googleUser.id)
                          // Pull from local RSVP state if it was there
                          // (creators are auto-RSVP'd at creation time).
                          if (state.rsvps[detailEvent.id]) {
                            dispatch({
                              type: 'TOGGLE_RSVP',
                              payload: {
                                eventId: detailEvent.id,
                                dateStart: detailEvent.dateStart,
                                name: detailEvent.name,
                                venue: detailEvent.venue,
                              },
                            })
                          }
                          // Refresh the group-events feed so the row vanishes
                          // from Home + Events.
                          const gid = state.googleUser?.id
                          if (gid) fetchUserGroupEvents(gid).then(events => setGroupEvents(events || []))
                          closeDetail()
                        } catch (e) {
                          alert(`Erro ao apagar: ${e?.message || e}`)
                        }
                      }
                    : null
                }
                onClose={closeDetail}
                onRsvp={() => handleRsvpToggle(detailEvent)}
                onAttended={() => {
                  dispatch({ type: 'MARK_ATTENDED' })
                  closeDetail()
                }}
                userNeighborhood={state.neighborhood}
                t={t}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AddToGroupSheet
        open={!!addToGroupEvent}
        onClose={() => setAddToGroupEvent(null)}
        event={addToGroupEvent}
      />

      <PersonalPlanSheet
        open={showPlanSheet}
        onClose={() => setShowPlanSheet(false)}
        googleId={state.googleUser?.id}
        onCreated={(event) => {
          // Backend auto-RSVPs the creator into the rsvps table, but the
          // RSVPs tab reads from client-side state.rsvps — without a local
          // dispatch the user wouldn't see their own plan in My RSVPs.
          // Mirror the auto-RSVP into client state so both views agree.
          if (event?.id) {
            dispatch({
              type: 'TOGGLE_RSVP',
              payload: {
                eventId: event.id,
                name: event.name,
                venue: event.venue,
                dateStart: event.date_start,
              },
            })
          }
          // Refresh the group-events feed so the new plan shows up in the
          // catalog without a manual page reload.
          const gid = state.googleUser?.id
          if (gid) fetchUserGroupEvents(gid).then(events => setGroupEvents(events || []))
        }}
      />
    </div>
  )
}

// ── EventCard (compact horizontal layout) ────────────────────────────────────

// SourceBadge — shared between EventCard and DetailPanel. For Instagram
// sources, shows "📷 @<handle>" and links to the IG profile's source page.
// For institutional sources, shows the standard source label and links to
// the source's page on /sources. e.stopPropagation() so card click won't
// also fire when the badge is tapped.
function SourceBadge({ ev, onSourceTap }) {
  if (ev.isCustom) {
    return null  // custom events don't have a "source" surface
  }
  const isIg = ev.source === 'instagram' && ev.igHandle
  const src = SOURCE_CONFIG[ev.source]
  if (!src) return null
  const label = isIg ? `@${ev.igHandle}` : src.label
  const targetId = isIg ? `ig:${ev.igHandle}` : ev.source
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onSourceTap?.(targetId) }}
      title={isIg ? `Ver eventos de @${ev.igHandle}` : `Ver eventos de ${src.label}`}
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
        background: src.bg, color: src.color,
        padding: '2px 8px', borderRadius: 5,
        display: 'inline-flex', alignItems: 'center', gap: 3,
        border: `1px solid ${src.border}`, cursor: 'pointer',
      }}
    >
      {/* Icon prefix is dropped for Instagram — the "@" already signals
          the source, and 📷 felt like a placeholder. Institutional
          sources keep their icon for quick visual differentiation. */}
      {!isIg && src.icon} {label}
    </button>
  )
}


function EventCard({ ev, rsvped, friendsGoing = [], personalChip = null, onOpen, onFriend, onSourceTap, onOpenGroup, t }) {
  // Prefer the geocoded bairro from venues.bairro (canonical, normalized
  // by Nominatim/Claude) over the legacy `Venue · Bairro` suffix split.
  // Falls back to the suffix when the venue isn't in the cache yet so
  // newly-scraped events still show their bairro until the auto-pipeline
  // catches up.
  const [venueRaw, suffixBairro] = ev.venue?.includes(' · ')
    ? ev.venue.split(' · ')
    : [ev.venue, null]
  const venueName = (venueRaw || '').trim()
  const venueNeighborhood = (ev.bairro && ev.bairro.trim()) || suffixBairro

  // Highlight model (inverted from a prior iteration that highlighted
  // routines): the SCARCE thing is what catches the eye. Routines happen
  // every week by definition, so they read as background; one-off events
  // are time-sensitive ("if you miss it, it's gone") and get the warm
  // peach wash + brand-tinted border. Group events keep their cream + sage
  // stripe (different signal: "yours / private"). The date label still
  // says "Toda quinta · próx. X" for routines, so the recurrence info is
  // preserved in text without competing visually with one-offs.
  const isGroupEvent = !!ev.isGroupEvent
  const isRecurring = !!ev.isRecurring && !isGroupEvent
  const isOneOff = !isGroupEvent && !isRecurring
  const cardBackground = isGroupEvent ? '#FFFAF3'
                       : isOneOff ? '#FFF4EC'   // warm peach — brand-aligned, soft
                       : 'white'                  // routines = neutral default
  const cardBorder = isOneOff ? '1px solid #FFCCB0' : '1px solid var(--border)'
  const cardShadow = isGroupEvent ? 'inset 4px 0 0 var(--sage)' : 'none'

  return (
    <div
      onClick={onOpen}
      style={{
        background: cardBackground, borderRadius: 16,
        margin: '0 16px 9px', padding: '12px 13px',
        border: cardBorder,
        boxShadow: cardShadow,
        display: 'flex', gap: 12, alignItems: 'flex-start',
        cursor: 'pointer', transition: 'box-shadow 0.15s',
      }}
    >
      {/* Category icon */}
      <div style={{
        width: 48, height: 48, borderRadius: 13, flexShrink: 0,
        background: ev.headerBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22,
      }}>
        {ev.icon}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Name row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <div style={{
            fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
            lineHeight: 1.3, flex: 1,
          }}>
            {ev.name}
          </div>
          {rsvped && (
            <span style={{
              fontSize: 10, fontWeight: 700, flexShrink: 0,
              background: 'var(--sage-pale)', color: 'var(--sage)',
              padding: '3px 7px', borderRadius: 6,
            }}>
              ✓ Vou
            </span>
          )}
        </div>

        {/* Venue */}
        <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 3 }}>
          📍 {venueName}{venueNeighborhood && (
            <span style={{ color: 'var(--charcoal-light)' }}> · {venueNeighborhood}</span>
          )}
        </div>

        {/* Date + time. One-offs get the terra accent (matches the peach
            card wash and signals "time-sensitive"); routines stay charcoal
            so the row reads as ambient/regular. The date label itself
            already includes "Toda quinta · próx. X" for routines, so the
            recurrence info survives the visual de-emphasis. */}
        <div style={{
          fontSize: 11, fontWeight: 600, marginTop: 2,
          color: isOneOff ? 'var(--terra)' : 'var(--charcoal-mid)',
        }}>
          {isRecurring ? '🔁' : '🗓'} {ev.date} · {ev.time}
        </div>

        {/* Friends going (live from friends_feed) */}
        {friendsGoing.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <div style={{ display: 'flex' }}>
              {friendsGoing.slice(0, 3).map((f, i) => (
                <button
                  key={f.google_id ?? i}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (f.google_id && onFriend) onFriend(f.google_id)
                  }}
                  disabled={!f.google_id}
                  title={f.google_id ? `Ver eventos de ${f.name}` : f.name}
                  style={{
                    background: 'none', border: 'none', padding: 0,
                    marginLeft: i === 0 ? 0 : -6,
                    cursor: f.google_id ? 'pointer' : 'default',
                    borderRadius: '50%',
                    boxShadow: '0 0 0 2px white',
                  }}
                >
                  <Avatar name={f.name} src={f.picture} size={20} />
                </button>
              ))}
            </div>
            <span style={{ fontSize: 10, fontWeight: 600, color: '#5B8DD9' }}>
              {friendsGoing.length === 1
                ? `${friendsGoing[0].name} vai`
                : `${friendsGoing.length} amigos vão`}
            </span>
          </div>
        )}

        {/* Vibe summary */}
        {ev.vibeSummary && ev.vibeSummary !== ev.name && (
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 3, fontStyle: 'italic', lineHeight: 1.35 }}>
            {ev.vibeSummary}
          </div>
        )}

        {/* Bottom row: badges + RSVP button */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
            {personalChip && <PersonalChip chip={personalChip} />}
            {isGroupEvent ? (
              <button
                onClick={(e) => { e.stopPropagation(); if (ev.groupId) onOpenGroup?.(ev.groupId) }}
                title={`Ver grupo: ${ev.groupName || ''}`}
                style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                  background: 'var(--sage-pale)', color: 'var(--sage)',
                  padding: '2px 8px', borderRadius: 5,
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  border: '1px solid var(--sage)', cursor: 'pointer',
                  maxWidth: 180, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                🔒 {ev.groupName || 'Grupo'}
              </button>
            ) : (
              <SourceBadge ev={ev} onSourceTap={onSourceTap} />
            )}
            {ev.isCustom && (
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                background: '#FFF3E0', color: 'var(--terra)',
                padding: '2px 8px', borderRadius: 5,
              }}>
                ★ {t.tag_private}
              </span>
            )}
            {ev.priceTier === 'free' ? (
              <span className="tag tag--sage" style={{ fontSize: 10, padding: '2px 7px' }}>
                {t.tag_free}
              </span>
            ) : ev.price ? (
              <span style={{
                fontSize: 11, color: 'var(--charcoal-light)', fontWeight: 400,
              }}>
                {ev.price}
              </span>
            ) : null}
            {ev.kidsWelcome && (
              <span className="tag" style={{
                fontSize: 10, padding: '2px 7px',
                background: '#FFF3E0', color: '#E65100',
              }}>
                {t.tag_kids}
              </span>
            )}
          </div>
          {/* Action buttons removed from the card. AddToCalendar / Add
              to group / Confirmar all live in the DetailPanel instead —
              tapping the card opens it. The card stays an info surface;
              actions are one tap deeper, where they have room and don't
              compete with the dozens of cards in the list. */}
        </div>
      </div>
    </div>
  )
}

// ── Personalization chip ──
// Pure presentational. Truncates the conflicting/echoed event name so the
// chip doesn't blow out the row on small screens. Full name lives in the
// title attribute (long-press on mobile, hover on desktop).
function PersonalChip({ chip }) {
  const [icon, label, bg, color] = chip.kind === 'conflict'
    ? ['⚠', 'Mesma noite', '#FFF4E5', '#B8761F']
    : ['📍', 'Mesmo lugar', '#EAF2EC', '#5A7E5E']
  const tip = `${label} que ${chip.other}`
  return (
    <span
      title={tip}
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
        background: bg, color,
        padding: '2px 8px', borderRadius: 5,
        whiteSpace: 'nowrap',
      }}
    >
      {icon} {label}
    </span>
  )
}

// ── VenueRow ──────────────────────────────────────────────────────────────────

function VenueRow({ ev, favorited, onFavorite, onOpen, t }) {
  const subtype = getSubtype(ev)
  // Split "Name · Neighborhood" reliably
  const [, neighborhood] = ev.venue?.includes(' · ')
    ? ev.venue.split(' · ')
    : [null, ev.venue || '']

  return (
    <div
      onClick={onOpen}
      style={{
        background: 'white', borderRadius: 16, margin: '0 16px 8px',
        padding: '13px 14px', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
        transition: 'box-shadow 0.15s',
      }}
    >
      {/* Icon */}
      <div style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        background: subtype === 'cafe' ? '#F5DDD1' : '#2C2C2C',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 20,
      }}>
        {ev.icon || (subtype === 'cafe' ? '☕' : '🍺')}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {ev.name}
        </div>
        <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
          📍 {neighborhood}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          {ev.source && SOURCE_CONFIG[ev.source] && (() => {
            const src = SOURCE_CONFIG[ev.source]
            return (
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                background: src.bg, color: src.color,
                padding: '1px 7px', borderRadius: 5,
                display: 'inline-flex', alignItems: 'center', gap: 3,
              }}>
                {src.icon} {src.label}
              </span>
            )
          })()}
          {ev.rating > 0 && (
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--terra)' }}>
              ⭐ {ev.rating}
            </span>
          )}
          {ev.openNow === true && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: 'var(--sage)',
              background: 'var(--sage-pale)', padding: '1px 7px',
              borderRadius: 6,
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--sage)',
              }}/>
              Aberto agora
            </span>
          )}
          {ev.openNow === false && (
            <span style={{
              fontSize: 10, fontWeight: 600, color: 'var(--charcoal-light)',
              background: 'rgba(44,44,44,0.06)', padding: '1px 7px',
              borderRadius: 6,
            }}>
              Fechado
            </span>
          )}
          {ev.price && (
            <span style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>{ev.price}</span>
          )}
          {ev.kidsWelcome && (
            <span style={{
              fontSize: 10, background: '#FFF3E0', color: '#E65100',
              padding: '1px 7px', borderRadius: 6, fontWeight: 600,
            }}>
              {t.tag_kids}
            </span>
          )}
        </div>
      </div>

      {/* Favorite heart */}
      <button
        onClick={e => { e.stopPropagation(); onFavorite() }}
        title={favorited ? 'Remover dos favoritos' : 'Favoritar este lugar'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 22, padding: 6, flexShrink: 0,
          color: favorited ? '#E91E63' : 'var(--charcoal-light)',
          transition: 'transform 0.15s',
          transform: favorited ? 'scale(1.05)' : 'scale(1)',
        }}
      >
        {favorited ? '♥' : '♡'}
      </button>
    </div>
  )
}

// ── DetailPanel ───────────────────────────────────────────────────────────────

function DetailPanel({ event: ev, googleId, viewerName, viewerPicture, rsvped, friendsGoing = [], onClose, onRsvp, onAttended, onFriend, onSourceTap, onAddToGroup, onDelete, userNeighborhood, t }) {
  const isVenue = VENUE_CATEGORIES.has(ev.category)
  const [shareStatus, setShareStatus] = useState(null) // 'shared' | 'copied' | 'failed' | null
  const [imageZoomed, setImageZoomed] = useState(false)

  // Share the in-app deep link (/#/events?event=<id>) for every event —
  // catalog, group, custom — so recipients land in auê with the hero
  // open, not on the original ticketing page. Backend's GET /events/{id}
  // resolves catalog events and group events (ids prefixed grp_ev_); the
  // Events screen reads `?event=` and opens the drawer on mount.
  async function handleShare() {
    const url = appLink(`/events?event=${encodeURIComponent(ev.id)}`)
    const dateStr = ev.date ? ` · ${ev.date}` : ''
    const venueStr = ev.venue ? ` no ${ev.venue}` : ''
    const text = `${ev.name}${venueStr}${dateStr}`
    const result = await shareLink({ url, title: ev.name, text })
    setShareStatus(result)
    setTimeout(() => setShareStatus(null), 2200)
  }

  return (
    <>
      {/* Hero — uses the existing 120px banner slot. IG post image when
          available, gradient fallback otherwise. Tap an image hero to
          open the lightbox (full-resolution view). Subtle dark overlay
          so the back button and category emoji stay legible against
          bright photos. */}
      <div
        onClick={ev.imageUrl ? () => setImageZoomed(true) : undefined}
        style={{
          height: 120,
          background: ev.imageUrl
            ? `linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0) 35%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.30) 100%), url(${ev.imageUrl}) center / cover no-repeat`
            : ev.headerBg,
          position: 'relative',
          cursor: ev.imageUrl ? 'zoom-in' : 'default',
        }}
      >
        <button onClick={(e) => { e.stopPropagation(); onClose() }} style={{
          position: 'absolute', top: 12, left: 12,
          width: 32, height: 32, borderRadius: '50%',
          background: 'rgba(255,255,255,0.9)', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
        }}>←</button>
        <div style={{
          position: 'absolute', bottom: 12, left: 14, fontSize: 30,
          filter: ev.imageUrl ? 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))' : 'none',
        }}>{ev.icon}</div>
        {/* Tiny zoom hint at top-right when there's an image — small
            visual nudge that the banner is interactive. Hidden behind
            an icon to avoid taking text space. */}
        {ev.imageUrl && (
          <div style={{
            position: 'absolute', top: 12, right: 12,
            padding: '5px 8px', borderRadius: 999,
            background: 'rgba(0,0,0,0.45)', color: 'white',
            fontSize: 11, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            🔍 Ver
          </div>
        )}
      </div>

      {/* Lightbox — fullscreen overlay with the original-resolution image.
          Tap anywhere outside the image (or on it) to close. zIndex sits
          above the drawer (drawer is 9999) so the lightbox fully covers. */}
      {imageZoomed && ev.imageUrl && (
        <div
          onClick={() => setImageZoomed(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, cursor: 'zoom-out',
          }}
        >
          <img
            src={ev.imageUrl}
            alt={ev.name}
            style={{
              maxWidth: '100%', maxHeight: '100%',
              objectFit: 'contain', borderRadius: 8,
              boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            }}
          />
          <button
            onClick={(e) => { e.stopPropagation(); setImageZoomed(false) }}
            aria-label="Fechar"
            style={{
              position: 'absolute', top: 16, right: 16,
              width: 36, height: 36, borderRadius: '50%',
              background: 'rgba(255,255,255,0.9)', border: 'none',
              fontSize: 18, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
            }}
          >✕</button>
        </div>
      )}

      {/* Content */}
      <div style={{ padding: '14px 20px 28px' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 6 }}>
          {ev.name}
        </div>

        {/* Source badge — clickable, opens the source's page on /sources.
            For Instagram events, surfaces the actual handle (@<handle>) so
            the user knows which monitored profile this came from. */}
        {(ev.source && SOURCE_CONFIG[ev.source]) ? (() => {
          const isIg = ev.source === 'instagram' && ev.igHandle
          const src = SOURCE_CONFIG[ev.source]
          const label = isIg ? `@${ev.igHandle}` : src.label
          const targetId = isIg ? `ig:${ev.igHandle}` : ev.source
          return (
            <button
              onClick={() => onSourceTap?.(targetId)}
              title={isIg ? `Ver eventos de @${ev.igHandle}` : `Ver eventos de ${src.label}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 8, marginBottom: 10,
                background: src.bg, border: `1px solid ${src.border}`,
                cursor: 'pointer',
              }}
            >
              {!isIg && (
                <span style={{ fontSize: 12 }}>{src.icon}</span>
              )}
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: src.color, textTransform: isIg ? 'none' : 'uppercase' }}>
                {label}
              </span>
              <span style={{ fontSize: 10, color: src.color, opacity: 0.6 }}>→</span>
            </button>
          )
        })() : ev.isCustom ? (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 12px', borderRadius: 8, marginBottom: 10,
            background: '#FFF3E0', border: '1px solid #FFB74D',
          }}>
            <span style={{ fontSize: 12 }}>★</span>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: 'var(--terra)', textTransform: 'uppercase' }}>
              {t.tag_private_long}
            </span>
          </div>
        ) : null}

        {isVenue && (() => {
          // Open-now status comes from Google Places (open_now boolean).
          // True/false → live status pill; null → fallback to "Sempre aberto".
          if (ev.openNow === true) {
            return (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'var(--sage-pale)', padding: '4px 10px', borderRadius: 8,
                fontSize: 10, fontWeight: 700, color: 'var(--sage)',
                textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: 'var(--sage)',
                }}/>
                Aberto agora
              </div>
            )
          }
          if (ev.openNow === false) {
            return (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'rgba(44,44,44,0.07)', padding: '4px 10px', borderRadius: 8,
                fontSize: 10, fontWeight: 700, color: 'var(--charcoal-mid)',
                textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
              }}>
                Fechado agora
              </div>
            )
          }
          return (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--terra-pale)', padding: '4px 10px', borderRadius: 8,
              fontSize: 10, fontWeight: 700, color: 'var(--terra)',
              textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
            }}>
              {t.events_venue_open}
            </div>
          )
        })()}

        {/* Rating row for venues */}
        {isVenue && ev.rating > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--terra)' }}>⭐ {ev.rating}</div>
            {ev.attendeesConfirmed > 0 && (
              <div style={{ fontSize: 12, color: 'var(--charcoal-mid)' }}>
                {ev.attendeesConfirmed.toLocaleString('pt-BR')} avaliações no Google
              </div>
            )}
          </div>
        )}

        <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 12 }}>
          <div>📍 {ev.venue}{ev.city && !ev.venue?.includes(ev.city) ? ` · ${ev.city}` : ''}</div>
          {ev.venueAddress && (
            <div style={{ marginLeft: 18, fontSize: 12, color: 'var(--charcoal-light)' }}>
              {ev.venueAddress}
            </div>
          )}
          <div>
            {isVenue
              ? `🕐 ${t.events_venue_open}`
              : `🗓 ${ev.date} · ${ev.duration || ev.time}`
            }
          </div>
          <div>{ev.categoryEmoji} {ev.categoryLabel}</div>
          {ev.price && <div>💰 {ev.price}</div>}
          {ev.hasFood && <div>{t.events_food_drink}</div>}
        </div>

        {/* Price badge + Kids Welcome tag in detail view */}
        {(ev.priceTier === 'free' || ev.kidsWelcome) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {ev.priceTier === 'free' && (
              <span className="tag tag--sage">{t.tag_free}</span>
            )}
            {ev.kidsWelcome && (
              <span className="tag" style={{ background: '#FFF3E0', color: '#E65100' }}>
                {t.tag_kids}
              </span>
            )}
          </div>
        )}

        {/* Quem vai — full RSVP roster (friends + strangers + viewer if
            confirmed). Replaces the older "Amigos vão" block: this row
            covers both populations in one expandable strip, with friends
            still tappable so the post-event "people you met" flow works
            from the hero too. */}
        {googleId && (
          <div style={{ marginBottom: 12 }}>
            <AttendeesRow
              eventId={ev.id}
              googleId={googleId}
              isRsvped={rsvped}
              refreshKey={rsvped ? 'rsvp-on' : 'rsvp-off'}
              viewerName={viewerName}
              viewerPicture={viewerPicture}
              onFriend={onFriend}
            />
          </div>
        )}

        {(() => {
          const desc = cleanDescription(ev.description)
          return desc ? (
            <div style={{ fontSize: 14, color: 'var(--charcoal)', lineHeight: 1.5, marginBottom: 12, whiteSpace: 'pre-line' }}>
              {desc}
            </div>
          ) : null
        })()}

        {/* Source link — prominent so users can verify on the original site */}
        {ev.url && !isVenue && (() => {
          // When the URL is a Google Maps fallback (no canonical event URL),
          // label it as a map link instead of pretending it's a Sympla page.
          const isMapsUrl = ev.url.includes('google.com/maps')
          const src = ev.source && SOURCE_CONFIG[ev.source]
          const icon = isMapsUrl ? '📍' : '🔗'
          const label = isMapsUrl
            ? 'Ver no mapa →'
            : src ? `Ver no ${src.label} →` : t.events_view_original
          return (
            <a
              href={ev.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '7px 12px', borderRadius: 10, marginBottom: 12,
                background: 'var(--sage-pale)', color: 'var(--sage)',
                fontSize: 12, fontWeight: 700, textDecoration: 'none',
                border: '1px solid var(--sage)',
              }}
            >
              {icon} {label}
            </a>
          )
        })()}

        {ev.pitch && (
          <div style={{
            background: 'var(--sage-pale)', borderRadius: 12,
            padding: '10px 12px', marginBottom: 12,
            borderLeft: '3px solid var(--sage)',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--sage)', marginBottom: 4 }}>
              {t.events_why_good}
            </div>
            <div style={{ fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.5 }}>{ev.pitch}</div>
          </div>
        )}

        {/* Post-event attendees — "People you met" */}
        {!isVenue && (
          <PostEventAttendees
            eventId={ev.id}
            eventDate={ev.dateStart || ev.date}
          />
        )}

        <button className="btn btn--primary" onClick={onRsvp}>
          {rsvped
            ? (isVenue ? t.events_venue_remove : t.events_cancel_rsvp)
            : (isVenue ? t.events_venue_save : t.events_rsvp_btn)
          }
        </button>

        {onAddToGroup && !isVenue && (
          <button
            onClick={onAddToGroup}
            style={{
              width: '100%', marginTop: 10,
              padding: '12px', borderRadius: 12,
              background: 'transparent', border: '1.5px solid var(--border)',
              color: 'var(--charcoal-mid)', fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            👥 Adicionar a um grupo
          </button>
        )}

        <button
          onClick={handleShare}
          style={{
            width: '100%', marginTop: 10,
            padding: '12px', borderRadius: 12,
            background: 'transparent', border: '1.5px solid var(--border)',
            color: shareStatus ? 'var(--sage)' : 'var(--charcoal-mid)',
            borderColor: shareStatus ? 'var(--sage)' : 'var(--border)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {shareStatus === 'shared' ? '✓ Compartilhado'
            : shareStatus === 'copied' ? '✓ Link copiado'
            : shareStatus === 'failed' ? '✕ Falhou'
            : '🔗 Compartilhar'}
        </button>

        {/* Delete — only when caller decides the user has authority
            (personal plan creator). Red text + ghost background so it
            reads as destructive without a loud full-color button. */}
        {onDelete && (
          <button
            onClick={onDelete}
            style={{
              width: '100%', marginTop: 10,
              padding: '12px', borderRadius: 12,
              background: 'transparent', border: '1.5px solid #FFCDD2',
              color: '#C62828',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            🗑 Apagar plano
          </button>
        )}

        {rsvped && (
          <div style={{ marginTop: 10 }}>
            <AddToCalendar event={ev} />
          </div>
        )}

        {rsvped && !isVenue && (
          <button
            className="btn"
            style={{ marginTop: 10, background: 'var(--sage-pale)', color: 'var(--sage)', fontWeight: 600, fontSize: 14 }}
            onClick={onAttended}
          >
            {t.events_attended_btn}
          </button>
        )}

        {/* Venues keep the Google Maps link at the bottom; non-venue source link is shown above the description. */}
        {ev.url && isVenue && (
          <a
            href={ev.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', textAlign: 'center', marginTop: 14, fontSize: 12, color: 'var(--charcoal-light)', textDecoration: 'underline' }}
          >
            📍 Ver no Google Maps →
          </a>
        )}
      </div>
    </>
  )
}
