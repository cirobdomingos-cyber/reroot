import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import HomeEventRow from '../components/HomeEventRow'
import { fetchChannel, setChannelFollow, setChannelNotify, trackEvent } from '../services/api'

// The channel screen.
//
// Deliberately NOT GroupDetail with things hidden. That screen answers
// "what is this crew" — members, roles, invite code, mural, primeiros
// passos — and a channel needs almost none of it. Rendering it and
// switching pieces off is how an "...unless it's a channel" branch
// spreads through a file, which is the failure docs/NEXT.md warned
// about before any of this was built.
//
// A channel answers one question instead: is this worth following?
// So the screen is what it publishes, with one action attached.
//
//   hero      -> what it is, and proof it's alive
//   ação      -> Seguir, and once following, whether to be told
//   o feed    -> the reason to follow, taking most of the screen
//
// No member list, no invite, no stats panel, no nudge to bring friends
// into something auê runs.
export default function ChannelDetail() {
  const { channelId } = useParams()
  const navigate = useNavigate()
  const { state } = useApp()
  const googleId = state.googleUser?.id

  const [data, setData] = useState(null)   // null = loading
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchChannel(channelId, googleId)
      .then(d => { d ? setData(d) : setFailed(true) })
      .catch(() => setFailed(true))
  }, [channelId, googleId])

  useEffect(() => { load() }, [load])

  const channel = data?.channel
  const events = data?.events || []
  const past = data?.past_events || []

  async function toggleFollow() {
    if (!googleId || busy || !channel) return
    const next = !channel.is_following
    setBusy(true)
    // Optimistic — this is the whole interaction, it has to answer now.
    setData(d => ({ ...d, channel: {
      ...d.channel,
      is_following: next,
      follower_count: d.channel.follower_count + (next ? 1 : -1),
    } }))
    try {
      await setChannelFollow(channelId, googleId, next)
      trackEvent(next ? 'channel_followed' : 'channel_unfollowed', { channel_id: channelId })
    } catch {
      setData(d => ({ ...d, channel: {
        ...d.channel,
        is_following: !next,
        follower_count: d.channel.follower_count + (next ? -1 : 1),
      } }))
    }
    setBusy(false)
  }

  async function toggleNotify() {
    if (!googleId || busy || !channel?.is_following) return
    const next = !channel.notify
    setBusy(true)
    setData(d => ({ ...d, channel: { ...d.channel, notify: next } }))
    try {
      await setChannelNotify(channelId, googleId, next)
      trackEvent('channel_notify_set', { channel_id: channelId, on: next })
    } catch {
      setData(d => ({ ...d, channel: { ...d.channel, notify: !next } }))
    }
    setBusy(false)
  }

  if (failed) {
    return (
      <Shell onBack={() => navigate('/community')}>
        <p style={{ fontSize: 13, color: 'var(--text2)', padding: '28px 0', textAlign: 'center' }}>
          Esse canal não está mais no ar.
        </p>
      </Shell>
    )
  }
  if (!channel) {
    return (
      <Shell onBack={() => navigate('/community')}>
        <p className="neon-mono" style={{ fontSize: 11, color: 'var(--text3)' }}>Carregando...</p>
      </Shell>
    )
  }

  const count = channel.upcoming_event_count ?? events.length

  return (
    <Shell onBack={() => navigate('/community')}>
      {/* ── Hero ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h1 className="neon-display" style={{
          fontSize: 30, color: 'var(--text)', letterSpacing: '-0.025em',
          margin: 0, lineHeight: 1.1,
        }}>
          {channel.name}
        </h1>
        <span style={{
          fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 8,
          background: 'var(--magenta)', color: 'var(--bg)', letterSpacing: '0.06em',
        }}>
          auê
        </span>
      </div>

      {channel.description && (
        <p style={{
          fontSize: 14, lineHeight: 1.55, color: 'var(--text2)', margin: '10px 0 0',
        }}>
          {channel.description}
        </p>
      )}

      {/* What's in it leads. A channel that only reports followers is
          asking for a follow without saying what for. */}
      <div className="neon-mono" style={{
        fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
        color: 'var(--text2)', marginTop: 10,
      }}>
        {count > 0 ? `${count} ${count === 1 ? 'rolê marcado' : 'rolês marcados'}` : 'sem rolê marcado'}
        {' · '}{channel.follower_count} seguindo
      </div>

      {/* ── Action ── */}
      {googleId ? (
        <>
          <button
            onClick={toggleFollow}
            disabled={busy}
            style={{
              width: '100%', marginTop: 16, padding: '13px', borderRadius: 12,
              fontSize: 14, fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
              border: channel.is_following ? '1.5px solid var(--line)' : 'none',
              background: channel.is_following ? 'transparent' : 'var(--magenta)',
              color: channel.is_following ? 'var(--text2)' : 'var(--bg)',
              boxShadow: channel.is_following ? 'none' : '0 0 18px rgba(255, 43, 214, 0.35)',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {channel.is_following ? '✓ Seguindo' : 'Seguir'}
          </button>

          {/* Only once following — a switch for something you don't get
              is a setting with no subject. */}
          {channel.is_following && (
            <button
              onClick={toggleNotify}
              disabled={busy}
              style={{
                width: '100%', marginTop: 8, padding: '11px 13px', borderRadius: 12,
                display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                border: '1px solid var(--line)', background: 'var(--bg2)',
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              <span style={{ fontSize: 15 }}>{channel.notify ? '🔔' : '🔕'}</span>
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.4 }}>
                {channel.notify
                  ? 'Te avisamos quando entrar rolê novo'
                  : 'Sem aviso — você vê quando abrir o app'}
              </span>
              <Switch on={channel.notify} />
            </button>
          )}
        </>
      ) : (
        <p style={{
          fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.5,
          margin: '16px 0 0', padding: '11px 13px',
          border: '1px dashed var(--line)', borderRadius: 12,
        }}>
          Entra com o Google pra seguir e ser avisado quando entrar rolê novo.
        </p>
      )}

      {/* ── The feed ── */}
      <h2 className="neon-mono" style={{
        fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
        color: 'var(--text2)', margin: '26px 0 10px',
      }}>
        Próximos
      </h2>

      {events.length === 0 && (
        <p style={{
          fontSize: 13, color: 'var(--text2)', lineHeight: 1.5,
          padding: '16px 14px', border: '1px dashed var(--line)', borderRadius: 14,
        }}>
          Nada marcado agora. Seguindo, você fica sabendo assim que entrar.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {events.map(ev => (
          <ChannelRow key={ev.id} ev={ev} navigate={navigate} />
        ))}
      </div>

      {/* Recent past, so a channel between shows still reads as alive
          rather than empty. Newest first: this is "what you missed",
          not a schedule. */}
      {past.length > 0 && (
        <>
          <h2 className="neon-mono" style={{
            fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
            color: 'var(--text3)', margin: '26px 0 10px',
          }}>
            Já rolou
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: 0.6 }}>
            {past.map(ev => (
              <ChannelRow key={ev.id} ev={ev} navigate={navigate} />
            ))}
          </div>
        </>
      )}
    </Shell>
  )
}

function ChannelRow({ ev, navigate }) {
  return (
    <HomeEventRow
      name={ev.name}
      dateStart={ev.dateStart}
      dateEnd={ev.dateEnd}
      time={ev.time}
      venue={ev.venue}
      isRecurring={ev.isRecurring}
      // Not a private event here — a channel's events are published, and
      // the padlock this flag draws would say the opposite.
      isGroupEvent={false}
      featured={ev.featured}
      onClick={() => navigate('/events', { state: { openEventId: ev.id } })}
    />
  )
}

function Switch({ on }) {
  return (
    <span style={{
      flexShrink: 0, width: 34, height: 20, borderRadius: 10,
      background: on ? 'var(--magenta)' : 'var(--line)',
      position: 'relative', transition: 'background 0.18s',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 16 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: 'var(--bg)', transition: 'left 0.18s',
      }} />
    </span>
  )
}

function Shell({ children, onBack }) {
  return (
    <div style={{ padding: '18px 18px 90px' }}>
      <button
        onClick={onBack}
        className="neon-mono"
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          color: 'var(--text3)', fontSize: 10, letterSpacing: '0.18em',
          textTransform: 'uppercase', marginBottom: 14,
        }}
      >
        ← Canais
      </button>
      {children}
    </div>
  )
}
