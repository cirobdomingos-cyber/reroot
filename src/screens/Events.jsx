import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import { MOODS } from '../data/events'
import { fetchEvents, fetchEventDetail, trackEvent, syncRsvp, fetchFriendsFeed } from '../services/api'
import { scheduleEventReminder, cancelEventReminder, schedulePostEventNotification } from '../lib/notifications'
import AddToCalendar from '../components/AddToCalendar'
import PostEventAttendees from '../components/PostEventAttendees'
import EventsWeekStrip from '../components/EventsWeekStrip'
import Avatar from '../components/Avatar'

const VENUE_CATEGORIES = new Set(['bars_cafes', 'parks', 'cinema', 'bookstore'])

// Source provenance config — drives the badge label/style for every event origin.
// Add new entries here when new scrapers go live (sympla, lu.ma, etc.).
const SOURCE_CONFIG = {
  aue_original:     { label: 'Original auê',     icon: '⭐', bg: 'linear-gradient(135deg, #FFF8E1, #FFECB3)', border: '#FFD54F', color: '#8D6E10' },
  mon:              { label: 'MON',              icon: '🖼️', bg: '#F3E5F5',                                    border: '#CE93D8', color: '#4A148C' },
  turismo_curitiba: { label: 'Turismo CWB',      icon: '🏙', bg: '#E0F7FA',                                    border: '#80DEEA', color: '#006064' },
  sesc:             { label: 'SESC',              icon: '🎭', bg: '#E8F5E9',                                    border: '#A5D6A7', color: '#1B5E20' },
  teatro_guaira:    { label: 'Teatro Guaíra',    icon: '🎭', bg: '#FFEBEE',                                    border: '#EF9A9A', color: '#B71C1C' },
  aue_ai:           { label: 'auê IA',           icon: '✦', bg: 'linear-gradient(135deg, #EDE7F6, #D1C4E9)', border: '#CE93D8', color: '#6A1B9A' },
  sympla:           { label: 'Sympla',            icon: '🎟', bg: '#E8F5E9',                                    border: '#A5D6A7', color: '#1B5E20' },
  eventbrite:       { label: 'Eventbrite',        icon: '🎫', bg: '#FFF3E0',                                    border: '#FFCC80', color: '#BF360C' },
  meetup:           { label: 'Meetup',            icon: '👥', bg: '#E3F2FD',                                    border: '#90CAF9', color: '#0D47A1' },
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

// ── Skeleton loaders ──────────────────────────────────────────────────────────

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
  // Friends' RSVPs — feeds the friend-dot in the week strip. Only fetched
  // when the user is signed in.
  const [friendsFeed, setFriendsFeed]       = useState([])

  useEffect(() => {
    const googleId = state.googleUser?.id
    if (!googleId) { setFriendsFeed([]); return }
    let cancelled = false
    fetchFriendsFeed(googleId).then(events => {
      if (!cancelled) setFriendsFeed(events || [])
    })
    return () => { cancelled = true }
  }, [state.googleUser?.id])

  const isVenueMode = VENUE_CATEGORIES.has(activeFilter)

  const loadEvents = useCallback(async (category) => {
    setLoading(true)
    const { events: evs, source } = await fetchEvents(category)
    setEvents(evs)
    setDataSource(source)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadEvents(activeFilter)
    setVenueSubFilter('all')
  }, [activeFilter, loadEvents])

  useEffect(() => {
    const openId = location.state?.openEventId
    if (openId && !loading) {
      openDetail(openId)
      window.history.replaceState({}, '')
    }
  }, [location.state?.openEventId, loading])

  async function openDetail(eventId) {
    setSelectedEventId(eventId)
    // Check custom events first — they don't exist in the backend
    const customMatch = (state.customEvents || []).find(e => e.id === eventId)
    if (customMatch) {
      setDetailEvent(customMatch)
      return
    }
    setDetailLoading(true)
    const { event } = await fetchEventDetail(eventId)
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

  // Merge user-created custom events into the list
  const customEventsForFilter = (state.customEvents || []).filter(ev =>
    activeFilter === 'all' || ev.category === activeFilter
  )
  const allDisplayEvents = [...customEventsForFilter, ...events]

  // Apply search + date/venue filter
  let filteredEvents = allDisplayEvents
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
  // AI-curated/made-up events never surface in the Events tab — they're
  // reserved for a separate discovery surface (chatbot or dedicated tab,
  // TBD). The Events tab is the catalog of real, scraped Curitiba events.
  filteredEvents = filteredEvents.filter(ev => !ev.isCurated)
  // Snapshot for the week strip's count badges — reflects every active
  // filter *except* the per-day pick, so picking a day doesn't zero out
  // the other days' counts.
  const eventsForStrip = filteredEvents
  if (!isVenueMode && selectedDay) {
    filteredEvents = filteredEvents.filter(ev => (ev.dateStart || '').slice(0, 10) === selectedDay)
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

        {/* Mood chips — top-level filter for the catalog */}
        <div style={{ display: 'flex', gap: 7, padding: '0 16px 10px', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {MOODS.map(mood => (
            <button
              key={mood.id}
              onClick={() => handleCategoryChange(mood.id)}
              style={{
                padding: '6px 13px', borderRadius: 20, whiteSpace: 'nowrap',
                fontSize: 12, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
                transition: 'all 0.15s',
                border: activeFilter === mood.id ? 'none' : '1.5px solid var(--border)',
                background: activeFilter === mood.id ? 'var(--charcoal)' : 'white',
                color: activeFilter === mood.id ? 'white' : 'var(--charcoal-mid)',
              }}
            >
              {mood.label}
            </button>
          ))}
        </div>

      </div>

      {/* ── Week strip with per-day event counts (events mode only) ── */}
      {!isVenueMode && (
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
        {/* All-dates pill — leads the row so users always have a clear path
            back to the full catalog. Active when no specific day is picked
            from the week strip; clears the strip pick when tapped. */}
        {!isVenueMode && (
          <button
            onClick={() => setSelectedDay(null)}
            style={{
              padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
              fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
              transition: 'all 0.15s',
              border: !selectedDay ? 'none' : '1px solid var(--border)',
              background: !selectedDay ? 'var(--terra)' : 'transparent',
              color: !selectedDay ? 'white' : 'var(--charcoal-light)',
            }}
          >
            {selectedDay ? '✕ ' : ''}Todas as datas
          </button>
        )}
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

      {/* ── AI suggestion CTA — sits above the list so it's reachable
          without scrolling. AI/curated events are hidden from the catalog
          (real events only), so this is the bridge: tap to ask the
          Companion for ideas. */}
      {!loading && !isVenueMode && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('open-companion', { detail: { intent: 'suggest' } }))}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            margin: '4px 16px 12px', padding: '14px 16px',
            background: 'linear-gradient(135deg, #FFF8E1, #FFECB3)',
            border: '1px solid #FFD54F',
            borderRadius: 14, cursor: 'pointer',
            width: 'calc(100% - 32px)',
            textAlign: 'left',
          }}
        >
          <div style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: 'rgba(232, 98, 63, 0.18)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18,
          }}>✦</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#8D6E10' }}>
              Sem ideias para hoje?
            </div>
            <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2, lineHeight: 1.35 }}>
              auê IA pode sugerir algo baseado no seu humor →
            </div>
          </div>
        </button>
      )}

      {/* ── Loading skeletons ── */}
      {loading && (
        isVenueMode
          ? <>{[0,1,2,3,4].map(i => <VenueSkeletonRow key={i} />)}</>
          : <>{[0,1,2,3,4].map(i => <EventCardSkeleton key={i} />)}</>
      )}

      {/* ── List ── */}
      {!loading && (
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
                      saved={rsvped}
                      onSave={() => handleRsvpToggle(ev)}
                      onOpen={() => openDetail(ev.id)}
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
                    onOpen={() => openDetail(ev.id)}
                    onRsvp={e => { e.stopPropagation(); handleRsvpToggle(ev) }}
                    onFriend={(gid) => navigate(`/friends/${encodeURIComponent(gid)}`)}
                    t={t}
                  />
                </motion.div>
              )
            })
          )}
        </AnimatePresence>
      )}

      {/* ── Sources transparency footer — links to the catalog of monitored
          sources so users see where the events come from. */}
      {!loading && !isVenueMode && filteredEvents.length > 0 && (
        <button
          onClick={() => navigate('/sources')}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            margin: '12px 16px 24px', padding: '12px 14px',
            background: 'transparent',
            border: '1px dashed var(--border)',
            borderRadius: 12, cursor: 'pointer',
            width: 'calc(100% - 32px)',
            color: 'var(--charcoal-mid)',
            fontSize: 12, fontWeight: 600,
          }}
        >
          <span>📡 De onde vem isso? Ver fontes monitoradas</span>
          <span style={{ color: 'var(--charcoal-light)' }}>→</span>
        </button>
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
              <div style={{ fontSize: 12, fontWeight: 700 }}>Lembrete salvo</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 1 }}>{notifToast}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Detail drawer ── */}
      <AnimatePresence>
        {selectedEventId && (
          <motion.div
            key="drawer"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              background: 'var(--cream)', zIndex: 30,
              overflowY: 'auto', scrollbarWidth: 'none',
            }}
          >
            {/* Drag handle */}
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(44,44,44,0.18)' }}/>
            </div>

            {detailLoading || !detailEvent ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '80%' }}>
                <div style={{ fontSize: 14, color: 'var(--charcoal-mid)' }}>{t.events_loading}</div>
              </div>
            ) : (
              <DetailPanel
                event={detailEvent}
                rsvped={!!state.rsvps[detailEvent.id]}
                friendsGoing={friendsByEventId[detailEvent.id] || []}
                onFriend={(gid) => navigate(`/friends/${encodeURIComponent(gid)}`)}
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
    </div>
  )
}

