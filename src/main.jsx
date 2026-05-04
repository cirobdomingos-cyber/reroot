import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { AppProvider } from './context/AppContext'
import { reportError } from './services/api'
import App from './App'
import './styles/globals.css'

// ── iOS / Android Universal Link handler ──────────────────
// When iOS hands a tapped reroot-production.up.railway.app/... URL to the
// installed app (because the AASA file declares this domain belongs to
// app.aue), Capacitor fires an `appUrlOpen` event with the full URL.
// We extract the hash fragment and apply it to window.location so
// HashRouter picks up the deep route.
//
// Cold-launch case (app not running): iOS still fires appUrlOpen after the
// webview boots — handler sees it just like the warm case.
//
// OAuth callbacks (custom scheme com.googleusercontent.apps.*) are a
// different listener entirely (in google-auth.js); we skip them here so
// the universal link handler doesn't fight the auth flow.
if (Capacitor.isNativePlatform?.()) {
  import('@capacitor/app').then(({ App: CapApp }) => {
    CapApp.addListener('appUrlOpen', (event) => {
      const url = event?.url || ''
      if (!url || url.startsWith('com.googleusercontent.apps.')) return
      try {
        const parsed = new URL(url)
        // 1. Old-style hash links (#/events?event=...) — used directly.
        if (parsed.hash) {
          window.location.hash = parsed.hash
          return
        }
        // 2. Short-link path /e/<event_id> → expand to /#/events?event=<id>.
        //    Without this, Universal Links to short URLs open the app
        //    cold and just sit on the Home tab because the listener
        //    had nothing to forward.
        const shortMatch = parsed.pathname.match(/^\/e\/([^/?#]+)/)
        if (shortMatch) {
          const eventId = decodeURIComponent(shortMatch[1])
          window.location.hash = `#/events?event=${encodeURIComponent(eventId)}`
          return
        }
        // 3. Future short-paths could be added here. For everything
        //    else (bare landing, unknown path), stay on the current
        //    route — better than guessing wrong.
      } catch {
        // Unparseable — ignore. Better to land users on the home screen
        // than crash on a malformed deep link.
      }
    })

    // Clear iOS notification badge whenever the app comes to the
    // foreground (or launches from a tap on a notification). Each
    // APNs push we send carries badge:1 so the icon shows a dot —
    // but iOS doesn't auto-clear that count on app open. Without an
    // explicit reset the badge sticks at 1 forever even after the
    // user reads the notification.
    //
    // removeAllDeliveredNotifications also clears the in-tray
    // notifications — once the user has the app focused, those are
    // redundant noise.
    function clearBadge() {
      import('@capacitor/push-notifications').then(({ PushNotifications }) => {
        PushNotifications.removeAllDeliveredNotifications().catch(() => {})
      }).catch(() => {})
    }
    CapApp.addListener('appStateChange', (state) => {
      if (state?.isActive) clearBadge()
    })
    // Cold launch: appStateChange fires on background→foreground transitions
    // but not on the initial active state, so we also clear once on boot.
    clearBadge()
  })
}

// Global error handlers — catch uncaught JS errors in production
window.addEventListener('error', (event) => {
  reportError('js_uncaught', event.message, {
    filename: event.filename,
    line: event.lineno,
    col: event.colno,
  })
})
window.addEventListener('unhandledrejection', (event) => {
  reportError('js_unhandled_promise', String(event.reason).slice(0, 500))
})

// PWA install prompt capture — Chrome/Edge/Brave fire `beforeinstallprompt`
// when the app is installable. We stash the event so any component (e.g.
// the Share/Install section in Profile) can call `prompt()` later when
// the user opts in. iOS Safari never fires this — install is manual via
// Add to Home Screen.
window.__aueDeferredInstallPrompt = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  window.__aueDeferredInstallPrompt = e
  window.dispatchEvent(new CustomEvent('aue-install-available'))
})
window.addEventListener('appinstalled', () => {
  window.__aueDeferredInstallPrompt = null
  window.dispatchEvent(new CustomEvent('aue-install-installed'))
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </StrictMode>
)
