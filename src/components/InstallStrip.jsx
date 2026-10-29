import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { isStandalonePwa } from '../lib/platform'
import { trackEvent } from '../services/api'

// One line offering the app to someone reading auê in a browser tab.
//
// Where it goes: pages a shared link lands on (a public channel today).
// Those routes skip the App Store gate on purpose — a deep link that
// bounces you to a store before showing what you tapped is how links
// stop getting tapped — so this is the only nudge such a visitor sees.
//
// `/install` sniffs the platform server-side and sends iPhones to the
// App Store and Androids to Play, so one link serves both; `?src=`
// lets /analytics/funnel tell these installs apart from the bio link's.
//
// Never rendered inside the native wrappers or the installed PWA: they
// already are the app. Dismissal is per browser, in localStorage, so a
// person who said no isn't asked on every channel they open.
const KEY = 'aue_install_strip_dismissed'

function dismissed() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export default function InstallStrip({ src = 'strip' }) {
  const [hidden, setHidden] = useState(dismissed)
  if (hidden) return null
  if (Capacitor.isNativePlatform?.() || isStandalonePwa()) return null

  function dismiss() {
    try { localStorage.setItem(KEY, '1') } catch { /* private mode: lasts the tab */ }
    trackEvent('install_strip_dismissed', { src })
    setHidden(true)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      marginTop: 12, padding: '9px 12px', borderRadius: 12,
      background: 'var(--bg2)', border: '1px solid var(--line)',
    }}>
      <span style={{ fontSize: 18, lineHeight: 1 }}>📲</span>
      <div style={{ flex: 1, fontSize: 12, lineHeight: 1.4, color: 'var(--text2)' }}>
        Segue esse canal no app e recebe os rolês da semana.
      </div>
      <a
        href={`/install?src=${encodeURIComponent(src)}`}
        onClick={() => trackEvent('install_strip_tap', { src })}
        style={{
          fontSize: 12, fontWeight: 800, padding: '6px 10px', borderRadius: 8,
          background: 'var(--from-aue)', color: 'var(--bg)', textDecoration: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        Baixar
      </a>
      <button
        onClick={dismiss}
        aria-label="Fechar"
        style={{
          background: 'none', border: 'none', color: 'var(--text3)',
          fontSize: 16, lineHeight: 1, padding: '2px 4px', cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  )
}
