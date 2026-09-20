import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import HomeEventRow from '../components/HomeEventRow'
import Avatar from '../components/Avatar'
import {
  CalendarSheet, CatalogPickerSheet, InviteSheet, MembersSheet,
} from '../components/GroupSheets'
import PersonalPlanSheet from '../components/PersonalPlanSheet'
import { appLink } from '../lib/share'
import {
  BASE_URL, addChannelCurator, fetchChannel, fetchChannelCurators,
  removeChannelCurator, setChannelFollow, setChannelNotify,
  setChannelPrioritize, trackEvent, updateChannel,
  createGroupEvent, getGroupCalendarFeedUrl, leaveGroup,
} from '../services/api'

// The channel screen — the only one, for both kinds.
//
// A public channel is run by auê, a private one by whoever made it.
// That is a difference in who may do what, not in what a channel *is*,
// so there is one screen and permissions decide what it offers. The
// alternative — a screen per kind — is how the same feed, the same
// follow button and the same calendar end up implemented twice and
// drifting apart, which is what the old GroupDetail had already become.
//
// Every affordance below is gated on one of three facts and nothing
// else: isPrivate (invite, add event, member list), can_curate (the
// catalog picker, the curation panel), is_following (notify, priority).
// Read them as the permission table; there is no "...unless it's a
// channel" branch anywhere, and adding one should feel wrong.
//
// A channel still answers one question first: is this worth following?
// So the screen leads with what it publishes, action attached.
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
  // Private-channel affordances. They live on the same screen as the
  // public ones and differ by permission, not by existing somewhere
  // else — which is what let GroupDetail go away.
  const [showInvite, setShowInvite] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [showNewEvent, setShowNewEvent] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  // Leaving is not unfollowing. You lose the events, the invite and the
  // way back in — someone has to let you in again — so it confirms,
  // says what it costs, and then sends you out of a screen you can no
  // longer read.
  async function leave() {
    if (!confirm(`Sair de "${channel?.name}"? Você perde os rolês do canal, e só volta se alguém te convidar de novo.`)) return
    setBusy(true)
    try {
      await leaveGroup(channelId, googleId)
      navigate('/community')
    } catch {
      alert('Não deu pra sair agora. Tenta de novo.')
      setBusy(false)
    }
  }

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
  // The single thing that differs between the two kinds. Everything
  // below reads from it instead of from a second screen existing.
  const isPrivate = channel.is_public === false
  // The screen wears its channel's colour, the same one the Canais row
  // and the Eventos stripe use. A private channel screen painted in
  // auê magenta is the product telling you this is auê's, one tap
  // after a cyan row told you it is yours.
  const accent = isPrivate ? 'var(--from-private)' : 'var(--from-aue)'
  const accentGlow = isPrivate
    ? 'var(--from-private-glow)'
    : 'var(--from-aue-glow)'
  // Nothing to open on a channel nobody is in yet — and an underline
  // that opens an empty sheet is worse than no underline.
  const hasPeople = (data?.followers || []).length > 0
  const accentSoft = isPrivate
    ? 'var(--from-private-soft)'
    : 'var(--from-aue-soft)'
  const peopleWord = isPrivate
    ? (channel.follower_count === 1 ? 'membro' : 'membros')
    : 'seguindo'

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
          background: accent,
          color: 'var(--bg)', letterSpacing: '0.06em',
        }}>
          {isPrivate ? '🔒 privado' : 'auê'}
        </span>
      </div>

      {channel.description && (
        <p style={{
          fontSize: 14, lineHeight: 1.55, color: 'var(--text2)', margin: '10px 0 0',
        }}>
          {channel.description}
        </p>
      )}

      {/* Everything about the channel in one line: what's on, who
          else is here, and a couple of faces. The follower strip used
          to be its own row lower down, which cost 40px to say what
          fits in four words here. */}
      <button
        onClick={hasPeople ? () => setShowMembers(true) : undefined}
        // One target: faces and count together. It used to be the
        // avatars alone, and only on a private channel — so on an auê
        // one there was no way to see who else was there, and on a
        // private one the way in was three 22px circles with nothing
        // saying they were a button.
        //
        // Who is in a channel is not a private-channel question. It is
        // most of the answer to "is this worth following".
        style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
          background: 'none', border: 'none', padding: 0, textAlign: 'left',
          cursor: hasPeople ? 'pointer' : 'default',
          width: '100%',
        }}
      >
        {(data.followers || []).length > 0 && (
          <div style={{ display: 'flex', flexShrink: 0 }}>
            {(data.followers || []).slice(0, 3).map((f, i) => (
              <span key={f.google_id} style={{ marginLeft: i === 0 ? 0 : -8 }}>
                <Avatar name={f.name} src={f.picture} size={22} />
              </span>
            ))}
          </div>
        )}
        <span className="neon-mono" style={{
          fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
          color: 'var(--text2)',
        }}>
          {count > 0 ? `${count} ${count === 1 ? 'rolê' : 'rolês'}` : 'sem rolê marcado'}
          {' · '}
          <span style={{
            color: hasPeople ? accent : 'var(--text2)',
            textDecoration: hasPeople ? 'underline' : 'none',
            textUnderlineOffset: 3,
          }}>
            {channel.follower_count} {peopleWord}
          </span>
        </span>
      </button>

      {/* One decision at full width — the only one most people make
          here. Everything else became an icon.
          
          The screen used to lead with six stacked rows, which pushed
          the first event to 478px of an 844px viewport: more than half
          the screen was settings, above the list that is the entire
          reason to open a channel. Configuration is set once; the list
          is read every week, and the layout should say so. */}
      {googleId ? (
        <>
          {/* Follow is a public-channel decision. You find one and opt
              in, and "deixar de seguir" undoes exactly that.

              A private channel isn't found — you were let in. There is
              nothing to opt into, and the button had nothing to undo:
              unfollow_channel only deletes rows with role='follower',
              and a member's row says 'member'. So it sat there reading
              "✓ Seguindo" and refusing to turn off.

              The real action is leaving, which is not a toggle — it
              costs you access — so it gets a word, low emphasis, and a
              confirm rather than the primary slot. */}
          {!isPrivate && (
            <button
              onClick={toggleFollow}
              disabled={busy}
              style={{
                width: '100%', marginTop: 14, padding: '13px', borderRadius: 12,
                fontSize: 14, fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
                border: channel.is_following ? '1.5px solid var(--line)' : 'none',
                background: channel.is_following ? 'transparent' : accent,
                color: channel.is_following ? 'var(--text2)' : 'var(--bg)',
                boxShadow: channel.is_following ? 'none' : `0 0 18px ${accentGlow}`,
                opacity: busy ? 0.7 : 1,
              }}
            >
              {channel.is_following ? '✓ Seguindo' : 'Seguir'}
            </button>
          )}

          {/* Icon row. State is the colour, and every one carries a
              title so the meaning is reachable without a label — the
              two toggles used to be full-width rows explaining
              themselves in a sentence each. */}
          <div style={{
            display: 'flex', gap: 8, marginTop: 8,
            // Passed down as custom properties rather than as a prop on
            // each of the seven IconActions below — they all belong to
            // the same channel, so the colour is a property of the row.
            '--channel-accent': accent,
            '--channel-accent-soft': accentSoft,
          }}>
            {/* The 🔔 and ⭐ switches lived here.
                
                Notification moved to the daily novidades push, which
                now says how many of the day's events came from your
                channels — one push instead of one per channel, which is
                what a person actually wants told once. Ordering stopped
                being a setting: a channel you're in belongs at the top
                of Eventos, and a switch for that was asking people to
                turn on the reason they joined.
                
                A private channel still pushes at the moment. There the
                event IS the message. */}
            {channel.feed_token
              && (channel.is_following || channel.can_curate || isPrivate) && (
              <IconAction onClick={() => setShowCalendar(true)} title="Assinar calendário">
                📅
              </IconAction>
            )}
            {/* Invite belongs to a private channel only: you follow a
                public one from an open list, and there is nobody to
                invite into something anyone can already find. */}
            {isPrivate && (
              <IconAction onClick={() => setShowInvite(true)} title="Convidar pro canal">
                ➕
              </IconAction>
            )}
            <IconAction onClick={share} title="Compartilhar canal">
              {copied ? '✓' : '🔗'}
            </IconAction>
            {/* Anyone in a private channel can add an event — control
                means administration, not publishing. In a public one
                that's the curation team, and the catalog picker is how. */}
            {isPrivate && (
              <IconAction onClick={() => setShowNewEvent(true)} accent title="Novo evento">
                ＋
              </IconAction>
            )}
            {channel.can_curate && (
              <IconAction onClick={() => setShowCatalog(true)} accent title="Adicionar do catálogo">
                🌍
              </IconAction>
            )}
          </div>
          {isPrivate && (
            <button
              onClick={leave}
              disabled={busy}
              style={{
                marginTop: 10, padding: '6px 0', background: 'none',
                border: 'none', fontSize: 11.5, color: 'var(--text3)',
                cursor: busy ? 'wait' : 'pointer', letterSpacing: '0.02em',
              }}
            >
              Sair do canal
            </button>
          )}
        </>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
          <p style={{
            flex: 1, fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.5,
            margin: 0, padding: '11px 13px',
            border: '1px dashed var(--line)', borderRadius: 12,
          }}>
            Entra com o Google pra seguir esse canal.
          </p>
          <IconAction onClick={share} title="Compartilhar canal">
            {copied ? '✓' : '🔗'}
          </IconAction>
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

      <InviteSheet
        open={showInvite}
        onClose={() => setShowInvite(false)}
        group={channel}
        t={{}}
      />
      <MembersSheet
        open={showMembers}
        onClose={() => setShowMembers(false)}
        group={{ ...channel, members: data.followers || [] }}
        t={{}}
        peopleWord={peopleWord}
        // Role management, kick and promote are the owner's. A follower
        // opening an auê channel's list gets the same sheet read-only —
        // names and "+ amigo", which is what they came for.
        viewerIsAdmin={channel.viewer_role === 'admin'}
        viewerGoogleId={googleId}
        onRoleChanged={load}
      />
      <PersonalPlanSheet
        open={showNewEvent}
        onClose={() => setShowNewEvent(false)}
        googleId={googleId}
        initialGroupId={channelId}
        onCreated={() => { setShowNewEvent(false); load() }}
      />

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
      background: on ? 'var(--channel-accent, var(--from-aue))' : 'var(--line)',
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

// One icon, one job, state in the colour. These were full-width rows
// with a sentence each — six of them stacked pushed the first event
// below the fold on an 844px screen.
//
// Every one carries a title, so the meaning is a long-press away
// instead of permanently occupying a line. That's the trade: the
// labels were doing real work for a first-time reader, and the cost
// was burying the thing they came for on every subsequent visit.
function IconAction({ children, onClick, disabled, on, accent, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        flex: '1 1 0', minWidth: 0, padding: '10px 0', borderRadius: 12,
        fontSize: 17, lineHeight: 1, cursor: disabled ? 'wait' : 'pointer',
        border: accent ? 'none'
          : `1px solid ${on ? 'var(--channel-accent, var(--from-aue))' : 'var(--line)'}`,
        background: accent
          ? 'var(--channel-accent, var(--from-aue))'
          : (on ? 'var(--channel-accent-soft, var(--from-aue-soft))' : 'var(--bg2)'),
        opacity: disabled ? 0.6 : (on === false ? 0.55 : 1),
      }}
    >
      {children}
    </button>
  )
}
