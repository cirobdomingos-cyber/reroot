import { useState } from 'react'
import { API_BASE } from '../lib/apiBase'
import { CATEGORY_ORDER } from '../data/categories'

// "+ Adicionar nova fonte do Instagram" — the curator's way to grow the
// catalog. Lived on the Fontes screen, which is now for looking; it
// mounts in Curadoria -> Contas @, where the rest of the account tools
// are. `flush` drops the page-gutter padding it carried on Fontes.

const CATEGORY_PRESETS = CATEGORY_ORDER

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: '9px 12px',
  fontSize: 13, fontFamily: 'inherit',
  background: 'var(--white)',
  border: '1px solid var(--border)', borderRadius: 10,
  outline: 'none', color: 'var(--charcoal)',
}

export default function AddHandleForm({ email, onAdded, flush = false }) {
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
      <div style={{ padding: flush ? '0 0 12px' : '0 16px 12px' }}>
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
        margin: flush ? '0 0 14px' : '0 16px 14px', padding: '14px',
        background: 'var(--white)', borderRadius: 14,
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
