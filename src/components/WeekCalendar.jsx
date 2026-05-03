import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useT } from '../i18n'
import { getAnchorToday } from '../lib/dateAnchor'
import Avatar from './Avatar'

const DAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const DAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_LABELS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const MONTH_LABELS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function getWeekDays(offset = 0) {
  // Rolling 7-day window starting from the 6am-anchored "today"
  // (see getAnchorToday). offset=0 → today + 6 upcoming days;
  // offset=1 → 7 days after that; offset=-1 → 7 days before today
  // (handy for re-checking past plans).
  const start = getAnchorToday()
  start.setDate(start.getDate() + offset * 7)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isToday(d) {
  // Compare against the 6am-anchored "today" so the highlighted column
  // matches the strip's rolling logic.
  const t = getAnchorToday()
  return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear()
}

/**
 * WeekCalendar — scrollable week view with event dots
 *
 * Props:
 *   rsvpEvents:  [{ id, name, icon, date, time, dateStart, headerBg, ...}]  — confirmed
 *   groupEvents: [{ id, name, group_name, date_start, ...}]                — from groups, not yet RSVPd
 *   language:    'pt' | 'en'
 *   onEventTap:  (event, type) => void  — type is 'rsvp' or 'group'
 *   onGroupRsvp: (event) => void
 */
export default function WeekCalendar({
  rsvpEvents = [], groupEvents = [], friendsByEventId = {},
  language = 'pt', onEventTap, onGroupRsvp,
  // Optional controlled API. If `weekOffset` is provided the parent owns
  // the state (so it can compute "events outside the visible week" for
  // its own sections); otherwise we keep an internal offset for callers
  // that don't care about the current week.
  weekOffset: weekOffsetProp,
  onWeekOffsetChange,
}) {
  const t = useT()
  const [internalOffset, setInternalOffset] = useState(0)
  const isControlled = typeof weekOffsetProp === 'number'
  const weekOffset = isControlled ? weekOffsetProp : internalOffset
  const setWeekOffset = (next) => {
    const value = typeof next === 'function' ? next(weekOffset) : next
    if (isControlled) onWeekOffsetChange?.(value)
    else setInternalOffset(value)
  }

  const days = getWeekDays(weekOffset)
  const dayLabels = language === 'pt' ? DAY_LABELS_PT : DAY_LABELS_EN
  const monthLabels = language === 'pt' ? MONTH_LABELS_PT : MONTH_LABELS_EN

  // Build event map by date
  const eventsByDate = {}

  rsvpEvents.forEach(ev => {
    if (!ev.dateStart) return
    const key = ev.dateStart.slice(0, 10)
    if (!eventsByDate[key]) eventsByDate[key] = []
    eventsByDate[key].push({ ...ev, _type: 'rsvp' })
  })

  groupEvents.forEach(ev => {
    // Group events from /groups have date_start (snake_case); events from
    // /events/group return dateStart (camelCase). Both flow through here,
    // so accept either.
    const ds = ev.date_start || ev.dateStart
    if (!ds) return
    const key = ds.slice(0, 10)
    if (!eventsByDate[key]) eventsByDate[key] = []
    eventsByDate[key].push({ ...ev, _type: 'group' })
  })

  // Flatten the week's events grouped by day. The day strip still
  // highlights selectedDate for visual context, but the events list
  // below now spans the whole visible week instead of just one day —
  // user feedback was that single-day filtering hid plans they'd RSVP'd
  // to and made the calendar feel empty most of the time.
  const dayBuckets = days
    .map(day => {
      const key = dateKey(day)
      const events = eventsByDate[key] || []
      return { day, key, events }
    })
    .filter(b => b.events.length > 0)
  const totalWeekEvents = dayBuckets.reduce((sum, b) => sum + b.events.length, 0)

  // Month label from the first day of the visible week
  const monthLabel = `${monthLabels[days[0].getMonth()]} ${days[0].getFullYear()}`

  return (
    <div style={{ margin: '0 16px 14px' }}>
      {/* Header — month + navigation */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10,
      }}>
        <button onClick={() => setWeekOffset(o => o - 1)} style={navBtn}>‹</button>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--charcoal)' }}>
          {monthLabel}
          {weekOffset !== 0 && (
            <button
              onClick={() => setWeekOffset(0)}
              style={{ marginLeft: 8, fontSize: 10, color: 'var(--terra)', background: 'var(--terra-pale)', border: 'none', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontWeight: 600 }}
            >
              {language === 'pt' ? 'Hoje' : 'Today'}
            </button>
          )}
        </div>
        <button onClick={() => setWeekOffset(o => o + 1)} style={navBtn}>›</button>
      </div>

      {/* Day cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {days.map((day) => {
          const key = dateKey(day)
          const today = isToday(day)
          const eventsOnDay = eventsByDate[key] || []
          const hasRsvp = eventsOnDay.some(e => e._type === 'rsvp')
          const hasGroup = eventsOnDay.some(e => e._type === 'group')

          return (
            <div
              key={key}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                padding: '6px 0 4px', borderRadius: 12,
                background: today ? 'var(--cream)' : 'transparent',
                border: today ? '1.5px solid var(--terra)' : '1.5px solid transparent',
              }}
            >
              <div style={{
                fontSize: 10, fontWeight: 600,
                color: 'var(--charcoal-light)', marginBottom: 2,
              }}>
                {dayLabels[day.getDay()]}
              </div>
              <div style={{
                fontSize: 16, fontWeight: 700,
                color: today ? 'var(--terra)' : 'var(--charcoal)',
              }}>
                {day.getDate()}
              </div>
              {/* Dots */}
              <div style={{ display: 'flex', gap: 3, marginTop: 3, height: 6 }}>
                {hasRsvp && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--sage)' }} />}
                {hasGroup && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--terra)' }} />}
              </div>
            </div>
          )
        })}
      </div>

      {/* Week events — grouped by day. Each day gets a small label
          (Ter, 28 Abr) before its events. Days with no events are
          skipped entirely so the list stays compact. */}
      <AnimatePresence mode="wait">
        <motion.div
          key={`${weekOffset}-week`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
          style={{ marginTop: 10 }}
        >
          {totalWeekEvents === 0 ? (
            <div style={{
              textAlign: 'center', padding: '14px 0', fontSize: 12,
              color: 'var(--charcoal-light)', fontStyle: 'italic',
            }}>
              {language === 'pt' ? 'Nenhum evento esta semana' : 'No events this week'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
                color: 'var(--charcoal-light)', textTransform: 'uppercase',
              }}>
                {language === 'pt' ? 'Seus eventos essa semana' : 'Your events this week'}
              </div>
              {dayBuckets.map(({ day, key, events }) => (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {events.map(ev => {
                    const isGroup = ev._type === 'group'
                    const accentColor = isGroup ? 'var(--terra)' : 'var(--sage)'
                    const friends = friendsByEventId[ev.id] || []
                    // Left-edge ribbon — same pattern as HomeEventRow so
                    // confirmed/pending rows read consistently across all
                    // Home sections. Sage for confirmed RSVPs, terra for
                    // pending group invites.
                    const stripeColor = isGroup ? 'var(--terra)' : 'var(--sage)'
                    return (
                      <div
                        key={ev.id}
                        onClick={() => onEventTap?.(ev, ev._type)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          background: 'var(--white)', borderRadius: 12, padding: '10px 12px',
                          border: `1.5px solid ${isGroup ? 'var(--terra-pale)' : 'var(--sage-pale)'}`,
                          boxShadow: `inset 3px 0 0 ${stripeColor}`,
                          cursor: 'pointer',
                        }}
                      >
                        {/* Date column — same shape as the catalog EventCard
                            so group/personal-plan rows in the home calendar
                            read consistently with the rest of the app. Color
                            picks up the row's accent (terra for pending
                            invites, sage for confirmed). */}
                        <div style={{
                          flexShrink: 0, width: 36,
                          display: 'flex', flexDirection: 'column', alignItems: 'center',
                          lineHeight: 1,
                        }}>
                          <div style={{
                            fontSize: 18, fontWeight: 800, color: accentColor,
                          }}>
                            {day.getDate()}
                          </div>
                          <div style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
                            color: 'var(--charcoal-light)',
                            textTransform: 'uppercase', marginTop: 2,
                          }}>
                            {dayLabels[day.getDay()]}
                          </div>
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 13, fontWeight: 600, color: 'var(--charcoal)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>
                            {ev.name}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>
                            {ev.time || (ev.date_start || ev.dateStart || '').slice(11, 16) || ''}
                            {isGroup && ev.group_name && ` · ${ev.group_name}`}
                            {!isGroup && ev.venue && ` · ${ev.venue}`}
                          </div>
                        </div>

                        {/* Friends-going avatar stack — same shape as the
                            "Amigos vão" rows below so this section reads
                            consistently. Capped at 3 avatars + total
                            count chip. Hidden when no friends overlap. */}
                        {friends.length > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginRight: 4 }}>
                            {friends.slice(0, 3).map((friend, i) => (
                              <div
                                key={(friend.google_id || friend.name) + i}
                                style={{
                                  marginLeft: i === 0 ? 0 : -8,
                                  boxShadow: '0 0 0 2px var(--bg2)',
                                  borderRadius: '50%',
                                }}
                              >
                                <Avatar name={friend.name} src={friend.picture} size={22} />
                              </div>
                            ))}
                            <span style={{
                              fontSize: 10, fontWeight: 700, color: 'var(--terra)',
                              marginLeft: 5,
                            }}>
                              {friends.length}
                            </span>
                          </div>
                        )}

                        {/* Status badge */}
                        {isGroup ? (
                          <button
                            onClick={e => { e.stopPropagation(); onGroupRsvp?.(ev) }}
                            style={{
                              padding: '5px 10px', borderRadius: 8, fontSize: 10,
                              fontWeight: 700, cursor: 'pointer', border: 'none',
                              background: 'var(--terra)', color: 'white', flexShrink: 0,
                            }}
                          >
                            {language === 'pt' ? 'Aceitar' : 'Accept'}
                          </button>
                        ) : (
                          <span style={{
                            fontSize: 10, fontWeight: 700, color: 'var(--sage)',
                            background: 'var(--sage-pale)', padding: '4px 8px', borderRadius: 6,
                            flexShrink: 0,
                          }}>
                            {language === 'pt' ? 'Confirmado' : 'Confirmed'}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 8, justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--sage)' }} />
          <span style={{ fontSize: 10, color: 'var(--charcoal-light)' }}>
            {language === 'pt' ? 'Confirmado' : 'Confirmed'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--terra)' }} />
          <span style={{ fontSize: 10, color: 'var(--charcoal-light)' }}>
            {language === 'pt' ? 'Convite de grupo' : 'Group invite'}
          </span>
        </div>
      </div>
    </div>
  )
}

const navBtn = {
  width: 32, height: 32, borderRadius: 10, border: '1px solid var(--border)',
  background: 'var(--white)', cursor: 'pointer', fontSize: 16, fontWeight: 700,
  color: 'var(--charcoal-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
