import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { fetchVenueDashboard } from '../services/api'
import Avatar from '../components/Avatar'

// Per-venue dashboard. Reachable via /venue/<handle>. Founder always
// has access; the claimed_email matching state.googleUser.email also
// has access. Anyone else gets a friendly 403.
//
// Phase-1 metrics (this screen):
//   - Headline: views + RSVPs + conversion (last 30d emphasized)
//   - Friends amplification (RSVPs where the user has a friend also going)
//   - Top 5 events by RSVPs
//   - Hour-of-day view distribution (when does your audience browse)

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

export default function VenueDashboard() {
  const { handle } = useParams()
  const navigate = useNavigate()
  const { state } = useApp()
  const email = state.googleUser?.email || ''
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchVenueDashboard(handle, email).then(d => {
      if (cancelled) return
      if (d?.error) {
        setError({ status: d.status, message: d.error })
      } else {
        setData(d)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [handle, email])

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--charcoal-mid)' }}>Carregando…</div>
  }

  if (error) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>🔒</div>
        <div style={{ fontSize: 14, color: 'var(--charcoal-mid)', marginBottom: 18 }}>
          {error.status === 403
            ? 'Sem acesso ao painel desse local. Contate o admin pra reivindicar.'
            : error.message || 'Falha ao carregar.'}
        </div>
        <button onClick={() => navigate(-1)} style={btnPrimary}>Voltar</button>
      </div>
    )
  }

  const maxHour = Math.max(1, ...data.hour_distribution_local)
  const conv = (data.conversion_rate * 100).toFixed(1)

  return (
    <div style={{ padding: '20px 0 80px' }}>
      <div style={{ padding: '0 16px 14px' }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--charcoal-light)', fontSize: 13, padding: '4px 0', marginBottom: 10,
          }}
        >
          ← Voltar
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar src={data.profile_pic_url} name={data.label} size={56} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{
              fontSize: 18, fontWeight: 700, margin: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              📊 Painel · {data.label}
            </h1>
            <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 3 }}>
              <a
                href={`https://instagram.com/${data.handle}`}
                target="_blank"
                rel="noreferrer"
                title="Abrir no Instagram"
                style={{
                  color: 'var(--charcoal-mid)', fontWeight: 700,
                  textDecoration: 'none',
                }}
              >
                @{data.handle}
              </a>
              {data.featured && (
                <span style={{
                  marginLeft: 8, fontSize: 9, fontWeight: 800,
                  letterSpacing: 0.5, color: 'var(--honey)',
                  background: 'var(--honey-pale)', border: '1px solid var(--honey)',
                  padding: '1px 6px', borderRadius: 999,
                }}>⭐ SELEÇÃO AUÊ</span>
              )}
            </div>
            {data.claimed_by_email && (
              <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginTop: 2 }}>
                Reivindicado por <code>{data.claimed_by_email}</code>
              </div>
            )}
          </div>
        </div>
      </div>

      {data.events_in_catalog === 0 ? (
        <div style={{
          margin: '0 16px', padding: '24px 16px', textAlign: 'center',
          background: 'white', borderRadius: 12, border: '1px dashed var(--border)',
          color: 'var(--charcoal-light)', fontSize: 13,
        }}>
          Nenhum evento desse local no catálogo ainda. Quando o próximo
          scrape detectar, as métricas começam a popular aqui.
        </div>
      ) : (
        <>
          {/* Headline metric tiles — last 30 days as the leading number,
              7 days as the smaller "esta semana" caption underneath. */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
            padding: '0 16px 12px',
          }}>
            <Metric
              emoji="👀"
              label="Visualizações (30d)"
              value={data.views.d30}
              sub={`${data.views.d7} nos últimos 7 dias · ${data.views.all} total`}
            />
            <Metric
              emoji="🙌"
              label="Confirmações (30d)"
              value={data.rsvps.d30}
              sub={`${data.rsvps.d7} nos últimos 7 dias · ${data.rsvps.all} total`}
            />
            <Metric
              emoji="📈"
              label="Conversão view → RSVP"
              value={`${conv}%`}
              sub={`Da galera que abriu, ${conv}% confirmou`}
            />
            <Metric
              emoji="🤝"
              label="Amplificação social"
              value={data.friends_amplified}
              sub="RSVPs onde um amigo também vai"
            />
          </div>

          <div style={{ padding: '0 16px 12px' }}>
            <Metric
              emoji="📷"
              label="Visitas ao seu perfil no auê"
              value={data.source_views.d30}
              sub={`Últimos 30 dias · ${data.source_views.d7} esta semana`}
              full
            />
          </div>


          {/* Daily activity — stacked bar (views + RSVPs) for the
              last 30 days. Reads as "how busy was each day" and lets
              the venue spot post-event spikes vs steady state. */}
          {data.daily_breakdown && data.daily_breakdown.length > 0 && (
            <DailyActivity daily={data.daily_breakdown} />
          )}

          {/* Per-event breakdown — every post from this venue with its
              individual click + RSVP counts. Default: top 8; "Ver
              tudo" expands to the full list. The medal on rank 1
              keeps the "tração" framing for the standout. */}
          {(data.events_breakdown && data.events_breakdown.length > 0) && (
            <EventsBreakdown events={data.events_breakdown} />
          )}

          {/* Hour of day distribution — when is your audience looking */}
          <div style={{ padding: '0 16px 14px' }}>
            <h2 style={sectionTitle}>🕒 Quando o público abre seus eventos</h2>
            <div style={{
              padding: '12px', background: 'white',
              border: '1px solid var(--border)', borderRadius: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 70 }}>
                {data.hour_distribution_local.map((c, h) => {
                  const bh = Math.max(1, (c / maxHour) * 60)
                  return (
                    <div
                      key={h}
                      title={`${HOUR_LABELS[h]}h: ${c} view${c === 1 ? '' : 's'}`}
                      style={{
                        flex: 1, background: c > 0 ? 'var(--sage)' : '#EAEAEA',
                        height: `${bh}px`, borderRadius: '2px 2px 0 0',
                      }}
                    />
                  )
                })}
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                fontSize: 9, color: 'var(--charcoal-light)', marginTop: 4,
              }}>
                <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginTop: 4 }}>
                Distribuição dos últimos 30 dias · horário de Curitiba
              </div>
            </div>
          </div>

          <div style={{
            margin: '0 16px', padding: '12px 14px',
            background: 'var(--cream)', borderRadius: 10,
            fontSize: 11, color: 'var(--charcoal-mid)', lineHeight: 1.5,
          }}>
            💡 <strong>Como o auê mede:</strong> uma "view" é cada vez que
            alguém abre a tela de detalhe de um evento seu. "RSVP" é
            quando confirmam presença. As métricas são anônimas — você
            vê totais e padrões, nunca a identidade individual de quem
            abriu.
          </div>
        </>
      )}
    </div>
  )
}

