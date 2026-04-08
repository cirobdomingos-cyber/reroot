import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp, computeCurrentWeek, getChapter } from '../context/AppContext'
import { useT } from '../i18n'
import { EVENTS } from '../data/events'

function getGreetingKey() {
  const h = new Date().getHours()
  if (h < 12) return 'greeting_morning'
  if (h < 18) return 'greeting_afternoon'
  return 'greeting_evening'
}

function daysUntilMonday() {
  const day = new Date().getDay() // 0=Sun, 1=Mon
  if (day === 1) return 0
  return (8 - day) % 7
}

// Simple confetti burst using framer-motion
const CONFETTI_PIECES = ['🌿', '✨', '🌱', '⭐', '💚']
function ConfettiBurst() {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', borderRadius: 24 }}>
      {CONFETTI_PIECES.map((emoji, i) => (
        <motion.div key={i}
          initial={{ opacity: 1, y: 0, x: 0, scale: 0.5 }}
          animate={{
            opacity: 0,
            y: -80 - Math.random() * 40,
            x: (i - 2) * 30,
            scale: 1.2,
          }}
          transition={{ duration: 0.9, delay: i * 0.06, ease: 'easeOut' }}
          style={{
            position: 'absolute',
            bottom: 20, left: '50%',
            transform: 'translateX(-50%)',
            fontSize: 20,
          }}
        >
          {emoji}
        </motion.div>
      ))}
    </div>
  )
}

