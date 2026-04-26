// ── Google Identity Services (GSI) helper ──────────────────
// No backend required — client-side only OAuth via Google's GSI library.
// The library is loaded in index.html via <script src="...gsi/client" async>.
//
// Two modes:
//   REAL  — VITE_GOOGLE_CLIENT_ID is set → custom button + OAuth2 token flow
//           with prompt='select_account' so the account picker always shows.
//   MOCK  — env var not set → renders a custom button with demo user data
//           so the full UI flow is always testable without Google Cloud setup.
//
// Why we do NOT use accounts.id.renderButton + ID token:
// On modern Chrome / Edge / Opera, that path uses FedCM which auto-selects
// the only signed-in Google account WITHOUT showing a picker. Users on a
// shared machine or testing with a second account couldn't switch accounts
// without juggling browser profiles. The OAuth2 token flow with explicit
// prompt='select_account' is the documented escape hatch.

export function isGoogleConfigured() {
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
 * Mount a "Continue with Google" button that uses the OAuth2 token flow
 * (instead of the ID-token + FedCM path). Forces account picker every time.
 *
 * Polls until the GSI script is loaded (loaded async in index.html).
 * Only call when isGoogleConfigured() === true.
 * Returns a cleanup function.
 */
export function mountGoogleButton(containerRef, onSuccess) {
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
      // The whole point of this rewrite — show the account picker every
      // time, never silently sign in with the browser's default account.
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
