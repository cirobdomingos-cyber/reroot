import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchSources } from '../services/api'
import { useApp } from '../context/AppContext'
import { CATEGORY_META, CATEGORY_ORDER, INST_CATEGORY } from '../data/categories'
import Avatar from '../components/Avatar'

const API_BASE = import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? 'http://localhost:8000' : '')

// Add-handle form preset list: same taxonomy as CATEGORY_META, ordered.
// Kept in sync automatically since both come from the shared module.
const CATEGORY_PRESETS = CATEGORY_ORDER

// Unified browser for every catalog source — institutional + Instagram
// handles, grouped by category. Same taxonomy as the Events tab filter
// chips (both import CATEGORY_META from src/data/categories).

function categoryFor(source, isIg) {
  if (isIg) return (source.category || 'outro').toLowerCase()
  return INST_CATEGORY[source.id] || 'outro'
}


export default function Sources() {
  const navigate = useNavigate()
  const { state } = useApp()
  const email = state.googleUser?.email || ''
  const [data, setData] = useState({ institutional: [], instagram: [] })
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  // Active category chip — 'all' shows every category section; otherwise
  // only the chosen category renders. Independent of the search query
  // (search narrows further within whatever category is active).
  const [activeCategory, setActiveCategory] = useState('all')

  // Curator status — when true, the page renders a top 'Adicionar @
  // handle' form so curators can grow the catalog without needing the
  // full Curar tab (which is now founder-only). Both is_curator and
  // is_founder grant the form; the backend's POST /admin/ig-accounts
  // accepts either role.
  const [canCurate, setCanCurate] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchSources().then(d => {
      if (cancelled) return
      setData(d || { institutional: [], instagram: [] })
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // Determine curator/founder role on mount + when the user changes.
  useEffect(() => {
    if (!email) { setCanCurate(false); return }
    let cancelled = false
    fetch(`${API_BASE}/admin/curators?requesting_email=${encodeURIComponent(email)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return
        setCanCurate(!!(d?.is_curator || d?.is_founder))
      })
      .catch(() => { if (!cancelled) setCanCurate(false) })
    return () => { cancelled = true }
  }, [email])

  // Refresh sources after a successful add so the new handle shows up
  // immediately without a manual reload.
  function refreshSources() {
    fetchSources().then(d => setData(d || { institutional: [], instagram: [] }))
  }

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

      {/* Curator add-handle form — only renders when the user is a
          curator or founder. Mirrors the form on the Curar tab so the
          two paths share the same UX. */}
      {!loading && canCurate && (
        <AddHandleForm email={email} onAdded={refreshSources} />
      )}

      {/* Curator-only: list of venues missing coordinates. Pin-on-map
          editor opens when one's tapped. */}
      {!loading && canCurate && (
        <UngeocodedVenues email={email} />
      )}

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


function AddHandleForm({ email, onAdded }) {
  const [open, setOpen] = useState(false)
  const [handle, setHandle] = useState('')
  const [label, setLabel] = useState('')
  const [category, setCategory] = useState('bar')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const cleanHandle = handle.trim().replace(/^@/, '')
    if (!/^[A-Za-z0-9._]{1,30}$/.test(cleanHandle)) {
      setFeedback({ kind: 'err', msg: 'Handle inválido (letras, números, "." ou "_")' })
      return
    }
    setSubmitting(true)
    setFeedback(null)
    try {
      const r = await fetch(`${API_BASE}/admin/ig-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          handle: cleanHandle,
          label: label.trim(),
          category,
          enabled: true,
          notes: '',
          requesting_email: email,
        }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        setFeedback({ kind: 'err', msg: err.detail || `HTTP ${r.status}` })
      } else {
        setFeedback({ kind: 'ok', msg: `@${cleanHandle} adicionado.` })
        setHandle(''); setLabel('')
        onAdded?.()
        setTimeout(() => setFeedback(null), 3500)
      }
    } catch (e) {
      setFeedback({ kind: 'err', msg: e?.message || 'Erro ao adicionar' })
    } finally {
      setSubmitting(false)
    }
  }

  // Collapsed state: a single-line "+" pill so the form doesn't dominate
  // the page for browsing curators. Tapping expands to the full form.
  if (!open) {
    return (
      <div style={{ padding: '0 16px 12px' }}>
        <button
          onClick={() => setOpen(true)}
          style={{
            width: '100%', padding: '10px 14px',
            background: 'var(--terra-pale)', color: 'var(--terra)',
            border: '1.5px dashed var(--terra)',
            borderRadius: 12, cursor: 'pointer',
            fontSize: 13, fontWeight: 700, letterSpacing: 0.3,
          }}
        >
          + Adicionar nova fonte do Instagram
        </button>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      style={{
        margin: '0 16px 14px', padding: '14px',
        background: 'white', borderRadius: 14,
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
          Nova fonte do Instagram
        </div>
        <button
          type="button"
          onClick={() => { setOpen(false); setFeedback(null) }}
          aria-label="Fechar"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--charcoal-light)', fontSize: 16, padding: 4,
          }}
        >✕</button>
      </div>
      <input
        value={handle}
        onChange={e => setHandle(e.target.value)}
        placeholder="@handle"
        autoCapitalize="none"
        autoCorrect="off"
        style={inputStyle}
      />
      <input
        value={label}
        onChange={e => setLabel(e.target.value)}
        placeholder="Nome (opcional, ex: Café Lucca)"
        style={{ ...inputStyle, marginTop: 8 }}
      />
      <select
        value={category}
        onChange={e => setCategory(e.target.value)}
        style={{ ...inputStyle, marginTop: 8 }}
      >
        {CATEGORY_PRESETS.map(c => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      {feedback && (
        <div style={{
          marginTop: 10, padding: '7px 10px',
          background: feedback.kind === 'ok' ? 'var(--sage-pale)' : '#FFF3E0',
          color: feedback.kind === 'ok' ? 'var(--sage)' : '#BF360C',
          borderRadius: 8, fontSize: 12, textAlign: 'center',
        }}>
          {feedback.msg}
        </div>
      )}
      <button
        type="submit"
        disabled={submitting || !handle.trim()}
        style={{
          width: '100%', marginTop: 10, padding: '11px',
          background: 'var(--terra)', color: 'white',
          border: 'none', borderRadius: 12,
          fontSize: 13, fontWeight: 700,
          cursor: submitting ? 'wait' : 'pointer',
          opacity: (submitting || !handle.trim()) ? 0.55 : 1,
        }}
      >
        {submitting ? 'Adicionando…' : 'Adicionar'}
      </button>
    </form>
  )
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: '9px 12px',
  fontSize: 13, fontFamily: 'inherit',
  background: 'white',
  border: '1px solid var(--border)', borderRadius: 10,
  outline: 'none', color: 'var(--charcoal)',
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


// ── Curator UI: ungeocoded venues + manual fix sheet ──────────────────

const CTBA_CENTER = [-25.4284, -49.2733]

function UngeocodedVenues({ email }) {
  const [venues, setVenues] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(null)  // venue dict or null

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch(
        `${API_BASE}/admin/venues?requesting_email=${encodeURIComponent(email)}&status=pending`,
      )
      if (r.ok) {
        const data = await r.json()
        setVenues(data.venues || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }
  useEffect(() => { load() }, [email])

  if (loading) return null
  if (!venues.length) return null

  // Default: collapsed strip showing just the count + a "Ver lista" link.
  // Expanded: scrollable list with click-to-edit. Editor sheet (with the
  // pin-on-map) opens for the picked venue.
  const visible = expanded ? venues : venues.slice(0, 6)

  return (
    <div style={{
      margin: '0 16px 14px', padding: '12px 14px',
      background: '#FFF8E1', border: '1px solid #FFD54F',
      borderRadius: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, marginBottom: 8,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#8D6E10' }}>
          📍 {venues.length} local{venues.length === 1 ? '' : 'ais'} sem coordenadas
        </div>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 700, color: '#8D6E10',
          }}
        >
          {expanded ? '− Esconder' : '+ Ver lista'}
        </button>
      </div>
      <div style={{
        fontSize: 11, color: '#8D6E10', marginBottom: 10, lineHeight: 1.4,
      }}>
        O Nominatim não achou esses locais. Toca pra colocar a coordenada
        manualmente — pode digitar o endereço, lat/lng, ou pinar direto no
        mapa.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.map(v => (
          <button
            key={v.name_normalized}
            onClick={() => setEditing(v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', background: 'white',
              border: '1px solid var(--border)', borderRadius: 8,
              cursor: 'pointer', textAlign: 'left',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 600, color: 'var(--charcoal)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {v.name_original}
              </div>
              <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
                {v.event_count} evento{v.event_count === 1 ? '' : 's'}
                {v.attempt_count > 0 && ` · ${v.attempt_count} tentativa${v.attempt_count === 1 ? '' : 's'}`}
              </div>
            </div>
            <span style={{ fontSize: 14, color: 'var(--charcoal-light)' }}>→</span>
          </button>
        ))}
        {!expanded && venues.length > visible.length && (
          <button
            onClick={() => setExpanded(true)}
            style={{
              padding: '6px', background: 'none', border: 'none',
              cursor: 'pointer', fontSize: 11, color: '#8D6E10', fontWeight: 700,
            }}
          >
            + {venues.length - visible.length} mais
          </button>
        )}
      </div>
      {editing && (
        <VenueLocationSheet
          venue={editing}
          email={email}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}

// Hook component — react-leaflet's way to attach a click handler to the
// MapContainer. Drops a pin where the user tapped.
function MapClickHandler({ onClick }) {
  useMapEvents({ click: (e) => onClick(e.latlng) })
  return null
}

const _pinIcon = L.divIcon({
  className: 'aue-edit-pin',
  html: `<div style="
    display:flex;align-items:center;justify-content:center;
    width:34px;height:34px;
    background:var(--terra,#E8623F);color:white;
    border:2px solid white;border-radius:50%;
    font-size:16px;box-shadow:0 2px 6px rgba(0,0,0,0.25);
  ">📍</div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17],
})

function VenueLocationSheet({ venue, email, onClose, onSaved }) {
  const [address, setAddress] = useState(venue.address || '')
  const [lat, setLat] = useState(venue.lat ?? null)
  const [lng, setLng] = useState(venue.lng ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  function setFromMap(latlng) {
    setLat(Number(latlng.lat.toFixed(6)))
    setLng(Number(latlng.lng.toFixed(6)))
  }

  async function retryNominatim() {
    setError(null); setBusy(true)
    try {
      // Save the address first if it changed — gives Nominatim better input.
      if ((address || '') !== (venue.address || '')) {
        await fetch(
          `${API_BASE}/admin/venues/${encodeURIComponent(venue.name_normalized)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requesting_email: email,
              lat: null, lng: null, address,
            }),
          },
        )
      }
      const r = await fetch(
        `${API_BASE}/admin/venues/${encodeURIComponent(venue.name_normalized)}/geocode?requesting_email=${encodeURIComponent(email)}`,
        { method: 'POST' },
      )
      const data = await r.json()
      if (data.ok) {
        setLat(data.lat); setLng(data.lng)
      } else {
        setError('Nominatim ainda não achou. Tenta pinar no mapa abaixo.')
      }
    } catch (e) {
      setError(e?.message || 'Falha ao buscar')
    }
    setBusy(false)
  }

  async function save() {
    if (lat == null || lng == null) {
      setError('Defina uma coordenada antes de salvar (ou pina no mapa).')
      return
    }
    setError(null); setBusy(true)
    try {
      const r = await fetch(
        `${API_BASE}/admin/venues/${encodeURIComponent(venue.name_normalized)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requesting_email: email,
            lat: Number(lat), lng: Number(lng),
            address: address || undefined,
          }),
        },
      )
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      onSaved?.()
    } catch (e) {
      setError(e?.message || 'Falha ao salvar')
    }
    setBusy(false)
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999,
      }} />
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'white', borderRadius: '20px 20px 0 0',
        padding: '14px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
        zIndex: 1000, maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(44,44,44,0.18)' }} />
        </div>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>
          {venue.name_original}
        </h2>
        <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginBottom: 12 }}>
          {venue.event_count} evento{venue.event_count === 1 ? '' : 's'} ·{' '}
          {venue.geocode_status === 'failed' ? 'Nominatim falhou' : 'sem tentativa ainda'}
        </div>

        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)' }}>
          Endereço (opcional, ajuda o Nominatim)
        </label>
        <input
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="Rua XV de Novembro, 123, Curitiba"
          style={_inputStyle}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            onClick={retryNominatim}
            disabled={busy}
            style={_secondaryBtn}
          >
            🔁 Tentar Nominatim
          </button>
        </div>

        <div style={{ marginTop: 14, marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)', marginBottom: 4 }}>
            Pinar no mapa (toque pra mover)
          </div>
          <div style={{
            height: 280, borderRadius: 10, overflow: 'hidden',
            border: '1px solid var(--border)',
          }}>
            <MapContainer
              center={lat != null && lng != null ? [lat, lng] : CTBA_CENTER}
              zoom={lat != null ? 16 : 12}
              style={{ height: '100%', width: '100%' }}
            >
              <TileLayer
                attribution='&copy; OpenStreetMap'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapClickHandler onClick={setFromMap} />
              {lat != null && lng != null && (
                <Marker position={[lat, lng]} icon={_pinIcon} />
              )}
            </MapContainer>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)' }}>
              Latitude
            </label>
            <input
              value={lat ?? ''}
              onChange={e => setLat(e.target.value === '' ? null : Number(e.target.value))}
              type="number"
              step="any"
              placeholder="-25.4284"
              style={_inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)' }}>
              Longitude
            </label>
            <input
              value={lng ?? ''}
              onChange={e => setLng(e.target.value === '' ? null : Number(e.target.value))}
              type="number"
              step="any"
              placeholder="-49.2733"
              style={_inputStyle}
            />
          </div>
        </div>

        {error && (
          <div style={{
            marginTop: 10, padding: '8px 12px', background: '#FFEBEE',
            color: '#B71C1C', borderRadius: 8, fontSize: 12,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} disabled={busy} style={_secondaryBtn}>
            Cancelar
          </button>
          <button onClick={save} disabled={busy} style={_primaryBtn}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}

const _inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: '8px 10px', borderRadius: 8,
  border: '1px solid var(--border)', fontSize: 13,
  background: 'white', color: 'var(--charcoal)', outline: 'none',
  marginTop: 4,
}

const _secondaryBtn = {
  flex: 1, padding: '10px 14px', borderRadius: 10,
  border: '1px solid var(--border)', background: 'white',
  fontSize: 13, fontWeight: 600, color: 'var(--charcoal)',
  cursor: 'pointer',
}

const _primaryBtn = {
  flex: 1, padding: '10px 14px', borderRadius: 10,
  border: 'none', background: 'var(--terra)',
  fontSize: 13, fontWeight: 700, color: 'white',
  cursor: 'pointer',
}
