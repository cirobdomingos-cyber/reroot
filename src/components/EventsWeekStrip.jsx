import { useState, useMemo } from 'react'
import { getAnchorToday, eventCoversDay } from '../lib/dateAnchor'

const DAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MONTH_LABELS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

function getWeekDays(offset = 0) {
  // Rolling 7-day window starting on today in Curitiba
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
  // Today in Curitiba (lib/dateAnchor), whatever the device timezone.
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

  // Count per visible day with the same eventCoversDay the list filter
  // uses, so the badge on a day always matches the list that day opens:
  // one-offs on their day, ranges on every day of the run, recurring
  // residencies on matching weekdays from today on, and anything still
  // running (last night's show at 03:00) on today.
  const dayKeysSig = days.map(dateKey).join(',')
  const countsByDay = useMemo(() => {
    const map = {}
    for (const key of dayKeysSig.split(',')) {
      let n = 0
      for (const ev of events) if (eventCoversDay(ev, key)) n += 1
      map[key] = n
    }
    return map
  }, [events, dayKeysSig])

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
              data-day={key}
              aria-current={today ? 'date' : undefined}
              aria-pressed={selected}
              onClick={() => handleTap(key)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                padding: '6px 0 5px', borderRadius: 12, cursor: 'pointer',
                // On the dark Neon Boteco shell, the previous --cream
                // highlight for "today" landed on the same color as the
                // page bg and disappeared — today's cell ended up
                // looking identical to the rest. Faint magenta wash
                // makes today readable without competing with the
                // selected (solid magenta) state.
                background: selected ? 'var(--magenta)'
                          : today ? 'rgba(255, 43, 214, 0.10)'
                          : 'transparent',
                border: today && !selected ? '1.5px solid var(--magenta)'
                      : selected ? '1.5px solid var(--magenta)'
                      : '1.5px solid transparent',
                transition: 'all 0.15s',
              }}
            >
              <div style={{
                fontSize: 10, fontWeight: 600,
                // Selected = dark text on magenta, today = magenta text
                // on faint wash, neutral = text2 (visible muted on dark).
                color: selected ? '#14081E'
                     : today ? 'var(--magenta)'
                     : 'var(--text2)',
                marginBottom: 1,
              }}>
                {DAY_LABELS_PT[day.getDay()]}
              </div>
              <div style={{
                fontSize: 16, fontWeight: 700,
                color: selected ? '#14081E'
                     : today ? 'var(--magenta)'
                     : 'var(--text)',
                lineHeight: 1.1,
                textShadow: today && !selected ? '0 0 8px rgba(255, 43, 214, 0.5)' : 'none',
              }}>
                {day.getDate()}
              </div>
              <div style={{
                marginTop: 3, height: 14,
                fontSize: 9, fontWeight: 700,
                // Today always renders the badge — even at 0 — so the
                // cell looks structurally complete next to the
                // populated future days. Without this, today looked
                // visually broken when the catalog had no Sunday
                // events. Empty state uses muted text on bg2 so it
                // reads as "0, no events today" rather than competing
                // with the populated days. Other days hide the badge
                // when count=0 to keep the strip tight.
                color: selected ? '#14081E'
                     : hasEvents ? '#14081E'
                     : today ? 'var(--text3)'
                     : 'transparent',
                background: selected ? 'rgba(20, 8, 30, 0.25)'
                          : hasEvents ? 'var(--magenta)'
                          : today ? 'var(--bg2)'
                          : 'transparent',
                border: today && !hasEvents && !selected ? '1px solid var(--line)' : 'none',
                padding: (hasEvents || today) ? '1px 6px' : 0,
                borderRadius: 6,
                minWidth: (hasEvents || today) ? 18 : 0,
                lineHeight: 1.2,
              }}>
                {hasEvents ? count : today ? '0' : ''}
              </div>
              {/* Social dots — lime = you RSVPed, cyan = friends going.
                  Reserve the row height even when empty so cells stay
                  aligned. Bumped to 7px with a subtle glow so they stay
                  glanceable on the Neon Boteco dark shell. */}
              <div style={{
                display: 'flex', gap: 4, marginTop: 4, height: 7,
              }}>
                {youGoing && (
                  <div
                    title="Você confirmou"
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: 'var(--lime)',
                      boxShadow: selected ? 'none' : '0 0 6px rgba(198, 255, 0, 0.6)',
                    }}
                  />
                )}
                {friendsGoing && (
                  <div
                    title="Amigos vão"
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: 'var(--cyan)',
                      boxShadow: selected ? 'none' : '0 0 6px rgba(0, 229, 255, 0.6)',
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
  background: 'var(--white)', cursor: 'pointer', fontSize: 14, fontWeight: 700,
  color: 'var(--charcoal-mid)', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
