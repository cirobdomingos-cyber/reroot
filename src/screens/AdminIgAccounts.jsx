import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { fetchVenueLeaderboard, checkBackendHealth } from '../services/api'
import Aue from '../components/Aue'
import Avatar from '../components/Avatar'
import AddHandleForm from '../components/AddHandleForm'
import { CATEGORY_META, CATEGORY_ORDER } from '../data/categories'

// Admin: a menu first, then one screen per job.
//
// It used to be one long page — usage, leaderboard, curators, feedback,
// accounts, tools — stacked in an order that made sense once and then
// had to be scrolled past every visit. Three lists of people (usage
// table, "últimos logins", curators) and two lists of @s (leaderboard
// for the founder, "contas ativas" for curators) described the same
// rows twice. Now: /admin is a menu whose cards carry the one number
// that matters for each job, and /admin/<section> is that job.
//
// One curator role (Sep 2026): a curator sees Pedidos, Contas and
// Locais; the founder sees everything.
//
// Identity comes from the existing Google OAuth (state.googleUser.email).
// All mutating endpoints take a `requesting_email` so the backend can verify
// the role.

import { API_BASE } from '../lib/apiBase'

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
  // Full user directory (founder-only) — replaces "last 10 logins".
  const [users, setUsers] = useState(null)
  // Distinct from the page-wide `error` state: UsersTable used to render
  // nothing at all on a failed fetch, so "not deployed yet" and "broken"
  // looked identical. Tracked separately so retrying just re-fetches this
  // one endpoint instead of the whole admin page.
  const [usersError, setUsersError] = useState(null)
  // Client-side errors, grouped by (type, message) — founder-only.
  const [clientErrors, setClientErrors] = useState(null)
  const [isCurator, setIsCurator] = useState(false)
  const [isFounder, setIsFounder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // Which environment is answering. The catalog sync only makes sense
  // away from production — production is the source, not a target — so
  // the button stays hidden until /health says we're somewhere else.
  const [envName, setEnvName] = useState(null)
  // Separate from `busy`: a few hundred events, imported one fsync'd
  // commit at a time, can take long enough that "disabled + grey" reads
  // as "did nothing" on a phone. The button says so explicitly instead.
  const [syncing, setSyncing] = useState(false)

  // Search filter for the IG handles list — matches handle, label,
  // display_name, or category. Live filter, no debounce needed for ~25
  // rows. Empty string = show everything.
  const [handleQuery, setHandleQuery] = useState('')

  // Which job this visit is for. No section = the menu.
  const { section } = useParams()

  // Counts for the menu cards: what's waiting in the two review queues.
  // Both endpoints default to status=review, so length is the answer.
  const [pendingCatalog, setPendingCatalog] = useState(null)
  const [pendingAccounts, setPendingAccounts] = useState(null)

  // Founder-only 30d activity per handle, overlaid on the one @ list.
  // This is what the separate leaderboard used to be for.
  const [metricsByHandle, setMetricsByHandle] = useState({})
  const [accountSort, setAccountSort] = useState('eventos')

  // Standalone (not folded into `load` below) so the retry button in
  // UsersTable's error state can re-fetch just this endpoint instead of
  // every founder panel on the page.
  const loadUsers = useCallback(async () => {
    if (!email) return
    try {
      const usersRes = await fetch(withEmail(`${API_BASE}/admin/users?limit=500`, email))
      if (!usersRes.ok) throw new Error(`Erro ${usersRes.status}`)
      setUsers(await usersRes.json())
      setUsersError(null)
    } catch (e) {
      setUsersError(e.message)
    }
  }, [email])

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
      if (accData.is_curator || accData.is_founder) {
        // Best-effort: a missing count shows as "—", never blocks the page.
        try {
          const [cq, aq] = await Promise.all([
            fetch(withEmail(`${API_BASE}/admin/catalog-requests`, email)),
            fetch(withEmail(`${API_BASE}/admin/account-requests`, email)),
          ])
          setPendingCatalog(cq.ok ? ((await cq.json()).requests || []).length : null)
          setPendingAccounts(aq.ok ? ((await aq.json()).requests || []).length : null)
        } catch { /* counts are decoration */ }
      }
      if (accData.is_founder) {
        try {
          const lb = await fetchVenueLeaderboard(email, 30)
          const map = {}
          ;(lb.venues || []).forEach((v, i) => { map[v.handle] = { ...v, rank: i + 1 } })
          setMetricsByHandle(map)
          setAccountSort('atividade')
        } catch { /* metrics are an overlay */ }
      }
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
        await loadUsers()
        try {
          const errRes = await fetch(withEmail(`${API_BASE}/admin/client-errors`, email))
          if (errRes.ok) setClientErrors(await errRes.json())
        } catch { /* client-errors panel is best-effort */ }
      }
      setError(null)
    } catch (e) {
      setError(`Falha ao carregar: ${e.message}`)
    }
    setLoading(false)
  }, [email, loadUsers])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    checkBackendHealth().then(h => setEnvName(h?.env_name || null))
  }, [])

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

  // Edit name / category / notes on a tracked handle. The endpoint was
  // always an upsert that takes all three — only the UI was missing, so
  // a typo'd label or a handle filed under the wrong category could only
  // be fixed by deleting and re-adding it, losing its history.
  async function saveAccount(acc, fields) {
    setBusy(true)
    try {
      const res = await fetch(`${API_BASE}/admin/ig-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: acc.handle,
          label: fields.label ?? acc.label ?? '',
          category: fields.category ?? acc.category ?? '',
          enabled: acc.enabled,
          notes: fields.notes ?? acc.notes ?? '',
          requesting_email: email,
        }),
      })
      if (!res.ok) throw new Error(`Erro ${res.status}`)
      await load()
      return true
    } catch (e) {
      setError(`Falha ao salvar: ${e.message}`)
      return false
    } finally {
      setBusy(false)
    }
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

  async function syncSocial() {
    if (!confirm(
      'Puxar pessoas, amizades, canais e RSVPs da produção?\n\n' +
      'Os dados vêm ANONIMIZADOS: nomes, e-mails e fotos reais são ' +
      'trocados na produção, antes de sair. A tua conta vem intacta ' +
      'pra você conseguir entrar.\n\n' +
      'Isso APAGA todo o grafo social deste ambiente antes de escrever. ' +
      'Push e tokens de aparelho nunca são copiados.'
    )) return
    setBusy(true)
    setSyncing(true)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 120_000)
    try {
      const r = await fetch(
        withEmail(`${API_BASE}/admin/sync-social`, email),
        { method: 'POST', signal: timeout.signal },
      )
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`)
      alert(
        `Grafo sincronizado (anonimizado).

` +
        `${body.users} pessoas, ${body.friendships} amizades, ` +
        `${body.groups} canais, ${body.group_members} participações, ` +
        `${body.group_events} eventos privados, ${body.rsvps} RSVPs.`
      )
      await load()
    } catch (e) {
      const msg = e.name === 'AbortError'
        ? 'A produção não respondeu em 120s — tenta de novo em instantes.'
        : e.message
      setError(`Falha ao sincronizar pessoas: ${msg}`)
      alert(`Falha ao sincronizar pessoas: ${msg}`)
    }
    clearTimeout(timer)
    setSyncing(false)
    setBusy(false)
  }

  async function syncCatalog() {
    if (!confirm(
      'Puxar o catálogo da produção pra este ambiente?\n\n' +
      'Vem eventos, locais e @s.\n\n' +
      'Pessoas, amizades e canais são o outro botão — este não mexe ' +
      'neles.'
    )) return
    setBusy(true)
    setSyncing(true)
    // The request can legitimately take a while (production fetches its
    // own catalog, then this service writes every row) — but it must
    // not hang forever if Railway's edge or the production service
    // drops it silently. 90s is comfortably above a normal sync and
    // still short enough that the failure is loud, not "nothing".
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 90_000)
    try {
      const r = await fetch(
        withEmail(`${API_BASE}/admin/sync-catalog`, email),
        { method: 'POST', signal: timeout.signal },
      )
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`)
      const dropped = body.skipped?.length
        ? `\n${body.skipped.length} evento(s) ignorado(s) por payload inválido.`
        : ''
      alert(
        `Catálogo sincronizado.\n\n${body.events} eventos, ` +
        `${body.venues} locais, ${body.ig_accounts} @s.${dropped}`
      )
      await load()
    } catch (e) {
      const msg = e.name === 'AbortError'
        ? 'A produção não respondeu em 90s — tenta de novo em instantes.'
        : e.message
      // A silent setError can render off-screen above a long page while
      // the button that triggered it sits near the bottom — this looked
      // exactly like "clicked, nothing happened". The alert can't be missed.
      setError(`Falha ao sincronizar catálogo: ${msg}`)
      alert(`Falha ao sincronizar catálogo: ${msg}`)
    }
    clearTimeout(timer)
    setSyncing(false)
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

  // Grant from a row of the people table, never from a typed email.
  // The old form took an address the founder remembered, and an Apple
  // "Hide My Email" account signs in with a relay address that looks
  // nothing like it — so the grant landed on an email no account used.
  // Promoting the row you can see makes the address the one on file by
  // construction.
  async function grantCurator(targetEmail) {
    const target = (targetEmail || '').trim().toLowerCase()
    if (!target) return
    setBusy(true)
    try {
      const r = await fetch(`${API_BASE}/admin/curators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: target, notes: '', requesting_email: email,
          is_curator: true, is_feedbacker: false,
        }),
      })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      await load()
    } catch (e) {
      setError(`Falha ao liberar: ${e.message}`)
    }
    setBusy(false)
  }

  // Promo code on a handle — founder's monetization tool, moved here
  // from the leaderboard so the one @ list carries it.
  async function setPromo(handle, code, perk) {
    setBusy(true)
    try {
      const r = await fetch(
        `${API_BASE}/admin/ig-accounts/${encodeURIComponent(handle)}/promo`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requesting_email: email, code, perk }),
        },
      )
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${r.status}`)
      }
      await load()
    } catch (e) {
      setError(`Falha ao salvar código: ${e.message}`)
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

  // The menu, or the one section this visit is for. Sections that are
  // their own screens (Pedidos, Locais) just navigate.
  const canSee = (s) => ({
    pedidos: isCurator, contas: isCurator, locais: isCurator,
    pessoas: isFounder, uso: isFounder, feedback: isFounder, ferramentas: isFounder,
  })[s]

  const menu = [
    { id: 'pedidos', icon: '📋', label: 'Pedidos', to: '/curadoria',
      count: pendingCatalog, hint: 'eventos e @s sugeridos, esperando revisão',
      extra: pendingAccounts },
    { id: 'contas', icon: '📷', label: 'Contas @', count: enabledCount, hint: 'as fontes do catálogo' },
    { id: 'locais', icon: '📍', label: 'Locais e pins', to: '/admin/venues', hint: 'onde cada lugar fica no mapa' },
    { id: 'pessoas', icon: '👥', label: 'Pessoas', count: users?.total, hint: 'quem usa, e quem cura' },
    { id: 'uso', icon: '📊', label: 'Uso', count: usage?.dau, hint: 'ativos hoje' },
    { id: 'feedback', icon: '💬', label: 'Feedback', count: feedback.length, hint: 'o que disseram' },
    { id: 'ferramentas', icon: '🛠', label: 'Ferramentas', hint: 'refresh, sync, erros' },
  ].filter(m => canSee(m.id))

  const waiting = (pendingCatalog || 0) + (pendingAccounts || 0)
  const homeLabel = isFounder ? 'Admin' : 'Curadoria'

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

      {isCurator && !section && (
        <>
          {/* The one line the menu opens with: is anything waiting. */}
          {waiting > 0 && (
            <button
              onClick={() => navigate('/curadoria')}
              style={{
                display: 'block', width: '100%', marginBottom: 14, padding: '12px 14px',
                borderRadius: 12, border: '1px solid var(--magenta)', background: 'var(--magenta-soft)',
                color: 'var(--text)', fontSize: 14, fontWeight: 700, textAlign: 'left', cursor: 'pointer',
              }}
            >
              {waiting} {waiting === 1 ? 'pedido esperando' : 'pedidos esperando'} você →
            </button>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {menu.map(m => (
              <MenuCard
                key={m.id}
                {...m}
                onClick={() => navigate(m.to || `/admin/${m.id}`)}
              />
            ))}
          </div>
        </>
      )}

      {isCurator && section && !canSee(section) && (
        <SectionShell home={homeLabel} title="Sem acesso" onBack={() => navigate('/admin')}>
          <div style={{ fontSize: 13, color: 'var(--charcoal-light)' }}>
            Essa parte é do fundador.
          </div>
        </SectionShell>
      )}

      {isCurator && section === 'contas' && (
        <SectionShell home={homeLabel} title="📷 Contas @" onBack={() => navigate('/admin')}>
          {/* Adding a handle happens here now. It lived on Fontes, which
              sent everyone — curators included — to a screen that is
              for looking, and made that screen read as an admin tool. */}
          <AddHandleForm email={email} onAdded={load} flush />
          <div style={{ fontSize: 12, color: 'var(--charcoal-light)', marginBottom: 12 }}>
            Edita, desliga, scrapeia — e o 📍 leva ao pin do lugar no mapa.
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={handleQuery}
              onChange={e => setHandleQuery(e.target.value)}
              placeholder="🔍 Buscar conta (handle, nome, categoria…)"
              style={{ ...inputStyle, flex: '1 1 200px', boxSizing: 'border-box' }}
            />
            <select
              value={accountSort}
              onChange={e => setAccountSort(e.target.value)}
              title="Ordenar"
              style={{ ...inputStyle, flex: '0 0 auto' }}
            >
              {isFounder && <option value="atividade">por atividade (30d)</option>}
              <option value="eventos">mais eventos</option>
              <option value="az">A–Z</option>
            </select>
          </div>

          {loading ? (
            <div style={{ color: 'var(--charcoal-light)', fontSize: 13 }}>Carregando…</div>
          ) : accounts.length === 0 ? (
            <div style={{ color: 'var(--charcoal-light)', fontSize: 13 }}>
              Nenhuma conta cadastrada.
            </div>
          ) : (() => {
            const q = handleQuery.trim().toLowerCase()
            const filtered = (q
              ? accounts.filter(a =>
                  (a.handle || '').toLowerCase().includes(q) ||
                  (a.label || '').toLowerCase().includes(q) ||
                  (a.display_name || '').toLowerCase().includes(q) ||
                  (a.category || '').toLowerCase().includes(q)
                )
              : accounts.slice()
            ).sort((a, b) => {
              if (accountSort === 'atividade') {
                const ra = metricsByHandle[a.handle]?.rank ?? 9999
                const rb = metricsByHandle[b.handle]?.rank ?? 9999
                if (ra !== rb) return ra - rb
              }
              if (accountSort !== 'az') {
                const d = (b.future_events ?? 0) - (a.future_events ?? 0)
                if (d !== 0) return d
              }
              return (a.label || a.handle).localeCompare(b.label || b.handle)
            })
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
                  metrics={isFounder ? metricsByHandle[acc.handle] : null}
                  busy={busy}
                  isFounder={isFounder}
                  onToggle={toggleEnabled}
                  onDelete={deleteAccount}
                  onScrape={scrapeOne}
                  onToggleFeatured={toggleFeatured}
                  onSave={saveAccount}
                  onSetPromo={isFounder ? setPromo : null}
                  onOpenVenue={() => navigate('/admin/venues')}
                  onOpenSource={(h) => navigate(isFounder ? `/venue/${encodeURIComponent(h)}` : `/sources/${encodeURIComponent('ig:' + h)}`)}
                />
              ))}
            </div>
            )
          })()}
        </SectionShell>
      )}

      {isFounder && section === 'pessoas' && (
        <SectionShell home={homeLabel} title="👥 Pessoas" onBack={() => navigate('/admin')}>
          <div style={{ fontSize: 12, color: 'var(--charcoal-light)', marginBottom: 12 }}>
            Todo mundo que entrou, o que fez, e quem cura. Liberar alguém
            como curador é na linha da pessoa — assim o e-mail é o que a
            conta usa de verdade, não um lembrado de cabeça.
          </div>
          <UsersTable
            data={users}
            error={usersError}
            onRetry={loadUsers}
            curators={curators}
            selfEmail={email}
            onGrant={grantCurator}
            onRevoke={removeCurator}
            busy={busy}
          />
        </SectionShell>
      )}

      {isFounder && section === 'uso' && usage && (
        <SectionShell home={homeLabel} title="📊 Uso do app" onBack={() => navigate('/admin')}>
          <UsageSection usage={usage} />
        </SectionShell>
      )}

      {isFounder && section === 'feedback' && (
        <SectionShell home={homeLabel} title="💬 Feedback" onBack={() => navigate('/admin')}>
          <FeedbackSection
            feedback={feedback}
            email={email}
            onReload={load}
            busy={busy}
            setBusy={setBusy}
          />
        </SectionShell>
      )}

      {isFounder && section === 'ferramentas' && (
        <SectionShell home={homeLabel} title="🛠 Ferramentas" onBack={() => navigate('/admin')}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
            <button onClick={triggerRefresh} disabled={busy} style={ghostBtn('var(--sage)')}>
              ▶ Disparar refresh agora
            </button>
            {envName && envName !== 'production' && (
              <button
                onClick={syncCatalog}
                disabled={busy}
                style={ghostBtn('var(--honey)')}
                title="Só catálogo — usuários e push ficam na produção"
              >
                {syncing ? '⬇ Sincronizando…' : '⬇ Puxar catálogo da produção'}
              </button>
            )}
            {envName && envName !== 'production' && (
              <button
                onClick={syncSocial}
                disabled={busy}
                style={ghostBtn('var(--cyan)')}
                title="Anonimizado na produção antes de sair. Apaga o grafo deste ambiente."
              >
                {syncing ? '⬇ Sincronizando…' : '⬇ Puxar pessoas e canais'}
              </button>
            )}
          </div>
          <ClientErrorsSection data={clientErrors} />
          <PostDebugSection email={email} />
        </SectionShell>
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
          background: 'var(--white)', borderRadius: 12, padding: '14px 16px',
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
                  background: 'var(--white)', border: '1px solid var(--border)',
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
    border: `1px solid ${color}`, background: 'var(--white)', color,
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
    <div>
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
        background: 'var(--white)', borderRadius: 12, padding: 14,
        border: '1px solid var(--border)', marginBottom: 14,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)', marginBottom: 2 }}>
          USUÁRIOS ATIVOS POR DIA
        </div>
        {/* Was grouped by user_states.updated_at, which is overwritten on
            every save — so each user landed on their last active day and
            every earlier day read as empty. Now from user_activity (one
            row per user per day), split into first-day vs returning. */}
        <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginBottom: 8 }}>
          <span style={{ color: 'var(--terra)', fontWeight: 700 }}>■</span> novos ·{' '}
          <span style={{ color: 'var(--sage)', fontWeight: 700 }}>■</span> voltaram ·
          antes desta medição, só o último acesso de cada pessoa
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 92 }}>
          {usage.daily.map(d => {
            const newUsers = d.new ?? 0
            const returning = d.returning ?? d.active
            const h = Math.max(2, (d.active / maxDaily) * 70)
            const newH = d.active > 0 ? (newUsers / d.active) * h : 0
            return (
              <div
                key={d.date}
                title={`${d.date}: ${d.active} ativo(s) — ${newUsers} novo(s), ${returning} de volta`}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'flex-end',
                  minWidth: 0,
                }}
              >
                {/* Count label above each bar — readable scan instead
                    of having to hover/long-press for the tooltip. Hidden
                    when 0 to keep the empty-day strip clean. */}
                <span style={{
                  fontSize: 8, fontWeight: 700,
                  color: d.active > 0 ? 'var(--sage)' : 'transparent',
                  marginBottom: 2,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {d.active > 0 ? d.active : ''}
                </span>
                <div style={{ width: '100%', borderRadius: '3px 3px 0 0', overflow: 'hidden' }}>
                  <div style={{ width: '100%', background: 'var(--terra)', height: `${newH}px` }} />
                  <div style={{ width: '100%', background: 'var(--sage)', height: `${h - newH}px` }} />
                </div>
              </div>
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
        background: 'var(--white)', borderRadius: 12, padding: 14,
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
        <Metric label="Novos hoje" value={usage.new_today} small />
        <Metric label="RSVPs" value={usage.counts.rsvps} small />
        <Metric label="Amizades" value={usage.counts.friendships} small />
        <Metric label="Canais" value={usage.counts.groups} small />
        <Metric label="Feedback" value={usage.counts.feedback} small />
        {usage.retention && (
          <Metric
            label={`Voltaram (${usage.retention.returned}/${usage.retention.eligible})`}
            value={`${usage.retention.pct}%`}
            small
          />
        )}
      </div>

    </div>
  )
}


// ── UsersTable — who the users are, not just how many ─────
// The dashboard could only show the ten most recent logins. This is the
// whole list with per-user activity, sorted client-side (tens of rows).
// Inline styles can't be reached by media queries; this is the same
// shape as useIsDesktop, for one table's column set.
function useMinWidth(px) {
  const query = `(min-width: ${px}px)`
  const [ok, setOk] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setOk(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return ok
}

function UsersTable({ data, error, onRetry, curators = [], selfEmail = '', onGrant, onRevoke, busy }) {
  const [sort, setSort] = useState('last_seen')
  const [query, setQuery] = useState('')
  const isWide = useMinWidth(600)
  // Role by email, from the curators table. Feedbacker-only rows don't
  // count as a role any more (feedback is open to everyone).
  const roleOf = (u) => {
    const c = curators.find(c => (c.email || '').toLowerCase() === (u.email || '').toLowerCase())
    return c?.is_founder ? 'founder' : c?.is_curator ? 'curator' : null
  }
  // Curators who were granted by email but have never signed in have no
  // row in the directory. They still need to be visible — and revocable.
  const directoryEmails = new Set((data?.users || []).map(u => (u.email || '').toLowerCase()))
  const grantedNeverSeen = curators.filter(c =>
    (c.is_curator || c.is_founder) && !directoryEmails.has((c.email || '').toLowerCase()))

  // A failed fetch and "this endpoint isn't deployed yet" used to look
  // identical — both just rendered nothing. Show which one it actually is.
  if (error) {
    return (
      <div style={{
        background: 'var(--white)', borderRadius: 12, padding: 14,
        border: '1px solid var(--border)', marginBottom: 14,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)', marginBottom: 8 }}>
          USUÁRIOS
        </div>
        <div style={{ fontSize: 12, color: '#C62828', marginBottom: 10 }}>
          Falha ao carregar: {error}
        </div>
        <button
          onClick={onRetry}
          style={{
            padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--charcoal)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Tentar de novo
        </button>
      </div>
    )
  }
  if (!data) return null

  // Ten columns at 12px are ~600px however tight the name cell is, so a
  // phone gets the six that answer "who is active, who curates"; the
  // rest come back from 600px up. `wide` marks the ones that wait.
  const cols = [
    { key: 'joined', label: 'Entrou', num: false, wide: true },
    { key: 'last_seen', label: 'Visto', num: false },
    { key: 'days_active', label: 'Dias', num: true },
    { key: 'rsvps', label: 'RSVPs', num: true },
    { key: 'friends', label: 'Amigos', num: true, wide: true },
    { key: 'groups', label: 'Canais', num: true, wide: true },
    { key: 'events_created', label: 'Criou', num: true, wide: true },
  ].filter(c => isWide || !c.wide)
  const q = query.trim().toLowerCase()
  const rows = (data.users || [])
    .filter(u => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === 'name') return (a.name || a.email || '').localeCompare(b.name || b.email || '')
      const av = a[sort] ?? '', bv = b[sort] ?? ''
      return av < bv ? 1 : av > bv ? -1 : 0
    })

  const fmtDay = iso => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '—')
  const th = active => ({
    textAlign: 'left', padding: '6px 6px', fontSize: 10, fontWeight: 700,
    color: active ? 'var(--terra)' : 'var(--charcoal-light)',
    textTransform: 'uppercase', letterSpacing: 0.4, cursor: 'pointer',
    whiteSpace: 'nowrap', background: 'none', border: 'none',
  })

  return (
    <div style={{
      background: 'var(--white)', borderRadius: 12, padding: 14,
      border: '1px solid var(--border)', marginBottom: 14,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, marginBottom: 10, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)' }}>
          PESSOAS · {data.total}
        </div>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Buscar nome ou email"
          style={{ ...inputStyle, flex: '0 1 200px', padding: '6px 10px', fontSize: 12 }}
        />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ textAlign: 'left' }}>
                <button onClick={() => setSort('name')} style={th(sort === 'name')}>Pessoa</button>
              </th>
              {cols.map(c => (
                <th key={c.key} style={{ textAlign: c.num ? 'right' : 'left' }}>
                  <button onClick={() => setSort(c.key)} style={th(sort === c.key)}>{c.label}</button>
                </th>
              ))}
              <th style={{ textAlign: 'right' }}>
                <span style={{ ...th(false), cursor: 'default' }}>Push</span>
              </th>
              <th style={{ textAlign: 'right' }}>
                <span style={{ ...th(false), cursor: 'default' }}>Papel</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(u => (
              <tr key={u.google_id} style={{ borderBottom: '1px solid var(--cream)' }}>
                <td style={{ padding: '6px 6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 104 }}>
                    {u.picture ? (
                      <img src={u.picture} alt="" referrerPolicy="no-referrer"
                        style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0 }} />
                    ) : (
                      <div style={{
                        width: 22, height: 22, borderRadius: '50%', background: 'var(--cream)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, flexShrink: 0,
                      }}>{(u.name || u.email || '?')[0]?.toUpperCase()}</div>
                    )}
                    {/* One line, 110px, email in the tooltip. The cell used
                        to reserve 160px and stack the email under the name,
                        which on a phone pushed the whole table into a
                        sideways scroll for the sake of a second line few
                        people read. The search box still matches email. */}
                    <div
                      title={u.email && u.email !== u.name ? u.email : undefined}
                      style={{
                        fontWeight: 600, color: 'var(--charcoal)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110,
                      }}
                    >
                      {u.name || u.email || u.google_id.slice(0, 10)}
                    </div>
                  </div>
                </td>
                {isWide && <td style={{ padding: '6px 6px', color: 'var(--charcoal-mid)', whiteSpace: 'nowrap' }}>{fmtDay(u.joined)}</td>}
                <td style={{ padding: '6px 6px', color: 'var(--charcoal-mid)', whiteSpace: 'nowrap' }}>{fmtDay(u.last_seen)}</td>
                <td style={{ padding: '6px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.days_active}</td>
                <td style={{ padding: '6px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.rsvps}</td>
                {isWide && <td style={{ padding: '6px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.friends}</td>}
                {isWide && <td style={{ padding: '6px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.groups}</td>}
                {isWide && <td style={{ padding: '6px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.events_created}</td>}
                <td style={{ padding: '6px 6px', textAlign: 'right' }}>{u.push_devices > 0 ? '🔔' : '—'}</td>
                <td style={{ padding: '6px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <RoleCell
                    role={roleOf(u)}
                    isSelf={(u.email || '').toLowerCase() === (selfEmail || '').toLowerCase()}
                    canEdit={!!onGrant}
                    busy={busy}
                    onGrant={() => onGrant?.(u.email)}
                    onRevoke={() => onRevoke?.(u.email)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--charcoal-light)', paddingTop: 8 }}>
          Nenhuma pessoa encontrada.
        </div>
      )}
      {grantedNeverSeen.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)', marginBottom: 6 }}>
            LIBERADOS QUE NUNCA ENTRARAM
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginBottom: 8, lineHeight: 1.4 }}>
            Curadores por e-mail sem conta no diretório. Se a pessoa entrou
            pela Apple com "Ocultar meu email", o endereço real dela é outro
            — libera pela linha dela acima e remove este.
          </div>
          {grantedNeverSeen.map(c => (
            <div key={c.email} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.email}{c.is_founder ? ' · fundador' : ''}
              </span>
              {!c.is_founder && onRevoke && (
                <button onClick={() => onRevoke(c.email)} disabled={busy} title="Remover curador"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--charcoal-light)' }}>
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


// A person's role, and the one action the founder has on it. Founder
// rows and your own row carry no action: you can't demote yourself by
// accident, and there is only one founder.
function RoleCell({ role, isSelf, canEdit, busy, onGrant, onRevoke }) {
  if (role === 'founder') {
    return <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 5, background: '#FFF3E0', color: '#FF8F00' }}>FUNDADOR</span>
  }
  if (role === 'curator') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 5, background: 'var(--sage-pale)', color: 'var(--sage)' }}>CURADOR</span>
        {canEdit && !isSelf && (
          <button onClick={onRevoke} disabled={busy} title="Remover curador"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--charcoal-light)', padding: 0 }}>
            🗑
          </button>
        )}
      </span>
    )
  }
  if (!canEdit) return <span style={{ color: 'var(--charcoal-light)' }}>—</span>
  return (
    <button onClick={onGrant} disabled={busy} title="Liberar como curador"
      style={{ ...ghostBtn('var(--sage)'), padding: '3px 8px', fontSize: 10 }}>
      + curador
    </button>
  )
}


// A menu card: the job, and the one number that says whether to open it.
function MenuCard({ icon, label, hint, count, extra, onClick }) {
  const n = (count ?? null) === null ? null : count + (extra || 0)
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: 'pointer', padding: '14px 14px 12px',
        borderRadius: 14, border: '1px solid var(--line)', background: 'var(--bg2)',
        color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 92,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
        {n !== null && (
          <span className="neon-display" style={{
            fontSize: 22, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
            color: n > 0 ? 'var(--magenta)' : 'var(--text3)',
          }}>{n}</span>
        )}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.35 }}>{hint}</div>
    </button>
  )
}


// The frame every section sits in: a way back, and a title.
function SectionShell({ title, onBack, home = 'Admin', children }) {
  return (
    <section>
      <button
        onClick={onBack}
        className="neon-mono"
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          color: 'var(--text3)', fontSize: 10, letterSpacing: '0.18em',
          textTransform: 'uppercase', marginBottom: 10,
        }}
      >
        ← {home}
      </button>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 10px' }}>{title}</h2>
      {children}
    </section>
  )
}


function ClientErrorsSection({ data }) {
  const [sort, setSort] = useState('count')
  const [query, setQuery] = useState('')
  if (!data) return null

  const q = query.trim().toLowerCase()
  const rows = (data.errors || [])
    .filter(e => !q || e.message.toLowerCase().includes(q) || e.error_type.toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === 'count') return b.count - a.count
      if (sort === 'last_seen') return b.last_seen < a.last_seen ? -1 : 1
      return String(a[sort]).localeCompare(String(b[sort]))
    })

  const fmt = iso => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
  const th = active => ({
    textAlign: 'left', padding: '6px 6px', fontSize: 10, fontWeight: 700,
    color: active ? 'var(--terra)' : 'var(--charcoal-light)',
    textTransform: 'uppercase', letterSpacing: 0.4, cursor: 'pointer',
    whiteSpace: 'nowrap', background: 'none', border: 'none',
  })

  return (
    <div style={{
      background: 'var(--white)', borderRadius: 12, padding: 14,
      border: '1px solid var(--border)', marginBottom: 14,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, marginBottom: 10, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)' }}>
          ERROS DO CLIENTE · {rows.length} distinto{rows.length === 1 ? '' : 's'}
        </div>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Buscar mensagem ou tipo"
          style={{ ...inputStyle, flex: '0 1 200px', padding: '6px 10px', fontSize: 12 }}
        />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th><button onClick={() => setSort('error_type')} style={th(sort === 'error_type')}>Tipo</button></th>
              <th><button onClick={() => setSort('message')} style={th(sort === 'message')}>Mensagem</button></th>
              <th style={{ textAlign: 'right' }}><button onClick={() => setSort('count')} style={th(sort === 'count')}>Vezes</button></th>
              <th><button onClick={() => setSort('last_seen')} style={th(sort === 'last_seen')}>Última vez</button></th>
              <th style={{ textAlign: 'left' }}><span style={{ ...th(false), cursor: 'default' }}>Amostra</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(e => (
              <tr key={`${e.error_type}:${e.message}`} style={{ borderBottom: '1px solid var(--cream)' }}>
                <td style={{ padding: '6px 6px', color: 'var(--charcoal-mid)', whiteSpace: 'nowrap' }}>{e.error_type}</td>
                <td style={{
                  padding: '6px 6px', color: 'var(--charcoal)', maxWidth: 320,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={e.message}>
                  {e.message || <span style={{ color: 'var(--charcoal-light)' }}>(sem mensagem)</span>}
                </td>
                <td style={{ padding: '6px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{e.count}</td>
                <td style={{ padding: '6px 6px', color: 'var(--charcoal-mid)', whiteSpace: 'nowrap' }}>{fmt(e.last_seen)}</td>
                <td style={{
                  padding: '6px 6px', color: 'var(--charcoal-light)', maxWidth: 200,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={e.sample_url}>
                  {e.sample_url || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--charcoal-light)', paddingTop: 8 }}>
          Nenhum erro registrado.
        </div>
      )}
    </div>
  )
}


function Metric({ label, value, small }) {
  return (
    <div style={{
      background: 'var(--white)', borderRadius: 10, padding: small ? '8px 10px' : '10px 12px',
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
  background: 'var(--sage)', color: '#14081E', fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13,
  opacity: disabled ? 0.5 : 1,
})

const ghostBtn = (color) => ({
  padding: '8px 14px', borderRadius: 8,
  border: `1px solid ${color}`, background: 'var(--white)', color,
  fontWeight: 700, fontSize: 12, cursor: 'pointer',
})


// "Esse post não virou evento" used to be answerable only by reading
// Railway logs. Paste the link, get the model's actual answer and the
// reason each event was rejected.
function PostDebugSection({ email }) {
  const [url, setUrl] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState(false)

  async function run() {
    const link = url.trim()
    if (!link) return
    setRunning(true); setError(null); setResult(null)
    try {
      const r = await fetch(
        `${API_BASE}/admin/ig-extract-debug?url=${encodeURIComponent(link)}`
        + `&requesting_email=${encodeURIComponent(email)}`
      )
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`)
      setResult(body)
    } catch (e) {
      setError(e.message)
    }
    setRunning(false)
  }

  return (
    <section style={{ marginBottom: 14 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'block', width: '100%', padding: '12px 14px',
          borderRadius: 12, border: '1px solid var(--line)', background: 'var(--bg2)',
          color: 'var(--text)', fontSize: 14, fontWeight: 700,
          textAlign: 'left', cursor: 'pointer',
        }}
      >
        🔍 Por que esse post não virou evento? {open ? '▾' : '▸'}
      </button>

      {open && (
        <div style={{
          marginTop: 8, padding: 12, borderRadius: 12,
          border: '1px solid var(--border)', background: 'var(--white)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', lineHeight: 1.5 }}>
            Cola o link de um post do Instagram. Roda a extração nele e mostra
            o que o modelo respondeu — e o motivo de cada evento que caiu.
            Custa uma chamada Apify + uma Claude.
          </div>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/p/..."
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', flex: 'unset' }}
          />
          <button onClick={run} disabled={running || !url.trim()} style={ghostBtn('var(--sage)')}>
            {running ? 'Analisando…' : '▶ Analisar post'}
          </button>

          {error && (
            <div style={{
              padding: '9px 12px', background: 'var(--terra-pale)',
              color: 'var(--terra)', borderRadius: 8, fontSize: 12,
            }}>
              {error}
            </div>
          )}

          {result && <PostDebugResult result={result} />}
          {result?.ok && (result.extracted || []).length > 0 && (
            <div style={{
              padding: '9px 12px', background: 'var(--cream)', borderRadius: 8,
              fontSize: 11, color: 'var(--charcoal-mid)', lineHeight: 1.5,
            }}>
              Isso é só um teste — nada foi salvo. Pra colocar no catálogo,
              roda o 🔄 na linha do @{result.handle}.
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function PostDebugResult({ result }) {
  const line = { fontSize: 12, color: 'var(--charcoal)', lineHeight: 1.6 }
  const muted = { fontSize: 11, color: 'var(--charcoal-mid)' }
  if (result.ok === false) {
    return <div style={line}>Parou em <b>{result.stage}</b>: {result.detail}</div>
  }
  const extracted = result.extracted || []
  const dropped = result.dropped || []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={line}>
        <b>@{result.handle}</b> · postado {result.posted_at || '—'}<br />
        Flyer enviado pro modelo:{' '}
        <b style={{ color: result.image_sent_to_model ? 'var(--sage)' : 'var(--terra)' }}>
          {result.image_sent_to_model ? 'sim' : 'não'}
        </b>
      </div>

      <div>
        <div style={{ ...muted, fontWeight: 700, marginBottom: 4 }}>
          ✅ Passaram nas travas · {extracted.length}
        </div>
        {extracted.length === 0 ? (
          <div style={muted}>nenhum</div>
        ) : extracted.map(e => (
          <div key={e.external_id} style={line}>
            • <b>{e.name}</b> — {(e.date_start || '').replace('T', ' ').slice(0, 16)}
            {e.venue_name ? ` · ${e.venue_name}` : ''}
          </div>
        ))}
      </div>

      {dropped.length > 0 && (
        <div>
          <div style={{ ...muted, fontWeight: 700, marginBottom: 4 }}>
            ✕ Caíram · {dropped.length}
          </div>
          {dropped.map((d, i) => (
            <div key={i} style={line}>• <b>{d.name}</b> — {d.reason}</div>
          ))}
        </div>
      )}

      <details>
        <summary style={{ ...muted, cursor: 'pointer' }}>Resposta crua do modelo</summary>
        <pre style={{
          fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          color: 'var(--charcoal-mid)', marginTop: 6,
        }}>
          {JSON.stringify(result.model_answer, null, 2)}
        </pre>
      </details>

      <details>
        <summary style={{ ...muted, cursor: 'pointer' }}>Legenda enviada</summary>
        <div style={{ ...muted, whiteSpace: 'pre-wrap', marginTop: 6 }}>
          {result.caption || '—'}
        </div>
      </details>
    </div>
  )
}


function Header({ userName, email, isCurator, isFounder, enabledCount, totalCount }) {
  const role = isFounder ? 'Fundador' : isCurator ? 'Curador' : 'Visitante'
  const roleColor = isFounder ? '#FF8F00' : isCurator ? 'var(--sage)' : 'var(--charcoal-light)'
  return (
    <div style={{ marginBottom: 20 }}>
      {/* The screen is called what the person is — same rule as the
          nav tab. A curator's screen titled "Admin" reads as someone
          else's. */}
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{isFounder ? 'Admin' : 'Curadoria'}</h1>
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


// Venue leaderboard — single founder surface that merges the old
// "Negociação" sales table with the operational "Contas ativas" list.
// Each row carries: rank, avatar, name + handle + last scrape, the
// venue's catalog event count, monthly view/RSVP/conversion stats,
// plus action affordances (⭐ Seleção auê toggle, manual scrape,
// delete). Tap the row body → opens the venue's Painel.
// The one row for a tracked @. It used to be two: a leaderboard row for
// the founder (rank, 30d views/RSVPs, promo) and this one for curators.
// Same handle, same edit, same scrape, same delete — so one row, and the
// founder's extras are an overlay (`metrics`, `onSetPromo`) rather than
// a second list.
function AccountRow({ acc, metrics, busy, onToggle, onDelete, onScrape, onOpenSource, onOpenVenue, onToggleFeatured, onSave, onSetPromo, isFounder }) {
  const [promoOpen, setPromoOpen] = useState(false)
  const [promoCode, setPromoCode] = useState(acc.promo_code || '')
  const [promoPerk, setPromoPerk] = useState(acc.promo_perk || '')
  useEffect(() => {
    setPromoCode(acc.promo_code || '')
    setPromoPerk(acc.promo_perk || '')
  }, [acc.promo_code, acc.promo_perk])
  const futureCount = acc.future_events ?? 0
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(acc.label || '')
  const [category, setCategory] = useState(acc.category || '')
  const [notes, setNotes] = useState(acc.notes || '')

  async function submit() {
    const ok = await onSave(acc, { label, category, notes })
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <div style={{
        background: 'var(--white)', border: '1px solid var(--sage)',
        borderRadius: 12, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
          @{acc.handle}
        </div>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Nome (ex: Bar do Sax)"
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', flex: 'unset' }}
        />
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', flex: 'unset' }}
        >
          <option value="">— sem categoria —</option>
          {CATEGORY_ORDER.map(c => (
            <option key={c} value={c}>
              {CATEGORY_META[c].emoji} {CATEGORY_META[c].label}
            </option>
          ))}
        </select>
        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Anotação interna (opcional)"
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', flex: 'unset' }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={busy} style={{ ...ghostBtn('var(--sage)'), flex: 1 }}>
            {busy ? '…' : '✓ Salvar'}
          </button>
          <button
            onClick={() => {
              setLabel(acc.label || ''); setCategory(acc.category || '')
              setNotes(acc.notes || ''); setEditing(false)
            }}
            disabled={busy}
            style={{ ...ghostBtn('var(--charcoal-light)'), flex: 1 }}
          >
            Cancelar
          </button>
        </div>
      </div>
    )
  }
  // Prefix BASE_URL for our rehosted-avatar paths in dev — without
  // this, the <Avatar> tries to load /event-images/avatars/... from
  // Vite :5173 and 404s. Same logic as fetchSources's absoluteImageUrl.
  const rawPic = acc.profile_pic_url
  const pic = (rawPic && API_BASE && rawPic.startsWith('/event-images/'))
    ? `${API_BASE}${rawPic}`
    : rawPic
  return (
    <div style={{
      background: 'var(--white)', border: acc.featured ? '1.5px solid var(--honey)' : '1px solid var(--border)',
      borderRadius: 12, overflow: 'hidden',
      opacity: acc.enabled ? 1 : 0.55,
    }}>
    <div style={{
      padding: 12,
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
          width: 18, height: 18, borderRadius: '50%', background: 'var(--white)',
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

      {/* Founder overlay: 30d views / RSVPs, from the leaderboard. */}
      {metrics && (
        <div
          title={`${metrics.views} visualizações · ${metrics.rsvps} RSVPs · ${(metrics.conversion_rate * 100).toFixed(1)}% conversão (30d)`}
          style={{
            display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0,
            fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums', textAlign: 'right',
          }}
        >
          <span style={{ color: 'var(--terra-light)' }}>👀 {metrics.views}</span>
          <span style={{ color: 'var(--sage)' }}>🙌 {metrics.rsvps}</span>
        </div>
      )}

      {/* Where this place is on the map. Editing an @ includes fixing
          its pin — the venue row lives on its own screen, this is the
          door to it from the account. */}
      {onOpenVenue && (
        <button
          onClick={onOpenVenue}
          disabled={busy}
          title="Localização no mapa (pin do local)"
          style={{
            background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer',
            fontSize: 14, color: 'var(--charcoal-light)', padding: 4,
          }}
        >
          📍
        </button>
      )}

      {onSetPromo && (
        <button
          onClick={() => setPromoOpen(o => !o)}
          disabled={busy}
          title={acc.promo_code ? `Editar cupom (${acc.promo_code})` : 'Adicionar cupom'}
          style={{
            background: acc.promo_code ? 'var(--sage-pale)' : 'none',
            border: acc.promo_code ? '1px solid var(--sage)' : '1px solid var(--border)',
            borderRadius: 999, cursor: busy ? 'default' : 'pointer',
            fontSize: 11, color: acc.promo_code ? 'var(--sage)' : 'var(--charcoal-light)',
            padding: '2px 6px', lineHeight: 1,
          }}
        >🎁</button>
      )}

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
      {onSave && (
        <button
          onClick={() => setEditing(true)}
          disabled={busy}
          title="Editar nome e categoria"
          style={{
            background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer',
            fontSize: 14, color: 'var(--charcoal-light)', padding: 4,
          }}
        >
          ✏️
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
    {onSetPromo && promoOpen && (
      <div style={{
        padding: '8px 12px', borderTop: '1px dashed var(--border)',
        background: 'var(--cream)', display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ fontSize: 10, color: 'var(--charcoal-mid)', fontWeight: 700 }}>
          🎁 Cupom Seleção auê para @{acc.handle}
        </div>
        <input
          value={promoCode}
          onChange={e => setPromoCode(e.target.value.slice(0, 32))}
          placeholder="Código (ex. AUE10)"
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', flex: 'unset', fontFamily: 'monospace' }}
        />
        <input
          value={promoPerk}
          onChange={e => setPromoPerk(e.target.value.slice(0, 120))}
          placeholder="Vantagem (ex. 10% off no chopp)"
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', flex: 'unset' }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => { onSetPromo(acc.handle, promoCode.trim(), promoPerk.trim()); setPromoOpen(false) }}
            disabled={busy}
            style={{ ...ghostBtn('var(--sage)'), flex: 1 }}
          >Salvar</button>
          {(acc.promo_code || promoCode) && (
            <button
              onClick={() => { onSetPromo(acc.handle, '', ''); setPromoCode(''); setPromoPerk(''); setPromoOpen(false) }}
              disabled={busy}
              style={{ ...ghostBtn('var(--charcoal-light)'), flex: 1 }}
            >Limpar</button>
          )}
          <button onClick={() => setPromoOpen(false)} style={{ ...ghostBtn('var(--charcoal-light)'), flex: 1 }}>
            Cancelar
          </button>
        </div>
        {!acc.featured && (
          <div style={{ fontSize: 10, color: 'var(--charcoal-light)', fontStyle: 'italic' }}>
            ⚠️ Esse local não é Seleção auê — o código fica salvo mas não aparece pros usuários até você ativar a estrela.
          </div>
        )}
      </div>
    )}
    </div>
  )
}


const checkLabelStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  fontSize: 12, fontWeight: 600, color: 'var(--charcoal)', cursor: 'pointer',
}
