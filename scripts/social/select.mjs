// Pick the events for the weekly "Rola esse fim de semana em Curitiba"
// Instagram carousel.
//
// Pure functions only: no fetch, no clock, no randomness. The same feed and
// the same window always give the same picks, which is what lets a human
// review the carousel on Thursday and trust that a re-run renders the same
// slides.
//
// Feed quirk worth knowing: `dateStart` / `dateEnd` carry Curitiba wall-clock
// time with a "+00:00" suffix (an event at 21h reads "...T21:00:00+00:00").
// So dates are compared as the literal YYYY-MM-DD and HH:MM in the string,
// never through Date parsing, which would shift them by three hours.

export const DEFAULTS = {
  count: 7,
  maxPerCategory: 2,
  maxPerVenue: 1,
  maxLongRun: 1, // multi-week exhibitions and theatre seasons
  maxRecurring: 1,
  maxKids: 1,
  minEachPriceGroup: 2, // at least this many free and this many paid, when the feed has them
  longRunDays: 14,
}

// Feed rows that are not a weekend plan for someone in Curitiba. Matched on
// name + venue; the feed geocodes some regional races onto Curitiba bairros,
// so the city name in the text is the reliable signal. Letter lookarounds
// with the u flag, because \b treats "í" as a word break.
export const OUT_OF_TOWN = /(?<!\p{L})(paranava[ií]|ponta grossa|toledo|matinhos|arapongas|belo horizonte|rio de janeiro|s[aã]o paulo|porto alegre|campina grande do sul|uni[aã]o da vit[oó]ria|londrina|maring[aá]|cascavel|guarapuava|paranagu[aá]|guaratuba|pontal do paran[aá]|morretes|foz do igua[cç]u|apucarana|castrolanda|agroleite|umuarama|joinville|florian[oó]polis)(?!\p{L})/iu
// Listicles, sign-ups and political rallies are feed rows, not rolês.
export const NOT_AN_EVENT = /^(inscri[cç][oõ]es|\d+\s+(musicais|eventos|coisas|lugares|programas))|segundo turno|elei[cç][aã]o|candidat|estampa pol[ií]tica/i

// Handles that repost the whole city rather than run a venue. They still get
// credited, but a slide that tags the venue itself is the one that gets reposted.
export const AGGREGATOR_HANDLES = new Set([
  'curitibacult', 'partiurolecwb', 'bilheteriadigital', 'eventimbrasil', 'curiti.kids',
  'visit.curitiba', 'corridasparana', 'sympla', 'entrelike',
])

// Formats people plan a night around; a slide about one of these is the one
// that gets saved and shared. Workshops and courses still qualify, lower.
export const HEADLINE_TIPOS = new Set(['show', 'comedia', 'teatro'])
export const NIGHT_OUT_TIPOS = new Set(['festa', 'literatura', 'feira'])

const pad = (n) => String(n).padStart(2, '0')

/** "2026-10-16T21:00:00+00:00" -> "2026-10-16" (wall-clock date, see header). */
export function dayOf(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null
}

function clockOf(iso) {
  const m = typeof iso === 'string' && iso.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : null
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number)
  const [yb, mb, db] = b.split('-').map(Number)
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000)
}

/** The event's real time of day, or null. The feed writes "00:00" for "no time given". */
export function timeOf(event) {
  const t = (event.time || '').trim()
  if (!/^\d{1,2}:\d{2}$/.test(t) || t === '00:00') return null
  return t.padStart(5, '0')
}

/**
 * First and last day the event happens on. A party that starts Friday 21h and
 * ends Saturday before 08h is a Friday event, not a two-day one.
 */
export function spanOf(event) {
  const start = dayOf(event.dateStart)
  if (!start) return null
  let end = dayOf(event.dateEnd) || start
  if (end < start) end = start
  const endClock = clockOf(event.dateEnd)
  if (daysBetween(start, end) === 1 && endClock && endClock < '08:00') end = start
  return { start, end, days: daysBetween(start, end) + 1 }
}

export function overlaps(event, from, to) {
  const s = spanOf(event)
  return Boolean(s) && s.start <= to && s.end >= from
}

