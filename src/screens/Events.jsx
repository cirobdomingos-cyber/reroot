import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp, myPicture } from '../context/AppContext'
import { unfollowedSet, hiddenByFollows } from '../lib/follows'
import { eventCardVariant } from '../lib/cardVariant'
import { useT } from '../i18n'
import { CATEGORY_META, CATEGORY_ORDER, INST_CATEGORY } from '../data/categories'
import { fetchEvents, fetchEventDetail, trackEvent, syncRsvp, fetchFriendsFeed, fetchUserGroupEvents, fetchSources, deletePersonalPlan, deleteGroupEvent, uploadEventImage, deleteEventImage, requestEventInvite, fetchChannelPicks, BASE_URL } from '../services/api'
import { scheduleEventReminder, cancelEventReminder } from '../lib/notifications'
import PostEventAttendees from '../components/PostEventAttendees'
import EventsWeekStrip from '../components/EventsWeekStrip'
import { getAnchorToday, getAnchorTodayIso } from '../lib/dateAnchor'
import Avatar from '../components/Avatar'
import { createPortal } from 'react-dom'
import { compressImageForUpload } from '../lib/image-compress'
import AddToGroupSheet from '../components/AddToGroupSheet'
import InviteRequestsPanel from '../components/InviteRequestsPanel'
import EditEventSheet from '../components/EditEventSheet'
import EditCatalogEventSheet from '../components/EditCatalogEventSheet'
import PersonalPlanSheet from '../components/PersonalPlanSheet'
import AttendeesRow from '../components/AttendeesRow'
import EventDetail, { EventDetailDrawer } from '../components/EventDetail'
import InvitePeopleSheet from '../components/InvitePeopleSheet'
import CoHostsSheet from '../components/CoHostsSheet'
import EventsMap from '../components/EventsMap'
import { shareLink, appLink, shortEventLink } from '../lib/share'
import { VENUE_CATEGORIES, SOURCE_CONFIG } from '../data/eventSources'

// VENUE_CATEGORIES + SOURCE_CONFIG moved to data/eventSources.js so
// EventDetail can import them without a cycle back through this file.

