import { useEffect } from 'react'
import { APP_STORE_URL } from '../lib/platform'
import { trackEvent } from '../services/api'

const SKIP_KEY = 'aue_skip_appstore_redirect'

// Shown instead of Onboarding to a first-time iOS Safari visitor (not the
// installed PWA, not the native app) landing on a generic entry point —
// see App.jsx's `/` route. Deep links (event/group/digest) never reach
// this: only ['/', ] with no specific route counts as "generic" there.
//
// Auto-redirects after a beat rather than instantly — an instant jump
// with zero UI reads as the browser malfunctioning, not a deliberate
// choice. "Continuar no navegador" is a real escape hatch, not a fake
// one: onboarding just fixed a dead-end bug (a screen you can't back out
// of), so this new gate doesn't get to introduce a new one.
export default function AppStoreGate({ onContinueInBrowser }) {
  useEffect(() => {
    trackEvent('appstore_gate_shown')
    const t = setTimeout(() => {
      trackEvent('appstore_gate_auto_redirect')
      window.location.href = APP_STORE_URL
    }, 1200)
    return () => clearTimeout(t)
  }, [])

  function handleContinue() {
    trackEvent('appstore_gate_continue_in_browser')
    try { sessionStorage.setItem(SKIP_KEY, '1') } catch {}
    onContinueInBrowser()
  }

  return (
    <div style={{
      minHeight: '100%',
      background: 'linear-gradient(165deg, #1E3A5F 0%, #2C2C2C 100%)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '24px 20px', color: 'white', textAlign: 'center',
    }}>
      <div style={{
        fontSize: 44, fontWeight: 800, letterSpacing: -1.2,
        color: 'var(--sage)', lineHeight: 1, marginBottom: 8,
      }}>
        auê
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        Agora tem app! 🎉
      </div>
      <div style={{
        fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.5,
        marginBottom: 28, maxWidth: 280,
      }}>
        Abrindo a App Store...
      </div>
      <a
        href={APP_STORE_URL}
        onClick={() => trackEvent('appstore_gate_manual_open')}
        className="btn btn--primary"
        style={{ width: '100%', maxWidth: 280, marginBottom: 12, textAlign: 'center' }}
      >
        Abrir na App Store
      </a>
      <button
        onClick={handleContinue}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'rgba(255,255,255,0.5)', fontSize: 12, textDecoration: 'underline',
          padding: 8,
        }}
      >
        Continuar no navegador
      </button>
    </div>
  )
}

export function shouldSkipAppStoreGate() {
  try {
    return sessionStorage.getItem(SKIP_KEY) === '1'
  } catch {
    return false
  }
}