export default function Home() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()

  const [showConfetti, setShowConfetti] = useState(false)
  const [showReflectModal, setShowReflectModal] = useState(false)
  const [reflectWord, setReflectWord] = useState('')

  const currentWeek = computeCurrentWeek(state.joinedAt)
  const chapter = getChapter(currentWeek)
  const progressPct = Math.round((currentWeek / state.totalWeeks) * 100)

  // First event pick: lowest-pressure event not yet RSVPd
  const dayZeroEvent = EVENTS.find(e => e.isLowPressure && !state.rsvps[e.id]) ?? EVENTS[0]

  function handleDayZeroSave() {
    dispatch({ type: 'SAVE_DAY_ZERO', payload: { eventId: dayZeroEvent.id } })
    setShowConfetti(true)
    setTimeout(() => setShowConfetti(false), 1200)
  }

  function saveReflection() {
    if (!reflectWord.trim()) return
    dispatch({ type: 'SAVE_REFLECTION', payload: { word: reflectWord.trim() } })
    setReflectWord('')
    setShowReflectModal(false)
  }

  const rsvpCount = Object.values(state.rsvps).filter(Boolean).length
  const showReflectNudge = rsvpCount > 0 && state.reflections.length === 0
  const daysLeft = daysUntilMonday()

  // Month-end card: show in first 10 days of the month if user joined over a week ago
  const joinedOverAWeek = state.joinedAt && (Date.now() - state.joinedAt) > 7 * 24 * 60 * 60 * 1000
  const showMonthEnd = joinedOverAWeek && !state.monthEndDismissed && new Date().getDate() <= 10

  // Milestone dots for progress bar
  const MILESTONE_WEEKS = [1, 2, 3, 6, 9, 12]
  const weekMilestones = MILESTONE_WEEKS.map(w => ({
    week: w, label: `W${w}`,
    state: w < currentWeek ? 'done' : w === currentWeek ? 'current' : 'future',
  }))

  return (
    <div>
      {/* Month-end win card */}
      <AnimatePresence>
        {showMonthEnd && (
          <motion.div
            initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.3 }}
            style={{
              margin: '10px 16px 0',
              background: 'linear-gradient(135deg, #C4724A 0%, #E8956D 100%)',
              borderRadius: 20, padding: '16px 18px',
              position: 'relative', overflow: 'hidden',
            }}
          >
            <div style={{
              position: 'absolute', right: -16, top: -16,
              width: 80, height: 80, borderRadius: '50%',
              background: 'rgba(255,255,255,0.1)', pointerEvents: 'none',
            }}/>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>
                  {t.home_month_sub}
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: 'white', marginBottom: 8 }}>
                  {t.home_month_title} 🌿
                </div>
                <div style={{ display: 'flex', gap: 16 }}>
                  {[
                    { val: rsvpCount, lbl: t.home_stat_rsvpd },
                    { val: state.eventsAttended, lbl: t.home_stat_attended },
                    { val: state.reflections.length, lbl: 'Reflexões' },
                  ].map(({ val, lbl }) => (
                    <div key={lbl} style={{ color: 'white' }}>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>{lbl}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', marginLeft: 8 }}>
                <button
                  onClick={() => dispatch({ type: 'DISMISS_MONTH_END' })}
                  style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontWeight: 600 }}
                >
                  {t.home_month_dismiss}
                </button>
                <button
                  style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
                >
                  {t.home_month_share} →
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Greeting */}
      <div style={{ padding: '14px 20px 4px' }}>
        <div style={{ fontSize: 13, color: 'var(--charcoal-mid)' }}>{t[getGreetingKey()]},</div>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--charcoal)' }}>
          {state.userName} 👋
        </div>
      </div>

      {/* Chapter banner */}
      <div style={{ margin: '6px 16px 0' }}>
        <div style={{
          background: chapter.pale,
          border: `1.5px solid ${chapter.color}22`,
          borderRadius: 14, padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: chapter.color, flexShrink: 0,
          }}/>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: chapter.color }}>
              {t.home_chapter_label}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)', marginTop: 1 }}>
              {chapter.name} — {chapter.desc.split('.')[0]}.
            </div>
          </div>
        </div>
      </div>

      {/* Progress card */}
      <div style={{ margin: '8px 16px 12px' }} className="card card--dark">
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
          {t.home_journey_label}
        </div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>
          {t.home_week} {currentWeek}{' '}
          <span style={{ fontSize: 15, fontWeight: 400, color: 'rgba(255,255,255,0.55)' }}>
            {t.home_of} {state.totalWeeks}
          </span>
        </div>

        {/* Progress bar */}
        <div style={{ margin: '14px 0 8px' }}>
          <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${progressPct}%`, borderRadius: 4,
              background: `linear-gradient(90deg, ${chapter.color}, var(--sage-light))`,
              transition: 'width 0.8s ease',
            }}/>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            {weekMilestones.map(m => (
              <div key={m.week} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: m.state === 'done' ? 'var(--sage-light)'
                    : m.state === 'current' ? chapter.color
                    : 'rgba(255,255,255,0.2)',
                  boxShadow: m.state === 'current' ? `0 0 0 3px ${chapter.color}55` : 'none',
                }}/>
                <span style={{
                  fontSize: 10,
                  color: m.state === 'done' ? 'var(--sage-light)'
                    : m.state === 'current' ? chapter.color
                    : 'rgba(255,255,255,0.3)',
                }}>{m.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 22, marginTop: 6 }}>
          {[
            { val: rsvpCount, lbl: t.home_stat_rsvpd },
            { val: state.frameworkRead ? 1 : 0, lbl: t.home_stat_frameworks },
            { val: state.eventsAttended, lbl: t.home_stat_attended },
          ].map(({ val, lbl }) => (
            <div key={lbl}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{lbl}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Day-zero win mechanic */}
      {!state.dayZeroSaved && (
        <div style={{ margin: '0 16px 12px', position: 'relative' }}>
          <div style={{
            background: 'linear-gradient(135deg, #1e2d2e 0%, #2C3A2D 100%)',
            borderRadius: 24, padding: 20, overflow: 'hidden', position: 'relative',
          }}>
            {showConfetti && <ConfettiBurst />}
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2, color: 'rgba(158,201,162,0.8)', marginBottom: 6 }}>
              {t.home_day_zero_title}
            </div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 14, lineHeight: 1.4 }}>
              {t.home_day_zero_sub}
            </div>
            <div style={{
              background: 'rgba(255,255,255,0.08)', borderRadius: 14,
              padding: '12px 14px', marginBottom: 14,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                background: dayZeroEvent.headerBg,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
              }}>{dayZeroEvent.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'white' }}>{dayZeroEvent.name}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
                  {dayZeroEvent.date} · {dayZeroEvent.time}
                </div>
              </div>
            </div>
            <button
              onClick={handleDayZeroSave}
              style={{
                width: '100%', padding: '13px', borderRadius: 14, fontSize: 14,
                fontWeight: 700, cursor: 'pointer', border: 'none',
                background: '#9EC9A2', color: '#1e2d2e',
                transition: 'all 0.15s',
              }}
            >
              {t.home_day_zero_save}
            </button>
          </div>
        </div>
      )}

      {/* Day-zero saved confirmation */}
      {state.dayZeroSaved && (
        <div style={{ margin: '0 16px 4px' }}>
          <div style={{
            background: 'var(--sage-pale)', borderRadius: 14, padding: '10px 16px',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ color: 'var(--sage)', fontSize: 18 }}>✓</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--sage)' }}>
                {t.home_day_zero_saved}
              </div>
              <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>
                {t.home_day_zero_going} — {EVENTS.find(e => e.id === state.dayZeroEventId)?.name}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reflection nudge */}
      {showReflectNudge && (
        <div style={{ margin: '8px 16px 0' }}>
          <div style={{
            background: 'white', borderRadius: 16, padding: '14px 16px',
            boxShadow: 'var(--shadow-sm)',
            display: 'flex', alignItems: 'center', gap: 12,
            borderLeft: '3px solid var(--terra)',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 2 }}>
                {t.home_reflect_title}
              </div>
              <div style={{ fontSize: 11, color: 'var(--charcoal-mid)' }}>
                {t.home_reflect_sub}
              </div>
            </div>
            <button
              onClick={() => setShowReflectModal(true)}
              style={{
                padding: '8px 14px', borderRadius: 10, fontSize: 12,
                fontWeight: 700, cursor: 'pointer', border: 'none',
                background: 'var(--terra)', color: 'white', flexShrink: 0,
              }}
            >
              {t.home_reflect_btn}
            </button>
          </div>
        </div>
      )}

      {/* Prescription */}
      <div className="section-label">{t.home_prescription_label}</div>
      <div style={{ margin: '0 16px 12px' }}>
        {/* Prescription pad header */}
        <div style={{
          background: 'white', borderRadius: '16px 16px 0 0',
          padding: '10px 16px 8px',
          borderBottom: '1px dashed var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>💊</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--charcoal)' }}>
                Rx · {t.home_prescription_protocol} {currentWeek}
              </div>
              <div style={{ fontSize: 10, color: 'var(--charcoal-light)' }}>
                {t.home_prescription_sub}
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {daysLeft === 0 ? (
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--sage)', background: 'var(--sage-pale)', padding: '3px 8px', borderRadius: 8 }}>
                {t.home_rx_fresh}
              </div>
            ) : (
              <div style={{ fontSize: 10, color: 'var(--charcoal-light)', lineHeight: 1.4 }}>
                {t.home_rx_refreshes}<br/>
                <strong style={{ color: 'var(--charcoal)' }}>{daysLeft} {t.home_rx_days}</strong>
              </div>
            )}
          </div>
        </div>

        <div style={{ background: 'var(--terra-pale)', borderRadius: '0 0 16px 16px', padding: '10px 12px 12px' }}>
          {EVENTS.slice(0, 2).map(ev => {
            const rsvped = !!state.rsvps[ev.id]
            const going = ev.cohortGoing.length + (rsvped ? 1 : 0)
            return (
              <div key={ev.id} onClick={() => navigate('/events')} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: 'white', borderRadius: 14, padding: '11px 14px',
                marginBottom: 8, cursor: 'pointer', boxShadow: 'var(--shadow-sm)',
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, background: ev.headerBg, flexShrink: 0,
                }}>{ev.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>{ev.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>{ev.date} · {ev.time}</div>
                </div>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: 'var(--sage)',
                  background: 'var(--sage-pale)', padding: '3px 8px', borderRadius: 8, flexShrink: 0,
                }}>
                  {going === 0 ? t.home_be_first : `${going} ${t.home_going}`}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Cohort activity */}
      <div className="section-label">{t.home_cohort_label}</div>
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="avatar-stack">
            {EVENTS[0].cohortGoing.slice(0, 3).map(p => (
              <div key={p.name} className="avatar" style={{ background: p.color, width: 30, height: 30, fontSize: 11 }}>
                {p.initial}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.4 }}>
            <strong style={{ color: 'var(--charcoal)' }}>
              {EVENTS[0].cohortGoing.length + (state.rsvps[EVENTS[0].id] ? 1 : 0)} {t.home_cohort_going}
            </strong>{' '}
            {EVENTS[0].name}
          </div>
          <button
            className="btn btn--primary"
            style={{ width: 'auto', padding: '6px 14px', fontSize: 11, borderRadius: 10 }}
            onClick={() => dispatch({ type: 'TOGGLE_RSVP', payload: { eventId: EVENTS[0].id } })}
          >
            {state.rsvps[EVENTS[0].id] ? t.home_going : t.home_rsvp}
          </button>
        </div>
        <div className="divider"/>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="avatar" style={{ background: '#5B8DD9', width: 30, height: 30, fontSize: 11 }}>J</div>
          <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.4 }}>
            <strong style={{ color: 'var(--charcoal)' }}>Jamie</strong>{' '}{t.home_cohort_completed}
          </div>
        </div>
      </div>

      {/* Framework teaser */}
      <div className="section-label">{t.home_framework_label}</div>
      <div style={{ margin: '0 16px 16px', cursor: 'pointer' }} className="card card--sage" onClick={() => navigate('/journey')}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1,
            background: 'white', color: 'var(--sage)', padding: '3px 8px', borderRadius: 6,
          }}>
            {t.home_framework_badge} {currentWeek}
          </span>
          <span style={{ fontSize: 18, color: 'var(--sage)' }}>→</span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
          The Re-entry Ritual
        </div>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5 }}>
          {t.home_framework_desc}
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--sage)', fontWeight: 600 }}>
          {t.home_framework_verified}
        </div>
      </div>

      {/* Reflection modal */}
      <AnimatePresence>
        {showReflectModal && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'flex-end', zIndex: 200,
            }}
            onClick={e => { if (e.target === e.currentTarget) setShowReflectModal(false) }}
          >
            <motion.div
              initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
              transition={{ type: 'spring', damping: 25 }}
              style={{
                background: 'white', borderRadius: '24px 24px 0 0',
                padding: '24px 20px 40px', width: '100%',
              }}
            >
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto 20px' }}/>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 16 }}>
                {t.home_reflect_modal_title}
              </div>
              <input
                autoFocus
                value={reflectWord}
                onChange={e => setReflectWord(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveReflection()}
                placeholder={t.home_reflect_placeholder}
                maxLength={40}
                style={{
                  width: '100%', padding: '13px 16px', borderRadius: 14,
                  border: '1.5px solid var(--border)', fontSize: 15,
                  color: 'var(--charcoal)', outline: 'none',
                  background: 'var(--cream)',
                  marginBottom: 14,
                }}
              />
              <button
                onClick={saveReflection}
                disabled={!reflectWord.trim()}
                style={{
                  width: '100%', padding: '14px', borderRadius: 14, fontSize: 14,
                  fontWeight: 700, cursor: reflectWord.trim() ? 'pointer' : 'default',
                  border: 'none', marginBottom: 10,
                  background: reflectWord.trim() ? 'var(--charcoal)' : 'var(--border)',
                  color: reflectWord.trim() ? 'white' : 'var(--charcoal-light)',
                  opacity: reflectWord.trim() ? 1 : 0.6,
                }}
              >
                {t.home_reflect_save}
              </button>
              <button
                onClick={() => setShowReflectModal(false)}
                style={{ width: '100%', padding: '10px', fontSize: 13, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {t.home_reflect_cancel}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
