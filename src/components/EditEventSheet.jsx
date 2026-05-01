import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { updateGroupEvent } from '../services/api'

// Bottom sheet for editing the content fields of a group event or
// personal plan. Image, co-hosts, visibility, and invitees have their
// own dedicated affordances — this sheet covers only what the existing
// PATCH endpoint accepts: name, venue, date, description, note.
//
// Permission: caller is responsible for only mounting this when the
// viewer is creator or co-host. The backend re-checks anyway, but the
// UI shouldn't tease the option to people who can't use it.

const FIELD_LIMITS = { name: 200, venue: 200, description: 1000, note: 280 }

// Convert backend ISO 8601 ("2026-05-15T20:00:00") to the shape iOS's
// <input type="datetime-local"> expects: same format minus seconds and
// timezone. Backend tolerates both on the round-trip.
function toLocalInputValue(iso) {
  if (!iso) return ''
  // Strip seconds + tz to fit "YYYY-MM-DDTHH:MM"
  return iso.slice(0, 16)
}

export default function EditEventSheet({ open, onClose, event, googleId, onSaved }) {
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [description, setDescription] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Reset form whenever the sheet opens for a new event. Only repopulate
  // when `open` flips true so we don't clobber in-progress edits if the
  // event prop reference changes during typing.
  useEffect(() => {
    if (!open || !event) return
    setName(event.name || '')
    setVenue(event.venue || '')
    setDateStart(toLocalInputValue(event.dateStart || event.date_start || ''))
    setDescription(event.description || '')
    setNote(event.note || '')
    setError('')
  }, [open, event?.id])

  async function handleSave() {
    if (!event || saving) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Nome não pode ficar vazio')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await updateGroupEvent(event.id, googleId, {
        name: trimmedName.slice(0, FIELD_LIMITS.name),
        venue: venue.trim().slice(0, FIELD_LIMITS.venue),
        date_start: dateStart || null,
        description: description.trim().slice(0, FIELD_LIMITS.description),
        note: note.trim().slice(0, FIELD_LIMITS.note),
      })
      onSaved?.(result.event)
      onClose()
    } catch (err) {
      setError('Falha ao salvar. Tenta de novo.')
    }
    setSaving(false)
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={saving ? undefined : onClose}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 10500 }}
          />
          <motion.div
            key="sheet"
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0,
              background: 'white', borderRadius: '20px 20px 0 0',
              zIndex: 10501,
              // Cap at 85% of viewport so on small phones (and with the
              // iOS keyboard up) you can always see what's behind the
              // sheet to confirm context. Content area below scrolls;
              // the action footer is sticky.
              maxHeight: '85vh',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ flexShrink: 0, padding: '6px 20px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }}/>
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 700, textAlign: 'center', marginBottom: 18, color: 'var(--charcoal)' }}>
                Editar evento
              </h3>
            </div>

            {/* Scrollable content area — form fields. Pads the bottom so
                the last field doesn't sit flush against the sticky footer. */}
            <div style={{
              flex: 1, overflowY: 'auto', padding: '0 20px 8px',
              WebkitOverflowScrolling: 'touch', // iOS momentum scroll
            }}>

            <Field label="Nome">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={FIELD_LIMITS.name}
                style={inputStyle}
              />
            </Field>

            <Field label="Local">
              <input
                type="text"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="Ex.: Bar Brahma"
                maxLength={FIELD_LIMITS.venue}
                style={inputStyle}
              />
            </Field>

            <Field label="Data e hora">
              <input
                type="datetime-local"
                value={dateStart}
                onChange={(e) => setDateStart(e.target.value)}
                style={inputStyle}
              />
            </Field>

            <Field label="Descrição">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={FIELD_LIMITS.description}
                placeholder="Detalhes opcionais do evento"
                style={{ ...inputStyle, resize: 'none', fontFamily: 'inherit' }}
              />
            </Field>

            <Field label="Mensagem pra galera (opcional)">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={FIELD_LIMITS.note}
                placeholder='"Bora porque..."'
                style={{ ...inputStyle, resize: 'none', fontFamily: 'inherit' }}
              />
              <CharCount value={note} max={FIELD_LIMITS.note} />
            </Field>

            {error && (
              <div style={{
                padding: '10px 12px', marginTop: 4, marginBottom: 8,
                background: '#FFEBEE', border: '1px solid #EF9A9A', borderRadius: 10,
                color: '#B71C1C', fontSize: 12,
              }}>
                {error}
              </div>
            )}

            </div>{/* /scrollable content area */}

            {/* Sticky footer — action buttons stay visible no matter
                how tall the form is or where the keyboard pushes the
                viewport. Bottom padding accommodates the iOS home bar. */}
            <div style={{
              flexShrink: 0,
              display: 'flex', gap: 10,
              padding: '12px 20px calc(12px + env(safe-area-inset-bottom, 0px))',
              borderTop: '1px solid var(--border)',
              background: 'white',
            }}>
              <button
                onClick={onClose}
                disabled={saving}
                style={{
                  flex: 1, padding: '12px', borderRadius: 12,
                  background: 'transparent', border: '1.5px solid var(--border)',
                  color: 'var(--charcoal-mid)', fontSize: 14, fontWeight: 600,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  flex: 1.4, padding: '12px', borderRadius: 12,
                  background: 'var(--terracotta)', border: 'none',
                  color: 'white', fontSize: 14, fontWeight: 700,
                  cursor: saving ? 'wait' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'Salvando...' : 'Salvar alterações'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: 'block', fontSize: 11, fontWeight: 700,
        color: 'var(--charcoal-mid)', marginBottom: 5, letterSpacing: 0.3,
      }}>
        {label.toUpperCase()}
      </label>
      {children}
    </div>
  )
}

function CharCount({ value, max }) {
  if (!value) return null
  return (
    <div style={{ fontSize: 10, color: 'var(--charcoal-light)', textAlign: 'right', marginTop: 2 }}>
      {value.length} / {max}
    </div>
  )
}

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1.5px solid var(--border)',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
  background: 'var(--cream)',
  color: 'var(--charcoal)',
}
