import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { fetchNotifications, trackEvent } from '../services/api'
import PushBanner from '../components/PushBanner'

// Notificações — what's waiting on you, plus what's new.
//
// Everything countable here is derived from existing state rather than
// stored when something happens (see GET /notifications). Two things
// follow from that, and both are visible on this screen:
//
//   - The badge and this list come from one query, so they can never
//     disagree.
//   - Nothing clears by being looked at. An item leaves because you
//     answered the invite or accepted the friend. That's why the number
//     stays worth reading.
//
// Actionable items sit above informational ones, and only actionable
// ones carry the count. "There is new stuff" never reaches zero, and a
// badge that never reaches zero stops being seen within a week.

const KIND_META = {
  event_invite:      { emoji: '📨', cta: 'Ver convite' },
  friend_request:    { emoji: '👋', cta: 'Ver pedido' },
  curation_events:   { emoji: '📋', cta: 'Revisar' },
  curation_accounts: { emoji: '📋', cta: 'Revisar' },
  digest:            { emoji: '✨', cta: 'Ver novidades' },
}

function relativeTime(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const mins = Math.round((t - Date.now()) / 60000)
  const abs = Math.abs(mins)
  const future = mins > 0
  if (abs < 60) return future ? `em ${abs}min` : `há ${abs}min`
  const hours = Math.round(abs / 60)
  if (hours < 24) return future ? `em ${hours}h` : `há ${hours}h`
  const days = Math.round(hours / 24)
  return future ? `em ${days}d` : `há ${days}d`
}

export default function Notifications() {
  const navigate = useNavigate()
  const { state } = useApp()
  const googleId = state.googleUser?.id
  const email = state.googleUser?.email
  const [items, setItems] = useState(null)   // null = loading

  const load = useCallback(() => {
    fetchNotifications(googleId, email).then(data => setItems(data.items))
  }, [googleId, email])

  useEffect(() => { load() }, [load])

  // Refresh when the tab regains focus: acting on an item usually
  // happens on another screen, and coming back to a stale list that
  // still shows what you just answered is how people stop trusting it.
  useEffect(() => {
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [load])

  function open(item) {
    trackEvent('notification_opened', { kind: item.kind })
    switch (item.kind) {
      case 'event_invite':
        navigate('/events', { state: { openEventId: item.ref_id } })
        break
      case 'friend_request':
        navigate('/community', { state: { tab: 'friends' } })
        break
      case 'curation_events':
      case 'curation_accounts':
        navigate('/curadoria')
        break
      case 'digest':
        navigate(`/novidades/${item.ref_id}`)
        break
      default:
        break
    }
  }

  const actionable = (items || []).filter(i => i.actionable)
  const rest = (items || []).filter(i => !i.actionable)

  return (
    <div style={{ paddingBottom: 90 }}>
      <div style={{ padding: '18px 18px 0' }}>
        <h1 className="neon-display" style={{
          fontSize: 28, color: 'var(--text)', letterSpacing: '-0.025em',
          margin: 0, lineHeight: 1.1,
        }}>
          Notifi<span className="neon-glow-mag">cações</span>
        </h1>
      </div>

      {/* The push ask, made from the screen about being notified. It
          lived on Home until Home dissolved; this is the first place it
          has actually been about something. */}
      <PushBanner />

      <div style={{ padding: '16px 18px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items === null && (
          <div className="neon-mono" style={{ fontSize: 11, color: 'var(--text3)' }}>
            Carregando...
          </div>
        )}

        {items !== null && items.length === 0 && (
          <div style={{
            padding: '22px 16px', borderRadius: 16,
            border: '1px dashed var(--line)', textAlign: 'center',
            fontSize: 13, color: 'var(--text2)', lineHeight: 1.5,
          }}>
            {googleId
              ? 'Nada esperando por você. Bora ver o que tá rolando?'
              : 'Entra na tua conta pra ver convites e pedidos.'}
          </div>
        )}

        {actionable.length > 0 && (
          <SectionLabel>Esperando você</SectionLabel>
        )}
        {actionable.map(item => (
          <Row key={item.id} item={item} onClick={() => open(item)} accent />
        ))}

        {rest.length > 0 && <SectionLabel>Novidades</SectionLabel>}
        {rest.map(item => (
          <Row key={item.id} item={item} onClick={() => open(item)} />
        ))}
      </div>
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div className="neon-mono" style={{
      fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
      color: 'var(--text2)', marginTop: 6,
    }}>
      {children}
    </div>
  )
}

function Row({ item, onClick, accent }) {
  const meta = KIND_META[item.kind] || { emoji: '•', cta: 'Abrir' }
  const when = relativeTime(item.at)
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%',
        textAlign: 'left', cursor: 'pointer',
        background: 'var(--bg2)', borderRadius: 14, padding: '13px 14px',
        // Actionable rows get the magenta edge — the same signal the
        // badge uses, so the tab and the row agree about what's urgent.
        border: '1px solid var(--line)',
        boxShadow: accent ? 'inset 3px 0 0 var(--magenta)' : 'none',
      }}
    >
      <span style={{ fontSize: 18, flexShrink: 0 }}>{meta.emoji}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: 14, fontWeight: 700, color: 'var(--text)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {item.title}
        </span>
        <span style={{
          display: 'block', fontSize: 12, color: 'var(--text2)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {item.body}{item.body && when ? ' · ' : ''}{when}
        </span>
      </span>
      <span className="neon-mono" style={{
        flexShrink: 0, fontSize: 10, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: accent ? 'var(--magenta)' : 'var(--text3)',
      }}>
        {meta.cta}
      </span>
    </button>
  )
}