// Records a filter change, skipping the first render (which is the
// default, not a choice). The header carries three rows of filters and
// nothing measured whether they earn the space — /analytics/funnel counts
// by event name, so each control gets its own name.
function useFilterUsage(eventName, value) {
  const settled = useRef(false)
  useEffect(() => {
    if (!settled.current) { settled.current = true; return }
    trackEvent(eventName, { value: String(value) })
  }, [eventName, value])
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
      background: 'var(--white)', borderRadius: 16, margin: '0 16px 9px',
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
      background: 'var(--white)', borderRadius: 16, margin: '0 16px 8px',
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

  // Which of these filters people actually touch.
  useFilterUsage('events_filter_category', activeFilter)
  useFilterUsage('events_filter_kids', kidsFilter)
  useFilterUsage('events_filter_oneoff', oneOffOnly)
  useFilterUsage('events_filter_date', dateRange)
  useFilterUsage('events_view_mode', viewMode)
  // Filters collapsed by default. Three stacked rows of pills (category,
  // price/kids, date) ate the top third of the phone before a single
  // event showed — and in Mapa mode they pushed the map's own controls
  // below the fold. The bar below says how many are on, so a collapsed
  // filter is never a hidden one.
  const [filtersOpen, setFiltersOpen] = useState(false)
  // Legacy digest filter: ?digest=<id> / ?new=<id,id,...>. The digest now
  // has its own screen (screens/Novidades.jsx), but production pushes keep
  // sending the query-param form until DIGEST_URL_NOVIDADES flips, and old
  // installed bundles have no /novidades route at all — so this path stays
  // until those links have aged out (digests prune after 30 days).
  const [digestIds, setDigestIds] = useState(null) // null | string[]
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
  // Catalog correction is a separate sheet with a separate permission:
  // curators fix the shared catalog, creators edit their own fork.
  const [editCatalogEvent, setEditCatalogEvent] = useState(null)
  const [isCurator, setIsCurator] = useState(false)
  const [isFounder, setIsFounder] = useState(false)
  // Which public channel picked which catalog event, {catalogId: [name]}.
  // A catalog event added to a public channel is a separate row (a fork
  // carrying source_event_id), so this is a lookup, not a list to
  // render: the catalog row stays the one that shows, carrying the
  // channel's name. Showing the fork as well is how the same night used
  // to appear twice with nothing connecting them.
  //
  // Every public channel, not the ones you follow: this used to be read
  // off /channels/feed, which is capped at 40 and knows only followed
  // channels, so once the rule fill put ~150 nights into channels most
  // rows lost their mark and a new channel marked nothing.
  const [channelPicks, setChannelPicks] = useState({})

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

  useEffect(() => {
    let cancelled = false
    fetchChannelPicks().then(picks => {
      if (!cancelled) setChannelPicks(picks || {})
    })
    return () => { cancelled = true }
  }, [])

  // Keyed by the catalog id the channel's copy points at. A list per
  // key, not one name: two channels can pick the same night, and
  // keeping only the last one would quietly drop the other.
  const publicChannelsBySourceId = useMemo(
    () => new Map(Object.entries(channelPicks)),
    [channelPicks],
  )

  // Curator status gates the "corrigir evento" affordance on catalog
  // events. Curator, not founder: the people who notice a wrong venue
  // are the ones already curating handles, and every correction is
  // pinned and reversible. Same endpoint BottomNav uses for its founder
  // check — it returns both flags.
  useEffect(() => {
    const email = state.googleUser?.email
    if (!email) { setIsCurator(false); return }
    let cancelled = false
    fetch(`${BASE_URL}/admin/curators?requesting_email=${encodeURIComponent(email)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return
        setIsCurator(!!(d?.is_curator || d?.is_founder))
        setIsFounder(!!d?.is_founder)
      })
      .catch(() => { if (!cancelled) { setIsCurator(false); setIsFounder(false) } })
    return () => { cancelled = true }
  }, [state.googleUser?.email])

  // Who runs a private event: its creator or a co-host. This role set
  // deletes, invites and names co-hosts.
  const hostsEvent = (ev) => !!(
    ev?.isGroupEvent && state.googleUser?.id && (
      ev.createdBy === state.googleUser.id ||
      (ev.coHostIds || []).includes(state.googleUser.id)
    )
  )
  // Who may change its content and cover: the hosts, plus the founder
  // on any private event they can see — the drawer only ever holds
  // those. The founder is who a wrong time or a missing flyer gets
  // reported to; this is the fix without asking for co-host powers.
  // Same rule as the backend's _can_edit_group_event.
  const editsEvent = (ev) => hostsEvent(ev) || !!(isFounder && ev?.isGroupEvent && state.googleUser?.id)

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
    const queryNew = params.get('new')        // legacy: inline ?new=id1,id2,...
    const queryDigest = params.get('digest')  // current: ?digest=<digest_id>
    const openId = stateId || queryId

    // Digest push tap on an older bundle lands here with ?digest=<id>.
    // Fetch the persisted event_ids list from the backend (kept off the
    // push payload to avoid the APNs / web push size limits that forced
    // the old ?new=id,id,... approach to cap at 12).
    if (queryDigest) {
      fetch(`${BASE_URL}/digests/${encodeURIComponent(queryDigest)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (d?.event_ids?.length) setDigestIds(d.event_ids)
        })
        .catch(() => {})
    } else if (queryNew) {
      // Backward compat: older builds sent inline ids in the URL.
      const ids = queryNew.split(',').map(s => s.trim()).filter(Boolean)
      if (ids.length > 0) setDigestIds(ids)
    }

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
    } else if (queryNew || queryDigest) {
      // Strip the digest params once consumed — keeps the URL clean
      // for navigation back/forward. digestIds state drives the filter
      // from here on.
      navigate('/events', { replace: true })
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
    const { event, forbidden, networkError, message, eventName, canRequest, requestStatus } =
      await fetchEventDetail(eventId, state.googleUser?.id || '')
    if (forbidden) {
      // Backend returned 403 (private plan / private group event). Render
      // a friendly 'this is private' panel instead of the silent-empty
      // state that masquerades as "link is broken". canRequest +
      // requestStatus drive the "Pedir convite" affordance.
      setDetailEvent({
        _forbidden: true, _message: message, id: eventId,
        _eventName: eventName, _canRequest: canRequest, _requestStatus: requestStatus,
      })
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

  // Esc-to-close lives in EventDetailDrawer now — shared with ChannelDetail.

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
  // Tiered sort: paid placements first, then the user's own commitments
  // (group invites + accepted public events), then everything else. The
  // user's complaint was that opening Eventos buried their plans below
  // 30 unrelated catalog rows; tier ranking surfaces "what you signed up
  // for" before "what's happening".
  //
  //   0 — featured (paid Seleção auê)
  //   1 — group events / personal plans (pending or accepted)
  //   2 — public catalog events the user RSVP'd to
  //   3 — everything else
  //
  // Within a tier, sort chronologically. Same-day group-vs-public
  // tie-break stays so a sibling group plan still beats a public event
  // on the same day if both end up in the same tier (won't normally,
  // but defensive against future tier-merging changes).
  function eventTier(ev) {
    if (ev.featured) return 0
    if (ev.isGroupEvent) return 1
    if (state.rsvps?.[ev.id]) return 2
    return 3
  }
  // Sort key has to match what the card *visually shows* in its date
  // column, otherwise the list reads as out-of-order. The card uses
  // displayDate=today for any recurring/multi-day event that covers
  // today (see displayDate logic on the EventCard render below); the
  // sort key has to follow the same rule. Without this alignment a
  // "Tributo Bowie SEX" recurring event with dateStart pinned to the
  // next Friday would render as "DOM 03" today but sort by Friday,
  // landing in the middle of the Friday block.
  const sortFloor = getAnchorToday().getTime()
  const todayIsoForSort = getAnchorTodayIso()

  // Which day of a run the reader is looking at.
  //
  // A residency or a week-long programação is ONE row in the catalog,
  // shown on each day it covers — the card's date column is an override,
  // not a different event. So "the 18th" and "the 14th" are the same
  // row, and anything that acts on what the reader sees has to be told
  // which day that was. Returns null for a one-off, whose own dateStart
  // is already the answer.
  const occurrenceDayFor = (ev) => {
    if (!ev) return null
    const isMultiDay = !!(
      ev.dateEnd && ev.dateStart
      && ev.dateEnd.slice(0, 10) > ev.dateStart.slice(0, 10)
    )
    if (!ev.isRecurring && !isMultiDay) return null
    if (selectedDay) return selectedDay
    const todayIso = getAnchorTodayIso()
    return eventCoversDay(ev, todayIso) ? todayIso : null
  }
  function effectiveStartTs(ev) {
    const raw = ev.dateStart ? Date.parse(ev.dateStart) : NaN
    if (Number.isNaN(raw)) return Number.MAX_SAFE_INTEGER
    const isMultiDay = !!(ev.dateEnd && ev.dateStart && ev.dateEnd.slice(0, 10) > ev.dateStart.slice(0, 10))
    if ((ev.isRecurring || isMultiDay) && eventCoversDay(ev, todayIsoForSort)) {
      // Sort with today's bucket, with a small offset so the
      // ordering inside the bucket is still stable (preserve relative
      // ordering of multiple recurring events covering today).
      return sortFloor + (raw % 86_400_000)
    }
    return Math.max(raw, sortFloor)
  }
  const allDisplayEvents = [...(state.customEvents || []), ...groupEvents, ...events].sort((a, b) => {
    const ta_tier = eventTier(a)
    const tb_tier = eventTier(b)
    if (ta_tier !== tb_tier) return ta_tier - tb_tier

    const ta = effectiveStartTs(a)
    const tb = effectiveStartTs(b)
    if (ta !== tb) return ta - tb

    // Same effective day: keep group events ahead of catalog ones —
    // matches the displayDate-aware grouping by re-checking the card's
    // visible day column (today for covering events, dateStart else).
    if (a.isGroupEvent && !b.isGroupEvent) return -1
    if (!a.isGroupEvent && b.isGroupEvent) return 1
    return 0
  })

  // Apply search + source-category + date/venue filter
  let filteredEvents = allDisplayEvents
  // Digest filter — when the user taps a daily-digest push, narrow
  // down to ONLY the events from that scrape. Other filters still
  // compose on top (so the user can search/category-filter within
  // the digest set). Limpar in the banner clears digestIds.
  if (digestIds && digestIds.length > 0) {
    const digestSet = new Set(digestIds)
    filteredEvents = filteredEvents.filter(ev => digestSet.has(ev.id))
  }
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
  // The "Grátis" filter is gone with the label: it selected on the same
  // price_tier flag, so it promised a list of free events and delivered
  // a list of events whose caption happened not to mention money.
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
  // Accounts the user stopped following in Fontes. Counted after the
  // other filters so the banner below says how many events *this view*
  // is hiding — an emptier feed should never be a mystery.
  const hiddenSources = unfollowedSet(state)
  const beforeFollowFilter = filteredEvents.length
  filteredEvents = filteredEvents.filter(ev => !hiddenByFollows(ev, hiddenSources))
  const hiddenByFollowCount = beforeFollowFilter - filteredEvents.length
  // One night, one row.
  //
  // A private channel's event and the catalog event it was forked from
  // are the same post arriving by two paths — /events/group for the
  // fork, /events for the original — so an event in one private channel
  // and one public channel showed up twice. The fork wins: it already
  // merges the catalog's facts (name, time, cover — see
  // _merge_source_event) and adds the private layer on top, so dropping
  // the original loses nothing and dropping the fork would lose the
  // invitees, the note and the co-hosts.
  //
  // Computed from the ALREADY-FILTERED list, not from groupEvents. A
  // category filter drops private rows, and a set built upstream would
  // still hold their source ids — taking the catalog original down with
  // rows that are no longer there, and making the event vanish entirely.
  // Every private channel a night reached the viewer through, keyed by
  // the catalog event its forks point at. Built before the collapse
  // below, which keeps one fork and discards its siblings.
  const forkNamesBySource = useMemo(() => {
    const map = new Map()
    for (const ev of groupEvents) {
      if (!ev.sourceEventId) continue
      const names = ev.groupNames?.length
        ? ev.groupNames
        : (ev.groupName ? [ev.groupName] : [])
      if (!names.length) continue
      const list = map.get(ev.sourceEventId) || []
      for (const n of names) if (!list.includes(n)) list.push(n)
      map.set(ev.sourceEventId, list)
    }
    return map
  }, [groupEvents])

  const dropMirroredOriginals = (list) => {
    const mirrored = new Set(
      list.filter(e => e.isGroupEvent && e.sourceEventId).map(e => e.sourceEventId)
    )
    // ...and collapse forks of the SAME catalog event down to one.
    //
    // Adding a night to three channels writes three group_events rows —
    // the per-group dedupe only stops a second copy in the SAME channel.
    // So the same night rendered three identical cards. One row stands
    // for all of them; channelSourcesFor already names every channel a
    // row came from, so nothing is lost by dropping the rest.
    const seenFork = new Set()
    const out = []
    for (const ev of list) {
      if (!ev.isGroupEvent && mirrored.has(ev.id)) continue
      if (ev.isGroupEvent && ev.sourceEventId) {
        if (seenFork.has(ev.sourceEventId)) continue
        seenFork.add(ev.sourceEventId)
      }
      out.push(ev)
    }
    return out
  }

  // Snapshot for the week strip's count badges — reflects every active
  // filter *except* the per-day pick, so picking a day doesn't zero out
  // the other days' counts.
  const eventsForStrip = dropMirroredOriginals(filteredEvents)
  if (!isVenueMode && selectedDay) {
    // Range events ("terça a domingo", multi-day exhibitions) cover every
    // day between dateStart and dateEnd inclusive — they should show up
    // when ANY of those days is selected, not just the start day. One-offs
    // (no dateEnd) keep the simple equality check.
    filteredEvents = filteredEvents.filter(ev => eventCoversDay(ev, selectedDay))
  }

  // Which channel of yours an event came from — one answer for both
  // kinds. A private channel's event IS the row (it arrives through
  // /events/group carrying its channel's name). A public channel's is
  // a fork of a catalog event, so the catalog row is the real one and
  // channelBySourceId says which channel picked it.
  //
  // Both render identically. The difference between a channel run by
  // auê and one run by a friend is who may post in it, and that is not
  // something the reader of a list needs to be told twice.
  // Where a row came from: a name AND which kind of channel it is, so
  // the card can colour each name for itself. Kind is derived, not
  // stored: /events/group excludes public-channel events, so anything
  // arriving as isGroupEvent is private by construction, and anything
  // in publicChannelsBySourceId came from /channels/picks, which only
  // lists public channels.
  const channelSourcesFor = (ev) => {
    // A personal plan carries isGroupEvent too (it reuses the private
    // styling) but belongs to no channel. It still isn't part of the
    // city catalog, so it stays in the first section rather than being
    // buried under Explorar — labelled for what it is, and counted as
    // private: nothing is more yours than a plan you made.
    // "Plano" only when there is genuinely no channel behind it.
    //
    // isPersonalPlan is computed from the VIEWER's membership — it means
    // "you are not in any group this event is tagged with", which is the
    // right rule for hiding a private channel's name from an outsider
    // and the wrong one for calling something your plan. An event you
    // were invited to, from a channel you're not in, is not a plan you
    // made. Where the backend won't name the channel, the honest label
    // is no label at all.
    const hasChannel = !!(ev.groupId || (ev.groupIds || []).length
                          || (ev.groupNames || []).length)
    if (ev.isPersonalPlan) {
      return hasChannel ? [] : [{ name: 'Plano', kind: 'private' }]
    }
    const out = []
    const add = (name, kind) => {
      if (name && !out.some(o => o.name === name)) out.push({ name, kind })
    }
    if (ev.isGroupEvent) {
      const own = ev.groupNames?.length
        ? ev.groupNames
        : (ev.groupName ? [ev.groupName] : [])
      own.forEach(n => add(n, 'private'))
      // Names from the sibling forks this row now stands for. Collapsing
      // three rows into one without this would silently drop two of the
      // three channels the night actually came from.
      ;(forkNamesBySource.get(ev.sourceEventId) || []).forEach(n => add(n, 'private'))
      // The same post can sit in a private channel AND a public one.
      // The private row is the one that survives the dedupe below, so
      // it has to carry the public channel's name too — otherwise the
      // name disappears along with the row it was attached to.
      ;(publicChannelsBySourceId.get(ev.sourceEventId) || []).forEach(n => add(n, 'aue'))
    } else {
      ;(publicChannelsBySourceId.get(ev.id) || []).forEach(n => add(n, 'aue'))
    }
    return out
  }


  // Two sections instead of a band. The band was horizontal so its
  // length cost no vertical space, but it also made a channel's event
  // look like a different species from the same event in the list
  // below — two shapes, two colours, for one thing. Sections keep the
  // prominence and drop the second shape: the same row either way,
  // named on the right.
  filteredEvents = dropMirroredOriginals(filteredEvents)
  const myChannelEvents = filteredEvents.filter(ev => channelSourcesFor(ev).length > 0)
  const exploreEvents = filteredEvents.filter(ev => channelSourcesFor(ev).length === 0)

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
      // Post-event "quem foi com você" nudge removed: it pinged people
      // 3h after event start (often during the event itself, or right at
      // the wind-down) without enough signal to justify the interruption.
    } else if (wasRsvped) {
      cancelEventReminder(ev.id)
    }
  }

  // One row renderer for both sections. The channel section and
  // the catalog section render the SAME card — that is the point of
  // splitting them by heading instead of by component.
  const renderEventNode = (ev) => {
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
                    // Which channels brought it — public or private,
                    // same slot, same styling. The section above says
                    // these are yours; this says which of yours.
                    fromChannels={channelSourcesFor(ev)}
                    rsvped={rsvped}
                    friendsGoing={friendsByEventId[ev.id] || []}
                    personalChip={getPersonalChip(ev, state.rsvps)}
                    onOpen={() => openDetail(ev.id)}
                    onFriend={(gid) => navigate(`/friends/${encodeURIComponent(gid)}`)}
                    onSourceTap={(sid) => navigate(`/sources/${encodeURIComponent(sid)}`)}
                    onOpenGroup={(gid) => navigate(`/channels/${encodeURIComponent(gid)}`)}
                    // Day shown on the card's date column:
                    //   - When a specific strip day is picked: show that day.
                    //   - Otherwise: for multi-day or recurring events that
                    //     cover today, show TODAY (so a programação Maio
                    //     2026 reads as "happening today" instead of "May 2,
                    //     past"). One-off events fall through and keep their
                    //     own dateStart.
                    displayDate={occurrenceDayFor(ev)}
                    t={t}
                  />
                </motion.div>
              )
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
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              onClick={() => navigate('/sources')}
              title="Fontes monitoradas"
              className="neon-mono"
              style={{
                height: 36, padding: '0 12px',
                borderRadius: 999,
                background: 'transparent', border: '1px solid var(--line)',
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
                cursor: 'pointer', color: 'var(--text2)',
              }}
            >
              <span style={{ fontSize: 14 }}>📡</span>
              <span>Fontes</span>
            </button>
            {/* No "+" here on purpose. Every event someone creates is one
                they want to invite people to, so creation lives where the
                invitees are: the Home "Criar um evento com amigos" banner
                and inside a group. Both use PersonalPlanSheet, which can
                pre-fill from an Instagram link. */}
            <button
              onClick={() => setSearchOpen(o => !o)}
              style={{
                width: 36, height: 36, borderRadius: 12,
                background: searchOpen ? 'var(--magenta)' : 'transparent',
                border: searchOpen ? 'none' : '1px solid var(--line)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 15, cursor: 'pointer', transition: 'all 0.15s',
                color: searchOpen ? 'var(--bg)' : 'var(--text2)',
                boxShadow: searchOpen ? '0 0 12px rgba(255, 43, 214, 0.4)' : 'none',
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
                  background: 'var(--white)', borderRadius: 12,
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

        {/* Digest filter banner — shows when the user landed here via a
            daily-digest push tap. Lime accent + "Limpar" link returns
            them to the full catalog. Sits inside the sticky header so
            it scrolls with the title chrome and stays visible while
            the user reviews the filtered list. */}
        {digestIds && digestIds.length > 0 && (
          <div style={{
            margin: '0 16px 8px',
            padding: '10px 12px',
            background: 'rgba(198, 255, 0, 0.06)',
            border: '1px solid rgba(198, 255, 0, 0.35)',
            borderRadius: 12,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{
              fontSize: 14, lineHeight: 1, flexShrink: 0,
              color: 'var(--lime)',
              filter: 'drop-shadow(0 0 4px rgba(198, 255, 0, 0.5))',
            }}>✨</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="neon-mono" style={{
                fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
                color: 'var(--lime)',
              }}>
                {digestIds.length} novidade{digestIds.length === 1 ? '' : 's'} de hoje
              </div>
              <div style={{
                fontSize: 11, color: 'var(--text2)', marginTop: 2, lineHeight: 1.4,
              }}>
                Os rolês que apareceram no scrape de hoje. Toque 🔍 acima
                pra buscar dentro da lista.
              </div>
            </div>
            <button
              onClick={() => setDigestIds(null)}
              className="neon-mono"
              style={{
                flexShrink: 0,
                padding: '6px 10px', borderRadius: 8,
                background: 'transparent', border: '1px solid var(--line)',
                color: 'var(--text2)',
                fontSize: 10, letterSpacing: '0.18em',
                textTransform: 'uppercase', cursor: 'pointer',
              }}
            >
              Limpar
            </button>
          </div>
        )}

        {/* Category chips — counts are computed from the FULL union
            (catalog + custom + group), independent of the active
            filter, so 'Tudo · N' doesn't shrink the moment the user
            picks a category and stops showing custom/group events.
            'Canal' is a synthetic bucket for private/group/personal
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
            ...(groupCount > 0 ? [{ id: 'group', emoji: '🎲', label: 'Canal', count: groupCount }] : []),
            ...orderedCats.map(c => ({
              id: c,
              emoji: CATEGORY_META[c]?.emoji || '🔗',
              label: CATEGORY_META[c]?.label || c,
              count: eventCounts[c] || 0,
            })),
          ]
          // Default-collapsed cap: 5 category chips + the "Ver mais"
          // overflow button = 6 total elements, which lays out as ~2
          // rows on a 360-380px viewport (the typical small Android,
          // ~3 chips/row given the chip widths). Always include the
          // active chip in the visible set even when it would otherwise
          // be in the overflow tail — otherwise picking "Cinema · 1"
          // and then collapsing would hide what the user just selected.
          const COLLAPSED_CAP = 5
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
                      background: active ? 'var(--magenta)' : 'transparent',
                      color: active ? '#14081E' : 'var(--text2)',
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
                    color: active ? '#14081E' : 'var(--text2)',
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
                color: venueSubFilter === sub.id ? '#14081E' : 'var(--text2)',
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

      {/* ── Filters, collapsed ── */}
      {(() => {
        const activeCount =
          (oneOffOnly ? 1 : 0) +
          (kidsFilter ? 1 : 0) +
          (dateRange !== 'all' ? 1 : 0)
        return (
          <div style={{ display: 'flex', gap: 6, padding: '0 16px 8px', alignItems: 'center' }}>
            <button
              onClick={() => setFiltersOpen(o => !o)}
              className="neon-mono"
              style={{
                padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
                fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase',
                cursor: 'pointer',
                border: `1px solid ${activeCount ? 'var(--magenta)' : 'var(--border)'}`,
                background: activeCount ? 'var(--terra-pale)' : 'transparent',
                color: activeCount ? 'var(--magenta)' : 'var(--charcoal-mid)',
              }}
            >
              {filtersOpen ? '− Filtros' : '+ Filtros'}{activeCount ? ` · ${activeCount}` : ''}
            </button>
            {activeCount > 0 && (
              <button
                onClick={() => {
                  setOneOffOnly(false)
                  setKidsFilter(false); setDateRange('all')
                }}
                style={{
                  padding: '5px 10px', borderRadius: 16, whiteSpace: 'nowrap',
                  fontSize: 11, cursor: 'pointer', background: 'transparent',
                  border: '1px solid var(--border)', color: 'var(--charcoal-light)',
                }}
              >
                Limpar
              </button>
            )}
          </div>
        )
      })()}

      {filtersOpen && (<>
      {/* ── Filter chips: Todos + Só únicos + price + kids ──
          Order: "Todos" leads as the reset-everything pill (clears
          both price AND the oneOffOnly toggle so a single tap returns
          the full catalog). "⚡ Só únicos" sits second as a sub-mode. */}
      <div style={{ display: 'flex', gap: 6, padding: '0 16px 8px', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {/* "Todos" — clears every filter in this row in one tap. Active
            state requires them all at default for the visual to read as
            "no filtering active". */}
        {(() => {
          const isAllActive = !oneOffOnly && !kidsFilter
          return (
            <button
              onClick={() => { setOneOffOnly(false); setKidsFilter(false) }}
              style={{
                padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
                fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
                transition: 'all 0.15s',
                border: isAllActive ? 'none' : '1px solid var(--border)',
                background: isAllActive ? 'var(--sage)' : 'transparent',
                color: isAllActive ? '#14081E' : 'var(--text2)',
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
            color: oneOffOnly ? '#FFFFFF' : 'var(--text2)',
          }}
        >
          ⚡ Só únicos
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
            color: kidsFilter ? '#14081E' : 'var(--text2)',
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
                  color: active ? '#14081E' : 'var(--text2)',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}

      {/* "Criar um evento com amigos" CTA was here as a wide row that
          felt orphaned between the filter chips and the event list.
          Moved into the Events header (lime 🎲 icon-pill next to
          Fontes/🔍) so it's always reachable from the chrome without
          stealing list real estate. */}

      </>)}

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

      {/* Events hidden because the user unfollowed their account. */}
      {!loading && viewMode === 'list' && hiddenByFollowCount > 0 && (
        <div style={{
          margin: '0 16px 10px', padding: '9px 12px', borderRadius: 12,
          border: '1px dashed var(--line)', color: 'var(--text2)', fontSize: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        }}>
          <span>
            {hiddenByFollowCount} evento{hiddenByFollowCount === 1 ? '' : 's'} escondido{hiddenByFollowCount === 1 ? '' : 's'} de
            {' '}contas que você não segue
          </span>
          <button
            onClick={() => navigate('/sources')}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--cyan)', fontSize: 12, fontWeight: 700, flexShrink: 0,
            }}
          >
            Gerenciar
          </button>
        </div>
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
            <>
              {myChannelEvents.length > 0 && (
                <>
                  <ListSectionHeading
                    label="Dos teus canais"
                    count={myChannelEvents.length}
                    // Takes the strongest colour in the section, so the
                    // heading and the rows under it agree. A section of
                    // auê rows headed in private cyan would promise a
                    // closeness none of them have.
                    accent={
                      myChannelEvents.some(e => channelSourcesFor(e)
                        .some(c => c.kind === 'private'))
                        ? 'var(--from-private)'
                        : 'var(--from-aue)'
                    }
                  />
                  {myChannelEvents.map(renderEventNode)}
                  <ListSectionHeading
                    label="Explorar"
                    count={exploreEvents.length}
                    accent="var(--from-catalog)"
                  />
                </>
              )}
              {exploreEvents.map(renderEventNode)}
            </>
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
              background: 'var(--charcoal)', color: 'var(--on-light)',
              borderRadius: 14, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            }}
          >
            <span style={{ fontSize: 18 }}>🔔</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>✓ Confirmado</div>
              <div style={{ fontSize: 11, color: 'rgba(10, 5, 16, 0.65)', marginTop: 1 }}>{notifToast}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Shared drawer shell — portal, overlay and the sticky nav strip
          all live in components/EventDetail.jsx so ChannelDetail renders
          the identical chrome instead of a second copy. */}
      <EventDetailDrawer
        open={!!selectedEventId}
        onClose={closeDetail}
        idLabel={detailEvent ? String(detailEvent.id || '').slice(-4).toUpperCase() : ''}
      >
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
                  {detailEvent._eventName ? (
                    <>"{detailEvent._eventName}" — só convidados podem ver os detalhes.</>
                  ) : (detailEvent._message || 'Só convidados podem ver os detalhes desse evento.')}
                </div>
                <RequestInviteButton
                  eventId={detailEvent.id}
                  googleId={state.googleUser?.id}
                  canRequest={detailEvent._canRequest}
                  initialStatus={detailEvent._requestStatus}
                />
                <button
                  onClick={closeDetail}
                  style={{
                    padding: '10px 22px', borderRadius: 12, border: 'none',
                    background: 'var(--sage)', color: '#14081E',
                    fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    marginTop: 12,
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
                      background: 'var(--white)', color: 'var(--charcoal)',
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
                    background: 'var(--sage)', color: '#14081E',
                    fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Voltar
                </button>
              </div>
            ) : (
              <EventDetail
                event={detailEvent}
                // Same source of truth the card uses, so the row and
                // the panel can't disagree about where a night came
                // from — the panel has no way to work out the public
                // half on its own.
                fromChannels={channelSourcesFor(detailEvent)}
                googleId={state.googleUser?.id || ''}
                viewerName={state.googleUser?.given_name || state.googleUser?.name || 'Você'}
                viewerPicture={myPicture(state)}
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
                  // Two different edits behind one slot. A host (or the
                  // founder) edits a private event; a curator corrects
                  // the shared catalog row everyone sees. An event is
                  // only ever one of the two.
                  editsEvent(detailEvent)
                    ? () => setEditEvent(detailEvent)
                    : (isCurator && !detailEvent.isGroupEvent)
                      ? () => setEditCatalogEvent(detailEvent)
                      : null
                }
                editLabel={
                  (isCurator && !detailEvent.isGroupEvent)
                    ? '🛠 Corrigir evento (curadoria)'
                    : undefined
                }
                onDelete={
                  // Delete affordance for any user-created event the
                  // viewer is creator or co-host of — covers personal
                  // plans AND group events. Routes to the right backend
                  // endpoint based on whether the event is tagged to a
                  // group. Group admins still have the full Excluir flow
                  // inside a channel; this button is the catalog-side
                  // shortcut for the same action.
                  hostsEvent(detailEvent)
                    ? async () => {
                        if (!confirm(`Apagar o plano "${detailEvent.name}"? Os convidados também perdem acesso.`)) return
                        try {
                          if (detailEvent.groupId) {
                            await deleteGroupEvent(detailEvent.groupId, detailEvent.id, state.googleUser.id)
                          } else {
                            await deletePersonalPlan(detailEvent.id, state.googleUser.id)
                          }
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
                  hostsEvent(detailEvent)
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
                  // Image management = same role set as the edit sheet.
                  // Catalog events are not editable.
                  editsEvent(detailEvent)
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
                onDeclined={() => {
                  // Refetch: a personal invite drops out of the feed, a
                  // group's event comes back marked declined.
                  const gid = state.googleUser?.id
                  if (gid) fetchUserGroupEvents(gid).then(events => setGroupEvents(events || []))
                }}
                userNeighborhood={state.neighborhood}
                t={t}
              />
            )}
      </EventDetailDrawer>

      <AddToGroupSheet
        open={!!addToGroupEvent}
        onClose={() => setAddToGroupEvent(null)}
        event={addToGroupEvent}
        // The day the reader was on, not the row's dateStart. Adding
        // "Semana do Consumidor" from its 18th to a channel used to
        // fork it on the 14th — the day the run started — so it landed
        // in the channel already over.
        occurrenceDay={occurrenceDayFor(addToGroupEvent)}
      />

      {/* Curator correction of a catalog event. Separate sheet from
          EditEventSheet above: different endpoint, different permission,
          and the fields differ (no invitee note, but category and genre). */}
      <EditCatalogEventSheet
        open={!!editCatalogEvent}
        onClose={() => setEditCatalogEvent(null)}
        event={editCatalogEvent}
        requestingEmail={state.googleUser?.email}
        onSaved={(updated) => {
          // The backend returns the same shape the catalog serves, so
          // mirror it into the open detail panel and the loaded list
          // instead of refetching the whole catalog for one row.
          setDetailEvent(prev => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev))
          setEvents(prev => (prev || []).map(e => (e.id === updated.id ? { ...e, ...updated } : e)))
        }}
      />

      <EditEventSheet
        open={!!editEvent}
        onClose={() => setEditEvent(null)}
        event={editEvent}
        googleId={state.googleUser?.id}
        onSaved={(updatedRow, view) => {
          // Backend returns the raw DB row (snake_case) and, since the
          // Instagram link came to the sheet, the same shape GET
          // /events/{id} serves: url, cover and the description with
          // the link already stripped. Mirror that into the live detail
          // panel so the "Ver no Instagram" button and the flyer show
          // without a full refetch; the row is the fallback for older
          // responses.
          setDetailEvent(prev => prev && prev.id === updatedRow.id ? {
            ...prev,
            name: updatedRow.name,
            venue: updatedRow.venue,
            dateStart: updatedRow.date_start,
            description: updatedRow.description,
            note: updatedRow.note,
            ...(view ? {
              description: view.description,
              date: view.date, time: view.time,
              url: view.url,
              imageUrl: view.imageUrl,
              sourceIgHandle: view.sourceIgHandle,
            } : {}),
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

// SourceBadge — shared between EventCard and EventDetail. For Instagram
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
// all live in EventDetail (components/EventDetail.jsx) one tap deeper.

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

// A heading inside the list, not a band above it.
//
// Not sticky: the screen already has a sticky header at top:0, and a
// second sticky element would scroll up and park underneath it —
// present in the DOM, invisible on screen.
function ListSectionHeading({ label, count, accent }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 8,
      padding: '14px 16px 8px',
    }}>
      <h2 className="neon-mono" style={{
        fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
        color: accent, margin: 0,
      }}>
        {label}
      </h2>
      <span style={{ fontSize: 10, color: 'var(--text3)' }}>{count}</span>
    </div>
  )
}

function EventCard({ ev, rsvped, friendsGoing = [], personalChip = null, onOpen, onFriend, onSourceTap, onOpenGroup, displayDate = null, fromChannels = [], t }) {
  // Flyer treatment — staging experiment, see lib/cardVariant.js.
  const cardVariant = eventCardVariant()
  const [imgBroken, setImgBroken] = useState(false)
  const hasImage = !!ev.imageUrl && !imgBroken
  const showThumb = hasImage && cardVariant === 'thumb'
  const showCover = hasImage && cardVariant === 'cover'
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
  // The dominant kind decides the row's one accent: an event in a
  // private channel AND an auê one is still, first, something people
  // you know are going to. Each name below keeps its own colour, so
  // the second source is named without being hidden.
  const fromKind = fromChannels.some(c => c.kind === 'private') ? 'private'
                 : fromChannels.length > 0 ? 'aue'
                 : null

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
        background: 'var(--white)',
        margin: '0 16px 6px', padding: '12px 14px',
        borderRadius: 12,
        border: ev.featured ? '1.5px solid var(--honey)' : '1px solid var(--border)',
        // Lime for anything highlighted FOR you — your own plans, and
        // now the catalog rows that came from a channel you follow.
        // The channel's own identity stays magenta (the badge, the
        // channel screen); lime is "this one is picked out for you",
        // which is what it already means on free/going/confirmados.
        // Provenance stripe. Width and glow carry the ranking that the
        // hue alone can't: private announces itself, auê is present,
        // the catalog is just marked. An ongoing event keeps its "no
        // stripe" tell, which is what separates it from a one-off.
        boxShadow: fromKind === 'private'
                    ? 'inset 4px 0 0 var(--from-private), -1px 0 14px -6px var(--from-private-glow)'
                  : fromKind === 'aue'
                    ? 'inset 3px 0 0 var(--from-aue), -1px 0 12px -7px var(--from-aue-glow)'
                  : isOngoing ? 'none'
                  : 'inset 3px 0 0 var(--from-catalog)',
        display: 'flex', alignItems: 'stretch', gap: 14,
        // The cover variant needs the image on its own line above the
        // row; wrapping + flex-basis 100% does that without restructuring
        // the card into a column and re-indenting everything below.
        flexWrap: showCover ? 'wrap' : 'nowrap',
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      {showCover && (
        <img
          src={ev.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImgBroken(true)}
          style={{
            // Negative margins cancel the card's padding so the flyer
            // goes edge to edge and the top corners match the card.
            flexBasis: '100%', width: 'calc(100% + 28px)',
            margin: '-12px -14px 10px', height: 150,
            objectFit: 'cover', display: 'block',
            borderRadius: '11px 11px 0 0', background: 'var(--bg2)',
          }}
        />
      )}

      {/* LEFT — day + flyer as ONE unit: "which event is this", before
          the text answers "what is it". They sit on a tighter gap than
          the card's own, so proximity groups them; with everything on
          the same 14px the card read as three loose columns and nothing
          belonged to anything. Both centre on the same line, which is
          the other half of the fix — a top-aligned date next to a
          centred photo looks crooked the moment a title wraps to two
          lines. */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
      }}>
        {/* Fixed width so rows without a flyer still start their text on
            a consistent x, and a single-digit day doesn't shift the row
            left. 36px is that width with no slack to spare: the widest
            thing in here is a two-digit day at 35.2px (the weekday is
            27px), measured, not eyeballed. */}
        <div style={{ width: 36, textAlign: 'left' }}>
          <div style={{
            fontSize: 26, fontWeight: 800, lineHeight: 1,
            // Day color matches the stripe — sage for group, purple for
            // one-off (mirrors the "Só únicos" filter chip), terra-light
            // blue for ongoing.
            // Same scale as the stripe. Ongoing events used to take
            // --terra-light, a magenta tint, which now reads as "from
            // an auê channel" — so they join the catalog colour and
            // keep the missing stripe as their only tell.
            color: fromKind === 'private' ? 'var(--from-private)'
                 : fromKind === 'aue' ? 'var(--from-aue)'
                 : 'var(--from-catalog)',
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

        {showThumb && (
          <img
            src={ev.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImgBroken(true)}
            style={{
              flexShrink: 0, width: 56, height: 56,
              objectFit: 'cover', borderRadius: 10,
              background: 'var(--bg2)', display: 'block',
            }}
          />
        )}
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

        {/* Single metadata row: time · 📍 venue · bairro. Truncates
            with ellipsis on narrow screens. Pin glyph on the venue half
            makes the location obvious at glance — without it the venue
            blended into the surrounding time + bairro text and felt
            buried. Kept on one line for compact density. */}
        <div style={{
          fontSize: 11,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {time && (
            <span style={{ color: 'var(--text2)' }}>{time}</span>
          )}
          {time && venueLine && (
            <span style={{ color: 'var(--text3)' }}> · </span>
          )}
          {venueLine && (
            <>
              <span style={{ color: 'var(--cyan)' }}>📍 </span>
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                {venueLine}
              </span>
            </>
          )}
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

      {/* RIGHT — which channel this came from, then Destaque / RSVP.
          The channel name sits here rather than under the title so the
          left-to-right read stays "when · what · where", with "who
          brought it to you" as the trailing answer. Capped so a long
          channel name can't squeeze the title: it truncates, and the
          section heading above already says these are yours. */}
      <div style={{
        flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'flex-end', justifyContent: 'flex-start',
        gap: 4, maxWidth: 96,
      }}>
        {fromChannels.length > 0 && (
          // One line per channel rather than a joined string: two names
          // run together read as one long name, and the ones that matter
          // most are short enough that stacking costs nothing. Two shown,
          // the rest counted — the full list is in the tooltip.
          <div
            title={`De ${fromChannels.map(c => c.name).join(' · ')}`}
            style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'flex-end', gap: 1, maxWidth: '100%',
            }}
          >
            {fromChannels.slice(0, 2).map(c => (
              // Coloured per source, not per row. A night that reached
              // you through a friend's channel and an auê one says both,
              // and says which was which — the stripe can only answer
              // once, and it answers for the stronger of the two.
              <div key={c.name} className="neon-mono" style={{
                fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase',
                color: c.kind === 'private' ? 'var(--from-private)' : 'var(--from-aue)',
                textAlign: 'right', lineHeight: 1.25,
                maxWidth: '100%',
                display: '-webkit-box', WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>
                {c.name}
              </div>
            ))}
            {fromChannels.length > 2 && (
              <div className="neon-mono" style={{
                fontSize: 9, letterSpacing: '0.1em',
                color: 'var(--text3)', lineHeight: 1.25,
              }}>
                +{fromChannels.length - 2}
              </div>
            )}
          </div>
        )}
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
// "Pedir convite" button on the private-event lock screen. Calls the
// backend to ask the creator + co-hosts to be added; backend rate-limits
// to 5/hour/user across all events. Status states: 'none' shows the
// button enabled, 'pending' shows a disabled "Pedido enviado" pill,
// 'rejected' shows a disabled "Pedido recusado" pill (the row stays
// in the DB to enforce no-re-request).
function RequestInviteButton({ eventId, googleId, canRequest, initialStatus }) {
  const [status, setStatus] = useState(initialStatus || 'none')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  if (!googleId) {
    return (
      <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 4 }}>
        Faça login pra pedir convite.
      </div>
    )
  }
  if (!canRequest && status === 'none') {
    return null
  }

  if (status === 'pending') {
    return (
      <div style={{
        padding: '10px 16px', borderRadius: 12,
        background: 'var(--sage-pale)', color: 'var(--sage)',
        fontSize: 13, fontWeight: 700,
      }}>
        ✓ Pedido enviado
      </div>
    )
  }
  if (status === 'rejected') {
    return (
      <div style={{
        padding: '10px 16px', borderRadius: 12,
        background: '#FFEBEE', color: '#B71C1C',
        fontSize: 13, fontWeight: 700,
      }}>
        Pedido recusado
      </div>
    )
  }
  if (status === 'accepted' || status === 'already_invited') {
    return (
      <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 4 }}>
        Você já tem acesso — recarregue a tela.
      </div>
    )
  }

  async function handleClick() {
    if (submitting) return
    setSubmitting(true); setError('')
    try {
      const result = await requestEventInvite(eventId, googleId)
      setStatus(result?.status || 'pending')
    } catch (err) {
      setError(err?.message || 'Falha ao pedir convite')
    }
    setSubmitting(false)
  }

  return (
    <>
      <button
        onClick={handleClick}
        disabled={submitting}
        style={{
          padding: '10px 22px', borderRadius: 12, border: 'none',
          background: 'var(--terra)', color: 'white',
          fontSize: 13, fontWeight: 700,
          cursor: submitting ? 'wait' : 'pointer',
          opacity: submitting ? 0.7 : 1,
        }}
      >
        {submitting ? 'Pedindo...' : '📩 Pedir convite'}
      </button>
      {error && (
        <div style={{ fontSize: 12, color: '#B71C1C', marginTop: 8, textAlign: 'center', maxWidth: 280 }}>
          {error}
        </div>
      )}
    </>
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
        background: 'var(--white)', borderRadius: 16, margin: '0 16px 8px',
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

