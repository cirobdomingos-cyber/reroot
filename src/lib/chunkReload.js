// ── Stale chunks: reload once instead of failing ──────────────
// A lazy import (`await import('@capacitor/browser')`, a screen) asks for a
// chunk by the hashed filename baked into the index.html that is running.
// If the files on disk changed underneath that page, the chunk is gone and
// the import rejects with "Failed to fetch dynamically imported module".
// That happened on Android 1.1.2: a live update swapped the bundle folder
// while the PWA service worker kept serving the old index.html, and
// "Continuar com Google" died on the chunk of @capacitor/browser.
//
// Vite fires `vite:preloadError` on window for exactly this. We reload the
// app once so it boots from what is really on disk. "Once" is a timestamp
// in sessionStorage: a chunk that is still missing after a fresh load is a
// real bug, and reloading forever would hide it behind a flicker loop.
//
// On native, any service worker is unregistered before the reload: the
// Capacitor app ships its files inside the bundle, so a worker only ever
// adds a second, stale copy of them (see unregisterNativeServiceWorkers).

import { Capacitor } from '@capacitor/core'

const KEY = 'aue_chunk_reload_at'
const WINDOW_MS = 30_000

let reloading = false

/** True while the page is about to reload for a stale chunk, so callers
 *  can skip the error alert the failed import would otherwise show. */
export function isReloadingForStaleChunk() {
  return reloading
}

function recentlyReloaded() {
  try {
    const at = Number(sessionStorage.getItem(KEY) || 0)
    return at > 0 && Date.now() - at < WINDOW_MS
  } catch {
    return true // no storage: cannot tell, so never risk a loop
  }
}

/** Unregister every service worker on native. No-op on the web (where the
 *  worker is the offline cache and the push channel) and on iOS, where
 *  WKWebView has no service workers at all. */
export async function unregisterNativeServiceWorkers() {
  if (!Capacitor.isNativePlatform?.()) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map((r) => r.unregister()))
  } catch {
    // Best effort: the reload below still happens.
  }
}

export function installStaleChunkReload() {
  if (typeof window === 'undefined') return
  window.addEventListener('vite:preloadError', () => {
    if (reloading || recentlyReloaded()) return // let the error surface
    reloading = true
    try { sessionStorage.setItem(KEY, String(Date.now())) } catch { /* see recentlyReloaded */ }
    unregisterNativeServiceWorkers().finally(() => window.location.reload())
  })
}
