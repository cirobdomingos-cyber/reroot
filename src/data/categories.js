// Shared category taxonomy — keeps Events filter chips and the Sources
// page browser in sync. The id matches the `category` column on
// tracked_ig_accounts; emoji/label are display-only.
//
// Order here is the order chips appear (only categories with at least
// one tracked source / event show up — empty buckets hide).

export const CATEGORY_META = {
  bar:             { label: 'Bares',             emoji: '🍺' },
  cafe:            { label: 'Cafés',             emoji: '☕' },
  restaurante:     { label: 'Restaurantes',      emoji: '🍽' },
  musica:          { label: 'Música',            emoji: '🎵' },
  teatro:          { label: 'Teatros',           emoji: '🎭' },
  comedia:         { label: 'Comédia',           emoji: '🎤' },
  museu:           { label: 'Museus',            emoji: '🖼' },
  livraria:        { label: 'Livrarias',         emoji: '📚' },
  centro_cultural: { label: 'Centros Culturais', emoji: '🏛' },
  cinema:          { label: 'Cinema',            emoji: '🎬' },
  coletivo:        { label: 'Coletivos',         emoji: '🎲' },
  curador:         { label: 'Curadores',         emoji: '📰' },
  parque:          { label: 'Parques',           emoji: '🌿' },
  esporte:         { label: 'Esportes',          emoji: '🏃' },
  infantil:        { label: 'Família',           emoji: '👨‍👩‍👧' },
  comercial:       { label: 'Shoppings',         emoji: '🏬' },
  cultural:        { label: 'Cultural',          emoji: '✨' },
  outro:           { label: 'Outros',            emoji: '🔗' },
}

export const CATEGORY_ORDER = Object.keys(CATEGORY_META)

// Institutional sources don't carry a category column — map by id.
// Currently only aue_original is institutional after we dropped the
// web/scraper sources.
export const INST_CATEGORY = {
  aue_original: 'cultural',
}
