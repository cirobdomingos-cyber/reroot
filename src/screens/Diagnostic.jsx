import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useApp, getChapter, getProfile } from '../context/AppContext'
import { useT } from '../i18n'

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 } }

function DiagRow({ icon, label, value, color, delay }) {
  return (
    <motion.div
      {...fadeUp}
      transition={{ duration: 0.35, delay }}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px', borderRadius: 14,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)',
        marginBottom: 8,
      }}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: color ?? 'rgba(255,255,255,0.1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 16,
      }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)', lineHeight: 1.3 }}>
          {value}
        </div>
      </div>
    </motion.div>
  )
}

export default function Diagnostic() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()

  const chapter = getChapter(1)
  const answers = state.questionnaireAnswers ?? {}
  const pastLife = state.identityPastLife
  const currentFeel = state.identityCurrentFeel
  const profile = getProfile(state.userSituation)
  const profileCopy = t.profiles?.[state.userSituation]
  const goalCopy = t.goals?.[state.userGoal]

  const pastLabel = t.diag_past_labels?.[pastLife] ?? pastLife
  const feelLabel = t.diag_feel_labels?.[currentFeel] ?? currentFeel
  const reasonLabel = t.diag_reason_labels?.[answers.reason] ?? answers.reason
  const challengeLabel = t.diag_challenge_labels?.[answers.challenge] ?? answers.challenge
  const goalLabel = t.diag_goal_labels?.[answers.goal] ?? answers.goal

  // Profile-specific prescription lines (fallback to generic)
  const rxLines = profileCopy
    ? [profileCopy.rx1, profileCopy.rx2, profileCopy.rx3]
    : [t.diag_rx_line1, t.diag_rx_line2, t.diag_rx_line3]

  function handleBegin() {
    dispatch({ type: 'MARK_DIAGNOSTIC_SEEN' })
    navigate('/home')
  }

  return (
    <div style={{
      minHeight: '100%',
      background: 'linear-gradient(165deg, #2C2C2C 0%, #3d2d25 100%)',
      display: 'flex', flexDirection: 'column', color: 'white',
    }}>
      <div style={{ flex: 1, padding: '16px 20px', overflowY: 'auto' }}>

        {/* Header */}
        <motion.div {...fadeUp} transition={{ duration: 0.4 }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 4 }}>
            {t.diag_header}
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>
            {t.diag_hello} {state.userName}
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 20, lineHeight: 1.5 }}>
            {t.diag_we_heard}
          </div>
        </motion.div>

        {/* Diagnostic rows */}
        {profileCopy && (
          <DiagRow icon={profile?.emoji ?? '🧭'} label={t.diag_profile_label} value={profileCopy.name} color="rgba(196,114,74,0.25)" delay={0.1} />
        )}
        {goalCopy && (
          <DiagRow icon={goalCopy.emoji} label={t.diag_goal_label} value={goalCopy.label} color="rgba(155,126,184,0.2)" delay={0.2} />
        )}
        {pastLife && (
          <DiagRow icon="🪞" label={t.diag_social_before} value={pastLabel} color="rgba(122,158,126,0.2)" delay={0.3} />
        )}
        {currentFeel && (
          <DiagRow icon="💭" label={t.diag_feeling_now} value={feelLabel} color="rgba(122,158,126,0.25)" delay={0.4} />
        )}
        {answers.challenge && (
          <DiagRow icon="⚡" label={t.diag_challenge} value={challengeLabel} color="rgba(212,162,86,0.2)" delay={0.5} />
        )}

        {/* Prescription card */}
        <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.7 }}>
          <div style={{
            marginTop: 12,
            background: 'rgba(122,158,126,0.12)',
            border: '1px solid rgba(122,158,126,0.25)',
            borderRadius: 20, padding: '18px 18px 16px',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
            }}>
              <span style={{ fontSize: 20 }}>💊</span>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'rgba(158,201,162,0.9)' }}>
                {t.diag_prescription}
              </div>
            </div>

            {rxLines.map((line, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8,
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: '#9EC9A2', marginTop: 6,
                }}/>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>
                  {line}
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Chapter preview */}
        <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.85 }}>
          <div style={{
            marginTop: 12,
            background: `${chapter.color}22`,
            border: `1px solid ${chapter.color}33`,
            borderRadius: 18, padding: '14px 16px',
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: chapter.color, marginBottom: 6 }}>
              {t.diag_chapter}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'white', marginBottom: 4 }}>
              {chapter.name}
            </div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
              {chapter.desc}
            </div>
            {profileCopy?.tag && (
              <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: chapter.color, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                {profileCopy.tag}
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* CTA */}
      <div style={{ background: 'var(--cream)', borderRadius: '28px 28px 0 0', padding: '20px 20px 36px' }}>
        <button className="btn btn--primary" onClick={handleBegin}>
          {t.diag_begin}
        </button>
      </div>
    </div>
  )
}
