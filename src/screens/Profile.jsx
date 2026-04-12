import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp, computeBadges, computeCurrentWeek, getChapter, CHAPTERS } from '../context/AppContext'
import { useT } from '../i18n'
export default function Profile() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(state.userName)
  const [showPauseSheet, setShowPauseSheet] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [paused, setPaused] = useState(state.isPaused)
  const [selectedBadge, setSelectedBadge] = useState(null)

  const googleId = state.googleUser?.id

  const badges = computeBadges(state)
  const rsvpCount = Object.values(state.rsvps).filter(Boolean).length
  const currentWeek = computeCurrentWeek(state.joinedAt)
  const chapter = getChapter(currentWeek)

  // Badge celebration — detect newly earned badges and show overlay
  const earnedBadgeIds = badges.filter(b => b.earned).map(b => b.id).join(',')
  const prevEarnedRef = useRef(null)
  const [celebratingBadge, setCelebratingBadge] = useState(null)

  useEffect(() => {
    if (prevEarnedRef.current === null) {
      // First render — initialize without firing celebration
      prevEarnedRef.current = earnedBadgeIds
      return
    }
    if (earnedBadgeIds !== prevEarnedRef.current) {
      const prevIds = prevEarnedRef.current.split(',').filter(Boolean)
      const currentIds = earnedBadgeIds.split(',').filter(Boolean)
      const newlyEarned = currentIds.filter(id => !prevIds.includes(id))
      prevEarnedRef.current = earnedBadgeIds
      if (newlyEarned.length > 0) {
        const badge = badges.find(b => b.id === newlyEarned[0])
        if (badge) {
          setCelebratingBadge(badge)
          setTimeout(() => setCelebratingBadge(null), 6000)
        }
      }
    }
  }, [earnedBadgeIds]) // eslint-disable-line react-hooks/exhaustive-deps

  function saveName() {
    if (nameInput.trim()) dispatch({ type: 'SET_NAME', payload: nameInput.trim() })
    setEditingName(false)
  }

  function handleReset() {
    dispatch({ type: 'RESET' })
    window.location.hash = '/'
    window.location.reload()
  }

  function handlePause() {
    dispatch({ type: 'SET_PAUSED', payload: true })
    setPaused(true)
    setShowPauseSheet(false)
  }

  function handleCancelTap() {
    setShowPauseSheet(false)
    setShowCancelConfirm(true)
  }

  // 12-week grid for "weeks shown up"
  const weeksShownUp = state.weeksShownUp ?? []

  return (
    <div>
      {/* Badge earned celebration overlay */}
      <AnimatePresence>
        {celebratingBadge && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
              zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={() => setCelebratingBadge(null)}
          >
            <motion.div
              initial={{ scale: 0.7, y: 24 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ type: 'spring', damping: 20, stiffness: 280 }}
              onClick={e => e.stopPropagation()}
              style={{
                background: 'white', borderRadius: 24, padding: '32px 28px',
                textAlign: 'center', maxWidth: 300, margin: '0 20px',
                boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
              }}
            >
              <div style={{ fontSize: 60, marginBottom: 12 }}>{celebratingBadge.icon}</div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: 'var(--sage)', marginBottom: 4 }}>
                {state.language === 'pt' ? 'Conquista desbloqueada!' : 'Badge unlocked!'}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 8 }}>{celebratingBadge.name}</div>
              <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 20 }}>{celebratingBadge.desc}</div>
              <button
                onClick={async () => {
                  const text = state.language === 'pt'
                    ? `Conquistei o badge "${celebratingBadge.name}" no Reroot! ${celebratingBadge.icon}`
                    : `Unlocked the "${celebratingBadge.name}" badge on Reroot! ${celebratingBadge.icon}`
                  if (navigator.share) {
                    try { await navigator.share({ title: 'Reroot', text }) } catch {}
                  } else {
                    navigator.clipboard.writeText(text).catch(() => {})
                  }
                  setCelebratingBadge(null)
                }}
                style={{
                  width: '100%', padding: 13, borderRadius: 14, border: 'none',
                  background: 'var(--sage)', color: 'white', fontSize: 14,
                  fontWeight: 700, cursor: 'pointer', marginBottom: 8,
                }}
              >
                {state.language === 'pt' ? 'Compartilhar conquista →' : 'Share achievement →'}
              </button>
              <button
                onClick={() => setCelebratingBadge(null)}
                style={{ fontSize: 12, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {state.language === 'pt' ? 'Fechar' : 'Close'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hero */}
      <div style={{
        background: 'linear-gradient(135deg, #2C2C2C 0%, #3d2d25 100%)',
        padding: '16px 24px 28px', textAlign: 'center', color: 'white',
        position: 'relative',
      }}>
        {/* Gear icon */}
        <button
          onClick={() => setShowPauseSheet(true)}
          style={{
            position: 'absolute', top: 16, right: 20,
            background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: '50%',
            width: 34, height: 34, cursor: 'pointer', fontSize: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >⚙️</button>

        {state.googleUser?.picture ? (
          <img
            src={state.googleUser.picture}
            alt={state.userName}
            style={{
              width: 72, height: 72, borderRadius: '50%',
              margin: '0 auto 12px', display: 'block',
              border: '3px solid rgba(255,255,255,0.2)',
              objectFit: 'cover',
            }}
          />
        ) : (
          <div className="avatar avatar--lg" style={{ background: 'var(--terra)', margin: '0 auto 12px' }}>
            {(state.userName || '?').charAt(0).toUpperCase()}
          </div>
        )}

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

        {state.googleUser?.email && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
            {state.googleUser.email}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>
          {t.profile_cohort}
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: paused ? 'rgba(255,255,255,0.15)' : 'var(--terra)', padding: '5px 14px',
          borderRadius: 20, fontSize: 11, fontWeight: 700, marginTop: 10,
        }}>
          {paused ? t.profile_paused_badge : t.profile_member_badge}
        </div>
        {paused && (
          <button
            onClick={() => {
              dispatch({ type: 'SET_PAUSED', payload: false })
              setPaused(false)
            }}
            style={{
              marginTop: 10, background: 'var(--sage)', color: 'white',
              border: 'none', borderRadius: 20, padding: '7px 20px',
              fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}
          >
            ▶ {t.profile_resume_btn ?? 'Retomar jornada'}
          </button>
        )}
      </div>

      {/* Weeks shown up — 12-week grid */}
      <div className="section-label">{t.profile_weeks_shown}</div>
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
          {Array.from({ length: 12 }, (_, i) => {
            const week = i + 1
            const shown = weeksShownUp.includes(week)
            const isCurrent = week === currentWeek
            const isPast = week < currentWeek
            const chapterForWeek = CHAPTERS.find(c => c.weeks.includes(week))
            return (
              <div key={week} style={{ textAlign: 'center' }}>
                <div style={{
                  width: '100%', aspectRatio: '1', borderRadius: 10,
                  background: shown ? chapterForWeek?.color ?? 'var(--sage)' : 'transparent',
                  border: shown ? 'none'
                    : isCurrent ? `2px solid ${chapter.color}`
                    : isPast ? '2px dashed var(--border)'
                    : '2px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: shown ? 12 : 11,
                  color: shown ? 'white' : 'var(--charcoal-light)',
                  fontWeight: 700,
                  opacity: !isPast && !isCurrent ? 0.5 : 1,
                }}>
                  {shown ? '✓' : week}
                </div>
                <div style={{
                  fontSize: 9, marginTop: 3,
                  color: isCurrent ? 'var(--charcoal)' : 'var(--charcoal-light)',
                  fontWeight: isCurrent ? 700 : 400,
                }}>
                  W{week}
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: 'var(--charcoal-mid)' }}>
          <strong style={{ color: 'var(--charcoal)' }}>{weeksShownUp.length}</strong> {t.profile_weeks_shown?.toLowerCase?.() ?? 'weeks shown up'}
        </div>
      </div>

      {/* Badges */}
      <div className="section-label">{t.profile_badges_label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '0 16px' }}>
        {badges.map(badge => {
          const isSelected = selectedBadge === badge.id
          return (
            <div
              key={badge.id}
              onClick={() => setSelectedBadge(isSelected ? null : badge.id)}
              style={{
                background: 'white', borderRadius: 14, padding: '12px 14px',
                flex: '1 1 calc(33% - 8px)', textAlign: 'center',
                boxShadow: isSelected ? '0 0 0 2px var(--sage)' : 'var(--shadow-sm)',
                opacity: badge.earned ? 1 : 0.35,
                filter: badge.earned ? 'none' : 'grayscale(1)',
                transition: 'all 0.2s', position: 'relative',
                cursor: 'pointer',
              }}
            >
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
              <AnimatePresence>
                {isSelected && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{ overflow: 'hidden' }}
                  >
                    <div style={{
                      fontSize: 10, color: badge.earned ? 'var(--sage)' : 'var(--charcoal-light)',
                      marginTop: 6, lineHeight: 1.4,
                    }}>
                      {badge.desc}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
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
          { key: 'shareRsvps',             label: t.privacy_share_rsvps ?? 'Share RSVPs with friends',        desc: t.privacy_share_rsvps_desc ?? 'Your friends can see events you confirmed' },
          { key: 'showInFriendSuggestions', label: t.privacy_show_suggestions ?? 'Appear in friend suggestions', desc: t.privacy_show_suggestions_desc ?? 'Other people can find your profile' },
          { key: 'showProfileToStrangers',  label: t.privacy_show_profile ?? 'Profile visible to non-friends',   desc: t.privacy_show_profile_desc ?? 'Non-friends can see your full profile' },
        ].map(({ key, label, desc }) => {
          const value = state.privacy?.[key] ?? (key === 'shareRsvps' ? state.shareRsvps : false)
          return (
            <div key={key} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 0',
              borderBottom: key !== 'showProfileToStrangers' ? '1px solid var(--border)' : 'none',
            }}>
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

      {/* Redo onboarding + Reset */}
      <div style={{ padding: '4px 16px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => {
            dispatch({ type: 'REDO_ONBOARDING' })
            navigate('/')
          }}
          style={{ fontSize: 12, color: 'var(--terra)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
        >
          {t.profile_redo_onboarding ?? 'Redo onboarding'}
        </button>
        <button onClick={handleReset} style={{ fontSize: 11, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}>
          {t.profile_reset}
        </button>
      </div>

      {/* Pause/Cancel sheet */}
      <AnimatePresence>
        {showPauseSheet && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'flex-end', zIndex: 200,
            }}
            onClick={e => { if (e.target === e.currentTarget) setShowPauseSheet(false) }}
          >
            <motion.div
              initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
              transition={{ type: 'spring', damping: 25 }}
              style={{
                background: 'white', borderRadius: '24px 24px 0 0',
                padding: '24px 20px 44px', width: '100%',
              }}
            >
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto 20px' }}/>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 20 }}>
                {t.profile_pause_title}
              </div>

              {/* Pause option — primary */}
              <button
                onClick={handlePause}
                style={{
                  width: '100%', background: 'var(--sage-pale)', border: 'none',
                  borderRadius: 16, padding: '16px', marginBottom: 10,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sage)', marginBottom: 4 }}>
                  ⏸ {t.profile_pause_option}
                </div>
                <div style={{ fontSize: 12, color: 'var(--charcoal-mid)' }}>{t.profile_pause_sub}</div>
              </button>

              {/* Cancel option — secondary, smaller */}
              <button
                onClick={handleCancelTap}
                style={{
                  width: '100%', background: 'transparent', border: 'none',
                  padding: '10px 16px', marginBottom: 10,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--charcoal-light)' }}>
                  {t.profile_cancel_option}
                </div>
              </button>

              <button
                onClick={() => setShowPauseSheet(false)}
                style={{ width: '100%', padding: '10px', fontSize: 13, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {t.profile_close}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cancel confirmation — retention message */}
      <AnimatePresence>
        {showCancelConfirm && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'flex-end', zIndex: 200,
            }}
            onClick={e => { if (e.target === e.currentTarget) setShowCancelConfirm(false) }}
          >
            <motion.div
              initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
              transition={{ type: 'spring', damping: 25 }}
              style={{
                background: 'white', borderRadius: '24px 24px 0 0',
                padding: '28px 24px 44px', width: '100%',
              }}
            >
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto 24px' }}/>

              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🌿</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--charcoal)', lineHeight: 1.4, marginBottom: 8 }}>
                  {t.profile_cancel_msg_pre} {currentWeek} {t.profile_cancel_msg_of}
                </div>
                <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.6 }}>
                  {t.profile_cancel_msg_post}
                </div>
              </div>

              {/* Pause instead — primary offer */}
              <button
                onClick={() => { handlePause(); setShowCancelConfirm(false) }}
                className="btn btn--sage"
                style={{ marginBottom: 10 }}
              >
                ⏸ {t.profile_pause_offer}
              </button>

              {/* Final cancel */}
              <button
                onClick={() => setShowCancelConfirm(false)}
                style={{
                  width: '100%', padding: '12px', fontSize: 12,
                  color: 'var(--charcoal-light)', background: 'none',
                  border: 'none', cursor: 'pointer',
                }}
              >
                {t.profile_go_back}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
