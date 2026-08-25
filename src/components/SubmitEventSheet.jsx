import { useState, useEffect, useRef } from 'react'
import { extractIgEvent, submitCatalogEvent } from '../services/api'

function parseIgHandle(raw) {
  try {
    const u = new URL(raw.trim())
    if (!u.hostname.includes('instagram.com')) return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (!parts.length) return null
    const reserved = new Set(['p', 'reel', 'tv', 'explore', 'accounts', 'stories', 'reels'])
    return reserved.has(parts[0]) ? null : parts[0]
  } catch { return null }
}

// Parse "2026-08-30T20:00:00" into separate date + time strings for <input>
function splitDateTime(iso) {
  if (!iso) return { date: '', time: '' }
  const [d, t] = iso.split('T')
  return { date: d || '', time: t ? t.slice(0, 5) : '' }
}

const inputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  border: '1px solid var(--line)', background: 'var(--bg)',
  color: 'var(--text)', fontSize: 15, outline: 'none', boxSizing: 'border-box',
}
const labelStyle = {
  fontSize: 12, color: 'var(--text2)', marginBottom: 4,
  display: 'block', letterSpacing: '0.05em',
}

export default function SubmitEventSheet({ open, onClose, googleId }) {
  const [igUrl, setIgUrl]           = useState('')
  const [extracting, setExtracting] = useState(false)
  const [extracted, setExtracted]   = useState(null) // null = not yet fetched
  const [extractErr, setExtractErr] = useState('')

  // Form fields (populated from extraction, editable by user)
  const [igHandle, setIgHandle]   = useState('')
  const [name, setName]           = useState('')
  const [date, setDate]           = useState('')
  const [time, setTime]           = useState('')
  const [venue, setVenue]         = useState('')
  const [description, setDesc]    = useState('')
  const [priceMin, setPriceMin]   = useState('')
  const [priceMax, setPriceMax]   = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [done, setDone]             = useState(false)
  const [submitErr, setSubmitErr]   = useState('')

  const debounceRef = useRef(null)

  function reset() {
    setIgUrl(''); setExtracting(false); setExtracted(null); setExtractErr('')
    setIgHandle(''); setName(''); setDate(''); setTime('')
    setVenue(''); setDesc(''); setPriceMin(''); setPriceMax('')
    setSubmitting(false); setDone(false); setSubmitErr('')
  }

  function handleClose() { reset(); onClose() }

  function applyExtraction(data) {
    setExtracted(data)
    if (data.handle) setIgHandle(data.handle)
    if (data.name) setName(data.name)
    if (data.venue_name) setVenue(data.venue_name)
    if (data.description) setDesc(data.description)
    if (data.price_min != null) setPriceMin(data.price_min > 0 ? String(data.price_min) : '')
    if (data.price_max != null) setPriceMax(data.price_max > 0 ? String(data.price_max) : '')
    if (data.date_start) {
      const { date: d, time: t } = splitDateTime(data.date_start)
      setDate(d); setTime(t)
    }
  }

  function handleUrlChange(val) {
    setIgUrl(val)
    setExtractErr('')

    // Instant handle extraction for profile URLs — no API call needed
    const handle = parseIgHandle(val)
    if (handle && !extracted) setIgHandle(handle)

    // Debounce Apify extraction — fires 1s after user stops typing
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!val.trim() || !val.includes('instagram.com')) return

    debounceRef.current = setTimeout(async () => {
      setExtracting(true)
      setExtractErr('')
      try {
        const data = await extractIgEvent(val.trim())
        applyExtraction(data)
      } catch (err) {
        setExtractErr('Não conseguimos ler o post. Preencha os campos abaixo.')
        // Still try to get handle from URL
        const h = parseIgHandle(val)
        if (h) setIgHandle(h)
        setExtracted({}) // mark as attempted
      } finally {
        setExtracting(false)
      }
    }, 1000)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitErr('')
    if (!name.trim()) { setSubmitErr('Nome do evento é obrigatório'); return }
    if (!date) { setSubmitErr('Data é obrigatória'); return }
    if (!venue.trim()) { setSubmitErr('Local é obrigatório'); return }

    const date_start = time ? `${date}T${time}:00` : `${date}T00:00:00`
    setSubmitting(true)
    try {
      await submitCatalogEvent({
        name: name.trim(),
        description: description.trim(),
        venue_name: venue.trim(),
        date_start,
        price_min: parseFloat(priceMin) || 0,
        price_max: parseFloat(priceMax) || 0,
        url: igUrl.trim(),
        ig_handle: igHandle.trim(),
        submitted_by: googleId || null,
      })
      setDone(true)
    } catch (err) {
      setSubmitErr(err.message || 'Erro ao enviar evento')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  // Determine what the user still needs to fill
  const missingFields = !extracted ? [] : [
    !name && 'nome',
    !date && 'data',
    !venue && 'local',
  ].filter(Boolean)

  return (
    <>
      <div onClick={handleClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998 }} />

      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
        background: 'var(--cream)', borderRadius: '20px 20px 0 0',
        padding: '0 0 calc(env(safe-area-inset-bottom, 0px) + 24px)',
        maxHeight: '92dvh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 0' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--line)' }} />
        </div>

        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Adicionar evento</div>
            <button onClick={handleClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text2)', padding: 4 }}>✕</button>
          </div>

          {done ? (
            <div style={{ textAlign: 'center', padding: '32px 0 16px' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
              <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)', marginBottom: 8 }}>Evento adicionado!</div>
              <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 24 }}>Vai aparecer no catálogo em instantes.</div>
              <button onClick={handleClose} style={{ padding: '12px 32px', borderRadius: 12, background: 'var(--magenta)', color: '#fff', border: 'none', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
                Fechar
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* IG link — always shown, drives extraction */}
              <div>
                <label style={labelStyle}>Link do Instagram</label>
                <input
                  type="url"
                  placeholder="https://www.instagram.com/p/..."
                  value={igUrl}
                  onChange={e => handleUrlChange(e.target.value)}
                  style={inputStyle}
                />

                {/* Status row below the URL input */}
                {extracting && (
                  <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', border: '2px solid var(--magenta)', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
                    Lendo post…
                    <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
                  </div>
                )}
                {!extracting && igHandle && (
                  <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text2)' }}>
                    Perfil: <span style={{ fontWeight: 600, color: 'var(--magenta)' }}>@{igHandle}</span>
                    {extracted && Object.keys(extracted).some(k => extracted[k] && k !== 'handle' && k !== 'caption' && k !== 'image_url' && k !== 'url') && (
                      <span style={{ marginLeft: 8, color: 'var(--green, #22c55e)', fontSize: 12 }}>✓ campos preenchidos automaticamente</span>
                    )}
                  </div>
                )}
                {extractErr && (
                  <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text2)' }}>{extractErr}</div>
                )}
              </div>

              {/* Caption preview — helps user when auto-extraction partially failed */}
              {extracted?.caption && !name && (
                <div style={{ fontSize: 12, color: 'var(--text2)', background: 'var(--bg)', borderRadius: 10, padding: '10px 12px', maxHeight: 80, overflowY: 'auto', lineHeight: 1.5 }}>
                  {extracted.caption.slice(0, 300)}{extracted.caption.length > 300 ? '…' : ''}
                </div>
              )}

              {/* Form fields — always shown so user can edit even auto-filled values */}
              <div>
                <label style={labelStyle}>Nome do evento *</label>
                <input type="text" placeholder="ex: Noite de Jazz no Boteco" value={name} onChange={e => setName(e.target.value)} maxLength={200} style={inputStyle} required />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle}>Data *</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} required />
                </div>
                <div>
                  <label style={labelStyle}>Hora</label>
                  <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
                </div>
              </div>

              <div>
                <label style={labelStyle}>Local *</label>
                <input type="text" placeholder="ex: Boteco do Alemão, Batel" value={venue} onChange={e => setVenue(e.target.value)} maxLength={200} style={inputStyle} required />
              </div>

              <div>
                <label style={labelStyle}>Descrição (opcional)</label>
                <textarea placeholder="Detalhes do evento…" value={description} onChange={e => setDesc(e.target.value)} maxLength={1000} rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle}>Preço mín. (R$)</label>
                  <input type="number" min={0} placeholder="0" value={priceMin} onChange={e => setPriceMin(e.target.value)} style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Preço máx. (R$)</label>
                  <input type="number" min={0} placeholder="0" value={priceMax} onChange={e => setPriceMax(e.target.value)} style={inputStyle} />
                </div>
              </div>

              {submitErr && (
                <div style={{ fontSize: 13, color: '#e53', padding: '8px 12px', background: 'rgba(255,80,80,0.08)', borderRadius: 8 }}>
                  {submitErr}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || extracting}
                style={{
                  padding: '14px', borderRadius: 12,
                  background: (submitting || extracting) ? 'var(--line)' : 'var(--magenta)',
                  color: '#fff', border: 'none', fontWeight: 700, fontSize: 16,
                  cursor: (submitting || extracting) ? 'default' : 'pointer', transition: 'background 0.2s',
                }}
              >
                {submitting ? 'Enviando…' : 'Adicionar ao catálogo'}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  )
}
