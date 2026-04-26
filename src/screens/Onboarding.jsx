import { useRef, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp, PROFILES } from '../context/AppContext'
import { useT } from '../i18n'
import { mountGoogleButton, isGoogleConfigured, MOCK_GOOGLE_USER } from '../lib/google-auth'
import { trackEvent } from '../services/api'

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
          onSkip={handleSkipSignin}
          privacyText={t.onboarding_privacy}
        />
      ) : (
        <VibeStep onPick={finishOnboarding} />
      )}
    </div>
  )
}

// ── Step 1: welcome / sign-in ─────────────────────────────
function WelcomeStep({ googleConfigured, googleBtnRef, onMockGoogle, onSkip, privacyText }) {
  return (
    <>
      <div style={{ flex: 1, padding: '40px 20px 0', color: 'white' }}>
        <div style={{
          fontSize: 28, fontWeight: 700, lineHeight: 1.25, marginBottom: 14,
        }}>
          Tudo que tá rolando<br />em Curitiba,<br />
          <span style={{ color: 'var(--sage)' }}>com a galera junto.</span>
        </div>
        <div style={{
          fontSize: 14, color: 'rgba(255,255,255,0.7)',
          lineHeight: 1.55, maxWidth: 360,
        }}>
          Shows, exposições, feiras, oficinas, encontros pequenos.
          Reunidos de Sympla, Eventbrite, MON, SESC, Catraca Livre e
          Instagram — atualizado todo dia.
        </div>
      </div>

      <div style={{
        background: 'var(--cream)', borderRadius: '28px 28px 0 0',
        padding: '24px 20px 32px', marginTop: 24,
      }}>
        {googleConfigured ? (
          <div ref={googleBtnRef} style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }} />
        ) : (
          <button className="btn btn--primary" onClick={onMockGoogle} style={{ marginBottom: 10 }}>
            Entrar com Google
          </button>
        )}

        <button
          onClick={onSkip}
          style={{
            width: '100%', background: 'transparent',
            border: '1px solid var(--border)', borderRadius: 12,
            padding: '12px 16px', fontSize: 14, fontWeight: 600,
            color: 'var(--charcoal-mid)', cursor: 'pointer',
          }}
        >
          Continuar como visitante
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
                e.currentTarget.style.background = 'rgba(232, 98, 63, 0.18)'
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