// ── EventCard (compact horizontal layout) ────────────────────────────────────

function EventCard({ ev, rsvped, friendsGoing = [], onOpen, onRsvp, onFriend, t }) {
  // Split "Venue Name · Neighborhood" into two parts
  const [venueName, venueNeighborhood] = ev.venue?.includes(' · ')
    ? ev.venue.split(' · ')
    : [ev.venue, null]

  return (
    <div
      onClick={onOpen}
      style={{
        background: 'white', borderRadius: 16,
        margin: '0 16px 9px', padding: '12px 13px',
        border: '1px solid var(--border)',
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

        {/* Date + time */}
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--terra)', marginTop: 2 }}>
          🗓 {ev.date} · {ev.time}
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
            {ev.source && SOURCE_CONFIG[ev.source] && (() => {
              const src = SOURCE_CONFIG[ev.source]
              return (
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                  background: src.bg, color: src.color,
                  padding: '2px 8px', borderRadius: 5,
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                }}>
                  {src.icon} {src.label}
                </span>
              )
            })()}
            {ev.isCustom && (
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                background: '#FFF3E0', color: 'var(--terra)',
                padding: '2px 8px', borderRadius: 5,
              }}>
                ★ {t.tag_private}
              </span>
            )}
            {ev.isLowPressure && (
              <span style={{
                fontSize: 10, background: 'var(--sage-pale)', color: 'var(--sage)',
                padding: '2px 7px', borderRadius: 5, fontWeight: 600,
              }}>
                🌿 {t.events_low_pressure}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <AddToCalendar event={ev} />
            <button
              className="btn btn--primary"
              style={{ width: 'auto', padding: '7px 16px', fontSize: 11, borderRadius: 10 }}
              onClick={onRsvp}
            >
              {rsvped ? `✓ ${t.events_rsvped.replace(' ✓', '')}` : t.events_rsvp}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── VenueRow ──────────────────────────────────────────────────────────────────

function VenueRow({ ev, saved, onSave, onOpen, t }) {
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
          {ev.price && (
            <span style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>{ev.price}</span>
          )}
          {ev.isLowPressure && (
            <span style={{
              fontSize: 10, background: 'var(--sage-pale)', color: 'var(--sage)',
              padding: '1px 7px', borderRadius: 6, fontWeight: 600,
            }}>
              {t.events_low_pressure}
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

      {/* Save button + calendar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <AddToCalendar event={ev} />
        <button
          onClick={e => { e.stopPropagation(); onSave() }}
          style={{
            padding: '7px 14px', borderRadius: 10,
            fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
            border: saved ? 'none' : '1.5px solid var(--border)',
            background: saved ? 'var(--sage)' : 'transparent',
            color: saved ? 'white' : 'var(--charcoal-mid)',
          }}
        >
          {saved ? `✓ ${t.events_saved_check}` : t.events_save}
        </button>
      </div>
    </div>
  )
}

// ── DetailPanel ───────────────────────────────────────────────────────────────

function DetailPanel({ event: ev, rsvped, friendsGoing = [], onClose, onRsvp, onAttended, onFriend, userNeighborhood, t }) {
  const isVenue = VENUE_CATEGORIES.has(ev.category)
  const [copied, setCopied] = useState(false)

  function handleWhatsApp() {
    const link = ev.url || 'aue.app'
    const msg = `Vou ao ${ev.name} no ${ev.venue}! 🎉 Bora junto? ${link}`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener,noreferrer')
  }

  function handleCopyLink() {
    const link = ev.url || window.location.href
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <>
      {/* Hero */}
      <div style={{ height: 180, background: ev.headerBg, position: 'relative' }}>
        <button onClick={onClose} style={{
          position: 'absolute', top: 16, left: 16,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(255,255,255,0.9)', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}>←</button>
        <div style={{ position: 'absolute', bottom: 16, left: 16, fontSize: 36 }}>{ev.icon}</div>
        {ev.isLowPressure && (
          <div style={{
            position: 'absolute', bottom: 16, right: 16,
            fontSize: 10, background: 'rgba(122,158,126,0.9)', color: 'white',
            padding: '4px 10px', borderRadius: 8, fontWeight: 700,
          }}>
            🌿 {t.events_low_pressure}
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '20px 20px 100px' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 6 }}>
          {ev.name}
        </div>

        {/* Source badge — always visible so user knows where this event came from */}
        {(ev.source && SOURCE_CONFIG[ev.source]) ? (() => {
          const src = SOURCE_CONFIG[ev.source]
          return (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '5px 12px', borderRadius: 8, marginBottom: 10,
              background: src.bg, border: `1px solid ${src.border}`,
            }}>
              <span style={{ fontSize: 12 }}>{src.icon}</span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: src.color, textTransform: 'uppercase' }}>
                {src.label}
              </span>
            </div>
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

        {isVenue && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--terra-pale)', padding: '4px 10px', borderRadius: 8,
            fontSize: 10, fontWeight: 700, color: 'var(--terra)',
            textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
          }}>
            {t.events_venue_open}
          </div>
        )}

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

        <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.8, marginBottom: 14 }}>
          📍 {ev.venue}{ev.city && !ev.venue?.includes(ev.city) ? ` · ${ev.city}` : ''}<br/>
          {ev.venueAddress && (
            <span style={{ marginLeft: 18, fontSize: 12, color: 'var(--charcoal-light)' }}>
              {ev.venueAddress}<br/>
            </span>
          )}
          {isVenue
            ? `🕐 ${t.events_venue_open}`
            : `🗓 ${ev.date} · ${ev.duration || ev.time}`
          }<br/>
          {ev.categoryEmoji} {ev.categoryLabel}
          {ev.price && <><br/>💰 {ev.price}</>}
          {ev.hasFood && <><br/>{t.events_food_drink}</>}
        </div>

        {/* Price badge + Kids Welcome tag in detail view */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {ev.priceTier === 'free' && (
            <span className="tag tag--sage">{t.tag_free}</span>
          )}
          {ev.kidsWelcome && (
            <span className="tag" style={{ background: '#FFF3E0', color: '#E65100' }}>
              {t.tag_kids}
            </span>
          )}
        </div>

        {/* Friends going (live from friends_feed) */}
        {friendsGoing.length > 0 && (
          <div style={{
            background: 'white', borderRadius: 14, padding: '12px 14px',
            border: '1px solid var(--border)', marginBottom: 16,
          }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#5B8DD9',
              textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
            }}>
              Amigos vão
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {friendsGoing.map((f, i) => (
                <button
                  key={f.google_id ?? i}
                  onClick={() => f.google_id && onFriend?.(f.google_id)}
                  disabled={!f.google_id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: 'none', border: 'none', padding: 0,
                    cursor: f.google_id ? 'pointer' : 'default',
                    textAlign: 'left',
                  }}
                >
                  <Avatar name={f.name} src={f.picture} size={32} />
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>
                    {f.name}
                  </div>
                  {f.google_id && (
                    <div style={{ fontSize: 14, color: 'var(--charcoal-light)' }}>→</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {(() => {
          const desc = cleanDescription(ev.description)
          return desc ? (
            <div style={{ fontSize: 14, color: 'var(--charcoal)', lineHeight: 1.6, marginBottom: 16, whiteSpace: 'pre-line' }}>
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
                padding: '8px 14px', borderRadius: 10, marginBottom: 16,
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
            padding: '12px 14px', marginBottom: 18,
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
