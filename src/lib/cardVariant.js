/**
 * Which event-card treatment to render — a deliberate, temporary experiment.
 *
 * "Does the flyer make the list richer or noisier?" is a taste call that
 * nobody can settle by describing it, so both versions ship to staging
 * behind a switch and get compared on a real phone with real events:
 *
 *   ?card=thumb   72px square on the right (default) — photo at almost no
 *                 height cost, text stays the primary signal
 *   ?card=cover   full-bleed image above the row — magazine-ish, but a
 *                 card grows from ~70px to ~220px, so ~3 events per
 *                 screen instead of ~9
 *   ?card=off     today's text-only card
 *
 * Sticky per device (localStorage) so the choice survives navigation —
 * the Events screen rewrites the URL when it consumes other params.
 *
 * DELETE THIS FILE once the variant is chosen, and inline the winner.
 */
const KEY = 'aue_card_variant'
const VALID = new Set(['thumb', 'cover', 'off'])
const DEFAULT = 'thumb'

export function eventCardVariant() {
  if (typeof window === 'undefined') return DEFAULT
  try {
    // HashRouter puts the query inside the hash (#/events?card=cover);
    // accept a plain ?card= too, for pasting on desktop.
    const hash = window.location.hash || ''
    const qIndex = hash.indexOf('?')
    const fromHash = qIndex >= 0
      ? new URLSearchParams(hash.slice(qIndex + 1)).get('card')
      : null
    const picked = fromHash || new URLSearchParams(window.location.search).get('card')
    if (picked && VALID.has(picked)) {
      localStorage.setItem(KEY, picked)
      return picked
    }
    const saved = localStorage.getItem(KEY)
    if (saved && VALID.has(saved)) return saved
  } catch {
    // Private mode / storage blocked — fall through to the default.
  }
  return DEFAULT
}
