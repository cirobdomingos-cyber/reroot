// ── Share helper ────────────────────────────────────────────
// Wraps the Web Share API (the native iOS/Android share sheet) with a
// clipboard fallback for desktops and browsers that don't support it.
//
// Usage: const ok = await shareLink({ url, title, text })
//        if (ok === 'shared') ... if (ok === 'copied') ... if (ok === 'failed') ...
//
// Returns one of:
//   'shared' — user actually shared via the OS sheet
//   'copied' — fallback: link copied to clipboard
//   'cancelled' — user dismissed the share sheet (Web Share API)
//   'failed' — neither share nor clipboard worked

export async function shareLink({ url, title = '', text = '' }) {
  // Web Share API — works on iOS Safari, Android Chrome/Firefox, recent
  // Edge. Opens the native share sheet with WhatsApp/SMS/Email/etc.
  if (navigator.share) {
    try {
      await navigator.share({ url, title, text })
      return 'shared'
    } catch (err) {
      // User cancelled the sheet — that's fine, treat as cancelled.
      if (err?.name === 'AbortError') return 'cancelled'
      // Some platforms (e.g., desktop Safari on a non-PWA) reject silently;
      // fall through to clipboard.
    }
  }

  // Fallback — copy to clipboard so the user can paste anywhere.
  try {
    await navigator.clipboard.writeText(url)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/**
 * Build a hash-router URL for the current origin. Use this when generating
 * shareable links — the app uses HashRouter, so links must include the `#`.
 */
export function appLink(hashPath) {
  const path = hashPath.startsWith('/') ? hashPath : `/${hashPath}`
  return `${window.location.origin}/#${path}`
}
