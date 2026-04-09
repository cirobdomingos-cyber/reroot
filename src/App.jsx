import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from './context/AppContext'
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
  const [companionOpen, setCompanionOpen] = useState(false)

  const isOnboarding = ['/', '/onboarding', '/identity-mirror', '/partner-intro', '/diagnostic'].includes(location.pathname)
  const showNav = state.hasJoined && state.questionnaireCompleted && !isOnboarding

  // Sync accessibility mode to root element so CSS [data-accessibility="on"] selectors work
  useEffect(() => {
    document.documentElement.dataset.accessibility = state.accessibilityMode ? 'on' : 'off'
  }, [state.accessibilityMode])

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
            <Route path="/profile" element={<AnimatedPage><Profile /></AnimatedPage>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AnimatePresence>
      </div>

      {showNav && <BottomNav />}

      {/* AI Companion FAB — visible on all main screens */}
      {showNav && !companionOpen && (
        <motion.button
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.3, type: 'spring', stiffness: 260, damping: 20 }}
          onClick={() => setCompanionOpen(true)}
          style={{
            position: 'absolute', bottom: 80, right: 16, zIndex: 50,
            width: 52, height: 52, borderRadius: '50%', border: 'none',
            background: 'var(--sage)', color: 'white',
            boxShadow: '0 4px 16px rgba(122, 158, 126, 0.4)',
            cursor: 'pointer', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 22,
          }}
        >
          🌿
        </motion.button>
      )}

      <CompanionChat open={companionOpen} onClose={() => setCompanionOpen(false)} />
      <SyncStatus lang={state.language} />
    </div>
  )
}
