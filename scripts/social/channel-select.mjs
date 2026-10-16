// Picks for the "canais" carousel: for each public auê channel, a few of
// its events in the window, shown as a teaser of what following it gives.
//
// Pure and deterministic, like select.mjs. Input is the GET /channels/{id}
// payload per channel; nothing here fetches.

import { rejectReason, spanOf, timeOf, venueKey } from './select.mjs'

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

// The same show arrives once per post that announced it ("Texas
// Experience", "Pay In Cash", "Texas Experience com Pay In Cash"): one
// venue at one start time is one rolê. Two sessions of a comedy club on
// the same night stay two.
const rolêKey = (e) => `${handleOf(e) || venueKey(e)}|${(e.dateStart || '').slice(0, 16)}`

/**
 * @param channels [{ channel, events }] as GET /channels/{id} answers
 * @returns { slides: [{ channel, title, total, picks }], skipped: [{ title, reason }] }
 */
export function selectChannels(channels, { from, to, excludeIds = [], ...overrides } = {}) {
  const opts = { ...CHANNEL_DEFAULTS, ...overrides }
  const excluded = new Set(excludeIds)
  const prepared = channels.map(({ channel, events }) => {
    const seen = new Map()
    for (const raw of events || []) {
      const e = { ...raw, igHandle: handleOf(raw) }
      if (excluded.has(e.id) || excluded.has(e.sourceEventId)) continue
      if (rejectReason(e, from, to)) continue
      const key = rolêKey(e)
      // Keep the copy with a real time, then the shortest name (the
      // headline, not the lineup).
      const prev = seen.get(key)
      if (!prev || (!timeOf(prev) && timeOf(e)) || (Boolean(timeOf(prev)) === Boolean(timeOf(e)) && e.name.length < prev.name.length)) seen.set(key, e)
    }
    return { channel, title: channelTitle(channel.name), rolês: [...seen.values()] }
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
