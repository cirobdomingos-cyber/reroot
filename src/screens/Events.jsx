import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp, getProfile } from '../context/AppContext'
import { useT } from '../i18n'
import { CATEGORIES, DATE_FILTERS } from '../data/events'
import { fetchEvents, fetchEventDetail } from '../services/api'
import { scheduleEventReminder, cancelEventReminder } from '../lib/notifications'

const VENUE_CATEGORIES = new Set(['bars_cafes', 'parks', 'cinema', 'bookstore'])

const VENUE_SUBTYPES = [
  { id: 'all',  label: 'Todos' },
  { id: 'cafe', label: '☕ Cafés' },
  { id: 'bar',  label: '🍺 Bares' },
]

function getSubtype(ev) {
  if (ev.placeSubtype) return ev.placeSubtype
  // Infer from static data icon
  return ev.icon === '☕' ? 'cafe' : 'bar'
}

function EventCardSkeleton() {
  return (
    <div style={{
      background: 'white', borderRadius: 20, margin: '0 16px 12px',
      overflow: 'hidden', boxShadow: 'var(--shadow)',
    }}>
      <div style={{ height: 96, background: 'linear-gradient(90deg, #f0ede8, #e8e4de, #f0ede8)', backgroundSize: '200% 100%', animation: 'shimmer 1.4s infinite' }}/>
      <div style={{ padding: '13px 16px 15px' }}>
        <div style={{ height: 16, width: '70%', background: '#f0ede8', borderRadius: 6, marginBottom: 8 }}/>
        <div style={{ height: 12, width: '50%', background: '#f0ede8', borderRadius: 6, marginBottom: 12 }}/>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ height: 12, width: '30%', background: '#f0ede8', borderRadius: 6 }}/>
          <div style={{ height: 32, width: 70, background: '#f0ede8', borderRadius: 12 }}/>
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

