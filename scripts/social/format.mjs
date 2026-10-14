// Words for the weekend carousel: day and time labels, price, the one-line
// pitch and the caption. Pure functions; nothing here invents copy. The
// pitch line is the feed's own pitch (or vibeSummary), only trimmed.

import { spanOf, timeOf, isFree, addDays } from './select.mjs'

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

function parts(day) {
  const [y, m, d] = day.split('-').map(Number)
  return { weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], day: d, month: MONTHS[m - 1] }
}

/** "2026-10-16" -> "Sex 16" */
export const shortDay = (day) => { const p = parts(day); return `${p.weekday} ${p.day}` }

/** Cover line: "Sex 16 a Dom 18 out" (months shown once when equal). */
export function windowLabel(from, to) {
  const a = parts(from), b = parts(to)
  return a.month === b.month
    ? `${a.weekday} ${a.day} a ${b.weekday} ${b.day} ${b.month}`
    : `${a.weekday} ${a.day} ${a.month} a ${b.weekday} ${b.day} ${b.month}`
}

/** "21:00" -> "21h", "18:30" -> "18h30", none -> "" */
export function timeLabel(event) {
  const t = timeOf(event)
  if (!t) return ''
  const [h, m] = t.split(':')
  return `${Number(h)}h${m === '00' ? '' : m}`
}

/**
 * When the event happens, seen from inside the window.
 * One day: "Sex 16". Several days inside the window: "Sex 16 a Dom 18".
 * Running beyond the window: "Até 28 fev".
 */
export function dayLabel(event, from, to) {
  const s = spanOf(event)
  const start = s.start < from ? from : s.start
  if (s.end > addDays(to, 1)) { const e = parts(s.end); return `Até ${e.day} ${e.month}` }
  const end = s.end > to ? to : s.end
  if (start === end) return shortDay(start)
  return `${shortDay(start)} a ${shortDay(end)}`
}

export function whenLabel(event, from, to) {
  return [dayLabel(event, from, to), timeLabel(event)].filter(Boolean).join(' · ')
}

/** Price as the feed has it; "de graça" when free; a pointer when the feed has no number. */
export function priceLabel(event) {
  const price = (event.price || '').trim()
  if (isFree(event) && (!price || /^R\$\s*0$/.test(price))) return 'de graça'
  const zeroTo = price.match(/^R\$\s*0\s*[–-]\s*(\d+)/)
  if (zeroTo) return `de graça a R$ ${zeroTo[1]}`
  if (price) return price.replace(/\s*[–-]\s*/, ' a ')
  return isFree(event) ? 'de graça' : 'ingresso no perfil'
}

/**
 * The feed's pitch, trimmed to fit one or two lines on the slide.
 * Cuts at a clause break (" — ", ", ", "; ", ". ") when one exists past
 * `min` characters, otherwise at a word with an ellipsis. Never adds words.
 */
export function pitchLine(event, max = 110, min = 40) {
  const raw = ((event.pitch || '').trim() || (event.vibeSummary || '').trim()).replace(/\s+/g, ' ')
  if (!raw) return ''
  const clean = (s) => s.replace(/[\s,;:—–-]+$/, '')
  if (raw.length <= max) return clean(raw)
  const head = raw.slice(0, max + 1)
  let best = -1
  for (const sep of [' — ', ' – ', '. ', '; ', ', ']) {
    const i = head.lastIndexOf(sep)
    if (i >= min && i > best) best = i
  }
  if (best > 0) return clean(raw.slice(0, best))
  const space = head.lastIndexOf(' ', max - 1)
  return `${clean(raw.slice(0, space > min ? space : max - 1))}…`
}

/** "Venue · Bairro", without repeating the bairro when the venue name already has it. */
export const venueLine = (event) => {
  let venue = (event.venue || '').trim()
  const bairro = (event.bairro || '').trim()
  if (!bairro) return venue
  const tail = ` · ${bairro}`
  if (venue.endsWith(tail) && venue.slice(0, -tail.length).toLowerCase().includes(bairro.toLowerCase())) {
    venue = venue.slice(0, -tail.length)
  }
  if (venue.toLowerCase().includes(bairro.toLowerCase())) return venue
  return venue ? `${venue} · ${bairro}` : bairro
}

export const CTA_ANDROID = 'Tem Android? Testa o auê antes de todo mundo — link na bio'
export const CTA_IPHONE = 'No iPhone: auê na App Store'
export const HASHTAGS = ['#curitiba', '#agendacuritiba', '#oquefazeremcuritiba', '#curitibacultural', '#fimdesemanacuritiba']

/** Instagram caption. One line per pick so every venue handle is tagged. */
export function buildCaption(picks, from, to) {
  const lines = [
    `Rola esse fim de semana em Curitiba (${windowLabel(from, to)}) 👇`,
    '',
    ...picks.map(({ event }) => {
      const emoji = event.categoryEmoji || '📍'
      const when = whenLabel(event, from, to)
      return `${emoji} ${when} — ${event.name.trim()} @${event.igHandle}`
    }),
    '',
    'Horário e ingresso podem mudar: confere no perfil de cada lugar antes de sair.',
    '',
    CTA_ANDROID,
    `${CTA_IPHONE}.`,
    '',
    HASHTAGS.slice(0, 5).join(' '),
  ]
  return `${lines.join('\n')}\n`
}
