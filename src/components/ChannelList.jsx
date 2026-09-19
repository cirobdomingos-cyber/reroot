import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { fetchChannels, setChannelFollow, trackEvent } from '../services/api'

// Canais do auê — curated collections you follow.
//
// Rendered above your own groups rather than mixed in with them. The
// caution recorded before any of this was built (docs/NEXT.md) was that
// a curated channel must not read as a crew: arrive expecting people,
// find a feed. Both are called "canal" now, so the distinction has to
// live in the shape instead of the word —
//
//   canal privado  ->  membros, convite, "convida a galera"
//   canal do auê   ->  seguidores, "seguir", never an invite prompt
//
// Follower counts are shown on purpose: social proof helps. What never
// ships here is a prompt asking you to invite friends into something
// auê runs.
//
// Hides itself entirely when there are no channels, so the section
// doesn't sit there empty while the first one is still being curated.
export default function ChannelList() {
  const navigate = useNavigate()
  const { state } = useApp()
  const googleId = state.googleUser?.id
  const [channels, setChannels] = useState([])
  const [pending, setPending] = useState(null)   // id being toggled

  useEffect(() => {
    let cancelled = false
    fetchChannels(googleId).then(list => {
      if (!cancelled) setChannels(list)
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

  if (channels.length === 0) return null

  return (
    <div style={{ padding: '16px 16px 4px' }}>
      <h2 style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
        color: 'var(--text2)', margin: '0 0 10px',
      }}>
        Canais do auê
      </h2>

      {channels.map(channel => (
        <div
          key={channel.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: 'var(--bg2)', border: '1px solid var(--line)',
            borderRadius: 14, padding: '12px 14px', marginBottom: 8,
          }}
        >
          <div
            onClick={() => navigate(`/groups/${channel.id}`)}
            style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 15, fontWeight: 700, color: 'var(--text)',
            }}>
              <span style={{
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {channel.name}
              </span>
              {/* The badge is what separates an auê channel from a crew
                  at a glance, now that they share a word. */}
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
              {channel.follower_count} seguindo
              {channel.description ? ` · ${channel.description}` : ''}
            </div>
          </div>

          {googleId && (
            <button
              onClick={() => toggle(channel)}
              disabled={pending === channel.id}
              style={{
                flexShrink: 0, padding: '8px 14px', borderRadius: 10,
                fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: channel.is_following ? '1.5px solid var(--line)' : 'none',
                background: channel.is_following ? 'transparent' : 'var(--magenta)',
                color: channel.is_following ? 'var(--text2)' : 'var(--bg)',
                opacity: pending === channel.id ? 0.6 : 1,
              }}
            >
              {channel.is_following ? 'Seguindo' : 'Seguir'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
