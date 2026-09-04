import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { useApp, PROFILES } from '../context/AppContext'
import { useT } from '../i18n'
import { mountGoogleButton, isGoogleConfigured, MOCK_GOOGLE_USER } from '../lib/google-auth'
import { signInWithApple } from '../lib/apple-auth'
import { getPublicOrigin } from '../lib/share'
import { fetchBadgesCatalog, fetchUserBadges, fetchUserStats, deleteUserAccount } from '../services/api'
import { usePushNotifications, isPushSupported } from '../lib/usePushNotifications'
import Avatar from '../components/Avatar'
import Aue from '../components/Aue'

export default function Profile() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const t = useT()
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(state.userName)
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  // Account deletion has two entry points — next to the email at the top
  // (where App Review looks for it, per Guideline 5.1.1(v)) and in the
  // settings footer. Both drive the same confirmation block, so the top
  // link expands it and scrolls it into view rather than duplicating the UI.
  const deleteSectionRef = useRef(null)
  // Carried in via navigate('/profile', { state: { openBadge: '...' }})
  // — currently from the badge-unlock toast. BadgesSection auto-opens
  // the matching detail modal and scrolls into view.
  const initialOpenBadge = location.state?.openBadge ?? null

  function saveName() {
    if (nameInput.trim()) dispatch({ type: 'SET_NAME', payload: nameInput.trim() })
    setEditingName(false)
  }

  function handleReset() {
    dispatch({ type: 'RESET' })
    window.location.hash = '/'
    window.location.reload()
  }

  function openDeleteConfirm() {
    setDeleteConfirm(true)
    // Wait for the confirmation block to render before scrolling to it.
    setTimeout(() => {
      deleteSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  async function handleDeleteAccount() {
    const googleId = state.googleUser?.id
    if (!googleId) { handleReset(); return }
    setDeletingAccount(true)
    try {
      await deleteUserAccount(googleId)
    } catch (_) {
      // Ignore network errors — still wipe local state so user is unblocked
    } finally {
      setDeletingAccount(false)
      setDeleteConfirm(false)
      dispatch({ type: 'RESET' })
      window.location.hash = '/'
      window.location.reload()
    }
  }

  return (
    <div>
      {/* Sign-in card — only when no Google account is connected. Lets
          users who skipped onboarding sign in later (needed for curator
          access, friend code, RSVP sync). */}
      {!state.googleUser && <SignInCard dispatch={dispatch} />}

      {/* Hero — Neon Boteco palette: dark bg2 base with cyan + magenta
          radial gradients in opposite corners (mirrors the community
          card on Home, the event hero in Detail). */}
      <div style={{
        background:
          'radial-gradient(circle at 20% 20%, rgba(255, 43, 214, 0.35) 0%, transparent 55%),' +
          ' radial-gradient(circle at 80% 80%, rgba(0, 229, 255, 0.30) 0%, transparent 55%),' +
          ' var(--bg2)',
        borderBottom: '1px solid var(--line)',
        padding: '20px 24px 28px', textAlign: 'center', color: 'var(--text)',
      }}>
        <div style={{ margin: '0 auto 12px', width: 72 }}>
          <Avatar
            src={state.googleUser?.picture}
            name={state.userName || state.googleUser?.givenName || state.googleUser?.name}
            size={72}
            bordered
          />
        </div>

        {editingName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveName()}
              autoFocus maxLength={30}
              style={{
                fontSize: 18, fontWeight: 700, color: 'white',
                background: 'rgba(255,255,255,0.12)',
                border: '1.5px solid rgba(255,255,255,0.3)',
                borderRadius: 10, padding: '5px 12px',
                outline: 'none', textAlign: 'center', width: 160,
              }}
            />
            <button
              onClick={saveName}
              style={{ fontSize: 18, color: 'var(--sage-light)', background: 'none', border: 'none', cursor: 'pointer' }}
            >✓</button>
          </div>
        ) : (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', cursor: 'pointer' }}
            onClick={() => { setNameInput(state.userName || ''); setEditingName(true) }}
          >
            <span style={{ fontSize: 20, fontWeight: 700 }}>{state.userName || '—'}</span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>✎</span>
          </div>
        )}

        {state.googleUser?.email && (
          <div style={{
            fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            {state.googleUser.email}
            <button
              onClick={() => {
                if (confirm('Sair da conta Google? Você pode voltar a entrar quando quiser.')) {
                  dispatch({ type: 'SET_GOOGLE_USER', payload: null })
                }
              }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.55)', fontSize: 11, padding: 0,
                textDecoration: 'underline',
              }}
            >
              sair
            </button>
            <span style={{ color: 'rgba(255,255,255,0.25)' }}>·</span>
            <button
              onClick={openDeleteConfirm}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.55)', fontSize: 11, padding: 0,
                textDecoration: 'underline',
              }}
            >
              deletar conta
            </button>
          </div>
        )}
      </div>

      {/* Minha vibe — profile picker */}
      <VibeSection state={state} dispatch={dispatch} />

      {/* Compartilhar / Instalar — drives PWA distribution to friends */}
      <ShareInstallSection />

      {/* Notifications — placed right above Conquistas so the push opt-in
          is the first decision after the share card. Earlier we had it
          below Privacy at the bottom of the screen, which left it
          discoverable only to users who scrolled to settings. */}
      <NotificationsCard t={t} state={state} dispatch={dispatch} />

      {/* Conquistas — badges already earned + locked grid of what's possible */}
      <BadgesSection
        googleId={state.googleUser?.id}
        initialOpenBadge={initialOpenBadge}
      />

      {/* Recordes — lifetime counters that only go up. No streak anxiety. */}
      <RecordsSection googleId={state.googleUser?.id} />

      {/* Feedback — only visible to users granted the feedbacker role */}
      <FeedbackSection state={state} />

      {/* Language toggle */}
      <div style={{ margin: '16px 16px 12px' }} className="card">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 12 }}>
          {t.profile_language_label}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { code: 'pt', label: '🇧🇷  Português' },
            { code: 'en', label: '🇺🇸  English' },
          ].map(({ code, label }) => (
            <button
              key={code}
              onClick={() => dispatch({ type: 'SET_LANGUAGE', payload: code })}
              style={{
                flex: 1, padding: '10px 0', borderRadius: 12, fontSize: 13, fontWeight: 600,
                cursor: 'pointer', transition: 'all 0.15s',
                border: state.language === code ? 'none' : '1.5px solid var(--border)',
                background: state.language === code ? 'var(--charcoal)' : 'transparent',
                color: state.language === code ? 'white' : 'var(--charcoal-mid)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Accessibility mode toggle */}
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
              {t.accessibility_mode}
            </div>
            <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
              {t.accessibility_description}
            </div>
          </div>
          <button
            onClick={() => dispatch({ type: 'TOGGLE_ACCESSIBILITY' })}
            style={{
              width: 52, height: 30, borderRadius: 15, border: 'none',
              background: state.accessibilityMode ? 'var(--sage)' : 'var(--border)',
              cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
              flexShrink: 0, marginLeft: 12,
            }}
          >
            <div style={{
              width: 24, height: 24, borderRadius: '50%', background: 'var(--white)',
              position: 'absolute', top: 3,
              left: state.accessibilityMode ? 25 : 3,
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
            }} />
          </button>
        </div>
      </div>

      {/* Privacy settings */}
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 12 }}>
          🔒 {t.privacy_title ?? 'Privacy'}
        </div>
        {[
          { key: 'shareRsvps',              label: t.privacy_share_rsvps ?? 'Share RSVPs with friends',         desc: t.privacy_share_rsvps_desc ?? 'Your friends can see events you confirmed' },
          { key: 'showInFriendSuggestions', label: t.privacy_show_suggestions ?? 'Appear in friend suggestions', desc: t.privacy_show_suggestions_desc ?? 'Other people can find your profile' },
          { key: 'showProfileToStrangers',  label: t.privacy_show_profile ?? 'Profile visible to non-friends',   desc: t.privacy_show_profile_desc ?? 'Non-friends can see your full profile' },
        ].map(({ key, label, desc }, i, arr) => {
          const value = state.privacy?.[key] ?? (key === 'shareRsvps' ? state.shareRsvps : false)
          return (
            <div
              key={key}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 0',
                borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <div style={{ flex: 1, paddingRight: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>{label}</div>
                <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
              </div>
              <button
                onClick={() => dispatch({ type: 'SET_PRIVACY_OPTION', payload: { key, value: !value } })}
                style={{
                  width: 44, height: 26, borderRadius: 13, border: 'none',
                  background: value ? 'var(--sage)' : 'var(--border)',
                  position: 'relative', cursor: 'pointer', flexShrink: 0,
                  transition: 'background 0.2s',
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  background: 'var(--white)', position: 'absolute', top: 3,
                  left: value ? 21 : 3,
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>
          )
        })}
      </div>

      {/* Transparency: link to the sources catalog */}
      <div style={{ margin: '0 16px 12px' }} className="card">
        <button
          onClick={() => navigate('/sources')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', textAlign: 'left', padding: 0,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
              📡 Fontes monitoradas
            </div>
            <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
              Veja de onde vem o catálogo do <Aue />.
            </div>
          </div>
          <span style={{ fontSize: 16, color: 'var(--charcoal-light)' }}>→</span>
        </button>
      </div>

      {/* Redo onboarding + Reset (dev affordances) */}
      <div style={{ padding: '4px 16px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => {
            dispatch({ type: 'REDO_ONBOARDING' })
            navigate('/')
          }}
          style={{ fontSize: 12, color: 'var(--terra)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
        >
          {t.profile_redo_onboarding ?? 'Refazer onboarding'}
        </button>
        <button
          onClick={handleReset}
          style={{ fontSize: 11, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          {t.profile_reset}
        </button>

        {/* Account deletion — required by Apple Guideline 5.1.1(v) */}
        <div ref={deleteSectionRef} style={{ marginTop: 4 }}>
        {!deleteConfirm ? (
          <button
            onClick={openDeleteConfirm}
            style={{ fontSize: 12, color: 'var(--charcoal-mid)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
          >
            Deletar conta
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--bg2)', borderRadius: 10, border: '1px solid var(--line)' }}>
            <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.4 }}>
              Apaga teus RSVPs, amigos e histórico permanentemente.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setDeleteConfirm(false)}
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, border: '1px solid var(--line)', background: 'none', color: 'var(--charcoal-mid)', cursor: 'pointer' }}
              >
                Cancelar
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deletingAccount}
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, border: 'none', background: '#c0392b', color: '#fff', cursor: deletingAccount ? 'default' : 'pointer', opacity: deletingAccount ? 0.6 : 1 }}
              >
                {deletingAccount ? 'Deletando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}


// ── Notifications card ──────────────────────────────────
//
// Subscribe-then-toggle pattern: the device must explicitly opt into
// push (browser perm + pushManager.subscribe + backend register) before
// the per-type toggles do anything. Without this gate, flipping
// "Resumo diário" ON would silently set a preference no channel can
// honor, and the user would assume push is broken.
function NotificationsCard({ t, state, dispatch }) {
  const { subscribed, subscribe, unsubscribe, loading, error } = usePushNotifications()
  const supported = isPushSupported()
  const dailyDigest = state.privacy?.dailyDigest ?? true

  if (!supported) {
    return (
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 8 }}>
          🔔 {t.notifications_title ?? 'Notificações'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5 }}>
          {t.notif_unsupported
            ?? 'Push não funciona neste navegador. Instale o auê na tela inicial (Adicionar à Tela de Início) ou use Chrome/Firefox.'}
        </div>
      </div>
    )
  }

  return (
    <div style={{ margin: '0 16px 12px' }} className="card">
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 12 }}>
        🔔 {t.notifications_title ?? 'Notificações'}
      </div>

      {/* Step 1 — device subscription. When already subscribed, shows a
          confirmation pill + a "Desativar" link. When not, shows a
          single primary CTA. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, paddingBottom: 12, marginBottom: 12,
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>
            {subscribed
              ? (t.notif_status_on ?? '✓ Push ativado neste dispositivo')
              : (t.notif_status_off ?? 'Push desativado')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2, lineHeight: 1.4 }}>
            {subscribed
              ? (t.notif_status_on_desc ?? 'Você vai receber as notificações abaixo nesse browser.')
              : (t.notif_status_off_desc ?? 'Ative pra receber pings de novos rolês e convites.')}
          </div>
          {error && (
            <div style={{ fontSize: 11, color: '#C62828', marginTop: 6 }}>
              {error}
            </div>
          )}
        </div>
        {subscribed ? (
          <button
            onClick={unsubscribe}
            disabled={loading}
            style={{
              fontSize: 11, fontWeight: 600,
              padding: '8px 12px', borderRadius: 8,
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--charcoal-mid)', cursor: 'pointer',
              opacity: loading ? 0.6 : 1, flexShrink: 0,
            }}
          >
            {loading ? '...' : (t.notif_disable ?? 'Desativar')}
          </button>
        ) : (
          <button
            onClick={subscribe}
            disabled={loading}
            style={{
              fontSize: 12, fontWeight: 700,
              padding: '10px 14px', borderRadius: 10, border: 'none',
              background: 'var(--sage)', color: '#14081E',
              cursor: 'pointer', opacity: loading ? 0.6 : 1, flexShrink: 0,
            }}
          >
            {loading ? '...' : (t.notif_enable ?? 'Ativar push')}
          </button>
        )}
      </div>

      {/* Step 2 — per-type toggles. Disabled (greyed) when not subscribed
          so users don't think they're armed. Clicking the disabled label
          could prompt to subscribe, but for v1 keep it simple — they
          tap "Ativar push" above first. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 0',
        opacity: subscribed ? 1 : 0.45,
      }}>
        <div style={{ flex: 1, paddingRight: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>
            {t.notif_daily_digest ?? 'Resumo diário do auê'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2, lineHeight: 1.4 }}>
            {t.notif_daily_digest_desc
              ?? 'Toda tarde, depois do scrape — uma push com os novos rolês de Curitiba. Toque pra ver o evento.'}
          </div>
        </div>
        <button
          onClick={() => {
            if (!subscribed) return
            dispatch({ type: 'SET_PRIVACY_OPTION', payload: { key: 'dailyDigest', value: !dailyDigest } })
          }}
          disabled={!subscribed}
          style={{
            width: 44, height: 26, borderRadius: 13, border: 'none',
            background: dailyDigest ? 'var(--sage)' : 'var(--border)',
            position: 'relative',
            cursor: subscribed ? 'pointer' : 'not-allowed',
            flexShrink: 0, transition: 'background 0.2s',
          }}
        >
          <div style={{
            width: 20, height: 20, borderRadius: '50%',
            background: 'var(--white)', position: 'absolute', top: 3,
            left: dailyDigest ? 21 : 3,
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }} />
        </button>
      </div>
    </div>
  )
}


// ── Feedback — open to any signed-in user ────────────────
function FeedbackSection({ state }) {
  const email = state.googleUser?.email
  const googleId = state.googleUser?.id
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState(null) // 'sent' | 'error' | null
  const API_BASE = import.meta.env.VITE_API_URL ??
    (import.meta.env.DEV ? 'http://localhost:8000' : '')

  async function submit() {
    if (text.trim().length < 5 || submitting) return
    setSubmitting(true)
    setStatus(null)
    try {
      const r = await fetch(`${API_BASE}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          context: window.location.hash || '',
          requesting_email: email,
          google_id: googleId || '',
        }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setText('')
      setStatus('sent')
      setTimeout(() => { setOpen(false); setStatus(null) }, 1500)
    } catch {
      setStatus('error')
    }
    setSubmitting(false)
  }

  if (!email) return null

  return (
    <div style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: open ? 12 : 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
            💬 Mandar feedback
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
            Sugestões, bugs, ideias — manda direto pra equipe.
          </div>
        </div>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 10, padding: '6px 12px', fontSize: 12, fontWeight: 600,
            color: 'var(--charcoal-mid)', cursor: 'pointer', flexShrink: 0, marginLeft: 12,
          }}
        >
          {open ? 'fechar' : 'abrir'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 6 }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="O que tá funcionando, o que tá travando, o que faltaria…"
            rows={4}
            maxLength={4000}
            style={{
              width: '100%', resize: 'vertical', minHeight: 80,
              padding: '10px 12px', borderRadius: 10,
              border: '1px solid var(--border)',
              fontSize: 13, fontFamily: 'inherit', outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 8, gap: 10,
          }}>
            <div style={{ fontSize: 11, color: status === 'sent' ? 'var(--sage)' : status === 'error' ? '#B71C1C' : 'var(--charcoal-light)' }}>
              {status === 'sent' ? 'Enviado, valeu! ✓'
                : status === 'error' ? 'Falhou — tenta de novo.'
                : `${text.length}/4000`}
            </div>
            <button
              onClick={submit}
              disabled={text.trim().length < 5 || submitting}
              style={{
                padding: '8px 16px', borderRadius: 10, border: 'none',
                background: 'var(--sage)', color: '#14081E',
                fontSize: 12, fontWeight: 700,
                cursor: text.trim().length < 5 || submitting ? 'not-allowed' : 'pointer',
                opacity: text.trim().length < 5 || submitting ? 0.5 : 1,
              }}
            >
              {submitting ? 'Enviando…' : 'Mandar'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


// ── "Minha vibe" — profile picker ─────────────────────────
// Lets the user pick (or change) their profile any time. Profile drives
// the default mood + the order of suggestions on Home. Setting null
// clears the profile back to "no preference".
function VibeSection({ state, dispatch }) {
  const [editing, setEditing] = useState(false)
  const profile = state.profile ? PROFILES[state.profile] : null
  const profiles = Object.values(PROFILES)

  function pick(profileId) {
    dispatch({ type: 'SET_PROFILE', payload: profileId })
    setEditing(false)
  }

  return (
    <div style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: editing ? 14 : 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
            Minha vibe
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
            {profile
              ? `${profile.emoji} ${profile.label} · ${profile.blurb}`
              : 'Sem preferência — sugestões em ordem de data.'}
          </div>
        </div>
        <button
          onClick={() => setEditing(v => !v)}
          style={{
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 10, padding: '6px 12px', fontSize: 12, fontWeight: 600,
            color: 'var(--charcoal-mid)', cursor: 'pointer', flexShrink: 0,
            marginLeft: 12,
          }}
        >
          {editing ? 'fechar' : 'trocar'}
        </button>
      </div>

      {editing && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
        }}>
          {profiles.map(p => {
            const selected = state.profile === p.id
            return (
              <button
                key={p.id}
                onClick={() => pick(p.id)}
                style={{
                  background: selected ? 'var(--sage-pale)' : 'white',
                  border: `1.5px solid ${selected ? 'var(--sage)' : 'var(--border)'}`,
                  borderRadius: 12, padding: '12px 10px',
                  textAlign: 'left', cursor: 'pointer',
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}
              >
                <div style={{ fontSize: 22, lineHeight: 1 }}>{p.emoji}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>{p.label}</div>
                <div style={{ fontSize: 10, color: 'var(--charcoal-mid)', lineHeight: 1.35 }}>
                  {p.blurb}
                </div>
              </button>
            )
          })}
          {state.profile && (
            <button
              onClick={() => pick(null)}
              style={{
                gridColumn: 'span 2',
                background: 'transparent', border: '1px dashed var(--border)',
                borderRadius: 10, padding: '8px', fontSize: 12,
                color: 'var(--charcoal-light)', cursor: 'pointer',
              }}
            >
              Limpar perfil (sem preferência)
            </button>
          )}
        </div>
      )}
    </div>
  )
}


// ── Share + Install (PWA distribution) ───────────────────
// Two complementary CTAs:
//   - "Compartilhar" uses Web Share API (mobile native sheet) with a
//     clipboard fallback. Always visible.
//   - "Instalar como app" only appears in browsers that fired the
//     beforeinstallprompt event (Chrome/Edge/Brave on Android+desktop).
//     iOS Safari never fires it — those users go to /install for the
//     manual Add to Home Screen walkthrough.
function ShareInstallSection() {
  const [canInstall, setCanInstall] = useState(
    typeof window !== 'undefined' && !!window.__aueDeferredInstallPrompt
  )
  const [feedback, setFeedback] = useState(null)
  const [qrFullscreen, setQrFullscreen] = useState(false)
  const isStandalone = typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(display-mode: standalone)').matches
  const installUrl = typeof window !== 'undefined'
    ? `${getPublicOrigin()}/install`
    : 'https://reroot-production.up.railway.app/install'

  useEffect(() => {
    function onAvailable() { setCanInstall(true) }
    function onInstalled() { setCanInstall(false) }
    window.addEventListener('aue-install-available', onAvailable)
    window.addEventListener('aue-install-installed', onInstalled)
    return () => {
      window.removeEventListener('aue-install-available', onAvailable)
      window.removeEventListener('aue-install-installed', onInstalled)
    }
  }, [])

  function flashFeedback(msg) {
    setFeedback(msg)
    setTimeout(() => setFeedback(null), 3000)
  }

  async function handleShare() {
    const url = `${getPublicOrigin()}/install`
    const text = 'Olha o auê — app de eventos em Curitiba. Bora ver o que tá rolando? 🎉'
    if (navigator.share) {
      try {
        await navigator.share({ title: 'auê — Curitiba que acontece', text, url })
      } catch {
        // User cancelled — silent
      }
      return
    }
    // Fallback: copy to clipboard
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url)
        flashFeedback('✓ Link copiado — cola onde quiser mandar.')
      } catch {
        flashFeedback('Não foi possível copiar — tenta colar manualmente: ' + url)
      }
    } else {
      window.prompt('Copie o link:', url)
    }
  }

  async function handleInstall() {
    const ev = window.__aueDeferredInstallPrompt
    if (!ev) return
    try {
      ev.prompt()
      const choice = await ev.userChoice
      if (choice?.outcome === 'accepted') flashFeedback('✓ Instalando…')
    } catch {
      // Browser rejected — likely already installed or blocked
    } finally {
      window.__aueDeferredInstallPrompt = null
      setCanInstall(false)
    }
  }

  return (
    <div style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
        📲 Compartilhar auê
      </div>
      <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginBottom: 12, lineHeight: 1.5 }}>
        {isStandalone
          ? 'Você já tem o auê instalado. Manda pra galera testar.'
          : 'Manda pros amigos pelo WhatsApp/SMS. Cada um instala como app no celular.'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={handleShare}
          style={{
            width: '100%', padding: '11px 14px',
            border: 'none', borderRadius: 12,
            background: 'radial-gradient(circle at 20% 20%, rgba(255, 43, 214, 0.35) 0%, transparent 55%), radial-gradient(circle at 80% 80%, rgba(0, 229, 255, 0.30) 0%, transparent 55%), var(--bg2)',
            color: 'white', fontWeight: 700, fontSize: 13,
            cursor: 'pointer', fontFamily: 'inherit',
            boxShadow: '0 4px 14px rgba(255, 43, 214, 0.25)',
          }}
        >
          Compartilhar com amigos
        </button>
        {canInstall && !isStandalone && (
          <button
            onClick={handleInstall}
            style={{
              width: '100%', padding: '11px 14px',
              border: '1.5px solid var(--terra)',
              borderRadius: 12, background: 'transparent',
              color: 'var(--terra)', fontWeight: 700, fontSize: 13,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            📥 Instalar como app
          </button>
        )}
      </div>
      {feedback && (
        <div style={{
          fontSize: 11, color: 'var(--sage)', marginTop: 8, textAlign: 'center',
          fontWeight: 600,
        }}>
          {feedback}
        </div>
      )}

      {/* QR code — for in-person sharing. Tap to enlarge to fullscreen
          so the other phone can scan it from across a café table. */}
      <div style={{
        marginTop: 14, paddingTop: 14,
        borderTop: '1px dashed var(--border)',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <button
          onClick={() => setQrFullscreen(true)}
          aria-label="Mostrar QR code em tela cheia"
          style={{
            background: 'var(--white)', border: '1px solid var(--border)',
            borderRadius: 10, padding: 6, cursor: 'pointer',
            flexShrink: 0, display: 'flex',
          }}
        >
          <QRCodeSVG value={installUrl} size={88} level="M" includeMargin={false} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 2 }}>
            QR pra mostrar pessoalmente
          </div>
          <div style={{ fontSize: 10, color: 'var(--charcoal-light)', lineHeight: 1.4 }}>
            Tá com alguém aqui? Toque pra ver grande — e aponte a câmera dele pra esse QR.
          </div>
        </div>
      </div>

      {/* Fullscreen overlay — black-out backdrop with the QR scaled big.
          Tap anywhere to dismiss. */}
      <AnimatePresence>
        {qrFullscreen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setQrFullscreen(false)}
            style={{
              position: 'fixed', inset: 0,
              background: 'rgba(20, 20, 20, 0.9)',
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              zIndex: 500, cursor: 'pointer',
              padding: 20,
            }}
          >
            <motion.div
              initial={{ scale: 0.85 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.85 }}
              transition={{ type: 'spring', damping: 22, stiffness: 280 }}
              style={{
                background: 'var(--white)', padding: 24, borderRadius: 20,
                boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
              }}
            >
              <QRCodeSVG value={installUrl} size={260} level="M" includeMargin={false} />
            </motion.div>
            <div style={{
              color: 'white', fontSize: 14, fontWeight: 600,
              marginTop: 22, textAlign: 'center', maxWidth: 280,
              lineHeight: 1.5, opacity: 0.9,
            }}>
              Aponte a câmera do outro celular.<br/>
              <span style={{ fontSize: 12, opacity: 0.7 }}>Toque em qualquer lugar pra fechar.</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}


// ── Conquistas (badges) ───────────────────────────────────
// Renders the full badge catalog with earned ones in color and locked
// ones grayed out. Tap a tile (earned or locked) to expand a panel with
// the full description, tier ladder, and (for multi-instance) the list
// of venues with their tiers. v3 added tier ladders (I/II/III/IV) so the
// same template keeps giving progress beyond the first threshold.
//
// Tier visual: small "II" / "III" badge in the corner of the tile. Border
// color escalates bronze → silver → gold → diamond. Tier 0 = locked.
// Tier tones — metallic medal vibe (Bronze · Prata · Ouro · Platina).
// Solid `color` for borders/pins where a flat tone reads cleaner; `gradient`
// for fills where the metallic shimmer carries the achievement feel.
const TIER_TONE = {
  1: {
    name: 'Bronze',
    color: '#B87333',
    gradient: 'linear-gradient(135deg, #DA9863 0%, #8B5A2B 100%)',
  },
  2: {
    name: 'Prata',
    color: '#8B8B8B',
    gradient: 'linear-gradient(135deg, #E5E5E5 0%, #6F6F6F 100%)',
  },
  3: {
    name: 'Ouro',
    color: '#D4A017',
    gradient: 'linear-gradient(135deg, #FFE680 0%, #B88500 100%)',
  },
  4: {
    name: 'Platina',
    color: '#7C8FA3',
    gradient: 'linear-gradient(135deg, #C8D4DE 0%, #5A748A 100%)',
  },
}
const TIER_NUMERAL = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' }
function tierOf(n) { return TIER_TONE[n] || TIER_TONE[1] }

function BadgesSection({ googleId, initialOpenBadge = null }) {
  const navigate = useNavigate()
  const sectionRef = useRef(null)
  const [catalog, setCatalog] = useState([])
  const [earned, setEarned] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedBadge, setExpandedBadge] = useState(null) // base_id of tapped tile

  // Listen for new unlocks fired during this session — refresh in-place
  // so the section reflects what the toast just announced.
  useEffect(() => {
    let canceled = false
    async function load() {
      const [cat, mine] = await Promise.all([
        fetchBadgesCatalog(),
        googleId ? fetchUserBadges(googleId) : Promise.resolve([]),
      ])
      if (canceled) return
      setCatalog(cat)
      setEarned(mine)
      setLoading(false)
    }
    load()
    function onUnlock() { if (googleId) fetchUserBadges(googleId).then(setEarned) }
    window.addEventListener('badge-unlocked', onUnlock)
    return () => {
      canceled = true
      window.removeEventListener('badge-unlocked', onUnlock)
    }
  }, [googleId])

  // External request to open a specific badge modal — comes via the
  // /profile location state when a user taps the badge-unlock toast.
  // Wait until catalog is loaded before opening, then scroll the section
  // into view + clear the location state so refresh/back doesn't re-fire.
  useEffect(() => {
    if (!initialOpenBadge || loading) return
    setExpandedBadge(initialOpenBadge)
    sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    navigate('.', { replace: true, state: null })
  }, [initialOpenBadge, loading, navigate])

  if (loading || catalog.length === 0) return null

  // Group earned by base_id so "local_da_casa:cafe_lucca" rolls up under
  // the catalog tile for "local_da_casa". Track the highest tier reached
  // so multi-instance badges show their best venue's tier on the tile.
  const earnedByBase = {} // base_id -> array of earned rows
  for (const b of earned) {
    const base = b.base_id || b.id
    if (!earnedByBase[base]) earnedByBase[base] = []
    earnedByBase[base].push(b)
  }

  const earnedTemplateCount = Object.keys(earnedByBase).filter(b => catalog.find(c => c.id === b)).length

  return (
    <div ref={sectionRef} style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
          🏆 Conquistas
        </div>
        <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', fontWeight: 600 }}>
          {earnedTemplateCount} / {catalog.length}
        </div>
      </div>
      {!googleId && (
        <div style={{
          fontSize: 11, color: 'var(--charcoal-light)', lineHeight: 1.5,
          padding: '8px 0', textAlign: 'center',
        }}>
          Faça login pra desbloquear conquistas conforme você usa o auê.
        </div>
      )}
      <div style={{
        fontSize: 10, color: 'var(--charcoal-light)', marginBottom: 8, textAlign: 'center',
        lineHeight: 1.45,
      }}>
        Toque pra ver detalhe e progresso até o próximo tier.<br/>
        <span style={{ opacity: 0.8 }}>
          As conquistas de participação <strong>atualizam após o evento rolar</strong> —
          o "Primeiro auê" cai assim que você confirma.
        </span>
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
      }}>
        {catalog.map(badge => {
          const instances = earnedByBase[badge.id] || []
          const isEarned = instances.length > 0
          const maxTier = isEarned ? Math.max(...instances.map(i => i.tier || 1)) : 0
          const hasLadder = (badge.max_tier || 1) > 1
          const isExpanded = expandedBadge === badge.id
          const tone = isEarned && hasLadder ? tierOf(maxTier) : null
          return (
            <button
              key={badge.id}
              onClick={() => setExpandedBadge(isExpanded ? null : badge.id)}
              title={badge.desc}
              style={{
                position: 'relative',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 4, padding: '10px 6px', borderRadius: 12,
                background: isExpanded
                  ? 'var(--terra-pale)'
                  : isEarned ? 'var(--cream)' : '#F7F5F0',
                border: `${tone ? 2 : 1}px solid ${tone ? tone.color : (isEarned ? 'var(--terra-pale)' : 'var(--border)')}`,
                opacity: isEarned ? 1 : 0.45,
                cursor: 'pointer', transition: 'opacity 0.2s, background 0.2s, border-color 0.2s',
                fontFamily: 'inherit',
              }}
            >
              {/* Tier numeral pin — uses metallic gradient so the medal vibe
                  reads at a glance even on a 28px tile */}
              {tone && (
                <div style={{
                  position: 'absolute', top: 4, right: 4,
                  fontSize: 9, fontWeight: 800, lineHeight: 1,
                  color: 'white', background: tone.gradient,
                  padding: '2px 6px', borderRadius: 4,
                  letterSpacing: 0.5,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                  textShadow: '0 1px 1px rgba(0,0,0,0.25)',
                }}>{TIER_NUMERAL[maxTier] || maxTier}</div>
              )}
              <div style={{
                fontSize: 26, lineHeight: 1,
                filter: isEarned ? 'none' : 'grayscale(0.8)',
              }}>{badge.emoji}</div>
              <div style={{
                fontSize: 10, fontWeight: 700, textAlign: 'center',
                color: isEarned ? 'var(--charcoal)' : 'var(--charcoal-light)',
                lineHeight: 1.2,
              }}>{badge.label}</div>
              {badge.multi_instance && isEarned && (
                <div style={{
                  fontSize: 9, fontWeight: 700, color: 'var(--terra)',
                  marginTop: -2,
                }}>×{instances.length}</div>
              )}
            </button>
          )
        })}
      </div>

      {/* Detail modal — replaces the inline expansion. Modal feels more
          like an "achievement reveal" than a spreadsheet row. */}
      <BadgeDetailModal
        badge={expandedBadge ? catalog.find(c => c.id === expandedBadge) : null}
        instances={expandedBadge ? (earnedByBase[expandedBadge] || []) : []}
        onClose={() => setExpandedBadge(null)}
      />
    </div>
  )
}


