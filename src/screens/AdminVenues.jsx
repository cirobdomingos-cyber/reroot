import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { API_BASE } from '../lib/apiBase'

// Curator surface for venue pins.
//
// Why it exists: since Sep 2026 the bairro shown next to a venue comes
// from the geocoded `venues` row rather than the enrichment guess, which
// made a missing pin the remaining cause of a wrong-looking event. A
// seed + geocode pass on production left 36 venues Nominatim can't
// resolve, and `PUT /admin/venues/{name}` had existed all along with no
// UI — the only frontend caller of /admin/venues was the leaderboard.
//
// Ordered by event count descending (the backend sorts), so the first
// row on the screen is the pin that fixes the most events.
//
// Coordinates are parsed server-side from pasted text — see
// _parse_coords_text in backend/main.py. This screen just hands over
// whatever is on the clipboard.

const STATUS_TABS = [
  ['pending', 'Pendentes'],
  ['ok', 'Resolvidos'],
  ['all', 'Todos'],
]

export default function AdminVenues() {
  const navigate = useNavigate()
  const { state } = useApp()
  const email = state.googleUser?.email || ''

  const [status, setStatus] = useState('pending')
  const [venues, setVenues] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [allowed, setAllowed] = useState(null)   // null = still checking

  const reload = useCallback(async () => {
    if (!email) return
    setLoading(true)
    try {
      const r = await fetch(
        `${API_BASE}/admin/venues?requesting_email=${encodeURIComponent(email)}&status=${status}`,
      )
      if (r.status === 401 || r.status === 403) { setAllowed(false); return }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setAllowed(true)
      setVenues(data.venues || [])
      setError('')
    } catch (e) {
      setError(`Falha ao carregar: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [email, status])

  useEffect(() => { reload() }, [reload])

  // Batch actions. Each is idempotent on the backend, so a double tap
  // costs a round trip and nothing else.
  async function runBatch(path, label) {
    setBusy(true); setError(''); setNotice('')
    try {
      const r = await fetch(
        `${API_BASE}${path}${path.includes('?') ? '&' : '?'}requesting_email=${encodeURIComponent(email)}`,
        { method: 'POST' },
      )
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`)
      setNotice(`${label}: ${JSON.stringify(body)}`)
      await reload()
    } catch (e) {
      setError(`${label} falhou: ${e.message}`)
    }
    setBusy(false)
  }

  if (!email) {
    return <Shell onBack={() => navigate('/admin/ig')}>
      <Empty>Entra com a tua conta pra ver esta tela.</Empty>
    </Shell>
  }
  if (allowed === false) {
    return <Shell onBack={() => navigate('/admin/ig')}>
      <Empty>Esta tela é só pra curadores.</Empty>
    </Shell>
  }

  const pendingCount = venues.filter(v => v.geocode_status !== 'ok').length
  const noBairro = venues.filter(v => v.lat && !(v.bairro || '').trim()).length

  return (
    <Shell onBack={() => navigate('/admin/ig')}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--charcoal)', marginBottom: 4 }}>
        Locais e pins
      </h2>
      <p style={{ fontSize: 12, color: 'var(--charcoal-light)', lineHeight: 1.5, marginBottom: 14 }}>
        O bairro que aparece no evento vem daqui. Sem pin, o app cai no
        palpite da extração — e o palpite erra.
      </p>

      {/* Batch pass, in the order it makes sense to run:
          register missing venues -> geocode them -> fill bairros for
          pins that came back without one. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <BatchBtn busy={busy} onClick={() => runBatch('/admin/venues/seed', 'Registrar')}>
          1 · Registrar faltantes
        </BatchBtn>
        <BatchBtn busy={busy} onClick={() => runBatch('/admin/venues/geocode?limit=25', 'Geocodificar')}>
          2 · Geocodificar (25)
        </BatchBtn>
        <BatchBtn busy={busy} onClick={() => runBatch('/admin/venues/backfill-bairros?limit=40', 'Bairros')}>
          3 · Preencher bairros
        </BatchBtn>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {STATUS_TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setStatus(key)}
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 10, fontSize: 12, fontWeight: 700,
              border: '1.5px solid var(--border)', cursor: 'pointer',
              background: status === key ? 'var(--sage)' : 'transparent',
              color: status === key ? 'var(--on-lime)' : 'var(--charcoal-mid)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {notice && <Banner tone="ok">{notice}</Banner>}
      {error && <Banner tone="bad">{error}</Banner>}

      {!loading && (
        <p style={{ fontSize: 11, color: 'var(--charcoal-light)', marginBottom: 10 }}>
          {venues.length} local(is){pendingCount ? ` · ${pendingCount} sem pin` : ''}
          {noBairro ? ` · ${noBairro} com pin mas sem bairro` : ''}
        </p>
      )}

      {loading && <Empty>Carregando…</Empty>}
      {!loading && venues.length === 0 && <Empty>Nada aqui.</Empty>}

      {venues.map(v => (
        <VenueRow
          key={v.name_normalized}
          venue={v}
          email={email}
          onChanged={reload}
        />
      ))}
    </Shell>
  )
}

function VenueRow({ venue: v, email, onChanged }) {
  const [open, setOpen] = useState(false)
  const [coordsText, setCoordsText] = useState('')
  const [address, setAddress] = useState(v.address || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [suggestion, setSuggestion] = useState(null)

  const resolved = v.geocode_status === 'ok'
  // A pin with no bairro is only half-fixed: the event still falls back
  // to the enrichment guess for the label. Call it out on the row.
  const halfFixed = resolved && !(v.bairro || '').trim()

  async function call(path, options, label) {
    setBusy(true); setErr('')
    try {
      const r = await fetch(`${API_BASE}${path}`, options)
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`)
      return body
    } catch (e) {
      setErr(`${label}: ${e.message}`)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    const body = await call(
      `/admin/venues/${encodeURIComponent(v.name_normalized)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requesting_email: email,
          coords_text: coordsText || null,
          address: address.trim() || null,
        }),
      },
      'Salvar',
    )
    if (body) { setCoordsText(''); setSuggestion(null); setOpen(false); onChanged() }
  }

  async function retryGeocode() {
    const body = await call(
      `/admin/venues/${encodeURIComponent(v.name_normalized)}/geocode?requesting_email=${encodeURIComponent(email)}`,
      { method: 'POST' },
      'Geocodificar',
    )
    if (body) onChanged()
  }

  async function aiLookup() {
    const body = await call(
      `/admin/venues/${encodeURIComponent(v.name_normalized)}/ai-lookup?requesting_email=${encodeURIComponent(email)}`,
      { method: 'POST' },
      'IA',
    )
    // The backend deliberately doesn't write — it suggests, the curator
    // reviews. Prefill the fields and let them press Salvar.
    if (body?.ok && body.lat && body.lng) {
      setSuggestion(body)
      setCoordsText(`${body.lat}, ${body.lng}`)
      if (body.address) setAddress(body.address)
    } else if (body) {
      setErr('IA não soube dizer onde fica.')
    }
  }

  return (
    <div style={{
      background: 'var(--white)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 12, marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {v.name_original}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
            {v.event_count} evento(s)
            {v.bairro ? ` · ${v.bairro}` : ''}
            {halfFixed ? ' · pin sem bairro' : ''}
            {!resolved ? ` · ${v.attempt_count || 0} tentativa(s)` : ''}
          </div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 8,
          background: resolved ? (halfFixed ? '#FFF3E0' : '#E8F5E9') : '#FFEBEE',
          color: resolved ? (halfFixed ? '#E65100' : '#1B5E20') : '#B71C1C',
        }}>
          {resolved ? (halfFixed ? 'PARCIAL' : 'OK') : 'SEM PIN'}
        </span>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
            border: '1.5px solid var(--border)', background: 'transparent',
            color: 'var(--charcoal-mid)', cursor: 'pointer',
          }}
        >
          {open ? 'Fechar' : '📍'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <Label>Coordenadas</Label>
            <input
              value={coordsText}
              onChange={e => setCoordsText(e.target.value)}
              placeholder="Cola o link do Google Maps ou -25.42, -49.27"
              style={inputStyle}
            />
            <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginTop: 3, lineHeight: 1.4 }}>
              No Google Maps: botão direito no lugar → “copiar coordenadas”.
              O link da barra de endereço também serve.
            </div>
          </div>

          <div>
            <Label>Endereço</Label>
            <input
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="Rua, número, bairro"
              style={inputStyle}
            />
            <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginTop: 3 }}>
              Melhorar o endereço e tentar de novo costuma resolver sem pin manual.
            </div>
          </div>

          {suggestion && (
            <Banner tone="ok">
              IA sugeriu ({suggestion.confidence}): {suggestion.address || 'sem endereço'}
              {suggestion.notes ? ` — ${suggestion.notes}` : ''}. Confere e salva.
            </Banner>
          )}
          {err && <Banner tone="bad">{err}</Banner>}

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <RowBtn busy={busy} onClick={save} primary>Salvar</RowBtn>
            <RowBtn busy={busy} onClick={retryGeocode}>Tentar Nominatim</RowBtn>
            <RowBtn busy={busy} onClick={aiLookup}>Perguntar pra IA</RowBtn>
          </div>
        </div>
      )}
    </div>
  )
}

// ── bits ────────────────────────────────────────────────────────────

function Shell({ children, onBack }) {
  return (
    <div style={{ padding: '16px 16px 90px', maxWidth: 720, margin: '0 auto' }}>
      <button
        onClick={onBack}
        style={{
          background: 'none', border: 'none', color: 'var(--charcoal-mid)',
          fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '4px 0 12px',
        }}
      >
        ← Admin
      </button>
      {children}
    </div>
  )
}

function Empty({ children }) {
  return (
    <p style={{ fontSize: 13, color: 'var(--charcoal-light)', textAlign: 'center', padding: '28px 0' }}>
      {children}
    </p>
  )
}

function Banner({ tone, children }) {
  const ok = tone === 'ok'
  return (
    <div style={{
      padding: '9px 11px', borderRadius: 10, marginBottom: 10, fontSize: 11, lineHeight: 1.45,
      background: ok ? '#E8F5E9' : '#FFEBEE',
      border: `1px solid ${ok ? '#A5D6A7' : '#EF9A9A'}`,
      color: ok ? '#1B5E20' : '#B71C1C',
      wordBreak: 'break-word',
    }}>
      {children}
    </div>
  )
}

function Label({ children }) {
  return (
    <label style={{
      display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: 0.3,
      color: 'var(--charcoal-mid)', marginBottom: 4,
    }}>
      {children.toUpperCase()}
    </label>
  )
}

function BatchBtn({ children, busy, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        flex: '1 1 auto', padding: '9px 10px', borderRadius: 10,
        border: '1.5px solid var(--border)', background: 'transparent',
        color: 'var(--charcoal-mid)', fontSize: 11, fontWeight: 700,
        cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}

function RowBtn({ children, busy, onClick, primary }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        flex: 1, padding: '9px 10px', borderRadius: 10, fontSize: 12, fontWeight: 700,
        border: primary ? 'none' : '1.5px solid var(--border)',
        background: primary ? 'var(--terra)' : 'transparent',
        color: primary ? 'white' : 'var(--charcoal-mid)',
        cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}

const inputStyle = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 10,
  border: '1.5px solid var(--border)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
  background: 'var(--cream)',
  color: 'var(--charcoal)',
}
