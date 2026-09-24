import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

// Two answers to "the back button threw me back to Eventos while I was
// doing something else" (Sep 2026):
//
//   useGoBack(fallback)  — the "← Voltar" buttons. They used to jump to
//     a fixed route (Eventos, Canais, Fontes) no matter where the person
//     came from. Now they go back in history when there is somewhere to
//     go back to, and use the fixed route only when the screen was
//     opened directly (a share link, a push).
//
//   useBackClosesOverlay(open, onClose) — drawers and bottom sheets.
//     They rendered on top of the screen without touching history, so
//     the system back button (Android, browser) left the whole screen
//     instead of closing the overlay. Opening one now pushes a history
//     entry marked with the overlay's id; back pops it and the overlay
//     closes; closing from the UI pops it too, so history stays clean.
//     Overlays stack (a sheet over the drawer): each has its own id, so
//     one back closes only the top one.

export function useGoBack(fallback) {
  const navigate = useNavigate()
  return useCallback(() => {
    // React Router keeps the position of the current entry in
    // history.state.idx; 0 means this is the first entry of the session
    // — nothing of ours to go back to.
    const idx = (typeof window !== 'undefined' && window.history.state?.idx) || 0
    if (idx > 0) navigate(-1)
    else navigate(fallback, { replace: true })
  }, [navigate, fallback])
}

const OVERLAY_KEY = 'aueOverlay'
let nextOverlayId = 1

export function useBackClosesOverlay(open, onClose) {
  const navigate = useNavigate()
  const location = useLocation()
  const idRef = useRef(null)
  if (idRef.current === null) idRef.current = `o${nextOverlayId++}`
  const pushedRef = useRef(false)   // we navigated for this opening
  const armedRef = useRef(false)    // and our marker entry became current
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Open: push the marker entry, once per opening.
  useEffect(() => {
    if (!open) { pushedRef.current = false; armedRef.current = false; return }
    if (pushedRef.current) return
    // Opened through navigation state (Meus eventos → /events with
    // openEventId): that entry IS the overlay, back already leaves it.
    if (location.state?.openEventId) return
    pushedRef.current = true
    navigate(location.pathname + location.search, { state: { [OVERLAY_KEY]: idRef.current } })
  }, [open])

  // Arm once the router lands on our entry; from then on, landing on an
  // entry without our marker means back was pressed. Checking before
  // arming closed the overlay in the very commit that pushed the entry,
  // because this effect ran with the location from before the push.
  useEffect(() => {
    if (!open || !pushedRef.current) return
    if (location.state?.[OVERLAY_KEY] === idRef.current) {
      armedRef.current = true
      return
    }
    if (armedRef.current) {
      armedRef.current = false
      pushedRef.current = false
      onCloseRef.current?.()
    }
  }, [location, open])

  // Closing from the UI: pop our entry so the next back press doesn't
  // land on a ghost of the open overlay.
  return useCallback(() => {
    if (armedRef.current && location.state?.[OVERLAY_KEY] === idRef.current) {
      armedRef.current = false
      pushedRef.current = false
      navigate(-1)
    }
    onCloseRef.current?.()
  }, [location, navigate])
}
