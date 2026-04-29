import { useState, useMemo } from 'react'

const DAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MONTH_LABELS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

function getWeekDays(offset = 0) {
  const today = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + offset * 7)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isToday(d) {
  const t = new Date()
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

  // Two parallel signals per day:
  //
  //  1. countsByDay — one-offs only, +1 on dateStart per event. This is
  //     the BIG number on the day cell. Counts the time-sensitive
  //     stuff: shows / openings / festivals / things you'll miss.
  //  2. routineDays — Set of ISO days that have at least one recurring
  //     or multi-day-range event covering them. Rendered as a small
  //     🔁 dot on the day cell so the user knows "there's also a
  //     Thu/Fri/Sat residency tonight" without inflating the count.
  //
  // The list's per-day pick filter (eventCoversDay) still expands
  // routines + ranges onto every covered day, so tapping Friday surfaces
  // the Thu/Fri/Sat residency along with any one-offs that day.
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const { countsByDay, routineDays } = useMemo(() => {
    const counts = {}
    const routines = new Set()
    const horizon = new Date()
    horizon.setUTCDate(horizon.getUTCDate() + 60)
    for (const ev of events) {
      const isoStart = ev.dateStart || ev.date_start || ''
      if (!isoStart) continue
      const startKey = isoStart.slice(0, 10)
      const isoEnd = ev.dateEnd || ev.date_end || ''
      const endKey = isoEnd ? isoEnd.slice(0, 10) : ''
      const isRecurring = !!ev.isRecurring && Array.isArray(ev.recurrenceDays) && ev.recurrenceDays.length
      const isRange = endKey && endKey > startKey

      if (isRecurring) {
        // Mark every matching weekday in the next 60 days as a
        // routine-day. Doesn't touch counts.
        const cursor = new Date(`${todayIso}T00:00:00Z`)
        let n = 0
        while (cursor <= horizon && n < 60) {
          const isoDow = ((cursor.getUTCDay() + 6) % 7) + 1
          if (ev.recurrenceDays.includes(isoDow)) {
            routines.add(cursor.toISOString().slice(0, 10))
          }
          cursor.setUTCDate(cursor.getUTCDate() + 1)
          n += 1
        }
        continue
      }

      if (isRange) {
        // Multi-day range: count once on start (so the festival
        // "happens" the day it opens), mark every covered day as a
        // routine-day so the dot appears across the run.
        counts[startKey] = (counts[startKey] || 0) + 1
        const start = new Date(`${startKey}T00:00:00Z`)
        const end = new Date(`${endKey}T00:00:00Z`)
        if (Number.isNaN(start.getTime())) continue
        const finalEnd = Number.isNaN(end.getTime()) || end < start ? start : end
        const cursor = new Date(start)
        cursor.setUTCDate(cursor.getUTCDate() + 1)
        let n = 0
        while (cursor <= finalEnd && n < 60) {
          routines.add(cursor.toISOString().slice(0, 10))
          cursor.setUTCDate(cursor.getUTCDate() + 1)
          n += 1
        }
        continue
      }

      // Plain one-off — bumps the count on its single day.
      counts[startKey] = (counts[startKey] || 0) + 1
    }
    return { countsByDay: counts, routineDays: routines }
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
          const hasRoutine = routineDays.has(key)

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
              {/* Social/coverage dots — sage = you RSVPed, blue = friends
                  going, terra = there's a routine/range covering this
                  day (residencies, multi-day exhibitions). Reserve the
                  row height even when empty so day cells stay aligned. */}
              <div style={{
                display: 'flex', gap: 3, marginTop: 3, height: 6,
              }}>
                {hasRoutine && (
                  <div
                    title="Tem rotina/rolê fixo nesse dia"
                    style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: selected ? 'var(--terra-pale)' : 'var(--terra)',
                    }}
                  />
                )}
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
