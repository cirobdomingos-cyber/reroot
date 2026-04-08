// ── Google Identity Services (GSI) helper ──────────────────
// No backend required — client-side only OAuth via Google's GSI library.
// The library is loaded in index.html via <script src="...gsi/client" async>.
// Requires: VITE_GOOGLE_CLIENT_ID env var.

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
 * Initialize GSI and render Google's sign-in button into a DOM element.
 * Safe to call before the GSI script has loaded — polls until ready.
 * Returns a cleanup function.
 */
export function mountGoogleButton(containerRef, onSuccess) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  if (!clientId) {
    console.warn('[Reroot] VITE_GOOGLE_CLIENT_ID not set — Google Sign-In disabled')
    return () => {}
  }

  let attempts = 0
  const maxAttempts = 20
  const intervalMs = 300

  const poll = setInterval(() => {
    attempts++
    if (attempts > maxAttempts) {
      clearInterval(poll)
      return
    }
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
  }, intervalMs)

  return () => clearInterval(poll)
}
