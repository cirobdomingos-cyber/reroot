// ── Google Sign-In helper ──────────────────────────────────
// Two implementations, switched at runtime:
//
//   WEB    — Google Identity Services (GSI), client-side OAuth2 token flow
//            with prompt='select_account' so the account picker always shows.
//            The library is loaded in index.html via <script src="...gsi/client" async>.
//
//   NATIVE — @codetrix-studio/capacitor-google-auth plugin invokes iOS's
//            native Google Sign-In SDK. Required because Google blocks
//            embedded webview OAuth as of 2021 — GSI inside Capacitor's
//            WKWebView silently fails (button does nothing).
//
// Both branches end up calling onSuccess({id, name, givenName, email, picture})
// with the same shape, so callers never need to know which platform is active.
//
// Build-time env vars:
//   VITE_GOOGLE_CLIENT_ID      — web OAuth client ID (used by GSI)
//   VITE_GOOGLE_IOS_CLIENT_ID  — iOS OAuth client ID (also in capacitor.config.json)
//
// MOCK mode: when VITE_GOOGLE_CLIENT_ID isn't set, the button renders but
// uses MOCK_GOOGLE_USER on click — handy for local dev without OAuth setup.

import { Capacitor } from '@capacitor/core'

export function isGoogleConfigured() {
  // On native (iOS/Android), config lives in capacitor.config.json — assume
  // the build pipeline already wired the iosClientId / androidClientId.
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

// ── Native (iOS / Android) ────────────────────────────────
// Plugin reads iosClientId from capacitor.config.json. We dynamically import
// the plugin so the web bundle doesn't pull it in (its web fallback uses an
// older `gapi` library that conflicts with our GSI setup).
function mountNativeGoogleButton(containerRef, onSuccess) {
  if (!containerRef.current) return () => {}

  renderCustomButton(containerRef.current, async () => {
    try {
      const { GoogleAuth } = await import('@codetrix-studio/capacitor-google-auth')
      const result = await GoogleAuth.signIn()
      onSuccess({
        id: result.id,
        name: result.name,
        givenName: result.givenName,
        email: result.email,
        picture: result.imageUrl,
      })
    } catch (err) {
      console.warn('Google sign-in (native) failed:', err)
    }
  })

  return () => {}
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
