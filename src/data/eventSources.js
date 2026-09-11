/**
 * Event provenance + venue-category constants.
 *
 * Pulled out of Events.jsx when EventDetail moved to its own module. Both
 * files need them, and importing them from Events.jsx would make a cycle
 * (Events imports EventDetail, EventDetail would import Events), so they
 * live here instead.
 *
 * Worth knowing how their absence showed up: EventDetail reads them by
 * member access — `VENUE_CATEGORIES.has(...)`, `SOURCE_CONFIG[ev.source]`
 * — never as a call or a JSX tag. Vite happily builds an undefined
 * identifier as a presumed runtime global, so the extraction compiled
 * clean and then threw ReferenceError on the first line of the component
 * body, rendering the drawer as a black screen on every event.
 */

// Categories that are places rather than one-off events. Drives the
// "venue mode" branches: open-now status, rating, no date/time block.
export const VENUE_CATEGORIES = new Set(['bars_cafes', 'parks', 'cinema', 'bookstore'])

// Source provenance config — drives the badge label/style for every event
// origin. Add new entries here when new scrapers go live.
export const SOURCE_CONFIG = {
  aue_original:     { label: 'Seleção auê',      icon: '⭐', bg: 'linear-gradient(135deg, #FFF8E1, #FFECB3)', border: '#FFD54F', color: '#8D6E10' },
  aue_ai:           { label: 'auê IA',           icon: '✦', bg: 'linear-gradient(135deg, #EDE7F6, #D1C4E9)', border: '#CE93D8', color: '#6A1B9A' },
  instagram:        { label: 'Instagram',          icon: '📷', bg: 'linear-gradient(135deg, #FCE4EC, #F8BBD0)', border: '#F48FB1', color: '#AD1457' },
}
