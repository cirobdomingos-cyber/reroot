// ── Google Identity Services (GSI) helper ──────────────────
// No backend required — client-side only OAuth via Google's GSI library.
// The library is loaded in index.html via <script src="...gsi/client" async>.
//
// Two modes:
//   REAL  — VITE_GOOGLE_CLIENT_ID is set → renders Google's official button
//   MOCK  — env var not set → renders a custom button with demo user data
//           so the full UI flow is always testable without Google Cloud setup.

export function isGoogleConfigured() {
  return !!import.meta.env.VITE_GOOGLE_CLIENT_ID
}

// Demo user returned when no Client ID is configured
export const MOCK_GOOGLE_USER = {
  id: 'mock_google_user',
  name: 'Ciro Domingos',
  givenName: 'Ciro',
  email: 'ciro.b.domingos@gmail.com',
  picture: 'https://ui-avatars.com/api/?name=Ciro+Domingos&background=C4724A&color=fff&size=128&rounded=true',
}

/**
 * Parse the credential JWT returned by Google.
 * We only base64-decode the payload — no signature verification needed
 * for display purposes (Google already verified it on their side).
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
 * Initialize GSI and render Google's official sign-in button.
 * Polls until the GSI script is loaded (loaded async in index.html).
 * Only call this when isGoogleConfigured() === true.
 * Returns a cleanup function.
 */
export function mountGoogleButton(containerRef, onSuccess) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  if (!clientId) return () => {}

  let attempts = 0
  const poll = setInterval(() => {
    attempts++
    if (attempts > 20) { clearInterval(poll); return }
    if (!window.google?.accounts?.id) return
    clearInterval(poll)

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        const user = parseGoogleCredential(response.credential)
        if (user) onSuccess(user)
      },
      auto_select: false,
      cancel_on_tap_outside: true,
    })

    if (containerRef.current) {
      window.google.accounts.id.renderButton(containerRef.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        logo_alignment: 'left',
        width: containerRef.current.offsetWidth || 320,
      })
    }
  }, 300)

  return () => clearInterval(poll)
}
