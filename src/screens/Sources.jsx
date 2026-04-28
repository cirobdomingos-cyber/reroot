import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchSources } from '../services/api'
import Avatar from '../components/Avatar'

// Unified browser for every catalog source — institutional scrapers AND
// Instagram handles, in one page, grouped by category. Replaces the
// old split-by-source-type view + the separate venue chips on Events
// (Bares & Cafés / Parques / Cinemas / Livrarias) which were redundant
// once tracked_ig_accounts became the canonical venue list.

// Category metadata — emoji + label used by the chip strip and the
// section headers. Order here is the order chips appear (for visible
// categories only — empty buckets hide automatically).
const CATEGORY_META = {
  bar:             { label: 'Bares',            emoji: '🍺' },
  cafe:            { label: 'Cafés',            emoji: '☕' },
  restaurante:     { label: 'Restaurantes',     emoji: '🍽' },
  musica:          { label: 'Música',           emoji: '🎵' },
  teatro:          { label: 'Teatros',          emoji: '🎭' },
  comedia:         { label: 'Comédia',          emoji: '🎤' },
  museu:           { label: 'Museus',           emoji: '🖼' },
  livraria:        { label: 'Livrarias',        emoji: '📚' },
  centro_cultural: { label: 'Centros Culturais', emoji: '🏛' },
  cinema:          { label: 'Cinema',           emoji: '🎬' },
  coletivo:        { label: 'Coletivos',        emoji: '🎲' },
  curador:         { label: 'Curadores',        emoji: '📰' },
  parque:          { label: 'Parques',          emoji: '🌿' },
  esporte:         { label: 'Esportes',         emoji: '🏃' },
  infantil:        { label: 'Família',          emoji: '👨‍👩‍👧' },
  comercial:       { label: 'Shoppings',        emoji: '🏬' },
  cultural:        { label: 'Cultural',         emoji: '✨' },
  outro:           { label: 'Outros',           emoji: '🔗' },
}
const CATEGORY_ORDER = Object.keys(CATEGORY_META)

// Institutional sources don't have a `category` field — map by id.
// New institutional sources get a slot here when added to the backend.
const INST_CATEGORY = {
  mon:              'museu',
  sesc:             'centro_cultural',
  teatro_guaira:    'teatro',
  eventbrite:       'curador',
  turismo_curitiba: 'curador',
  aue_original:     'cultural',
}

function categoryFor(source, isIg) {
  if (isIg) return (source.category || 'outro').toLowerCase()
  return INST_CATEGORY[source.id] || 'outro'
}


