/**
 * Musical genre vocabulary — the frontend half of GENRES in
 * backend/enrichment.py.
 *
 * Closed on purpose. The tag exists to group nights that genuinely
 * belong together, and one invented label puts sertanejo in Rockzão;
 * the backend drops anything outside this set, so a drift here surfaces
 * as a 400 naming the valid values rather than as bad data.
 *
 * An empty genre means "not a music night" OR "couldn't tell" — those
 * are deliberately the same thing, both meaning "don't group this".
 */

// Order is the display order wherever genres are listed. Roughly by how
// much of the Curitiba catalog each one covers, so the common buckets
// lead.
export const GENRE_ORDER = [
  'rock',
  'samba_pagode',
  'eletronica',
  'sertanejo',
  'pop',
  'mpb',
  'rap_trap',
  'forro',
  'jazz_blues',
  'classica',
]

export const GENRE_META = {
  rock:         { label: 'Rock',           emoji: '🎸' },
  samba_pagode: { label: 'Samba & Pagode', emoji: '🥁' },
  eletronica:   { label: 'Eletrônica',     emoji: '🎛️' },
  sertanejo:    { label: 'Sertanejo',      emoji: '🤠' },
  pop:          { label: 'Pop',            emoji: '✨' },
  mpb:          { label: 'MPB',            emoji: '🎶' },
  rap_trap:     { label: 'Rap & Trap',     emoji: '🎤' },
  forro:        { label: 'Forró',          emoji: '🪗' },
  jazz_blues:   { label: 'Jazz & Blues',   emoji: '🎺' },
  classica:     { label: 'Clássica',       emoji: '🎻' },
}

export function genreLabel(genre) {
  return GENRE_META[genre]?.label || ''
}

/**
 * Group events by genre, but only when grouping actually helps.
 *
 * Headings cost vertical space and make a short list feel emptier than
 * it is — five events under three headings reads as three thin
 * sections, not as organisation. So this falls back to a flat list
 * unless the batch is big enough and genuinely varied: at least
 * `minEvents` in total, and at least two genres carrying two or more
 * events each. A digest that's mostly one genre is a flat list with a
 * lot of noise otherwise.
 *
 * Returns null when it isn't worth grouping — callers render flat.
 * Otherwise returns [{ genre, label, emoji, events }], biggest bucket
 * first, with the untagged remainder last and unlabelled by genre.
 */
export function groupByGenre(events, { minEvents = 8, minPerGenre = 2 } = {}) {
  const list = events || []
  if (list.length < minEvents) return null

  const buckets = new Map()
  const untagged = []
  for (const ev of list) {
    const genre = ev.genre || ''
    if (!genre || !GENRE_META[genre]) { untagged.push(ev); continue }
    if (!buckets.has(genre)) buckets.set(genre, [])
    buckets.get(genre).push(ev)
  }

  const substantial = [...buckets.values()].filter(evs => evs.length >= minPerGenre)
  if (substantial.length < 2) return null

  const sections = [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length
      || GENRE_ORDER.indexOf(a[0]) - GENRE_ORDER.indexOf(b[0]))
    .map(([genre, evs]) => ({
      genre,
      label: GENRE_META[genre].label,
      emoji: GENRE_META[genre].emoji,
      events: evs,
    }))

  if (untagged.length) {
    // Not "sem gênero" — most of these aren't music at all, and naming
    // the absence of a tag tells the reader about our data model rather
    // than about their night.
    sections.push({ genre: '', label: 'E mais', emoji: '', events: untagged })
  }
  return sections
}