// ── Badge detail modal ───────────────────────────────────
// Celebratory popup for a tapped badge — big emoji, tier ladder,
// instance list (for multi-instance), and a "locked" state for badges
// the user hasn't earned yet (still tappable so they see what's possible).
function BadgeDetailModal({ badge, instances = [], onClose }) {
  // Close on Escape — desktop ergonomics for free.
  useEffect(() => {
    if (!badge) return
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [badge, onClose])

  return (
    <AnimatePresence>
      {badge && (() => {
        const isEarned = instances.length > 0
        const hasLadder = (badge.max_tier || 1) > 1
        const top = isEarned
          ? instances.reduce((a, b) => (b.tier > a.tier ? b : a))
          : null
        const tone = top ? tierOf(top.tier) : null
        return (
          <motion.div
            key="badge-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            style={{
              position: 'fixed', inset: 0,
              background: 'rgba(28, 28, 28, 0.78)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 20, zIndex: 500,
            }}
          >
            <motion.div
              key="badge-card"
              initial={{ scale: 0.85, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 8 }}
              transition={{ type: 'spring', damping: 22, stiffness: 280 }}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'var(--cream)',
                borderRadius: 22, padding: '28px 22px 22px',
                width: '100%', maxWidth: 360,
                border: `2px solid ${tone ? tone.color : 'var(--terra-pale)'}`,
                boxShadow: tone
                  ? `0 24px 60px rgba(0,0,0,0.4), 0 0 0 4px ${tone.color}22`
                  : '0 24px 60px rgba(0,0,0,0.4)',
                position: 'relative',
              }}
            >
              {/* Close × in corner */}
              <button
                onClick={onClose}
                aria-label="Fechar"
                style={{
                  position: 'absolute', top: 10, right: 10,
                  width: 30, height: 30, borderRadius: '50%',
                  background: 'rgba(0,0,0,0.06)', border: 'none',
                  fontSize: 18, color: 'var(--charcoal-mid)',
                  cursor: 'pointer', lineHeight: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'inherit',
                }}
              >×</button>

              {/* Big emoji + earned/locked status badge */}
              <div style={{ textAlign: 'center', marginBottom: 14 }}>
                <div style={{
                  fontSize: 62, lineHeight: 1, marginBottom: 8,
                  filter: isEarned ? 'none' : 'grayscale(0.85)',
                  opacity: isEarned ? 1 : 0.55,
                }}>{badge.emoji}</div>
                <div style={{
                  display: 'inline-block', fontSize: 9, fontWeight: 800,
                  letterSpacing: 1.2, textTransform: 'uppercase',
                  padding: '4px 12px', borderRadius: 999,
                  background: tone ? tone.gradient : (isEarned ? 'var(--terra)' : 'var(--charcoal-light)'),
                  color: 'white',
                  textShadow: tone ? '0 1px 1px rgba(0,0,0,0.25)' : 'none',
                  boxShadow: tone ? '0 2px 6px rgba(0,0,0,0.18)' : 'none',
                }}>
                  {isEarned
                    ? (tone ? `${tone.name} · Conquista` : 'Conquista desbloqueada')
                    : 'Por desbloquear'}
                </div>
              </div>

              {/* Title */}
              <div style={{
                fontSize: 22, fontWeight: 800, color: 'var(--charcoal)',
                textAlign: 'center', lineHeight: 1.2, marginBottom: 6,
              }}>
                {badge.label}
                {hasLadder && top && (
                  <span style={{
                    marginLeft: 8, fontSize: 14, fontWeight: 800,
                    background: tone.gradient, color: 'white',
                    padding: '3px 10px', borderRadius: 6, verticalAlign: 'middle',
                    letterSpacing: 0.5,
                    textShadow: '0 1px 1px rgba(0,0,0,0.25)',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
                  }}>{TIER_NUMERAL[top.tier] || top.tier}</span>
                )}
              </div>

              {/* Description */}
              <div style={{
                fontSize: 13, color: 'var(--charcoal-mid)', textAlign: 'center',
                lineHeight: 1.5, marginBottom: hasLadder || (isEarned && badge.multi_instance) ? 18 : 0,
              }}>
                {badge.desc}
              </div>

              {/* Tier ladder */}
              {hasLadder && (
                <div style={{
                  background: 'var(--white)', borderRadius: 14, padding: '12px 14px',
                  marginBottom: instances.length > 0 && badge.multi_instance ? 14 : 0,
                  border: '1px solid var(--border)',
                }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, color: 'var(--charcoal-mid)',
                    letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8,
                  }}>Escada de tiers</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(badge.tiers || []).map((threshold, i) => {
                      const tierNum = i + 1
                      const reached = top && top.tier >= tierNum
                      const tierTone = tierOf(tierNum)
                      const unit = badge.tier_unit || ''
                      return (
                        <span key={tierNum} style={{
                          fontSize: 11, fontWeight: 700,
                          padding: '5px 10px', borderRadius: 8,
                          background: reached ? tierTone.gradient : 'var(--cream)',
                          color: reached ? 'white' : 'var(--charcoal-light)',
                          border: `1px solid ${reached ? 'transparent' : 'var(--border)'}`,
                          textShadow: reached ? '0 1px 1px rgba(0,0,0,0.2)' : 'none',
                          boxShadow: reached ? '0 2px 4px rgba(0,0,0,0.12)' : 'none',
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                        }}>
                          <span style={{ fontWeight: 800 }}>{tierTone.name}</span>
                          <span style={{ opacity: 0.85 }}>· {threshold}{unit}</span>
                        </span>
                      )
                    })}
                  </div>
                  {/* Next-tier hint: count-based for normal badges, alt copy
                      for window-based ones (versatil) where math doesn't fit */}
                  {top && top.next_threshold != null && !badge.tier_unit && (
                    <div style={{
                      fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 10,
                      lineHeight: 1.4,
                    }}>
                      <strong style={{ color: 'var(--terra)' }}>
                        Faltam {top.next_threshold - (top.context?.count ?? top.context?.events ?? top.context?.max_friends_at_event ?? 0)}
                      </strong>{' '}pra subir de tier.
                    </div>
                  )}
                  {top && top.next_threshold != null && badge.tier_unit === 'd' && (
                    <div style={{
                      fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 10,
                      lineHeight: 1.4,
                    }}>
                      Faça o conjunto de novo numa janela de{' '}
                      <strong style={{ color: 'var(--terra)' }}>
                        {top.next_threshold} dias
                      </strong>{' '}pra subir.
                    </div>
                  )}
                  {top && top.next_threshold == null && (
                    <div style={{
                      fontSize: 12, color: 'var(--terra)', marginTop: 10,
                      fontWeight: 700, textAlign: 'center',
                    }}>
                      🌟 Tier máximo alcançado!
                    </div>
                  )}
                  {!isEarned && (
                    <div style={{
                      fontSize: 11, color: 'var(--charcoal-light)', marginTop: 10, lineHeight: 1.4,
                    }}>
                      Comece confirmando eventos pra desbloquear o primeiro tier.
                    </div>
                  )}
                </div>
              )}

              {/* Multi-instance: list venues with tier chips */}
              {instances.length > 0 && badge.multi_instance && (
                <div style={{
                  background: 'var(--white)', borderRadius: 14, padding: '12px 14px',
                  border: '1px solid var(--border)',
                }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700, color: 'var(--charcoal-mid)',
                    letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8,
                  }}>{instances.length === 1 ? 'Onde você é' : `Onde você é (${instances.length})`}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {instances.map(inst => {
                      const instTone = hasLadder && inst.tier > 0 ? tierOf(inst.tier) : null
                      return (
                        <span key={inst.id} style={{
                          fontSize: 12, fontWeight: 600,
                          background: 'var(--cream)', color: 'var(--charcoal)',
                          padding: '5px 10px', borderRadius: 8,
                          border: '1px solid var(--terra-pale)',
                          display: 'inline-flex', alignItems: 'center', gap: 5,
                        }}>
                          {inst.instance || inst.context?.venue || '—'}
                          {instTone && (
                            <span style={{
                              color: 'white',
                              background: instTone.gradient,
                              padding: '1px 7px', borderRadius: 4, fontSize: 9,
                              fontWeight: 800, letterSpacing: 0.5,
                              textShadow: '0 1px 1px rgba(0,0,0,0.2)',
                              boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                            }}>{TIER_NUMERAL[inst.tier] || inst.tier}</span>
                          )}
                          {inst.context?.count != null && (
                            <span style={{ color: 'var(--charcoal-light)', fontSize: 10 }}>
                              ×{inst.context.count}
                            </span>
                          )}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )
      })()}
    </AnimatePresence>
  )
}


