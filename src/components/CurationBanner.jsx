import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { API_BASE } from '../lib/apiBase'

// One strip, for curators, saying how many scraped events are in the
// catalog without a curator's pass yet. Informative, not a gate: the
// events are already public. One strip — the alternative was an inbox
// item per event, twenty-odd on a normal day, which is spam by another
// name. Hidden for everyone else and when the queue is empty.
export default function CurationBanner() {
  const { state } = useApp()
  const navigate = useNavigate()
  const email = state.googleUser?.email || ''
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!email) { setCount(0); return }
    let cancelled = false
    const q = `requesting_email=${encodeURIComponent(email)}`
    fetch(`${API_BASE}/admin/curators?${q}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (cancelled || !(d?.is_curator || d?.is_founder)) return null
        return fetch(`${API_BASE}/admin/catalog-requests?status=review&${q}`)
          .then(r => (r.ok ? r.json() : null))
      })
      .then(d => { if (!cancelled && d) setCount((d.requests || []).length) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [email])

  if (!count) return null
  return (
    <button
      onClick={() => navigate('/curadoria')}
      data-testid="curation-banner"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        margin: '14px 18px 0', padding: '12px 14px', borderRadius: 14,
        border: '1px solid var(--magenta)', background: 'var(--magenta-soft)',
        color: 'var(--text)', cursor: 'pointer', textAlign: 'left', width: 'calc(100% - 36px)',
      }}
    >
      <span>
        <span className="neon-mono" style={{
          display: 'block', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
          color: 'var(--magenta)', marginBottom: 2,
        }}>
          Curadoria
        </span>
        <span style={{ fontSize: 14, fontWeight: 700 }}>
          {count} {count === 1 ? 'evento novo sem curadoria' : 'eventos novos sem curadoria'}
        </span>
      </span>
      <span style={{ fontSize: 18, color: 'var(--text3)' }}>›</span>
    </button>
  )
}
