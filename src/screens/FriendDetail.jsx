import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { fetchFriendsFeed, getFriends, fetchUserProfile, addFriendById } from '../services/api'
import Avatar from '../components/Avatar'

// Per-friend view: shows the friend's profile header + the upcoming events
// they've RSVPd to (intersection with the current user's friends_feed —
// respects that friend's privacy settings, which are filtered server-side).

export default function FriendDetail() {
  const { googleId: friendId } = useParams()
  const { state } = useApp()
  const navigate = useNavigate()
  const myGoogleId = state.googleUser?.id

  const [friend, setFriend] = useState(null)
  // friendStatus is what the BACKEND knows: 'friends' (already connected),
  // 'self' (you tapped your own profile), 'none' (not connected yet —
  // tap-to-add affordance fires).
  const [friendStatus, setFriendStatus] = useState('none')
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')

  useEffect(() => {
    if (!myGoogleId || !friendId) { setLoading(false); return }
    let cancelled = false
    Promise.all([
      getFriends(myGoogleId),
      fetchFriendsFeed(myGoogleId),
      fetchUserProfile(friendId, myGoogleId).catch(() => null),
    ])
      .then(([friendList, feed, profile]) => {
        if (cancelled) return
        // Prefer the friend-list entry (richer metadata) when the
        // viewer is already friends with this user; fall back to the
        // public profile for non-friends so we still render the page.
        const match = (friendList || []).find(f => f.google_id === friendId)
        setFriend(match || (profile ? {
          google_id: friendId,
          name: profile.name,
          picture: profile.picture,
        } : null))
        setFriendStatus(profile?.friend_status || (match ? 'friends' : 'none'))
        const theirs = (feed || []).filter(ev =>
          (ev.friends_going || []).some(f => f.google_id === friendId)
        )
        setEvents(theirs)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [myGoogleId, friendId])

  async function handleAddFriend() {
    if (adding || !myGoogleId || !friendId) return
    setAdding(true); setAddError('')
    try {
      const result = await addFriendById(myGoogleId, friendId)
      if (result.status === 'ok' || result.status === 'already_friends') {
        setFriendStatus('friends')
      } else if (result.status === 'self') {
        setFriendStatus('self')
      } else {
        setAddError('Não consegui adicionar. Tenta de novo.')
      }
    } catch {
      setAddError('Não consegui adicionar. Tenta de novo.')
    }
    setAdding(false)
  }

  const upcoming = events
    .filter(ev => ev.event_date && Date.parse(ev.event_date) > Date.now())
    .sort((a, b) => Date.parse(a.event_date) - Date.parse(b.event_date))

  if (!myGoogleId) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--charcoal-mid)' }}>
        Faça login com Google pra ver os eventos dos seus amigos.
      </div>
    )
  }

  return (
    <div style={{ padding: '20px 0 80px' }}>
      <div style={{ padding: '0 20px 14px' }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--charcoal-light)', fontSize: 13, padding: '4px 0', marginBottom: 12,
          }}
        >
          ← Voltar
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Avatar
            src={friend?.picture}
            name={friend?.name || friendId}
            size={56}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{
              fontSize: 22, fontWeight: 700, margin: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {friend?.name || 'Pessoa'}
            </h1>
            <div style={{ fontSize: 13, color: 'var(--charcoal-light)', marginTop: 2 }}>
              {loading
                ? 'Carregando…'
                : friendStatus !== 'friends'
                  ? (friendStatus === 'self' ? 'Você' : 'Ainda não são amigos')
                  : upcoming.length === 0
                    ? 'Sem eventos próximos.'
                    : `${upcoming.length} evento${upcoming.length === 1 ? '' : 's'} próximo${upcoming.length === 1 ? '' : 's'}.`}
            </div>
          </div>
        </div>
        {!loading && friendStatus === 'none' && (
          <button
            onClick={handleAddFriend}
            disabled={adding}
            style={{
              marginTop: 14, width: '100%',
              padding: '12px', borderRadius: 12,
              background: 'var(--terra)', color: 'white',
              border: 'none', fontSize: 14, fontWeight: 700,
              cursor: adding ? 'wait' : 'pointer',
              opacity: adding ? 0.7 : 1,
            }}
          >
            {adding ? 'Adicionando…' : '+ Adicionar como amigo'}
          </button>
        )}
        {addError && (
          <div style={{
            marginTop: 8, padding: '8px 12px',
            background: '#FFEBEE', borderRadius: 8,
            color: '#B71C1C', fontSize: 12,
          }}>
            {addError}
          </div>
        )}
      </div>

      {!loading && upcoming.length === 0 && (
        <div style={{ padding: '32px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🌱</div>
          <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5 }}>
            Quando {friend?.name || 'esse amigo'} confirmar presença em algum
            evento, ele aparece aqui.
          </div>
        </div>
      )}

      {upcoming.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px' }}>
          {upcoming.map(ev => {
            const dateLabel = formatDate(ev.event_date)
            const userIsGoing = !!state.rsvps[ev.event_id]
            return (
              <div
                key={ev.event_id}
                onClick={() => navigate('/events', { state: { openEventId: ev.event_id } })}
                style={{
                  background: 'var(--white)', borderRadius: 14, padding: '12px 14px',
                  border: '1px solid var(--border)', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}
              >
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <div style={{
                    fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
                    flex: 1, minWidth: 0,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {ev.event_name}
                  </div>
                  {userIsGoing && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, flexShrink: 0,
                      background: 'var(--sage-pale)', color: 'var(--sage)',
                      padding: '3px 7px', borderRadius: 6,
                    }}>
                      ✓ Vou
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
                  {dateLabel}{ev.event_venue ? ` · ${ev.event_venue}` : ''}
                </div>
              </div>
            )
          })}
        </div>
      )}
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
