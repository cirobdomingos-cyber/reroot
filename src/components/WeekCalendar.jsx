import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useT } from '../i18n'

const DAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const DAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_LABELS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const MONTH_LABELS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function getAnchorToday() {
  // The strip's "today" only advances at 06:00 local. Between 00:00
  // and 05:59 we still treat the previous calendar day as today, so
  // late-night plans (a show that runs to 02:00) stay on the same
  // column users were looking at when they made the plan. After
  // 06:00 the column rolls forward.
  const now = new Date()
  if (now.getHours() < 6) {
    now.setDate(now.getDate() - 1)
  }
  now.setHours(0, 0, 0, 0)
  return now
}

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
export default function WeekCalendar({ rsvpEvents = [], groupEvents = [], language = 'pt', onEventTap, onGroupRsvp, onDayClick }) {
  const t = useT()
  const [weekOffset, setWeekOffset] = useState(0)
  const [selectedDate, setSelectedDate] = useState(dateKey(getAnchorToday()))

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
        {days.map((day, i) => {
          const key = dateKey(day)
          const today = isToday(day)
          const selected = key === selectedDate
          const eventsOnDay = eventsByDate[key] || []
          const hasRsvp = eventsOnDay.some(e => e._type === 'rsvp')
          const hasGroup = eventsOnDay.some(e => e._type === 'group')

          return (
            <div
              key={key}
              onClick={() => {
                setSelectedDate(key)
                // When the parent wires onDayClick, route through to it
                // so the click can also filter another screen (e.g. Home
                // → Events tab filtered to that day).
                onDayClick?.(key)
              }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                padding: '6px 0 4px', borderRadius: 12, cursor: 'pointer',
                background: selected ? 'var(--charcoal)' : today ? 'var(--cream)' : 'transparent',
                border: today && !selected ? '1.5px solid var(--terra)' : '1.5px solid transparent',
                transition: 'all 0.15s',
              }}
            >
              <div style={{
                fontSize: 10, fontWeight: 600,
                color: selected ? 'rgba(255,255,255,0.6)' : 'var(--charcoal-light)',
                marginBottom: 2,
              }}>
                {dayLabels[day.getDay()]}
              </div>
              <div style={{
                fontSize: 16, fontWeight: 700,
                color: selected ? 'white' : today ? 'var(--terra)' : 'var(--charcoal)',
              }}>
                {day.getDate()}
              </div>
              {/* Dots */}
              <div style={{ display: 'flex', gap: 3, marginTop: 3, height: 6 }}>
                {hasRsvp && <div style={{ width: 6, height: 6, borderRadius: '50%', background: selected ? 'var(--sage-light)' : 'var(--sage)' }} />}
                {hasGroup && <div style={{ width: 6, height: 6, borderRadius: '50%', background: selected ? '#F0C27A' : 'var(--terra)' }} />}
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
              {dayBuckets.map(({ day, key, events }) => (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
                    color: 'var(--charcoal-light)', textTransform: 'uppercase',
                  }}>
                    {dayLabels[day.getDay()]}, {day.getDate()} {monthLabels[day.getMonth()]}
                    {isToday(day) && (
                      <span style={{
                        marginLeft: 6, color: 'var(--terra)', letterSpacing: 0,
                      }}>
                        · {language === 'pt' ? 'hoje' : 'today'}
                      </span>
                    )}
                  </div>
                  {events.map(ev => {
                    const isGroup = ev._type === 'group'
                    return (
                      <div
                        key={ev.id}
                        onClick={() => onEventTap?.(ev, ev._type)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          background: 'white', borderRadius: 12, padding: '10px 12px',
                          border: `1.5px solid ${isGroup ? 'var(--terra-pale)' : 'var(--sage-pale)'}`,
                          cursor: 'pointer',
                        }}
                      >
                        {/* Icon or group indicator */}
                        <div style={{
                          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 16,
                          background: isGroup
                            ? 'linear-gradient(135deg, var(--terra-pale), #f5ddd1)'
                            : (ev.headerBg || 'var(--sage-pale)'),
                        }}>
                          {isGroup ? '👥' : (ev.icon || '📅')}
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
  background: 'white', cursor: 'pointer', fontSize: 16, fontWeight: 700,
  color: 'var(--charcoal-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
