import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { syncRsvp, fetchFriendsFeed, fetchUserGroupEvents } from '../services/api'
import Avatar from '../components/Avatar'

// All RSVPs in one place — yours + your friends'.
//
// Sections:
//   - Amigos vão     (events friends RSVPd to, that you haven't yet)
//   - Pendentes      (group events + personal plans you were invited to but
//                     haven't confirmed — drives "I got invited, what now?"
//                     discovery so plans don't get lost in the catalog)
//   - Próximos       (your upcoming RSVPs)
//   - Passados       (your past RSVPs)
//   - Sem data       (legacy entries without metadata — pre-rebrand
//                     rsvps that were never re-confirmed; cleanable)

export default function MyRsvps() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const now = Date.now()

  // Friends' RSVPs + group/plan invitations — fetched on mount + when the
  // tab regains focus. groupEvents covers both classic group events (member
  // of a group) and personal plans (invited by friend) since the backend
  // unions them under /events/group.
  const [friendsFeed, setFriendsFeed] = useState([])
  const [groupEvents, setGroupEvents] = useState([])
  useEffect(() => {
    const googleId = state.googleUser?.id
    if (!googleId) return
    let cancelled = false
    function load() {
      fetchFriendsFeed(googleId).then(events => {
        if (cancelled) return
        setFriendsFeed(events.filter(ev => ev.friends_going?.length > 0))
      })
      fetchUserGroupEvents(googleId).then(events => {
        if (!cancelled) setGroupEvents(events || [])
      })
    }
    load()
    function onVisible() {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible) }
  }, [state.googleUser?.id])

  // Build a lookup of group/personal-plan metadata so each RSVP entry
  // can be tagged with its origin type (public catalog vs personal-plan
  // invite vs classic group event). The /events/group fetch above
  // already returns the user's invitations + member-of-group events.
  const groupEventsById = Object.fromEntries(groupEvents.map(ev => [ev.id, ev]))

  function classify(id) {
    const ge = groupEventsById[id]
    if (!ge) return 'public'  // catalog event (or anything not in our private feed)
    if (ge.isPersonalPlan) return 'plan'
    return 'group'
  }

  const entries = Object.entries(state.rsvps).map(([id, info]) => ({
    id,
    name: info?.name || '',
    venue: info?.venue || '',
    dateStart: info?.dateStart || '',
    parsed: info?.dateStart ? Date.parse(info.dateStart) : NaN,
    kind: classify(id),
  }))

  const upcoming = entries.filter(e => !Number.isNaN(e.parsed) && e.parsed > now)
                          .sort((a, b) => a.parsed - b.parsed)
  const past     = entries.filter(e => !Number.isNaN(e.parsed) && e.parsed <= now)
                          .sort((a, b) => b.parsed - a.parsed)
  const undated  = entries.filter(e => Number.isNaN(e.parsed))

  // Favorited venues — distinct from RSVPs. Stored per place id with the
  // minimum metadata needed to render a row + open the venue detail.
  const favoritePlaces = Object.entries(state.favorites || {}).map(([id, info]) => ({
    id, ...info,
  }))

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

  // Pending invitations — group events you're a member of OR personal plans
  // where you were invited, that you haven't RSVP'd to yet. Future-dated only.
  // The same backend endpoint returns both shapes, already filtered by
  // membership/invitee gates, so we just need to filter out already-RSVP'd
  // and past events here.
  const pending = groupEvents
    .filter(ev => !state.rsvps[ev.id])
    .filter(ev => {
      const t = ev.dateStart ? Date.parse(ev.dateStart) : NaN
      return !Number.isNaN(t) && t > now
    })
    .sort((a, b) => Date.parse(a.dateStart) - Date.parse(b.dateStart))

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
          {entries.length === 0 && friendsUpcoming.length === 0 && pending.length === 0
            ? 'Você ainda não confirmou nenhum evento.'
            : `${pending.length ? `${pending.length} pendente${pending.length === 1 ? '' : 's'} · ` : ''}${upcoming.length} confirmado${upcoming.length === 1 ? '' : 's'}${friendsUpcoming.length ? ` · ${friendsUpcoming.length} de amigos` : ''}${past.length ? ` · ${past.length} passado${past.length === 1 ? '' : 's'}` : ''}${undated.length ? ` · ${undated.length} sem data` : ''}.`}
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

      {entries.length === 0 && friendsUpcoming.length === 0 && pending.length === 0 && (
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

      {pending.length > 0 && (
        <Section title={`Pendentes · ${pending.length}`}>
          {pending.map(ev => (
            <PendingRow
              key={ev.id}
              event={ev}
              onOpen={() => openEvent({ id: ev.id })}
            />
          ))}
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section title={`Confirmados · ${upcoming.length}`}>
          {upcoming.map(e => (
            <RsvpRow key={e.id} entry={e} onOpen={openEvent} onCancel={unRsvp} />
          ))}
        </Section>
      )}

      {favoritePlaces.length > 0 && (
        <Section title={`♥ Lugares favoritos · ${favoritePlaces.length}`}>
          {favoritePlaces.map(place => (
            <div
              key={place.id}
              onClick={() => navigate('/events', { state: { openEventId: place.id } })}
              style={{
                background: 'white', borderRadius: 14, padding: '12px 14px',
                border: '1px solid var(--border)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 12,
              }}
            >
              <div style={{
                width: 38, height: 38, borderRadius: 11, flexShrink: 0,
                background: place.headerBg || 'var(--cream)', fontSize: 18,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {place.icon || '♥'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {place.name || place.id}
                </div>
                {place.venue && (
                  <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
                    {place.venue}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (!confirm(`Remover "${place.name || place.id}" dos favoritos?`)) return
                  dispatch({ type: 'TOGGLE_FAVORITE', payload: { placeId: place.id } })
                }}
                title="Remover dos favoritos"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 18, color: '#E91E63', padding: 6,
                }}
              >
                ♥
              </button>
            </div>
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

function PendingRow({ event: ev, onOpen }) {
  // Pending invite — surfaces personal plans + group events you haven't
  // RSVP'd to yet. Distinct visual: warm peach left stripe + "Convite"
  // pill so it reads as "needs your attention" vs the neutral upcoming
  // RSVPs below it. Tapping opens the event detail; the user can RSVP
  // there and the row will graduate to the Próximos section on next render.
  const dateLabel = formatDate(ev.dateStart) || ''
  const isPlan = ev.isPersonalPlan
  return (
    <div
      onClick={onOpen}
      style={{
        background: 'white', borderRadius: 14, padding: '12px 14px',
        border: '1px solid var(--border)',
        boxShadow: 'inset 4px 0 0 var(--terra)',
        display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 9, fontWeight: 700, color: 'var(--terra)',
            background: 'var(--terra-pale)', padding: '2px 7px',
            borderRadius: 4, letterSpacing: 0.4, textTransform: 'uppercase',
            flexShrink: 0,
          }}>
            {isPlan ? '🎲 Convite' : '👥 Grupo'}
          </span>
          <div style={{
            fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {ev.name || `Evento ${ev.id}`}
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 3 }}>
          {dateLabel}{ev.venue ? ` · ${ev.venue}` : ''}
        </div>
      </div>
      <span style={{ fontSize: 12, color: 'var(--charcoal-light)', flexShrink: 0 }}>›</span>
    </div>
  )
}


// Small kind badges — let the user tell at a glance what kind of event
// they confirmed: catalog (public), invited plan, or group event. Color
// matches the source elsewhere in the app: terra=plan/invite (warm
// scarcity), sage=group (calm/private), neutral=public.
const KIND_META = {
  plan:   { label: 'Convite',  icon: '🎲', bg: 'var(--terra-pale)',         color: 'var(--terra)' },
  group:  { label: 'Grupo',    icon: '👥', bg: 'var(--sage-pale)',          color: 'var(--sage)' },
  public: { label: 'Público',  icon: '🌍', bg: 'rgba(44,44,44,0.06)',       color: 'var(--charcoal-mid)' },
}

function KindBadge({ kind }) {
  const meta = KIND_META[kind] || KIND_META.public
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
      color: meta.color, background: meta.bg,
      padding: '2px 7px', borderRadius: 5,
      textTransform: 'uppercase', flexShrink: 0,
    }}>
      <span style={{ fontSize: 10 }}>{meta.icon}</span>
      {meta.label}
    </span>
  )
}

function RsvpRow({ entry, onOpen, onCancel, muted, undated }) {
  const dateLabel = formatDate(entry.dateStart) || (undated ? '— sem data' : '')
  // Highlight kind via a subtle inset stripe matching the badge color.
  // Picks up the same visual language as group events / personal plans
  // elsewhere in the app, so the row's origin reads at a glance.
  const stripeColor = entry.kind === 'plan' ? 'var(--terra)'
                    : entry.kind === 'group' ? 'var(--sage)'
                    : 'transparent'
  return (
    <div
      onClick={() => onOpen(entry)}
      style={{
        background: 'white', borderRadius: 14, padding: '12px 14px',
        border: '1px solid var(--border)',
        boxShadow: stripeColor !== 'transparent' ? `inset 4px 0 0 ${stripeColor}` : 'none',
        display: 'flex', alignItems: 'center', gap: 12,
        opacity: muted ? 0.7 : 1, cursor: 'pointer',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          marginBottom: 2,
        }}>
          {entry.kind && <KindBadge kind={entry.kind} />}
          <div style={{
            fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            flex: 1, minWidth: 0,
          }}>
            {entry.name || `Evento ${entry.id}`}
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
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