// ── Recordes pessoais ────────────────────────────────────
// Lifetime / personal-best counters that only ever go up. Anxiety-free —
// no current-streak that can break, just the all-time best week run.
function RecordsSection({ googleId }) {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let canceled = false
    async function load() {
      const data = googleId ? await fetchUserStats(googleId) : null
      if (canceled) return
      setStats(data)
      setLoading(false)
    }
    load()
    // Recompute when a badge unlock fires — likely the underlying counters
    // also moved.
    function onUnlock() { if (googleId) fetchUserStats(googleId).then(setStats) }
    window.addEventListener('badge-unlocked', onUnlock)
    return () => {
      canceled = true
      window.removeEventListener('badge-unlocked', onUnlock)
    }
  }, [googleId])

  if (loading || !stats || !googleId) return null
  if (stats.total_rsvps === 0) return null  // no signal yet, hide section

  const cards = [
    { label: 'RSVPs no total',     value: stats.total_rsvps,                  icon: '🎟' },
    { label: 'Lugares diferentes', value: stats.distinct_venues,              icon: '📍' },
    { label: 'Bairros visitados',  value: stats.distinct_bairros,             icon: '🗺' },
    { label: 'Recorde de semanas', value: stats.best_week_streak,             icon: '🔥', sub: 'seguidas com RSVP' },
    stats.top_venue && {
      label: 'Lugar predileto', value: stats.top_venue, icon: '⭐',
      sub: `${stats.top_venue_count} RSVPs`,
    },
    stats.top_month && {
      label: 'Mês mais ativo', value: _formatMonth(stats.top_month), icon: '📅',
      sub: `${stats.top_month_count} eventos`,
    },
  ].filter(Boolean)

  return (
    <div style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
        📈 Recordes
      </div>
      <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginBottom: 12 }}>
        Números que só sobem — sem streak pra quebrar.
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
      }}>
        {cards.map(c => (
          <div key={c.label} style={{
            background: 'var(--cream)',
            border: '1px solid var(--terra-pale)',
            borderRadius: 12, padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: 2,
            minWidth: 0,
          }}>
            <div style={{ fontSize: 10, color: 'var(--charcoal-mid)', fontWeight: 600 }}>
              {c.icon} {c.label}
            </div>
            <div style={{
              fontSize: 18, fontWeight: 800, color: 'var(--charcoal)',
              lineHeight: 1.1,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {c.value}
            </div>
            {c.sub && (
              <div style={{ fontSize: 10, color: 'var(--charcoal-light)' }}>{c.sub}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function _formatMonth(yyyymm) {
  if (!yyyymm || !yyyymm.includes('-')) return yyyymm
  const [y, m] = yyyymm.split('-')
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  const idx = parseInt(m, 10) - 1
  return idx >= 0 && idx < 12 ? `${months[idx]}/${y.slice(2)}` : yyyymm
}


// ── Sign-in card for unauthenticated users ────────────────
function SignInCard({ dispatch }) {
  const googleBtnRef = useRef(null)
  const googleConfigured = isGoogleConfigured()

  useEffect(() => {
    if (!googleConfigured) return
    const cleanup = mountGoogleButton(googleBtnRef, (googleUser) => {
      dispatch({ type: 'SET_GOOGLE_USER', payload: googleUser })
      if (googleUser.givenName || googleUser.name) {
        dispatch({
          type: 'SET_NAME',
          payload: googleUser.givenName || googleUser.name.split(' ')[0],
        })
      }
    })
    return cleanup
  }, [dispatch, googleConfigured])

  function handleMockSignIn() {
    dispatch({ type: 'SET_GOOGLE_USER', payload: MOCK_GOOGLE_USER })
    dispatch({ type: 'SET_NAME', payload: MOCK_GOOGLE_USER.givenName })
  }

  async function handleApple() {
    try {
      const user = await signInWithApple()
      dispatch({ type: 'SET_GOOGLE_USER', payload: user })
      if (user.givenName || user.name) {
        dispatch({ type: 'SET_NAME', payload: user.givenName || user.name?.split(' ')[0] || '' })
      }
    } catch (err) {
      if (err?.message && err.message !== 'Login cancelado.') {
        alert(err.message)
      }
    }
  }

  return (
    <div style={{
      margin: '14px 16px 0',
      background: 'var(--white)',
      borderRadius: 14,
      padding: 16,
      border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Entrar
      </div>
      <div style={{ fontSize: 12, color: 'var(--charcoal-light)', lineHeight: 1.5, marginBottom: 12 }}>
        Faça login pra salvar eventos, virar curador de Instagram e
        sincronizar entre dispositivos.
      </div>
      {googleConfigured ? (
        <div ref={googleBtnRef} style={{ marginBottom: 8 }} />
      ) : (
        <button
          onClick={handleMockSignIn}
          style={{
            width: '100%', padding: '10px 16px', marginBottom: 8,
            border: 'none', borderRadius: 10,
            background: 'var(--charcoal)', color: 'white',
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}
        >
          Entrar (modo demo)
        </button>
      )}
      {/* Apple Sign-In — Apple HIG: black button, system font, glyph
          on the left. Same handler as Onboarding's. */}
      <button
        onClick={handleApple}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 8, height: 40, borderRadius: 10,
          background: '#000', color: '#fff', border: '1px solid #000',
          fontSize: 14, fontWeight: 600,
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
          cursor: 'pointer',
        }}
      >
        {/* Apple's own logo glyph, from the system font (San Francisco) —
            not a redrawn path. HIG requires the mark come from Apple, and
            U+F8FF is how Apple ships it for exactly this use. */}
        <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>{'\uF8FF'}</span>
        <span>Continuar com Apple</span>
      </button>
    </div>
  )
}
