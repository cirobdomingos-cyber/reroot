import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { API_BASE } from '../lib/apiBase'

// Curator review queue for the public catalog.
//
// When someone creates a group or plan event from an Instagram link, the
// private event goes live immediately and the post is suggested for the
// catalog. Curators get a push that opens /curadoria/<id>: enough detail to
// decide quickly, the Instagram link to check the source, fields they can
// fix before publishing, and the option to start tracking the account.
//
// Identity follows the rest of the admin surface: state.googleUser.email is
// sent as requesting_email and the backend checks the curator role.

function withEmail(url, email) {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}requesting_email=${encodeURIComponent(email)}`
}

async function readJson(res) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || `Erro ${res.status}`)
  return data
}

// Event dates are stored as Curitiba wall-clock time, so parse them as
// local — appending no timezone is deliberate.
function fmtWhen(iso) {
  if (!iso) return 'sem data'
  const d = new Date(String(iso).slice(0, 19))
  if (Number.isNaN(d.getTime())) return iso
  const day = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return `${day} · ${time}`
}

// For real timestamps (created_at, reviewed_at): stored as UTC with an
// offset, so let Date convert to the viewer's local time.
function fmtStamp(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

const page = { padding: '16px 16px 110px', color: 'var(--text)', minHeight: '100%' }
const card = {
  background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 14,
  padding: 12, display: 'flex', gap: 12, alignItems: 'center',
}
const label = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 6 }
const input = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
  border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--text)',
  fontSize: 14, fontFamily: 'inherit',
}

export default function CatalogReview() {
  const { state } = useApp()
  const email = state.googleUser?.email || ''
  const { requestId } = useParams()
  const navigate = useNavigate()
  // loading | signed_out | not_curator | curator
  const [role, setRole] = useState('loading')

  useEffect(() => {
    if (!email) { setRole('signed_out'); return }
    let cancelled = false
    fetch(withEmail(`${API_BASE}/admin/curators`, email))
      .then(readJson)
      .then(d => { if (!cancelled) setRole(d.is_curator ? 'curator' : 'not_curator') })
      .catch(() => { if (!cancelled) setRole('not_curator') })
    return () => { cancelled = true }
  }, [email])

  return (
    <div style={page}>
      <button
        onClick={() => navigate(requestId ? '/curadoria' : -1)}
        style={{ background: 'none', border: 'none', color: 'var(--cyan)', fontSize: 14, padding: 0, marginBottom: 12, cursor: 'pointer' }}
      >
        ← {requestId ? 'Todos os pedidos' : 'Voltar'}
      </button>
      <h2 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 14px' }}>Curadoria do catálogo</h2>

      {role === 'loading' && <Muted>Carregando…</Muted>}
      {role === 'signed_out' && <Muted>Entra com a sua conta de curador pra ver os pedidos.</Muted>}
      {role === 'not_curator' && <Muted>Essa área é só pra curadores do auê.</Muted>}
      {role === 'curator' && (requestId
        ? <RequestDetail key={requestId} id={requestId} email={email} />
        : <RequestList email={email} />)}
    </div>
  )
}

function Muted({ children }) {
  return <div style={{ fontSize: 14, color: 'var(--text2)', lineHeight: 1.5 }}>{children}</div>
}

function RequestList({ email }) {
  const navigate = useNavigate()
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(withEmail(`${API_BASE}/admin/catalog-requests?status=review`, email))
      .then(readJson)
      .then(d => { if (!cancelled) setItems(d.requests || []) })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [email])

  if (error) return <Muted>{error}</Muted>
  if (!items) return <Muted>Carregando pedidos…</Muted>
  if (!items.length) return <Muted>Nada esperando revisão. 🎉</Muted>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Muted>{items.length} {items.length === 1 ? 'pedido esperando' : 'pedidos esperando'} — os mais antigos primeiro.</Muted>
      {items.map(r => (
        <button key={r.id} onClick={() => navigate(`/curadoria/${r.id}`)} style={{ ...card, cursor: 'pointer', textAlign: 'left', width: '100%' }}>
          <Thumb src={r.image_url} size={56} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
              {fmtWhen(r.date_start)}{r.venue_name ? ` · ${r.venue_name}` : ''}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
              {r.submitted_by_name ? `${r.submitted_by_name} sugeriu` : 'Sugestão'}{r.ig_handle ? ` · @${r.ig_handle}` : ''}
            </div>
          </div>
          <span style={{ color: 'var(--text3)', fontSize: 18 }}>›</span>
        </button>
      ))}
    </div>
  )
}

function Thumb({ src, size }) {
  const [broken, setBroken] = useState(false)
  if (!src || broken) {
    return <div style={{ width: size, height: size, borderRadius: 10, background: 'var(--line)', flexShrink: 0 }} />
  }
  return (
    <img
      src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)}
      style={{ width: size, height: size, borderRadius: 10, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--line)' }}
    />
  )
}

function RequestDetail({ id, email }) {
  const navigate = useNavigate()
  const [req, setReq] = useState(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', date_start: '', venue_name: '', description: '', image_url: '' })
  const [track, setTrack] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')     // '' | 'approve' | 'reject'
  const [done, setDone] = useState(null)   // { kind, eventId?, tracked? }

  const load = useCallback(() => {
    setError('')
    return fetch(withEmail(`${API_BASE}/admin/catalog-requests/${encodeURIComponent(id)}`, email))
      .then(readJson)
      .then(d => {
        setReq(d)
        setForm({
          name: d.name || '',
          // datetime-local wants YYYY-MM-DDTHH:MM.
          date_start: String(d.date_start || '').slice(0, 16),
          venue_name: d.venue_name || '',
          description: d.description || '',
          image_url: d.image_url || '',
        })
        setTrack(false)
      })
      .catch(e => setError(e.message))
  }, [id, email])

  useEffect(() => { load() }, [load])

  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }))

  async function decide(kind) {
    setBusy(kind)
    setError('')
    try {
      const body = kind === 'approve'
        ? { requesting_email: email, ...form, track_handle: track, note }
        : { requesting_email: email, note }
      const data = await fetch(`${API_BASE}/admin/catalog-requests/${encodeURIComponent(id)}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(readJson)
      setDone({ kind, eventId: data.catalog_event_id, tracked: data.handle_tracked })
    } catch (e) {
      setError(e.message)
      // A 409 means someone else resolved it — reload to show that state.
      load()
    } finally {
      setBusy('')
    }
  }

  if (error && !req) return <Muted>{error}</Muted>
  if (!req) return <Muted>Carregando pedido…</Muted>

  if (done) {
    return (
      <div style={{ ...card, flexDirection: 'column', alignItems: 'stretch', gap: 12, padding: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>
          {done.kind === 'approve' ? '✅ Publicado no catálogo' : 'Pedido recusado'}
        </div>
        {done.kind === 'approve' && done.tracked && req.ig_handle && (
          <Muted>@{req.ig_handle} agora é monitorado todo dia.</Muted>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {done.kind === 'approve' && done.eventId && (
            <button onClick={() => navigate(`/events?event=${encodeURIComponent(done.eventId)}`)} style={primaryBtn}>Ver evento</button>
          )}
          <button onClick={() => navigate('/curadoria')} style={ghostBtn}>Próximo pedido</button>
        </div>
      </div>
    )
  }

  const resolved = req.status !== 'review'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...card, alignItems: 'flex-start' }}>
        <Thumb src={form.image_url} size={96} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            {/* created_at is a real UTC timestamp (with offset), unlike event
                dates — fmtStamp converts it; fmtWhen would show it 3h off. */}
            {req.submitted_by_name ? `${req.submitted_by_name} sugeriu` : 'Sugestão'} · {fmtStamp(req.created_at)}
          </div>
          {req.ig_handle && <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 4 }}>@{req.ig_handle}</div>}
          <a
            href={req.url} target="_blank" rel="noreferrer"
            style={{ display: 'inline-block', marginTop: 8, fontSize: 13, fontWeight: 700, color: 'var(--cyan)' }}
          >
            Abrir no Instagram ↗
          </a>
          {form.image_url && !resolved && (
            <button onClick={() => setForm(f => ({ ...f, image_url: '' }))} style={{ ...linkBtn, display: 'block', marginTop: 6 }}>
              Remover imagem
            </button>
          )}
        </div>
      </div>

      {/* Every curator gets the same push, so the rest will open requests
          someone already decided. Say who and when, and point at the result,
          instead of leaving them to discover it from a greyed-out form. */}
      {resolved && (
        <div style={{ ...card, flexDirection: 'column', alignItems: 'stretch', gap: 8, borderColor: req.status === 'approved' ? 'var(--lime)' : 'var(--line)' }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>
            {req.status === 'approved' ? '✅ Essa adição já foi aprovada' : 'Essa adição já foi recusada'}
            {req.reviewed_by_name ? ` por ${req.reviewed_by_name}` : ''}
          </div>
          {req.reviewed_at && <Muted>{fmtStamp(req.reviewed_at)}</Muted>}
          {req.status === 'approved' && req.catalog_event_id && (
            <button
              onClick={() => navigate(`/events?event=${encodeURIComponent(req.catalog_event_id)}`)}
              style={{ ...primaryBtn, alignSelf: 'flex-start' }}
            >
              Ver no catálogo
            </button>
          )}
        </div>
      )}

      <div>
        <label style={label}>Nome</label>
        <input value={form.name} onChange={set('name')} disabled={resolved} maxLength={200} style={input} />
      </div>
      <div>
        <label style={label}>Quando</label>
        <input type="datetime-local" value={form.date_start} onChange={set('date_start')} disabled={resolved} style={input} />
      </div>
      <div>
        <label style={label}>Onde</label>
        <input value={form.venue_name} onChange={set('venue_name')} disabled={resolved} maxLength={200} style={input} />
      </div>
      <div>
        <label style={label}>Descrição</label>
        <textarea value={form.description} onChange={set('description')} disabled={resolved} rows={4} maxLength={1000} style={{ ...input, resize: 'vertical' }} />
      </div>

      {!resolved && req.ig_handle && (
        <label style={{ ...card, cursor: req.handle_tracked ? 'default' : 'pointer' }}>
          <input
            type="checkbox"
            checked={req.handle_tracked || track}
            disabled={req.handle_tracked}
            onChange={e => setTrack(e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {req.handle_tracked ? `@${req.ig_handle} já é monitorado` : `Também monitorar @${req.ig_handle}`}
            </div>
            {!req.handle_tracked && (
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                Os próximos posts dessa conta entram no scrape diário.
              </div>
            )}
          </div>
        </label>
      )}

      {!resolved && (
        <>
          <div>
            <label style={label}>Nota interna (opcional)</label>
            <input value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder="Ex: evento fora de Curitiba" style={input} />
          </div>
          {error && <div style={{ fontSize: 13, color: 'var(--magenta)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => decide('approve')} disabled={!!busy} style={{ ...primaryBtn, flex: 1, opacity: busy ? 0.6 : 1 }}>
              {busy === 'approve' ? 'Publicando…' : 'Aprovar e publicar'}
            </button>
            <button onClick={() => decide('reject')} disabled={!!busy} style={{ ...ghostBtn, opacity: busy ? 0.6 : 1 }}>
              {busy === 'reject' ? 'Recusando…' : 'Recusar'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const primaryBtn = {
  padding: '12px 16px', borderRadius: 12, border: 'none', cursor: 'pointer',
  background: 'var(--lime)', color: 'var(--on-lime)', fontSize: 14, fontWeight: 800,
}
const ghostBtn = {
  padding: '12px 16px', borderRadius: 12, cursor: 'pointer',
  background: 'transparent', border: '1px solid var(--line)', color: 'var(--text)',
  fontSize: 14, fontWeight: 700,
}
const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--text2)', fontSize: 12, textDecoration: 'underline',
}
