/**
 * Event tipo vocabulary — the frontend half of TIPOS in
 * backend/enrichment.py.
 *
 * "What happens" at the event, regardless of where. The source category
 * (bar, café, coletivo…) is a property of the Instagram handle and says
 * where; genre says what sound, for music nights only; tipo is the axis
 * that covers the whole catalog. A channel rule is tipos and/or genres.
 *
 * Closed on purpose, same reasoning as genres.js: the backend drops
 * anything outside this set, so drift here surfaces as a 400 naming the
 * valid values rather than as a channel that never fills.
 */

export const TIPO_ORDER = [
  'show',
  'festa',
  'comedia',
  'teatro',
  'cinema',
  'literatura',
  'exposicao',
  'gastronomia',
  'oficina',
  'esporte',
  'kids',
  'feira',
  'outro',
]

export const TIPO_META = {
  show:        { label: 'Show',        emoji: '🎸' },
  festa:       { label: 'Festa',       emoji: '🪩' },
  comedia:     { label: 'Comédia',     emoji: '🎤' },
  teatro:      { label: 'Teatro',      emoji: '🎭' },
  cinema:      { label: 'Cinema',      emoji: '🎬' },
  literatura:  { label: 'Livros',      emoji: '📚' },
  exposicao:   { label: 'Exposição',   emoji: '🖼' },
  gastronomia: { label: 'Gastronomia', emoji: '🍽' },
  oficina:     { label: 'Oficina',     emoji: '🛠' },
  esporte:     { label: 'Esporte',     emoji: '🏃' },
  kids:        { label: 'Kids',        emoji: '🧒' },
  feira:       { label: 'Feira',       emoji: '🧺' },
  outro:       { label: 'Outro',       emoji: '✨' },
}

export function tipoLabel(tipo) {
  return TIPO_META[tipo]?.label || ''
}
