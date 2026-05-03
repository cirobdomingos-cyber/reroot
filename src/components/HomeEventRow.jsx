// Shared event row used across Home + RSVPs surfaces. Implements the
// NeonRow component from the Neon Boteco direction: date column on the
// left (chunky display number with accent-color glow), title + mono
// metadata in the middle, optional trailing slot on the right.
//
// Accent color is picked per-row to create rhythm in the list. Group
// events get lime, ongoing events get cyan, one-off events get magenta —
// reuses the "kind" signal the previous row used to tint the day number.

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

const _ACCENT_GLOW = {
  'var(--cyan)':    'rgba(0, 229, 255, 0.7)',
  'var(--magenta)': 'rgba(255, 43, 214, 0.7)',
  'var(--lime)':    'rgba(198, 255, 0, 0.7)',
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
  const isOngoing = (isRecurring || isMultiDayRange) && !isGroupEvent
  // Per-kind accent. Group → lime ("// CONFIRMADOS" feel), ongoing → cyan
  // ("browse" feel), one-off → magenta (brand glow). Featured events
  // override to magenta so the auê pick stands out in any section.
  const accent = featured
    ? 'var(--magenta)'
    : isGroupEvent ? 'var(--lime)'
    : isOngoing ? 'var(--cyan)'
    : 'var(--magenta)'
  const glow = _ACCENT_GLOW[accent] || _ACCENT_GLOW['var(--magenta)']
  return (
    <div
      onClick={onClick}
      className="neon-card"
      style={{
        padding: 14,
        display: 'flex', alignItems: 'center', gap: 14,
        cursor: onClick ? 'pointer' : 'default',
        opacity: muted ? 0.55 : 1,
      }}
    >
      <div style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', minWidth: 44, flexShrink: 0,
      }}>
        <span
          className="neon-display"
          style={{
            fontSize: 30, lineHeight: 1,
            color: accent,
            textShadow: `0 0 12px ${glow}`,
          }}
        >
          {day}
        </span>
        <span
          className="neon-mono"
          style={{
            fontSize: 9, marginTop: 2,
            color: 'var(--text3)',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}
        >
          {weekday}
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="neon-display"
          style={{
            fontSize: 17, lineHeight: 1.15,
            color: 'var(--text)',
            display: 'flex', alignItems: 'center', gap: 6,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {featured && (
            <span title="Destaque auê" className="neon-pill" style={{
              color: 'var(--magenta)',
              padding: '2px 6px', fontSize: 9, letterSpacing: '0.16em',
              flexShrink: 0,
            }}>★</span>
          )}
          {isGroupEvent && (
            <span style={{ flexShrink: 0, color: 'var(--lime)' }}>◌</span>
          )}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {name}
          </span>
        </div>
        <div
          className="neon-mono"
          style={{
            fontSize: 11, color: 'var(--text2)',
            marginTop: 4, letterSpacing: '0.04em',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
        >
          {time}
          {time && venue && (
            <span style={{ color: 'var(--text3)' }}> :: </span>
          )}
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
