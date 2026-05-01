import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { syncRsvp, fetchFriendsFeed, fetchUserGroupEvents, declineEventInvite, deletePersonalPlan, deleteGroupEvent } from '../services/api'
import Avatar from '../components/Avatar'
import HomeEventRow from '../components/HomeEventRow'

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

  // event_id → [{ name, picture, google_id }, ...] so each RsvpRow can
  // render the same friends-going avatar stack the Home calendar uses.
  // Same source data (friendsFeed) keyed for O(1) lookup per row.
  const friendsByEventId = Object.fromEntries(
    friendsFeed
      .filter(ev => ev.event_id && Array.isArray(ev.friends_going) && ev.friends_going.length)
      .map(ev => [ev.event_id, ev.friends_going])
  )

  function classify(id) {
    const ge = groupEventsById[id]
    if (!ge) return 'public'  // catalog event (or anything not in our private feed)
    if (ge.isPersonalPlan) return 'plan'
    // Group event imported from the public catalog (e.g. "Brasilidades
    // 13 Anos" added to a group) keeps the original URL in ge.url. The
    // source is public; the group context is incidental, so tag it
    // public. Native group-only events (no catalog source) have ge.url
    // empty and stay as 'group'.
    if (ge.url) return 'public'
    return 'group'
  }

  // Prefer fresh server data (groupEventsById) over the cached entry in
  // state.rsvps. The cache was populated at RSVP time and never updates
  // when the event is edited later — so without this, an edited event
  // still showed its old name/venue/date here forever.
  const entries = Object.entries(state.rsvps).map(([id, info]) => {
    const fresh = groupEventsById[id]
    return {
      id,
      name: fresh?.name || info?.name || '',
      venue: fresh?.venue || info?.venue || '',
      dateStart: fresh?.dateStart || fresh?.date_start || info?.dateStart || '',
      parsed: ((fresh?.dateStart || fresh?.date_start || info?.dateStart) || '')
        ? Date.parse(fresh?.dateStart || fresh?.date_start || info?.dateStart)
        : NaN,
      kind: classify(id),
    }
  })

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

  // Remove an event from the user's "My RSVPs" list. The right action
  // depends on the user's role for that event:
  //
  //   creator → DELETE the whole event (destructive — affects every
  //             invitee). Confirms with extra warning copy.
  //   invitee → DECLINE (remove self from extra_invitee_ids). Polite,
  //             affects only this user.
  //   catalog → just cancel the local RSVP. Catalog events have no
  //             invitee model.
  //
  // Without the creator branch, a creator who tapped trash kept seeing
  // their own event because they're seen via `created_by`, not via the
  // invitee list. Decline-self was a no-op for creators.
  function unRsvp(entry) {
    if (!state.googleUser?.id) return
    const googleId = state.googleUser.id
    const isGroupShape = typeof entry.id === 'string' && entry.id.startsWith('grp_ev_')
    const fresh = groupEventsById[entry.id]
    const isCreator = isGroupShape && fresh && (fresh.created_by === googleId || fresh.createdBy === googleId)
    const isCoHost = isGroupShape && fresh && (
      (fresh.co_host_ids || []).includes(googleId) ||
      (fresh.coHostIds || []).includes(googleId)
    )

    const prompt = isCreator
      ? `Apagar o evento "${entry.name || entry.id}"? Os convidados também perdem acesso.`
      : `Remover "${entry.name || entry.id}" da sua lista?`
    if (!confirm(prompt)) return

    // Local: drop the RSVP either way so the row updates immediately.
    dispatch({
      type: 'TOGGLE_RSVP',
      payload: { eventId: entry.id, dateStart: entry.dateStart, name: entry.name, venue: entry.venue },
    })
    syncRsvp(googleId, {
      id: entry.id,
      name: entry.name,
      venue: entry.venue,
      dateStart: entry.dateStart,
      url: '',
    }, false)

    if (!isGroupShape) return  // catalog event — nothing else to do

    // Creator (or co-host, who shares the destructive privilege) deletes
    // the event entirely. Personal plans and group events have different
    // delete endpoints.
    const action = isCreator || isCoHost
      ? () => fresh.group_id || fresh.groupId
        ? deleteGroupEvent(fresh.group_id || fresh.groupId, entry.id, googleId)
        : deletePersonalPlan(entry.id, googleId)
      : () => declineEventInvite(entry.id, googleId)

    action()
      .then(() => fetchUserGroupEvents(googleId))
      .then((events) => { if (events) setGroupEvents(events) })
      .catch(() => {})
  }

  // Decline-only flow for the Pendentes section — user never RSVP'd
  // to begin with, just remove them from the invitee list. Creators
  // never appear in Pendentes (they're auto-RSVP'd at create time)
  // so we don't need the role-aware branch here.
  function declineInvite(ev) {
    if (!confirm(`Recusar convite pra "${ev.name || ev.id}"?`)) return
    if (!state.googleUser?.id) return
    declineEventInvite(ev.id, state.googleUser.id).then(() =>
      fetchUserGroupEvents(state.googleUser.id),
    ).then((events) => {
      if (events) setGroupEvents(events)
    }).catch(() => {})
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
              kind={classify(ev.event_id)}
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
              onDecline={() => declineInvite(ev)}
            />
          ))}
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section title={`Confirmados · ${upcoming.length}`}>
          {upcoming.map(e => (
            <RsvpRow
              key={e.id}
              entry={e}
              friends={friendsByEventId[e.id] || []}
              onOpen={openEvent}
              onCancel={unRsvp}
            />
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

function FriendEventRow({ event: ev, kind = 'public', onOpen, onFriend }) {
  // Same HomeEventRow shape as Confirmados / Home — friend stack on the
  // right reads consistently across surfaces. Tapping a friend avatar
  // opens that friend's profile; tapping the row body opens the event.
  const time = (ev.event_date || '').slice(11, 16)
  const friends = ev.friends_going || []
  const trailing = friends.length > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {friends.slice(0, 3).map((f, i) => (
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
            borderRadius: '50%', boxShadow: '0 0 0 2px white',
          }}
        >
          <Avatar name={f.name} src={f.picture} size={22} />
        </button>
      ))}
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--terra)', marginLeft: 5 }}>
        {friends.length}
      </span>
    </div>
  ) : null
  return (
    <HomeEventRow
      name={ev.event_name}
      dateStart={ev.event_date}
      time={time}
      venue={ev.event_venue}
      isGroupEvent={kind === 'group' || kind === 'plan'}
      onClick={onOpen}
      trailing={trailing}
    />
  )
}

