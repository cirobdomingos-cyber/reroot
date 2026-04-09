import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from './context/AppContext'
import { useT } from './i18n'
import StatusBar from './components/StatusBar'
import BottomNav from './components/BottomNav'
import CompanionChat from './components/CompanionChat'
import SyncStatus from './components/SyncStatus'
import Onboarding     from './screens/Onboarding'
import IdentityMirror from './screens/IdentityMirror'
import PartnerIntro   from './screens/PartnerIntro'
import Diagnostic     from './screens/Diagnostic'
import Home           from './screens/Home'
import Events         from './screens/Events'
import Journey        from './screens/Journey'
import Friends        from './screens/Friends'
import Profile        from './screens/Profile'

const pageVariants = {
  initial: { opacity: 0, x: 28 },
  animate: { opacity: 1, x: 0 },
  exit:    { opacity: 0, x: -28 },
}
const pageTransition = { duration: 0.22, ease: [0.4, 0, 0.2, 1] }

function AnimatedPage({ children }) {
  return (
    <motion.div
      className="screen"
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={pageTransition}
    >
      <div className="screen-inner">{children}</div>
    </motion.div>
  )
}

export default function App() {
  const { state } = useApp()
  const location = useLocation()
  const t = useT()
  const [companionOpen, setCompanionOpen] = useState(false)

  // First-visit coach-mark: show a hint bubble for 6s the first time the FAB renders,
  // then fall back to the compact extended-FAB. Persisted in localStorage.
  const [showHint, setShowHint] = useState(() => {
    try { return localStorage.getItem('reroot_companion_hint_seen') !== '1' } catch { return false }
  })

  const isOnboarding = ['/', '/onboarding', '/identity-mirror', '/partner-intro', '/diagnostic'].includes(location.pathname)
  const showNav = state.hasJoined && state.questionnaireCompleted && !isOnboarding

  // Sync accessibility mode to root element so CSS [data-accessibility="on"] selectors work
  useEffect(() => {
    document.documentElement.dataset.accessibility = state.accessibilityMode ? 'on' : 'off'
  }, [state.accessibilityMode])

  // Auto-dismiss the hint after 6s the first time the FAB is visible
  useEffect(() => {
    if (!showNav || !showHint) return
    const id = setTimeout(() => {
      setShowHint(false)
      try { localStorage.setItem('reroot_companion_hint_seen', '1') } catch {}
    }, 6000)
    return () => clearTimeout(id)
  }, [showNav, showHint])

  function openCompanion() {
    setCompanionOpen(true)
    if (showHint) {
      setShowHint(false)
      try { localStorage.setItem('reroot_companion_hint_seen', '1') } catch {}
    }
  }

  return (
    <div className="phone-shell">
      <StatusBar dark={isOnboarding} />

      {/* Screen area — AnimatePresence key on pathname triggers exit/enter */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route
              path="/"
              element={
                !state.hasJoined
                  ? <AnimatedPage><Onboarding /></AnimatedPage>
                  : !state.identityMirrorCompleted
                  ? <Navigate to="/identity-mirror" replace />
                  : !state.questionnaireCompleted
                  ? <Navigate to="/partner-intro" replace />
                  : !state.diagnosticSeen
                  ? <Navigate to="/diagnostic" replace />
                  : <Navigate to="/home" replace />
              }
            />
            <Route
              path="/identity-mirror"
              element={
                !state.hasJoined
                  ? <Navigate to="/" replace />
                  : state.identityMirrorCompleted
                  ? <Navigate to="/partner-intro" replace />
                  : <AnimatedPage><IdentityMirror /></AnimatedPage>
              }
            />
            <Route
              path="/partner-intro"
              element={
                !state.hasJoined
                  ? <Navigate to="/" replace />
                  : !state.identityMirrorCompleted
                  ? <Navigate to="/identity-mirror" replace />
                  : state.questionnaireCompleted
                  ? <Navigate to="/home" replace />
                  : <AnimatedPage><PartnerIntro /></AnimatedPage>
              }
            />
            <Route
              path="/diagnostic"
              element={
                !state.questionnaireCompleted
                  ? <Navigate to="/" replace />
                  : state.diagnosticSeen
                  ? <Navigate to="/home" replace />
                  : <AnimatedPage><Diagnostic /></AnimatedPage>
              }
            />
            <Route path="/home"    element={<AnimatedPage><Home /></AnimatedPage>} />
            <Route path="/events"  element={<AnimatedPage><Events /></AnimatedPage>} />
            <Route path="/journey" element={<AnimatedPage><Journey /></AnimatedPage>} />
            <Route path="/friends" element={<AnimatedPage><Friends /></AnimatedPage>} />
            <Route path="/profile" element={<AnimatedPage><Profile /></AnimatedPage>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AnimatePresence>
      </div>

      {showNav && <BottomNav />}

      {/* AI Companion FAB — extended pill, pulsing halo, first-visit hint bubble */}
      {showNav && !companionOpen && (
        <div style={{ position: 'absolute', bottom: 84, right: 16, zIndex: 50 }}>
          {/* First-visit hint bubble */}
          <AnimatePresence>
            {showHint && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.95 }}
                transition={{ duration: 0.3 }}
                style={{
                  position: 'absolute', bottom: 64, right: 0,
                  background: 'white', color: 'var(--charcoal)',
                  borderRadius: '16px 16px 4px 16px',
                  padding: '10px 14px', fontSize: 13, fontWeight: 600,
                  whiteSpace: 'nowrap',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                  border: '1px solid rgba(122,158,126,0.3)',
                }}
              >
                {t.companion_fab_hint ?? 'Converse com seu companheiro'}
                <div style={{
                  position: 'absolute', bottom: -6, right: 20,
                  width: 12, height: 12, background: 'white',
                  transform: 'rotate(45deg)',
                  borderRight: '1px solid rgba(122,158,126,0.3)',
                  borderBottom: '1px solid rgba(122,158,126,0.3)',
                }}/>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Pulsing halo ring (behind button) */}
          <motion.div
            aria-hidden
            animate={{ scale: [1, 1.35, 1], opacity: [0.55, 0, 0.55] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: 'easeOut' }}
            style={{
              position: 'absolute', inset: 0,
              borderRadius: 999,
              background: 'rgba(122,158,126,0.45)',
              pointerEvents: 'none',
            }}
          />

          {/* Extended FAB */}
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.3, type: 'spring', stiffness: 260, damping: 20 }}
            onClick={openCompanion}
            aria-label={t.companion_fab_hint ?? 'Companion chat'}
            style={{
              position: 'relative',
              display: 'flex', alignItems: 'center', gap: 8,
              height: 56, padding: '0 18px 0 14px',
              borderRadius: 999, border: 'none', cursor: 'pointer',
              background: 'linear-gradient(135deg, #7A9E7E 0%, #9EC9A2 100%)',
              color: 'white',
              boxShadow: '0 6px 20px rgba(122, 158, 126, 0.55), 0 0 0 3px rgba(255,255,255,0.08)',
              fontSize: 14, fontWeight: 700, letterSpacing: 0.3,
            }}
          >
            <span style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'rgba(255,255,255,0.22)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18,
            }}>🌿</span>
            {t.companion_fab_label ?? 'Companheiro'}
          </motion.button>
        </div>
      )}

      <CompanionChat open={companionOpen} onClose={() => setCompanionOpen(false)} />
      <SyncStatus lang={state.language} />
    </div>
  )
}
