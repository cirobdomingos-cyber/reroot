/**
 * FriendsFeed — "Para onde seus amigos estão indo".
 *
 * Upcoming events at least one friend RSVPed to. Lives at the top of the
 * Community tab: it's the one thing there that changes day to day, and it
 * used to sit at the bottom of the Amigos sub-tab, under the invite code
 * and the friend list, where nobody scrolled to it.
 *
 * Renders nothing for logged-out users or while there's nothing to show —
 * an empty box at the top of Community would push groups down for no
 * reason.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import Avatar from './Avatar'
import { fetchFriendsFeed } from '../services/api'

const _PT_WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const _PT_MONTHS   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']

function formatFeedDate(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return ''
  const wd = _PT_WEEKDAYS[d.getDay()]
  const mo = _PT_MONTHS[d.getMonth()]
  const time = d.getHours() || d.getMinutes()
    ? ` · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : ''
  return `${wd}, ${d.getDate()} ${mo}${time}`
}

export default function FriendsFeed() {
  const { state } = useApp()
  const t = useT()
  const navigate = useNavigate()
  const googleId = state.googleUser?.id
  const [feed, setFeed] = useState([])

  useEffect(() => {
    if (!googleId) { setFeed([]); return }
    let cancelled = false
    fetchFriendsFeed(googleId).then(events => {
      if (!cancelled) setFeed(events || [])
    })
    return () => { cancelled = true }
  }, [googleId])

  if (!googleId || feed.length === 0) return null

  return (
    <div style={{ margin: '14px 16px 4px' }}>
      <div className="section-label" style={{ marginLeft: 0, marginBottom: 8 }}>
        {t.friends_feed_label}
      </div>
      {feed.map(ev => (
        <div
          key={ev.event_id}
          onClick={() => navigate('/events', { state: { openEventId: ev.event_id } })}
          style={{
            background: 'var(--white)', borderRadius: 14, padding: '12px 14px',
            border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
            marginBottom: 8, cursor: 'pointer',
          }}
        >
          <div style={{
            fontSize: 14, fontWeight: 600, color: 'var(--charcoal)', marginBottom: 4,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {ev.event_name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginBottom: 8 }}>
            {formatFeedDate(ev.event_date)}{ev.event_venue ? ` · ${ev.event_venue}` : ''}
          </div>
          {ev.friends_going && ev.friends_going.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex' }}>
                {ev.friends_going.slice(0, 4).map((f, i) => (
                  <button
                    key={f.google_id ?? i}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (f.google_id) navigate(`/friends/${encodeURIComponent(f.google_id)}`)
                    }}
                    disabled={!f.google_id}
                    title={f.google_id ? `Ver eventos de ${f.name}` : f.name}
                    style={{
                      background: 'none', border: 'none', padding: 0,
                      marginLeft: i === 0 ? 0 : -8,
                      cursor: f.google_id ? 'pointer' : 'default',
                      borderRadius: '50%',
                    }}
                  >
                    <Avatar name={f.name} src={f.picture} size={26} />
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--terra)' }}>
                {ev.friends_going.length} {t.friends_feed_going}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
