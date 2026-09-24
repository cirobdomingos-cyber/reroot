import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGoBack } from '../lib/navigation'
import { fetchSources } from '../services/api'
import { useApp } from '../context/AppContext'
import { CATEGORY_META, CATEGORY_ORDER, INST_CATEGORY } from '../data/categories'
import Avatar from '../components/Avatar'

import { API_BASE } from '../lib/apiBase'

// Unified browser for every catalog source — institutional + Instagram
// handles, grouped by category. Same taxonomy as the Events tab filter
// chips (both import CATEGORY_META from src/data/categories).

function categoryFor(source, isIg) {
  if (isIg) return (source.category || 'outro').toLowerCase()
  return INST_CATEGORY[source.id] || 'outro'
}


export default function Sources() {
  const navigate = useNavigate()
  const { state, dispatch } = useApp()
  const goBack = useGoBack('/events')
  // Opt-out follow list (lib/follows.js) — handles the user hid.
  const unfollowed = useMemo(
    () => new Set((state.unfollowedSources || []).map(h => h.toLowerCase())),
    [state.unfollowedSources],
  )
  function toggleFollow(handle) {
    dispatch({ type: 'TOGGLE_FOLLOW_SOURCE', payload: handle })
  }
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
      featured: !!s.featured,
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

  // Featured-bucket first: every source flagged as Destaque OR the
  // institutional Seleção auê. These pin to the very top of the page,
  // above every category, so the paid placements + editorial line are
  // always the first thing the user sees.
  const featuredSources = useMemo(() =>
    allSources.filter(s => s.featured || s.id === 'aue_original')
      .sort((a, b) => {
        // aue_original first (editorial), then most-events, then alpha.
        if (a.id === 'aue_original') return -1
        if (b.id === 'aue_original') return 1
        const yd = (b.future_events || 0) - (a.future_events || 0)
        if (yd !== 0) return yd
        return a.sortKey.localeCompare(b.sortKey)
      }),
    [allSources],
  )
  const featuredIds = useMemo(() => new Set(featuredSources.map(s => s.id)), [featuredSources])

  // Bucket all sources by category — minus the featured set, which
  // renders in its own section above (no double-listing).
  const buckets = useMemo(() => {
    const out = {}
    for (const s of allSources) {
      if (featuredIds.has(s.id)) continue
      const cat = s.category in CATEGORY_META ? s.category : 'outro'
      if (!out[cat]) out[cat] = []
      out[cat].push(s)
    }
    for (const cat of Object.keys(out)) {
      out[cat].sort((a, b) => {
        const yd = (b.future_events || 0) - (a.future_events || 0)
        if (yd !== 0) return yd
        return a.sortKey.localeCompare(b.sortKey)
      })
    }
    return out
  }, [allSources, featuredIds])

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
          onClick={goBack}
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
        {!loading && (
          <div style={{ fontSize: 12, color: 'var(--charcoal-light)', marginTop: 6, lineHeight: 1.45 }}>
            {unfollowed.size === 0 ? (
              'Você segue todas. Toque em "Seguindo" pra tirar uma conta do seu feed.'
            ) : (
              <>
                Você deixou de seguir {unfollowed.size} conta{unfollowed.size === 1 ? '' : 's'} ·{' '}
                <button
                  onClick={() => dispatch({ type: 'SET_UNFOLLOWED_SOURCES', payload: [] })}
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    color: 'var(--cyan)', fontSize: 12, fontWeight: 700,
                  }}
                >
                  seguir todas de novo
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* This screen is for looking: which sources auê watches, and
          the one personal choice you get here — whether a source is in
          your feed. Curation (adding handles, the review queue) lives on
          the Curadoria tab; it used to sit at the top of this page and
          made it read as an admin tool to everyone else. */}

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
              background: 'var(--white)',
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
          background: 'var(--white)', borderRadius: 12, border: '1px dashed var(--border)',
          color: 'var(--charcoal-light)', fontSize: 13,
        }}>
          Nada com "{query}". Tenta uma palavra mais curta.
        </div>
      ) : renderedBuckets.length === 0 && featuredSources.length === 0 ? (
        <div style={{
          margin: '0 16px', padding: '24px 16px', textAlign: 'center',
          background: 'var(--white)', borderRadius: 12, border: '1px dashed var(--border)',
          color: 'var(--charcoal-light)', fontSize: 13,
        }}>
          Nenhuma fonte ainda nesta categoria.
        </div>
      ) : (
        <>
          {/* Seleção auê section pinned above every category. Holds the
              paid Destaque IG handles. The institutional aue_original
              source IS the section's brand/identity now (it's the
              header label itself), so we don't render its placeholder
              card — that would just be "Seleção auê" inside "Seleção
              auê", weird. aue_original is still excluded from the
              category buckets via featuredIds, and its events still
              get the Destaque pill + top-of-list sorting on Events. */}
          {activeCategory === 'all' && (() => {
            const visibleFeatured = featuredSources
              .filter(s => s.id !== 'aue_original')
              .filter(passesSearch)
            if (visibleFeatured.length === 0) return null
            const eventCount = visibleFeatured.reduce((sum, s) => sum + (s.future_events || 0), 0)
            return (
              <Section
                title={`⭐ Seleção auê · ${visibleFeatured.length}`}
                sub={eventCount > 0 ? `${eventCount} evento${eventCount === 1 ? '' : 's'} próximo${eventCount === 1 ? '' : 's'}` : ''}
              >
                {visibleFeatured.map(s => (
                  <SourceRow
                    key={s.id}
                    source={s}
                    following={!s.handle || !unfollowed.has(s.handle.toLowerCase())}
                    onToggleFollow={s.handle ? () => toggleFollow(s.handle) : null}
                    onOpen={() => navigate(`/sources/${encodeURIComponent(s.id)}`)}
                  />
                ))}
              </Section>
            )
          })()}
          {renderedBuckets.map(({ cat, items }) => {
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
                  following={!s.handle || !unfollowed.has(s.handle.toLowerCase())}
                  onToggleFollow={s.handle ? () => toggleFollow(s.handle) : null}
                  onOpen={() => navigate(`/sources/${encodeURIComponent(s.id)}`)}
                />
              ))}
            </Section>
          )
        })}
        </>
      )}

      {/* At the bottom, for anyone signed in — curators included. A
          suggestion goes to the review queue, which is how the catalog
          grows from outside the team. Down here it's an offer, not a
          form the page opens with. */}
      {!loading && state.googleUser?.id && (
        <SuggestAccountForm googleId={state.googleUser.id} />
      )}
    </div>
  )
}


