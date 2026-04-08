import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'

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

export default function Onboarding() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const [neighborhood, setNeighborhood] = useState(state.neighborhood)

  function handleJoin() {
    dispatch({ type: 'SET_NEIGHBORHOOD', payload: neighborhood })
    dispatch({ type: 'JOIN_COHORT' })
    navigate('/partner-intro')
  }

  return (
    <div style={{
      minHeight: '100%',
      background: 'linear-gradient(165deg, #2C2C2C 0%, #3d2d25 100%)',
      display: 'flex',
      flexDirection: 'column',
    }}>

      {/* Logo */}
      <div style={{ textAlign: 'center', padding: '10px 28px 0', color: 'white' }}>
        <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>
          re<span style={{ color: 'var(--terra-light)' }}>root</span>
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 2, marginTop: 2 }}>
          Your recovery journey
        </div>
      </div>

      {/* Cohort card */}
      <div style={{
        margin: '16px 20px 0',
        background: 'rgba(255,255,255,0.07)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 24,
        padding: 22,
        color: 'white',
      }}>

        {/* Live badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--terra)', padding: '4px 12px',
          borderRadius: 20, fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'white', display: 'block' }}/>
          Spring 2026 Cohort — Live Now
        </div>

        <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1.3, marginBottom: 6 }}>
          You're joining the<br />
          <span style={{ color: 'var(--terra-light)' }}>Curitiba Spring Cohort</span>
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 18, lineHeight: 1.5 }}>
          A small, curated group of people in the same chapter of life — not thousands of strangers.
        </div>

        {/* Member row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div className="avatar-stack">
            {COHORT_AVATARS.map(({ initial, color }) => (
              <div key={initial} className="avatar" style={{ background: color }}>
                {initial}
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>24 members in your cohort</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
              Same chapter of life · Cohort closes in 3 days
            </div>
          </div>
        </div>

        {/* Neighborhood input */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
            Your neighborhood
          </div>
          <input
            value={neighborhood}
            onChange={e => setNeighborhood(e.target.value)}
            placeholder="e.g. Batel, Centro, Água Verde"
            style={{
              width: '100%',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 12,
              padding: '11px 14px',
              color: 'white',
              fontSize: 14,
              outline: 'none',
            }}
          />
        </div>

        {/* Interest tags */}
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
          Pick your interests
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 4 }}>
          {ALL_INTERESTS.map(interest => {
            const selected = state.interests.includes(interest)
            return (
              <button
                key={interest}
                onClick={() => dispatch({ type: 'TOGGLE_INTEREST', payload: { interest } })}
                style={{
                  padding: '6px 12px',
                  borderRadius: 20,
                  fontSize: 12,
                  fontWeight: selected ? 600 : 400,
                  border: `1px solid ${selected ? 'var(--sage)' : 'rgba(255,255,255,0.2)'}`,
                  background: selected ? 'var(--sage)' : 'transparent',
                  color: selected ? 'white' : 'rgba(255,255,255,0.8)',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                {interest}
              </button>
            )
          })}
        </div>
      </div>

      {/* Bottom CTA */}
      <div style={{
        background: 'var(--cream)',
        borderRadius: '28px 28px 0 0',
        padding: '22px 22px 36px',
        marginTop: 20,
      }}>
        <button className="btn btn--primary" onClick={handleJoin}>
          Join the Curitiba Spring Cohort →
        </button>
        <div style={{
          textAlign: 'center',
          fontSize: 11,
          color: 'var(--charcoal-light)',
          marginTop: 12,
          lineHeight: 1.6,
        }}>
          🔒 First names only · No social media linking · Not a dating app
        </div>
      </div>
    </div>
  )
}
