/**
 * usePushNotifications — Web Push subscription hook (PWA / browser only).
 *
 * The full subscribe flow:
 *   1. Fetch VAPID public key from the backend
 *   2. Request browser Notification permission
 *   3. Subscribe via pushManager → creates a PushSubscription
 *   4. POST it to /push/subscribe so the backend can reach this device
 *
 * The backend stores subscriptions in SQLite and delivers pushes via
 * pywebpush from `_send_push_to_user` (per-user) or
 * `send_daily_digest_to_all_subscribers` (broadcast). The custom Service
 * Worker in src/sw.js handles `push` and `notificationclick` events.
 *
 * iOS Capacitor wrappers do NOT use this hook — Web Push doesn't work
 * inside capacitor:// scheme. Native iOS/Android push will plug in via
 * `@capacitor/push-notifications` later, with its own subscribe flow.
 */
import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../context/AppContext'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

// VAPID public key arrives URL-safe base64 from the backend; pushManager.subscribe()
// needs it as a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

// Capability detection that survives both real browsers and Capacitor wrappers.
// The wrapper has a service worker scope but pushManager throws on subscribe;
// safest to just gate on the public APIs being present.
export function isPushSupported() {
  if (typeof window === 'undefined') return false
  return 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

export function usePushNotifications() {
  const { state, dispatch } = useApp()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // Whether THIS device already has an active subscription. Browser perm
  // alone isn't enough (perm could be granted but the subscription got
  // dropped server-side or the user used a fresh device).
  const [subscribed, setSubscribed] = useState(false)

  // On mount, ask the SW if it already has a subscription on this device.
  useEffect(() => {
    if (!isPushSupported()) return
    let cancelled = false
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => { if (!cancelled) setSubscribed(!!sub) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const subscribe = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!isPushSupported()) {
        throw new Error('Web Push não suportado neste navegador.')
      }

      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        dispatch({ type: 'SET_PUSH_DISMISSED' })
        return false
      }

      const keyRes = await fetch(`${API_BASE}/push/vapid-public-key`)
      if (!keyRes.ok) throw new Error('Falha ao obter chave VAPID do servidor.')
      const { publicKey } = await keyRes.json()
      if (!publicKey) {
        throw new Error('Servidor não tem VAPID configurado. Configure VAPID_PRIVATE_KEY/VAPID_PUBLIC_KEY no backend.')
      }
      // VAPID public keys are uncompressed P-256 points (65 bytes). In
      // url-safe base64 without padding that's exactly 87 chars. The
      // historical hardcoded placeholder was 85 chars (malformed) and
      // would crash atob with a cryptic "string is not correctly
      // encoded" error. Catch that here with a helpful message.
      const trimmed = String(publicKey).trim()
      if (trimmed.length !== 87 || (trimmed.length % 4) === 1) {
        throw new Error(
          `VAPID key do servidor é inválida (${trimmed.length} chars; deveria ter 87). ` +
          'Gere uma real com `py -m py_vapid --gen` e configure VAPID_PUBLIC_KEY na Railway.'
        )
      }

      // Timeout on serviceWorker.ready — if VitePWA isn't registering the
      // SW (e.g. devOptions disabled, prod-only build), .ready hangs and
      // the UI sits in "...". 10s is generous; healthy installs resolve
      // in ms.
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Service Worker não foi registrado. Reinicie o dev server (Ctrl+C + npm run dev) ou rode em produção.')), 10000)
        ),
      ])
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })

      const subJson = subscription.toJSON()
      const res = await fetch(`${API_BASE}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
          google_id: state.googleUser?.id || '',
        }),
      })
      if (!res.ok) throw new Error('Falha ao registrar subscription no servidor.')

      dispatch({ type: 'SET_PUSH_OPTED_IN' })
      setSubscribed(true)
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setLoading(false)
    }
  }, [dispatch, state.googleUser?.id])

  const unsubscribe = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!isPushSupported()) return false
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await subscription.unsubscribe()
        // Best-effort backend cleanup — backend also self-prunes on
        // 410 Gone the next time it tries to send.
        try {
          await fetch(`${API_BASE}/push/subscribe`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          })
        } catch {}
      }
      dispatch({ type: 'SET_PUSH_DISMISSED' })
      setSubscribed(false)
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setLoading(false)
    }
  }, [dispatch])

  return { subscribed, subscribe, unsubscribe, loading, error }
}
