import { useRef, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp, PROFILES } from '../context/AppContext'
import { useT } from '../i18n'
import { mountGoogleButton, isGoogleConfigured, MOCK_GOOGLE_USER } from '../lib/google-auth'
import { signInWithApple } from '../lib/apple-auth'
import { trackEvent } from '../services/api'

// Sample events shown in the welcome teaser. NOT real catalog entries —
// these illustrate the variety (music/creative/community/comedy across 4
// different bairros) so a first-time visitor immediately gets what auê
// is. The real feed comes from /events once the user lands on /home.
const TEASER_EVENTS = [
  {
    icon: '🎵',
    headerBg: 'linear-gradient(135deg, #F5DDD1, #EDCBB8)',
    name: 'Show da Bossa na Pedreira',
    venue: 'Pedreira Paulo Leminski',
    bairro: 'Pilarzinho',
    date: 'Sex, 25 · 21h',
    friends: ['Maria', 'João'],
  },
  {
    icon: '🎨',
    headerBg: 'linear-gradient(135deg, #E4EFE5, #CDDECE)',
    name: 'Roda de cerâmica',
    venue: 'Ateliê do Bairro',
    bairro: 'São Francisco',
    date: 'Sáb, 26 · 14h',
    friends: [],
  },
  {
    icon: '🍻',
    headerBg: 'linear-gradient(135deg, #FFF3E0, #FFE0B2)',
    name: 'Feira do Largo da Ordem',
    venue: 'Largo da Ordem',
    bairro: 'Centro Histórico',
    date: 'Dom, 27 · todo o dia',
    friends: ['Pedro'],
  },
  {
    icon: '🎭',
    headerBg: 'linear-gradient(135deg, #E8EAF6, #C8CBE9)',
    name: 'Stand-up no Quintal',
    venue: 'O Quintal',
    bairro: 'Bigorrilho',
    date: 'Seg, 28 · 21h',
    friends: ['Ana', 'Lu', 'João'],
  },
]
const TEASER_AVATAR_COLORS = ['#5B8DD9', '#7A9E7E', '#E8623F', '#E8A93F']

// Onboarding (post-pivot) — two short steps:
//   1. Welcome + sign-in (Google or visitor).
//   2. Vibe picker — sets state.profile, which seeds the default mood and
//      orders Home suggestions. Skippable.
// Either step finishes by JOIN_COHORTing and navigating to /home.

function LangToggle({ language, dispatch }) {
  return (
    <div style={{ display: 'flex', gap: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 20, padding: 3 }}>
      {['pt', 'en'].map(lang => (
        <button
          key={lang}
          onClick={() => dispatch({ type: 'SET_LANGUAGE', payload: lang })}
          style={{
            padding: '4px 12px', borderRadius: 16, fontSize: 11, fontWeight: 700,
            cursor: 'pointer', border: 'none', transition: 'all 0.15s',
            background: language === lang ? 'white' : 'transparent',
            color: language === lang ? 'var(--charcoal)' : 'rgba(255,255,255,0.5)',
            textTransform: 'uppercase', letterSpacing: 0.5,
          }}
        >
          {lang}
        </button>
      ))}
    </div>
  )
}

