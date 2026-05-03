import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Avatar from './Avatar'
import { getFriends, addEventInvitees } from '../services/api'

// Post-creation invite sheet — opened from the Card Hero when the
// event creator wants to add more people after the event already
// exists. Friend picker that excludes anyone already on the invitee
// list (prevents duplicate-invite friction). Submits to
// POST /events/{id}/invitees, which fires "Ciro te convidou…"
// notifications to just-added invitees.
//
// Props:
//   open                 boolean
//   onClose              () => void
//   eventId              string  — the event being augmented
//   googleId             string  — the creator (and viewer)
//   eventName            string  — for header copy
//   existingInviteeIds   string[] — already on extra_invitee_ids; filtered out of picker
//   onInvited            ({ added, invitee_google_ids }) => void  — fires after success

export default function InvitePeopleSheet({
  open, onClose, eventId, googleId, eventName, existingInviteeIds = [], onInvited,
}) {
  const [friends, setFriends] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [search, setSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Hide the Companion FAB while the sheet is up — same pattern as
  // every other modal.
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: 1 } }))
    return () => window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: -1 } }))
  }, [open])

  useEffect(() => {
    if (!open || !googleId) return
    let cancelled = false
    getFriends(googleId).then(list => {
      if (!cancelled) setFriends(Array.isArray(list) ? list : [])
    })
    return () => { cancelled = true }
  }, [open, googleId])

  // Reset draft state on each reopen so a stale selection doesn't carry over.
  useEffect(() => {
    if (open) {
      setSelected(new Set()); setSearch(''); setError(null)
    }
  }, [open])

  const alreadyInvited = new Set(existingInviteeIds || [])
  const eligible = friends.filter(f => !alreadyInvited.has(f.google_id))
  const q = search.trim().toLowerCase()
  const visibleFriends = q
    ? eligible.filter(f => (f.name || '').toLowerCase().includes(q))
    : eligible

  function toggle(gid) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid); else next.add(gid)
      return next
    })
  }

  async function submit() {
    if (selected.size === 0) return
    setError(null); setSubmitting(true)
    try {
      const result = await addEventInvitees(eventId, googleId, [...selected])
      onInvited?.(result)
      onClose()
    } catch (e) {
      setError(e?.message || 'Erro ao convidar')
    } finally {
      setSubmitting(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={submitting ? undefined : onClose}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 10500 }}
          />
          <motion.div
            key="sheet"
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--white)',
              borderRadius: '20px 20px 0 0',
              zIndex: 10501, maxHeight: '85vh',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ flexShrink: 0, padding: '6px 20px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
              </div>
              <h3 style={{ fontSize: 17, fontWeight: 700, textAlign: 'center', marginBottom: 6, color: 'var(--charcoal)' }}>
                👥 Convidar mais gente
              </h3>
              {eventName && (
                <div style={{ fontSize: 12, color: 'var(--charcoal-light)', textAlign: 'center', marginBottom: 14 }}>
                  pra {eventName}
                </div>
              )}
            </div>
            <div style={{
              flex: 1, overflowY: 'auto', padding: '0 20px 8px',
              overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
            }}>

            {friends.length === 0 ? (
              <div style={{
                padding: '14px 12px', background: 'var(--cream)', borderRadius: 12,
                fontSize: 12, color: 'var(--charcoal-mid)', textAlign: 'center',
              }}>
                Você ainda não tem amigos no auê. Adicione alguns na aba Comunidade primeiro.
              </div>
            ) : eligible.length === 0 ? (
              <div style={{
                padding: '14px 12px', background: 'var(--cream)', borderRadius: 12,
                fontSize: 12, color: 'var(--charcoal-mid)', textAlign: 'center',
              }}>
                Todos os seus amigos já estão convidados.
              </div>
            ) : (
              <>
                <input
                  type="search"
                  placeholder="Buscar amigo…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={inputStyle}
                />
                <div style={{
                  marginTop: 8,
                  display: 'flex', flexDirection: 'column', gap: 4,
                  maxHeight: 320, overflowY: 'auto',
                  border: '1px solid var(--border)', borderRadius: 12, padding: 4,
                }}>
                  {visibleFriends.length === 0 ? (
                    <div style={{ padding: 12, fontSize: 12, color: 'var(--charcoal-light)', textAlign: 'center' }}>
                      Ninguém com "{search}".
                    </div>
                  ) : visibleFriends.map(f => {
                    const isSel = selected.has(f.google_id)
                    return (
                      <button
                        key={f.google_id}
                        type="button"
                        onClick={() => toggle(f.google_id)}
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
              </>
            )}

            {error && (
              <div style={{
                marginTop: 12, padding: '9px 12px', background: '#FFF3E0',
                color: '#BF360C', borderRadius: 8, fontSize: 12, textAlign: 'center',
              }}>
                {error}
              </div>
            )}
            </div>{/* /scrollable */}

            <div style={{
              flexShrink: 0,
              display: 'flex', gap: 8,
              padding: '12px 20px calc(12px + env(safe-area-inset-bottom, 0px))',
              borderTop: '1px solid var(--border)', background: 'var(--white)',
            }}>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 12,
                  border: '1px solid var(--border)', background: 'var(--white)',
                  fontSize: 13, fontWeight: 600, color: 'var(--charcoal-mid)',
                  cursor: 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting || selected.size === 0}
                style={{
                  flex: 2, padding: '12px 14px', borderRadius: 12,
                  border: 'none',
                  background: 'var(--terra)', color: 'white',
                  fontSize: 13, fontWeight: 700,
                  cursor: submitting ? 'wait' : 'pointer',
                  opacity: (submitting || selected.size === 0) ? 0.55 : 1,
                }}
              >
                {submitting
                  ? 'Convidando…'
                  : `Convidar ${selected.size} ${selected.size === 1 ? 'pessoa' : 'pessoas'}`}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: '10px 12px',
  fontSize: 13, fontFamily: 'inherit',
  background: 'var(--white)',
  border: '1px solid var(--border)', borderRadius: 10,
  outline: 'none', color: 'var(--charcoal)',
}