export const isFree = (e) => e.priceTier === 'free'
export const isKids = (e) =>
  e.kidsWelcome === true || e.tipo === 'kids' || /kids|infantil|crian[cç]/i.test(`${e.igHandle || ''} ${e.name || ''}`)
export const isLongRun = (e, longRunDays = DEFAULTS.longRunDays) => (spanOf(e)?.days || 1) >= longRunDays
// "Category" for the variety cap. The feed's `category` is coarse (most
// concerts, plays and parties are all "community"), so the finer `tipo`
// (show, teatro, festa, oficina, esporte, ...) is used when present.
export const categoryKey = (e) => (e.tipo || e.category || '').toLowerCase()
export const venueKey = (e) =>
  (e.venue || '').split('·')[0].trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** Why an event is not a candidate at all, or null when it is. */
export function rejectReason(event, from, to) {
  if (!event || !event.name) return 'no name'
  if (!overlaps(event, from, to)) return 'outside the window'
  const text = `${event.name} ${event.venue || ''}`
  if (OUT_OF_TOWN.test(text)) return 'outside Curitiba'
  // The enrichment often says so itself ("Show em BH — fora de Curitiba")
  // while the row stays in the feed, so read its own words too.
  const about = `${event.pitch || ''} ${event.vibeSummary || ''}`
  if (/fora d[eo] (cat[aá]logo de )?curitiba/i.test(about)) return 'outside Curitiba'
  if (!event.igHandle) return 'no Instagram handle to credit'
  if (NOT_AN_EVENT.test(`${event.name} ${event.pitch || ''}`)) return 'not an event'
  return null
}

/**
 * Preference score. One-off events with a time and a venue handle to tag
 * come first: they are the ones a venue reposts and a reader can act on.
 */
export function scoreOf(event, opts = DEFAULTS) {
  const span = spanOf(event)
  const reasons = []
  let score = 0
  if (span.days === 1 && !event.isRecurring) { score += 4; reasons.push('one-off') }
  else if (span.days < opts.longRunDays && !event.isRecurring) { score += 2; reasons.push(`${span.days}-day run`) }
  if (event.isRecurring) reasons.push('recurring')
  if (span.days >= opts.longRunDays) reasons.push('long run')
  if (timeOf(event)) { score += 2; reasons.push('has a time') }
  if (event.igHandle && !AGGREGATOR_HANDLES.has(event.igHandle)) { score += 2; reasons.push(`venue @${event.igHandle} to tag`) }
  else if (event.igHandle) { score += 1; reasons.push(`aggregator @${event.igHandle}`) }
  if ((event.price || '').trim() || isFree(event)) { score += 1; reasons.push(isFree(event) ? 'free' : 'price known') }
  if ((event.pitch || event.vibeSummary || '').trim()) score += 1
  const tipo = (event.tipo || '').toLowerCase()
  if (HEADLINE_TIPOS.has(tipo)) { score += 2; reasons.push(`headline format (${tipo})`) }
  else if (NIGHT_OUT_TIPOS.has(tipo)) { score += 1; reasons.push(`night-out format (${tipo})`) }
  return { score, reasons }
}

function byDateThenTime(a, b) {
  const da = a.windowDay.localeCompare(b.windowDay)
  if (da) return da
  const ta = (timeOf(a.event) || '99:99').localeCompare(timeOf(b.event) || '99:99')
  if (ta) return ta
  return (a.event.name || '').localeCompare(b.event.name || '') || String(a.event.id).localeCompare(String(b.event.id))
}

function byPreference(a, b) {
  return (
    b.score - a.score ||
    (b.event.attendeesConfirmed || 0) - (a.event.attendeesConfirmed || 0) ||
    byDateThenTime(a, b)
  )
}

/**
 * Select the carousel events.
 *
 * Grain: one pick = one feed event shown on one slide.
 * Order of work: filter to real Curitiba events overlapping [from, to];
 * score; walk the days round-robin (best of Friday, best of Saturday, best
 * of Sunday, second best of Friday, ...) so no day eats the carousel; apply
 * the caps; return in date-then-time order.
 *
 * @returns {{ picks: Array<{event, day, score, reasons}>, considered: number, rejected: Record<string, number> }}
 */
