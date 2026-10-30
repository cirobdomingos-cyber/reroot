import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchChannel, fetchChannels, setChannelFollow, trackEvent } from '../services/api'

// The season's channel, above the week strip on Home.
//
// A featured channel (groups.featured_until, set by the founder) is the
// one thing the catalog wants everyone to see this month — Carnaval
// first. The band names it, says what's next and when, and offers the
// follow. It is for people who DON'T follow yet: once you do, the
// channel's nights are already in your feed with "via auê Carnaval" on
// them, and a band repeating that is the app selling you what you
// bought. So it hides on follow, and never shows to a follower.
//
// Two cheap calls (the channel list, then the one channel) rather than
// a new endpoint: the list says whether there is a season at all, and
// most days there isn't. Nothing here is per-user LLM work.
// Local calendar day, not UTC: Curitiba's day ends at 21:00 UTC-wise,
// and a saída at 22h is still tonight's.
function localToday() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// The nearest night still on: starting today or later, or a multi-day
// one (a bloco's weekend) that hasn't ended yet.
function nextEvent(events) {
  const today = localToday()
  return (events || [])
    .filter(e => ((e.dateEnd || e.dateStart || '').slice(0, 10)) >= today)
    .sort((a, b) => (a.dateStart || '').localeCompare(b.dateStart || ''))[0] || null
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

function whenLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = d.getHours()
  const mm = d.getMinutes()
  const time = mm ? `${hh}h${String(mm).padStart(2, '0')}` : `${hh}h`
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}, ${time}`
}

// "hoje" / "amanhã" / "falta N dias" to the next saída — the countdown
// is to the next night, not to Carnaval itself: that is the date that
// moves every week and the one a person can act on.
function countdown(iso) {
  if (!iso) return ''
  const target = new Date(iso.slice(0, 10) + 'T00:00:00')
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((target - start) / 86400000)
  if (days <= 0) return 'é hoje'
  if (days === 1) return 'é amanhã'
  return `faltam ${days} dias`
}

export default function SeasonBand({ googleId }) {
  const navigate = useNavigate()
  const [channel, setChannel] = useState(null)
  const [next, setNext] = useState(null)
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    let alive = true
    // A sign-in or sign-out re-runs this; what the last run found is
    // not an answer for the new person.
    setChannel(null)
    setNext(null)
    setGone(false)
    fetchChannels(googleId).then(async (list) => {
      const featured = (list || []).find(c => c.featured && !c.is_following && (c.upcoming_event_count || 0) > 0)
      if (!featured || !alive) return
      const detail = await fetchChannel(featured.id, googleId)
      if (!alive) return
      setChannel({ ...featured, ...(detail?.channel || {}) })
      setNext(nextEvent(detail?.events))
      trackEvent('season_band_shown', { channel_id: featured.id })
    }).catch(() => {})
    return () => { alive = false }
  }, [googleId])

  if (!channel || gone) return null

  async function follow() {
    if (!googleId) { navigate(`/channels/${channel.id}`); return }
    setBusy(true)
    try {
      await setChannelFollow(channel.id, googleId, true)
      trackEvent('channel_followed', { channel_id: channel.id, via: 'season_band' })
      setGone(true)
    } catch {
      setBusy(false)
    }
  }

  return (
    <div style={{
      margin: '10px 16px 0', padding: '12px 14px', borderRadius: 14,
      background: 'var(--season-soft)', border: `1.5px solid var(--season)`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="neon-mono" style={{
          fontSize: 10, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase',
          padding: '3px 8px', borderRadius: 7, background: 'var(--season)', color: 'var(--bg)',
        }}>
          🥁 temporada
        </span>
        {next && (
          <span className="neon-mono" style={{ fontSize: 10.5, color: 'var(--season)', letterSpacing: '0.06em' }}>
            {countdown(next.dateStart)}
          </span>
        )}
      </div>
      <button
        onClick={() => navigate(`/channels/${channel.id}`)}
        style={{
          display: 'block', width: '100%', textAlign: 'left', background: 'none',
          border: 'none', padding: 0, marginTop: 8, cursor: 'pointer',
        }}
      >
        <div className="neon-display" style={{ fontSize: 20, color: 'var(--text)', lineHeight: 1.1 }}>
          {channel.name}
        </div>
        {next && (
          <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 4, lineHeight: 1.4 }}>
            Próximo: {next.name} · {whenLabel(next.dateStart)}{next.venue ? ` · ${next.venue}` : ''}
          </div>
        )}
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button
          onClick={follow}
          disabled={busy}
          style={{
            padding: '8px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontSize: 12.5, fontWeight: 800, background: 'var(--season)', color: 'var(--bg)',
            opacity: busy ? 0.6 : 1,
          }}
        >
          Seguir
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
          {channel.upcoming_event_count} rolê{channel.upcoming_event_count === 1 ? '' : 's'}
          {channel.follower_count ? ` · ${channel.follower_count} seguindo` : ''}
        </span>
      </div>
    </div>
  )
}