export default function Onboarding() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()
  const googleBtnRef = useRef(null)
  const googleConfigured = isGoogleConfigured()
  // 'welcome' = step 1 (sign-in/visitor), 'vibe' = step 2 (profile picker)
  const [step, setStep] = useState('welcome')

  useEffect(() => { trackEvent('onboarding_started') }, [])

  useEffect(() => {
    if (!googleConfigured || step !== 'welcome') return
    const cleanup = mountGoogleButton(googleBtnRef, (googleUser) => {
      dispatch({ type: 'SET_GOOGLE_USER', payload: googleUser })
      dispatch({ type: 'SET_NAME', payload: googleUser.givenName || googleUser.name?.split(' ')[0] || '' })
      trackEvent('onboarding_signed_in', { method: 'google' })
      setStep('vibe')
    })
    return cleanup
  }, [dispatch, googleConfigured, step])

  function handleMockGoogle() {
    dispatch({ type: 'SET_GOOGLE_USER', payload: MOCK_GOOGLE_USER })
    dispatch({ type: 'SET_NAME', payload: MOCK_GOOGLE_USER.givenName })
    trackEvent('onboarding_signed_in', { method: 'mock' })
    setStep('vibe')
  }

  // Apple Sign-In — same shape as Google: drop the resolved user into
  // state.googleUser (legacy field name; covers any provider). The
  // hook handles platform detection (Capacitor native vs web JS SDK)
  // and surfaces a Portuguese error string we just alert() since the
  // failure modes are mostly "user cancelled" / "config missing" /
  // network — none worth a custom UI surface yet.
  async function handleApple() {
    try {
      const user = await signInWithApple()
      dispatch({ type: 'SET_GOOGLE_USER', payload: user })
      if (user.givenName || user.name) {
        dispatch({ type: 'SET_NAME', payload: user.givenName || user.name?.split(' ')[0] || '' })
      }
      trackEvent('onboarding_signed_in', { method: 'apple', is_new_user: !!user.isNewUser })
      setStep('vibe')
    } catch (err) {
      if (err?.message && err.message !== 'Login cancelado.') {
        alert(err.message)
      }
    }
  }

  function handleSkipSignin() {
    trackEvent('onboarding_signed_in', { method: 'skip' })
    setStep('vibe')
  }

  function finishOnboarding(profileId) {
    if (profileId) dispatch({ type: 'SET_PROFILE', payload: profileId })
    dispatch({ type: 'JOIN_COHORT' })
    trackEvent('cohort_joined', {
      step_name: 'onboarding',
      profile: profileId || 'none',
    })
    navigate('/home')
  }

  return (
    <div style={{
      minHeight: '100%',
      background: 'linear-gradient(165deg, #1E3A5F 0%, #2C2C2C 100%)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Logo + lang toggle (always visible) */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px 0', color: 'white',
      }}>
        <div>
          <div style={{
            fontSize: 44, fontWeight: 800, letterSpacing: -1.2,
            color: 'var(--sage)',
            lineHeight: 1,
          }}>
            auê
          </div>
          <div style={{
            fontSize: 10, color: 'rgba(255,255,255,0.45)',
            textTransform: 'uppercase', letterSpacing: 2, marginTop: 6,
          }}>
            Curitiba que acontece
          </div>
        </div>
        <LangToggle language={state.language} dispatch={dispatch} />
      </div>

      {step === 'welcome' ? (
        <WelcomeStep
          googleConfigured={googleConfigured}
          googleBtnRef={googleBtnRef}
          onMockGoogle={handleMockGoogle}
          onApple={handleApple}
          onSkip={handleSkipSignin}
          privacyText={t.onboarding_privacy}
        />
      ) : (
        <VibeStep onPick={finishOnboarding} />
      )}
    </div>
  )
}

// ── Teaser: rotating event-card preview ──
// Shows 4 sample events in sequence so a first-time visitor immediately
// sees "this is an events catalog with my friends in it" instead of just
// reading marketing copy. AnimatePresence with `mode="wait"` makes the
// transitions feel like a slot-machine reveal, not a flicker.
function TeaserCard() {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setIdx(i => (i + 1) % TEASER_EVENTS.length), 2800)
    return () => clearInterval(id)
  }, [])
  const ev = TEASER_EVENTS[idx]
  return (
    <div style={{ position: 'relative', height: 120, marginBottom: 4 }}>
      <AnimatePresence mode="wait">
        <motion.div
          key={idx}
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16, scale: 0.96 }}
          transition={{ type: 'spring', damping: 22, stiffness: 280 }}
          style={{ position: 'absolute', inset: 0 }}
        >
          <div style={{
            background: 'var(--white)', borderRadius: 14, padding: '12px 14px',
            display: 'flex', gap: 12, alignItems: 'flex-start',
            boxShadow: '0 12px 32px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.04)',
            height: '100%', boxSizing: 'border-box',
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, flexShrink: 0,
              background: ev.headerBg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22,
            }}>{ev.icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 700, color: '#2C2C2C',
                lineHeight: 1.25, marginBottom: 3,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{ev.name}</div>
              <div style={{
                fontSize: 11, color: '#5B5B5B',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                📍 {ev.venue}
                <span style={{ color: '#9A9A9A' }}> · {ev.bairro}</span>
              </div>
              <div style={{
                fontSize: 11, fontWeight: 600, color: '#E8623F', marginTop: 1,
              }}>🗓 {ev.date}</div>
              {ev.friends.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5 }}>
                  <div style={{ display: 'flex' }}>
                    {ev.friends.slice(0, 3).map((name, i) => (
                      <div key={i} style={{
                        width: 18, height: 18, borderRadius: '50%',
                        background: TEASER_AVATAR_COLORS[i % TEASER_AVATAR_COLORS.length],
                        color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, fontWeight: 700,
                        marginLeft: i === 0 ? 0 : -5,
                        border: '2px solid var(--bg2)',
                      }}>{name[0]}</div>
                    ))}
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#5B8DD9' }}>
                    {ev.friends.length === 1 ? `${ev.friends[0]} vai` : `${ev.friends.length} amigos vão`}
                  </span>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
      {/* Progress dots — visualize "X of N" so the user knows it's cycling */}
      <div style={{
        position: 'absolute', bottom: -14, left: 0, right: 0,
        display: 'flex', justifyContent: 'center', gap: 5,
      }}>
        {TEASER_EVENTS.map((_, i) => (
          <div key={i} style={{
            width: i === idx ? 14 : 5, height: 5, borderRadius: 3,
            background: i === idx ? 'var(--sage)' : 'rgba(255,255,255,0.25)',
            transition: 'all 0.3s',
          }} />
        ))}
      </div>
    </div>
  )
}