export default function Sources() {
  const navigate = useNavigate()
  const [data, setData] = useState({ institutional: [], instagram: [] })
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  // Active category chip — 'all' shows every category section; otherwise
  // only the chosen category renders. Independent of the search query
  // (search narrows further within whatever category is active).
  const [activeCategory, setActiveCategory] = useState('all')

  useEffect(() => {
    let cancelled = false
    fetchSources().then(d => {
      if (cancelled) return
      setData(d || { institutional: [], instagram: [] })
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // Normalize every source — institutional + IG — into a single shape so
  // the rest of the page is a flat list grouped by category. Each entry
  // tracks its own kind so the row renderer knows whether to show a
  // profile pic (IG) or an icon (institutional).
  const allSources = useMemo(() => {
    const inst = data.institutional.map(s => ({
      kind: 'inst',
      id: s.id,
      label: s.label,
      blurb: s.blurb,
      icon: s.icon,
      url: s.url,
      future_events: s.future_events,
      category: categoryFor(s, false),
      sortKey: s.label || s.id,
    }))
    const ig = data.instagram.map(s => ({
      kind: 'ig',
      id: `ig:${s.handle}`,
      handle: s.handle,
      label: s.label,
      blurb: s.category ? `@${s.handle} · ${s.category}` : `@${s.handle}`,
      profile_pic_url: s.profile_pic_url,
      url: s.url,
      future_events: s.future_events,
      category: categoryFor(s, true),
      sortKey: s.label || s.handle,
    }))
    return [...inst, ...ig]
  }, [data])

  const q = query.trim().toLowerCase()
  function passesSearch(s) {
    if (!q) return true
    const fields = [s.label, s.handle, s.blurb, s.id]
    return fields.some(f => (f || '').toLowerCase().includes(q))
  }

  // Bucket all sources by category so we can both: (1) show counts in
  // the chip strip, (2) render the grouped sections below.
  const buckets = useMemo(() => {
    const out = {}
    for (const s of allSources) {
      const cat = s.category in CATEGORY_META ? s.category : 'outro'
      if (!out[cat]) out[cat] = []
      out[cat].push(s)
    }
    for (const cat of Object.keys(out)) {
      out[cat].sort((a, b) => {
        // Most-events first, then alphabetical
        const yd = (b.future_events || 0) - (a.future_events || 0)
        if (yd !== 0) return yd
        return a.sortKey.localeCompare(b.sortKey)
      })
    }
    return out
  }, [allSources])

  // Visible categories — order from CATEGORY_ORDER, plus any unknown
  // categories pushed to the end. Only categories with ≥1 source show.
  const visibleCats = [
    ...CATEGORY_ORDER.filter(c => (buckets[c] || []).length > 0),
    ...Object.keys(buckets).filter(c => !CATEGORY_ORDER.includes(c) && buckets[c].length > 0),
  ]

  const totalSources = allSources.length
  const totalEvents = allSources.reduce((s, x) => s + (x.future_events || 0), 0)

  // Apply both filters (category chip + search). When the active chip is
  // 'all' we render every visible category section in order; otherwise
  // only the picked category.
  const renderedCats = activeCategory === 'all' ? visibleCats : [activeCategory]
  const renderedBuckets = renderedCats
    .map(cat => ({
      cat,
      items: (buckets[cat] || []).filter(passesSearch),
    }))
    .filter(b => b.items.length > 0)

  const noResults = q && renderedBuckets.length === 0

  return (
    <div style={{ padding: '20px 0 80px' }}>
      <div style={{ padding: '0 20px 14px' }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--charcoal-light)', fontSize: 13, padding: '4px 0', marginBottom: 8,
          }}
        >
          ← Voltar
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
          📡 Fontes monitoradas
        </h1>
        <div style={{ fontSize: 13, color: 'var(--charcoal-light)', marginTop: 4, lineHeight: 1.45 }}>
          {!loading && (
            <>{totalSources} {totalSources === 1 ? 'fonte' : 'fontes'} · {totalEvents} evento{totalEvents === 1 ? '' : 's'} próximo{totalEvents === 1 ? '' : 's'}</>
          )}
        </div>
      </div>

      {/* Search */}
      {!loading && (
        <div style={{ padding: '0 16px 10px', position: 'relative' }}>
          <input
            type="search"
            inputMode="search"
            placeholder="Buscar por nome, @handle ou categoria…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '11px 36px 11px 14px',
              fontSize: 13, fontFamily: 'inherit',
              background: 'white',
              border: '1px solid var(--border)', borderRadius: 12,
              outline: 'none', color: 'var(--charcoal)',
            }}
            aria-label="Buscar fontes"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Limpar busca"
              style={{
                position: 'absolute', right: 24, top: '50%',
                transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--charcoal-light)', fontSize: 16, padding: 4,
              }}
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Category chips — wraps to multiple rows so all categories are
          visible at once (no horizontal scroll). 'Tudo' first, then
          categories in defined order, only those with ≥1 source. */}
      {!loading && visibleCats.length > 1 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 6,
          padding: '0 16px 14px',
        }}>
          <CategoryChip
            label="🌍 Tudo"
            count={totalSources}
            active={activeCategory === 'all'}
            onClick={() => setActiveCategory('all')}
          />
          {visibleCats.map(cat => {
            const meta = CATEGORY_META[cat] || CATEGORY_META.outro
            const count = buckets[cat]?.length || 0
            return (
              <CategoryChip
                key={cat}
                label={`${meta.emoji} ${meta.label}`}
                count={count}
                active={activeCategory === cat}
                onClick={() => setActiveCategory(cat)}
              />
            )
          })}
        </div>
      )}

      {loading ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--charcoal-mid)', fontSize: 13 }}>
          Carregando…
        </div>
      ) : noResults ? (
        <div style={{
          margin: '0 16px', padding: '24px 16px', textAlign: 'center',
          background: 'white', borderRadius: 12, border: '1px dashed var(--border)',
          color: 'var(--charcoal-light)', fontSize: 13,
        }}>
          Nada com "{query}". Tenta uma palavra mais curta.
        </div>
      ) : renderedBuckets.length === 0 ? (
        <div style={{
          margin: '0 16px', padding: '24px 16px', textAlign: 'center',
          background: 'white', borderRadius: 12, border: '1px dashed var(--border)',
          color: 'var(--charcoal-light)', fontSize: 13,
        }}>
          Nenhuma fonte ainda nesta categoria.
        </div>
      ) : (
        renderedBuckets.map(({ cat, items }) => {
          const meta = CATEGORY_META[cat] || CATEGORY_META.outro
          const eventCount = items.reduce((sum, s) => sum + (s.future_events || 0), 0)
          return (
            <Section
              key={cat}
              title={`${meta.emoji} ${meta.label} · ${items.length}`}
              sub={eventCount > 0 ? `${eventCount} evento${eventCount === 1 ? '' : 's'} próximo${eventCount === 1 ? '' : 's'}` : ''}
            >
              {items.map(s => (
                <SourceRow
                  key={s.id}
                  source={s}
                  onOpen={() => navigate(`/sources/${encodeURIComponent(s.id)}`)}
                />
              ))}
            </Section>
          )
        })
      )}
    </div>
  )
}


