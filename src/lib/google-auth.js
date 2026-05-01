// ── Google Sign-In helper ──────────────────────────────────
// Two implementations, switched at runtime:
//
//   WEB    — Google Identity Services (GSI), client-side OAuth2 token flow
//            with prompt='select_account' so the account picker always shows.
//            The library is loaded in index.html via <script src="...gsi/client" async>.
//
//   NATIVE — Custom OAuth 2.0 + PKCE flow using @capacitor/browser
//            (SFSafariViewController on iOS) + @capacitor/app deep link
//            listener. Required because Google blocks embedded webview OAuth
//            as of 2021 — GSI inside Capacitor's WKWebView silently fails.
//            We can't use community Google-Auth plugins because they all
//            require CocoaPods, and this project is Capacitor 8 SPM-only.
//
// Both branches end up calling onSuccess({id, name, givenName, email, picture})
// with the same shape, so callers never need to know which platform is active.
//
// Build-time env vars:
//   VITE_GOOGLE_CLIENT_ID — web OAuth client ID (used by GSI on web)
//
// The iOS OAuth client ID and reversed-client-ID redirect URI are hardcoded
// below — they're non-secret (the URL scheme is already in Info.plist).

import { Capacitor } from '@capacitor/core'

// iOS OAuth client ID + reversed-client-ID redirect URI. The URL scheme
// suffix `:/oauth2redirect/google` is what Google's iOS OAuth flow expects.
// Both registered at console.cloud.google.com under Bundle ID `app.aue`.
const IOS_CLIENT_ID =
  '511485926685-irun1c38rluvso37l9lqhbh03e35gms5.apps.googleusercontent.com'
const IOS_REDIRECT_URI =
  'com.googleusercontent.apps.511485926685-irun1c38rluvso37l9lqhbh03e35gms5:/oauth2redirect/google'

export function isGoogleConfigured() {
  // On native (iOS/Android), config lives in this file (IOS_CLIENT_ID etc.)
  // — assume the build pipeline has the URL scheme wired in Info.plist.
  if (Capacitor.isNativePlatform?.()) return true
  // On web, the env var is the source of truth for whether OAuth is set up.
  return !!import.meta.env.VITE_GOOGLE_CLIENT_ID
}

// Demo user returned when no Client ID is configured
export const MOCK_GOOGLE_USER = {
  id: 'mock_google_user',
  name: 'Ciro Domingos',
  givenName: 'Ciro',
  email: 'ciro.b.domingos@gmail.com',
  picture: 'https://ui-avatars.com/api/?name=Ciro+Domingos&background=E8623F&color=fff&size=128&rounded=true',
}

/**
 * Parse the credential JWT returned by Google (only used by the legacy ID
 * token path; new OAuth2 flow gets userinfo via REST instead).
 */
export function parseGoogleCredential(credential) {
  try {
    const payload = credential.split('.')[1]
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const data = JSON.parse(atob(padded))
    return {
      id: data.sub,
      name: data.name,
      givenName: data.given_name,
      email: data.email,
      picture: data.picture,
    }
  } catch {
    return null
  }
}

/**
 * Mount a "Continue with Google" button that signs in via the right path
 * for the current platform. Returns a cleanup function (clears any pending
 * polls; safe to call even on native where there's nothing to clean up).
 */
export function mountGoogleButton(containerRef, onSuccess) {
  const isNative = Capacitor.isNativePlatform?.() ?? false
  return isNative
    ? mountNativeGoogleButton(containerRef, onSuccess)
    : mountWebGoogleButton(containerRef, onSuccess)
}

// ── Native (iOS) ──────────────────────────────────────────
// PKCE flow: generate verifier + challenge, open SFSafariViewController to
// Google's auth URL, listen for the deep-link redirect, exchange the code
// for an access token, fetch userinfo. iOS public OAuth clients don't need
// a client secret.
function mountNativeGoogleButton(containerRef, onSuccess) {
  if (!containerRef.current) return () => {}

  renderCustomButton(containerRef.current, async () => {
    try {
      const user = await signInWithGoogleNative()
      onSuccess(user)
    } catch (err) {
      // Show user-visible feedback — there's no console on iOS for non-Mac users.
      const msg = err?.message || String(err)
      alert(`Login com Google falhou: ${msg}`)
    }
  })

  return () => {}
}

