import { useState, useEffect } from 'react'
import { Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from './context/AppContext'
import { useT } from './i18n'
import StatusBar from './components/StatusBar'
import BottomNav from './components/BottomNav'
import CompanionChat from './components/CompanionChat'
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
  // Counter incremented/decremented by any bottom-sheet via the `aue-modal`
  // CustomEvent. We hide the FAB while any sheet is open because the FAB
  // sits in the phone-shell stacking context and AnimatedPage establishes
  // its own (framer-motion sets inline transform), so a sheet inside an
  // AnimatedPage cannot stack above the FAB no matter how high its z-index.
  const [modalCount, setModalCount] = useState(0)

  // First-visit coach-mark: show a hint bubble for 6s the first time the FAB renders,
  // then fall back to the compact extended-FAB. Persisted in localStorage.
  const [showHint, setShowHint] = useState(() => {
    try { return localStorage.getItem('aue_companion_hint_seen') !== '1' } catch { return false }
  })

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

  // Auto-dismiss the hint after 6s the first time the FAB is visible
  useEffect(() => {
    if (!showNav || !showHint) return
    const id = setTimeout(() => {
      setShowHint(false)
      try { localStorage.setItem('aue_companion_hint_seen', '1') } catch {}
    }, 6000)
    return () => clearTimeout(id)
  }, [showNav, showHint])

  // Cross-screen bridge: any screen can open the Companion by dispatching
  // a window CustomEvent('open-companion', { detail: { intent } }). Used
  // by the Events tab "ask for ideas" CTA (intent: 'suggest').
  useEffect(() => {
    function onOpen() { setCompanionOpen(true) }
    window.addEventListener('open-companion', onOpen)
    return () => window.removeEventListener('open-companion', onOpen)
  }, [])

  // Track open bottom-sheets globally so we can hide the FAB while one is up.
  useEffect(() => {
    function onModal(e) {
      const delta = e.detail?.delta || 0
      setModalCount(c => Math.max(0, c + delta))
    }
    window.addEventListener('aue-modal', onModal)
    return () => window.removeEventListener('aue-modal', onModal)
  }, [])

  function openCompanion() {
    setCompanionOpen(true)
    if (showHint) {
      setShowHint(false)
      try { localStorage.setItem('aue_companion_hint_seen', '1') } catch {}
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
            <Route path="/profile" element={<AnimatedPage><Profile /></AnimatedPage>} />
            <Route path="/admin/ig" element={<AnimatedPage><AdminIgAccounts /></AnimatedPage>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AnimatePresence>
      </div>

      {showNav && <BottomNav />}

      {/* AI Companion FAB — extended pill, pulsing halo, first-visit hint bubble.
          bottom:96 (BottomNav is 80) gives 16px clearance above the nav so
          the FAB doesn't visually crowd the rightmost tab; the original 84
          left only 4px which read as overlap on real devices. */}
      {showNav && !companionOpen && modalCount === 0 && (
        <div style={{ position: 'absolute', bottom: 96, right: 16, zIndex: 50 }}>
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
                  border: '1px solid rgba(232, 98, 63, 0.3)',
                }}
              >
                {t.companion_fab_hint ?? 'Converse com seu companheiro'}
                <div style={{
                  position: 'absolute', bottom: -6, right: 20,
                  width: 12, height: 12, background: 'white',
                  transform: 'rotate(45deg)',
                  borderRight: '1px solid rgba(232, 98, 63, 0.3)',
                  borderBottom: '1px solid rgba(232, 98, 63, 0.3)',
                }}/>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Compact FAB — was a 56px tall pill with a pulsing halo and 32px
              icon, which the user flagged as "ocupando muito espaço". Now a
              ~36px slim pill with no halo, lighter shadow, smaller icon —
              still discoverable, no longer dominates the lower-right corner. */}
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.3, type: 'spring', stiffness: 260, damping: 20 }}
            onClick={openCompanion}
            aria-label={t.companion_fab_hint ?? 'Companion chat'}
            style={{
              position: 'relative',
              display: 'flex', alignItems: 'center', gap: 6,
              height: 36, padding: '0 12px 0 9px',
              borderRadius: 999, border: 'none', cursor: 'pointer',
              background: 'linear-gradient(135deg, #E8623F 0%, #F08869 100%)',
              color: 'white',
              boxShadow: '0 3px 10px rgba(232, 98, 63, 0.35)',
              fontSize: 12, fontWeight: 700, letterSpacing: 0.2,
            }}
          >
            <span style={{
              width: 22, height: 22, borderRadius: '50%',
              background: 'rgba(255,255,255,0.22)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13,
            }}>🎉</span>
            {t.companion_fab_label ?? 'Companheiro'}
          </motion.button>
        </div>
      )}

      <CompanionChat open={companionOpen} onClose={() => setCompanionOpen(false)} />
      <SyncStatus lang={state.language} />
      <BadgeUnlockToast />
    </div>
  )
}
