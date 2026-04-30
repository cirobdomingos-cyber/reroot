/**
 * PostEventAttendees — "People you met" section for past events.
 *
 * Shown in the event detail drawer after an event's date has passed
 * and the user had RSVPed. Lists other attendees with one-tap connect.
 *
 * This completes the core social loop: attend event -> see people -> connect.
 * Portfolio signal: this is the "activation moment" pattern — capturing peak
 * satisfaction (post-event) to drive the next engagement action (friend request).
 */
import { useState, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import { fetchEventAttendees, addFriend } from '../services/api'
import Avatar from './Avatar'

export default function PostEventAttendees({ eventId, eventDate }) {
  const { state } = useApp()
  const t = useT()
  const [attendees, setAttendees] = useState([])
  const [loading, setLoading] = useState(true)
  // Track per-attendee connect state: { [google_id]: 'idle' | 'sending' | 'sent' }
  const [connectState, setConnectState] = useState({})

  const googleId = state.googleUser?.id

  // Only render for past events where user RSVPed and is logged in
  const isPast = eventDate && new Date(eventDate) < new Date()
  const hasRsvped = !!state.rsvps[eventId]

  useEffect(() => {
    if (!isPast || !hasRsvped || !googleId) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    fetchEventAttendees(eventId, googleId).then(data => {
      if (!cancelled) {
        // Post-event roster is RSVPed-only; pending is irrelevant here.
        setAttendees(data.attendees || [])
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [eventId, googleId, isPast, hasRsvped])

  // Don't render anything if conditions aren't met
  if (!isPast || !hasRsvped || !googleId) return null

  // Don't render while loading or if no attendees
  if (loading) {
    return (
      <div style={{
        background: 'white', borderRadius: 16, padding: '16px 18px',
        marginBottom: 18, border: '1px solid var(--border)',
      }}>
        <div style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: 0.8, color: 'var(--terra)', marginBottom: 12,
        }}>
          {t.people_you_met}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 40, height: 40, borderRadius: '50%',
              background: '#f0ede8', animation: 'shimmer 1.4s infinite',
              backgroundSize: '200% 100%',
            }} />
          ))}
        </div>
      </div>
    )
  }

  if (attendees.length === 0) return null

  async function handleConnect(attendee) {
    setConnectState(prev => ({ ...prev, [attendee.google_id]: 'sending' }))
    const result = await addFriend(googleId, attendee.friend_code)
    if (result && (result.status === 'ok' || result.status === 'already_friends')) {
      setConnectState(prev => ({ ...prev, [attendee.google_id]: 'sent' }))
      // Update the attendee's is_friend locally
      setAttendees(prev => prev.map(a =>
        a.google_id === attendee.google_id ? { ...a, is_friend: true } : a
      ))
    } else {
      setConnectState(prev => ({ ...prev, [attendee.google_id]: 'idle' }))
    }
  }

  return (
    <div style={{
      background: 'white', borderRadius: 16, padding: '16px 18px',
      marginBottom: 18, border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}>
      {/* Section header */}
      <div style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: 0.8, color: 'var(--terra)', marginBottom: 14,
      }}>
        {t.people_you_met}
      </div>

      {/* Attendee list */}
      {attendees.map(attendee => {
        const cState = connectState[attendee.google_id] || 'idle'
        const isFriend = attendee.is_friend || cState === 'sent'

        return (
          <div
            key={attendee.google_id}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 0',
              borderBottom: '1px solid var(--border)',
            }}
          >
            {/* Avatar */}
            <Avatar name={attendee.name} src={attendee.picture} size={40} />

            {/* Name */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 600, color: 'var(--charcoal)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {attendee.name}
              </div>
            </div>

            {/* Action button */}
            {isFriend ? (
              <span style={{
                fontSize: 11, fontWeight: 600, color: 'var(--sage)',
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '6px 12px', borderRadius: 10,
                background: 'var(--sage-pale)', flexShrink: 0,
              }}>
                {t.already_friends}
              </span>
            ) : (
              <button
                onClick={() => handleConnect(attendee)}
                disabled={cState === 'sending'}
                style={{
                  padding: '6px 14px', borderRadius: 10,
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  flexShrink: 0, transition: 'all 0.15s',
                  border: 'none',
                  background: cState === 'sending' ? 'rgba(44,44,44,0.07)' : 'var(--terra)',
                  color: cState === 'sending' ? 'var(--charcoal-mid)' : 'white',
                  opacity: cState === 'sending' ? 0.7 : 1,
                }}
              >
                {cState === 'sending' ? t.connecting : t.connect}
              </button>
            )}
          </div>
        )
      })}

      {/* Remove bottom border from last item */}
      <style>{`
        div:last-child > div[style*="border-bottom"]:last-child {
          border-bottom: none !important;
        }
      `}</style>
    </div>
  )
}