function CategoryChip({ label, count, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px', borderRadius: 16,
        fontSize: 11, fontWeight: 600, cursor: 'pointer',
        transition: 'all 0.15s',
        border: active ? 'none' : '1px solid var(--border)',
        background: active ? 'var(--charcoal)' : 'transparent',
        color: active ? 'white' : 'var(--charcoal-light)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}{count > 0 && ` · ${count}`}
    </button>
  )
}


function Section({ title, sub, children }) {
  return (
    <div style={{ margin: '8px 0 18px' }}>
      <div style={{ padding: '0 20px 6px' }}>
        <div className="section-label" style={{ marginLeft: 0 }}>{title}</div>
        {sub && (
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
            {sub}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px' }}>
        {children}
      </div>
    </div>
  )
}


function SourceRow({ source: s, onOpen }) {
  const isIg = s.kind === 'ig'
  return (
    <div
      onClick={onOpen}
      style={{
        background: 'white', borderRadius: 14,
        border: '1px solid var(--border)',
        padding: '12px 14px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      {isIg ? (
        <Avatar src={s.profile_pic_url} name={s.label} size={40} />
      ) : (
        <div style={{
          width: 40, height: 40, borderRadius: 11, flexShrink: 0,
          background: 'var(--cream)', fontSize: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {s.icon}
        </div>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {s.label}
        </div>
        {s.blurb && (
          <div style={{
            fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2,
            lineHeight: 1.35,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {s.blurb}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{
          fontSize: 11, fontWeight: 700,
          background: s.future_events > 0 ? 'var(--terra-pale)' : 'transparent',
          color: s.future_events > 0 ? 'var(--terra)' : 'var(--charcoal-light)',
          padding: s.future_events > 0 ? '3px 8px' : 0,
          borderRadius: 7,
          minWidth: 20, textAlign: 'center',
        }}>
          {s.future_events}
        </span>
        {s.url && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              window.open(s.url, '_blank', 'noopener')
            }}
            title="Abrir site oficial"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 14, color: 'var(--charcoal-light)', padding: 4,
            }}
          >
            ↗
          </button>
        )}
      </div>
    </div>
  )
}
