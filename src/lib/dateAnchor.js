// Shared "today" for the events app: the calendar day in Curitiba
// (America/Sao_Paulo), whatever timezone the device is set to.
//
// History: until Oct 2026 "today" only flipped at 06:00 device-local
// time, so a show ending at 02:00 stayed visible. The cost was that at
// 03:20 on Wednesday the strip opened on Tuesday and listed Tuesday's
// events first. Now the strip opens on the real day, and the late show
// stays visible a different way: an event that is still running
// (isOngoing) counts as covering today.
//
// Feed quirk: dateStart / dateEnd carry Curitiba wall-clock time with a
// "+00:00" suffix (an event at 21h reads "...T21:00:00+00:00"; see
// scripts/social/select.mjs). Date.parse() would shift those by the
// device offset, so every comparison here works in "wall-clock ms":
// the Curitiba date and time read as if it were UTC. wallTs() turns a
// feed string into that scale, cityNowWallTs() turns the current
// instant into it.
//
// Used by:
//   - api.js dropPastEvents — keep today's and still-running events.
//   - WeekCalendar / EventsWeekStrip — date strip's "today" column.
//   - Events.jsx day filter, sort floor and "Hoje" / "Próx 7 dias".

export const CITY_TZ = 'America/Sao_Paulo'

const DAY_MS = 86_400_000

// How long an event without a dateEnd is assumed to run. Most catalog
// nights have no end time; six hours keeps a 22:00 show "ongoing" until
// 04:00 the next morning, which is what the old 06:00 rule protected.
export const IMPLICIT_DURATION_MS = 6 * 3_600_000

const cityParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: CITY_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
})

function partsOf(now) {
  const out = {}
  for (const p of cityParts.formatToParts(now)) out[p.type] = Number(p.value)
  return out
}

/** Current instant as Curitiba wall-clock ms (see header). */
export function cityNowWallTs(now = new Date()) {
  const p = partsOf(now)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
}

/** Today's date in Curitiba as 'YYYY-MM-DD'. */
export function cityTodayIso(now = new Date()) {
  return new Date(cityNowWallTs(now)).toISOString().slice(0, 10)
}

/** Midnight that starts today in Curitiba, in wall-clock ms. */
export function cityTodayStartWallTs(now = new Date()) {
  return Date.parse(`${cityTodayIso(now)}T00:00:00Z`)
}

/**
 * Feed date string -> wall-clock ms, ignoring any offset suffix.
 * "2026-10-14T21:00:00+00:00" and "2026-10-14T21:00" both read 21:00 on
 * the 14th. Date-only strings read midnight. NaN when unparseable.
 */
export function wallTs(iso) {
  if (!iso || typeof iso !== 'string') return NaN
  const date = iso.slice(0, 10)
  const time = /^\d{2}:\d{2}/.test(iso.slice(11, 16)) ? iso.slice(11, 16) : '00:00'
  return Date.parse(`${date}T${time}:00Z`)
}

/**
 * Wall-clock ms at which an event stops being relevant: its dateEnd when
 * given (a date-only end covers that whole day), else start + the
 * implicit duration. NaN when there is no usable start.
 */
export function eventEndWallTs(ev) {
  const start = wallTs(ev?.dateStart)
  if (Number.isNaN(start)) return NaN
  if (ev.dateEnd) {
    let end = wallTs(ev.dateEnd)
    if (!Number.isNaN(end) && ev.dateEnd.length <= 10) end += DAY_MS - 1
    if (!Number.isNaN(end) && end >= start) return end
  }
  return start + IMPLICIT_DURATION_MS
}

/** True when the event has started and has not ended yet. */
export function isOngoing(ev, now = new Date()) {
  if (!ev || ev.isRecurring) return false
  const start = wallTs(ev.dateStart)
  if (Number.isNaN(start)) return false
  const nowTs = cityNowWallTs(now)
  return start <= nowTs && nowTs < eventEndWallTs(ev)
}

/**
 * True when `dayIso` (YYYY-MM-DD) falls within an event's coverage:
 *   - One-off: its dateStart's day.
 *   - Range:   dateStart ≤ dayIso ≤ dateEnd (inclusive both ends).
 *   - Recurring: dayIso's weekday is in recurrenceDays (ISO 1=Mon..7=Sun)
 *     and dayIso is not before today.
 *   - Ongoing: anything still running right now also covers today, so
 *     last night's 22:00 show is listed under today at 03:00.
 *
 * Used by both the per-day pick filter and the week-strip count so the
 * badge on a day always matches the list that day opens.
 */
export function eventCoversDay(ev, dayIso, now = new Date()) {
  if (!dayIso || !ev) return false
  const todayIso = cityTodayIso(now)
  if (ev.isRecurring && Array.isArray(ev.recurrenceDays) && ev.recurrenceDays.length) {
    const d = new Date(`${dayIso}T00:00:00Z`)
    if (Number.isNaN(d.getTime())) return false
    // getUTCDay: 0=Sun..6=Sat. Convert to ISO 1=Mon..7=Sun.
    const isoDow = ((d.getUTCDay() + 6) % 7) + 1
    if (!ev.recurrenceDays.includes(isoDow)) return false
    return dayIso >= todayIso
  }
  const start = (ev.dateStart || '').slice(0, 10)
  if (!start) return false
  const end = (ev.dateEnd || '').slice(0, 10) || start
  if (dayIso >= start && dayIso <= end) return true
  return dayIso === todayIso && isOngoing(ev, now)
}

/**
 * Today in Curitiba as a device-local Date at 00:00, for code that walks
 * days with setDate()/getDay(). Only its year/month/day are meaningful;
 * never compare its getTime() with event timestamps (use the wall-clock
 * helpers above).
 */
export function getAnchorToday(now = new Date()) {
  const [y, m, d] = cityTodayIso(now).split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function getAnchorTodayIso(now = new Date()) {
  return cityTodayIso(now)
}
