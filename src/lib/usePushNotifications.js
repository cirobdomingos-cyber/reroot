/**
 * usePushNotifications — Dual-channel push subscription hook.
 *
 * Detects the runtime and picks the right channel:
 *   - Browser / PWA (incl. iOS Safari "Add to Home Screen"): Web Push
 *     via VAPID + pushManager + custom Service Worker
 *   - Capacitor wrapper (iOS native via TestFlight/App Store): APNs via
 *     `@capacitor/push-notifications` plugin → device token → backend
 *
 * The Profile UI doesn't care which channel is in use — `subscribe()`
 * does the right thing. Backend `_send_push_to_user` and the daily
 * digest fan out to both channels per user (a user with both PWA on
 * laptop and TestFlight on iPhone gets pinged on both).
 *
 * Push payload shape stays identical across channels: {title, body,
 * url, tag}. The native side reads `url` from the data dict on tap and
 * navigates the SPA via the HashRouter, mirroring what the SW does.
 */
import { useCallback, useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useApp } from '../context/AppContext'

import { API_BASE } from './apiBase'
const IS_NATIVE = typeof window !== 'undefined' && Capacitor.isNativePlatform()

// VAPID public key arrives URL-safe base64 from the backend; pushManager.subscribe()
// needs it as a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

// Capability detection across both runtimes.
// - Native (Capacitor): always supported — the plugin is installed and
//   handles APNs registration. Permission is requested at subscribe time.
// - Browser: gate on Web Push APIs being present.
export function isPushSupported() {
  if (typeof window === 'undefined') return false
  if (IS_NATIVE) return true
  return 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

export function usePushNotifications() {
  const { state, dispatch } = useApp()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // Source of truth for "is this user subscribed" is state.pushOptedIn —
  // it persists across reloads, syncs across components (Home banner +
  // Profile toggle), and survives logins. We mirror it into a local
  // subscribed bool only because the browser SW path can detect a
  // pre-existing subscription on mount (e.g., user enabled push in a
  // previous session and we lost the AppContext flag somehow).
  const [localDetected, setLocalDetected] = useState(false)
  const subscribed = !!state.pushOptedIn || localDetected

  // Native APNs token, captured from the Capacitor plugin's `registration`
  // event so we can re-POST it on retries and DELETE it on unsubscribe.
  // null until the plugin emits, persists across hook re-renders.
  const [apnsToken, setApnsToken] = useState(null)

  // On mount, restore the existing subscription state for this device.
  // Native: no API to query "do we have a token?" — the plugin only fires
  // `registration` once after `register()`. So we treat it as unsubscribed
  // until the user explicitly re-subscribes; backend de-dups on token
  // upsert anyway. Browser: ask the SW.
  //
  // If the SW reports an active subscription but state.pushOptedIn is
  // false (e.g., state was reset on logout but the SW still holds the
  // sub), reconcile by dispatching SET_PUSH_OPTED_IN. Keeps the UI
  // honest about what the device actually has registered.
  useEffect(() => {
    if (!isPushSupported() || IS_NATIVE) return
    let cancelled = false
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => {
        if (cancelled) return
        if (sub) {
          setLocalDetected(true)
          if (!state.pushOptedIn) dispatch({ type: 'SET_PUSH_OPTED_IN' })
        } else {
          setLocalDetected(false)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Returns true on success, the string 'denied' when the user (or a past
  // session) explicitly refused the permission prompt, or false for any
  // other failure — network, misconfigured VAPID key, SW timeout, server
  // error. Callers that permanently stop asking on failure (the Home
  // banner) MUST only do that for 'denied' — a transient false is worth
  // retrying next session, and used to get treated identically to a real
  // no, which is most of why so few of our accounts have push enabled.
  const subscribe = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!isPushSupported()) {
        throw new Error('Push não suportado nesse ambiente.')
      }

      // ── Native (iOS Capacitor) channel ────────────────────────
      if (IS_NATIVE) {
        const { PushNotifications } = await import('@capacitor/push-notifications')
        // Permission first — APNs returns "granted" on iOS only after
        // the user accepts the system prompt. 'denied' is an explicit
        // no; anything else ('prompt', 'prompt-with-rationale') means no
        // decision was made and the ask is worth repeating — see the
        // 'denied' sentinel return below.
        const permResult = await PushNotifications.requestPermissions()
        if (permResult.receive !== 'granted') {
          if (permResult.receive === 'denied') dispatch({ type: 'SET_PUSH_DISMISSED' })
          return permResult.receive === 'denied' ? 'denied' : false
        }

        // Listen for the registration event before calling register() —
        // the event fires fast and we'd miss it otherwise.
        const tokenPromise = new Promise((resolve, reject) => {
          let regHandle, errHandle
          PushNotifications.addListener('registration', token => {
            regHandle?.remove?.()
            errHandle?.remove?.()
            resolve(token.value)
          }).then(h => { regHandle = h })
          PushNotifications.addListener('registrationError', err => {
            regHandle?.remove?.()
            errHandle?.remove?.()
            reject(new Error(`APNs registration falhou: ${err?.error || 'unknown'}`))
          }).then(h => { errHandle = h })
          // Safety timeout — APNs registration usually completes in <1s.
          setTimeout(() => reject(new Error('APNs registration timeout (15s).')), 15_000)
        })

        await PushNotifications.register()
        const token = await tokenPromise

        // Forward the token to the backend so the digest fanout can
        // reach this device. Bundle id matches capacitor.config.json
        // appId — backend uses it for cross-app safety on multi-tenant
        // sends (currently we only have one app, but the field future-
        // proofs the schema).
        const res = await fetch(`${API_BASE}/push/register-device-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            google_id: state.googleUser?.id || '',
            bundle_id: 'app.aue',
            // production = TestFlight + App Store. The aps-environment
            // entitlement value we ship with (production) only routes
            // there; sandbox is for Xcode-built debug installs.
            env: 'production',
          }),
        })
        if (!res.ok) throw new Error('Falha ao registrar token no servidor.')

        // Tap handling is NOT wired here any more. It used to be — which
        // meant the listener only existed in the session where the user
        // opted in, since the plugin keeps listeners per app process and
        // nothing calls subscribe() on a normal launch. Every later tap
        // opened the default screen. It now registers at app start; see
        // lib/pushNavigation.js.
        setApnsToken(token)
        dispatch({ type: 'SET_PUSH_OPTED_IN' })
        setLocalDetected(true)
        return true
      }

      // ── Web (browser/PWA) channel ────────────────────────────
      // 'denied' is an explicit no. 'default' means the prompt was
      // dismissed without a choice (e.g. the user navigated away) — not
      // a no, so callers shouldn't treat it as one. See the 'denied'
      // sentinel return below.
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        if (permission === 'denied') dispatch({ type: 'SET_PUSH_DISMISSED' })
        return permission === 'denied' ? 'denied' : false
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
      setLocalDetected(true)
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

      // ── Native (iOS Capacitor) ──
      if (IS_NATIVE) {
        if (apnsToken) {
          try {
            await fetch(`${API_BASE}/push/register-device-token`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: apnsToken }),
            })
          } catch {}
          setApnsToken(null)
        }
        dispatch({ type: 'SET_PUSH_OPTED_OUT' })
        setLocalDetected(false)
        return true
      }

      // ── Web ──
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
      dispatch({ type: 'SET_PUSH_OPTED_OUT' })
      setLocalDetected(false)
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setLoading(false)
    }
  }, [dispatch, apnsToken])

  return { subscribed, subscribe, unsubscribe, loading, error }
}
