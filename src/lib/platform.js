// iOS Safari / standalone-PWA detection, shared by anything that needs to
// branch on "is this a first-time iOS web visitor" — e.g. App.jsx's `/`
// route offering the App Store instead of Onboarding. isIosBrowser was
// previously private to the now-deleted InstallBanner.jsx; moved here
// because App.jsx needs the same check for a different purpose.

export const APP_STORE_URL = 'https://apps.apple.com/app/id6765535013'

export function isIosBrowser() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua)) return true
  // iPadOS 13+ Safari spoofs Mac UA but exposes touch points; this
  // catches modern iPads in landscape that report as macintosh.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true
  return false
}

export function isStandalonePwa() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(display-mode: standalone)').matches
}
