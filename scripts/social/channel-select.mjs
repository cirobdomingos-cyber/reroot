// Picks for the "canais" carousel: for each public auê channel, a few of
// its events in the window, shown as a teaser of what following it gives.
//
// Pure and deterministic, like select.mjs. Input is the GET /channels/{id}
// payload per channel; nothing here fetches.

import { rejectReason, spanOf, timeOf, venueKey, AGGREGATOR_HANDLES } from './select.mjs'

export const CHANNEL_DEFAULTS = {
  perChannel: 3,     // events shown on one channel slide
  maxChannels: 8,    // a carousel holds 10 slides: cover + channels + closing
  minEvents: 2,      // a channel with fewer events in the window gets no slide
}

// Channel rows carry no handle of their own; the scrape's source handle is
// the venue. Dedup suffixes ("torkandroll_denj73", "muellercwb_dehk") are
// the importer's, not Instagram's, and would tag nobody.
export const handleOf = (e) => (e.igHandle || e.sourceIgHandle || '').replace(/_de[a-z0-9]{1,6}$/i, '') || null

/** "auê Samba e Pagode" -> "Samba e Pagode" */
export const channelTitle = (name) => (name || '').replace(/^au[eê]\s+/i, '').trim()

// One night out arrives once per post that announced it: Tork n' Roll's
// "Texas Experience" came as ten rows (one per band, per repost, per
// handle). Two rows of the same night are one rolê when
//  - they are at the same place and start under 2h apart or share a
//    word of their names (two comedy sessions 3h apart stay two), or
//  - they start within 1h and share 2+ name words, wherever the scrape
//    put them ("Roberto Carlos" with the venue "Curitiba"); one shared
//    word is not enough ("Carrie" and "A Casa do Terror" at 19h).
const SAME_PLACE_MINUTES = 120
const ANY_PLACE_MINUTES = 60
const STOPWORDS = new Set(['show', 'com', 'para', 'festa', 'noite', 'especial', 'edicao', 'curitiba', 'apresenta', 'final', 'semana', 'sabado', 'domingo', 'sexta', 'temporada'])
const fold = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const words = (e) => new Set(fold(e.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)))
// A place is its own handle or its venue text: "Changes" and "Changes
// Bar" share @changes.cwb, "Teatro Guaíra – Auditório Bento Munhoz" and
// "Teatro Guaira" share the text. An aggregator handle (@curitibacult)
// posts for many places, so only its venue text counts.
const placesOf = (e) => {
  const keys = []
  const venue = venueKey(e).split(' ').slice(0, 2).join(' ')
  if (venue) keys.push(`v:${venue}`)
  const h = handleOf(e)
  if (h && !AGGREGATOR_HANDLES.has(h)) keys.push(`h:${h}`)
  return keys
}
const minutesOf = (e) => Date.parse(e.dateStart) / 60000
// A night runs to 06h: a 00h30 set belongs to the evening before.
// dateStart carries the -03:00 offset, so shift to Curitiba time first.
const nightOf = (e) => new Date(Date.parse(e.dateStart) - 9 * 3600000).toISOString().slice(0, 10)

/** Group rows into rolês; returns arrays of rows, each array one rolê. */
export function groupRolês(events) {
  const byNight = new Map()
  for (const e of events) {
    const k = nightOf(e)
    if (!byNight.has(k)) byNight.set(k, [])
    byNight.get(k).push(e)
  }
  const groups = []
  for (const rows of byNight.values()) {
    const parent = rows.map((_, i) => i)
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    const w = rows.map(words)
    const p = rows.map(placesOf)
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const gap = Math.abs(minutesOf(rows[i]) - minutesOf(rows[j]))
        const shared = [...w[i]].filter((x) => w[j].has(x)).length
        const samePlace = p[i].some((k) => p[j].includes(k))
        if ((samePlace && (gap < SAME_PLACE_MINUTES || shared > 0)) || (gap <= ANY_PLACE_MINUTES && shared >= 2)) parent[find(i)] = find(j)
      }
    }
    const byRoot = new Map()
    rows.forEach((e, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(e) })
    groups.push(...byRoot.values())
  }
  return groups
}

