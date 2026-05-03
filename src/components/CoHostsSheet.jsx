import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Avatar from './Avatar'
import { fetchEventAttendees, addEventCoHost, removeEventCoHost } from '../services/api'

// Co-organizer management sheet — opened from the "Adicionado por" chip
// in the Card Hero. Two modes share one sheet:
//
//   - **Creator view**: full management. Tap an invitee to promote;
//     tap a co-host's "Remover" to demote.
//   - **Co-host self view**: read-only list of organizers + a
//     "Sair de co-organizador" self-demotion button.
//
// The component reuses fetchEventAttendees to source profile info
// (name, picture) for both invitees and co-hosts — same privacy rules
// already applied. Avoids a separate "list invitees with profile" path.
//
// Props:
//   open                 boolean
//   onClose              () => void
//   eventId              string
//   googleId             string  — viewer's id
//   creatorId            string  — event.created_by; used to identify the creator chip
//   creatorName          string  — fallback display name for the creator
//   creatorPicture       string  — fallback avatar
//   coHostIds            string[]
//   inviteeIds           string[] — extra_invitee_ids; eligible co-host pool
//   onChange             (newCoHostIds) => void

export default function CoHostsSheet({
  open, onClose, eventId, googleId,
  creatorId, creatorName, creatorPicture,
  coHostIds = [], inviteeIds = [],
  onChange,
}) {
  const [profiles, setProfiles] = useState({})  // google_id → {name, picture}
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const isCreator = googleId && googleId === creatorId
  const isCoHost = googleId && coHostIds.includes(googleId)

  // Hide Companion FAB while sheet is up.
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: 1 } }))
    return () => window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: -1 } }))
  }, [open])

  // Pull profile info from the attendees endpoint — covers both
  // RSVPed and pending invitees, with privacy rules already applied
  // server-side. Cheap (one round-trip) and avoids duplicating the
  // profile-resolution code on the client.
  useEffect(() => {
    if (!open || !eventId || !googleId) return
    let cancelled = false
    fetchEventAttendees(eventId, googleId).then(({ attendees, pending }) => {
      if (cancelled) return
      const map = {}
      for (const u of [...(attendees || []), ...(pending || [])]) {
        if (u.google_id) map[u.google_id] = { name: u.name, picture: u.picture }
      }
      // Stitch in the creator (excluded from /attendees) and the viewer
      // (also excluded).
      if (creatorId && !map[creatorId]) {
        map[creatorId] = { name: creatorName || 'Criador', picture: creatorPicture || '' }
      }
      setProfiles(map)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [open, eventId, googleId, creatorId, creatorName, creatorPicture])

  // Reset error on each reopen.
  useEffect(() => {
    if (open) { setError(null); setBusyId(null) }
  }, [open])

  async function promote(targetGid) {
    setError(null); setBusyId(targetGid)
    try {
      const result = await addEventCoHost(eventId, googleId, targetGid)
      onChange?.(result.co_host_ids || [])
    } catch (e) {
      setError(e?.message || 'Não consegui promover')
    } finally {
      setBusyId(null)
    }
  }

  async function demote(targetGid) {
    setError(null); setBusyId(targetGid)
    try {
      const result = await removeEventCoHost(eventId, googleId, targetGid)
      onChange?.(result.co_host_ids || [])
      // If the viewer just self-demoted, close the sheet — they no
      // longer have management rights here.
      if (targetGid === googleId && !isCreator) {
        onClose?.()
      }
    } catch (e) {
      setError(e?.message || 'Não consegui remover')
    } finally {
      setBusyId(null)
    }
  }

  if (typeof document === 'undefined') return null

  // Eligible to promote: people on the invitee list who aren't already
  // co-hosts. Creator is always implicitly the top organizer; not
  // listed as eligible.
  const coHostSet = new Set(coHostIds)
  const eligibleInvitees = (inviteeIds || []).filter(
    gid => gid && gid !== creatorId && !coHostSet.has(gid),
  )

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={busyId ? undefined : onClose}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 10500 }}
          />
          <motion.div
            key="sheet"
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--white)',
              borderRadius: '20px 20px 0 0',
              padding: '8px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
              zIndex: 10501, maxHeight: '85vh', overflowY: 'auto',
              overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
            </div>
            <h3 style={{ fontSize: 17, fontWeight: 700, textAlign: 'center', marginBottom: 4, color: 'var(--charcoal)' }}>
              🎲 Quem organiza
            </h3>
            <div style={{ fontSize: 12, color: 'var(--charcoal-light)', textAlign: 'center', marginBottom: 14 }}>
              Co-organizadores podem convidar e apagar o evento.
            </div>

            {/* Creator row — always shown, never demote-able. */}
            <OrganizerRow
              gid={creatorId}
              profile={profiles[creatorId] || { name: creatorName, picture: creatorPicture }}
              roleLabel="Criador"
            />

            {coHostIds.map(gid => (
              <OrganizerRow
                key={gid}
                gid={gid}
                profile={profiles[gid]}
                roleLabel="Co-organizador"
                action={
                  isCreator || gid === googleId ? (
                    <button
                      onClick={() => demote(gid)}
                      disabled={busyId === gid}
                      style={demoteBtnStyle(busyId === gid)}
                    >
                      {busyId === gid ? '...' : (gid === googleId ? 'Sair' : 'Remover')}
                    </button>
                  ) : null
                }
              />
            ))}

            {/* Promote section — only for the creator. Co-hosts can't
                promote others (avoids cascading delegation). */}
            {isCreator && eligibleInvitees.length > 0 && (
              <>
                <div style={{
                  marginTop: 14, marginBottom: 6,
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
                  color: 'var(--charcoal-light)', textTransform: 'uppercase',
                }}>
                  Promover convidados
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {eligibleInvitees.map(gid => {
                    const p = profiles[gid]
                    if (!p) return null  // privacy-filtered or not yet loaded
                    return (
                      <OrganizerRow
                        key={gid}
                        gid={gid}
                        profile={p}
                        action={
                          <button
                            onClick={() => promote(gid)}
                            disabled={busyId === gid}
                            style={promoteBtnStyle(busyId === gid)}
                          >
                            {busyId === gid ? '...' : 'Promover'}
                          </button>
                        }
                      />
                    )
                  })}
                </div>
              </>
            )}

            {!isCreator && !isCoHost && (
              <div style={{
                marginTop: 14, padding: '10px 12px', background: 'var(--cream)',
                borderRadius: 10, fontSize: 12, color: 'var(--charcoal-mid)', textAlign: 'center',
              }}>
                Só o criador pode adicionar co-organizadores.
              </div>
            )}

            {error && (
              <div style={{
                marginTop: 12, padding: '9px 12px', background: '#FFF3E0',
                color: '#BF360C', borderRadius: 8, fontSize: 12, textAlign: 'center',
              }}>
                {error}
              </div>
            )}

            <button
              onClick={onClose}
              style={{
                width: '100%', marginTop: 16, padding: '12px 14px', borderRadius: 12,
                border: '1px solid var(--border)', background: 'var(--white)',
                fontSize: 13, fontWeight: 600, color: 'var(--charcoal-mid)', cursor: 'pointer',
              }}
            >
              Fechar
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function OrganizerRow({ gid, profile, roleLabel, action }) {
  const name = profile?.name || gid || ''
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 6px',
    }}>
      <Avatar name={name} src={profile?.picture} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--charcoal)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {name}
        </div>
        {roleLabel && (
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
            color: 'var(--charcoal-light)', textTransform: 'uppercase',
          }}>
            {roleLabel}
          </div>
        )}
      </div>
      {action}
    </div>
  )
}

function promoteBtnStyle(busy) {
  return {
    padding: '6px 12px', borderRadius: 8,
    background: 'var(--sage)', color: '#14081E',
    border: 'none', fontSize: 12, fontWeight: 700,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.7 : 1,
  }
}

function demoteBtnStyle(busy) {
  return {
    padding: '6px 12px', borderRadius: 8,
    background: 'transparent', color: '#C62828',
    border: '1px solid #FFCDD2', fontSize: 12, fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.7 : 1,
  }
}
