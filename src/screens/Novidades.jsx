import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import HomeEventRow from '../components/HomeEventRow'
import { fetchEvents, trackEvent, BASE_URL } from '../services/api'

// "Novidades" — the daily digest as its own curated page, not the Eventos
// list wearing a filter.
//
// The first version of this route rendered <Events /> with a digest filter
// applied, which technically showed the right rows but read as "Eventos,
// but fewer" — same three rows of filter chips, same week strip, same
// search, plus a "Limpar" banner explaining why things were missing. A
// digest should feel like something someone put together for you, so this
// screen carries none of that chrome: a date, a count, and the rows.
//
// Events.jsx still handles the legacy ?digest= / ?new= query params, since
// production pushes keep sending those until DIGEST_URL_NOVIDADES flips
// (see _digest_deep_link in backend/main.py) and old installed bundles
// have no route for /novidades at all.

// Marks a digest as read once it's actually been opened, so Home's
// "✨ N novidades" card doesn't keep offering something you already saw.
// Keyed by digest id, and each scrape mints a new one — so this hides the
// card for that batch only, and the next scrape brings it back on its own.
// Per-device by design: it's a "you already looked at this" flag, not
// account state worth a backend round-trip.
const SEEN_KEY = 'aue_seen_digest_id'

export function hasSeenDigest(digestId) {
  try {
    return !!digestId && localStorage.getItem(SEEN_KEY) === digestId
  } catch {
    return false
  }
}

const PT_MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
]
const PT_WEEKDAYS = [
  'Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado',
]

function formatDigestDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${PT_WEEKDAYS[d.getDay()]}, ${d.getDate()} de ${PT_MONTHS[d.getMonth()]}`
}

export default function Novidades() {
  const { digestId } = useParams()
  const navigate = useNavigate()

  const [events, setEvents] = useState(null)   // null = still loading
  const [digestDate, setDigestDate] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!digestId) return
    let cancelled = false
    trackEvent('novidades_opened', { digest_id: digestId })

    async function load() {
      try {
        const res = await fetch(`${BASE_URL}/digests/${encodeURIComponent(digestId)}`)
        if (!res.ok) throw new Error(`Erro ${res.status}`)
        const digest = await res.json()
        const ids = digest?.event_ids || []
        if (cancelled) return
        setDigestDate(digest?.created_at || '')
        // Resolved, so it counts as seen even if it turned out empty —
        // the point is the person came and looked.
        try { localStorage.setItem(SEEN_KEY, digestId) } catch {}
        if (!ids.length) { setEvents([]); return }

        // The catalog fetch is the same offline-first one Eventos uses, so
        // this page still renders from embedded data when the backend is
        // unreachable — the digest ids just resolve against whatever the
        // catalog knows.
        const { events: all } = await fetchEvents('all')
        if (cancelled) return
        // Keep the digest's own order: the backend sorts it by date_start
        // ascending, so the soonest thing leads.
        const byId = new Map((all || []).map(ev => [ev.id, ev]))
        setEvents(ids.map(id => byId.get(id)).filter(Boolean))
      } catch {
        if (!cancelled) { setFailed(true); setEvents([]) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [digestId])

  const count = events?.length || 0

  return (
    <div style={{ paddingBottom: 90 }}>
      <div style={{ padding: '18px 18px 0' }}>
        <button
          onClick={() => navigate('/events')}
          className="neon-mono"
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--text3)', fontSize: 10, letterSpacing: '0.18em',
            textTransform: 'uppercase', marginBottom: 14,
          }}
        >
          ← Eventos
        </button>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h1 className="neon-display" style={{
            fontSize: 30, color: 'var(--text)', letterSpacing: '-0.025em',
            margin: 0, lineHeight: 1.1,
          }}>
            Novi<span className="neon-glow-lime">dades</span>
          </h1>
          <span style={{
            fontSize: 14, lineHeight: 1, flexShrink: 0, color: 'var(--lime)',
            filter: 'drop-shadow(0 0 4px rgba(198, 255, 0, 0.5))',
          }}>✨</span>
        </div>

        <div className="neon-mono" style={{
          fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
          color: 'var(--text2)', marginTop: 6,
        }}>
          {digestDate ? formatDigestDate(digestDate) : 'O que entrou no catálogo'}
          {count > 0 && ` · ${count} ${count === 1 ? 'rolê' : 'rolês'}`}
        </div>
      </div>

      <div style={{ padding: '18px 18px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {events === null && (
          <div className="neon-mono" style={{ fontSize: 11, color: 'var(--text3)' }}>
            Carregando...
          </div>
        )}

        {events !== null && count === 0 && (
          <div style={{
            padding: '18px 16px', borderRadius: 16,
            border: '1px dashed var(--line)', textAlign: 'center',
          }}>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5, marginBottom: 14 }}>
              {failed
                ? 'Essa lista de novidades já não está mais disponível.'
                : 'Nada novo por aqui — mas o catálogo continua cheio.'}
            </div>
            <button
              onClick={() => navigate('/events')}
              className="neon-mono"
              style={{
                width: '100%', padding: 12, borderRadius: 12,
                border: '1px solid var(--cyan)', background: 'transparent',
                color: 'var(--cyan)', fontSize: 11, letterSpacing: '0.18em',
                textTransform: 'uppercase', cursor: 'pointer',
              }}
            >
              Ver tudo ↗
            </button>
          </div>
        )}

        {(events || []).map(ev => (
          // `venue` already carries the bairro, and since Sep 2026 it's the
          // GEOCODED one, not the enrichment guess (_venue_label in
          // backend/main.py) — appending ev.bairro here printed it twice.
          <HomeEventRow
            key={ev.id}
            name={ev.name}
            dateStart={ev.dateStart}
            dateEnd={ev.dateEnd}
            time={ev.time}
            venue={ev.venue}
            isRecurring={ev.isRecurring}
            isGroupEvent={ev.isGroupEvent}
            featured={ev.featured}
            onClick={() => navigate('/events', { state: { openEventId: ev.id } })}
          />
        ))}
      </div>
    </div>
  )
}
