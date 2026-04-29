// Shared row layout used across Home + RSVPs surfaces. Mirrors the
// Events tab EventCard: day number on the left (color-coded by kind),
// event name + single metadata row in the middle, optional trailing
// slot on the right (friend avatars, status badge, action button,
// etc). Slimmer than EventCard since these surfaces show several
// sections side by side.

const _PT_WEEKDAY = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']

function _dayLabels(iso) {
  if (!iso) return { day: '—', weekday: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { day: '—', weekday: '' }
  return {
    day: String(d.getDate()).padStart(2, '0'),
    weekday: _PT_WEEKDAY[d.getDay()] || '',
  }
}

export default function HomeEventRow({
  name,
  dateStart,
  dateEnd,        // optional ISO; used to detect multi-day-range events
  time,           // optional, "HH:MM"
  venue,          // pass already with " · bairro" if you have one
  isRecurring = false,
  isGroupEvent = false,
  featured = false,
  trailing = null,
  onClick,
  muted = false,
}) {
  const { day, weekday } = _dayLabels(dateStart)
  const dsKey = (dateStart || '').slice(0, 10)
  const deKey = (dateEnd || '').slice(0, 10)
  const isMultiDayRange = !!(deKey && dsKey && deKey > dsKey)
  // "Ongoing" = recurring OR multi-day range. Mirrors EventCard.
  const isOngoing = (isRecurring || isMultiDayRange) && !isGroupEvent
  // Mirrors EventCard: sage for group, honey for one-off,
  // terra-light blue for ongoing.
  const dayColor = isGroupEvent ? 'var(--sage)'
                 : isOngoing ? 'var(--terra-light)'
                 : 'var(--honey)'
  const stripe = isGroupEvent ? 'inset 3px 0 0 var(--sage)'
               : isOngoing ? 'none'
               : 'inset 3px 0 0 var(--honey)'
  return (
    <div
      onClick={onClick}
      style={{
        background: 'white', borderRadius: 12,
        border: '1px solid var(--border)',
        boxShadow: stripe,
        padding: '10px 13px',
        display: 'flex', alignItems: 'center', gap: 12,
        cursor: onClick ? 'pointer' : 'default',
        opacity: muted ? 0.65 : 1,
      }}
    >
      <div style={{
        flexShrink: 0, width: 38, textAlign: 'left',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          fontSize: 22, fontWeight: 800, lineHeight: 1,
          color: dayColor, letterSpacing: -0.5,
        }}>
          {day}
        </div>
        <div style={{
          fontSize: 9, fontWeight: 700, marginTop: 2,
          color: 'var(--charcoal-mid)', letterSpacing: 1,
        }}>
          {weekday}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--charcoal)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {featured && (
            <span title="Destaque auê" style={{
              fontSize: 9, fontWeight: 800, letterSpacing: 0.5, flexShrink: 0,
              color: 'var(--honey)', background: 'var(--honey-pale)',
              padding: '2px 6px', borderRadius: 999,
              border: '1px solid var(--honey)',
            }}>⭐</span>
          )}
          {isGroupEvent && <span style={{ flexShrink: 0 }}>🔒</span>}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </span>
        </div>
        <div style={{
          fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {time}
          {time && venue && <> · </>}
          {venue}
        </div>
      </div>
      {trailing && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {trailing}
        </div>
      )}
    </div>
  )
}