export default function Events() {
  const { state, dispatch } = useApp()
  const location = useLocation()
  const t = useT()
  const profile = getProfile(state.userSituation)
  const defaultFilter = profile?.priorityCategories?.[0] ?? 'all'
  const [activeFilter, setActiveFilter] = useState(defaultFilter)
  const [dateFilter, setDateFilter] = useState('all')
  const [venueSubFilter, setVenueSubFilter] = useState('all')
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [dataSource, setDataSource] = useState('static')
  const [selectedEventId, setSelectedEventId] = useState(null)
  const [detailEvent, setDetailEvent] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [notifToast, setNotifToast] = useState(null)

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

  // Open event detail when navigated from companion chat
  useEffect(() => {
    const openId = location.state?.openEventId
    if (openId && !loading) {
      openDetail(openId)
      // Clear the navigation state so it doesn't re-trigger
      window.history.replaceState({}, '')
    }
  }, [location.state?.openEventId, loading])

  async function openDetail(eventId) {
    setSelectedEventId(eventId)
    setDetailLoading(true)
    const { event } = await fetchEventDetail(eventId)
    setDetailEvent(event)
    setDetailLoading(false)
  }

  function closeDetail() {
    setSelectedEventId(null)
    setDetailEvent(null)
  }

  // Apply search + date/venue filter
  let filteredEvents = events
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    filteredEvents = filteredEvents.filter(ev =>
      ev.name.toLowerCase().includes(q) ||
      ev.venue?.toLowerCase().includes(q)
    )
  }
  if (!isVenueMode && dateFilter !== 'all') {
    filteredEvents = filteredEvents.filter(ev => ev.dateTag === dateFilter)
  }
  if (isVenueMode && venueSubFilter !== 'all') {
    filteredEvents = filteredEvents.filter(ev => getSubtype(ev) === venueSubFilter)
  }

  function getMemberCount(ev) {
    const base = ev.cohortGoing?.length ?? 0
    return base + (state.rsvps[ev.id] ? 1 : 0)
  }

  async function handleRsvpToggle(ev) {
    const wasRsvped = !!state.rsvps[ev.id]
    dispatch({ type: 'TOGGLE_RSVP', payload: { eventId: ev.id } })
    if (!wasRsvped && !isVenueMode) {
      const ok = await scheduleEventReminder(ev)
      if (ok) {
        setNotifToast(ev.name)
        setTimeout(() => setNotifToast(null), 3000)
      }
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

      {/* Header */}
      <div className="screen-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="screen-header__title">{t.events_title}</div>
            <div className="screen-header__sub">{t.events_sub}</div>
          </div>
          <div style={{
            fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8,
            padding: '3px 8px', borderRadius: 6,
            background: dataSource === 'places' ? 'rgba(196,114,74,0.12)' : 'var(--sage-pale)',
            color: dataSource === 'places' ? 'var(--terra)' : 'var(--sage)',
          }}>
            {dataSource === 'live' ? t.events_live : dataSource === 'places' ? '📍 Google' : t.events_static}
          </div>
        </div>
      </div>

      {/* Search bar */}
      <div style={{ padding: '4px 16px 0' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'white', borderRadius: 14,
          border: '1.5px solid var(--border)',
          padding: '9px 14px', boxShadow: 'var(--shadow-sm)',
        }}>
          <span style={{ fontSize: 14, color: 'var(--charcoal-light)' }}>🔍</span>
          <input
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
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--charcoal-light)', padding: 0 }}
            >✕</button>
          )}
        </div>
      </div>

      {/* Category filter chips */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px 0', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            onClick={() => setActiveFilter(cat.id)}
            style={{
              padding: '7px 14px', borderRadius: 20, whiteSpace: 'nowrap',
              fontSize: 12, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
              transition: 'all 0.15s',
              border: activeFilter === cat.id ? 'none' : '1.5px solid var(--border)',
              background: activeFilter === cat.id ? 'var(--charcoal)' : 'white',
              color: activeFilter === cat.id ? 'white' : 'var(--charcoal-mid)',
            }}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Date filter or venue sub-filter */}
      {isVenueMode ? (
        <div style={{ display: 'flex', gap: 6, padding: '8px 16px 12px', overflowX: 'auto', scrollbarWidth: 'none' }}>
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
              fontSize: 10, color: 'var(--charcoal-light)',
              paddingRight: 4,
            }}>
              {filteredEvents.length} locais
            </span>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, padding: '8px 16px 12px', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {DATE_FILTERS.map(df => (
            <button
              key={df.id}
              onClick={() => setDateFilter(df.id)}
              style={{
                padding: '5px 12px', borderRadius: 16, whiteSpace: 'nowrap',
                fontSize: 11, fontWeight: 600, flexShrink: 0, cursor: 'pointer',
                transition: 'all 0.15s',
                border: dateFilter === df.id ? 'none' : '1px solid var(--border)',
                background: dateFilter === df.id ? 'var(--terra)' : 'transparent',
                color: dateFilter === df.id ? 'white' : 'var(--charcoal-light)',
              }}
            >
              {df.label}
            </button>
          ))}
        </div>
      )}

      {/* Loading skeletons */}
      {loading && (
        isVenueMode
          ? <>{[0,1,2,3,4].map(i => <VenueSkeletonRow key={i} />)}</>
          : <>{[0,1,2].map(i => <EventCardSkeleton key={i} />)}</>
      )}

      {/* List */}
      {!loading && (
        <AnimatePresence mode="popLayout">
          {filteredEvents.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--charcoal-mid)', fontSize: 14 }}
            >
              {searchQuery
                ? `${t.events_empty_search} "${searchQuery}"`
                : t.events_empty_cat}
            </motion.div>
          )}

          {filteredEvents.map(ev => {
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

            const count = getMemberCount(ev)

            return (
              <motion.div
                key={ev.id}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                style={{
                  background: 'white', borderRadius: 20,
                  margin: '0 16px 12px', overflow: 'hidden',
                  boxShadow: 'var(--shadow)', cursor: 'pointer',
                }}
                onClick={() => openDetail(ev.id)}
              >
                {/* Card header */}
                <div style={{ height: 96, background: ev.headerBg, position: 'relative' }}>
                  <span style={{
                    position: 'absolute', top: 10, left: 12,
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8,
                    background: 'rgba(255,255,255,0.92)', color: 'var(--charcoal)',
                    padding: '4px 10px', borderRadius: 8,
                  }}>
                    {ev.categoryEmoji} {ev.categoryLabel}
                  </span>

                  {count === 0 && (
                    <span style={{
                      position: 'absolute', top: 10, right: 12,
                      fontSize: 10, fontWeight: 700,
                      background: 'rgba(255,255,255,0.85)', color: 'var(--charcoal-mid)',
                      padding: '4px 10px', borderRadius: 8,
                    }}>
                      {t.events_be_first}
                    </span>
                  )}

                  {count > 0 && (
                    <span style={{
                      position: 'absolute', top: 10, right: 12,
                      fontSize: 10, fontWeight: 700,
                      background: 'rgba(44,44,44,0.75)', color: 'white',
                      padding: '4px 10px', borderRadius: 8,
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--sage-light)', display: 'block' }}/>
                      {count} {t.events_going}
                    </span>
                  )}

                  {ev.expectedSize && (
                    <span style={{
                      position: 'absolute', bottom: 10, right: 12,
                      fontSize: 9, background: 'rgba(122,158,126,0.85)', color: 'white',
                      padding: '2px 7px', borderRadius: 6, fontWeight: 700,
                    }}>
                      {ev.expectedSize === 'small' ? t.events_small : ev.expectedSize === 'medium' ? t.events_medium : t.events_large}
                    </span>
                  )}
                </div>

                {/* Card body */}
                <div style={{ padding: '13px 16px 15px' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 3 }}>
                    {ev.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    📍 {ev.venue}
                  </div>
                  {ev.vibeSummary && ev.vibeSummary !== ev.name && (
                    <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginBottom: 8, fontStyle: 'italic', lineHeight: 1.4 }}>
                      {ev.vibeSummary}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--terra)' }}>
                        {`${ev.date} · ${ev.time}`}
                      </div>
                      {ev.price && (
                        <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 1 }}>
                          {ev.price}
                          {ev.hasFood && <span style={{ marginLeft: 6 }}>🍽️ {t.events_has_food}</span>}
                        </div>
                      )}
                    </div>
                    <button
                      className="btn btn--primary"
                      style={{ width: 'auto', padding: '8px 18px', fontSize: 12, borderRadius: 12 }}
                      onClick={e => {
                        e.stopPropagation()
                        handleRsvpToggle(ev)
                      }}
                    >
                      {rsvped ? t.events_rsvped : t.events_rsvp}
                    </button>
                  </div>
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      )}

      {/* Notification toast */}
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

      {/* Event detail drawer */}
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
            {detailLoading || !detailEvent ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <div style={{ fontSize: 14, color: 'var(--charcoal-mid)' }}>{t.events_loading}</div>
              </div>
            ) : (
              <DetailPanel
                event={detailEvent}
                rsvped={!!state.rsvps[detailEvent.id]}
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

function VenueRow({ ev, saved, onSave, onOpen, t }) {
  const subtype = getSubtype(ev)
  const neighborhood = ev.venue?.split(' · ')[1] || ev.venue || ''

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
        </div>
      </div>

      {/* Save button */}
      <button
        onClick={e => { e.stopPropagation(); onSave() }}
        style={{
          flexShrink: 0, padding: '7px 14px', borderRadius: 10,
          fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
          border: saved ? 'none' : '1.5px solid var(--border)',
          background: saved ? 'var(--sage)' : 'transparent',
          color: saved ? 'white' : 'var(--charcoal-mid)',
        }}
      >
        {saved ? `✓ ${t.events_saved_check}` : t.events_save}
      </button>
    </div>
  )
}

function DetailPanel({ event: ev, rsvped, onClose, onRsvp, onAttended, userNeighborhood, t }) {
  const count = (ev.cohortGoing?.length ?? 0) + (rsvped ? 1 : 0)
  const isVenue = VENUE_CATEGORIES.has(ev.category)

  return (
    <>
      {/* Hero */}
      <div style={{ height: 200, background: ev.headerBg, position: 'relative' }}>
        <button onClick={onClose} style={{
          position: 'absolute', top: 58, left: 16,
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
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 6 }}>{ev.name}</div>

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
          📍 {ev.venue}<br/>
          {isVenue
            ? `🕐 ${t.events_venue_open}`
            : `🗓 ${ev.date} · ${ev.duration || ev.time}`
          }<br/>
          {ev.categoryEmoji} {ev.categoryLabel}
          {ev.price && <><br/>💰 {ev.price}</>}
          {ev.hasFood && <><br/>{t.events_food_drink}</>}
        </div>

        {ev.description && (
          <div style={{ fontSize: 14, color: 'var(--charcoal)', lineHeight: 1.6, marginBottom: 16 }}>
            {ev.description}
          </div>
        )}

        {ev.rerootReason && (
          <div style={{
            background: 'var(--sage-pale)', borderRadius: 12,
            padding: '12px 14px', marginBottom: 18,
            borderLeft: '3px solid var(--sage)',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--sage)', marginBottom: 4 }}>
              {t.events_why_good}
            </div>
            <div style={{ fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.5 }}>{ev.rerootReason}</div>
          </div>
        )}

        {/* Cohort members */}
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 12 }}>
          {isVenue
            ? (ev.cohortGoing?.length > 0 ? `${ev.cohortGoing.length} ${t.events_venue_frequent}` : t.events_venue_no_members)
            : (count === 0 ? t.events_be_first : `${count} ${t.events_going}`)
          }
        </div>

        <div style={{ background: 'white', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-sm)', marginBottom: 20 }}>
          {(ev.cohortGoing?.length === 0 && !rsvped) ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--charcoal-mid)', fontSize: 13 }}>
              {isVenue ? t.events_venue_save_first : t.events_no_members}
            </div>
          ) : (
            <>
              {ev.cohortGoing?.map(p => (
                <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                  <div className="avatar" style={{ background: p.color }}>{p.initial}</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--charcoal)' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>{p.note}</div>
                  </div>
                </div>
              ))}
              {rsvped && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
                  <div className="avatar" style={{ background: 'var(--terra)' }}>V</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--charcoal)' }}>
                      {t.events_you} <span style={{ fontSize: 11, color: 'var(--sage)', fontWeight: 700 }}>· {isVenue ? t.events_saved_check : t.events_going_check}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>{t.events_week} 3 · {userNeighborhood}</div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <button className="btn btn--primary" onClick={onRsvp}>
          {rsvped
            ? (isVenue ? t.events_venue_remove : t.events_cancel_rsvp)
            : (isVenue ? t.events_venue_save : t.events_rsvp_btn)
          }
        </button>

        {rsvped && !isVenue && (
          <button
            className="btn"
            style={{ marginTop: 10, background: 'var(--sage-pale)', color: 'var(--sage)', fontWeight: 600, fontSize: 14 }}
            onClick={onAttended}
          >
            {t.events_attended_btn}
          </button>
        )}

        {ev.url && (
          <a
            href={ev.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', textAlign: 'center', marginTop: 14, fontSize: 12, color: 'var(--charcoal-light)', textDecoration: 'underline' }}
          >
            {isVenue ? '📍 Ver no Google Maps →' : t.events_view_original}
          </a>
        )}
      </div>
    </>
  )
}
