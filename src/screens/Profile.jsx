import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp, PROFILES } from '../context/AppContext'
import { useT } from '../i18n'
import { mountGoogleButton, isGoogleConfigured, MOCK_GOOGLE_USER } from '../lib/google-auth'
import Avatar from '../components/Avatar'
import Aue from '../components/Aue'

export default function Profile() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(state.userName)

  function saveName() {
    if (nameInput.trim()) dispatch({ type: 'SET_NAME', payload: nameInput.trim() })
    setEditingName(false)
  }

  function handleReset() {
    dispatch({ type: 'RESET' })
    window.location.hash = '/'
    window.location.reload()
  }

  return (
    <div>
      {/* Sign-in card — only when no Google account is connected. Lets
          users who skipped onboarding sign in later (needed for curator
          access, friend code, RSVP sync). */}
      {!state.googleUser && <SignInCard dispatch={dispatch} />}

      {/* Hero */}
      <div style={{
        background: 'linear-gradient(135deg, #2C2C2C 0%, #3d2d25 100%)',
        padding: '20px 24px 28px', textAlign: 'center', color: 'white',
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
          </div>
        )}
      </div>

      {/* Minha vibe — profile picker */}
      <VibeSection state={state} dispatch={dispatch} />

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
              width: 24, height: 24, borderRadius: '50%', background: 'white',
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
                  background: 'white', position: 'absolute', top: 3,
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
      </div>
    </div>
  )
}


// ── Feedback — gated by is_feedbacker role ────────────────
// Pulls the role from /admin/curators (open to any authenticated user;
// returns is_feedbacker for the requester). Renders nothing when the
// flag is false, so non-feedbackers don't see this section.
function FeedbackSection({ state }) {
  const email = state.googleUser?.email
  const googleId = state.googleUser?.id
  const [allowed, setAllowed] = useState(false)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState(null) // 'sent' | 'error' | null
  const API_BASE = import.meta.env.VITE_API_URL ??
    (import.meta.env.DEV ? 'http://localhost:8000' : '')

  useEffect(() => {
    if (!email) { setAllowed(false); return }
    let cancelled = false
    fetch(`${API_BASE}/admin/curators?requesting_email=${encodeURIComponent(email)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) setAllowed(!!data?.is_feedbacker) })
      .catch(() => { if (!cancelled) setAllowed(false) })
    return () => { cancelled = true }
  }, [email, API_BASE])

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

  if (!allowed) return null

  return (
    <div style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: open ? 12 : 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
            💬 Mandar feedback
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
            Você foi liberado pra opinar sobre o app. Sugestões, bugs, ideias.
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
                background: 'var(--sage)', color: 'white',
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

  return (
    <div style={{
      margin: '14px 16px 0',
      background: 'white',
      borderRadius: 14,
      padding: 16,
      border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Entrar com Google
      </div>
      <div style={{ fontSize: 12, color: 'var(--charcoal-light)', lineHeight: 1.5, marginBottom: 12 }}>
        Faça login pra salvar eventos, virar curador de Instagram e
        sincronizar entre dispositivos.
      </div>
      {googleConfigured ? (
        <div ref={googleBtnRef} />
      ) : (
        <button
          onClick={handleMockSignIn}
          style={{
            width: '100%', padding: '10px 16px',
            border: 'none', borderRadius: 10,
            background: 'var(--charcoal)', color: 'white',
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}
        >
          Entrar (modo demo)
        </button>
      )}
    </div>
  )
}
