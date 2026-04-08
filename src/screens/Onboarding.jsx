import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import { mountGoogleButton } from '../lib/google-auth'

const ALL_INTERESTS = [
  'Coffee & Conversation', 'Hiking', 'Creative Writing', 'Yoga',
  'Book Clubs', 'Art & Museums', 'Cooking', 'Live Music',
  'Board Games', 'Photography',
]

const COHORT_AVATARS = [
  { initial: 'M', color: '#C4724A' },
  { initial: 'K', color: '#7A9E7E' },
  { initial: 'T', color: '#9B7EB8' },
  { initial: 'J', color: '#5B8DD9' },
  { initial: 'R', color: '#E08D5E' },
]

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
  const [name, setName] = useState(state.googleUser?.givenName ?? '')
  const [neighborhood, setNeighborhood] = useState(state.neighborhood)
  const googleBtnRef = useRef(null)

  useEffect(() => {
    const cleanup = mountGoogleButton(googleBtnRef, (googleUser) => {
      dispatch({ type: 'SET_GOOGLE_USER', payload: googleUser })
      setName(googleUser.givenName || googleUser.name.split(' ')[0])
    })
    return cleanup
  }, [dispatch])

  function handleJoin() {
    if (name.trim()) dispatch({ type: 'SET_NAME', payload: name.trim() })
    dispatch({ type: 'SET_NEIGHBORHOOD', payload: neighborhood })
    dispatch({ type: 'JOIN_COHORT' })
    navigate('/partner-intro')
  }

  const canJoin = name.trim().length > 0

  return (
    <div style={{
      minHeight: '100%',
      background: 'linear-gradient(165deg, #2C2C2C 0%, #3d2d25 100%)',
      display: 'flex',
      flexDirection: 'column',
    }}>

      {/* Logo + lang toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px 0', color: 'white' }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.5 }}>
            re<span style={{ color: 'var(--terra-light)' }}>root</span>
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 2, marginTop: 1 }}>
            {t.onboarding_tagline}
          </div>
        </div>
        <LangToggle language={state.language} dispatch={dispatch} />
      </div>

      {/* Cohort card */}
      <div style={{
        margin: '14px 20px 0',
        background: 'rgba(255,255,255,0.07)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 24, padding: 20, color: 'white',
      }}>
        {/* Live badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--terra)', padding: '4px 12px',
          borderRadius: 20, fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'white', display: 'block' }}/>
          {t.onboarding_cohort_badge}
        </div>

        <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.3, marginBottom: 6 }}>
          {t.onboarding_headline}<br />
          <span style={{ color: 'var(--terra-light)' }}>{t.onboarding_cohort_name}</span>
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 16, lineHeight: 1.5 }}>
          {t.onboarding_subtitle}
        </div>

        {/* Member row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div className="avatar-stack">
            {COHORT_AVATARS.map(({ initial, color }) => (
              <div key={initial} className="avatar" style={{ background: color }}>{initial}</div>
            ))}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t.onboarding_members}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{t.onboarding_closes}</div>
          </div>
        </div>

        {/* Google Sign-In */}
        {state.googleUser ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(255,255,255,0.1)', borderRadius: 12,
            padding: '10px 14px', marginBottom: 14,
          }}>
            <img
              src={state.googleUser.picture}
              alt=""
              style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'white' }}>
                {state.googleUser.name}
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 1 }}>
                {state.googleUser.email}
              </div>
            </div>
            <span style={{ fontSize: 14, color: 'var(--sage-light)' }}>✓</span>
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            <div ref={googleBtnRef} style={{ borderRadius: 12, overflow: 'hidden' }} />
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0',
            }}>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.12)' }}/>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>
                {t.onboarding_or ?? 'ou continue manualmente'}
              </span>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.12)' }}/>
            </div>
          </div>
        )}

        {/* Name input */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 1 }}>
            {t.onboarding_name_label}
          </div>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t.onboarding_name_placeholder}
            maxLength={30}
            style={{
              width: '100%', background: 'rgba(255,255,255,0.08)',
              border: `1px solid ${name.trim() ? 'rgba(122,158,126,0.6)' : 'rgba(255,255,255,0.15)'}`,
              borderRadius: 12, padding: '10px 14px',
              color: 'white', fontSize: 14, outline: 'none', transition: 'border-color 0.2s',
            }}
          />
        </div>

        {/* Neighborhood input */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 1 }}>
            {t.onboarding_neighborhood_label}
          </div>
          <input
            value={neighborhood}
            onChange={e => setNeighborhood(e.target.value)}
            placeholder={t.onboarding_neighborhood_placeholder}
            style={{
              width: '100%', background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 12, padding: '10px 14px',
              color: 'white', fontSize: 14, outline: 'none',
            }}
          />
        </div>

        {/* Interests */}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
          {t.onboarding_interests_label}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {ALL_INTERESTS.map(interest => {
            const selected = state.interests.includes(interest)
            return (
              <button
                key={interest}
                onClick={() => dispatch({ type: 'TOGGLE_INTEREST', payload: { interest } })}
                style={{
                  padding: '6px 12px', borderRadius: 20, fontSize: 12,
                  fontWeight: selected ? 600 : 400,
                  border: `1px solid ${selected ? 'var(--sage)' : 'rgba(255,255,255,0.2)'}`,
                  background: selected ? 'var(--sage)' : 'transparent',
                  color: selected ? 'white' : 'rgba(255,255,255,0.8)',
                  cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                {interest}
              </button>
            )
          })}
        </div>
      </div>

      {/* CTA */}
      <div style={{ background: 'var(--cream)', borderRadius: '28px 28px 0 0', padding: '20px 20px 36px', marginTop: 16 }}>
        <button
          className="btn btn--primary"
          onClick={handleJoin}
          disabled={!canJoin}
          style={{ opacity: canJoin ? 1 : 0.45 }}
        >
          {t.onboarding_join_btn}
        </button>
        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--charcoal-light)', marginTop: 10, lineHeight: 1.6 }}>
          {t.onboarding_privacy}
        </div>
      </div>
    </div>
  )
}
