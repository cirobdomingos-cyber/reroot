/**
 * Apple Sign-In helper — dual-channel (Capacitor native + web JS SDK).
 *
 * Mirrors the shape of lib/google-auth.js so AppContext can store the
 * resulting user under state.googleUser without any provider-aware
 * branching (the field name is legacy; functionally it now holds
 * "the canonical authenticated user, whoever the provider was").
 *
 * Native flow (iOS Capacitor):
 *   1. SignInWithApple.authorize(options)
 *   2. Apple presents the system sheet (FaceID / passcode)
 *   3. Result includes identityToken (JWT) + first-time-only name +
 *      email (might be relay)
 *   4. POST identityToken + name to /auth/apple → backend verifies and
 *      returns canonical user_id + persisted profile
 *
 * Web flow (browser):
 *   1. AppleID.auth.init({ clientId: serviceId, ... })  — once, per-tab
 *   2. AppleID.auth.signIn() opens the popup → user approves
 *   3. response.authorization.id_token + response.user (first-auth only)
 *   4. POST to /auth/apple
 *
 * The Apple JS SDK is loaded lazily via a <script> injection so we
 * don't pay the script cost for users who never tap the button.
 */
import { Capacitor } from '@capacitor/core'

const API_BASE = import.meta.env.VITE_API_URL ?? ''
const IS_NATIVE = typeof window !== 'undefined' && Capacitor.isNativePlatform()

// Bundle id (native) and Service ID (web) match what the backend's
// _apple_audiences() returns for `aud` validation. The web Service ID
// must be configured on the Apple Developer portal as a Sign in with
// Apple service tied to the app.aue App ID, with redirect URI pointing
// to our domain.
const NATIVE_CLIENT_ID = 'app.aue'
const WEB_SERVICE_ID = import.meta.env.VITE_APPLE_WEB_SERVICE_ID || ''
const WEB_REDIRECT_URI = import.meta.env.VITE_APPLE_WEB_REDIRECT_URI ||
  (typeof window !== 'undefined' ? `${window.location.origin}/` : '')


// ── Native (Capacitor) ────────────────────────────────────

async function signInNative() {
  const { SignInWithApple } = await import('@capacitor-community/apple-sign-in')
  const result = await SignInWithApple.authorize({
    clientId: NATIVE_CLIENT_ID,
    redirectURI: '',  // unused for native flow but field is required
    scopes: 'email name',
    state: '',
    nonce: '',
  })
  // Plugin v7 returns { response: { identityToken, givenName, familyName, ... } }
  // Older versions used .identityToken at top level — handle both for safety.
  const r = result?.response || result || {}
  return {
    identityToken: r.identityToken || '',
    givenName: r.givenName || '',
    familyName: r.familyName || '',
    email: r.email || '',
  }
}


// ── Web (Apple JS SDK) ────────────────────────────────────

let _appleSdkLoading = null

function loadAppleSdk() {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'))
  if (window.AppleID?.auth) return Promise.resolve()
  if (_appleSdkLoading) return _appleSdkLoading
  _appleSdkLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Falha ao carregar Apple Sign-In SDK'))
    document.head.appendChild(s)
  })
  return _appleSdkLoading
}

async function signInWeb() {
  if (!WEB_SERVICE_ID) {
    throw new Error('Apple Sign-In na web não configurado (VITE_APPLE_WEB_SERVICE_ID).')
  }
  await loadAppleSdk()
  // Init is idempotent — calling twice is harmless. Apple's SDK keeps
  // state per-tab anyway.
  window.AppleID.auth.init({
    clientId: WEB_SERVICE_ID,
    scope: 'name email',
    redirectURI: WEB_REDIRECT_URI,
    usePopup: true,
  })
  const response = await window.AppleID.auth.signIn()
  // response.authorization.id_token is the JWT we forward.
  // response.user is present ONLY on first sign-in: { name: { firstName, lastName }, email }
  const idToken = response?.authorization?.id_token || ''
  const u = response?.user || {}
  return {
    identityToken: idToken,
    givenName: u?.name?.firstName || '',
    familyName: u?.name?.lastName || '',
    email: u?.email || '',
  }
}


// ── Public entrypoint ─────────────────────────────────────

/**
 * Run the full Apple Sign-In flow on the current platform.
 * Returns the canonical user shape AppContext stores in state.googleUser:
 *   { id, email, name, givenName, familyName, picture: '' }
 *
 * Throws on any failure with a Portuguese message safe to show in UI.
 */
export async function signInWithApple() {
  let appleResult
  try {
    appleResult = IS_NATIVE ? await signInNative() : await signInWeb()
  } catch (err) {
    // Apple's SDK throws { error: 'popup_closed_by_user' } on cancel —
    // bubble up a clean message instead of "[object Object]".
    const code = err?.error || err?.code
    if (code === 'popup_closed_by_user' || code === '1001' /* native cancel */) {
      throw new Error('Login cancelado.')
    }
    throw new Error(err?.message || 'Falha no Sign in with Apple.')
  }
  if (!appleResult.identityToken) {
    throw new Error('Apple não retornou identityToken.')
  }

  // Send to our backend for verification + user resolution.
  const res = await fetch(`${API_BASE}/auth/apple`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identity_token: appleResult.identityToken,
      given_name: appleResult.givenName,
      family_name: appleResult.familyName,
    }),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.json())?.detail || '' } catch {}
    throw new Error(detail || `Erro do servidor (${res.status})`)
  }
  const data = await res.json()

  // Normalize into the same shape the rest of the app expects from a
  // "googleUser" — the field is legacy, the contract isn't.
  const fullName = (data.display_name || appleResult.givenName ||
                    [appleResult.givenName, appleResult.familyName].filter(Boolean).join(' ')).trim()
  return {
    id: data.user_id,
    email: data.email || '',
    name: fullName,
    givenName: appleResult.givenName || fullName.split(' ')[0] || '',
    familyName: appleResult.familyName || '',
    picture: data.picture || '',
    isNewUser: !!data.is_new_user,
    provider: 'apple',
  }
}
