import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchSourceDetail } from '../services/api'

// Per-source detail: header (label, blurb, link to official), then a list
// of upcoming events from that source. Tap an event → opens it in /events.

export default function SourceDetail() {
  const { sourceId } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchSourceDetail(sourceId).then(d => {
      if (cancelled) return
      if (!d) { setNotFound(true); setLoading(false); return }
      setData(d)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [sourceId])

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--charcoal-mid)', fontSize: 13 }}>
        Carregando…
      </div>
    )
  }

  if (notFound || !data) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>🤔</div>
        <div style={{ fontSize: 14, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 16 }}>
          Fonte não encontrada.
        </div>
        <button
          onClick={() => navigate('/sources')}
          style={{
            padding: '10px 22px', borderRadius: 12, border: 'none',
            background: 'var(--sage)', color: 'white',
            fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}
        >
          Ver todas as fontes
        </button>
      </div>
    )
  }

  const { source, events, total } = data

  return (
    <div style={{ padding: '20px 0 80px' }}>
      <div style={{ padding: '0 20px 18px' }}>
        <button
          onClick={() => navigate('/sources')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--charcoal-light)', fontSize: 13, padding: '4px 0', marginBottom: 12,
          }}
        >
          ← Fontes
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14, flexShrink: 0,
            background: 'var(--cream)', fontSize: 28,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {source.icon || '📡'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{
              fontSize: 20, fontWeight: 700, margin: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {source.label}
            </h1>
            <div style={{ fontSize: 12, color: 'var(--charcoal-light)', marginTop: 2 }}>
              {total} evento{total === 1 ? '' : 's'} próximo{total === 1 ? '' : 's'}
            </div>
          </div>
        </div>

        {source.blurb && (
          <div style={{
            fontSize: 13, color: 'var(--charcoal-mid)',
            lineHeight: 1.5, marginTop: 12,
          }}>
            {source.blurb}
          </div>
        )}

        {source.url && (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              marginTop: 12, padding: '8px 14px', borderRadius: 10,
              background: 'var(--sage-pale)', color: 'var(--sage)',
              fontSize: 12, fontWeight: 700, textDecoration: 'none',
              border: '1px solid var(--sage)',
            }}
          >
            🔗 Abrir site oficial →
          </a>
        )}
      </div>

      {events.length === 0 ? (
        <div style={{ padding: '32px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
          <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5 }}>
            Nenhum evento futuro nessa fonte por enquanto.
          </div>
        </div>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8,
          padding: '0 16px',
        }}>
          <div className="section-label" style={{ marginLeft: 0 }}>
            Próximos · {events.length}
          </div>
          {events.map(ev => (
            <div
              key={ev.id}
              onClick={() => navigate('/events', { state: { openEventId: ev.id } })}
              style={{
                background: 'white', borderRadius: 14, padding: '12px 14px',
                border: '1px solid var(--border)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 12,
              }}
            >
              <div style={{
                width: 40, height: 40, borderRadius: 11, flexShrink: 0,
                background: ev.headerBg || 'var(--cream)',
                fontSize: 18,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {ev.icon || '📅'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {ev.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
                  {ev.date}{ev.time ? ` · ${ev.time}` : ''}{ev.venue ? ` · ${ev.venue}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
