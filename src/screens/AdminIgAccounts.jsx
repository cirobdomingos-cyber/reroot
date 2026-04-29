import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import Aue from '../components/Aue'
import Avatar from '../components/Avatar'

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
  const [usage, setUsage] = useState(null)
  const [isCurator, setIsCurator] = useState(false)
  const [isFounder, setIsFounder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  // Search filter for the IG handles list — matches handle, label,
  // display_name, or category. Live filter, no debounce needed for ~25
  // rows. Empty string = show everything.
  const [handleQuery, setHandleQuery] = useState('')

  // Add-curator form state
  const [newCuratorEmail, setNewCuratorEmail] = useState('')
  const [newCuratorNotes, setNewCuratorNotes] = useState('')

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
        try {
          const usageRes = await fetch(withEmail(`${API_BASE}/admin/usage-stats`, email))
          if (usageRes.ok) setUsage(await usageRes.json())
        } catch { /* usage fetch is best-effort */ }
      }
      setError(null)
    } catch (e) {
      setError(`Falha ao carregar: ${e.message}`)
    }
    setLoading(false)
  }, [email])

  useEffect(() => { load() }, [load])

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

  async function scrapeOne(handle) {
    setBusy(true)
    try {
      const r = await fetch(`${API_BASE}/admin/ig-accounts/${encodeURIComponent(handle)}/scrape?requesting_email=${encodeURIComponent(email)}`, {
        method: 'POST',
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      const result = await r.json()
      alert(`@${handle}: ${result.events_extracted} evento(s) extraído(s).`)
      await load()
    } catch (e) {
      setError(`Falha ao scrapear: ${e.message}`)
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

  async function toggleFeatured(acc) {
    setBusy(true)
    try {
      const r = await fetch(
        `${API_BASE}/admin/ig-accounts/${encodeURIComponent(acc.handle)}/featured`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requesting_email: email,
            featured: !acc.featured,
          }),
        },
      )
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      await load()
    } catch (e) {
      setError(`Falha ao atualizar Destaque: ${e.message}`)
    }
    setBusy(false)
  }

  async function addCurator(e) {
    e?.preventDefault()
    const target = newCuratorEmail.trim().toLowerCase()
    if (!target) return
    setBusy(true)
    try {
      const r = await fetch(`${API_BASE}/admin/curators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: target, notes: newCuratorNotes.trim(),
          requesting_email: email,
          is_curator: true,        // role gates feedbacker-only rows; we only grant curator now
          is_feedbacker: false,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      setNewCuratorEmail(''); setNewCuratorNotes('')
      await load()
    } catch (e) {
      setError(`Falha ao adicionar: ${e.message}`)
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

      {/* Section order (founder/curator view):
          1. Statistics — usage dashboard up top so the founder lands on
             the dial that matters most.
          2. Curators — managing the team comes before content moderation.
          3. Feedback — read what users said.
          4. Active handles — operational list at the bottom; adding new
             handles lives on the Sources page now (no duplicate form). */}
      {isFounder && usage && <UsageSection usage={usage} />}

      {isFounder && (
        <CuratorsSection
          curators={curators}
          email={email}
          newCuratorEmail={newCuratorEmail}
          setNewCuratorEmail={setNewCuratorEmail}
          newCuratorNotes={newCuratorNotes}
          setNewCuratorNotes={setNewCuratorNotes}
          onAdd={addCurator}
          onRemove={removeCurator}
          busy={busy}
        />
      )}

      {isFounder && (
        <FeedbackSection
          feedback={feedback}
          email={email}
          onReload={load}
          busy={busy}
          setBusy={setBusy}
        />
      )}

      {isCurator && (
        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
            📷 Contas ativas
          </h2>
          <div style={{ fontSize: 12, color: 'var(--charcoal-light)', marginBottom: 12 }}>
            Adicionar novas contas é na aba <b>Fontes</b>.
          </div>

          {/* Quick actions. Atualizar locais / Buscar coordenadas
              moved off this UI — seed_venues_from_events runs at every
              scrape and the geocoding pipeline (Nominatim + Claude
              web_search fallback) auto-fills coordinates without
              human intervention, so the manual buttons just added
              clutter. */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <button
              onClick={triggerRefresh}
              disabled={busy}
              style={ghostBtn('var(--sage)')}
            >
              ▶ Disparar refresh agora
            </button>
          </div>

          {/* Search */}
          <input
            value={handleQuery}
            onChange={e => setHandleQuery(e.target.value)}
            placeholder="🔍 Buscar conta (handle, nome, categoria…)"
            style={{
              ...inputStyle, width: '100%', boxSizing: 'border-box',
              flex: 'unset', marginBottom: 12,
            }}
          />

          {/* Account list — filtered by handleQuery */}
          {loading ? (
            <div style={{ color: 'var(--charcoal-light)', fontSize: 13 }}>Carregando…</div>
          ) : accounts.length === 0 ? (
            <div style={{ color: 'var(--charcoal-light)', fontSize: 13 }}>
              Nenhuma conta cadastrada.
            </div>
          ) : (() => {
            const q = handleQuery.trim().toLowerCase()
            const filtered = q
              ? accounts.filter(a =>
                  (a.handle || '').toLowerCase().includes(q) ||
                  (a.label || '').toLowerCase().includes(q) ||
                  (a.display_name || '').toLowerCase().includes(q) ||
                  (a.category || '').toLowerCase().includes(q)
                )
              : accounts
            if (filtered.length === 0) {
              return (
                <div style={{ color: 'var(--charcoal-light)', fontSize: 13 }}>
                  Nenhuma conta encontrada para "{handleQuery}".
                </div>
              )
            }
            return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.map(acc => (
                <AccountRow
                  key={acc.handle}
                  acc={acc}
                  busy={busy}
                  isFounder={isFounder}
                  onToggle={toggleEnabled}
                  onDelete={deleteAccount}
                  onScrape={scrapeOne}
                  onToggleFeatured={toggleFeatured}
                  onOpenSource={(h) => navigate(`/sources/${encodeURIComponent('ig:' + h)}`)}
                />
              ))}
            </div>
            )
          })()}
        </section>
      )}
    </div>
  )
}


function FeedbackSection({ feedback, email, onReload, busy, setBusy }) {
  async function setStatus(fbId, status) {
    setBusy(true)
    try {
      const r = await fetch(`${API_BASE}/admin/feedback/${fbId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, requesting_email: email }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await onReload()
    } catch (e) {
      alert(`Falha ao atualizar status: ${e.message}`)
    }
    setBusy(false)
  }

  const openCount = feedback.filter(f => (f.status || 'open') === 'open').length

  return (
    <div style={{
      marginTop: 32, paddingTop: 24,
      borderTop: '2px dashed var(--border)',
    }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
        💬 Feedback dos usuários
      </h2>
      <p style={{ fontSize: 12, color: 'var(--charcoal-light)', margin: '0 0 14px' }}>
        {openCount} aberto{openCount === 1 ? '' : 's'} de {feedback.length} total. Abertos primeiro, resolvidos abaixo.
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
          {feedback.map(fb => {
            const status = fb.status || 'open'
            const isOpen = status === 'open'
            const statusMeta = {
              open:      { label: 'Aberto',     color: 'var(--charcoal-mid)', bg: 'transparent' },
              concluded: { label: '✓ Concluído', color: 'var(--sage)',         bg: 'var(--sage-pale)' },
              canceled:  { label: '✕ Cancelado', color: '#B71C1C',             bg: '#FFEBEE' },
            }[status]
            return (
              <div
                key={fb.id}
                style={{
                  background: 'white', border: '1px solid var(--border)',
                  borderRadius: 12, padding: '12px 14px',
                  opacity: isOpen ? 1 : 0.65,
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
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
                    color: statusMeta.color, background: statusMeta.bg,
                    textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 0,
                  }}>
                    {statusMeta.label}
                  </span>
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
                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  {isOpen ? (
                    <>
                      <button onClick={() => setStatus(fb.id, 'concluded')} disabled={busy} style={statusBtn('var(--sage)')}>
                        ✓ Concluir
                      </button>
                      <button onClick={() => setStatus(fb.id, 'canceled')} disabled={busy} style={statusBtn('#B71C1C')}>
                        ✕ Cancelar
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setStatus(fb.id, 'open')} disabled={busy} style={statusBtn('var(--charcoal-light)')}>
                      ↺ Reabrir
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}


function statusBtn(color) {
  return {
    padding: '5px 10px', borderRadius: 8,
    border: `1px solid ${color}`, background: 'white', color,
    fontWeight: 700, fontSize: 11, cursor: 'pointer',
  }
}

// ── UsageSection — founder dashboard ──────────────────────
// DAU/WAU/MAU + funnel + 30-day daily series + recent logins.
// Charts are simple inline SVG bars to avoid a chart-library dep.
function UsageSection({ usage }) {
  const maxDaily = Math.max(1, ...usage.daily.map(d => d.active))
  const maxFunnel = Math.max(1, ...usage.funnel.map(f => f.count))
  return (
    <div style={{
      marginTop: 32, paddingTop: 24,
      borderTop: '2px dashed var(--border)',
    }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
        📊 Uso do app
      </h2>
      <p style={{ fontSize: 12, color: 'var(--charcoal-light)', margin: '0 0 14px' }}>
        Métricas agregadas. Atividade = abriu o app / sincronizou estado nas últimas 24h/7d/30d.
      </p>

      {/* Top metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 18 }}>
        <Metric label="Total" value={usage.total_users} />
        <Metric label="Hoje (DAU)" value={usage.dau} />
        <Metric label="Semana (WAU)" value={usage.wau} />
        <Metric label="Mês (MAU)" value={usage.mau} />
      </div>

      {/* Daily series — 30d bar chart */}
      <div style={{
        background: 'white', borderRadius: 12, padding: 14,
        border: '1px solid var(--border)', marginBottom: 14,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)', marginBottom: 8 }}>
          USUÁRIOS ATIVOS POR DIA
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 80 }}>
          {usage.daily.map(d => {
            const h = Math.max(2, (d.active / maxDaily) * 70)
            return (
              <div
                key={d.date}
                title={`${d.date}: ${d.active} ativo(s)`}
                style={{
                  flex: 1, background: 'var(--sage)',
                  height: `${h}px`, borderRadius: '3px 3px 0 0',
                  transition: 'all 0.15s',
                }}
              />
            )
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--charcoal-light)', marginTop: 6 }}>
          <span>{usage.daily[0]?.date.slice(5) || '—'}</span>
          <span>hoje · pico {maxDaily}</span>
        </div>
      </div>

      {/* Funnel */}
      <div style={{
        background: 'white', borderRadius: 12, padding: 14,
        border: '1px solid var(--border)', marginBottom: 14,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)', marginBottom: 12 }}>
          FUNIL
        </div>
        {usage.funnel.map((f, i) => {
          const pct = maxFunnel ? (f.count / maxFunnel) * 100 : 0
          const color = `hsl(${160 - i * 18}, 35%, 55%)`
          return (
            <div key={f.step} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                <span style={{ color: 'var(--charcoal-mid)' }}>{f.step}</span>
                <span style={{ fontWeight: 700, color: 'var(--charcoal)' }}>{f.count}</span>
              </div>
              <div style={{
                height: 8, borderRadius: 4, background: 'var(--cream)',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${pct}%`, height: '100%', background: color,
                  transition: 'width 0.3s',
                }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* Counts strip */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <Metric label="RSVPs" value={usage.counts.rsvps} small />
        <Metric label="Amizades" value={usage.counts.friendships} small />
        <Metric label="Grupos" value={usage.counts.groups} small />
        <Metric label="Feedback" value={usage.counts.feedback} small />
      </div>

      {/* Recent logins */}
      <div style={{
        background: 'white', borderRadius: 12, padding: 14,
        border: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)', marginBottom: 10 }}>
          ÚLTIMOS LOGINS
        </div>
        {usage.recent.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--charcoal-light)' }}>
            Nenhum usuário ainda.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {usage.recent.map(u => (
              <div key={u.google_id || u.email} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 0',
              }}>
                {u.picture ? (
                  <img src={u.picture} alt={u.name} referrerPolicy="no-referrer"
                    style={{ width: 24, height: 24, borderRadius: '50%' }} />
                ) : (
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%', background: 'var(--cream)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10,
                  }}>{(u.name || '?')[0]?.toUpperCase()}</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12, fontWeight: 600, color: 'var(--charcoal)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {u.name || u.email || u.google_id?.slice(0, 12)}
                  </div>
                  {u.email && u.email !== u.name && (
                    <div style={{
                      fontSize: 10, color: 'var(--charcoal-light)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {u.email}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--charcoal-light)', flexShrink: 0 }}>
                  {new Date(u.last_seen).toLocaleString('pt-BR')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}


function Metric({ label, value, small }) {
  return (
    <div style={{
      background: 'white', borderRadius: 10, padding: small ? '8px 10px' : '10px 12px',
      border: '1px solid var(--border)', textAlign: 'center', flex: small ? '1 1 80px' : 'unset',
    }}>
      <div style={{
        fontSize: small ? 18 : 22, fontWeight: 700, color: 'var(--charcoal)', lineHeight: 1.1,
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 9, color: 'var(--charcoal-light)', marginTop: 3,
        textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600,
      }}>
        {label}
      </div>
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
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Admin</h1>
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
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Admin</h1>
      <p style={{ color: 'var(--charcoal-light)', fontSize: 14, lineHeight: 1.5 }}>
        Faça login no app primeiro pra acessar o admin. Volte pra tela inicial,
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


function AccountRow({ acc, busy, onToggle, onDelete, onScrape, onOpenSource, onToggleFeatured, isFounder }) {
  const futureCount = acc.future_events ?? 0
  // Prefix BASE_URL for our rehosted-avatar paths in dev — without
  // this, the <Avatar> tries to load /event-images/avatars/... from
  // Vite :5173 and 404s. Same logic as fetchSources's absoluteImageUrl.
  const rawPic = acc.profile_pic_url
  const pic = (rawPic && API_BASE && rawPic.startsWith('/event-images/'))
    ? `${API_BASE}${rawPic}`
    : rawPic
  return (
    <div style={{
      background: 'white', border: '1px solid var(--border)',
      borderRadius: 12, padding: 12,
      opacity: acc.enabled ? 1 : 0.55,
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      {/* Profile pic — captured from Apify; falls back to a cream-bg
          initial badge (via Avatar) when not yet enriched. */}
      <Avatar
        src={pic}
        name={acc.display_name || acc.label || acc.handle}
        size={36}
      />
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
          {/* Tap the @handle to open the in-app Source hero (catalog
              of this venue's events), not the external IG profile —
              the admin is typically asking "what's our catalog showing
              for this venue?", not "let me read their IG". For the
              external IG profile there's the count-button → arrow
              affordance to the right that still opens IG. */}
          <button
            onClick={() => onOpenSource?.(acc.handle)}
            style={{
              fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 0, textDecoration: 'none',
            }}
          >
            @{acc.handle}
          </button>
          {acc.category && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px',
              borderRadius: 5, background: 'var(--sage-pale)', color: 'var(--sage)',
            }}>
              {acc.category}
            </span>
          )}
        </div>
        {(acc.display_name || acc.label) && (
          <div style={{
            fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {acc.display_name || acc.label}
          </div>
        )}
        {/* Compact meta line — was a 4-5 line wrap of "Último scrape: full
            date · N no último run · adicionado por ciro@..." that ate the
            card. Trimmed to date+time without seconds, "N evt" instead of
            "N no último run", and the curator email moved to a hover tooltip. */}
        <div
          style={{
            fontSize: 11, color: 'var(--charcoal-light)', marginTop: 3,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
          title={acc.added_by_email ? `Adicionado por ${acc.added_by_email}` : undefined}
        >
          {acc.last_scraped_at
            ? `📅 ${new Date(acc.last_scraped_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
            : 'Sem scrape ainda'}
          {' · '}
          {`${acc.last_event_count || 0} evt`}
        </div>
      </div>

      {/* Future-event count chip — clickable, opens this handle's source page */}
      <button
        onClick={() => onOpenSource?.(acc.handle)}
        disabled={!futureCount}
        title={futureCount ? `Ver ${futureCount} evento${futureCount === 1 ? '' : 's'} próximo${futureCount === 1 ? '' : 's'}` : 'Sem eventos próximos'}
        style={{
          fontSize: 11, fontWeight: 700,
          background: futureCount > 0 ? 'var(--terra-pale)' : 'transparent',
          color: futureCount > 0 ? 'var(--terra)' : 'var(--charcoal-light)',
          border: futureCount > 0 ? '1px solid var(--terra-pale)' : '1px solid var(--border)',
          padding: '4px 10px', borderRadius: 8,
          cursor: futureCount > 0 ? 'pointer' : 'default',
          flexShrink: 0,
        }}
      >
        {futureCount} →
      </button>

      {/* Founder-only Destaque toggle. Tapping flips the featured flag
          and immediately bumps the handle to the top of /sources and
          /events. Designed as a visual switch (filled star = active)
          so the founder can scan a long list and see what's currently
          paid placement. Curators see no toggle — they can't grant
          featured. */}
      {isFounder && onToggleFeatured && (
        <button
          onClick={() => onToggleFeatured(acc)}
          disabled={busy}
          title={acc.featured ? 'Tirar Destaque' : 'Marcar como Destaque'}
          style={{
            background: acc.featured ? 'var(--honey-pale)' : 'none',
            border: acc.featured ? '1px solid var(--honey)' : '1px solid var(--border)',
            borderRadius: 999,
            cursor: busy ? 'default' : 'pointer',
            fontSize: 13, color: acc.featured ? 'var(--honey)' : 'var(--charcoal-light)',
            padding: '3px 8px', fontWeight: 700, letterSpacing: 0.3,
          }}
        >
          ⭐
        </button>
      )}
      {onScrape && (
        <button
          onClick={() => onScrape(acc.handle)}
          disabled={busy}
          title="Scrapear esta conta agora"
          style={{
            background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer',
            fontSize: 14, color: 'var(--charcoal-light)', padding: 4,
          }}
        >
          🔄
        </button>
      )}
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
  onAdd, onRemove, busy,
}) {
  // Only show non-feedbacker-only rows. With feedback open to everyone,
  // the curators table should reflect just curator status.
  const visibleCurators = curators.filter(c => c.is_founder || c.is_curator)
  return (
    <div style={{
      marginTop: 32, paddingTop: 24,
      borderTop: '2px dashed var(--border)',
    }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>
        Curadores
      </h2>
      <p style={{ fontSize: 12, color: 'var(--charcoal-light)', margin: '0 0 14px' }}>
        Apenas o fundador pode liberar ou remover curadores. Feedback agora
        é aberto pra qualquer pessoa logada.
      </p>

      <form onSubmit={onAdd} style={{
        background: 'white', borderRadius: 14, padding: 14,
        border: '1px solid var(--border)', marginBottom: 14,
        display: 'flex', gap: 8, flexWrap: 'wrap',
      }}>
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
        <button
          type="submit"
          disabled={busy || !newCuratorEmail.trim()}
          style={primaryBtn(busy || !newCuratorEmail.trim())}
        >
          Liberar
        </button>
      </form>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visibleCurators.map(c => (
          <div
            key={c.email}
            style={{
              background: 'white', border: '1px solid var(--border)',
              borderRadius: 10, padding: '10px 12px',
              display: 'flex', alignItems: 'center', gap: 10,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
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
            {!c.is_founder && c.email !== email && (
              <button
                onClick={() => onRemove(c.email)}
                disabled={busy}
                title="Remover curador"
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
