import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp } from '../context/AppContext'

// ── Questionnaire content ──────────────────────────────────
const STEPS = [
  {
    id: 'reason',
    question: 'What brought you to Reroot?',
    options: [
      { id: 'burnout',   label: 'Recovering from burnout',          emoji: '🔋' },
      { id: 'change',    label: 'After a major life change',        emoji: '🌀' },
      { id: 'anxiety',   label: 'Social anxiety holding me back',   emoji: '💭' },
      { id: 'moved',     label: 'New to the city',                  emoji: '📦' },
      { id: 'lost',      label: 'Lost my social circle',            emoji: '🌫️' },
    ],
  },
  {
    id: 'challenge',
    question: "What feels hardest right now?",
    options: [
      { id: 'starting',     label: 'Starting conversations',         emoji: '💬' },
      { id: 'groups',       label: 'Being comfortable in groups',    emoji: '👥' },
      { id: 'myself',       label: 'Feeling like myself again',      emoji: '🪞' },
      { id: 'consistent',   label: 'Showing up consistently',        emoji: '📅' },
      { id: 'values',       label: 'Finding people who get me',      emoji: '🤝' },
    ],
  },
  {
    id: 'goal',
    question: 'In 12 weeks, I want to...',
    options: [
      { id: 'friendships',  label: 'Have 2–3 real friendships',     emoji: '🌱' },
      { id: 'nodread',      label: 'Attend events without dread',   emoji: '✨' },
      { id: 'comfortable',  label: 'Feel comfortable socially',     emoji: '☀️' },
      { id: 'community',    label: 'Build a local community',       emoji: '🏡' },
    ],
  },
]

// ── Message generation based on answers ───────────────────
function generatePartnerMessage(answers) {
  const { reason, challenge, goal } = answers

  const openers = {
    burnout:  "You've been running on empty — and you know it. That awareness is exactly why this works.",
    change:   "Major transitions shake loose who we thought we were. That's actually the perfect starting point.",
    anxiety:  "Social anxiety isn't a flaw. It's your nervous system being overprotective. We'll work with it, not against it.",
    moved:    "New city, fresh slate. You don't have the weight of old social patterns here — that's an advantage.",
    lost:     "Losing your circle doesn't mean you lost yourself. It means there's space to build something more intentional.",
  }

  const middles = {
    starting:   "I'll ease you in with structured moments — no improvising required.",
    groups:     "We start small. Two people before twenty. Comfort builds incrementally.",
    myself:     "The frameworks will help you reconnect with how you actually want to show up, not perform.",
    consistent: "Each week has one anchor event — low stakes, high value. Just one thing.",
    values:     "The cohort model exists for this. These aren't strangers. They're people in the same chapter.",
  }

  const closers = {
    friendships:  "By Week 6, you'll know exactly who your people are.",
    nodread:      "By Week 4, showing up starts to feel like a choice, not a fight.",
    comfortable:  "Comfort isn't a destination — it's what happens when you stop bracing.",
    community:    "Community is built one small moment at a time. That's literally what we're doing.",
  }

  const opener  = openers[reason]   || openers.change
  const middle  = middles[challenge] || middles.consistent
  const closer  = closers[goal]      || closers.friendships

  return `${opener} ${middle} ${closer}`
}

