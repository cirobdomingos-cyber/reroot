import { useNavigate } from 'react-router-dom'

// "Dos teus canais" — a band above the catalog, not a merge into it.
//
// The ask was for a followed channel's events to sort first. Mixing
// them into the list and floating them to the top does that, and buries
// the city for anyone following three channels: the first screenful
// stops being Curitiba and becomes whatever we curated. A band gets the
// same prominence for a fixed amount of room, and the catalog below
// stays exactly what it was.
//
// Horizontal, so length doesn't cost vertical space — six channel
// events take the same height as two.
//
// Hides itself entirely when empty, which is also what an unfollowed
// account sees, so nobody gets an empty shelf explaining a feature they
// haven't opted into.
// Takes its events as a prop now. Eventos fetches the channel feed
// once and uses it twice — for this band, and to mark the catalog rows
// that came from a channel you follow. Fetching it in both places
// would have been two calls for one answer, and two chances for them
// to disagree.
export default function ChannelBand({ events = [] }) {
  const navigate = useNavigate()

  if (events.length === 0) return null

  return (
    <div style={{ margin: '4px 0 18px' }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        padding: '0 16px', marginBottom: 10,
      }}>
        <h2 className="neon-mono" style={{
          fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
          color: 'var(--magenta)', margin: 0,
        }}>
          Dos teus canais
        </h2>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>{events.length}</span>
      </div>

      <div style={{
        display: 'flex', gap: 10, overflowX: 'auto', padding: '0 16px 4px',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
      }}>
        {events.map(ev => (
          <button
            key={ev.id}
            onClick={() => navigate('/events', { state: { openEventId: ev.id } })}
            style={{
              flex: '0 0 auto', width: 190, textAlign: 'left', cursor: 'pointer',
              background: 'var(--bg2)', border: '1px solid var(--line)',
              borderRadius: 14, padding: '11px 12px',
              // Same magenta edge the channel rows use, so the band and
              // the channel list read as one thing.
              boxShadow: 'inset 3px 0 0 var(--magenta)',
            }}
          >
            <span className="neon-mono" style={{
              display: 'block', fontSize: 9, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--magenta)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {ev.groupName || 'Canal'}
            </span>
            <span style={{
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              overflow: 'hidden', marginTop: 4,
              fontSize: 13, fontWeight: 700, color: 'var(--text)', lineHeight: 1.3,
            }}>
              {ev.name}
            </span>
            <span style={{
              display: 'block', fontSize: 11, color: 'var(--text2)', marginTop: 3,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {ev.date}{ev.time ? ` · ${ev.time}` : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