async function signInWithGoogleNative() {
  const { App } = await import('@capacitor/app')
  const { Browser } = await import('@capacitor/browser')

  const verifier = generateCodeVerifier()
  const challenge = await sha256Base64Url(verifier)

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', IOS_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', IOS_REDIRECT_URI)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'openid profile email')
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('prompt', 'select_account')

  // Set up the deep-link listener BEFORE opening the browser, then await a
  // promise that resolves when the redirect URL fires. 60s timeout in case
  // the user just stares at the auth screen.
  const code = await new Promise((resolve, reject) => {
    let listenerHandlePromise = null
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('OAuth timeout (60s)'))
    }, 60000)

    const cleanup = () => {
      clearTimeout(timer)
      listenerHandlePromise?.then((h) => h.remove?.()).catch(() => {})
    }

    listenerHandlePromise = App.addListener('appUrlOpen', (event) => {
      const url = event?.url || ''
      if (!url.startsWith('com.googleusercontent.apps.')) return // not ours
      try {
        // Apple's URL parser doesn't love custom schemes — strip the scheme
        // before constructing a URL so searchParams works reliably.
        const query = url.split('?')[1] || ''
        const params = new URLSearchParams(query)
        const c = params.get('code')
        const e = params.get('error')
        cleanup()
        if (e) reject(new Error(`Google rejected: ${e}`))
        else if (c) resolve(c)
        else reject(new Error('Redirect had no code'))
      } catch (err) {
        cleanup()
        reject(err)
      }
    })

    Browser.open({ url: authUrl.toString() }).catch((err) => {
      cleanup()
      reject(err)
    })
  })

  // Close the in-app browser if iOS didn't auto-dismiss it on the redirect.
  await Browser.close().catch(() => {})

  // Exchange code for token. iOS public clients don't need client_secret.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: IOS_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: IOS_REDIRECT_URI,
    }).toString(),
  })
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    throw new Error(`Token exchange ${tokenRes.status}: ${body.slice(0, 120)}`)
  }
  const tokens = await tokenRes.json()

  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  if (!userRes.ok) throw new Error(`userinfo ${userRes.status}`)
  const data = await userRes.json()

  return {
    id: data.sub,
    name: data.name,
    givenName: data.given_name,
    email: data.email,
    picture: data.picture,
  }
}

// ── PKCE helpers ──────────────────────────────────────────
function generateCodeVerifier() {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return base64UrlEncode(arr)
}

async function sha256Base64Url(text) {
  const data = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(hash))
}

function base64UrlEncode(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Web (browser PWA) ─────────────────────────────────────
// Why we do NOT use accounts.id.renderButton + ID token:
// On modern Chrome / Edge / Opera, that path uses FedCM which auto-selects
// the only signed-in Google account WITHOUT showing a picker. Users on a
// shared machine or testing with a second account couldn't switch accounts
// without juggling browser profiles. The OAuth2 token flow with explicit
// prompt='select_account' is the documented escape hatch.
function mountWebGoogleButton(containerRef, onSuccess) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  if (!clientId) return () => {}

  let tokenClient = null
  let attempts = 0
  const poll = setInterval(() => {
    attempts++
    if (attempts > 20) { clearInterval(poll); return }
    if (!window.google?.accounts?.oauth2) return
    clearInterval(poll)

    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'openid profile email',
      prompt: 'select_account',
      callback: async (response) => {
        if (!response?.access_token) return
        try {
          const r = await fetch(
            'https://www.googleapis.com/oauth2/v3/userinfo',
            { headers: { Authorization: `Bearer ${response.access_token}` } },
          )
          if (!r.ok) return
          const data = await r.json()
          onSuccess({
            id: data.sub,
            name: data.name,
            givenName: data.given_name,
            email: data.email,
            picture: data.picture,
          })
        } catch (err) {
          console.warn('Google sign-in: userinfo fetch failed', err)
        }
      },
    })

    if (containerRef.current) {
      renderCustomButton(containerRef.current, () => {
        tokenClient.requestAccessToken()
      })
    }
  }, 300)

  return () => clearInterval(poll)
}

/**
 * Render a "Continue with Google" button matching Google brand guidelines
 * (white bg, official 4-color G logo, Roboto-ish text). Replaces the
 * container's children.
 */
function renderCustomButton(container, onClick) {
  container.innerHTML = ''
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Continuar com Google')
  Object.assign(btn.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    width: '100%',
    minHeight: '44px',
    padding: '10px 18px',
    border: '1px solid #DADCE0',
    borderRadius: '999px',
    background: 'white',
    color: '#3C4043',
    fontFamily: '"Roboto", system-ui, -apple-system, sans-serif',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'box-shadow 0.15s, background 0.15s',
  })

  // Official Google G logo (4-color, public from Google branding kit)
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
      <path d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
    <span>Continuar com Google</span>
  `

  btn.addEventListener('click', onClick)
  btn.addEventListener('mouseenter', () => {
    btn.style.boxShadow = '0 1px 2px 0 rgba(60,64,67,0.30), 0 1px 3px 1px rgba(60,64,67,0.15)'
    btn.style.background = '#F8F9FA'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.boxShadow = 'none'
    btn.style.background = 'white'
  })

  container.appendChild(btn)
}
