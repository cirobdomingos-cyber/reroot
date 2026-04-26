import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { syncRsvp, fetchFriendsFeed } from '../services/api'
import Avatar from '../components/Avatar'

// All RSVPs in one place — yours + your friends'.
//
// Sections:
//   - Amigos vão     (events friends RSVPd to, that you haven't yet)
//   - Próximos       (your upcoming RSVPs)
//   - Passados       (your past RSVPs)
//   - Sem data       (legacy entries without metadata — pre-rebrand
//                     rsvps that were never re-confirmed; cleanable)

export default function MyRsvps() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const now = Date.now()

  // Friends' RSVPs — fetched on mount + when the tab regains focus.
  const [friendsFeed, setFriendsFeed] = useState([])
  useEffect(() => {
    const googleId = state.googleUser?.id
    if (!googleId) return
    let cancelled = false
    function load() {
      fetchFriendsFeed(googleId).then(events => {
        if (cancelled) return
        setFriendsFeed(events.filter(ev => ev.friends_going?.length > 0))
      })
    }
    load()
    function onVisible() {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible) }
  }, [state.googleUser?.id])

  const entries = Object.entries(state.rsvps).map(([id, info]) => ({
    id,
    name: info?.name || '',
    venue: info?.venue || '',
    dateStart: info?.dateStart || '',
    parsed: info?.dateStart ? Date.parse(info.dateStart) : NaN,
  }))

  const upcoming = entries.filter(e => !Number.isNaN(e.parsed) && e.parsed > now)
                          .sort((a, b) => a.parsed - b.parsed)
  const past     = entries.filter(e => !Number.isNaN(e.parsed) && e.parsed <= now)
                          .sort((a, b) => b.parsed - a.parsed)
  const undated  = entries.filter(e => Number.isNaN(e.parsed))

  // Friend RSVPs — backend returns event_id/event_name/event_venue/event_date
  // (the friends_feed shape, not the catalog shape). Exclude events the user
  // already RSVPd to (already in "Próximos") and any without future dates.
  const friendsUpcoming = friendsFeed
    .filter(ev => !state.rsvps[ev.event_id])
    .filter(ev => {
      const t = ev.event_date ? Date.parse(ev.event_date) : NaN
      return !Number.isNaN(t) && t > now
    })
    .sort((a, b) => Date.parse(a.event_date) - Date.parse(b.event_date))

  function unRsvp(entry) {
    if (!confirm(`Cancelar RSVP de "${entry.name || entry.id}"?`)) return
    dispatch({
      type: 'TOGGLE_RSVP',
      payload: { eventId: entry.id, dateStart: entry.dateStart, name: entry.name, venue: entry.venue },
    })
    if (state.googleUser?.id) {
      syncRsvp(state.googleUser.id, {
        id: entry.id,
        name: entry.name,
        venue: entry.venue,
        dateStart: entry.dateStart,
        url: '',
      }, false)
    }
  }

  function openEvent(entry) {
    navigate('/events', { state: { openEventId: entry.id } })
  }

  return (
    <div style={{ padding: '20px 0 80px' }}>
      <div style={{ padding: '0 20px 14px' }}>
        <button
          onClick={() => navigate('/home')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--charcoal-light)', fontSize: 13, padding: '4px 0', marginBottom: 8,
          }}
        >
          ← Voltar
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>RSVPs</h1>
        <div style={{ fontSize: 13, color: 'var(--charcoal-light)', marginTop: 2 }}>
          {entries.length === 0 && friendsUpcoming.length === 0
            ? 'Você ainda não confirmou nenhum evento.'
            : `${upcoming.length} seu${upcoming.length === 1 ? '' : 's'}${friendsUpcoming.length ? ` · ${friendsUpcoming.length} de amigos` : ''}${past.length ? ` · ${past.length} passado${past.length === 1 ? '' : 's'}` : ''}${undated.length ? ` · ${undated.length} sem data` : ''}.`}
        </div>
      </div>

      {friendsUpcoming.length > 0 && (
        <Section title={`Amigos vão · ${friendsUpcoming.length}`}>
          {friendsUpcoming.map(ev => (
            <FriendEventRow
              key={ev.event_id}
              event={ev}
              onOpen={() => navigate('/events', { state: { openEventId: ev.event_id } })}
              onFriend={(gid) => navigate(`/friends/${encodeURIComponent(gid)}`)}
            />
          ))}
        </Section>
      )}

      {entries.length === 0 && friendsUpcoming.length === 0 && (
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📅</div>
          <div style={{ fontSize: 14, color: 'var(--charcoal-mid)', marginBottom: 20 }}>
            Quando você clicar "Vou!" em algum evento, ele aparece aqui.
            Eventos dos seus amigos também.
          </div>
          <button
            onClick={() => navigate('/events')}
            style={{
              padding: '12px 24px', borderRadius: 12, border: 'none',
              background: 'var(--sage)', color: 'white',
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            Ver eventos →
          </button>
        </div>
      )}

      {upcoming.length > 0 && (
        <Section title={`Próximos · ${upcoming.length}`}>
          {upcoming.map(e => (
            <RsvpRow key={e.id} entry={e} onOpen={openEvent} onCancel={unRsvp} />
          ))}
        </Section>
      )}

      {past.length > 0 && (
        <Section title={`Passados · ${past.length}`} muted>
          {past.map(e => (
            <RsvpRow key={e.id} entry={e} onOpen={openEvent} onCancel={unRsvp} muted />
          ))}
        </Section>
      )}

      {undated.length > 0 && (
        <Section
          title={`Sem data · ${undated.length}`}
          muted
          help="RSVPs antigos sem metadata (de antes da última atualização). Pode limpar tocando 🗑."
        >
          {undated.map(e => (
            <RsvpRow key={e.id} entry={e} onOpen={openEvent} onCancel={unRsvp} muted undated />
          ))}
        </Section>
      )}
    </div>
  )
}


