import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import HomeEventRow from '../components/HomeEventRow'
import Avatar from '../components/Avatar'
import { CalendarSheet, CatalogPickerSheet } from '../components/GroupSheets'
import { appLink } from '../lib/share'
import {
  BASE_URL, addChannelCurator, fetchChannel, fetchChannelCurators,
  removeChannelCurator, setChannelFollow, setChannelNotify,
  setChannelPrioritize, trackEvent, updateChannel,
  createGroupEvent, getGroupCalendarFeedUrl,
} from '../services/api'

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
  const [showCalendar, setShowCalendar] = useState(false)
  const [showCatalog, setShowCatalog] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchChannel(channelId, googleId)
      .then(d => { d ? setData(d) : setFailed(true) })
      .catch(() => setFailed(true))
  }, [channelId, googleId])

  useEffect(() => { load() }, [load])

  // Publishing into the channel from the catalog — this is how a
  // channel gets filled, and it's the same sheet a private channel
  // uses. The backend refuses anyone outside the curation team, so the
  // button just stops teasing it.
  // Anyone can pass a channel along — it's public, and whoever opens
  // the link lands on it and decides whether to follow. That's the
  // whole difference from a private channel, where the link IS the
  // invitation and opening it puts you in.
  async function share() {
    const url = appLink(`/channels/${channelId}`)
    const text = `Olha esse canal no auê: ${channel.name}`
    trackEvent('channel_shared', { channel_id: channelId })
    try {
      if (navigator.share) {
        await navigator.share({ title: channel.name, text, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Cancelling the share sheet throws. Not an error.
    }
  }

  async function addFromCatalog(eventData) {
    const created = await createGroupEvent(channelId, googleId, eventData)
    trackEvent('channel_event_added', { channel_id: channelId, via: 'catalog' })
    load()
    return created
  }

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

  async function togglePrioritize() {
    if (!googleId || busy || !channel?.is_following) return
    const next = !channel.prioritize
    setBusy(true)
    setData(d => ({ ...d, channel: { ...d.channel, prioritize: next } }))
    try {
      await setChannelPrioritize(channelId, googleId, next)
      trackEvent('channel_prioritize_set', { channel_id: channelId, on: next })
    } catch {
      setData(d => ({ ...d, channel: { ...d.channel, prioritize: !next } }))
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

          {/* Defaults on. Following a channel and then seeing nothing
              from it anywhere but its own screen is a follow that did
              nothing, which is how people conclude a feature is broken
              rather than off. */}
          {channel.is_following && (
            <button
              onClick={togglePrioritize}
              disabled={busy}
              style={{
                width: '100%', marginTop: 8, padding: '11px 13px', borderRadius: 12,
                display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                border: '1px solid var(--line)', background: 'var(--bg2)',
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              <span style={{ fontSize: 15 }}>{channel.prioritize ? '⭐' : '☆'}</span>
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.4 }}>
                {channel.prioritize
                  ? 'Aparece no topo dos Eventos'
                  : 'Só aqui dentro — fora dos Eventos'}
              </span>
              <Switch on={channel.prioritize} />
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

      {/* Action bar. The first version of this screen had none of it,
          on the grounds that a calendar feed and a catalog picker were
          "crew machinery". They aren't — nothing about them implies
          other people in the room. Only the invite and the "convida a
          galera" nudge do, and those two stay out.
          
          What changes here is who may use each one, not whether it
          exists: the picker and the activity panel are curator-only,
          the calendar is for anyone following. */}
      {(channel.is_following || channel.can_curate) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          {channel.feed_token && (
            <ChannelAction onClick={() => setShowCalendar(true)}>
              📅 Assinar calendário
            </ChannelAction>
          )}
          {channel.can_curate && (
            <ChannelAction onClick={() => setShowCatalog(true)} accent>
              🌍 Do catálogo
            </ChannelAction>
          )}
        </div>
      )}

      {/* Sharing is for everyone, follower or not — a channel is public
          and passing one along costs nothing. Sits outside the block
          above precisely because it isn't gated on following. */}
      <ChannelAction onClick={share} wide>
        {copied ? '✓ Link copiado' : '🔗 Compartilhar canal'}
      </ChannelAction>

      {/* Who else is here. Shown to everyone, follower or not — it's
          social proof, and you should be able to see it before deciding
          whether to follow. What never ships on a curated channel is a
          prompt asking you to bring friends into it. */}
      {(data.followers || []).length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18 }}>
          <div style={{ display: 'flex' }}>
            {(data.followers || []).slice(0, 6).map((f, i) => (
              <span key={f.google_id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
                <Avatar name={f.name} src={f.picture} size={26} />
              </span>
            ))}
          </div>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            {channel.follower_count === 1
              ? `${(data.followers[0] || {}).name || 'Alguém'} segue`
              : `${channel.follower_count} seguindo`}
          </span>
        </div>
      )}

      {/* ── Curadoria ── */}
      {channel.can_curate && (
        <ChannelCuration
          channel={channel}
          email={state.googleUser?.email}
          onChanged={load}
        />
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

      <CalendarSheet
        open={showCalendar}
        onClose={() => setShowCalendar(false)}
        group={channel}
        feedUrl={getGroupCalendarFeedUrl(channel.feed_token)}
        t={{}}
      />
      <CatalogPickerSheet
        open={showCatalog}
        onClose={() => setShowCatalog(false)}
        onPick={addFromCatalog}
      />

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

// Curation panel — editing the channel and choosing who runs it.
//
// Shown to whoever can curate THIS channel: the founder, or someone the
// founder made a curator of it. That's a different permission from the
// global curator role, which is "can touch the catalog" — approve
// suggestions, edit events, add IG handles. Running Rockzão shouldn't
// require any of that, and handing it out shouldn't grant any of it.
//
// Appointing stays founder-only, enforced server-side: a curator who
// can appoint curators makes the roster ungovernable.
function ChannelCuration({ channel, email, onChanged }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(channel.name || '')
  const [description, setDescription] = useState(channel.description || '')
  const [curators, setCurators] = useState(null)
  const [people, setPeople] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    fetchChannelCurators(channel.id, email).then(setCurators)
    // Founder-only endpoint; a non-founder curator gets nothing back
    // and never sees the appoint control.
    fetch(`${BASE_URL}/admin/users?requesting_email=${encodeURIComponent(email || '')}&limit=200`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setPeople(d?.users || []))
      .catch(() => setPeople([]))
  }, [open, channel.id, email])

  async function save() {
    if (!name.trim() || busy) return
    setBusy(true); setError('')
    try {
      await updateChannel(channel.id, email, { name: name.trim(), description: description.trim() })
      trackEvent('channel_edited', { channel_id: channel.id })
      onChanged()
    } catch (e) {
      setError(e?.message || 'Não rolou salvar.')
    }
    setBusy(false)
  }

  async function appoint(googleId) {
    setBusy(true); setError('')
    try {
      setCurators(await addChannelCurator(channel.id, email, googleId))
      onChanged()
    } catch (e) {
      setError(e?.message || 'Não rolou.')
    }
    setBusy(false)
  }

  async function stepDown(googleId) {
    setBusy(true); setError('')
    try {
      setCurators(await removeChannelCurator(channel.id, email, googleId))
      onChanged()
    } catch (e) {
      setError(e?.message || 'Não rolou.')
    }
    setBusy(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="neon-mono"
        style={{
          width: '100%', marginTop: 12, padding: '9px',
          borderRadius: 12, border: '1px dashed var(--magenta)',
          background: 'transparent', color: 'var(--magenta)',
          fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        ⚙ Curadoria do canal
      </button>
    )
  }

  const curatorIds = new Set((curators || []).map(c => c.google_id))
  const candidates = people.filter(p => !curatorIds.has(p.google_id)).slice(0, 40)

  return (
    <div style={{
      marginTop: 12, padding: 13, borderRadius: 14,
      border: '1px solid var(--magenta)', background: 'var(--bg2)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="neon-mono" style={{
          flex: 1, fontSize: 10, letterSpacing: '0.18em',
          textTransform: 'uppercase', color: 'var(--magenta)',
        }}>
          Curadoria do canal
        </span>
        <button
          onClick={() => setOpen(false)}
          style={{
            background: 'none', border: 'none', color: 'var(--text3)',
            fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1,
          }}
        >×</button>
      </div>

      <input
        value={name}
        onChange={e => setName(e.target.value)}
        maxLength={80}
        placeholder="Nome do canal"
        style={curationInput}
      />
      <input
        value={description}
        onChange={e => setDescription(e.target.value)}
        maxLength={200}
        placeholder="Uma linha sobre o que entra aqui"
        style={curationInput}
      />
      <button
        onClick={save}
        disabled={busy || !name.trim()}
        style={{
          padding: '9px', borderRadius: 10, fontSize: 12, fontWeight: 700,
          border: 'none', background: 'var(--magenta)', color: 'var(--bg)',
          cursor: busy ? 'wait' : 'pointer', opacity: (busy || !name.trim()) ? 0.6 : 1,
        }}
      >
        {busy ? '...' : 'Salvar'}
      </button>

      {/* Roster. Only the founder gets it back from the server, so a
          channel curator sees the edit fields above and nothing here. */}
      {curators !== null && (
        <>
          <div className="neon-mono" style={{
            fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'var(--text2)', marginTop: 4,
          }}>
            Quem cura ({curators.length})
          </div>
          {curators.length === 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.45 }}>
              Só você por enquanto. Quem você colocar aqui pode publicar e
              editar esse canal — e nada além dele.
            </div>
          )}
          {curators.map(c => (
            <div key={c.google_id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar name={c.name} src={c.picture} size={24} />
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>{c.name}</span>
              <button
                onClick={() => stepDown(c.google_id)}
                disabled={busy}
                style={{
                  padding: '5px 9px', borderRadius: 8, fontSize: 11,
                  border: '1px solid var(--line)', background: 'transparent',
                  color: 'var(--text2)', cursor: 'pointer',
                }}
              >
                Tirar
              </button>
            </div>
          ))}

          {candidates.length > 0 && (
            <select
              value=""
              onChange={e => e.target.value && appoint(e.target.value)}
              disabled={busy}
              style={curationInput}
            >
              <option value="">+ Adicionar curador…</option>
              {candidates.map(p => (
                <option key={p.google_id} value={p.google_id}>
                  {p.name || p.email || p.google_id}
                </option>
              ))}
            </select>
          )}
        </>
      )}

      {error && <div style={{ fontSize: 11, color: '#EF9A9A' }}>{error}</div>}
    </div>
  )
}

const curationInput = {
  width: '100%', padding: '9px 11px', borderRadius: 10,
  border: '1px solid var(--line)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box', background: 'var(--bg)', color: 'var(--text)',
}

function ChannelAction({ children, onClick, accent, wide }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: '1 1 auto', padding: '10px 12px', borderRadius: 12,
        ...(wide ? { width: '100%', marginTop: 8 } : null),
        fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        border: accent ? 'none' : '1px solid var(--line)',
        background: accent ? 'var(--magenta)' : 'var(--bg2)',
        color: accent ? 'var(--bg)' : 'var(--text2)',
      }}
    >
      {children}
    </button>
  )
}