// The row that stands for its rolê: a real time first, then the shortest
// name (the headline, not the lineup).
const representative = (rows) => [...rows].sort((a, b) => (timeOf(a) ? 0 : 1) - (timeOf(b) ? 0 : 1) || a.name.length - b.name.length)[0]
const rolêKey = (e) => `${placesOf(e)[0] || e.id}|${nightOf(e)}`

/**
 * @param channels [{ channel, events }] as GET /channels/{id} answers
 * @returns { slides: [{ channel, title, total, picks }], skipped: [{ title, reason }] }
 */
export function selectChannels(channels, { from, to, excludeIds = [], ...overrides } = {}) {
  const opts = { ...CHANNEL_DEFAULTS, ...overrides }
  const excluded = new Set(excludeIds)
  const prepared = channels.map(({ channel, events }) => {
    const rows = (events || [])
      .map((raw) => ({ ...raw, igHandle: handleOf(raw) }))
      .filter((e) => !excluded.has(e.id) && !excluded.has(e.sourceEventId) && !rejectReason(e, from, to))
    return { channel, title: channelTitle(channel.name), rolês: groupRolês(rows).map(representative) }
  })

  // Small channels claim their events first, so a night tagged both
  // "Cultura" and "Livros" shows up on Livros, where it is one of four.
  const claimed = new Set()
  const slides = []
  const skipped = []
  for (const c of [...prepared].sort((a, b) => a.rolês.length - b.rolês.length || a.title.localeCompare(b.title))) {
    if (c.rolês.length < opts.minEvents) { skipped.push({ title: c.title, reason: `${c.rolês.length} event(s) in the window` }); continue }
    const free = c.rolês.filter((e) => !claimed.has(rolêKey(e)) && !claimed.has(normName(e)))
    const picks = pickSpread(free, opts.perChannel)
    if (!picks.length) { skipped.push({ title: c.title, reason: 'every event already on another slide' }); continue }
    for (const e of picks) { claimed.add(rolêKey(e)); claimed.add(normName(e)) }
    slides.push({ channel: c.channel, title: c.title, total: c.rolês.length, picks })
  }
  slides.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title))
  return { slides: slides.slice(0, opts.maxChannels), skipped: [...skipped, ...slides.slice(opts.maxChannels).map((s) => ({ title: s.title, reason: 'over the slide cap' }))] }
}

const normName = (e) => `name:${e.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 24)}`

// Night out first (17h on), then the rest of the timed events, then the
// untimed ones: a morning course reads as homework on a weekend slide.
const slot = (e) => { const t = timeOf(e); return !t ? 2 : t >= '17:00' ? 0 : 1 }

// Different venues first, days taken round-robin, best slot first; shown
// by date and time.
function pickSpread(events, n) {
  const byDay = new Map()
  for (const e of [...events].sort((a, b) => slot(a) - slot(b) || a.dateStart.localeCompare(b.dateStart))) {
    const d = spanOf(e).start
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(e)
  }
  const days = [...byDay.keys()].sort()
  const picks = []
  const venues = new Set()
  for (const allowRepeatVenue of [false, true]) {
    let progress = true
    while (picks.length < n && progress) {
      progress = false
      for (const d of days) {
        if (picks.length >= n) break
        const queue = byDay.get(d)
        const i = queue.findIndex((e) => allowRepeatVenue || !venues.has(e.igHandle))
        if (i < 0) continue
        const [e] = queue.splice(i, 1)
        picks.push(e); venues.add(e.igHandle); progress = true
      }
    }
  }
  return picks.sort((a, b) => a.dateStart.localeCompare(b.dateStart))
}
