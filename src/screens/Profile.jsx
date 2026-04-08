import { useState } from 'react'
import { useApp, computeBadges, computeCurrentWeek } from '../context/AppContext'
import { useT } from '../i18n'
import { TIMELINE } from '../data/framework'

export default function Profile() {
  const { state, dispatch } = useApp()
  const t = useT()
  const [referralCode, setReferralCode] = useState('')
  const [referralApplied, setReferralApplied] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(state.userName)

  const badges = computeBadges(state)
  const rsvpCount = Object.values(state.rsvps).filter(Boolean).length
  const currentWeek = computeCurrentWeek(state.joinedAt)

  function saveName() {
    if (nameInput.trim()) dispatch({ type: 'SET_NAME', payload: nameInput.trim() })
    setEditingName(false)
  }

  function handleReset() {
    dispatch({ type: 'RESET' })
    window.location.hash = '/'
    window.location.reload()
  }

  const enrichedTimeline = TIMELINE.map(item => {
    const itemState = item.week < currentWeek ? 'done'
      : item.week === currentWeek ? 'current'
      : 'locked'
    const note = item.week === currentWeek
      ? `${rsvpCount} RSVP'd · ${state.eventsAttended} attended`
      : item.note
    return { ...item, state: itemState, note }
  })

  return (
    <div>
      {/* Hero */}
      <div style={{
        background: 'linear-gradient(135deg, #2C2C2C 0%, #3d2d25 100%)',
        padding: '16px 24px 28px', textAlign: 'center', color: 'white',
      }}>
        <div className="avatar avatar--lg" style={{ background: 'var(--terra)', margin: '0 auto 12px' }}>
          {state.userName.charAt(0).toUpperCase()}
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
            <button onClick={saveName} style={{ fontSize: 18, color: 'var(--sage-light)', background: 'none', border: 'none', cursor: 'pointer' }}>✓</button>
          </div>
        ) : (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', cursor: 'pointer' }}
            onClick={() => { setNameInput(state.userName); setEditingName(true) }}
          >
            <span style={{ fontSize: 20, fontWeight: 700 }}>{state.userName}</span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>✎</span>
          </div>
        )}

        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>
          {t.profile_cohort}
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--terra)', padding: '5px 14px',
          borderRadius: 20, fontSize: 11, fontWeight: 700, marginTop: 10,
        }}>
          {t.profile_member_badge}
        </div>
      </div>

      {/* Timeline */}
      <div className="section-label">{t.profile_timeline_label}</div>
      <div style={{ padding: '0 16px' }}>
        {enrichedTimeline.map((item, idx) => {
          const isLast = idx === enrichedTimeline.length - 1
          const dotColor = item.state === 'done' ? 'var(--sage-pale)'
            : item.state === 'current' ? 'var(--terra-pale)' : '#F0F0F0'
          const dotEmoji = item.state === 'done' ? '✓' : item.state === 'current' ? '→' : '🔒'

          return (
            <div key={item.week} style={{ display: 'flex', gap: 12, position: 'relative' }}>
              {!isLast && (
                <div style={{ position: 'absolute', left: 15, top: 32, bottom: 0, width: 2, background: 'var(--border)' }}/>
              )}
              <div style={{ width: 32, flexShrink: 0 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', background: dotColor,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, position: 'relative', zIndex: 1,
                  opacity: item.state === 'locked' ? 0.45 : 1,
                  boxShadow: item.state === 'current' ? '0 0 0 4px var(--terra-pale)' : 'none',
                }}>
                  {dotEmoji}
                </div>
              </div>
              <div style={{ flex: 1, paddingBottom: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--charcoal-light)' }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--charcoal)', opacity: item.state === 'locked' ? 0.45 : 1 }}>
                  {item.event}
                </div>
                <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>{item.note}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Badges */}
      <div className="section-label">{t.profile_badges_label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '0 16px' }}>
        {badges.map(badge => (
          <div key={badge.id} title={badge.desc} style={{
            background: 'white', borderRadius: 14, padding: '12px 14px',
            flex: '1 1 calc(33% - 8px)', textAlign: 'center',
            boxShadow: 'var(--shadow-sm)',
            opacity: badge.earned ? 1 : 0.35,
            filter: badge.earned ? 'none' : 'grayscale(1)',
            transition: 'all 0.3s', position: 'relative',
          }}>
            {badge.earned && (
              <div style={{
                position: 'absolute', top: -4, right: -4,
                width: 14, height: 14, borderRadius: '50%',
                background: 'var(--sage)', border: '2px solid white',
                fontSize: 8, color: 'white',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
              }}>✓</div>
            )}
            <div style={{ fontSize: 24, marginBottom: 4 }}>{badge.icon}</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--charcoal)', lineHeight: 1.2 }}>{badge.name}</div>
          </div>
        ))}
      </div>

      {/* Membership */}
      <div className="section-label">{t.profile_membership_label}</div>
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--charcoal)' }}>{t.profile_membership_title}</div>
            <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 2 }}>{t.profile_membership_sub}</div>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--terra)' }}>
            {state.language === 'pt' ? 'R$99' : '$19.99'}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--charcoal-light)' }}>/mo</span>
          </div>
        </div>
        <div className="divider"/>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.8 }}>
          {t.profile_feature_1}<br/>
          {t.profile_feature_2}<br/>
          {t.profile_feature_3}<br/>
          {t.profile_feature_4}
        </div>
      </div>

      {/* Referral */}
      <div style={{ margin: '0 16px 12px' }} className="card card--sage">
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
          {t.profile_referral_label}
        </div>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 14 }}>
          {t.profile_referral_sub}
        </div>
        {referralApplied ? (
          <div style={{ textAlign: 'center', padding: 12, background: 'var(--sage-pale)', borderRadius: 12, color: 'var(--sage)', fontSize: 13, fontWeight: 600 }}>
            {t.profile_referral_applied}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={referralCode}
              onChange={e => setReferralCode(e.target.value)}
              placeholder={t.profile_referral_placeholder}
              style={{
                flex: 1, padding: '11px 14px',
                border: '1.5px solid rgba(122,158,126,0.4)',
                borderRadius: 12, fontSize: 13,
                background: 'rgba(255,255,255,0.7)',
                outline: 'none', color: 'var(--charcoal)',
              }}
            />
            <button
              className="btn btn--sage"
              style={{ width: 'auto', padding: '11px 18px', fontSize: 13 }}
              onClick={() => referralCode.trim() && setReferralApplied(true)}
            >
              {t.profile_referral_btn}
            </button>
          </div>
        )}
      </div>

      {/* Language toggle */}
      <div style={{ margin: '0 16px 12px' }} className="card">
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

      {/* Reset */}
      <div style={{ padding: '4px 16px 20px', textAlign: 'center' }}>
        <button onClick={handleReset} style={{ fontSize: 11, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}>
          {t.profile_reset}
        </button>
      </div>
    </div>
  )
}
