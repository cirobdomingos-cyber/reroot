import { useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { CATEGORIES, DATE_FILTERS } from '../data/events'
import { fetchEvents, fetchEventDetail } from '../services/api'
import { scheduleEventReminder, cancelEventReminder } from '../lib/notifications'

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

export default function Events() {
  const { state, dispatch } = useApp()
  const [activeFilter, setActiveFilter] = useState('all')
  const [dateFilter, setDateFilter] = useState('all')
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [dataSource, setDataSource] = useState('static')
  const [selectedEventId, setSelectedEventId] = useState(null)
  const [detailEvent, setDetailEvent] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [notifToast, setNotifToast] = useState(null)

  const loadEvents = useCallback(async (category) => {
    setLoading(true)
    const { events: evs, source } = await fetchEvents(category)
    setEvents(evs)
    setDataSource(source)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadEvents(activeFilter)
  }, [activeFilter, loadEvents])

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

  // Apply search + date filter
  let filteredEvents = events
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    filteredEvents = filteredEvents.filter(ev =>
      ev.name.toLowerCase().includes(q) ||
      ev.venue?.toLowerCase().includes(q)
    )
  }
  if (dateFilter !== 'all') {
    filteredEvents = filteredEvents.filter(ev => ev.dateTag === dateFilter)
  }

  function getMemberCount(ev) {
    const base = ev.cohortGoing?.length ?? ev.attendeesConfirmed ?? 0
    return base + (state.rsvps[ev.id] ? 1 : 0)
  }

  async function handleRsvpToggle(ev) {
    const wasRsvped = !!state.rsvps[ev.id]
    dispatch({ type: 'TOGGLE_RSVP', payload: { eventId: ev.id } })
    if (!wasRsvped && ev.category !== 'bars_cafes') {
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
            <div className="screen-header__title">Events</div>
            <div className="screen-header__sub">
              Curitiba · Spring Cohort · 24 members
            </div>
          </div>
          <div style={{
            fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8,
            padding: '3px 8px', borderRadius: 6,
            background: 'var(--sage-pale)', color: 'var(--sage)',
          }}>
            {dataSource === 'live' ? '🟢 Live' : '🌿 Curitiba'}
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
            placeholder="Search events or venues..."
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

      {/* Date filter chips */}
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

      {/* Loading skeletons */}
      {loading && (
        <>
          <EventCardSkeleton />
          <EventCardSkeleton />
          <EventCardSkeleton />
        </>
      )}

      {/* Event list */}
      {!loading && (
        <AnimatePresence mode="popLayout">
          {filteredEvents.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--charcoal-mid)', fontSize: 14 }}
            >
              {searchQuery
                ? `No events found for "${searchQuery}"`
                : 'No events found for this filter.'}
            </motion.div>
          )}

          {filteredEvents.map(ev => {
            const rsvped = !!state.rsvps[ev.id]
            const count = getMemberCount(ev)
            const isVenue = ev.category === 'bars_cafes'

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

                  {isVenue && (
                    <span style={{
                      position: 'absolute', top: 10, right: 12,
                      fontSize: 9, fontWeight: 700,
                      background: 'rgba(196,114,74,0.85)', color: 'white',
                      padding: '3px 8px', borderRadius: 6,
                    }}>
                      SEMPRE ABERTO
                    </span>
                  )}

                  {!isVenue && count === 0 && (
                    <span style={{
                      position: 'absolute', top: 10, right: 12,
                      fontSize: 10, fontWeight: 700,
                      background: 'rgba(255,255,255,0.85)', color: 'var(--charcoal-mid)',
                      padding: '4px 10px', borderRadius: 8,
                    }}>
                      Be first in your cohort
                    </span>
                  )}

                  {!isVenue && count > 0 && (
                    <span style={{
                      position: 'absolute', top: 10, right: 12,
                      fontSize: 10, fontWeight: 700,
                      background: 'rgba(44,44,44,0.75)', color: 'white',
                      padding: '4px 10px', borderRadius: 8,
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--sage-light)', display: 'block' }}/>
                      {count} going
                    </span>
                  )}

                  {ev.expectedSize && !isVenue && (
                    <span style={{
                      position: 'absolute', bottom: 10, right: 12,
                      fontSize: 9, background: 'rgba(122,158,126,0.85)', color: 'white',
                      padding: '2px 7px', borderRadius: 6, fontWeight: 700,
                    }}>
                      {ev.expectedSize === 'small' ? 'SMALL GROUP' : ev.expectedSize === 'medium' ? 'MEDIUM GROUP' : 'LARGE EVENT'}
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
                        {isVenue ? ev.time : `${ev.date} · ${ev.time}`}
                      </div>
                      {ev.price && (
                        <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 1 }}>
                          {ev.price}
                          {ev.hasFood && <span style={{ marginLeft: 6 }}>🍽️ includes food</span>}
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
                      {rsvped ? 'Going ✓' : isVenue ? 'Save' : 'RSVP'}
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
                <div style={{ fontSize: 14, color: 'var(--charcoal-mid)' }}>Loading...</div>
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
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DetailPanel({ event: ev, rsvped, onClose, onRsvp, onAttended, userNeighborhood }) {
  const count = (ev.cohortGoing?.length ?? ev.attendeesConfirmed ?? 0) + (rsvped ? 1 : 0)
  const isVenue = ev.category === 'bars_cafes'

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
            🌿 Low pressure
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
            Sempre aberto · Venha quando quiser
          </div>
        )}

        <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.8, marginBottom: 14 }}>
          📍 {ev.venue}<br/>
          🗓 {isVenue ? `Horário: ${ev.duration || ev.time}` : `${ev.date} · ${ev.duration || ev.time}`}<br/>
          {ev.categoryEmoji} {ev.categoryLabel}
          {ev.price && <><br/>💰 {ev.price}</>}
          {ev.hasFood && <><br/>🍽️ Food & drinks included</>}
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
              Why this is good for you now
            </div>
            <div style={{ fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.5 }}>{ev.rerootReason}</div>
          </div>
        )}

        {/* Cohort members */}
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 12 }}>
          {isVenue
            ? (ev.cohortGoing?.length > 0 ? `${ev.cohortGoing.length} cohort members frequent this spot` : 'No cohort members here yet')
            : (count === 0 ? 'Be first in your cohort' : `${count} going`)
          }
        </div>

        <div style={{ background: 'white', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-sm)', marginBottom: 20 }}>
          {(ev.cohortGoing?.length === 0 && !rsvped) ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--charcoal-mid)', fontSize: 13 }}>
              {isVenue ? 'Be the first cohort member to save this spot.' : 'No cohort members yet. Be the first to RSVP.'}
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
                  <div className="avatar" style={{ background: 'var(--terra)' }}>S</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--charcoal)' }}>
                      You <span style={{ fontSize: 11, color: 'var(--sage)', fontWeight: 700 }}>· {isVenue ? 'Saved ✓' : 'Going ✓'}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>Week 3 · {userNeighborhood}</div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <button className="btn btn--primary" onClick={onRsvp}>
          {rsvped
            ? (isVenue ? 'Remove from saved' : 'Cancel RSVP')
            : (isVenue ? 'Save this spot' : 'RSVP to this event')
          }
        </button>

        {rsvped && !isVenue && (
          <button
            className="btn"
            style={{ marginTop: 10, background: 'var(--sage-pale)', color: 'var(--sage)', fontWeight: 600, fontSize: 14 }}
            onClick={onAttended}
          >
            Mark as attended ✓
          </button>
        )}

        {ev.url && (
          <a
            href={ev.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', textAlign: 'center', marginTop: 14, fontSize: 12, color: 'var(--charcoal-light)', textDecoration: 'underline' }}
          >
            View original event →
          </a>
        )}
      </div>
    </>
  )
}
