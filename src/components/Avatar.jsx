import { useEffect, useState } from 'react'

/**
 * Reusable avatar with a 3-step fallback chain:
 *   1. <img src={src}> — if a picture URL is provided. On load error
 *      (broken URL, expired Google CDN, blocked referrer), falls to step 2.
 *   2. ui-avatars.com generated avatar from `name` — coral background
 *      (#E8623F) with cream text, on-brand for auê.
 *   3. CSS circle with the first letter of `name`. Pure markup, never fails.
 *
 * Common sizes used in the app: 26 (compact stack), 42 (list rows), 72 (hero).
 */
export default function Avatar({ src, name, size = 42, bordered = false }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
  const generatedSrc = name?.trim() ? buildUiAvatarsUrl(name, size * 2) : null
  const primarySrc = src || generatedSrc

  const [failed, setFailed] = useState(false)
  // If the source URL changes (e.g., user switches accounts), reset the
  // failure flag so the new URL gets a fresh attempt.
  useEffect(() => { setFailed(false) }, [primarySrc])

  const baseStyle = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    objectFit: 'cover',
    // Magenta placeholder while picture loads — matches the brand and
    // the ui-avatars fallback below so the swap doesn't flash to a
    // different color mid-load.
    background: 'var(--magenta)',
    border: bordered ? '3px solid rgba(255, 43, 214, 0.3)' : undefined,
  }

  if (primarySrc && !failed) {
    return (
      <img
        src={primarySrc}
        alt={name || 'avatar'}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={baseStyle}
      />
    )
  }

  // Final fallback — always renders, never depends on the network.
  return (
    <div
      style={{
        ...baseStyle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontSize: size * 0.4,
        fontWeight: 700,
        letterSpacing: 0,
      }}
      aria-label={name || 'avatar'}
    >
      {initial}
    </div>
  )
}

function buildUiAvatarsUrl(name, sizePx) {
  // Neon Boteco palette: deep magenta bg with cream-violet initials.
  // Matches the brand stamp on Home + the magenta-on-bg2 chips
  // throughout the app.
  const params = new URLSearchParams({
    name: name.trim(),
    background: 'FF2BD6',
    color: 'F4ECFF',
    size: String(Math.max(64, Math.round(sizePx))),
    rounded: 'true',
    bold: 'true',
    'font-size': '0.5',
  })
  return `https://ui-avatars.com/api/?${params.toString()}`
}
