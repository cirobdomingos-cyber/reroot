/**
 * Push taps → routes.
 *
 * The native tap handler used to be registered inside subscribe() in
 * usePushNotifications — so it existed only in the session where the user
 * opted in. The plugin keeps listeners for the lifetime of the app
 * *process*, and nothing calls subscribe() on a normal launch, so every
 * later notification tap arrived with nobody listening and iOS opened the
 * app on its default screen. The daily digest ("✨ N novos em CWB")
 * carried `/#/events?digest=<id>` the whole time; it was simply dropped.
 *
 * Registered from main.jsx at module load — the earliest our JS runs,
 * which matters because iOS delivers the tap immediately after launch.
 */
import { Capacitor } from '@capacitor/core'

/** Point the app at a push's url. Safe before the router has mounted:
 *  HashRouter reads location.hash when it boots. */
export function applyPushUrl(target) {
  if (!target || typeof target !== 'string') return false
  try {
    const hashIndex = target.indexOf('#')
    if (hashIndex < 0) {
      window.location.assign(target)
      return true
    }
    const hash = target.slice(hashIndex) // '#/events?digest=d_123'
    if (window.location.hash === hash) {
      // Already there (second tap on the same digest): the router won't
      // re-run its effect on an identical hash, so nudge it.
      window.dispatchEvent(new Event('hashchange'))
    } else {
      window.location.hash = hash
    }
    return true
  } catch {
    return false
  }
}

let started = false

export function initPushNavigation() {
  if (started || typeof window === 'undefined') return
  started = true

  // Web/PWA: a service worker can't reliably navigate an already-open
  // window, so it hands the target back to the page instead (see sw.js).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'push-navigate') applyPushUrl(event.data.url)
    })
  }

  if (!Capacitor.isNativePlatform?.()) return
  import('@capacitor/push-notifications')
    .then(({ PushNotifications }) => {
      PushNotifications.addListener('pushNotificationActionPerformed', action => {
        applyPushUrl(action?.notification?.data?.url)
      })
    })
    .catch(() => {
      // Plugin missing (web build running in a native shell, etc.) — the
      // app still works, taps just open the default screen.
    })
}
