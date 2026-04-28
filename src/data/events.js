// Static fallback for the live event catalog.
//
// The live source of truth is the FastAPI backend (multiple scrapers + Apify
// Instagram pipeline). This array used to hold ~15 hand-written "Reroot
// Original" events with hardcoded April 2026 dates — those went stale and now
// live in the backend's `tracked_ig_accounts` seed plus a database-side seed
// of evergreen suggestions (see `backend/seed_events.py`).
//
// Keeping this as an empty array means: when the backend is unreachable, the
// frontend simply shows "Nada por aqui" instead of stale events with bad
// dates. Honest > pretending.
export const EVENTS = []

// MOODS — high-level filter chips on the Events screen. Each id maps to a
// backend `mood` query param (handled in main.py:_mood_predicate). The
// 4 kind-based moods replace the old CATEGORIES of the same names; the
// 2 newer ones (cultural, familia) are filter combinations applied at the
// API layer. The venue chips (bars_cafes / parks / cinema / bookstore)
// were removed — venue browsing now lives on the Sources screen, which
// is the canonical "where things come from" surface.
export const MOODS = [
  { id: 'all',         label: '🌍 Tudo' },
  { id: 'tranquilo',   label: '🌿 Tranquilo' },
  { id: 'ativo',       label: '🏃 Ativo' },
  { id: 'criativo',    label: '🎨 Criativo' },
  { id: 'comunidade',  label: '🤝 Comunidade' },
  { id: 'cultural',    label: '🎭 Cultural' },
  { id: 'familia',     label: '👨‍👩‍👧 Família' },
]

// Legacy alias — kept until every screen migrates to MOODS.
export const CATEGORIES = MOODS

export const DATE_FILTERS = [
  { id: 'all',           label: 'Todas datas' },
  { id: 'this_week',     label: 'Esta semana' },
  { id: 'this_weekend',  label: 'Fim de semana' },
  { id: 'next_week',     label: 'Próxima semana' },
  { id: 'anytime',       label: 'Sempre aberto' },
]
