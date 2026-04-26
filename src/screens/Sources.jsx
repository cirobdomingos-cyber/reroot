import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchSources } from '../services/api'

// Transparency surface: lists every source the catalog pulls from with a
// future-event count. Two groups — institutional scrapers (museums, theatres,
// ticket platforms) and Instagram handles (curated by the founder / curators).

export default function Sources() {
  const navigate = useNavigate()
  const [data, setData] = useState({ institutional: [], instagram: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchSources().then(d => {
      if (cancelled) return
      setData(d || { institutional: [], instagram: [] })
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const totalInst = data.institutional.reduce((acc, s) => acc + s.future_events, 0)
  const totalIg = data.instagram.reduce((acc, s) => acc + s.future_events, 0)

  return (
    <div style={{ padding: '20px 0 80px' }}>
      <div style={{ padding: '0 20px 18px' }}>
        <button
          onClick={() => navigate(-1)}
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
          De onde o catálogo vem. Tap numa fonte pra ver só os eventos dela
          ou abrir o site oficial.
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--charcoal-mid)', fontSize: 13 }}>
          Carregando…
        </div>
      ) : (
        <>
          <Section
            title={`Institucionais · ${data.institutional.length}`}
            sub={`${totalInst} evento${totalInst === 1 ? '' : 's'} próximo${totalInst === 1 ? '' : 's'}`}
          >
            {data.institutional.map(s => (
              <SourceRow
                key={s.id}
                icon={s.icon}
                label={s.label}
                blurb={s.blurb}
                count={s.future_events}
                officialUrl={s.url}
                onOpen={() => navigate(`/sources/${encodeURIComponent(s.id)}`)}
              />
            ))}
          </Section>

          <Section
            title={`Instagram · ${data.instagram.length} contas`}
            sub={`${totalIg} evento${totalIg === 1 ? '' : 's'} próximo${totalIg === 1 ? '' : 's'}`}
          >
            {data.instagram.length === 0 ? (
              <div style={{
                background: 'white', borderRadius: 12, padding: '14px 16px',
                border: '1px dashed var(--border)',
                fontSize: 12, color: 'var(--charcoal-light)',
              }}>
                Nenhuma conta cadastrada ainda.
              </div>
            ) : (
              data.instagram.map(s => (
                <SourceRow
                  key={s.handle}
                  icon="📷"
                  label={s.label}
                  blurb={s.category ? `@${s.handle} · ${s.category}` : `@${s.handle}`}
                  count={s.future_events}
                  officialUrl={s.url}
                  onOpen={() => navigate(`/sources/${encodeURIComponent('ig:' + s.handle)}`)}
                />
              ))
            )}
          </Section>
        </>
      )}
    </div>
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


function SourceRow({ icon, label, blurb, count, officialUrl, onOpen }) {
  return (
    <div
      onClick={onOpen}
      style={{
        background: 'white', borderRadius: 14,
        border: '1px solid var(--border)',
        padding: '12px 14px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 11, flexShrink: 0,
        background: 'var(--cream)', fontSize: 20,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {label}
        </div>
        {blurb && (
          <div style={{
            fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2,
            lineHeight: 1.35,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {blurb}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{
          fontSize: 11, fontWeight: 700,
          background: count > 0 ? 'var(--terra-pale)' : 'transparent',
          color: count > 0 ? 'var(--terra)' : 'var(--charcoal-light)',
          padding: count > 0 ? '3px 8px' : 0,
          borderRadius: 7,
          minWidth: 20, textAlign: 'center',
        }}>
          {count}
        </span>
        {officialUrl && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              window.open(officialUrl, '_blank', 'noopener')
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
