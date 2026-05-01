import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import { fetchEventAttendees, removeEventInvitee } from '../services/api'

// "Quem vai" — compact RSVP roster for the event hero. Avatar stack with
// a +N overflow pill plus a friendly summary ("Você + 3 amigos", "2 pessoas").
// Tapping the row expands an inline list of attendees; friends in the
// expanded list are tappable (navigate to their profile via onFriend).
//
// Pending invitees (named-invite-but-not-yet-RSVPed) render below the
// "vão" block when the event is private and the invitee list is non-
// empty. They use muted styling so the difference reads as "still
// deciding" without dragging eye-weight away from confirmed.
//
// The backend `/events/{id}/attendees` endpoint excludes the requester
// from its result, so we stitch the viewer back in when they've RSVPed —
// otherwise the hero would say "2 vão" while the user is staring at their
// own confirmed status. Privacy: the endpoint already filters strangers
// with showProfileToStrangers=false; we don't redo that here.
//
// Props:
//   eventId       string   — required to fetch attendees
//   googleId      string   — viewer's id (used as the request's `google_id`)
//   isRsvped      bool     — whether the viewer has already RSVPed
//   refreshKey    any      — bump when viewer toggles RSVP to refetch
//   viewerName    string   — viewer's name for the stitched-in chip
//   viewerPicture string   — viewer's avatar
//   onFriend      function — called with google_id when a friend row is tapped
export default function AttendeesRow({
  eventId, googleId, isRsvped, refreshKey,
  viewerName, viewerPicture, onFriend,
  // canManage: true when the viewer is the event creator or a co-host —
  // unlocks the "Remover" button next to each attendee/pending entry.
  // Caller is responsible for the role check; backend re-validates.
  canManage = false,
}) {
  const [attendees, setAttendees] = useState([])
  const [pending, setPending] = useState([])
  const [expanded, setExpanded] = useState(false)
  const [bumpKey, setBumpKey] = useState(0)
  useEffect(() => {
    if (!eventId || !googleId) { setAttendees([]); setPending([]); return }
    let cancelled = false
    fetchEventAttendees(eventId, googleId).then(({ attendees: a, pending: p }) => {
      if (!cancelled) { setAttendees(a || []); setPending(p || []) }
    })
    return () => { cancelled = true }
  }, [eventId, googleId, refreshKey, bumpKey])

  async function handleRemove(invitee) {
    if (!canManage || !invitee?.google_id) return
    if (!confirm(`Remover ${invitee.name || 'esse convidado'} do evento?`)) return
    // Optimistic: drop the row from both lists locally so the UI
    // responds instantly. The bumpKey-triggered refetch below
    // reconciles with the server (in case the backend rejected for
    // some reason we don't surface).
    setAttendees(prev => prev.filter(a => a.google_id !== invitee.google_id))
    setPending(prev => prev.filter(a => a.google_id !== invitee.google_id))
    try {
      await removeEventInvitee(eventId, invitee.google_id, googleId)
      setBumpKey(k => k + 1)
    } catch (err) {
      alert(err?.message || 'Falha ao remover.')
      // Restore from server on error.
      setBumpKey(k => k + 1)
    }
  }

  const others = attendees
  const total = others.length + (isRsvped ? 1 : 0)
  // Hide the row entirely only when there's nothing to say — no RSVPs
  // and no pending invitees either. Otherwise we still surface the
  // pending list, which is the host's main planning signal.
  if (total === 0 && pending.length === 0) return null

  // First 5 avatars in the stack — beyond that we render a "+N" pill.
  const stack = []
  if (isRsvped) {
    stack.push({ name: viewerName || 'Você', picture: viewerPicture, isViewer: true })
  }
  for (const a of others) {
    if (stack.length >= 5) break
    stack.push({ name: a.name || 'Alguém', picture: a.picture, isFriend: a.is_friend })
  }
  const overflow = total - stack.length

  // Friendly summary line.
  const friendCount = others.filter(a => a.is_friend).length
  const othersCount = others.length
  let summary
  if (isRsvped && othersCount === 0) {
    summary = 'Só você por enquanto'
  } else if (isRsvped) {
    if (friendCount > 0 && friendCount === othersCount) {
      summary = `Você + ${friendCount} amig${friendCount === 1 ? 'o' : 'os'}`
    } else if (friendCount > 0) {
      summary = `Você, ${friendCount} amig${friendCount === 1 ? 'o' : 'os'} e mais ${othersCount - friendCount}`
    } else {
      summary = `Você + ${othersCount}`
    }
  } else {
    if (friendCount > 0 && friendCount === othersCount) {
      summary = `${friendCount} amig${friendCount === 1 ? 'o' : 'os'} ${friendCount === 1 ? 'vai' : 'vão'}`
    } else if (friendCount > 0) {
      summary = `${friendCount} amig${friendCount === 1 ? 'o' : 'os'} + ${othersCount - friendCount}`
    } else {
      summary = `${othersCount} ${othersCount === 1 ? 'pessoa' : 'pessoas'}`
    }
  }

  // Build the full expanded roster — viewer (if RSVPed) at the top,
  // then friends, then strangers. Sort within friends/strangers by name
  // so it's stable across re-fetches.
  const friendsList = others
    .filter(a => a.is_friend)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  const strangersList = others
    .filter(a => !a.is_friend)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

  return (
    <div style={{
      borderRadius: 12, background: 'white',
      border: '1px solid var(--border)', overflow: 'hidden',
      marginTop: 12,
    }}>
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', width: '100%',
          background: 'none', border: 'none', cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'row-reverse' }}>
          {overflow > 0 && (
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'var(--cream)', color: 'var(--charcoal-mid)',
              border: '2px solid white', marginLeft: -8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
            }}>+{overflow}</div>
          )}
          {stack.slice().reverse().map((p, i) => (
            <div key={i} style={{
              border: '2px solid white', borderRadius: '50%',
              marginLeft: i === stack.length - 1 ? 0 : -8,
            }}>
              <Avatar name={p.name} src={p.picture} size={28} />
            </div>
          ))}
        </div>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--charcoal-mid)' }}>
          {total > 0 ? (
            <>
              <strong style={{ color: 'var(--charcoal)' }}>{summary}</strong> — quem vai
              {pending.length > 0 && (
                <span style={{ color: 'var(--charcoal-light)' }}>
                  {' '}· {pending.length} aguardando
                </span>
              )}
            </>
          ) : (
            <strong style={{ color: 'var(--charcoal)' }}>
              {pending.length} {pending.length === 1 ? 'pessoa convidada' : 'pessoas convidadas'} — ninguém confirmou ainda
            </strong>
          )}
        </span>
        <span style={{
          fontSize: 12, color: 'var(--charcoal-light)',
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform 120ms',
        }}>▾</span>
      </button>

      {expanded && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '8px 12px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {isRsvped && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 4 }}>
              <Avatar name={viewerName || 'Você'} src={viewerPicture} size={28} />
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>
                Você
              </div>
            </div>
          )}
          {friendsList.map(a => (
            <div key={a.google_id} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: 4,
            }}>
              <button
                onClick={() => onFriend?.(a.google_id)}
                style={{
                  flex: 1,
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: 'none', border: 'none', padding: 0,
                  cursor: onFriend ? 'pointer' : 'default',
                  textAlign: 'left',
                }}
              >
                <Avatar name={a.name} src={a.picture} size={28} />
                <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>
                  {a.name}
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: '#5B8DD9',
                  textTransform: 'uppercase', letterSpacing: 0.5,
                }}>
                  amigo
                </span>
                {onFriend && <span style={{ fontSize: 14, color: 'var(--charcoal-light)' }}>→</span>}
              </button>
              {canManage && (
                <RemoveBtn onClick={() => handleRemove(a)} />
              )}
            </div>
          ))}
          {strangersList.map(a => (
            <div key={a.google_id} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: 4,
            }}>
              {/* Strangers are tappable too — same onFriend handler
                  that takes friends to their detail page. The detail
                  page (FriendDetail) now handles non-friends by
                  showing the "+ Adicionar como amigo" button. */}
              <button
                onClick={() => onFriend?.(a.google_id)}
                style={{
                  flex: 1,
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: 'none', border: 'none', padding: 0,
                  cursor: onFriend ? 'pointer' : 'default',
                  textAlign: 'left',
                }}
              >
                <Avatar name={a.name} src={a.picture} size={28} />
                <div style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--charcoal)' }}>
                  {a.name}
                </div>
                {onFriend && <span style={{ fontSize: 14, color: 'var(--charcoal-light)' }}>→</span>}
              </button>
              {canManage && (
                <RemoveBtn onClick={() => handleRemove(a)} />
              )}
            </div>
          ))}
          {/* Pending invitees — named-but-haven't-responded. Muted
              styling so the difference reads at a glance. Keep below the
              "vão" group so confirmed attendees stay top-of-mind. */}
          {pending.length > 0 && (
            <>
              {(others.length > 0 || isRsvped) && (
                <div style={{
                  marginTop: 6, paddingTop: 6,
                  borderTop: '1px dashed var(--border)',
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                  color: 'var(--charcoal-light)', textTransform: 'uppercase',
                }}>
                  Aguardando
                </div>
              )}
              {pending.map(a => (
                <div key={`pending-${a.google_id}`} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: 4,
                }}>
                  <button
                    onClick={() => onFriend?.(a.google_id)}
                    style={{
                      flex: 1,
                      display: 'flex', alignItems: 'center', gap: 10,
                      background: 'none', border: 'none', padding: 0,
                      cursor: onFriend ? 'pointer' : 'default',
                      textAlign: 'left',
                      opacity: 0.7,
                    }}
                  >
                    <Avatar name={a.name} src={a.picture} size={28} />
                    <div style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--charcoal)' }}>
                      {a.name}
                    </div>
                    <span style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                      color: 'var(--charcoal-light)', textTransform: 'uppercase',
                    }}>
                      convidado
                    </span>
                  </button>
                  {canManage && (
                    <RemoveBtn onClick={() => handleRemove(a)} />
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Compact "X" button used by hosts to remove an attendee/invitee from
// the event. Keeps the row clean — destructive action stays small and
// to the right edge so accidental taps are rare.
function RemoveBtn({ onClick }) {
  return (
    <button
      onClick={onClick}
      title="Remover do evento"
      style={{
        width: 28, height: 28, borderRadius: '50%',
        border: '1px solid #FFCDD2', background: 'white',
        color: '#C62828', fontSize: 14, fontWeight: 700,
        cursor: 'pointer', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        lineHeight: 1,
      }}
    >
      ×
    </button>
  )
}
