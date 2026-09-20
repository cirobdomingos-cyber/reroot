import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { BASE_URL, createAueChannel, fetchChannels, setChannelFollow, trackEvent } from '../services/api'
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
  // Founder-only: creating an auê channel had an endpoint and no
  // button, so the only way in was curl — or the ordinary "criar canal"
  // form, which makes a private one that nobody else can see.
  const [isFounder, setIsFounder] = useState(false)
  const [creating, setCreating] = useState(false)
  const email = state.googleUser?.email

  useEffect(() => {
    if (!email) { setIsFounder(false); return }
    let cancelled = false
    fetch(`${BASE_URL}/admin/curators?requesting_email=${encodeURIComponent(email)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setIsFounder(!!d?.is_founder) })
      .catch(() => { if (!cancelled) setIsFounder(false) })
    return () => { cancelled = true }
  }, [email])

  const reload = useCallback(() => {
    setLoading(true)
    return fetchChannels(googleId).then(list => {
      setChannels(list)
      setLoading(false)
    })
  }, [googleId])

  useEffect(() => { reload() }, [reload])

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

        {/* Founder-only, and placed here rather than in the admin shell
            because this is the screen where the gap shows: the ordinary
            create button below makes a PRIVATE channel, and the two are
            a tap apart. */}
        {isFounder && (
          <CreateAueChannel
            open={creating}
            onOpen={() => setCreating(true)}
            onCancel={() => setCreating(false)}
            email={email}
            onCreated={() => { setCreating(false); reload() }}
          />
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

// Creating an auê channel, for the founder, from the screen where the
// distinction matters. POST /admin/channels shipped without any UI,
// which left curl as the only way in — or the ordinary "criar canal"
// button a few rows down, which makes a private channel nobody else can
// find. Those two being a tap apart with no visible difference is how
// an "AUÊ Samba e Pagode" ends up invisible to everyone.
function CreateAueChannel({ open, onOpen, onCancel, email, onCreated }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!name.trim() || busy) return
    setBusy(true); setError('')
    try {
      await createAueChannel(email, name.trim(), description.trim())
      trackEvent('aue_channel_created', { name: name.trim() })
      setName(''); setDescription('')
      onCreated()
    } catch (e) {
      setError(e?.message || 'Não rolou criar. Tenta de novo.')
    }
    setBusy(false)
  }

  if (!open) {
    return (
      <button
        onClick={onOpen}
        className="neon-mono"
        style={{
          width: '100%', marginBottom: 10, padding: '10px',
          borderRadius: 12, border: '1px dashed var(--magenta)',
          background: 'transparent', color: 'var(--magenta)',
          fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        + Novo canal do auê
      </button>
    )
  }

  return (
    <div style={{
      marginBottom: 10, padding: 12, borderRadius: 14,
      border: '1px solid var(--magenta)', background: 'var(--bg2)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div className="neon-mono" style={{
        fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
        color: 'var(--magenta)',
      }}>
        Novo canal do auê
      </div>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Nome (ex: Samba e Pagode)"
        maxLength={80}
        style={createInput}
      />
      <input
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Uma linha sobre o que entra aqui"
        maxLength={200}
        style={createInput}
      />
      <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.45 }}>
        Público e seguível por qualquer pessoa. Só a curadoria publica nele.
      </div>
      {error && (
        <div style={{ fontSize: 11, color: '#EF9A9A' }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onCancel}
          disabled={busy}
          style={{
            flex: 1, padding: '9px', borderRadius: 10, fontSize: 12, fontWeight: 700,
            border: '1.5px solid var(--line)', background: 'transparent',
            color: 'var(--text2)', cursor: 'pointer',
          }}
        >
          Cancelar
        </button>
        <button
          onClick={submit}
          disabled={busy || !name.trim()}
          style={{
            flex: 1.4, padding: '9px', borderRadius: 10, fontSize: 12, fontWeight: 700,
            border: 'none', background: 'var(--magenta)', color: 'var(--bg)',
            cursor: busy ? 'wait' : 'pointer',
            opacity: (busy || !name.trim()) ? 0.6 : 1,
          }}
        >
          {busy ? '...' : 'Criar canal'}
        </button>
      </div>
    </div>
  )
}

const createInput = {
  width: '100%', padding: '9px 11px', borderRadius: 10,
  border: '1px solid var(--line)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text)',
}