export function selectWeekend(events, { from, to, ...overrides } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) {
    throw new Error(`selectWeekend needs from <= to as YYYY-MM-DD, got ${from}..${to}`)
  }
  const opts = { ...DEFAULTS, ...overrides }
  const exclude = new Set(opts.excludeIds || [])
  // Hand picks (curation is the product): placed first, in the order given,
  // past every cap except the window check; the rest of the carousel fills
  // around them under the usual rules.
  const pinIds = (opts.pinIds || []).filter((id) => !exclude.has(id))
  const rejected = {}
  const candidates = []
  const seenIds = new Set()
  for (const event of events || []) {
    if (seenIds.has(event?.id)) continue
    seenIds.add(event?.id)
    const reason = exclude.has(event?.id) ? 'excluded by hand' : rejectReason(event, from, to)
    if (reason) { rejected[reason] = (rejected[reason] || 0) + 1; continue }
    const span = spanOf(event)
    const { score, reasons } = scoreOf(event, opts)
    candidates.push({ event, windowDay: span.start < from ? from : span.start, score, reasons })
  }

  const days = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)
  const queues = days.map((d) => candidates.filter((c) => c.windowDay === d).sort(byPreference))

  const freeAvailable = candidates.filter((c) => isFree(c.event)).length
  const paidAvailable = candidates.length - freeAvailable
  const minMix = Math.min(opts.minEachPriceGroup, Math.floor(opts.count / 2))
  const maxFree = paidAvailable >= minMix ? opts.count - minMix : opts.count
  const maxPaid = freeAvailable >= minMix ? opts.count - minMix : opts.count

  const picked = []
  const used = new Set()
  for (const id of pinIds) {
    const c = candidates.find((x) => x.event.id === id)
    if (!c) throw new Error(`--pick ${id}: not an event in ${from}..${to} (or rejected as not a Curitiba rolê)`)
    if (!used.has(c) && picked.length < opts.count) { picked.push({ ...c, reasons: ['picked by hand', ...c.reasons] }); used.add(c) }
  }
  const fits = (c, enforceMix) => {
    const e = c.event
    const same = (fn) => picked.filter((p) => fn(p.event)).length
    if (same((p) => categoryKey(p) === categoryKey(e)) >= opts.maxPerCategory) return false
    const v = venueKey(e)
    if (v && same((p) => venueKey(p) === v) >= opts.maxPerVenue) return false
    if (e.igHandle && same((p) => p.igHandle === e.igHandle) >= opts.maxPerVenue) return false
    if (isLongRun(e, opts.longRunDays) && same((p) => isLongRun(p, opts.longRunDays)) >= opts.maxLongRun) return false
    if (e.isRecurring && same((p) => p.isRecurring) >= opts.maxRecurring) return false
    if (isKids(e) && same(isKids) >= opts.maxKids) return false
    if (enforceMix) {
      if (isFree(e) && same(isFree) >= maxFree) return false
      if (!isFree(e) && same((p) => !isFree(p)) >= maxPaid) return false
    }
    return true
  }

  // Pass 1 keeps the free/paid mix; pass 2 fills any slot left if the mix
  // could not be met with the other caps in place.
  for (const enforceMix of [true, false]) {
    let progress = true
    while (picked.length < opts.count && progress) {
      progress = false
      for (const queue of queues) {
        if (picked.length >= opts.count) break
        const next = queue.find((c) => !used.has(c) && fits(c, enforceMix))
        if (next) { picked.push(next); used.add(next); progress = true }
      }
    }
  }

  picked.sort(byDateThenTime)
  return {
    picks: picked.map((c) => ({ event: c.event, day: c.windowDay, score: c.score, reasons: c.reasons })),
    considered: candidates.length,
    rejected,
  }
}

/** The coming Friday..Sunday for a given "today" (YYYY-MM-DD, Curitiba). On a weekend, the current one. */
export function comingWeekend(today) {
  const [y, m, d] = today.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 Sun .. 6 Sat
  const toFriday = dow === 6 ? -1 : dow === 0 ? -2 : 5 - dow
  const from = addDays(today, toFriday)
  return { from, to: addDays(from, 2) }
}
