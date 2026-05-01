import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { fetchGroups, createGroupEvent } from '../services/api'

// Reusable bottom sheet for "add this catalog event to one of my groups".
// Lists the user's groups; tap one to add the event. Hidden when not
// signed in (groups need a google_id).
//
// The catalog event is mirrored into the group's events table — same
// flow as the GroupDetail "Do catálogo" button.
export default function AddToGroupSheet({ open, onClose, event }) {
  const { state } = useApp()
  const navigate = useNavigate()
  const googleId = state.googleUser?.id
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(false)
  const [submittingId, setSubmittingId] = useState(null)
  const [doneId, setDoneId] = useState(null)
  // Optional "que tal esse?" message attached to the group event card.
  // R3 P29 + P31: without it, users open WhatsApp instead — leak of crew
  // conversation outside the platform.
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open || !googleId) return
    let cancelled = false
    setLoading(true)
    fetchGroups(googleId).then(gs => {
      if (cancelled) return
      setGroups(gs || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [open, googleId])

  // Reset the note when the sheet closes/reopens for a different event.
  useEffect(() => { if (!open) setNote('') }, [open])

  async function handlePick(group) {
    if (submittingId || !event) return
    setSubmittingId(group.id)
    try {
      const desc = (event.description || '').trim()
      const urlSuffix = event.url ? `\n\nVer original: ${event.url}` : ''
      await createGroupEvent(group.id, googleId, {
        name: event.name,
        venue: event.venue || '',
        date_start: event.dateStart,
        date_end: null,
        description: (desc + urlSuffix).slice(0, 1000),
        visibility: 'members',
        note: note.trim().slice(0, 280),
        // Pass through the catalog event id so the backend can parse the
        // source IG handle. Drives venue-dashboard attribution: views/RSVPs
        // on the group event still count toward the source venue's Painel.
        source_event_id: event.id || '',
      })
      setDoneId(group.id)
      setTimeout(() => { onClose(); setDoneId(null) }, 900)
    } catch {
      alert('Falha ao adicionar. Tenta de novo.')
    }
    setSubmittingId(null)
  }

  if (!googleId) return null

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 10500 }}
          />
          <motion.div
            key="sheet"
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0,
              background: 'white', borderRadius: '20px 20px 0 0',
              // bottom-padding picks up the iOS home-bar inset so the last
              // tappable element clears the gesture area. 28 is the
              // baseline, env() degrades to 0 on browsers without it.
              padding: '8px 20px calc(28px + env(safe-area-inset-bottom, 0px))',
              zIndex: 10501,
              maxHeight: '80vh', overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }}/>
            </div>
            <h3 style={{ fontSize: 15, fontWeight: 700, textAlign: 'center', marginBottom: 6, color: 'var(--charcoal)' }}>
              Adicionar a um grupo
            </h3>
            <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', textAlign: 'center', marginBottom: 14, lineHeight: 1.4 }}>
              "{event?.name}"
            </div>

            {/* Optional message — surfaces in the group event card so the
                crew sees the "vibe" of the recommendation, not just the
                title. Reduces the WhatsApp-migration leak. */}
            {!loading && groups.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Que tal esse, pessoal? (opcional)"
                  rows={2}
                  maxLength={280}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1.5px solid var(--border)',
                    fontSize: 13,
                    fontFamily: 'inherit',
                    resize: 'none',
                    outline: 'none',
                    boxSizing: 'border-box',
                    color: 'var(--charcoal)',
                    background: 'var(--cream)',
                  }}
                />
                {note.length > 0 && (
                  <div style={{
                    fontSize: 10, color: 'var(--charcoal-light)',
                    textAlign: 'right', marginTop: 2,
                  }}>
                    {note.length} / 280
                  </div>
                )}
              </div>
            )}

            {loading ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--charcoal-mid)', fontSize: 13 }}>
                Carregando…
              </div>
            ) : groups.length === 0 ? (
              <div style={{ padding: '12px 4px 4px', textAlign: 'center' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>👥</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 6 }}>
                  Você ainda não tem grupos
                </div>
                <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.4, marginBottom: 16 }}>
                  Crie um grupo com seus amigos pra combinar de ir junto nesse e em outros eventos.
                </div>
                <button
                  onClick={() => { onClose(); navigate('/groups') }}
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    borderRadius: 12,
                    background: 'var(--terracotta)',
                    color: 'white',
                    border: 'none',
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  + Criar grupo agora
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {groups.map(g => {
                  const isSubmitting = submittingId === g.id
                  const isDone = doneId === g.id
                  return (
                    <button
                      key={g.id}
                      onClick={() => handlePick(g)}
                      disabled={isSubmitting || !!doneId}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        background: isDone ? 'var(--sage-pale)' : 'white',
                        border: `1px solid ${isDone ? 'var(--sage)' : 'var(--border)'}`,
                        borderRadius: 12, padding: '12px 14px',
                        textAlign: 'left',
                        cursor: isSubmitting || isDone ? 'default' : 'pointer',
                      }}
                    >
                      <span style={{ fontSize: 22 }}>👥</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 14, fontWeight: 700, color: 'var(--charcoal)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {g.name}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>
                          {g.member_count} {g.member_count === 1 ? 'membro' : 'membros'}
                          {g.visibility === 'private' && ' · 🔒'}
                        </div>
                      </div>
                      <div style={{ fontSize: 14, color: isDone ? 'var(--sage)' : 'var(--charcoal-light)' }}>
                        {isDone ? '✓' : isSubmitting ? '…' : '+'}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