// ── Step 1: welcome / sign-in ─────────────────────────────
function WelcomeStep({ googleConfigured, googleBtnRef, onMockGoogle, onApple, onSkip, privacyText }) {
  return (
    <>
      <div style={{ flex: 1, padding: '24px 20px 0', color: 'white' }}>
        <div style={{
          fontSize: 26, fontWeight: 700, lineHeight: 1.25, marginBottom: 18,
        }}>
          Tudo que tá rolando<br />
          em Curitiba,{' '}
          <span style={{ color: 'var(--sage)' }}>com a galera junto.</span>
        </div>

        <TeaserCard />

        <div style={{
          fontSize: 11, color: 'rgba(255,255,255,0.45)',
          lineHeight: 1.6, marginTop: 22, textAlign: 'center',
          letterSpacing: 0.3,
        }}>
          80+ perfis do Instagram curados a dedo<br/>
          Atualizado todo dia.
        </div>
      </div>

      <div style={{
        background: 'var(--cream)', borderRadius: '28px 28px 0 0',
        padding: '24px 20px 32px', marginTop: 20,
      }}>
        {googleConfigured ? (
          <div ref={googleBtnRef} style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }} />
        ) : (
          <button className="btn btn--primary" onClick={onMockGoogle} style={{ marginBottom: 10 }}>
            Entrar com Google
          </button>
        )}

        {/* Apple Sign-In — Apple HIG specifies black button + system
            font + Apple logo glyph for both iOS and web. Fixed black
            even on the dark Neon Boteco shell because that's what
            Apple's review guidelines accept. */}
        <button
          onClick={onApple}
          style={{
            width: '100%', marginBottom: 12,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 8, height: 44, borderRadius: 12,
            background: '#000', color: '#fff', border: '1px solid #000',
            fontSize: 15, fontWeight: 600,
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
            cursor: 'pointer',
          }}
        >
          <span aria-hidden style={{ fontSize: 17, lineHeight: 1, marginTop: -2 }}></span>
          <span>Continuar com Apple</span>
        </button>

        <button
          onClick={onSkip}
          style={{
            width: '100%', background: 'transparent',
            border: '1px solid var(--border)', borderRadius: 12,
            padding: '12px 16px', fontSize: 14, fontWeight: 600,
            color: 'var(--charcoal-mid)', cursor: 'pointer',
          }}
        >
          Bora ver →
        </button>

        <div style={{
          textAlign: 'center', fontSize: 11, color: 'var(--charcoal-light)',
          marginTop: 14, lineHeight: 1.6,
        }}>
          {privacyText ?? 'Sem cadastro complicado. Você pode entrar com Google quando quiser salvar eventos ou virar curador.'}
        </div>
      </div>
    </>
  )
}

// ── Step 2: vibe picker ───────────────────────────────────
function VibeStep({ onPick }) {
  const profiles = Object.values(PROFILES)
  return (
    <>
      <div style={{ flex: 1, padding: '32px 20px 0', color: 'white' }}>
        <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.3, marginBottom: 8 }}>
          Que vibe combina<br />com você hoje?
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5, marginBottom: 24 }}>
          Isso só ajuda a ordenar as sugestões na Home. Pode mudar depois.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {profiles.map(p => (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              style={{
                background: 'rgba(255,255,255,0.08)',
                border: '1.5px solid rgba(255,255,255,0.14)',
                borderRadius: 18,
                padding: '20px 14px',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'white',
                transition: 'all 0.15s',
                minHeight: 140,
                display: 'flex', flexDirection: 'column', gap: 8,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(255, 43, 214, 0.18)'
                e.currentTarget.style.borderColor = 'var(--sage)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)'
              }}
            >
              <div style={{ fontSize: 32, lineHeight: 1 }}>{p.emoji}</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{p.label}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', lineHeight: 1.4 }}>
                {p.blurb}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div style={{
        background: 'var(--cream)', borderRadius: '28px 28px 0 0',
        padding: '20px 20px 32px', marginTop: 24,
      }}>
        <button
          onClick={() => onPick(null)}
          style={{
            width: '100%', background: 'transparent',
            border: '1px solid var(--border)', borderRadius: 12,
            padding: '12px 16px', fontSize: 14, fontWeight: 600,
            color: 'var(--charcoal-mid)', cursor: 'pointer',
          }}
        >
          Pular →
        </button>
      </div>
    </>
  )
}
