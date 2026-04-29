import { useState, useMemo } from 'react'
import { getAnchorToday } from '../lib/dateAnchor'

const DAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MONTH_LABELS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

function getWeekDays(offset = 0) {
  // Rolling 7-day window anchored on the 6am-adjusted "today"
  // (today + 6). offset slides by full weeks. Matches Home's
  // WeekCalendar so the user sees a consistent frame across both.
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
  // Compare against 6am-anchored today so the highlighted column
  // matches the strip's rolling logic.
  const t = getAnchorToday()
  return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear()
}

/**
 * EventsWeekStrip — horizontal week with a count badge per day.
 *
 * Props:
 *   events:      [{ dateStart, ... }]   — all candidate events (after non-date filters)
 *   selectedDay: 'YYYY-MM-DD' | null    — currently filtered date (controlled)
 *   onSelectDay: (day | null) => void   — toggles; pass null to clear
 *   rsvpDays:    Set<'YYYY-MM-DD'>      — days where the user has at least one RSVP
 *   friendDays:  Set<'YYYY-MM-DD'>      — days where any friend has at least one RSVP
 */
export default function EventsWeekStrip({
  events = [],
  selectedDay = null,
  onSelectDay,
  rsvpDays,
  friendDays,
}) {
  const [weekOffset, setWeekOffset] = useState(0)
  const days = getWeekDays(weekOffset)

  // Bucket events by ISO day. Each day gets +1 for every event covering
  // it: one-offs on their single day, multi-day ranges on every day in
  // the run, recurring residencies on every matching weekday in a
  // 60-day forward window.
  //
  // Yes, this can make the strip badges look "busy" when residencies
  // cover multiple weekdays — that's the discoverability tradeoff.
  // Users who want only the time-sensitive stuff toggle the "Só únicos"
  // filter on the price-row to drop residencies + ranges from both the
  // strip events feed AND the list. 60-day cap protects against
  // malformed multi-year ranges.
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const countsByDay = useMemo(() => {
    const map = {}
    const horizon = new Date()
    horizon.setUTCDate(horizon.getUTCDate() + 60)
    for (const ev of events) {
      // Recurring branch: walk forward 60 days, count every matching
      // ISO weekday.
      if (ev.isRecurring && Array.isArray(ev.recurrenceDays) && ev.recurrenceDays.length) {
        const cursor = new Date(`${todayIso}T00:00:00Z`)
        let n = 0
        while (cursor <= horizon && n < 60) {
          const isoDow = ((cursor.getUTCDay() + 6) % 7) + 1
          if (ev.recurrenceDays.includes(isoDow)) {
            const k = cursor.toISOString().slice(0, 10)
            map[k] = (map[k] || 0) + 1
          }
          cursor.setUTCDate(cursor.getUTCDate() + 1)
          n += 1
        }
        continue
      }
      const isoStart = ev.dateStart || ev.date_start || ''
      if (!isoStart) continue
      const startKey = isoStart.slice(0, 10)
      const isoEnd = ev.dateEnd || ev.date_end || ''
      const endKey = isoEnd ? isoEnd.slice(0, 10) : startKey
      const start = new Date(`${startKey}T00:00:00Z`)
      const end = new Date(`${endKey}T00:00:00Z`)
      if (Number.isNaN(start.getTime())) continue
      const finalEnd = Number.isNaN(end.getTime()) || end < start ? start : end
      const cursor = new Date(start)
      let n = 0
      while (cursor <= finalEnd && n < 60) {
        const k = cursor.toISOString().slice(0, 10)
        map[k] = (map[k] || 0) + 1
        cursor.setUTCDate(cursor.getUTCDate() + 1)
        n += 1
      }
    }
    return map
  }, [events, todayIso])

  const monthLabel = `${MONTH_LABELS_PT[days[0].getMonth()]} ${days[0].getFullYear()}`

  function handleTap(key) {
    if (selectedDay === key) onSelectDay?.(null)
    else onSelectDay?.(key)
  }

  return (
    <div style={{ padding: '4px 16px 8px' }}>
      {/* Header — month + week nav */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <button onClick={() => setWeekOffset(o => o - 1)} style={navBtn}>‹</button>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
          {monthLabel}
          {weekOffset !== 0 && (
            <button
              onClick={() => setWeekOffset(0)}
              style={{
                marginLeft: 8, fontSize: 10, color: 'var(--terra)',
                background: 'var(--terra-pale)', border: 'none', borderRadius: 6,
                padding: '2px 8px', cursor: 'pointer', fontWeight: 600,
              }}
            >
              Hoje
            </button>
          )}
        </div>
        <button onClick={() => setWeekOffset(o => o + 1)} style={navBtn}>›</button>
      </div>

      {/* Day cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {days.map(day => {
          const key = dateKey(day)
          const today = isToday(day)
          const selected = key === selectedDay
          const count = countsByDay[key] || 0
          const hasEvents = count > 0
          const youGoing = rsvpDays?.has(key)
          const friendsGoing = friendDays?.has(key)

          return (
            <button
              key={key}
              onClick={() => handleTap(key)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                padding: '6px 0 5px', borderRadius: 12, cursor: 'pointer',
                background: selected ? 'var(--terra)' : today ? 'var(--cream)' : 'transparent',
                border: today && !selected ? '1.5px solid var(--terra)'
                      : selected ? '1.5px solid var(--terra)'
                      : '1.5px solid transparent',
                transition: 'all 0.15s',
              }}
            >
              <div style={{
                fontSize: 10, fontWeight: 600,
                color: selected ? 'rgba(255,255,255,0.75)' : 'var(--charcoal-light)',
                marginBottom: 1,
              }}>
                {DAY_LABELS_PT[day.getDay()]}
              </div>
              <div style={{
                fontSize: 16, fontWeight: 700,
                color: selected ? 'white' : today ? 'var(--terra)' : 'var(--charcoal)',
                lineHeight: 1.1,
              }}>
                {day.getDate()}
              </div>
              <div style={{
                marginTop: 3, height: 14,
                fontSize: 9, fontWeight: 700,
                color: selected ? 'white'
                     : hasEvents ? 'var(--terra)'
                     : 'transparent',
                background: selected ? 'rgba(255,255,255,0.22)'
                          : hasEvents ? 'var(--terra-pale)'
                          : 'transparent',
                padding: hasEvents ? '1px 6px' : 0,
                borderRadius: 6,
                minWidth: hasEvents ? 18 : 0,
                lineHeight: 1.2,
              }}>
                {hasEvents ? count : ''}
              </div>
              {/* Social dots — sage = you RSVPed, blue = friends going.
                  Reserve the row height even when empty so cells stay
                  aligned. The recurring-routine dot was dropped: the
                  count badge now includes routines, and users who want
                  to filter them out toggle "Só únicos" on the price row. */}
              <div style={{
                display: 'flex', gap: 3, marginTop: 3, height: 6,
              }}>
                {youGoing && (
                  <div
                    title="Você confirmou"
                    style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: selected ? 'var(--sage-light)' : 'var(--sage)',
                    }}
                  />
                )}
                {friendsGoing && (
                  <div
                    title="Amigos vão"
                    style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: selected ? '#B0CCEF' : '#5B8DD9',
                    }}
                  />
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const navBtn = {
  width: 28, height: 28, borderRadius: 8, border: '1px solid var(--border)',
  background: 'white', cursor: 'pointer', fontSize: 14, fontWeight: 700,
  color: 'var(--charcoal-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