function DailyActivity({ daily }) {
  // Stacked bar — views in terra-light blue at the bottom, RSVPs in
  // sage on top. Day labels show every 5 days to keep the strip
  // readable on a 360px screen. Hover/long-press shows "30 abr — 12
  // views, 3 RSVPs" via title attr.
  const max = Math.max(1, ...daily.map(d => d.views + d.rsvps))
  const totalViews = daily.reduce((s, d) => s + d.views, 0)
  const totalRsvps = daily.reduce((s, d) => s + d.rsvps, 0)
  return (
    <div style={{ padding: '0 16px 14px' }}>
      <h2 style={sectionTitle}>📊 Atividade nos últimos 30 dias</h2>
      <div style={{
        background: 'white', border: '1px solid var(--border)',
        borderRadius: 10, padding: '12px 14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 110 }}>
          {daily.map((d) => {
            const total = d.views + d.rsvps
            const totalH = (total / max) * 90
            const viewH = total === 0 ? 0 : (d.views / total) * totalH
            const rsvpH = total === 0 ? 0 : (d.rsvps / total) * totalH
            const dateLabel = (() => {
              try { return new Date(d.date + 'T12:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) }
              catch { return d.date }
            })()
            return (
              <div
                key={d.date}
                title={`${dateLabel} — ${d.views} views, ${d.rsvps} RSVPs`}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'flex-end',
                  minWidth: 0, height: 100,
                }}
              >
                {total > 0 && (
                  <span style={{
                    fontSize: 7, fontWeight: 700, color: 'var(--charcoal-mid)',
                    marginBottom: 1, fontVariantNumeric: 'tabular-nums',
                  }}>{total}</span>
                )}
                <div style={{
                  width: '100%', display: 'flex', flexDirection: 'column',
                  justifyContent: 'flex-end', height: `${totalH}px`,
                }}>
                  <div style={{
                    background: 'var(--sage)',
                    height: `${rsvpH}px`,
                    borderRadius: rsvpH > 0 ? '2px 2px 0 0' : 0,
                  }}/>
                  <div style={{
                    background: 'var(--terra-light)',
                    height: `${viewH}px`,
                  }}/>
                </div>
              </div>
            )
          })}
        </div>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: 9, color: 'var(--charcoal-light)', marginTop: 6,
        }}>
          <span>{daily[0] && new Date(daily[0].date + 'T12:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</span>
          <span>hoje</span>
        </div>
        <div style={{
          display: 'flex', gap: 14, fontSize: 11, marginTop: 8,
          color: 'var(--charcoal-mid)', fontWeight: 600,
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--terra-light)', borderRadius: 2 }}/>
            Views · {totalViews}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--sage)', borderRadius: 2 }}/>
            RSVPs · {totalRsvps}
          </span>
        </div>
      </div>
    </div>
  )
}

function EventsBreakdown({ events }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? events : events.slice(0, 8)
  const hidden = events.length - visible.length
  function fmtDate(iso) {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    } catch { return '' }
  }
  return (
    <div style={{ padding: '0 16px 14px' }}>
      <h2 style={sectionTitle}>📋 Posts &amp; performance · {events.length}</h2>
      <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginBottom: 8, lineHeight: 1.4 }}>
        Cada post do Instagram que virou evento no auê, com a foto e
        a descrição que aparece pra galera, mais quantos abriram (👀)
        e quantos confirmaram (🙌).
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {visible.map((e, i) => (
          <PostBreakdownRow key={e.event_id} event={e} rank={i + 1} fmtDate={fmtDate} />
        ))}
        {hidden > 0 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            style={{
              padding: '8px 12px', borderRadius: 10,
              border: '1px dashed var(--border)', background: 'transparent',
              fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)',
              cursor: 'pointer',
            }}
          >
            + Ver todos os {events.length} posts
          </button>
        )}
        {expanded && events.length > 8 && (
          <button
            onClick={() => setExpanded(false)}
            style={{
              padding: '8px 12px', borderRadius: 10,
              border: '1px dashed var(--border)', background: 'transparent',
              fontSize: 11, fontWeight: 700, color: 'var(--charcoal-mid)',
              cursor: 'pointer',
            }}
          >
            − Mostrar menos
          </button>
        )}
      </div>
    </div>
  )
}

