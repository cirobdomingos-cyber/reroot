import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import Aue from '../components/Aue'

// Admin: collaborative curation of Instagram accounts.
// - Anyone logged in can VIEW the catalog.
// - Curators (whitelisted by the founder) can ADD / EDIT / REMOVE handles.
// - The founder can also manage the curator list.
//
// Identity comes from the existing Google OAuth (state.googleUser.email).
// All mutating endpoints take a `requesting_email` so the backend can verify
// the role.

const API_BASE = import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? 'http://localhost:8000' : '')

const CATEGORY_PRESETS = [
  'museu', 'cultural', 'teatro', 'cafe', 'bar', 'curador',
  'wellness', 'parque', 'musica', 'livraria', 'outro',
]

function withEmail(url, email) {
  const sep = url.includes('?') ? '&' : '?'
  return email ? `${url}${sep}requesting_email=${encodeURIComponent(email)}` : url
}

export default function AdminIgAccounts() {
  const { state } = useApp()
  const navigate = useNavigate()
  const email = state.googleUser?.email || ''
  const userName = state.googleUser?.givenName || state.googleUser?.name || ''

  const [accounts, setAccounts] = useState([])
  const [curators, setCurators] = useState([])
  const [feedback, setFeedback] = useState([])
  const [isCurator, setIsCurator] = useState(false)
  const [isFounder, setIsFounder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  // Add-account form state
  const [newHandle, setNewHandle] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newCategory, setNewCategory] = useState('cultural')

  // Add-curator form state
  const [newCuratorEmail, setNewCuratorEmail] = useState('')
  const [newCuratorNotes, setNewCuratorNotes] = useState('')
  const [newRoleCurator, setNewRoleCurator]   = useState(true)
  const [newRoleFeedbacker, setNewRoleFeedbacker] = useState(false)

  const load = useCallback(async () => {
    if (!email) { setLoading(false); return }
    setLoading(true)
    try {
      const [accRes, curRes] = await Promise.all([
        fetch(withEmail(`${API_BASE}/admin/ig-accounts`, email)),
        fetch(withEmail(`${API_BASE}/admin/curators`, email)),
      ])
      const accData = await accRes.json()
      const curData = await curRes.json()
      setAccounts(accData.accounts || [])
      setCurators(curData.curators || [])
      setIsCurator(!!accData.is_curator)
      setIsFounder(!!accData.is_founder)
      // Founders also see submitted feedback. The feedback endpoint is
      // founder-gated server-side; we only fetch it when the previous
      // calls already confirmed founder status.
      if (accData.is_founder) {
        try {
          const fbRes = await fetch(withEmail(`${API_BASE}/admin/feedback`, email))
          const fbData = await fbRes.json()
          setFeedback(fbData.feedback || [])
        } catch { /* feedback fetch is best-effort */ }
      }
      setError(null)
    } catch (e) {
      setError(`Falha ao carregar: ${e.message}`)
    }
    setLoading(false)
  }, [email])

  useEffect(() => { load() }, [load])

  async function addAccount(e) {
    e?.preventDefault()
    const handle = newHandle.trim().replace(/^@/, '')
    if (!handle) return
    setBusy(true)
    try {
      const r = await fetch(`${API_BASE}/admin/ig-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle, label: newLabel.trim(), category: newCategory,
          enabled: true, notes: '', requesting_email: email,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      setNewHandle(''); setNewLabel('')
      await load()
    } catch (e) {
      setError(`Falha ao adicionar: ${e.message}`)
    }
    setBusy(false)
  }

  async function toggleEnabled(acc) {
    setBusy(true)
    try {
      await fetch(`${API_BASE}/admin/ig-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: acc.handle, label: acc.label, category: acc.category,
          enabled: !acc.enabled, notes: acc.notes || '', requesting_email: email,
        }),
      })
      await load()
    } catch (e) {
      setError(`Falha ao atualizar: ${e.message}`)
    }
    setBusy(false)
  }

  async function deleteAccount(handle) {
    if (!confirm(`Remover @${handle}?`)) return
    setBusy(true)
    try {
      await fetch(withEmail(
        `${API_BASE}/admin/ig-accounts/${encodeURIComponent(handle)}`, email,
      ), { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(`Falha ao remover: ${e.message}`)
    }
    setBusy(false)
  }

  async function triggerRefresh() {
    setBusy(true)
    try {
      const r = await fetch(`${API_BASE}/events/refresh`, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      alert('Refresh iniciado em background. Próximo scrape de Instagram em ~1-2 min.')
    } catch (e) {
      setError(`Falha ao disparar refresh: ${e.message}`)
    }
    setBusy(false)
  }

  async function addCurator(e) {
    e?.preventDefault()
    const target = newCuratorEmail.trim().toLowerCase()
    if (!target) return
    if (!newRoleCurator && !newRoleFeedbacker) {
      setError('Marque pelo menos um papel.')
      return
    }
    setBusy(true)
    try {
      const r = await fetch(`${API_BASE}/admin/curators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: target, notes: newCuratorNotes.trim(),
          requesting_email: email,
          is_curator: newRoleCurator,
          is_feedbacker: newRoleFeedbacker,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      setNewCuratorEmail(''); setNewCuratorNotes('')
      setNewRoleCurator(true); setNewRoleFeedbacker(false)
      await load()
    } catch (e) {
      setError(`Falha ao adicionar: ${e.message}`)
    }
    setBusy(false)
  }

  async function updateRoles(target, isCurator, isFeedbacker) {
    setBusy(true)
    try {
      const r = await fetch(`${API_BASE}/admin/curators/${encodeURIComponent(target)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_curator: isCurator, is_feedbacker: isFeedbacker,
          requesting_email: email,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      await load()
    } catch (e) {
      setError(`Falha ao atualizar papéis: ${e.message}`)
    }
    setBusy(false)
  }

  async function removeCurator(target) {
    if (!confirm(`Remover ${target} de todos os papéis?`)) return
    setBusy(true)
    try {
      const r = await fetch(withEmail(
        `${API_BASE}/admin/curators/${encodeURIComponent(target)}`, email,
      ), { method: 'DELETE' })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      await load()
    } catch (e) {
      setError(`Falha ao remover: ${e.message}`)
    }
    setBusy(false)
  }

  // ── Render branches ──

  if (!email) {
    return (
      <NotLoggedIn onGoHome={() => navigate('/')} />
    )
  }

  const enabledCount = accounts.filter(a => a.enabled).length

  return (
    <div style={{ padding: '20px 16px 80px', maxWidth: 720, margin: '0 auto' }}>
      <Header
        userName={userName}
        email={email}
        isCurator={isCurator}
        isFounder={isFounder}
        enabledCount={enabledCount}
        totalCount={accounts.length}
      />

      {error && (
        <div style={{
          background: '#FFEBEE', color: '#B71C1C', padding: '10px 14px',
          borderRadius: 10, marginBottom: 16, fontSize: 13,
        }}>
          {error}
          <button onClick={() => setError(null)} style={{
            float: 'right', background: 'none', border: 'none',
            color: '#B71C1C', cursor: 'pointer', fontWeight: 700,
          }}>✕</button>
        </div>
      )}

      {!isCurator && !loading && (
        <NotACuratorMessage email={email} />
      )}

      {isCurator && (
        <>
          {/* Add new account */}
          <form onSubmit={addAccount} style={{
            background: 'white', borderRadius: 14, padding: 14,
            border: '1px solid var(--border)', marginBottom: 18,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Adicionar conta do Instagram</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={newHandle}
                onChange={e => setNewHandle(e.target.value)}
                placeholder="@handle"
                style={inputStyle}
              />
              <input
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="Nome (ex: Café Lucca)"
                style={{ ...inputStyle, flex: '2 1 200px' }}
              />
              <select
                value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                style={{ ...inputStyle, flex: '0 1 130px', background: 'white' }}
              >
                {CATEGORY_PRESETS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <button
                type="submit"
                disabled={busy || !newHandle.trim()}
                style={primaryBtn(busy || !newHandle.trim())}
              >
                Adicionar
              </button>
            </div>
          </form>

          {/* Quick actions */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
            <button
              onClick={triggerRefresh}
              disabled={busy}
              style={ghostBtn('var(--sage)')}
            >
              ▶ Disparar refresh agora
            </button>
          </div>

          {/* Account list */}
          {loading ? (
            <div style={{ color: 'var(--charcoal-light)', fontSize: 13 }}>Carregando…</div>
          ) : accounts.length === 0 ? (
            <div style={{ color: 'var(--charcoal-light)', fontSize: 13 }}>
              Nenhuma conta cadastrada.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {accounts.map(acc => (
                <AccountRow
                  key={acc.handle}
                  acc={acc}
                  busy={busy}
                  onToggle={toggleEnabled}
                  onDelete={deleteAccount}
                />
              ))}
            </div>
          )}
        </>
      )}

      {isFounder && (
        <CuratorsSection
          curators={curators}
          email={email}
          newCuratorEmail={newCuratorEmail}
          setNewCuratorEmail={setNewCuratorEmail}
          newCuratorNotes={newCuratorNotes}
          setNewCuratorNotes={setNewCuratorNotes}
          newRoleCurator={newRoleCurator}
          setNewRoleCurator={setNewRoleCurator}
          newRoleFeedbacker={newRoleFeedbacker}
          setNewRoleFeedbacker={setNewRoleFeedbacker}
          onAdd={addCurator}
          onRemove={removeCurator}
          onUpdateRoles={updateRoles}
          busy={busy}
        />
      )}

      {isFounder && <FeedbackSection feedback={feedback} />}
    </div>
  )
}


function FeedbackSection({ feedback }) {
  return (
    <div style={{
      marginTop: 32, paddingTop: 24,
      borderTop: '2px dashed var(--border)',
    }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
        💬 Feedback dos usuários
      </h2>
      <p style={{ fontSize: 12, color: 'var(--charcoal-light)', margin: '0 0 14px' }}>
        Mensagens enviadas por feedbackers. Os {feedback.length} mais recentes,
        novos primeiro.
      </p>
      {feedback.length === 0 ? (
        <div style={{
          background: 'white', borderRadius: 12, padding: '14px 16px',
          border: '1px dashed var(--border)',
          fontSize: 12, color: 'var(--charcoal-light)',
        }}>
          Nenhum feedback ainda.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {feedback.map(fb => (
            <div
              key={fb.id}
              style={{
                background: 'white', border: '1px solid var(--border)',
                borderRadius: 12, padding: '12px 14px',
              }}
            >
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                marginBottom: 6, gap: 8,
              }}>
                <div style={{
                  fontSize: 12, fontWeight: 700, color: 'var(--charcoal)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  flex: 1, minWidth: 0,
                }}>
                  {fb.email}
                </div>
                <div style={{ fontSize: 10, color: 'var(--charcoal-light)', flexShrink: 0 }}>
                  {new Date(fb.created_at).toLocaleString('pt-BR')}
                </div>
              </div>
              <div style={{
                fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.5,
                whiteSpace: 'pre-line',
              }}>
                {fb.text}
              </div>
              {fb.context && (
                <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginTop: 6 }}>
                  📍 {fb.context}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Subcomponents ─────────────────────────────────────────

const inputStyle = {
  flex: '1 1 180px', minWidth: 140,
  padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--border)', fontSize: 13, outline: 'none',
}

const primaryBtn = (disabled) => ({
  padding: '8px 16px', borderRadius: 8, border: 'none',
  background: 'var(--sage)', color: 'white', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13,
  opacity: disabled ? 0.5 : 1,
})

const ghostBtn = (color) => ({
  padding: '8px 14px', borderRadius: 8,
  border: `1px solid ${color}`, background: 'white', color,
  fontWeight: 700, fontSize: 12, cursor: 'pointer',
})


function Header({ userName, email, isCurator, isFounder, enabledCount, totalCount }) {
  const role = isFounder ? 'Fundador' : isCurator ? 'Curador' : 'Visitante'
  const roleColor = isFounder ? '#FF8F00' : isCurator ? 'var(--sage)' : 'var(--charcoal-light)'
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Curadoria de Instagram</h1>
      <p style={{ fontSize: 13, color: 'var(--charcoal-light)', margin: '4px 0 0' }}>
        {enabledCount} de {totalCount} contas ativas. {' '}
        Você está logado como{' '}
        <span style={{ fontWeight: 700, color: 'var(--charcoal)' }}>{userName || email}</span>
        {' · '}
        <span style={{ color: roleColor, fontWeight: 700 }}>{role}</span>.
      </p>
    </div>
  )
}


function NotLoggedIn({ onGoHome }) {
  return (
    <div style={{ padding: '40px 20px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Curadoria de Instagram</h1>
      <p style={{ color: 'var(--charcoal-light)', fontSize: 14, lineHeight: 1.5 }}>
        Faça login no app primeiro pra acessar a curadoria. Volte pra tela inicial,
        complete o login com Google, e abra esse link de novo.
      </p>
      <button
        onClick={onGoHome}
        style={{
          ...primaryBtn(false),
          marginTop: 16, padding: '10px 24px',
        }}
      >
        Voltar para o início
      </button>
    </div>
  )
}


function NotACuratorMessage({ email }) {
  function copyEmail() {
    try {
      navigator.clipboard.writeText(email)
      alert('Email copiado! Manda pro fundador.')
    } catch {
      alert(`Email: ${email}`)
    }
  }
  return (
    <div style={{
      background: '#FFF8E1', border: '1px solid #FFE082',
      borderRadius: 14, padding: 18, marginBottom: 18,
    }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
        Você ainda não é curador
      </div>
      <p style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, margin: '0 0 12px' }}>
        A curadoria do <Aue /> é colaborativa, mas só pessoas liberadas podem
        adicionar contas. Mande seu email pro fundador e peça liberação. Depois
        é só atualizar essa página.
      </p>
      <button onClick={copyEmail} style={ghostBtn('var(--sage)')}>
        📋 Copiar meu email ({email})
      </button>
    </div>
  )
}


function AccountRow({ acc, busy, onToggle, onDelete }) {
  return (
    <div style={{
      background: 'white', border: '1px solid var(--border)',
      borderRadius: 12, padding: 12,
      opacity: acc.enabled ? 1 : 0.55,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <button
        onClick={() => onToggle(acc)}
        disabled={busy}
        title={acc.enabled ? 'Desativar' : 'Ativar'}
        style={{
          width: 38, height: 22, borderRadius: 11,
          background: acc.enabled ? 'var(--sage)' : 'var(--border)',
          border: 'none', cursor: 'pointer', position: 'relative',
          flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: acc.enabled ? 18 : 2,
          width: 18, height: 18, borderRadius: '50%', background: 'white',
          transition: 'left 0.15s',
        }}/>
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <a
            href={`https://www.instagram.com/${acc.handle}/`}
            target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 14, fontWeight: 700, color: 'var(--charcoal)', textDecoration: 'none' }}
          >
            @{acc.handle}
          </a>
          {acc.category && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px',
              borderRadius: 5, background: 'var(--sage-pale)', color: 'var(--sage)',
            }}>
              {acc.category}
            </span>
          )}
        </div>
        {acc.label && (
          <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 2 }}>
            {acc.label}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 4 }}>
          {acc.last_scraped_at
            ? `Último scrape: ${new Date(acc.last_scraped_at).toLocaleString('pt-BR')}`
            : 'Ainda não scrapeada'}
          {' · '}
          {`${acc.last_event_count || 0} eventos no último run`}
          {acc.added_by_email && ` · adicionado por ${acc.added_by_email}`}
        </div>
      </div>

      <button
        onClick={() => onDelete(acc.handle)}
        disabled={busy}
        title="Remover"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 16, color: 'var(--charcoal-light)', padding: 4,
        }}
      >
        🗑
      </button>
    </div>
  )
}


function CuratorsSection({
  curators, email,
  newCuratorEmail, setNewCuratorEmail,
  newCuratorNotes, setNewCuratorNotes,
  newRoleCurator, setNewRoleCurator,
  newRoleFeedbacker, setNewRoleFeedbacker,
  onAdd, onRemove, onUpdateRoles, busy,
}) {
  return (
    <div style={{
      marginTop: 32, paddingTop: 24,
      borderTop: '2px dashed var(--border)',
    }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
        Pessoas com acesso
      </h2>
      <p style={{ fontSize: 12, color: 'var(--charcoal-light)', margin: '0 0 14px' }}>
        Apenas o fundador pode liberar ou alterar papéis. Curadores podem editar
        contas do Instagram. Feedbackers podem mandar feedback do app.
      </p>

      <form onSubmit={onAdd} style={{
        background: 'white', borderRadius: 14, padding: 14,
        border: '1px solid var(--border)', marginBottom: 14,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="email"
            value={newCuratorEmail}
            onChange={e => setNewCuratorEmail(e.target.value)}
            placeholder="email@exemplo.com"
            style={{ ...inputStyle, flex: '2 1 220px' }}
          />
          <input
            value={newCuratorNotes}
            onChange={e => setNewCuratorNotes(e.target.value)}
            placeholder="Nota (opcional)"
            style={inputStyle}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <label style={checkLabelStyle}>
            <input type="checkbox" checked={newRoleCurator}
              onChange={e => setNewRoleCurator(e.target.checked)} /> Curador
          </label>
          <label style={checkLabelStyle}>
            <input type="checkbox" checked={newRoleFeedbacker}
              onChange={e => setNewRoleFeedbacker(e.target.checked)} /> Feedbacker
          </label>
          <button
            type="submit"
            disabled={busy || !newCuratorEmail.trim() || (!newRoleCurator && !newRoleFeedbacker)}
            style={{ ...primaryBtn(busy || !newCuratorEmail.trim() || (!newRoleCurator && !newRoleFeedbacker)), marginLeft: 'auto' }}
          >
            Liberar
          </button>
        </div>
      </form>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {curators.map(c => (
          <div
            key={c.email}
            style={{
              background: 'white', border: '1px solid var(--border)',
              borderRadius: 10, padding: '10px 12px',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {c.email}
                {c.is_founder ? (
                  <span style={{
                    marginLeft: 8, fontSize: 9, fontWeight: 700, padding: '2px 6px',
                    borderRadius: 5, background: '#FFF3E0', color: '#FF8F00',
                  }}>FUNDADOR</span>
                ) : null}
              </div>
              {c.notes && (
                <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
                  {c.notes}
                </div>
              )}
            </div>
            <label style={checkLabelStyle}>
              <input
                type="checkbox"
                checked={!!c.is_curator}
                disabled={busy || c.is_founder}
                onChange={e => onUpdateRoles(c.email, e.target.checked, !!c.is_feedbacker)}
              /> Curador
            </label>
            <label style={checkLabelStyle}>
              <input
                type="checkbox"
                checked={!!c.is_feedbacker}
                disabled={busy || c.is_founder}
                onChange={e => onUpdateRoles(c.email, !!c.is_curator, e.target.checked)}
              /> Feedbacker
            </label>
            {!c.is_founder && c.email !== email && (
              <button
                onClick={() => onRemove(c.email)}
                disabled={busy}
                title="Remover de todos os papéis"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 14, color: 'var(--charcoal-light)', padding: 4,
                }}
              >
                🗑
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}


const checkLabelStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 12, fontWeight: 600, color: 'var(--charcoal)', cursor: 'pointer',
}
