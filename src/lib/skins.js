// Skins: alternative palettes for the whole app, picked in Perfil.
//
// The palette itself lives in src/styles/globals.css (`:root` is Neon
// Boteco, `:root[data-skin="<id>"]` blocks override it). This module only
// knows the list, remembers the choice per device and flips the
// attribute. It runs before React mounts (initSkin in main.jsx) so the
// first frame is already in the chosen skin: no neon flash on launch.
//
// Per device on purpose, not per account: a skin is how this phone looks,
// like the keyboard theme, and it must apply before sign-in is known.

export const SKIN_STORAGE_KEY = 'aue_skin'
export const DEFAULT_SKIN = 'neon'

// `swatch` mirrors the CSS values (bg, primary, secondary, yes) for the
// picker and for the contrast test; `ink` is the text colour on primary,
// `accentInk` on the secondary and yes fills (--on-cyan / --on-lime).
// Keep them in sync with globals.css: skins.test.js reads both.
export const SKINS = [
  {
    id: 'neon',
    name: 'Neon Boteco',
    blurb: { pt: 'O original: néon de boteco às duas da manhã.', en: 'The original: dive-bar neon at 2am.' },
    swatch: { bg: '#0A0510', text: '#F4ECFF', text3: '#6E5C8E', primary: '#FF2BD6', secondary: '#00E5FF', yes: '#C6FF00', ink: '#0A0510', accentInk: '#0A0510' },
  },
  {
    id: 'garoa',
    name: 'Garoa',
    blurb: { pt: 'Frio de Curitiba: farol amarelo na garoa, vidro de tubo.', en: 'Curitiba cold: headlights in the drizzle, tube-station glass.' },
    swatch: { bg: '#0A0E13', text: '#E6EDF3', text3: '#61717F', primary: '#FFD400', secondary: '#4CC9F0', yes: '#3DF5A0', ink: '#0A0E13', accentInk: '#0A0E13' },
  },
  {
    id: 'garoa-clara',
    name: 'Garoa Clara',
    light: true,
    blurb: { pt: 'Garoa de dia: cinza de neblina, vidro de tubo, para ler no sol.', en: 'Garoa by day: fog grey and tube glass, readable in the sun.' },
    swatch: { bg: '#EEF2F5', text: '#121A22', text3: '#6B7783', primary: '#00758F', secondary: '#8A6100', yes: '#0E7A3E', ink: '#FFFFFF', accentInk: '#FFFFFF' },
  },
]

export function isSkin(id) {
  return SKINS.some((s) => s.id === id)
}

export function getSkin(storage = globalThis.localStorage) {
  try {
    const id = storage?.getItem(SKIN_STORAGE_KEY)
    return isSkin(id) ? id : DEFAULT_SKIN
  } catch {
    return DEFAULT_SKIN // private mode / blocked storage: fall back, never throw
  }
}

// Applies a skin to the document: the data-skin attribute (neon = none,
// so the default path is the CSS that shipped before skins existed) and
// the theme-color meta, which tints the browser / Android status bar.
export function applySkin(id, doc = globalThis.document) {
  const skin = SKINS.find((s) => s.id === id) || SKINS[0]
  if (!doc) return skin.id
  const root = doc.documentElement
  if (skin.id === DEFAULT_SKIN) root.removeAttribute('data-skin')
  else root.setAttribute('data-skin', skin.id)
  const meta = doc.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', skin.swatch.bg)
  syncNativeStatusBar(skin)
  return skin.id
}

// iOS draws the clock and battery in the system's colour, not ours: on a
// phone in dark mode a light skin got white status text on a light page.
// @capacitor/status-bar sets it per skin. It is native, so it only works
// from the first store build that bundles it; on older binaries (reached
// by an OTA bundle) the call rejects and is ignored, which leaves today's
// behaviour.
function syncNativeStatusBar(skin) {
  if (!globalThis.Capacitor?.isNativePlatform?.()) return
  import('@capacitor/status-bar')
    .then(({ StatusBar, Style }) => StatusBar.setStyle({ style: skin.light ? Style.Light : Style.Dark }))
    .catch(() => {})
}

export function setSkin(id, storage = globalThis.localStorage, doc = globalThis.document) {
  const applied = applySkin(id, doc)
  try { storage?.setItem(SKIN_STORAGE_KEY, applied) } catch { /* not persisted; still applied */ }
  return applied
}

export function initSkin() {
  return applySkin(getSkin())
}
