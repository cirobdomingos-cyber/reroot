import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'

// Smart install banner that nudges PWA users on iOS Safari toward the
// TestFlight beta. Apple's `<meta name="apple-itunes-app">` Smart Banner
// only works for App Store apps — TestFlight betas have no App Store ID
// yet, so we DIY it.
//
// Visibility rules (all must be true):
//   1. Not running inside the Capacitor wrapper (Capacitor.isNativePlatform false)
//   2. iPhone or iPad UA — desktop / Android / etc. don't get this banner
//      (Android users are still on the PWA path; their /install
//      walkthrough handles them already)
//   3. User hasn't dismissed in this browser before (localStorage flag)
//   4. Backend's TESTFLIGHT_INVITE_URL is set — the /install endpoint
//      detects iOS and 302s. This banner just routes there.
const DISMISS_KEY = 'aue_install_banner_dismissed_v1'

function isIosBrowser() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  // iPadOS 13+ Safari spoofs Mac UA but exposes touch points; this
  // catches modern iPads in landscape that report as macintosh.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true
  return false
}

export default function InstallBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (Capacitor.isNativePlatform?.()) return  // already in app
    if (!isIosBrowser()) return
    try {
      if (localStorage.getItem(DISMISS_KEY)) return
    } catch {}
    setVisible(true)
  }, [])

  function handleInstall() {
    // /install detects iOS UA on the server and 302s to the TestFlight
    // invite URL (when TESTFLIGHT_INVITE_URL is configured). Falls back
    // to the universal walkthrough HTML otherwise.
    window.location.href = '/install'
  }

  function handleDismiss() {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch {}
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div style={{
      position: 'sticky', top: 0,
      // Above StatusBar's built-in offset but below modals (z 10000+).
      zIndex: 90,
      background: 'var(--terra)',
      color: 'white',
      padding: 'calc(env(safe-area-inset-top, 0px) + 8px) 14px 8px',
      display: 'flex', alignItems: 'center', gap: 10,
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    }}>
      <span style={{ fontSize: 22 }}>📱</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2 }}>
          auê funciona melhor no app
        </div>
        <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
          Instale a versão de testes em segundos
        </div>
      </div>
      <button
        onClick={handleInstall}
        style={{
          background: 'var(--white)', color: 'var(--terra)',
          border: 'none', borderRadius: 8,
          padding: '6px 12px', fontSize: 12, fontWeight: 700,
          cursor: 'pointer', flexShrink: 0,
        }}
      >
        Instalar
      </button>
      <button
        onClick={handleDismiss}
        aria-label="Fechar"
        style={{
          background: 'transparent', color: 'white',
          border: 'none', cursor: 'pointer',
          fontSize: 18, padding: 4, opacity: 0.7,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  )
}
