import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from './context/AppContext'
import { useT } from './i18n'
import StatusBar from './components/StatusBar'
import BottomNav from './components/BottomNav'
import InstallBanner from './components/InstallBanner'
// Companion chat (LLM) disabled — kept in the codebase as dead code so the
// surface is easy to bring back, but unmounted here so users can't open it
// and burn API tokens. Re-enable by restoring the import + FAB + mount.
// import CompanionChat from './components/CompanionChat'
import SyncStatus from './components/SyncStatus'
import BadgeUnlockToast from './components/BadgeUnlockToast'
import Onboarding     from './screens/Onboarding'
import IdentityMirror from './screens/IdentityMirror'
import PartnerIntro   from './screens/PartnerIntro'
import Diagnostic     from './screens/Diagnostic'
import Home           from './screens/Home'
import Events         from './screens/Events'
import Community      from './screens/Community'
import Groups         from './screens/Groups'
import GroupDetail    from './screens/GroupDetail'
import JoinGroup      from './screens/JoinGroup'
import Friends        from './screens/Friends'
import Profile        from './screens/Profile'
import AdminIgAccounts from './screens/AdminIgAccounts'
import AddFriend       from './screens/AddFriend'
import MyRsvps         from './screens/MyRsvps'
import FriendDetail    from './screens/FriendDetail'
import Sources         from './screens/Sources'
import SourceDetail    from './screens/SourceDetail'
import VenueDashboard  from './screens/VenueDashboard'

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
  // Counter incremented/decremented by any bottom-sheet via the `aue-modal`
  // CustomEvent. Previously gated the Companion FAB; kept in case other
  // floating UI wants to use the same broadcast.
  const [modalCount, setModalCount] = useState(0)

  // Onboarding was previously a 4-step flow (welcome → identity mirror →
  // partner intro → diagnostic). The brand pivot to "Curitiba's complete
  // event app" makes those questions vestigial — we'll re-introduce a much
  // shorter mood/profile picker later. For now: just the welcome screen.
  const isOnboarding = ['/', '/onboarding'].includes(location.pathname)
  // Tabs show on every screen except Onboarding. We no longer require
  // hasJoined because visitors can use the app without signing in — they
  // hit Onboarding only on first launch and immediately get past it.
  const showNav = !isOnboarding

  // Sync accessibility mode to root element so CSS [data-accessibility="on"] selectors work
  useEffect(() => {
    document.documentElement.dataset.accessibility = state.accessibilityMode ? 'on' : 'off'
  }, [state.accessibilityMode])

  // Track open bottom-sheets globally — kept around for any future
  // floating UI that needs the same broadcast (was the Companion FAB).
  useEffect(() => {
    function onModal(e) {
      const delta = e.detail?.delta || 0
      setModalCount(c => Math.max(0, c + delta))
    }
    window.addEventListener('aue-modal', onModal)
    return () => window.removeEventListener('aue-modal', onModal)
  }, [])

  return (
    <div className="phone-shell">
      <StatusBar dark={isOnboarding} />
      <InstallBanner />

      {/* Screen area — AnimatePresence key on pathname triggers exit/enter */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <AnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route
              path="/"
              element={
                !state.hasJoined
                  ? <AnimatedPage><Onboarding /></AnimatedPage>
                  : <Navigate to="/home" replace />
              }
            />
            {/* Question screens are kept but bypassed — restore the routes
                here when we re-introduce a (shorter) profile/mood picker.
                /journey (the 12-week framework) is also vestigial from the
                Reroot brand and not reachable from any current UI. */}
            <Route path="/identity-mirror" element={<Navigate to="/home" replace />} />
            <Route path="/partner-intro"   element={<Navigate to="/home" replace />} />
            <Route path="/diagnostic"      element={<Navigate to="/home" replace />} />
            <Route path="/journey"         element={<Navigate to="/home" replace />} />
            <Route path="/home"    element={<AnimatedPage><Home /></AnimatedPage>} />
            <Route path="/events"  element={<AnimatedPage><Events /></AnimatedPage>} />
            <Route path="/community" element={<AnimatedPage><Community /></AnimatedPage>} />
            <Route path="/groups"  element={<Navigate to="/community" replace />} />
            <Route path="/friends" element={<Navigate to="/community" replace />} />
            <Route path="/groups/:groupId" element={<AnimatedPage><GroupDetail /></AnimatedPage>} />
            <Route path="/join/:inviteCode" element={<AnimatedPage><JoinGroup /></AnimatedPage>} />
            <Route path="/friend/:code" element={<AnimatedPage><AddFriend /></AnimatedPage>} />
            <Route path="/friends/:googleId" element={<AnimatedPage><FriendDetail /></AnimatedPage>} />
            <Route path="/my-rsvps" element={<AnimatedPage><MyRsvps /></AnimatedPage>} />
            <Route path="/sources" element={<AnimatedPage><Sources /></AnimatedPage>} />
            <Route path="/sources/:sourceId" element={<AnimatedPage><SourceDetail /></AnimatedPage>} />
            <Route path="/venue/:handle" element={<AnimatedPage><VenueDashboard /></AnimatedPage>} />
            <Route path="/profile" element={<AnimatedPage><Profile /></AnimatedPage>} />
            <Route path="/admin/ig" element={<AnimatedPage><AdminIgAccounts /></AnimatedPage>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AnimatePresence>
      </div>

      {showNav && <BottomNav />}

      {/* Companion FAB + chat panel removed — entry point gone so users
          can't trigger per-message LLM calls against the project's API
          tokens. Backend cached enrichments (vibe summaries) still
          render normally; only the real-time chat is gated. */}

      <SyncStatus lang={state.language} />
      <BadgeUnlockToast />
    </div>
  )
}
