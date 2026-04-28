import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import { fetchEventAttendees } from '../services/api'

// "Quem vai" — compact RSVP roster for the event hero. Avatar stack with
// a +N overflow pill plus a friendly summary ("Você + 3 amigos", "2 pessoas").
// Tapping the row expands an inline list of attendees; friends in the
// expanded list are tappable (navigate to their profile via onFriend).
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
}) {
  const [attendees, setAttendees] = useState([])
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!eventId || !googleId) { setAttendees([]); return }
    let cancelled = false
    fetchEventAttendees(eventId, googleId).then(list => {
      if (!cancelled) setAttendees(list || [])
    })
    return () => { cancelled = true }
  }, [eventId, googleId, refreshKey])

  const others = attendees
  const total = others.length + (isRsvped ? 1 : 0)
  if (total === 0) return null

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
          <strong style={{ color: 'var(--charcoal)' }}>{summary}</strong> — quem vai
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
            <button
              key={a.google_id}
              onClick={() => onFriend?.(a.google_id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: 'none', border: 'none', padding: 4,
                cursor: onFriend ? 'pointer' : 'default',
                textAlign: 'left', borderRadius: 8,
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
          ))}
          {strangersList.map(a => (
            <div key={a.google_id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: 4,
            }}>
              <Avatar name={a.name} src={a.picture} size={28} />
              <div style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--charcoal)' }}>
                {a.name}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
