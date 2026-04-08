import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'

export default function IdentityMirror() {
  const { dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()

  const [step, setStep] = useState(0)        // 0, 1, 2 (affirmation)
  const [pastLife, setPastLife] = useState(null)
  const [currentFeel, setCurrentFeel] = useState(null)
  const [selected, setSelected] = useState(null)

  function handleNext() {
    if (step === 0) {
      if (!selected) return
      setPastLife(selected)
      setSelected(null)
      setStep(1)
    } else if (step === 1) {
      if (!selected) return
      setCurrentFeel(selected)
      setSelected(null)
      setStep(2)
    } else {
      // Step 2 — affirmation, just proceed
      dispatch({
        type: 'COMPLETE_IDENTITY_MIRROR',
        payload: { pastLife, currentFeel },
      })
      navigate('/partner-intro')
    }
  }

  const step1opts = t.mirror_step1_opts
  const step2opts = t.mirror_step2_opts

  // Build affirmation: one line for past life, one for current feel
  const aff1 = t.mirror_affirmations[pastLife]
  const aff2 = t.mirror_affirmations[currentFeel]

  return (
    <div style={{
      minHeight: '100%',
      background: 'linear-gradient(165deg, #1e1e2e 0%, #2C2C3A 100%)',
      display: 'flex', flexDirection: 'column',
    }}>

      {/* Header */}
      <div style={{ padding: '16px 24px 8px', color: 'white' }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 2 }}>
          {t.mirror_header}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
          re<span style={{ color: '#C4A882' }}>root</span>
        </div>
      </div>

      {/* Step dots */}
      {step < 2 && (
        <div style={{ display: 'flex', gap: 6, padding: '4px 24px 16px' }}>
          {[0, 1].map(i => (
            <div key={i} style={{
              height: 3, flex: 1, borderRadius: 2,
              background: i <= step ? '#C4724A' : 'rgba(255,255,255,0.15)',
              transition: 'background 0.3s',
            }}/>
          ))}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 20px' }}>
        <AnimatePresence mode="wait">

          {/* Step 0 — past social life */}
          {step === 0 && (
            <motion.div key="step0"
              initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.2 }}
            >
              <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 20, lineHeight: 1.3 }}>
                {t.mirror_step1_q}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {step1opts.map(opt => {
                  const isSelected = selected === opt.id
                  return (
                    <button key={opt.id} onClick={() => setSelected(opt.id)} style={{
                      display: 'flex', alignItems: 'center', gap: 14,
                      padding: '14px 16px', borderRadius: 16, cursor: 'pointer',
                      border: `1.5px solid ${isSelected ? '#C4724A' : 'rgba(255,255,255,0.12)'}`,
                      background: isSelected ? 'rgba(196,114,74,0.15)' : 'rgba(255,255,255,0.05)',
                      transition: 'all 0.15s', textAlign: 'left',
                    }}>
                      <span style={{ fontSize: 22, flexShrink: 0 }}>{opt.emoji}</span>
                      <span style={{ fontSize: 14, fontWeight: isSelected ? 600 : 400, color: isSelected ? 'white' : 'rgba(255,255,255,0.75)', lineHeight: 1.3 }}>
                        {opt.label}
                      </span>
                      {isSelected && <span style={{ marginLeft: 'auto', color: '#C4724A', fontSize: 16, flexShrink: 0 }}>✓</span>}
                    </button>
                  )
                })}
              </div>
            </motion.div>
          )}

          {/* Step 1 — current feel */}
          {step === 1 && (
            <motion.div key="step1"
              initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.2 }}
            >
              <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 20, lineHeight: 1.3 }}>
                {t.mirror_step2_q}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {step2opts.map(opt => {
                  const isSelected = selected === opt.id
                  return (
                    <button key={opt.id} onClick={() => setSelected(opt.id)} style={{
                      display: 'flex', alignItems: 'center', gap: 14,
                      padding: '14px 16px', borderRadius: 16, cursor: 'pointer',
                      border: `1.5px solid ${isSelected ? '#C4724A' : 'rgba(255,255,255,0.12)'}`,
                      background: isSelected ? 'rgba(196,114,74,0.15)' : 'rgba(255,255,255,0.05)',
                      transition: 'all 0.15s', textAlign: 'left',
                    }}>
                      <span style={{ fontSize: 22, flexShrink: 0 }}>{opt.emoji}</span>
                      <span style={{ fontSize: 14, fontWeight: isSelected ? 600 : 400, color: isSelected ? 'white' : 'rgba(255,255,255,0.75)', lineHeight: 1.3 }}>
                        {opt.label}
                      </span>
                      {isSelected && <span style={{ marginLeft: 'auto', color: '#C4724A', fontSize: 16, flexShrink: 0 }}>✓</span>}
                    </button>
                  )
                })}
              </div>
            </motion.div>
          )}

          {/* Step 2 — affirmation */}
          {step === 2 && (
            <motion.div key="affirmation"
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              style={{ paddingBottom: 20 }}
            >
              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <div style={{
                  width: 56, height: 56, borderRadius: '50%', margin: '0 auto 14px',
                  background: 'linear-gradient(135deg, #C4724A, #E8956D)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 28,
                }}>🪞</div>
                <div style={{ fontSize: 11, color: 'rgba(196,114,74,0.9)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>
                  {t.mirror_affirmation_label}
                </div>
              </div>

              <div style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(196,114,74,0.3)',
                borderRadius: '4px 20px 20px 20px', padding: '18px 20px', marginBottom: 14,
              }}>
                {aff1 && (
                  <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.9)', lineHeight: 1.65, margin: '0 0 10px' }}>
                    {aff1}
                  </p>
                )}
                {aff2 && (
                  <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.9)', lineHeight: 1.65, margin: 0 }}>
                    {aff2}
                  </p>
                )}
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>

      {/* CTA */}
      <div style={{ background: 'var(--cream)', borderRadius: '28px 28px 0 0', padding: '20px 20px 36px' }}>
        <button
          className="btn btn--primary"
          onClick={handleNext}
          disabled={step < 2 && !selected}
          style={{ opacity: step < 2 && !selected ? 0.45 : 1 }}
        >
          {step === 0 ? t.mirror_continue
           : step === 1 ? t.mirror_finish
           : t.mirror_next_btn}
        </button>

        {step < 2 && (
          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: 'var(--charcoal-light)' }}>
            {t.mirror_question_of} {step + 1} / 2
          </div>
        )}
      </div>
    </div>
  )
}