function PostBreakdownRow({ event: e, rank, fmtDate }) {
  // Per-post card: thumbnail (rehosted IG image) + event name + date +
  // description preview + link to the original IG post + the venue-
  // facing stats (views / RSVPs). Image fails-silent to a gradient
  // placeholder when it 404s (rehost gap, not yet captured, etc.).
  // Tap the card body → opens the event's hero in the app (Events tab,
  // detail drawer). The "Ver post original →" link still routes to IG.
  const navigate = useNavigate()
  const [imgBroken, setImgBroken] = useState(false)
  const showImage = !!e.image_url && !imgBroken
  return (
    <div
      onClick={() => navigate('/events', { state: { openEventId: e.event_id } })}
      style={{
      background: 'white',
      border: '1px solid var(--border)', borderRadius: 12,
      padding: 10, display: 'flex', gap: 10, alignItems: 'flex-start',
      cursor: 'pointer',
    }}>
      {/* Thumbnail */}
      <div style={{
        flexShrink: 0, width: 64, height: 64, borderRadius: 10,
        overflow: 'hidden', position: 'relative',
        background: 'linear-gradient(135deg, #FFE0B2, #FFCC80)',
      }}>
        {showImage && (
          <img
            src={e.image_url}
            alt=""
            onError={() => setImgBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        {/* Rank medal — small overlay so the chart pops without
            taking a whole column. Rank 1 honey, rest neutral. */}
        <div style={{
          position: 'absolute', top: 4, left: 4,
          width: 18, height: 18, borderRadius: '50%',
          background: rank === 1 ? 'var(--honey)' : 'rgba(255,255,255,0.92)',
          color: rank === 1 ? 'white' : 'var(--charcoal-mid)',
          fontSize: 9, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}>{rank}</div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
              lineHeight: 1.3,
              display: '-webkit-box', WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{e.name}</div>
            <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginTop: 2 }}>
              📅 {fmtDate(e.date_start) || '—'}
            </div>
          </div>
          {/* Stats — kept compact, right-aligned. Hover/long-press
              shows the full label via title. */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 2,
            flexShrink: 0, fontSize: 11, fontWeight: 800,
            fontVariantNumeric: 'tabular-nums', textAlign: 'right',
          }}>
            <span title={`${e.views} visualizações`} style={{ color: 'var(--terra-light)' }}>
              👀 {e.views}
            </span>
            <span title={`${e.rsvps} confirmaram presença`} style={{ color: 'var(--sage)' }}>
              🙌 {e.rsvps}
            </span>
          </div>
        </div>
        {e.description && (
          <div style={{
            fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 4,
            lineHeight: 1.4, fontStyle: 'italic',
            display: '-webkit-box', WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {e.description}
          </div>
        )}
        {e.url && (
          <a
            href={e.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(ev) => ev.stopPropagation()}
            style={{
              display: 'inline-block', marginTop: 4,
              fontSize: 10, fontWeight: 700,
              color: 'var(--sage)', textDecoration: 'none',
            }}
          >
            🔗 Ver post original →
          </a>
        )}
      </div>
    </div>
  )
}

function Metric({ emoji, label, value, sub, full = false }) {
  return (
    <div style={{
      background: 'white', borderRadius: 12,
      border: '1px solid var(--border)',
      padding: '12px 14px',
      gridColumn: full ? '1 / -1' : 'auto',
    }}>
      <div style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
        {emoji} {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 800, color: 'var(--charcoal)',
        marginTop: 2, fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

const sectionTitle = {
  fontSize: 12, fontWeight: 700, color: 'var(--charcoal-mid)',
  textTransform: 'uppercase', letterSpacing: 0.6,
  margin: '0 0 8px',
}

const btnPrimary = {
  padding: '10px 22px', borderRadius: 12, border: 'none',
  background: 'var(--sage)', color: 'white',
  fontSize: 13, fontWeight: 700, cursor: 'pointer',
}
