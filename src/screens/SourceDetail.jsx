import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchSourceDetail, trackEvent } from '../services/api'
import Avatar from '../components/Avatar'

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
    // Track the source-page view for the venue dashboard. ig_handle
    // is the part after "ig:"; institutional sources fire with the
    // raw source id (aue_original etc.) for consistency.
    if (sourceId) {
      const igHandle = sourceId.startsWith('ig:') ? sourceId.slice(3) : ''
      trackEvent('source_view', { source_id: sourceId, ig_handle: igHandle })
    }
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
            background: 'var(--sage)', color: '#14081E',
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
          {/* IG handles use Avatar (round + initial fallback). Institutional
              sources keep the iconic colored square because they have a
              distinct icon (🖼 for MON, 🎭 for SESC, etc.) — meaningful, not
              a placeholder. */}
          {source.id?.startsWith('ig:') ? (
            <Avatar
              src={source.profile_pic_url}
              name={source.label}
              size={56}
            />
          ) : (
            <div style={{
              width: 56, height: 56, borderRadius: 14, flexShrink: 0,
              background: 'var(--cream)', fontSize: 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden',
            }}>
              {source.icon || '📡'}
            </div>
          )}
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

        {source.bio ? (
          <div style={{
            background: 'var(--white)', border: '1px solid var(--border)',
            borderRadius: 12, padding: '10px 12px', marginTop: 12,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, color: 'var(--charcoal-light)',
              letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 4,
            }}>
              Bio do Instagram
            </div>
            <div style={{
              fontSize: 13, color: 'var(--charcoal)',
              lineHeight: 1.4, whiteSpace: 'pre-line',
            }}>
              {source.bio}
            </div>
          </div>
        ) : source.blurb ? (
          <div style={{
            fontSize: 13, color: 'var(--charcoal-mid)',
            lineHeight: 1.5, marginTop: 12,
          }}>
            {source.blurb}
          </div>
        ) : null}

        {/* Aggregator banner — explicit "we're not the source" framing,
            so the page doesn't read like a parallel IG profile. Lives
            above the events list with a clear backlink to the original
            (Instagram for IG-tracked handles, the institutional URL
            for aue_originals etc.). Also doubles as the public-facing
            opt-out path: tap "Sair do catálogo" → mailto with a pre-
            filled subject to ciro.b.domingos@gmail.com. */}
        {source.url && (() => {
          const isIg = source.id?.startsWith('ig:')
          const handle = isIg ? source.id.slice(3) : null
          const banner = isIg
            ? <>Conteúdo agregado de <strong>@{handle}</strong> ·{' '}
                <a href={source.url} target="_blank" rel="noopener noreferrer"
                   style={{ color: 'var(--sage)', fontWeight: 700, textDecoration: 'underline' }}>
                  ver no Instagram →
                </a>
              </>
            : <>Conteúdo de <strong>{source.label}</strong> ·{' '}
                <a href={source.url} target="_blank" rel="noopener noreferrer"
                   style={{ color: 'var(--sage)', fontWeight: 700, textDecoration: 'underline' }}>
                  ir pra fonte original →
                </a>
              </>
          const optOutSubject = isIg
            ? `Remover @${handle} do auê`
            : `Remover ${source.label} do auê`
          return (
            <div style={{
              marginTop: 12, padding: '10px 12px',
              background: 'var(--cream)', borderRadius: 10,
              border: '1px solid var(--border)',
              fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5,
            }}>
              <div>📡 {banner}</div>
              {isIg && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--charcoal-light)' }}>
                  É seu perfil e quer sair do catálogo?{' '}
                  <a
                    href={`mailto:ciro.b.domingos@gmail.com?subject=${encodeURIComponent(optOutSubject)}`}
                    style={{ color: 'var(--charcoal-mid)', textDecoration: 'underline' }}
                  >
                    Manda email
                  </a>
                  {' '}— removo em até 24h.
                </div>
              )}
            </div>
          )
        })()}
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
                background: 'var(--white)', borderRadius: 14, padding: '12px 14px',
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
