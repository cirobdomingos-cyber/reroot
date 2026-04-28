/**
 * usePushNotifications — Web Push subscription hook
 *
 * Handles the full subscribe flow:
 *   1. Fetch VAPID public key from the backend
 *   2. Request Notification permission from the browser
 *   3. Subscribe via pushManager (creates a PushSubscription)
 *   4. POST the subscription to /push/subscribe on our backend
 *
 * The backend stores subscriptions in SQLite and delivers pushes via
 * pywebpush when /push/send-weekly is called (e.g. by a weekly cron job).
 *
 * Portfolio note: Web Push uses VAPID (Voluntary Application Server Identification)
 * to authenticate push messages — interviewers ask about this when discussing
 * "how do you send push without Firebase?". Answer: VAPID + browser push service.
 */
import { useCallback, useState } from 'react'
import { useApp } from '../context/AppContext'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

// urlBase64ToUint8Array converts the VAPID public key from the URL-safe base64
// format the backend sends to the Uint8Array that pushManager.subscribe() requires.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export function usePushNotifications() {
  const { state, dispatch } = useApp()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const subscribe = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Step 1: browser must support service workers and push
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Web Push não suportado neste navegador.')
      }

      // Step 2: request notification permission
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        dispatch({ type: 'SET_PUSH_DISMISSED' })
        return false
      }

      // Step 3: fetch VAPID public key from backend
      const keyRes = await fetch(`${API_BASE}/push/vapid-public-key`)
      if (!keyRes.ok) throw new Error('Falha ao obter chave VAPID do servidor.')
      const { publicKey } = await keyRes.json()

      // Step 4: wait for the service worker to be ready (VitePWA registers it)
      const registration = await navigator.serviceWorker.ready

      // Step 5: subscribe via push manager
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,                              // required — must show notification on push
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })

      // Step 6: send subscription to our backend for storage. We pass the
      // google_id so the backend can target this user specifically (group
      // event added, friend confirmed, etc.) — anonymous subs only get
      // the weekly broadcast.
      const subJson = subscription.toJSON()
      const res = await fetch(`${API_BASE}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,  // { p256dh, auth }
          google_id: state.googleUser?.id || '',
        }),
      })
      if (!res.ok) throw new Error('Falha ao registrar subscription no servidor.')

      dispatch({ type: 'SET_PUSH_OPTED_IN' })
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setLoading(false)
    }
  }, [dispatch, state.googleUser?.id])

  const dismiss = useCallback(() => {
    dispatch({ type: 'SET_PUSH_DISMISSED' })
  }, [dispatch])

  return { subscribe, dismiss, loading, error }
}
