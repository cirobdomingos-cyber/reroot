import { useState } from 'react'
import { submitCatalogEvent } from '../services/api'

// Extract an IG handle from a profile or post URL.
// Profile:  instagram.com/handle/           → "handle"
// Post/reel: instagram.com/p/SHORTCODE/     → null (need manual input)
function parseIgHandle(raw) {
  try {
    const u = new URL(raw.trim())
    if (!u.hostname.includes('instagram.com')) return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (!parts.length) return null
    const reserved = new Set(['p', 'reel', 'tv', 'explore', 'accounts', 'stories', 'reels'])
    if (!reserved.has(parts[0])) return parts[0]
    return null
  } catch {
    return null
  }
}

export default function SubmitEventSheet({ open, onClose, googleId }) {
  const [igUrl, setIgUrl] = useState('')
  const [igHandle, setIgHandle] = useState('')
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [venue, setVenue] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  function handleIgUrl(val) {
    setIgUrl(val)
    setError('')
    const extracted = parseIgHandle(val)
    if (extracted) setIgHandle(extracted)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!name.trim()) { setError('Nome do evento é obrigatório'); return }
    if (!date) { setError('Data é obrigatória'); return }
    if (!venue.trim()) { setError('Local é obrigatório'); return }

    const date_start = time ? `${date}T${time}:00` : `${date}T00:00:00`

    setSubmitting(true)
    try {
      await submitCatalogEvent({
        name: name.trim(),
        description: description.trim(),
        venue_name: venue.trim(),
        date_start,
        url: igUrl.trim(),
        ig_handle: igHandle.trim(),
        submitted_by: googleId || null,
      })
      setDone(true)
    } catch (err) {
      setError(err.message || 'Erro ao enviar evento')
    } finally {
      setSubmitting(false)
    }
  }

  function handleClose() {
    setIgUrl(''); setIgHandle(''); setName(''); setDate(''); setTime('')
    setVenue(''); setDescription(''); setError(''); setDone(false)
    onClose()
  }

  if (!open) return null

  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1px solid var(--line)', background: 'var(--bg)',
    color: 'var(--text)', fontSize: 15, outline: 'none', boxSizing: 'border-box',
  }
  const labelStyle = { fontSize: 12, color: 'var(--text2)', marginBottom: 4, display: 'block', letterSpacing: '0.05em' }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9998 }}
      />

      {/* Sheet */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
        background: 'var(--cream)', borderRadius: '20px 20px 0 0',
        padding: '0 0 calc(env(safe-area-inset-bottom, 0px) + 24px)',
        maxHeight: '92dvh', overflowY: 'auto',
      }}>
        {/* Handle bar */}
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
              <button
                onClick={handleClose}
                style={{ padding: '12px 32px', borderRadius: 12, background: 'var(--magenta)', color: '#fff', border: 'none', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
              >
                Fechar
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* IG link */}
              <div>
                <label style={labelStyle}>Link do Instagram (opcional)</label>
                <input
                  type="url"
                  placeholder="https://www.instagram.com/..."
                  value={igUrl}
                  onChange={e => handleIgUrl(e.target.value)}
                  style={inputStyle}
                />
                {igHandle && (
                  <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text2)' }}>
                    Perfil detectado:
                    <span style={{ marginLeft: 6, fontWeight: 600, color: 'var(--magenta)' }}>@{igHandle}</span>
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text2)' }}>(será monitorado)</span>
                  </div>
                )}
                {igUrl && !igHandle && (
                  <div style={{ marginTop: 6 }}>
                    <label style={{ ...labelStyle, marginBottom: 4 }}>Handle do perfil (@)</label>
                    <input
                      type="text"
                      placeholder="ex: cafebeirario"
                      value={igHandle}
                      onChange={e => setIgHandle(e.target.value.replace('@', ''))}
                      style={{ ...inputStyle, marginTop: 0 }}
                    />
                  </div>
                )}
              </div>

              {/* Name */}
              <div>
                <label style={labelStyle}>Nome do evento *</label>
                <input
                  type="text"
                  placeholder="ex: Noite de Jazz no Boteco"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  maxLength={200}
                  style={inputStyle}
                  required
                />
              </div>

              {/* Date + time */}
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

              {/* Venue */}
              <div>
                <label style={labelStyle}>Local *</label>
                <input
                  type="text"
                  placeholder="ex: Boteco do Alemão, Batel"
                  value={venue}
                  onChange={e => setVenue(e.target.value)}
                  maxLength={200}
                  style={inputStyle}
                  required
                />
              </div>

              {/* Description */}
              <div>
                <label style={labelStyle}>Descrição (opcional)</label>
                <textarea
                  placeholder="Detalhes do evento..."
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

              {error && (
                <div style={{ fontSize: 13, color: '#e53', padding: '8px 12px', background: 'rgba(255,80,80,0.08)', borderRadius: 8 }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                style={{
                  padding: '14px', borderRadius: 12, background: submitting ? 'var(--line)' : 'var(--magenta)',
                  color: '#fff', border: 'none', fontWeight: 700, fontSize: 16,
                  cursor: submitting ? 'default' : 'pointer', transition: 'background 0.2s',
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