// "Sugerir uma conta" — for anyone signed in. Goes to the
// curator queue (/curadoria?tab=contas) instead of straight into tracking:
// every tracked account costs an Apify + Claude pass each day.
function SuggestAccountForm({ googleId }) {
  const [open, setOpen] = useState(false)
  const [handle, setHandle] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const clean = handle.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?].*$/, '')
    if (!/^[A-Za-z0-9._]{1,30}$/.test(clean)) {
      setFeedback({ kind: 'err', msg: 'Confere o @ (letras, números, "." ou "_")' })
      return
    }
    setSubmitting(true)
    setFeedback(null)
    try {
      const r = await fetch(`${API_BASE}/accounts/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ google_id: googleId, handle: clean, note: note.trim() }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setFeedback({ kind: 'err', msg: d.detail || `Erro ${r.status}` })
      } else if (d.status === 'already_tracked') {
        setFeedback({ kind: 'ok', msg: `@${d.handle} já está nas fontes do auê.` })
      } else {
        setFeedback({ kind: 'ok', msg: `Valeu! A curadoria vai dar uma olhada em @${d.handle}.` })
        setHandle(''); setNote('')
      }
    } catch (err) {
      setFeedback({ kind: 'err', msg: err?.message || 'Não deu pra enviar agora' })
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <div style={{ padding: '0 16px 12px' }}>
        <button
          onClick={() => setOpen(true)}
          style={{
            width: '100%', padding: '10px 14px',
            background: 'transparent', color: 'var(--cyan)',
            border: '1.5px dashed var(--cyan)',
            borderRadius: 12, cursor: 'pointer',
            fontSize: 13, fontWeight: 700, letterSpacing: 0.3,
          }}
        >
          💡 Sugerir uma conta do Instagram
        </button>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      style={{
        margin: '0 16px 14px', padding: '14px',
        background: 'var(--white)', borderRadius: 14,
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
          Sugerir uma conta
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
      <div style={{ fontSize: 12, color: 'var(--charcoal-light)', marginBottom: 10, lineHeight: 1.45 }}>
        Um bar, uma casa de show, um coletivo que posta a agenda no Insta. A curadoria confere e, se rolar, os eventos começam a aparecer no auê.
      </div>
      <input
        value={handle}
        onChange={e => setHandle(e.target.value)}
        placeholder="@conta ou link do perfil"
        autoCapitalize="none"
        autoCorrect="off"
        style={inputStyle}
      />
      <input
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="O que rola lá? (opcional)"
        maxLength={300}
        style={{ ...inputStyle, marginTop: 8 }}
      />
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
          background: 'var(--cyan)', color: '#14081E',
          border: 'none', borderRadius: 12,
          fontSize: 13, fontWeight: 700,
          cursor: submitting ? 'wait' : 'pointer',
          opacity: (submitting || !handle.trim()) ? 0.55 : 1,
        }}
      >
        {submitting ? 'Enviando…' : 'Enviar sugestão'}
      </button>
    </form>
  )
}


const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: '9px 12px',
  fontSize: 13, fontFamily: 'inherit',
  background: 'var(--white)',
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
        background: active ? 'var(--magenta)' : 'transparent',
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


function SourceRow({ source: s, onOpen, following = true, onToggleFollow = null }) {
  const isIg = s.kind === 'ig'
  // Featured-handle treatment mirrors the EventCard: a honey 1.5px
  // border instead of the default neutral, plus a star pill near the
  // count. Tells the user "this venue is paying us to surface them"
  // without screaming about it.
  const isFeatured = !!s.featured || s.id === 'aue_original'
  return (
    <div
      onClick={onOpen}
      style={{
        background: 'var(--white)', borderRadius: 14,
        border: isFeatured ? '1.5px solid var(--honey)' : '1px solid var(--border)',
        padding: '12px 14px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 12,
        // Unfollowed accounts stay listed (so you can follow them back)
        // but read as switched off.
        opacity: following ? 1 : 0.6,
      }}
    >
      {isIg ? (
        <Avatar src={s.profile_pic_url} name={s.label} size={40} expandable={false} />
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
        {isFeatured && (
          <span title="Destaque auê" style={{
            fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
            color: 'var(--honey)', background: 'var(--honey-pale)',
            padding: '2px 6px', borderRadius: 999,
            border: '1px solid var(--honey)',
          }}>
            ⭐
          </span>
        )}
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
        {onToggleFollow && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFollow() }}
            aria-pressed={following}
            title={following ? 'Deixar de seguir' : 'Seguir'}
            style={{
              padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
              fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
              border: following ? '1px solid var(--border)' : '1px solid var(--cyan)',
              background: following ? 'transparent' : 'var(--cyan)',
              color: following ? 'var(--charcoal-light)' : '#14081E',
            }}
          >
            {following ? 'Seguindo' : 'Seguir'}
          </button>
        )}
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
