import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import { CATEGORY_META, CATEGORY_ORDER, INST_CATEGORY } from '../data/categories'
import { fetchEvents, fetchEventDetail, trackEvent, syncRsvp, fetchFriendsFeed, fetchUserGroupEvents, fetchSources, deletePersonalPlan, uploadEventImage, deleteEventImage } from '../services/api'
import { scheduleEventReminder, cancelEventReminder, schedulePostEventNotification } from '../lib/notifications'
import AddToCalendar from '../components/AddToCalendar'
import PostEventAttendees from '../components/PostEventAttendees'
import EventsWeekStrip from '../components/EventsWeekStrip'
import { getAnchorToday, getAnchorTodayIso } from '../lib/dateAnchor'
import Avatar from '../components/Avatar'
import AddToGroupSheet from '../components/AddToGroupSheet'
import EditEventSheet from '../components/EditEventSheet'
import PersonalPlanSheet from '../components/PersonalPlanSheet'
import AttendeesRow from '../components/AttendeesRow'
import InvitePeopleSheet from '../components/InvitePeopleSheet'
import CoHostsSheet from '../components/CoHostsSheet'
import EventsMap from '../components/EventsMap'
import { shareLink, appLink } from '../lib/share'

const VENUE_CATEGORIES = new Set(['bars_cafes', 'parks', 'cinema', 'bookstore'])