// ── Helpers ──────────────────────────────────────────────

function Section({ title, children, muted = false, help }) {
  return (
    <div style={{ margin: '8px 0 16px' }}>
      <div
        className="section-label"
        style={muted ? { color: 'var(--charcoal-light)' } : undefined}
      >
        {title}
      </div>
      {help && (
        <div style={{ fontSize: 11, color: 'var(--charcoal-light)', padding: '0 16px 6px', lineHeight: 1.4 }}>
          {help}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px' }}>
        {children}
      </div>
    </div>
  )
}

function FriendEventRow({ event: ev, onOpen, onFriend }) {
  const dateLabel = formatDate(ev.event_date) || ''
  const friends = ev.friends_going || []
  return (
    <div
      onClick={onOpen}
      style={{
        background: 'white', borderRadius: 14, padding: '12px 14px',
        border: '1px solid var(--border)', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {ev.event_name}
      </div>
      <div style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
        {dateLabel}{ev.event_venue ? ` · ${ev.event_venue}` : ''}
      </div>
      {friends.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <div style={{ display: 'flex' }}>
            {friends.slice(0, 4).map((f, i) => (
              <button
                key={f.google_id ?? i}
                onClick={(e) => {
                  e.stopPropagation()
                  if (f.google_id && onFriend) onFriend(f.google_id)
                }}
                disabled={!f.google_id}
                title={f.google_id ? `Ver eventos de ${f.name}` : f.name}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  marginLeft: i === 0 ? 0 : -8,
                  cursor: f.google_id ? 'pointer' : 'default',
                  borderRadius: '50%',
                }}
              >
                <Avatar name={f.name} src={f.picture} size={24} />
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--terra)' }}>
            {friends.length === 1
              ? `${friends[0].name} vai`
              : `${friends.length} amigos vão`}
          </div>
        </div>
      )}
    </div>
  )
}

function RsvpRow({ entry, onOpen, onCancel, muted, undated }) {
  const dateLabel = formatDate(entry.dateStart) || (undated ? '— sem data' : '')
  return (
    <div
      onClick={() => onOpen(entry)}
      style={{
        background: 'white', borderRadius: 14, padding: '12px 14px',
        border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12,
        opacity: muted ? 0.7 : 1, cursor: 'pointer',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {entry.name || `Evento ${entry.id}`}
        </div>
        <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
          {dateLabel}{entry.venue ? ` · ${entry.venue}` : ''}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onCancel(entry) }}
        title={undated ? 'Limpar RSVP antigo' : 'Cancelar RSVP'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 16, color: 'var(--charcoal-light)', padding: 6,
        }}
      >
        🗑
      </button>
    </div>
  )
}

const _PT_WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const _PT_MONTHS   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']

function formatDate(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return ''
  const wd = _PT_WEEKDAYS[d.getDay()]
  const mo = _PT_MONTHS[d.getMonth()]
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const yearSuffix = sameYear ? '' : ` ${d.getFullYear()}`
  const time = d.getHours() || d.getMinutes()
    ? ` · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : ''
  return `${wd}, ${d.getDate()} ${mo}${yearSuffix}${time}`
}
