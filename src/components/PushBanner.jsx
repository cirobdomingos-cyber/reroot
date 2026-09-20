import { useState } from 'react'
import { usePushNotifications, isPushSupported } from '../lib/usePushNotifications'
import { useApp } from '../context/AppContext'

// Extracted from Home when Home dissolved (Sep 2026). It now lives on
// Notificações, which is the most contextually honest place it has ever
// had: the ask is "let us notify you", made from the screen about being
// notified, rather than from a home feed it had nothing to do with.
//
// Takes no props now — it reads AppContext itself, because its single
// caller no longer has state/dispatch lying around.
export default function PushBanner() {
  const { state, dispatch } = useApp()
  return <PushBannerInner state={state} dispatch={dispatch} />
}

// ── Push opt-in banner ─────────────────────────────────────
//
// Catch-net for users who skipped the onboarding push primer (or who
// were already past onboarding when the primer shipped). Shows a
// single low-key strip with a lime CTA + dismiss. Hides permanently
// once the user subscribes OR taps the X.
function PushBannerInner({ state, dispatch }) {
  const { subscribed, subscribe, loading, error } = usePushNotifications()
  const [busy, setBusy] = useState(false)

  // Three independent reasons to hide. If any is true, no banner.
  if (!isPushSupported()) return null
  if (state.pushOptedIn || subscribed) return null
  if (state.pushBannerDismissed) return null

  async function handleEnable() {
    setBusy(true)
    try {
      const result = await subscribe()
      // Only an explicit "denied" permanently hides the banner. It used
      // to hide on ANY failure — a VAPID misconfig, a slow mobile
      // network, a timed-out service worker registration — which meant
      // a one-off hiccup burned the ask forever, same as a real refusal.
      // 26 of 38 accounts have no push device; conflating "no" with
      // "the network blinked" is a plausible chunk of that gap.
      if (result === 'denied') {
        dispatch({ type: 'DISMISS_PUSH_BANNER' })
      }
    } finally {
      setBusy(false)
    }
  }

  function handleDismiss() {
    dispatch({ type: 'DISMISS_PUSH_BANNER' })
  }

  return (
    <div style={{
      margin: '12px 18px 0',
      padding: '10px 12px',
      background: 'rgba(198, 255, 0, 0.06)',
      border: '1px solid rgba(198, 255, 0, 0.35)',
      borderRadius: 12,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{
        fontSize: 16, lineHeight: 1, flexShrink: 0,
        color: 'var(--lime)',
        filter: 'drop-shadow(0 0 4px rgba(198, 255, 0, 0.5))',
      }}>🔔</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="neon-mono" style={{
          fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
          color: 'var(--lime)',
        }}>
          Ative o push
        </div>
        <div style={{
          fontSize: 11, color: 'var(--text2)', marginTop: 2, lineHeight: 1.4,
        }}>
          Receba quando amigos confirmarem rolês perto de você.
        </div>
        {/* Only reachable on a transient failure now — an explicit
            "denied" hides the whole banner instead. Tells the user the
            tap wasn't a no-op, since the banner otherwise just sits
            there waiting for a retry. */}
        {error && (
          <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 4, opacity: 0.8 }}>
            Não rolou agora — tenta de novo?
          </div>
        )}
      </div>
      <button
        onClick={handleEnable}
        disabled={loading || busy}
        className="neon-mono"
        style={{
          flexShrink: 0,
          padding: '6px 10px', borderRadius: 8,
          background: 'var(--lime)', color: '#14081E',
          border: 'none',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.18em',
          textTransform: 'uppercase', cursor: 'pointer',
          opacity: (loading || busy) ? 0.6 : 1,
        }}
      >
        {(loading || busy) ? '...' : 'Bora'}
      </button>
      <button
        onClick={handleDismiss}
        aria-label="Dispensar"
        style={{
          flexShrink: 0, width: 24, height: 24, borderRadius: 8,
          background: 'transparent', border: 'none', color: 'var(--text3)',
          fontSize: 14, cursor: 'pointer', padding: 0,
        }}
      >×</button>
    </div>
  )
}