// Source provenance config — drives the badge label/style for every event origin.
// Add new entries here when new scrapers go live.
const SOURCE_CONFIG = {
  aue_original:     { label: 'Seleção auê',      icon: '⭐', bg: 'linear-gradient(135deg, #FFF8E1, #FFECB3)', border: '#FFD54F', color: '#8D6E10' },
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
    // light up before the user's "today" gets there. 6am-anchored so
    // late-night sessions stay surfaced until morning.
    return dayIso >= getAnchorTodayIso()
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
  // "Só únicos" — hide recurring residencies and multi-day ranges from
  // the list and the per-day pick filter. Default OFF so the catalog
  // shows everything; toggle ON when the user wants only the
  // time-sensitive stuff. Off = inclusive. On = exclusive.
  const [oneOffOnly, setOneOffOnly]         = useState(false)
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
  // Edit-event sheet target. null = sheet closed.
  const [editEvent, setEditEvent] = useState(null)

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
    // Track the open as an analytics event so the venue dashboard can
    // count "how many people viewed this event". Fire-and-forget; the
    // ig_handle is parsed from the event id (`instagram_ig_<handle>_<post>`)
    // so the per-venue rollup can group without a join.
    if (typeof eventId === 'string' && eventId.startsWith('instagram_ig_')) {
      const rest = eventId.slice('instagram_ig_'.length)
      const lastUnderscore = rest.lastIndexOf('_')
      const igHandle = lastUnderscore > 0 ? rest.slice(0, lastUnderscore) : ''
      trackEvent('event_view', { event_id: eventId, ig_handle: igHandle })
    } else if (typeof eventId === 'string' && eventId.startsWith('grp_ev_')) {
      // Group event opened — if the row was forked from a public IG
      // catalog event, attribute the view to the source venue's Painel
      // so group-context attention still credits the original venue.
      // sourceIgHandle is set on the event by the backend serializer.
      const groupMatch = groupEvents.find(e => e.id === eventId)
      const sourceHandle = (groupMatch && groupMatch.sourceIgHandle) || ''
      if (sourceHandle) {
        trackEvent('event_view', { event_id: eventId, ig_handle: sourceHandle })
      } else {
        trackEvent('event_view', { event_id: eventId })
      }
    } else {
      trackEvent('event_view', { event_id: eventId })
    }
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
    // Tier 1 — featured (Seleção auê) ABOVE everything else regardless
    // of date. That's the paid-placement guarantee the venue is paying
    // for. The backend already ships them sorted; the merge with
    // group/custom events would otherwise mix them back into the
    // chronological pile, so we re-pin here.
    const fa = a.featured ? 0 : 1
    const fb = b.featured ? 0 : 1
    if (fa !== fb) return fa - fb

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
  // "Só únicos" — drop recurring residencies and multi-day ranges. The
  // user reaches for this when the day-by-day expansion (which is back
  // on, see below) makes the list feel like the same residency over
  // and over. Off = full catalog with routines included.
  if (oneOffOnly) {
    filteredEvents = filteredEvents.filter(ev => {
      if (ev.isRecurring) return false
      const start = (ev.dateStart || '').slice(0, 10)
      const end = (ev.dateEnd || '').slice(0, 10) || start
      // Multi-day range = covers more than one day. Drop those too —
      // user only wants strict one-day events here.
      return !end || end === start
    })
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
    const startOfToday = getAnchorToday()
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

      {/* ── Filter chips: Todos + Só únicos + price + kids ──
          Order: "Todos" leads as the reset-everything pill (clears
          both price AND the oneOffOnly toggle so a single tap returns
          the full catalog). "⚡ Só únicos" sits second as a sub-mode.
          Then the price options. */}
      <div style={{ display: 'flex', gap: 6, padding: '0 16px 8px', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {/* "Todos" — clears price + Só únicos in one tap. Active state
            requires BOTH filters at default for the visual to read as
            "no filtering active". */}
        {(() => {
          const isAllActive = priceFilter === 'all' && !oneOffOnly && !kidsFilter
          return (
            <button
              onClick={() => { setPriceFilter('all'); setOneOffOnly(false); setKidsFilter(false) }}
              style={{
                padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
                fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
                transition: 'all 0.15s',
                border: isAllActive ? 'none' : '1px solid var(--border)',
                background: isAllActive ? 'var(--sage)' : 'transparent',
                color: isAllActive ? 'white' : 'var(--charcoal-light)',
              }}
            >
              {t.filter_all_prices}
            </button>
          )
        })()}
        {/* "Só únicos" — drops residencies/ranges so the list shows only
            one-day events. Sits second, after Todos. Toggling on flips
            the price filter back to 'all' if it was on free/paid? No —
            keep these orthogonal: oneOffOnly stacks with price. Only
            "Todos" resets everything. */}
        <button
          onClick={() => setOneOffOnly(v => !v)}
          style={{
            padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
            fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
            transition: 'all 0.15s',
            border: oneOffOnly ? 'none' : '1px solid var(--border)',
            background: oneOffOnly ? '#7E57C2' : 'transparent',
            color: oneOffOnly ? 'white' : 'var(--charcoal-light)',
          }}
        >
          ⚡ Só únicos
        </button>
        {/* Grátis is a toggle: tap to enable, tap again to disable.
            Pago was dropped — most users reach for Grátis explicitly,
            and the binary "any price" / "free only" pair covers the
            two states people actually want. */}
        <button
          onClick={() => setPriceFilter(p => p === 'free' ? 'all' : 'free')}
          style={{
            padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
            fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
            transition: 'all 0.15s',
            border: priceFilter === 'free' ? 'none' : '1px solid var(--border)',
            background: priceFilter === 'free' ? 'var(--sage)' : 'transparent',
            color: priceFilter === 'free' ? 'white' : 'var(--charcoal-light)',
          }}
        >
          🆓 {t.filter_free}
        </button>
        <button
          onClick={() => setKidsFilter(k => !k)}
          style={{
            padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
            fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
            transition: 'all 0.15s',
            // Pink accent — honey freed up for the EventCard one-off
            // ribbon, so the Kids Welcome chip moved to pink. Distinct
            // from sage (group), purple (Só únicos), and the date-range
            // terra orange.
            border: kidsFilter ? 'none' : '1px solid var(--border)',
            background: kidsFilter ? '#EC407A' : 'transparent',
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
            const isAllChip = r.id === 'all'
            const dayPicked = !!selectedDay
            const dateActive = dayPicked || dateRange !== 'all'
            // "Tudo" doubles as the reset for any date narrowing — a
            // per-day pick from the week strip OR a non-default range
            // (Hoje / Fim de semana / Próx 7 dias). Whenever ANY date
            // filter is active, Tudo re-labels to "✕ Todas as datas"
            // so the escape hatch is obvious. Tap clears both axes.
            const active = isAllChip
              ? !dateActive
              : dateRange === r.id
            const label = isAllChip && dateActive ? '✕ Todas as datas' : r.label
            return (
              <button
                key={r.id}
                onClick={() => {
                  setDateRange(r.id)
                  if (isAllChip) setSelectedDay(null)
                }}
                style={{
                  padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
                  fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
                  transition: 'all 0.15s',
                  border: active ? 'none' : '1px solid var(--border)',
                  background: active ? 'var(--terra)' : 'transparent',
                  color: active ? 'white' : 'var(--charcoal-light)',
                }}
              >
                {label}
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
                    // For recurring events: when a specific day is
                    // picked from the strip, the card should show THAT
                    // day, not the rolled-forward "next occurrence"
                    // dateStart on the event. Range events get the
                    // same treatment when the picked day falls inside
                    // their span.
                    displayDate={
                      selectedDay && (ev.isRecurring || (ev.dateEnd && ev.dateEnd.slice(0,10) > ev.dateStart.slice(0,10)))
                        ? selectedDay
                        : null
                    }
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
                onEdit={
                  // Same permission set as image management — creator or
                  // co-host of any user-created event (group or personal).
                  !!(state.googleUser?.id &&
                  detailEvent.isGroupEvent && (
                    detailEvent.createdBy === state.googleUser.id ||
                    (detailEvent.coHostIds || []).includes(state.googleUser.id)
                  ))
                    ? () => setEditEvent(detailEvent)
                    : null
                }
                onDelete={
                  // Personal plans only get a delete affordance here.
                  // Group events have their own delete in GroupDetail
                  // (admin / creator / co-host). Personal plan deletion
                  // is allowed for the creator OR any co-host.
                  state.googleUser?.id &&
                  detailEvent.isPersonalPlan && (
                    detailEvent.createdBy === state.googleUser.id ||
                    (detailEvent.coHostIds || []).includes(state.googleUser.id)
                  )
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
                canInvite={
                  // Creator OR co-host, and only on private events.
                  // Catalog events have no invitee list to add to.
                  !!(state.googleUser?.id &&
                  detailEvent.isGroupEvent && (
                    detailEvent.createdBy === state.googleUser.id ||
                    (detailEvent.coHostIds || []).includes(state.googleUser.id)
                  ))
                }
                onInvited={({ invitee_google_ids }) => {
                  // Mirror the new list into local state so the next
                  // open of the picker filters out everyone we already
                  // added. AttendeesRow refresh is handled inside.
                  setDetailEvent(prev => prev && prev.id === detailEvent.id
                    ? { ...prev, extraInviteeIds: invitee_google_ids }
                    : prev)
                  // Refresh the user's group-events feed so the row
                  // reflects the new pending count on Home + Events.
                  const gid = state.googleUser?.id
                  if (gid) fetchUserGroupEvents(gid).then(events => setGroupEvents(events || []))
                }}
                onCoHostsChanged={(newCoHostIds) => {
                  setDetailEvent(prev => prev && prev.id === detailEvent.id
                    ? { ...prev, coHostIds: newCoHostIds }
                    : prev)
                }}
                canEdit={
                  // Image management = same role set as invite/delete.
                  // Catalog events are not editable.
                  !!(state.googleUser?.id &&
                  detailEvent.isGroupEvent && (
                    detailEvent.createdBy === state.googleUser.id ||
                    (detailEvent.coHostIds || []).includes(state.googleUser.id)
                  ))
                }
                onImageChanged={(newImageUrl) => {
                  setDetailEvent(prev => prev && prev.id === detailEvent.id
                    ? { ...prev, imageUrl: newImageUrl || null }
                    : prev)
                  // Refresh the user's group-events feed so the row
                  // shows the new cover image on Home + Events.
                  const gid = state.googleUser?.id
                  if (gid) fetchUserGroupEvents(gid).then(events => setGroupEvents(events || []))
                }}
                onClose={closeDetail}
                onRsvp={() => handleRsvpToggle(detailEvent)}
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

      <EditEventSheet
        open={!!editEvent}
        onClose={() => setEditEvent(null)}
        event={editEvent}
        googleId={state.googleUser?.id}
        onSaved={(updatedRow) => {
          // Backend returns the raw DB row (snake_case). Mirror it into
          // the live detail panel and the user's group-events feed so the
          // changes show without a full refetch. Field names follow the
          // frontend's normalized shape (Events.jsx already maps name,
          // venue, dateStart, etc. when reading from the catalog).
          setDetailEvent(prev => prev && prev.id === updatedRow.id ? {
            ...prev,
            name: updatedRow.name,
            venue: updatedRow.venue,
            dateStart: updatedRow.date_start,
            description: updatedRow.description,
            note: updatedRow.note,
          } : prev)
          const gid = state.googleUser?.id
          if (gid) fetchUserGroupEvents(gid).then(events => setGroupEvents(events || []))
        }}
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


// ── EventCard — day-anchored row, auê palette ────────────────────────────────
//
// Layout borrowed from a tight terminal-style reference: day number
// as visual anchor on the left, event name dominant in the middle,
// metadata on a single line below, price pinned right. Friends-going
// shows as a small line below when applicable.
//
// Colors stay in the auê palette — cream/white card on the page
// background, terra (#E8623F) for the day anchor and accents, sage
// (#5A7E5E) for friends-going, charcoal for text. PersonalChip /
// SourceBadge / kidsWelcome / vibeSummary dropped from the card; they
// all live in DetailPanel one tap deeper.

const _PT_WEEKDAY = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']

function _parseDayLabels(iso) {
  if (!iso) return { day: '—', weekday: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { day: '—', weekday: '' }
  return {
    day: String(d.getDate()).padStart(2, '0'),
    weekday: _PT_WEEKDAY[d.getDay()] || '',
  }
}

function _formatPrice(ev, freeLabel) {
  if (ev.priceTier === 'free' || ev.price === 'Gratuito' || ev.price === 'Free') {
    return { text: (freeLabel || 'FREE').toUpperCase(), accent: true }
  }
  if (!ev.price) return null
  // Strip the R$ prefix for the compact terminal look — reference shows
  // bare numbers ("80-160", "18"). Keep the raw string when stripping
  // would lose meaning ("Doação", "Combo"). em-dash → en-dash for
  // consistency with the reference.
  const stripped = ev.price.replace(/R\$\s*/g, '').replace(/\s*-\s*/g, '–').trim()
  return { text: stripped, accent: false }
}

function EventCard({ ev, rsvped, friendsGoing = [], personalChip = null, onOpen, onFriend, onSourceTap, onOpenGroup, displayDate = null, t }) {
  const isGroupEvent = !!ev.isGroupEvent
  const isRecurring = !!ev.isRecurring && !isGroupEvent
  // "Ongoing" = recurring OR multi-day range. Both are conceptually
  // the same for the purpose of visual emphasis: not a one-night-only
  // commitment, you can drop in any day in the run. A 12-day theatre
  // residency, a weekly bar set, and a 3-night festival all read
  // similarly to the user — none of them are scarce in the
  // "miss-it-and-it's-gone" sense that one-offs carry.
  const dsKey = (ev.dateStart || '').slice(0, 10)
  const deKey = (ev.dateEnd || '').slice(0, 10)
  const isMultiDayRange = !!(deKey && dsKey && deKey > dsKey)
  const isOngoing = (isRecurring || isMultiDayRange) && !isGroupEvent

  // For recurring events, the parent passes the strip-picked day so
  // the card shows the specific occurrence the user is looking at,
  // not the rolled-forward "next" date stored on the event. Same idea
  // for multi-day ranges. Falls back to ev.dateStart for one-offs.
  const sourceDate = displayDate
    ? `${displayDate}T${(ev.dateStart || '').slice(11) || '00:00:00'}`
    : ev.dateStart
  const { day, weekday } = _parseDayLabels(sourceDate)
  const time = (ev.time || '').trim()

  // Venue + bairro: single inline " · " separated string. Bairro from
  // the geocoded venues cache, falling back to the legacy suffix split
  // for venues not in the cache yet.
  const [venueRaw, suffixBairro] = ev.venue?.includes(' · ')
    ? ev.venue.split(' · ')
    : [ev.venue, null]
  const venueName = (venueRaw || '').trim()
  const bairro = (ev.bairro && ev.bairro.trim()) || suffixBairro || ''
  const venueLine = bairro ? `${venueName} · ${bairro}` : venueName

  const price = _formatPrice(ev, t?.tag_free)
  const friendCount = friendsGoing.length

  return (
    <div
      onClick={onOpen}
      style={{
        // Card hues:
        //   - group (yours)                    → sage (orange #E8623F)
        //   - one-off (time-sensitive)         → honey (amber #F4A623)
        //   - ongoing (recurring or multi-day) → terra-light blue,
        //                                        no stripe
        // Kids Welcome chip moved off honey (now pink) so the EventCard
        // can reclaim honey/yellow for the most visually loud row type.
        // Featured ("Destaque") events get a star pill in the top-right
        // of the card AND lift to the top of the list — that's the
        // monetization surface, not a card color change.
        background: 'white',
        margin: '0 16px 6px', padding: '12px 14px',
        borderRadius: 12,
        border: ev.featured ? '1.5px solid var(--honey)' : '1px solid var(--border)',
        boxShadow: isGroupEvent ? 'inset 3px 0 0 var(--sage)'
                  : isOngoing ? 'none'
                  : 'inset 3px 0 0 #7E57C2',
        display: 'flex', alignItems: 'stretch', gap: 14,
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      {/* LEFT — day anchor. Color tracks the stripe so the kind reads
          from the day number too: terra for one-off, purple for
          recurring, sage for group. Width fixed at 42px so the
          center column starts on a consistent x across rows. */}
      <div style={{
        flexShrink: 0, width: 42, textAlign: 'left',
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
      }}>
        <div style={{
          fontSize: 26, fontWeight: 800, lineHeight: 1,
          // Day color matches the stripe — sage for group, purple for
          // one-off (mirrors the "Só únicos" filter chip), terra-light
          // blue for ongoing.
          color: isGroupEvent ? 'var(--sage)'
               : isOngoing ? 'var(--terra-light)'
               : '#7E57C2',
          letterSpacing: -0.5,
        }}>
          {day}
        </div>
        <div style={{
          fontSize: 10, fontWeight: 700, marginTop: 2,
          color: 'var(--charcoal-mid)', letterSpacing: 1,
        }}>
          {weekday}
        </div>
      </div>

      {/* CENTER — name + single metadata row */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
          lineHeight: 1.3,
          // Allow up to 2 lines, truncate after.
          display: '-webkit-box', WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
          marginBottom: 4,
        }}>
          {isGroupEvent && '🔒 '}
          {ev.name}
        </div>

        {/* Single metadata row: time · venue · bairro. Truncates with
            ellipsis on narrow screens — venue + bairro can be long.
            The leading category emoji was dropped since the day-number
            color + left stripe already convey the event kind. */}
        <div style={{
          fontSize: 11, color: 'var(--charcoal-mid)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {time}
          {time && venueLine && <> · </>}
          {venueLine}
        </div>

        {/* Friends going line. Sage (auê's friend color) with ▸ prefix.
            Friend avatars dropped for visual density — the count +
            names land harder when unaccompanied. Tap routes to the
            first friend's profile. */}
        {friendCount > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              const first = friendsGoing.find(f => f.google_id)
              if (first?.google_id && onFriend) onFriend(first.google_id)
            }}
            style={{
              background: 'none', border: 'none', padding: 0,
              marginTop: 4, cursor: 'pointer',
              fontSize: 11, color: 'var(--sage)',
              fontWeight: 600,
            }}
          >
            ▸ {friendCount === 1
              ? `${friendsGoing[0].name} vai`
              : `${friendCount} amigos vão`}
          </button>
        )}
      </div>

      {/* RIGHT — Destaque badge / price / RSVP marker */}
      <div style={{
        flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'flex-end', justifyContent: 'flex-start',
        gap: 4,
      }}>
        {ev.featured && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <div
              title="Seleção auê — destaque pago"
              style={{
                fontSize: 11, lineHeight: 1,
                color: 'var(--honey)', background: 'var(--honey-pale)',
                width: 18, height: 18, borderRadius: '50%',
                border: '1px solid var(--honey)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >⭐</div>
            {ev.promoCode && (
              <div
                title={ev.promoPerk || 'Cupom no balcão — toca o evento pra ver o código'}
                style={{
                  fontSize: 11, lineHeight: 1,
                  color: 'var(--sage)', background: 'var(--sage-pale)',
                  width: 18, height: 18, borderRadius: '50%',
                  border: '1px solid var(--sage)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >🎁</div>
            )}
          </div>
        )}
        {price && (
          <div style={{
            fontSize: 12, fontWeight: 800,
            color: price.accent ? 'var(--sage)' : 'var(--charcoal)',
            letterSpacing: 0.5, whiteSpace: 'nowrap',
          }}>
            {price.text}
          </div>
        )}
        {rsvped && (
          <div style={{
            fontSize: 9, fontWeight: 700, color: 'var(--sage)',
            letterSpacing: 0.5,
          }}>
            ✓ VOU
          </div>
        )}
      </div>
    </div>
  )
}

// ── Personalization chip ──
// Pure presentational. Truncates the conflicting/echoed event name so the
// chip doesn't blow out the row on small screens. Full name lives in the
// title attribute (long-press on mobile, hover on desktop).
// Sympla buy-link CTA — appears in DetailPanel when the matching
// pipeline has attached a sympla_url to the event. Click handler
// fires sympla_click analytics with the IG handle for venue Painel
// rollup, then appends utm_source=aue&utm_campaign=event_<id> to
// the outbound URL so we can show "auê drove X visits" later when
// pitching per-event affiliate invites.
function SymplaBuyButton({ ev }) {
  const igHandle = (ev.id || '').startsWith('instagram_ig_')
    ? (() => {
        const rest = ev.id.slice('instagram_ig_'.length)
        const i = rest.lastIndexOf('_')
        return i > 0 ? rest.slice(0, i) : ''
      })()
    : ''
  function buildUrl() {
    try {
      const u = new URL(ev.symplaUrl)
      u.searchParams.set('utm_source', 'aue')
      u.searchParams.set('utm_medium', 'referral')
      u.searchParams.set('utm_campaign', `event_${ev.id}`)
      return u.toString()
    } catch {
      return ev.symplaUrl
    }
  }
  function handleClick(e) {
    trackEvent('sympla_click', {
      event_id: ev.id,
      ig_handle: igHandle,
      sympla_url: ev.symplaUrl,
    })
  }
  return (
    <a
      href={buildUrl()}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, marginTop: 12, padding: '12px 16px',
        borderRadius: 12, textDecoration: 'none',
        background: 'var(--terra)', color: 'white',
        fontSize: 14, fontWeight: 700, letterSpacing: 0.3,
      }}
    >
      🎟️ Comprar ingresso na Sympla →
    </a>
  )
}


function PromoCodeBlock({ ev }) {
  // Two-state pill: collapsed "🎁 Mostrar código no balcão" → tap →
  // expanded card with the code monospaced + perk copy + a "copiar"
  // button. Tracks `code_view` on first reveal so the venue Painel
  // can count tighter conversions than view→RSVP.
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  function reveal() {
    if (revealed) return
    setRevealed(true)
    const igHandle = (ev.id || '').startsWith('instagram_ig_')
      ? (() => {
          const rest = ev.id.slice('instagram_ig_'.length)
          const i = rest.lastIndexOf('_')
          return i > 0 ? rest.slice(0, i) : ''
        })()
      : ''
    trackEvent('code_view', { event_id: ev.id, ig_handle: igHandle })
  }

  function copyCode() {
    try {
      navigator.clipboard.writeText(ev.promoCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch { /* swallow — copy is best-effort */ }
  }

  if (!revealed) {
    return (
      <button
        onClick={reveal}
        style={{
          width: '100%', marginBottom: 10,
          padding: '12px', borderRadius: 12,
          background: 'var(--honey-pale)',
          border: '1.5px solid var(--honey)',
          color: '#8D6E10', fontSize: 13, fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        🎁 Mostrar código no balcão
      </button>
    )
  }
  return (
    <div style={{
      marginBottom: 10, padding: '12px 14px',
      background: 'var(--honey-pale)',
      border: '1.5px solid var(--honey)', borderRadius: 12,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: '#8D6E10',
        textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4,
      }}>
        🎁 Cupom Seleção auê
      </div>
      <div style={{
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 18, fontWeight: 800, color: 'var(--charcoal)',
        letterSpacing: 0.6, marginBottom: 6, wordBreak: 'break-all',
      }}>
        {ev.promoCode}
      </div>
      {ev.promoPerk && (
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.4, marginBottom: 8 }}>
          {ev.promoPerk}
        </div>
      )}
      <button
        onClick={copyCode}
        style={{
          padding: '7px 14px', borderRadius: 10,
          background: 'white', border: '1px solid var(--honey)',
          color: '#8D6E10', fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}
      >
        {copied ? '✓ Copiado' : '📋 Copiar código'}
      </button>
      <div style={{
        fontSize: 10, color: 'var(--charcoal-light)',
        marginTop: 8, lineHeight: 1.4,
      }}>
        Mostre esse código no balcão pra resgatar. Cupom oferecido pelo
        local — auê só conecta.
      </div>
    </div>
  )
}

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

function DetailPanel({ event: ev, googleId, viewerName, viewerPicture, rsvped, friendsGoing = [], onClose, onRsvp, onFriend, onSourceTap, onAddToGroup, onDelete, canInvite, onInvited, onCoHostsChanged, canEdit, onImageChanged, onEdit, userNeighborhood, t }) {
  const isVenue = VENUE_CATEGORIES.has(ev.category)
  const [shareStatus, setShareStatus] = useState(null) // 'shared' | 'copied' | 'failed' | null
  // Post-creation invite sheet — only opens for the creator/co-hosts
  // of a private event. Bumped invitedTick refetches AttendeesRow so
  // the newly added pending invitees show up immediately.
  const [showInvite, setShowInvite] = useState(false)
  const [showCoHosts, setShowCoHosts] = useState(false)
  const [invitedTick, setInvitedTick] = useState(0)
  const [imageZoomed, setImageZoomed] = useState(false)
  // Track image load failure separately. IG CDN URLs are signed and
  // expire after a few days, so by the time a user opens an older
  // event the URL 403s. background-image has no error event, so we
  // render via <img> and flip this flag from onError to fall back
  // cleanly to the gradient (and hide the zoom affordance).
  const [imageBroken, setImageBroken] = useState(false)
  const showImage = !!ev.imageUrl && !imageBroken
  // Reset imageBroken whenever the underlying URL changes (e.g.,
  // after a successful upload). Without this, a single onError
  // would permanently mask any future uploaded image too.
  useEffect(() => { setImageBroken(false) }, [ev.imageUrl])
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState(null)
  const fileInputRef = useRef(null)

  async function handleImagePicked(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !ev.id) return
    setImageError(null); setImageUploading(true)
    try {
      const result = await uploadEventImage(ev.id, googleId, file)
      onImageChanged?.(result.image_url)
    } catch (err) {
      setImageError(err?.message || 'Não consegui enviar a foto')
    } finally {
      setImageUploading(false)
    }
  }

  async function handleImageRemove(e) {
    e?.stopPropagation()
    if (!ev.id) return
    if (!confirm('Remover a foto do evento?')) return
    setImageError(null); setImageUploading(true)
    try {
      await deleteEventImage(ev.id, googleId)
      onImageChanged?.('')
    } catch (err) {
      setImageError(err?.message || 'Não consegui remover a foto')
    } finally {
      setImageUploading(false)
    }
  }

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
          available + loadable, gradient fallback otherwise. Tap an
          image hero to open the lightbox. Subtle dark overlay keeps
          the back button + category emoji readable against bright
          photos. */}
      <div
        onClick={showImage ? () => setImageZoomed(true) : undefined}
        style={{
          // Image hero gets more room (240px) so faces/posters/flyers
          // actually read at a glance — 180 was enough to know "yes,
          // there is a photo" but cropped most of the content.
          // Gradient hero stays 120 to keep no-image events from
          // looking unintentionally tall and empty.
          height: showImage ? 240 : 120,
          background: ev.headerBg,
          position: 'relative',
          overflow: 'hidden',
          cursor: showImage ? 'zoom-in' : 'default',
        }}
      >
        {/* Image rendered via <img> so onError can flip imageBroken
            and we degrade to the gradient cleanly when an IG CDN URL
            has expired. Hidden image still loads — onError fires and
            removes it from view. */}
        {ev.imageUrl && !imageBroken && (
          <>
            <img
              src={ev.imageUrl}
              alt=""
              onError={() => setImageBroken(true)}
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                objectFit: 'cover',
              }}
            />
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0) 35%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.30) 100%)',
              pointerEvents: 'none',
            }} />
          </>
        )}
        <button onClick={(e) => { e.stopPropagation(); onClose() }} style={{
          position: 'absolute',
          // Push below iPhone notch / Dynamic Island. env() degrades to
          // 0 on browsers that don't define the safe-area-inset, so this
          // is also correct on web.
          top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
          left: 12,
          width: 32, height: 32, borderRadius: '50%',
          background: 'rgba(255,255,255,0.9)', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
          zIndex: 1,
        }}>←</button>
        {/* Category emoji is the visual anchor only when there's no
            image — when a photo is showing it's redundant noise on top
            of the actual content of the event. */}
        {!showImage && (
          <div style={{
            position: 'absolute', bottom: 12, left: 14, fontSize: 30,
            zIndex: 1,
          }}>{ev.icon}</div>
        )}
        {/* Top-right slot: editor controls (canEdit) win priority over
            the zoom hint. For non-editors viewing an image we keep the
            zoom hint so they know it expands. Stop propagation on
            buttons so the hero's tap-to-zoom doesn't fire from a tap
            on the upload control. */}
        {canEdit ? (
          <div style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
            right: 12,
            display: 'flex', gap: 6, zIndex: 2,
          }}>
            <button
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click() }}
              disabled={imageUploading}
              aria-label={showImage ? 'Trocar foto' : 'Adicionar foto'}
              style={{
                padding: '6px 12px', borderRadius: 16,
                background: 'rgba(255,255,255,0.92)', border: 'none',
                fontSize: 12, fontWeight: 700, cursor: imageUploading ? 'wait' : 'pointer',
                boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
                opacity: imageUploading ? 0.7 : 1,
              }}
            >
              {imageUploading ? '...' : showImage ? '📷 Trocar' : '📷 Adicionar foto'}
            </button>
            {showImage && !imageUploading && (
              <button
                onClick={handleImageRemove}
                aria-label="Remover foto"
                style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'rgba(255,255,255,0.92)', border: 'none',
                  cursor: 'pointer', fontSize: 14,
                  boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
                }}
              >
                🗑
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              // Keep the input in the layout (not display:none) so iOS
              // WKWebView fires the file picker reliably on programmatic
              // .click(). Visually invisible via 0×0 + opacity:0.
              style={{
                position: 'absolute', width: 0, height: 0, opacity: 0,
                pointerEvents: 'none',
              }}
              onChange={handleImagePicked}
            />
          </div>
        ) : showImage ? (
          <div style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
            right: 12,
            padding: '5px 8px', borderRadius: 999,
            background: 'rgba(0,0,0,0.45)', color: 'white',
            fontSize: 11, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 4,
            zIndex: 1,
          }}>
            🔍 Ver
          </div>
        ) : null}
        {imageError && (
          <div style={{
            position: 'absolute', bottom: 8, left: 12, right: 12,
            padding: '6px 10px', borderRadius: 8,
            background: '#FFEBEE', color: '#B71C1C', fontSize: 11,
            zIndex: 2,
          }}>
            {imageError}
          </div>
        )}
      </div>

      {/* Lightbox — fullscreen overlay with the original-resolution image.
          Tap anywhere outside the image (or on it) to close. zIndex sits
          above the drawer (drawer is 9999) so the lightbox fully covers.
          Only shown when the image actually loaded — protects against
          a stale-URL banner trying to expand into a 403. */}
      {imageZoomed && showImage && (
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

        {/* Vibe summary — short LLM-extracted sentence about the event.
            Sits right under the title as the "what is this in one line"
            glance before the user scrolls into the metadata + actions.
            Hidden when the LLM echoed the event name (noise filter). */}
        {ev.vibeSummary && ev.vibeSummary !== ev.name && (
          <div style={{
            fontSize: 13, color: 'var(--charcoal-mid)',
            fontStyle: 'italic', lineHeight: 1.4, marginBottom: 10,
          }}>
            {ev.vibeSummary}
          </div>
        )}

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
          {/* Catalog events show their genre/source category here ("🎵
              Música", "🍻 Bar"). Group events and personal plans get
              "👥 Grupo" / "🎲 Plano" from the backend, which is
              redundant — the user already knows it's a plan from the
              creator chip + invitee list. Hide for those. */}
          {!ev.isGroupEvent && (
            <div>{ev.categoryEmoji} {ev.categoryLabel}</div>
          )}
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

        {/* Adicionado por — group events / personal plans surface the
            creator so the recipient knows who put this on the calendar.
            Catalog (IG) events leave createdByName empty and skip this.
            Chip is tappable on private events so creator/co-host can
            manage co-organizers and viewers can see who's organizing. */}
        {ev.createdByName && (() => {
          const coHostCount = (ev.coHostIds || []).length
          const isPrivate = !!ev.isGroupEvent
          const ChipTag = isPrivate ? 'button' : 'div'
          return (
            <ChipTag
              {...(isPrivate ? { onClick: () => setShowCoHosts(true) } : {})}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
                padding: '8px 12px', borderRadius: 12, background: 'white',
                border: '1px solid var(--border)',
                width: '100%', textAlign: 'left',
                cursor: isPrivate ? 'pointer' : 'default',
              }}
            >
              <Avatar name={ev.createdByName} src={ev.createdByPicture} size={28} />
              <span style={{ flex: 1, fontSize: 12, color: 'var(--charcoal-mid)' }}>
                {ev.isPersonalPlan ? 'Convite de ' : 'Adicionado por '}
                <strong style={{ color: 'var(--charcoal)' }}>{ev.createdByName}</strong>
                {coHostCount > 0 && (
                  <span> · {coHostCount} co-organizador{coHostCount === 1 ? '' : 'es'}</span>
                )}
              </span>
              {isPrivate && (
                <span style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>›</span>
              )}
            </ChipTag>
          )
        })()}

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
              refreshKey={`${rsvped ? 'rsvp-on' : 'rsvp-off'}-${invitedTick}`}
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

        {/* "Bora?" pitch block removed — copy was prescriptive ("Não
            recomendado…") which clashes with auê's voice (descriptive,
            not judgmental). The vibe summary on the EventCard plus the
            event description below cover the same ground without the
            "should you go" framing. */}

        {/* Post-event attendees — "People you met" */}
        {!isVenue && (
          <PostEventAttendees
            eventId={ev.id}
            eventDate={ev.dateStart || ev.date}
          />
        )}

        {/* Promo code reveal — only on featured (paid) venues that
            set a code. Tap to expand, copy-able pill, perk copy
            below. Logs `code_view` so the venue Painel can track
            "of N viewers, M tapped the code" as a tighter
            conversion signal than RSVP alone. */}
        {ev.promoCode && <PromoCodeBlock ev={ev} />}

        {/* Sympla buy-link — set by the matching pipeline when the
            catalog event aligns with a CWB Sympla event. Tracks
            sympla_click + appends utm_source=aue so we can show
            venues we drove X visits to their event. */}
        {ev.symplaUrl && <SymplaBuyButton ev={ev} />}

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

        {onEdit && (
          <button
            onClick={onEdit}
            style={{
              width: '100%', marginTop: 10,
              padding: '12px', borderRadius: 12,
              background: 'transparent', border: '1.5px solid var(--border)',
              color: 'var(--charcoal-mid)', fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ✏️ Editar evento
          </button>
        )}

        {canInvite && (
          <button
            onClick={() => setShowInvite(true)}
            style={{
              width: '100%', marginTop: 10,
              padding: '12px', borderRadius: 12,
              background: 'transparent', border: '1.5px solid var(--border)',
              color: 'var(--charcoal-mid)', fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            👥 Convidar mais gente
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
      <InvitePeopleSheet
        open={showInvite}
        onClose={() => setShowInvite(false)}
        eventId={ev.id}
        googleId={googleId}
        eventName={ev.name}
        existingInviteeIds={ev.extraInviteeIds || []}
        onInvited={(result) => {
          setInvitedTick(t => t + 1)
          onInvited?.(result)
        }}
      />
      <CoHostsSheet
        open={showCoHosts}
        onClose={() => setShowCoHosts(false)}
        eventId={ev.id}
        googleId={googleId}
        creatorId={ev.createdBy}
        creatorName={ev.createdByName}
        creatorPicture={ev.createdByPicture}
        coHostIds={ev.coHostIds || []}
        inviteeIds={ev.extraInviteeIds || []}
        onChange={(newCoHostIds) => onCoHostsChanged?.(newCoHostIds)}
      />
    </>
  )
}
