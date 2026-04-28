import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Avatar from './Avatar'
import { getFriends, createPersonalPlan } from '../services/api'

// Personal plan = event with a hand-picked invitee list, no group attached.
// User can pick individual friends here. Phase 2 will add an "import group
// members" affordance that bulk-adds everyone from a chosen group.
//
// Auto-RSVPs the creator (per product spec); invitees get a push +
// the event in their group-events feed.

export default function PersonalPlanSheet({ open, onClose, googleId, onCreated }) {
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [note, setNote] = useState('')
  const [friends, setFriends] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  // Hide the Companion FAB while this sheet is up — same convention
  // every modal in the app uses.
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: 1 } }))
    return () => window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: -1 } }))
  }, [open])

  // Fetch friends when the sheet opens. Cache in component state so
  // the user doesn't re-fetch every time they tweak a field.
  useEffect(() => {
    if (!open || !googleId) return
    let cancelled = false
    getFriends(googleId).then(list => {
      if (!cancelled) setFriends(Array.isArray(list) ? list : [])
    })
    return () => { cancelled = true }
  }, [open, googleId])

  // Reset form when reopened so a stale draft doesn't haunt the next
  // creation.
  useEffect(() => {
    if (open) {
      setName(''); setVenue(''); setDateStart(''); setNote('')
      setSelected(new Set()); setSearch(''); setError(null)
    }
  }, [open])

  const q = search.trim().toLowerCase()
  const visibleFriends = q
    ? friends.filter(f => (f.name || '').toLowerCase().includes(q))
    : friends

  function toggleFriend(gid) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid); else next.add(gid)
      return next
    })
  }

  async function submit() {
    setError(null)
    const trimmedName = name.trim()
    if (trimmedName.length < 3) { setError('Dá um nome pro plano (mín 3 letras)'); return }
    if (!dateStart) { setError('Escolhe uma data'); return }
    if (selected.size === 0) { setError('Convida pelo menos um amigo'); return }
    setSubmitting(true)
    try {
      const event = await createPersonalPlan(googleId, {
        name: trimmedName,
        venue: venue.trim(),
        date_start: dateStart,
        note: note.trim(),
        invitee_google_ids: [...selected],
      })
      onCreated?.(event)
      onClose()
    } catch (e) {
      setError(e?.message || 'Erro ao criar plano')
    } finally {
      setSubmitting(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={submitting ? undefined : onClose}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 999 }} />
          <motion.div key="sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, background: 'white',
              borderRadius: '20px 20px 0 0',
              padding: '8px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
              zIndex: 1000, maxHeight: '90vh', overflowY: 'auto',
              overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
            }}>
            {/* Drag handle */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
            </div>
            <h3 style={{ fontSize: 17, fontWeight: 700, textAlign: 'center', marginBottom: 14, color: 'var(--charcoal)' }}>
              🎲 Convidar amigos pra um plano
            </h3>

            <Field label="O que vai rolar?">
              <input
                value={name} onChange={e => setName(e.target.value)}
                placeholder="Ex: Pizza no Madá sexta"
                style={inputStyle} maxLength={120}
              />
            </Field>

            <Field label="Quando?">
              <input
                type="datetime-local"
                value={dateStart} onChange={e => setDateStart(e.target.value)}
                style={inputStyle}
              />
            </Field>

            <Field label="Onde? (opcional)">
              <input
                value={venue} onChange={e => setVenue(e.target.value)}
                placeholder="Ex: Bar Quermesse, Prudente de Morais"
                style={inputStyle} maxLength={200}
              />
            </Field>

            <Field label="Recado pros convidados (opcional)">
              <textarea
                value={note} onChange={e => setNote(e.target.value)}
                placeholder="Ex: Bora celebrar a sexta? :)"
                rows={2}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                maxLength={200}
              />
            </Field>

            {/* Friend picker */}
            <div style={{ marginTop: 6, marginBottom: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--charcoal)', marginBottom: 6 }}>
                Quem você convida? <span style={{ color: 'var(--charcoal-light)', fontWeight: 400 }}>
                  ({selected.size} selecionado{selected.size === 1 ? '' : 's'})
                </span>
              </div>
              {friends.length > 0 && (
                <input
                  type="search"
                  placeholder="Buscar amigo…"
                  value={search} onChange={e => setSearch(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 8 }}
                />
              )}
              {friends.length === 0 ? (
                <div style={{
                  padding: '14px 12px', background: 'var(--cream)', borderRadius: 12,
                  fontSize: 12, color: 'var(--charcoal-mid)', textAlign: 'center',
                }}>
                  Você ainda não tem amigos no auê. Adicione alguns na aba Comunidade primeiro.
                </div>
              ) : visibleFriends.length === 0 ? (
                <div style={{ padding: 12, fontSize: 12, color: 'var(--charcoal-light)', textAlign: 'center' }}>
                  Ninguém com "{search}".
                </div>
              ) : (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  maxHeight: 220, overflowY: 'auto',
                  border: '1px solid var(--border)', borderRadius: 12, padding: 4,
                }}>
                  {visibleFriends.map(f => {
                    const isSel = selected.has(f.google_id)
                    return (
                      <button
                        key={f.google_id}
                        type="button"
                        onClick={() => toggleFriend(f.google_id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 10px', borderRadius: 8,
                          border: 'none', cursor: 'pointer',
                          background: isSel ? 'var(--sage-pale)' : 'transparent',
                          textAlign: 'left',
                        }}
                      >
                        <Avatar name={f.name} src={f.picture} size={32} />
                        <span style={{
                          flex: 1, minWidth: 0, fontSize: 13,
                          fontWeight: isSel ? 600 : 500,
                          color: isSel ? 'var(--sage)' : 'var(--charcoal)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {f.name || f.google_id}
                        </span>
                        {isSel && <span style={{ color: 'var(--sage)', fontSize: 14 }}>✓</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {error && (
              <div style={{
                marginTop: 12, padding: '9px 12px', background: '#FFF3E0',
                color: '#BF360C', borderRadius: 8, fontSize: 12, textAlign: 'center',
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 12,
                  border: '1px solid var(--border)', background: 'white',
                  fontSize: 13, fontWeight: 600, color: 'var(--charcoal-mid)',
                  cursor: 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting || !name.trim() || !dateStart || selected.size === 0}
                style={{
                  flex: 2, padding: '12px 14px', borderRadius: 12,
                  border: 'none',
                  background: 'var(--terra)', color: 'white',
                  fontSize: 13, fontWeight: 700,
                  cursor: submitting ? 'wait' : 'pointer',
                  opacity: (submitting || !name.trim() || !dateStart || selected.size === 0) ? 0.55 : 1,
                }}
              >
                {submitting ? 'Convidando…' : `Convidar ${selected.size || ''} ${selected.size === 1 ? 'amigo' : 'amigos'}`}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--charcoal)', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </label>
  )
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: '10px 12px',
  fontSize: 13, fontFamily: 'inherit',
  background: 'white',
  border: '1px solid var(--border)', borderRadius: 10,
  outline: 'none', color: 'var(--charcoal)',
}
