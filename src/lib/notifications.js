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

function tomorrowAt8am() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d
}

function nextSundayAt18() {
  const d = new Date()
  const daysUntil = (7 - d.getDay()) % 7 || 7
  d.setDate(d.getDate() + daysUntil)
  d.setHours(18, 0, 0, 0)
  return d
}

// ── Public API ─────────────────────────────────────────────

/**
 * Called when user RSVPs to an event.
 * Native: schedules a local notification for tomorrow at 8am.
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
          title: '🌿 Você tem um evento amanhã!',
          body: `${event.name} · ${event.time}`,
          schedule: { at: tomorrowAt8am() },
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
    new Notification('🌿 Presença confirmada!', {
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

/**
 * Schedule weekly Sunday check-in notification (native only).
 * Safe to call multiple times — cancels the previous one first.
 */
export async function scheduleWeeklyCheckin() {
  const plugin = await getLocalNotifications()
  if (!plugin) return
  try {
    await plugin.cancel({ notifications: [{ id: 99_999 }] })
    await plugin.schedule({
      notifications: [{
        id: 99_999,
        title: '🌿 Como foi a semana?',
        body: 'Conta pra gente e já veja os eventos de amanhã.',
        schedule: { at: nextSundayAt18(), every: 'week' },
        smallIcon: 'ic_stat_icon_config_sample',
      }],
    })
  } catch {}
}

/**
 * Schedule a post-event "reconnect" notification.
 * Fires 3 hours after the event start time on native.
 * No-op on web — the in-app reconnect card in Home.jsx handles that surface.
 */
export async function schedulePostEventNotification(event) {
  const plugin = await getLocalNotifications()
  if (!plugin) return
  try {
    const { display } = await plugin.checkPermissions()
    if (display !== 'granted') return

    // Calculate notification time: event dateStart + 3h (fall back to time field, then +3h from now)
    let at
    if (event.dateStart) {
      at = new Date(new Date(event.dateStart).getTime() + 3 * 60 * 60 * 1000)
    } else if (event.time) {
      const match = event.time.match(/(\d{1,2}):(\d{2})/)
      if (match) {
        at = new Date()
        at.setHours(parseInt(match[1], 10) + 3, parseInt(match[2], 10), 0, 0)
        if (at < new Date()) at = new Date(Date.now() + 3 * 60 * 60 * 1000)
      } else {
        at = new Date(Date.now() + 3 * 60 * 60 * 1000)
      }
    } else {
      at = new Date(Date.now() + 3 * 60 * 60 * 1000)
    }

    await plugin.schedule({
      notifications: [{
        id: strHash(event.id + '_post'),
        title: '🤝 Você conheceu alguém hoje?',
        body: `${event.name} — veja quem esteve lá e conecte-se.`,
        schedule: { at },
        smallIcon: 'ic_stat_icon_config_sample',
      }],
    })
  } catch {}
}
