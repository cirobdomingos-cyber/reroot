import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'

function generateMessage(t, answers) {
  const { reason, challenge, goal } = answers
  const msgs = t.partner_messages
  const opener  = msgs[reason]    ?? msgs.change
  const middle  = msgs[challenge] ?? msgs.consistent
  const closer  = msgs[goal]      ?? msgs.friendships
  return `${opener} ${middle} ${closer}`
}

export default function PartnerIntro() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()

  const STEPS = t.partner_steps

  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState({})
  const [selected, setSelected] = useState(null)

  function handleNext() {
    if (selected === null) return
    const newAnswers = { ...answers, [STEPS[step].id]: selected }
    setAnswers(newAnswers)
    setSelected(null)

    if (step < STEPS.length - 1) {
      setStep(step + 1)
    } else {
      setStep(3)
      const message = generateMessage(t, newAnswers)
      setTimeout(() => {
        setStep(4)
        dispatch({ type: 'COMPLETE_QUESTIONNAIRE', payload: { answers: newAnswers, message } })
      }, 2200)
    }
  }

  const currentStep = STEPS[step]
  const partnerMessage = state.aiPartnerMessage

  return (
    <div style={{
      minHeight: '100%',
      background: 'linear-gradient(165deg, #1e2d2e 0%, #2C3A2D 100%)',
      display: 'flex', flexDirection: 'column',
    }}>

      {/* Header */}
      <div style={{ padding: '16px 24px 8px', color: 'white' }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 2 }}>
          {t.partner_setting_up}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
          re<span style={{ color: '#9EC9A2' }}>root</span> {t.partner_companion_title}
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

      {/* Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 20px' }}>
        <AnimatePresence mode="wait">

          {/* Questions */}
          {step < 3 && (
            <motion.div key={step}
              initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.2 }}
            >
              <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 20, lineHeight: 1.3 }}>
                {currentStep.question}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {currentStep.options.map(opt => {
                  const isSelected = selected === opt.id
                  return (
                    <button key={opt.id} onClick={() => setSelected(opt.id)} style={{
                      display: 'flex', alignItems: 'center', gap: 14,
                      padding: '14px 16px', borderRadius: 16, cursor: 'pointer',
                      border: `1.5px solid ${isSelected ? '#9EC9A2' : 'rgba(255,255,255,0.12)'}`,
                      background: isSelected ? 'rgba(158,201,162,0.15)' : 'rgba(255,255,255,0.05)',
                      transition: 'all 0.15s', textAlign: 'left',
                    }}>
                      <span style={{ fontSize: 22, flexShrink: 0 }}>{opt.emoji}</span>
                      <span style={{ fontSize: 14, fontWeight: isSelected ? 600 : 400, color: isSelected ? 'white' : 'rgba(255,255,255,0.75)', lineHeight: 1.3 }}>
                        {opt.label}
                      </span>
                      {isSelected && <span style={{ marginLeft: 'auto', color: '#9EC9A2', fontSize: 16, flexShrink: 0 }}>✓</span>}
                    </button>
                  )
                })}
              </div>
            </motion.div>
          )}

          {/* Thinking */}
          {step === 3 && (
            <motion.div key="thinking" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
                style={{ width: 48, height: 48, borderRadius: '50%', border: '3px solid rgba(158,201,162,0.2)', borderTopColor: '#9EC9A2' }}
              />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'white', marginBottom: 6 }}>{t.partner_building_title}</div>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)' }}>{t.partner_building_sub}</div>
              </div>
            </motion.div>
          )}

          {/* Result */}
          {step === 4 && (
            <motion.div key="result" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} style={{ paddingBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                <div style={{
                  width: 52, height: 52, borderRadius: '50%',
                  background: 'linear-gradient(135deg, #7A9E7E, #9EC9A2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 24, flexShrink: 0, boxShadow: '0 0 0 3px rgba(158,201,162,0.25)',
                }}>🌿</div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'white' }}>{t.partner_companion_label}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>{t.partner_companion_sub}</div>
                </div>
              </div>

              <div style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(158,201,162,0.25)',
                borderRadius: '4px 20px 20px 20px', padding: '18px 20px', marginBottom: 24,
              }}>
                <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.9)', lineHeight: 1.65, margin: 0 }}>
                  {partnerMessage}
                </p>
              </div>

              <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 16, padding: '14px 16px', marginBottom: 6 }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
                  {t.partner_week1_label}
                </div>
                {t.partner_week1_items.map(item => (
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

      {/* CTA */}
      <div style={{ background: 'var(--cream)', borderRadius: '28px 28px 0 0', padding: '20px 20px 36px' }}>
        {step < 3 ? (
          <button className="btn btn--primary" onClick={handleNext} disabled={selected === null} style={{ opacity: selected === null ? 0.45 : 1 }}>
            {step < STEPS.length - 1 ? t.partner_continue : t.partner_build}
          </button>
        ) : step === 4 ? (
          <button className="btn btn--primary" onClick={() => navigate('/home')}>{t.partner_begin}</button>
        ) : (
          <button className="btn btn--primary" disabled style={{ opacity: 0.45 }}>{t.partner_building_btn}</button>
        )}

        {step < 3 && (
          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: 'var(--charcoal-light)' }}>
            {t.partner_question_of} {step + 1} / {STEPS.length} · {t.partner_takes}
          </div>
        )}
      </div>
    </div>
  )
}