// ── Component ──────────────────────────────────────────────
export default function PartnerIntro() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()

  const [step, setStep] = useState(0)           // 0-2 = questions, 3 = thinking, 4 = result
  const [answers, setAnswers] = useState({})
  const [selected, setSelected] = useState(null) // selected option for current step

  function handleSelect(optionId) {
    setSelected(optionId)
  }

  function handleNext() {
    if (selected === null) return
    const newAnswers = { ...answers, [STEPS[step].id]: selected }
    setAnswers(newAnswers)
    setSelected(null)

    if (step < STEPS.length - 1) {
      setStep(step + 1)
    } else {
      // All questions done → show thinking state
      setStep(3)
      const message = generatePartnerMessage(newAnswers)
      setTimeout(() => {
        setStep(4)
        dispatch({
          type: 'COMPLETE_QUESTIONNAIRE',
          payload: { answers: newAnswers, message },
        })
      }, 2200)
    }
  }

  function handleBegin() {
    navigate('/home')
  }

  const currentStep = STEPS[step]
  const partnerMessage = state.aiPartnerMessage

  return (
    <div style={{
      minHeight: '100%',
      background: 'linear-gradient(165deg, #1e2d2e 0%, #2C3A2D 100%)',
      display: 'flex',
      flexDirection: 'column',
    }}>

      {/* Header */}
      <div style={{ padding: '16px 24px 8px', color: 'white' }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 2 }}>
          Setting up your
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
          re<span style={{ color: '#9EC9A2' }}>root</span> companion
        </div>
      </div>

      {/* Step dots */}
      {step < 3 && (
        <div style={{ display: 'flex', gap: 6, padding: '4px 24px 16px' }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              height: 3, flex: 1, borderRadius: 2,
              background: i <= step ? '#9EC9A2' : 'rgba(255,255,255,0.15)',
              transition: 'background 0.3s',
            }}/>
          ))}
        </div>
      )}

      {/* Content area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 20px' }}>
        <AnimatePresence mode="wait">

          {/* Question steps 0–2 */}
          {step < 3 && (
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.2 }}
            >
              <div style={{
                fontSize: 20, fontWeight: 700, color: 'white',
                marginBottom: 20, lineHeight: 1.3,
              }}>
                {currentStep.question}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {currentStep.options.map(opt => {
                  const isSelected = selected === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleSelect(opt.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 14,
                        padding: '14px 16px', borderRadius: 16, cursor: 'pointer',
                        border: `1.5px solid ${isSelected ? '#9EC9A2' : 'rgba(255,255,255,0.12)'}`,
                        background: isSelected ? 'rgba(158,201,162,0.15)' : 'rgba(255,255,255,0.05)',
                        transition: 'all 0.15s',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: 22, flexShrink: 0 }}>{opt.emoji}</span>
                      <span style={{
                        fontSize: 14, fontWeight: isSelected ? 600 : 400,
                        color: isSelected ? 'white' : 'rgba(255,255,255,0.75)',
                        lineHeight: 1.3,
                      }}>
                        {opt.label}
                      </span>
                      {isSelected && (
                        <span style={{ marginLeft: 'auto', color: '#9EC9A2', fontSize: 16, flexShrink: 0 }}>✓</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </motion.div>
          )}

          {/* Thinking state */}
          {step === 3 && (
            <motion.div
              key="thinking"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 20,
              }}
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
                style={{
                  width: 48, height: 48, borderRadius: '50%',
                  border: '3px solid rgba(158,201,162,0.2)',
                  borderTopColor: '#9EC9A2',
                }}
              />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'white', marginBottom: 6 }}>
                  Building your companion...
                </div>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)' }}>
                  Personalising your 12-week arc
                </div>
              </div>
            </motion.div>
          )}

          {/* Result — AI partner message */}
          {step === 4 && (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              style={{ paddingBottom: 20 }}
            >
              {/* Avatar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                <div style={{
                  width: 52, height: 52, borderRadius: '50%',
                  background: 'linear-gradient(135deg, #7A9E7E, #9EC9A2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 24, flexShrink: 0,
                  boxShadow: '0 0 0 3px rgba(158,201,162,0.25)',
                }}>
                  🌿
                </div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'white' }}>Your Reroot Companion</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                    AI · Therapist-reviewed methodology
                  </div>
                </div>
              </div>

              {/* Message bubble */}
              <div style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(158,201,162,0.25)',
                borderRadius: '4px 20px 20px 20px',
                padding: '18px 20px',
                marginBottom: 24,
              }}>
                <p style={{
                  fontSize: 15, color: 'rgba(255,255,255,0.9)',
                  lineHeight: 1.65, margin: 0,
                }}>
                  {partnerMessage}
                </p>
              </div>

              {/* What's next preview */}
              <div style={{
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 16, padding: '14px 16px', marginBottom: 6,
              }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
                  Your week 1 starts with
                </div>
                {[
                  { emoji: '📖', text: 'The Arrival Framework — a 10-min reflection' },
                  { emoji: '☕', text: 'One low-pressure cohort event' },
                  { emoji: '🤝', text: 'Meeting 3 people in your cohort' },
                ].map(item => (
                  <div key={item.text} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
                    <span style={{ fontSize: 14, flexShrink: 0 }}>{item.emoji}</span>
                    <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.4 }}>{item.text}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>

      {/* Bottom CTA */}
      <div style={{
        background: 'var(--cream)',
        borderRadius: '28px 28px 0 0',
        padding: '20px 20px 36px',
      }}>
        {step < 3 ? (
          <button
            className="btn btn--primary"
            onClick={handleNext}
            disabled={selected === null}
            style={{ opacity: selected === null ? 0.45 : 1 }}
          >
            {step < STEPS.length - 1 ? 'Continue →' : 'Build my companion →'}
          </button>
        ) : step === 4 ? (
          <button className="btn btn--primary" onClick={handleBegin}>
            Begin Week 1 →
          </button>
        ) : (
          <button className="btn btn--primary" disabled style={{ opacity: 0.45 }}>
            Building...
          </button>
        )}

        {step < 3 && (
          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: 'var(--charcoal-light)' }}>
            Question {step + 1} of {STEPS.length} · Takes 30 seconds
          </div>
        )}
      </div>
    </div>
  )
}
