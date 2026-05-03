// ── auê Notifications ────────────────────────────────────
// Abstracts over:
//   - @capacitor/local-notifications (native Android/iOS)
//   - browser Notification API (web/PWA fallback)
// Usage: scheduleEventReminder(event) after RSVP

import { Capacitor } from '@capacitor/core'

async function getLocalNotifications() {
  if (!Capacitor.isNativePlatform()) return null
  try {
    const mod = await import(/* @vite-ignore */ '@capacitor/local-notifications')
    return mod.LocalNotifications
  } catch {
    return null
  }
}

// Deterministic integer ID from a string (needed for Capacitor cancel)
function strHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return Math.abs(h) % 2_147_483_647
}

function tomorrowAt10am() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(10, 0, 0, 0)
  return d
}

// ── Public API ─────────────────────────────────────────────

/**
 * Called when user RSVPs to an event.
 * Native: schedules a local notification for tomorrow at 10am (user-friendly
 *   wake time — 8am pinged people too early per founder feedback).
 * Web: shows an immediate browser notification as confirmation.
 * Returns true if notification was delivered/scheduled.
 */
export async function scheduleEventReminder(event) {
  const plugin = await getLocalNotifications()

  if (plugin) {
    try {
      const { display } = await plugin.checkPermissions()
      if (display !== 'granted') {
        const { display: d } = await plugin.requestPermissions()
        if (d !== 'granted') return false
      }
      await plugin.schedule({
        notifications: [{
          id: strHash(event.id),
          title: '🗓 Tem auê amanhã!',
          body: `${event.name} · ${event.time}`,
          schedule: { at: tomorrowAt10am() },
          smallIcon: 'ic_stat_icon_config_sample',
        }],
      })
      return true
    } catch {
      return false
    }
  }

  // Web fallback: immediate confirmation notification
  if (!('Notification' in window)) return false
  if (Notification.permission === 'denied') return false

  const perm = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission()

  if (perm === 'granted') {
    new Notification('🎉 Confirmado!', {
      body: `${event.name} · ${event.date} às ${event.time}`,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    })
    return true
  }
  return false
}

/**
 * Cancel a previously scheduled event reminder.
 * No-op on web (immediate notifications can't be cancelled).
 */
export async function cancelEventReminder(eventId) {
  const plugin = await getLocalNotifications()
  if (!plugin) return
  try {
    await plugin.cancel({ notifications: [{ id: strHash(eventId) }] })
  } catch {}
}
