import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { fetchChannels, setChannelFollow, trackEvent } from '../services/api'
import ChannelsIntro from './ChannelsIntro'

// Canais do auê — curated collections you follow.
//
// Rendered above your own channels, not mixed into them. The caution
// recorded before any of this was built (docs/NEXT.md) was that a
// curated channel must not read as a crew: arrive expecting humans,
// find a feed. Both are called "canal" since the Sep 2026 rename, so
// the distinction lives in the shape —
//
//   canal privado  ->  membros, convite, "convida a galera"
//   canal do auê   ->  seguidores, "seguir", never an invite prompt
//
// Follower counts are shown on purpose: social proof helps. What never
// ships here is a prompt asking you to invite friends into something
// auê runs.
export default function ChannelList() {
  const navigate = useNavigate()
  const { state } = useApp()
  const googleId = state.googleUser?.id
  const [channels, setChannels] = useState([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(null)   // id being toggled

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchChannels(googleId).then(list => {
      if (cancelled) return
      setChannels(list)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [googleId])

  async function toggle(channel) {
    if (!googleId || pending) return
    const next = !channel.is_following
    setPending(channel.id)
    // Optimistic: the button is the whole interaction, so it has to
    // respond now. Rolled back below if the call fails.
    setChannels(prev => prev.map(c => c.id === channel.id
      ? { ...c, is_following: next, follower_count: c.follower_count + (next ? 1 : -1) }
      : c))
    try {
      await setChannelFollow(channel.id, googleId, next)
      trackEvent(next ? 'channel_followed' : 'channel_unfollowed', { channel_id: channel.id })
    } catch {
      setChannels(prev => prev.map(c => c.id === channel.id
        ? { ...c, is_following: !next, follower_count: c.follower_count + (next ? -1 : 1) }
        : c))
    }
    setPending(null)
  }

  // Split by follow state. One flat list with a button on each row
  // makes "what I follow" and "what exists" the same pile — you have to
  // read every button to answer either question.
  //
  // The split only appears once it's needed: before the first follow
  // everything IS discovery, and a "Seguindo (0)" heading over nothing
  // is noise. Same reasoning the other way — once you follow all of
  // them, "Descobrir" has nothing to show and goes away.
  const following = channels.filter(c => c.is_following)
  const discover = channels.filter(c => !c.is_following)

  function row(channel) {
    return (
      <ChannelRow
        key={channel.id}
        channel={channel}
        canFollow={!!googleId}
        busy={pending === channel.id}
        onOpen={() => navigate(`/channels/${channel.id}`)}
        onToggle={() => toggle(channel)}
      />
    )
  }

  return (
    <>
      {/* Explains the word before the list uses it. Disappears once the
          person follows something — see ChannelsIntro. */}
      <ChannelsIntro followedCount={following.length} loading={loading} />

      <div style={{ padding: '0 16px 4px' }}>
        {/* Used to return null with nothing to show. That hid the
            concept from exactly the people who'd never met it — the
            heading is the only place the word gets introduced, and a
            tab that renders nothing teaches nothing. */}
        {!loading && channels.length === 0 && (
          <>
            <SectionHeading>Canais do auê</SectionHeading>
            <div style={{
              padding: '14px 14px', borderRadius: 14,
              border: '1px dashed var(--line)',
              fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.5,
            }}>
              Ainda não tem canal nosso no ar. Tamo montando os primeiros —
              rock, samba, eletrônica — pra você seguir o que gosta e parar
              de caçar no meio de tudo.
            </div>
          </>
        )}

        {following.length > 0 && (
          <>
            <SectionHeading count={following.length}>Seguindo</SectionHeading>
            {following.map(row)}
          </>
        )}

        {discover.length > 0 && (
          <>
            {/* Named for what you do here, not for who made them. Before
                the first follow there's nothing to contrast with, so it
                keeps the plain name. */}
            <SectionHeading spaced={following.length > 0}>
              {following.length > 0 ? 'Descobrir' : 'Canais do auê'}
            </SectionHeading>
            {discover.map(row)}
          </>
        )}
      </div>
    </>
  )
}

function SectionHeading({ children, count, spaced }) {
  return (
    <h2 style={{
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
      color: 'var(--text2)', margin: spaced ? '20px 0 10px' : '10px 0 10px',
    }}>
      {children}
      {count != null && <span style={{ color: 'var(--text3)' }}> · {count}</span>}
    </h2>
  )
}

function ChannelRow({ channel, canFollow, busy, onOpen, onToggle }) {
  const events = channel.upcoming_event_count ?? 0
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: 'var(--bg2)', border: '1px solid var(--line)',
      borderRadius: 14, padding: '12px 14px', marginBottom: 8,
      // A followed channel is marked on the row itself, not only by the
      // button's wording — the state should survive a glance that never
      // reaches the right-hand edge.
      boxShadow: channel.is_following ? 'inset 3px 0 0 var(--magenta)' : 'none',
    }}>
      <div onClick={onOpen} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 15, fontWeight: 700, color: 'var(--text)',
        }}>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {channel.name}
          </span>
          {/* What separates an auê channel from a crew at a glance, now
              that they share a word. */}
          <span
            title="Canal curado pelo auê"
            style={{
              flexShrink: 0, fontSize: 10, fontWeight: 800,
              padding: '2px 7px', borderRadius: 7,
              background: 'var(--magenta)', color: 'var(--bg)',
              letterSpacing: '0.06em',
            }}
          >
            auê
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
          {/* What's in it comes first. A channel that says "12 seguindo"
              and nothing else is asking for a follow without saying
              what for. */}
          {events > 0 ? `${events} ${events === 1 ? 'rolê' : 'rolês'}` : 'sem rolê marcado'}
          {' · '}{channel.follower_count} seguindo
        </div>
        {channel.description && (
          <div style={{
            fontSize: 12, color: 'var(--text3)', marginTop: 3, lineHeight: 1.45,
          }}>
            {channel.description}
          </div>
        )}
      </div>

      {canFollow && (
        <button
          onClick={onToggle}
          disabled={busy}
          style={{
            flexShrink: 0, padding: '8px 14px', borderRadius: 10,
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: channel.is_following ? '1.5px solid var(--line)' : 'none',
            background: channel.is_following ? 'transparent' : 'var(--magenta)',
            color: channel.is_following ? 'var(--text2)' : 'var(--bg)',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {channel.is_following ? 'Seguindo' : 'Seguir'}
        </button>
      )}
    </div>
  )
}
