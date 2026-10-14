// Words for the weekend carousel: day and time labels, the one-line
// pitch and the caption. Pure functions; nothing here invents copy. The
// pitch line is the feed's own pitch (or vibeSummary), only trimmed.

import { spanOf, timeOf, addDays } from './select.mjs'

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

// No price and no "free" on the posts (Ciro, 2026-10-14): the feed's price is
// often a guess from a flyer, it changes, and a wrong "de graça" costs trust.
// The caption sends people to the venue's profile for the ticket.
const SALES_OPENER = /^(bora|vai|bom|vale)\b[^.]*\bporque\b|^bora\b/i
const MENTIONS_PRICE = /R\$\s*\d|\d+\s*reais|gr[aá]tis|gratuit|de gra[cç]a|\bfree\b|ingresso|entrada franca/i

/**
 * The feed's pitch, trimmed to fit one or two lines on the slide.
 * Cuts at a clause break (" — ", ", ", "; ", ". ") when one exists past
 * `min` characters, otherwise at a word with an ellipsis. Never adds words.
 */
export function pitchLine(event, max = 110, min = 40) {
  // The descriptive vibeSummary first ("Show de rock no Changes"); the pitch
  // only when it is not the old "Bora porque..." line, which the app no
  // longer shows. Neither usable (or both name a price) -> no line.
  const pick = [event.vibeSummary, event.pitch].map((t) => (t || '').trim())
    .find((t) => t && !MENTIONS_PRICE.test(t) && !SALES_OPENER.test(t))
  // Attendance is the app's live counter, not a description ("auditório de
  // 648 lugares confirmados"): drop any clause that talks about it.
  const raw = (pick || '').replace(/\s+/g, ' ').split(/,\s+/).filter((c, i) => i === 0 || !/confirmad/i.test(c)).join(', ')
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

// Both stores, iPhone first: the App Store app is live for everyone; Android
// is the closed beta. One link in the bio (/install) serves both.
export const CTA_DOWNLOAD = '📲 Baixa o auê de graça — link na bio'
export const CTA_IPHONE = 'iPhone: já na App Store'
export const CTA_ANDROID = 'Android: entra no beta antes de todo mundo'
export const HASHTAGS = ['#curitiba', '#agendacuritiba', '#oquefazeremcuritiba', '#curitibacultural', '#fimdesemanacuritiba']

/** Instagram caption. One line per pick so every venue handle is tagged. */
// The feed's categoryEmoji is the coarse mood (nearly everything is 🤝
// "community"), so the caption reads the finer `tipo` first.
export const TIPO_EMOJI = {
  show: '🎸', festa: '🪩', comedia: '😂', teatro: '🎭', literatura: '📚', oficina: '🎨',
  exposicao: '🖼️', esporte: '🏃', feira: '🛍️', gastronomia: '🍽️', kids: '🧸', cinema: '🎬',
}

export function buildCaption(picks, from, to) {
  const lines = [
    `Rola esse fim de semana em Curitiba (${windowLabel(from, to)}) 👇`,
    // Most people never reach the last slide or the end of the caption, so the
    // app is named up front too, not only in the closing CTA.
    'Esses e mais centenas de rolês no app auê, de graça. Link na bio 📲',
    '',
    ...picks.map(({ event }) => {
      const emoji = TIPO_EMOJI[(event.tipo || '').toLowerCase()] || event.categoryEmoji || '📍'
      const when = whenLabel(event, from, to)
      return `${emoji} ${when} — ${event.name.trim()} @${event.igHandle}`
    }),
    '',
    'Horário e ingresso podem mudar: confere no perfil de cada lugar antes de sair.',
    '',
    CTA_DOWNLOAD,
    `${CTA_IPHONE} · ${CTA_ANDROID}`,
    '',
    HASHTAGS.slice(0, 5).join(' '),
  ]
  return `${lines.join('\n')}\n`
}