function PendingRow({ event: ev, onOpen, onDecline }) {
  // Pending invite — distinct from confirmed RSVPs by the terra
  // "Convite" pill. Trash button declines the invite (removes the
  // user from the event's invitee list) so the row vanishes — without
  // it, the only way out of a pending invite was to confirm + cancel,
  // which left the row bouncing back to pending.
  const time = (ev.dateStart || '').slice(11, 16)
  const isPlan = ev.isPersonalPlan
  const trailing = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, color: 'var(--terra)',
        background: 'var(--terra-pale)', padding: '4px 8px', borderRadius: 6,
        letterSpacing: 0.3,
      }}>
        {isPlan ? '🎲 Convite' : '👥 Grupo'}
      </span>
      {onDecline && (
        <button
          onClick={(e) => { e.stopPropagation(); onDecline() }}
          title="Recusar convite"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 14, color: 'var(--charcoal-light)', padding: 4,
          }}
        >
          🗑
        </button>
      )}
    </div>
  )
  return (
    <HomeEventRow
      name={ev.name || `Evento ${ev.id}`}
      dateStart={ev.dateStart}
      time={time}
      venue={ev.venue}
      isGroupEvent
      onClick={onOpen}
      trailing={trailing}
    />
  )
}


function RsvpRow({ entry, friends = [], onOpen, onCancel, muted, undated }) {
  // Extract the time-of-day off the ISO so HomeEventRow's meta line
  // shows it. The day number / weekday come from dateStart.
  const time = (entry.dateStart || '').slice(11, 16)
  const trailing = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {friends.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {friends.slice(0, 3).map((friend, i) => (
            <div
              key={(friend.google_id || friend.name) + i}
              style={{
                marginLeft: i === 0 ? 0 : -8,
                boxShadow: '0 0 0 2px white',
                borderRadius: '50%',
              }}
            >
              <Avatar name={friend.name} src={friend.picture} size={22} />
            </div>
          ))}
          <span style={{
            fontSize: 10, fontWeight: 700, color: 'var(--terra)',
            marginLeft: 5,
          }}>
            {friends.length}
          </span>
        </div>
      )}
      {!undated && (
        <span style={{
          fontSize: 10, fontWeight: 700, color: 'var(--sage)',
          background: 'var(--sage-pale)', padding: '4px 8px', borderRadius: 6,
        }}>
          Confirmado
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onCancel(entry) }}
        title={undated ? 'Limpar RSVP antigo' : 'Cancelar RSVP'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, color: 'var(--charcoal-light)', padding: 4,
        }}
      >
        🗑
      </button>
    </div>
  )
  return (
    <HomeEventRow
      name={entry.name || `Evento ${entry.id}`}
      dateStart={entry.dateStart}
      time={time}
      venue={entry.venue}
      isGroupEvent={entry.kind === 'group' || entry.kind === 'plan'}
      onClick={() => onOpen(entry)}
      muted={muted}
      trailing={trailing}
    />
  )
}

