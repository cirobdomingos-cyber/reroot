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
// picker and for the contrast test; `ink` is the text colour on primary.
// Keep them in sync with globals.css: skins.test.js reads both.
export const SKINS = [
  {
    id: 'neon',
    name: 'Neon Boteco',
    blurb: { pt: 'O original: néon de boteco às duas da manhã.', en: 'The original: dive-bar neon at 2am.' },
    swatch: { bg: '#0A0510', text: '#F4ECFF', text3: '#6E5C8E', primary: '#FF2BD6', secondary: '#00E5FF', yes: '#C6FF00', ink: '#FFFFFF' },
  },
  {
    id: 'pinhao',
    name: 'Pinhão',
    blurb: { pt: 'Araucária à noite: dourado de quentão e rosa de ipê.', en: 'Araucaria at night: mulled-wine gold and ipê pink.' },
    swatch: { bg: '#0B110D', text: '#F3EEDC', text3: '#7E7A63', primary: '#F5B700', secondary: '#FF8FC8', yes: '#9BEA5A', ink: '#0B110D' },
  },
  {
    id: 'garoa',
    name: 'Garoa',
    blurb: { pt: 'Frio de Curitiba: farol amarelo na garoa, vidro de tubo.', en: 'Curitiba cold: headlights in the drizzle, tube-station glass.' },
    swatch: { bg: '#0A0E13', text: '#E6EDF3', text3: '#61717F', primary: '#FFD400', secondary: '#4CC9F0', yes: '#3DF5A0', ink: '#0A0E13' },
  },
  {
    id: 'pedreira',
    name: 'Pedreira',
    blurb: { pt: 'Show a céu aberto: pedra, laser violeta, spot âmbar.', en: 'Open-air show: stone, violet laser, amber spotlight.' },
    swatch: { bg: '#0E0C0A', text: '#F2EDE6', text3: '#7A7064', primary: '#A86BFF', secondary: '#FFB547', yes: '#7CF29A', ink: '#0E0C0A' },
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
  return skin.id
}

export function setSkin(id, storage = globalThis.localStorage, doc = globalThis.document) {
  const applied = applySkin(id, doc)
  try { storage?.setItem(SKIN_STORAGE_KEY, applied) } catch { /* not persisted; still applied */ }
  return applied
}

export function initSkin() {
  return applySkin(getSkin())
}
