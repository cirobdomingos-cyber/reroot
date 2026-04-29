// Shared "today" anchor for the events app. The user's mental "today"
// only flips at 06:00 local — between 00:00 and 05:59 we treat the
// previous calendar day as today. A show that ends at 02:00 stays on
// the same column the user was looking at when they made the plan,
// and the events list keeps that day's events visible until morning
// instead of clearing out at midnight.
//
// Used by:
//   - api.js dropPastEvents — keep yesterday's late events visible
//     in the catalog until 06:00.
//   - WeekCalendar / EventsWeekStrip — date strip's "today" column.
//   - Events.jsx "Hoje" / "Próx 7 dias" range filters.

export function getAnchorToday() {
  const now = new Date()
  if (now.getHours() < 6) {
    now.setDate(now.getDate() - 1)
  }
  now.setHours(0, 0, 0, 0)
  return now
}

export function getAnchorTodayIso() {
  const t = getAnchorToday()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}
