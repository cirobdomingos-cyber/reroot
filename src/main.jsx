import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { AppProvider } from './context/AppContext'
import { reportError } from './services/api'
import { initPushNavigation } from './lib/pushNavigation'
import App from './App'
import './styles/globals.css'

// ── iOS / Android Universal Link handler ──────────────────
// When iOS hands a tapped auecuritiba.com/... URL to the installed app
// (because App.entitlements lists the domain and the AASA file served
// there declares it belongs to app.aue), Capacitor fires an `appUrlOpen`
// event with the full URL.
//
// The handler below never looks at the host — it reads the hash and the
// path — so it works for any domain the entitlement happens to list.
// We extract the hash fragment and apply it to window.location so
// HashRouter picks up the deep route.
//
// Cold-launch case (app not running): iOS still fires appUrlOpen after the
// webview boots — handler sees it just like the warm case.
//
// OAuth callbacks (custom scheme com.googleusercontent.apps.*) are a
// different listener entirely (in google-auth.js); we skip them here so
// the universal link handler doesn't fight the auth flow.
// ── Live updates (Capgo) — MUST confirm the bundle booted ─────────────
// The updater treats a bundle as failed unless notifyAppReady() runs
// within appReadyTimeout, and rolls back to the previous one. That is the
// safety net that makes shipping JS outside App Review sane: a bundle
// that white-screens gets reverted on its own instead of bricking the app
// for everyone until a new build clears review.
//
// It follows that this call must be as close to unconditional as
// possible. It sits before the deep-link wiring (which lazy-imports and
// could plausibly throw) and inside its own try/catch, so no later
// failure can stop the bundle being marked healthy. On web the import
// resolves to a no-op shim, hence the native guard.
if (Capacitor.isNativePlatform?.()) {
  import('@capgo/capacitor-updater')
    .then(({ CapacitorUpdater }) => CapacitorUpdater.notifyAppReady())
    .catch((err) => {
      // Losing the confirmation means this bundle gets rolled back on the
      // next launch. Noisy on purpose — silent rollback loops are miserable
      // to diagnose from a user saying "it went back to the old version".
      console.error('CapacitorUpdater.notifyAppReady failed', err)
    })
}

// Notification taps → routes. Registered here, at module load, because
// iOS delivers the tap right after launch and the listener has to exist
// already. It used to be wired inside the push opt-in flow, so it was
// missing on every launch after the one where permission was granted —
// which is why tapping "✨ N novos em CWB" opened the default screen
// instead of the digest. Sits after notifyAppReady so nothing here can
// delay the bundle being marked healthy.
initPushNavigation()

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

// Reads googleUser straight from localStorage rather than AppContext —
// these listeners fire outside React (and can fire before AppProvider
// has mounted), so there's no hook to call here. Best-effort: a parse
// failure or missing user just means the report goes in anonymous.
function currentGoogleId() {
  try {
    const raw = localStorage.getItem('aue_state')
    return raw ? (JSON.parse(raw)?.googleUser?.id || '') : ''
  } catch {
    return ''
  }
}

// Global error handlers — catch uncaught JS errors in production. url and
// stack ride along in `context` so the founder-only /admin/client-errors
// panel can show where an error happened, not just its message — without
// them, every report from every screen collapses into one anonymous line.
window.addEventListener('error', (event) => {
  reportError('js_uncaught', event.message, {
    filename: event.filename,
    line: event.lineno,
    col: event.colno,
    url: window.location.href,
    stack: event.error?.stack || '',
  }, currentGoogleId())
})
window.addEventListener('unhandledrejection', (event) => {
  reportError('js_unhandled_promise', String(event.reason).slice(0, 500), {
    url: window.location.href,
    stack: event.reason?.stack || '',
  }, currentGoogleId())
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
