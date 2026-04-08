import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from './context/AppContext'
import StatusBar from './components/StatusBar'
import BottomNav from './components/BottomNav'
import Onboarding    from './screens/Onboarding'
import PartnerIntro  from './screens/PartnerIntro'
import Home          from './screens/Home'
import Events        from './screens/Events'
import Journey       from './screens/Journey'
import Profile       from './screens/Profile'

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

  const isOnboarding = ['/', '/onboarding', '/partner-intro'].includes(location.pathname)
  const showNav = state.hasJoined && state.questionnaireCompleted && !isOnboarding

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
                  : !state.questionnaireCompleted
                  ? <Navigate to="/partner-intro" replace />
                  : <Navigate to="/home" replace />
              }
            />
            <Route
              path="/partner-intro"
              element={
                !state.hasJoined
                  ? <Navigate to="/" replace />
                  : state.questionnaireCompleted
                  ? <Navigate to="/home" replace />
                  : <AnimatedPage><PartnerIntro /></AnimatedPage>
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
    </div>
  )
}
