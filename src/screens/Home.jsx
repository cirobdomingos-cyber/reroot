import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp, PROFILES } from '../context/AppContext'
import { useT } from '../i18n'
import { fetchEvents, fetchFriendsFeed, fetchGroups, fetchUserGroupEvents, syncRsvp } from '../services/api'
import WeekCalendar from '../components/WeekCalendar'
import Avatar from '../components/Avatar'
import HomeEventRow from '../components/HomeEventRow'
import PersonalPlanSheet from '../components/PersonalPlanSheet'
import { getAnchorToday } from '../lib/dateAnchor'

function getGreetingKey() {
  const h = new Date().getHours()
  if (h < 12) return 'greeting_morning'
  if (h < 18) return 'greeting_afternoon'
  return 'greeting_evening'
}

// Eyebrow label tracks time-of-day on the same hour boundaries as the
// greeting. Brand stamp ▸ CWB.NIGHT.LOG stays as-is — that's the
// identity of the Neon Boteco direction and doesn't shift by hour.
function getEyebrowLabel() {
  const h = new Date().getHours()
  if (h < 12) return 'SUA MANHÃ'
  if (h < 18) return 'SUA TARDE'
  return 'SUA NOITE'
}

// Mood→event matching, used to order Home suggestions by the user's profile.
// Mirrors the backend's _MOOD_KIND / _MOOD_SOURCES / familia logic so the
// frontend can re-rank without a round-trip.
const _MOOD_KIND = {
  tranquilo:  'quiet_social',
  ativo:      'active',
  criativo:   'creative',
  comunidade: 'community',
}
// Was a source-id allowlist back when we scraped MON/SESC/Teatro Guaíra
// directly. Those scrapers are gone — equivalent IG handles cover the
// same venues. Cultural mood now matches by the LLM-extracted event
// kind only (see _mood_predicate on the backend).
const _CULTURAL_SOURCES = new Set()

function eventMatchesMood(ev, mood) {
  if (!mood || mood === 'all') return true
  if (mood in _MOOD_KIND) return ev.category === _MOOD_KIND[mood]
  if (mood === 'cultural') return _CULTURAL_SOURCES.has(ev.source)
  if (mood === 'familia') return !!ev.kidsWelcome
  return false
}

function eventPriorityRank(ev, priorityMoods) {
  for (let i = 0; i < priorityMoods.length; i++) {
    if (eventMatchesMood(ev, priorityMoods[i])) return i
  }
  return Number.MAX_SAFE_INTEGER
}

export default function Home() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()

  const [notifToast, setNotifToast] = useState(null)
  const [showPlanSheet, setShowPlanSheet] = useState(false)
  const [friendsFeed, setFriendsFeed] = useState([])
  const [groupEventsPending, setGroupEventsPending] = useState([])
  const [groupEventsAccepted, setGroupEventsAccepted] = useState([])
  // Live event catalog — fetched from backend instead of using the stale
  // static EVENTS array. Drives suggestions, RSVP cards, and reconnect.
  const [allEvents, setAllEvents] = useState([])
  // Lifted from WeekCalendar so "Seus próximos eventos" knows which week
  // the calendar is currently showing — without this, navigating the
  // calendar to a future week leaves the "próximos" section showing the
  // exact same events that are already visible in the strip.
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0)

  useEffect(() => {
    // Fetch the live catalog (broad "Tudo" view — same as Events screen).
    fetchEvents('all').then(({ events }) => {
      setAllEvents(events || [])
    }).catch(() => setAllEvents([]))
  }, [])

  useEffect(() => {
    const googleId = state.googleUser?.id
    if (!googleId) return
    fetchFriendsFeed(googleId).then(events => {
      setFriendsFeed(events.filter(ev => ev.friends_going?.length > 0))
    })
    // Fetch every private event the user can see (classic group events,
    // personal plans where they're the creator or an invitee, plus
    // group+extras events). Split into pending vs accepted by checking
    // local RSVP state. Was previously only pulling one next_event per
    // group via fetchGroups, which missed personal plans entirely.
    const now = Date.now()
    fetchUserGroupEvents(googleId).then(events => {
      const pending = []
      const accepted = []
      for (const ev of (events || [])) {
        const t = ev.dateStart ? Date.parse(ev.dateStart) : NaN
        if (Number.isNaN(t) || t <= now) continue  // future-only on Home
        // Normalize shape: groupEvents from /events/group already have
        // groupName as a property; mirror it as group_name for the
        // existing UpcomingPlans renderer that expects either.
        const norm = { ...ev, group_name: ev.groupName || ev.group_name || '' }
        if (state.rsvps[ev.id]) accepted.push(norm)
        else pending.push(norm)
      }
      setGroupEventsPending(pending)
      setGroupEventsAccepted(accepted)
    })
    // Refetch friends feed when the tab regains focus — covers the case
    // where a friend RSVPd while the app was in background.
    function onVisible() {
      if (document.visibilityState === 'visible') {
        fetchFriendsFeed(googleId).then(events => {
          setFriendsFeed(events.filter(ev => ev.friends_going?.length > 0))
        })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [state.googleUser?.id])

  // "Amigos vão" tile — counts (friend, event) pairs across all
  // upcoming events. One friend going to three different events = 3.
  // Reads as "friend-confirmations you might want to join" rather
  // than "distinct friends with any plans". Total social activity
  // signal beats unique-person count for surfacing FOMO.
  const friendGoingCount = friendsFeed.reduce(
    (sum, ev) => sum + (ev.friends_going?.length || 0),
    0,
  )

  // event_id → [{ name, picture, google_id }, ...] for the WeekCalendar
  // rows to render the same avatar stack the "Amigos vão" section
  // already shows below. Same source data, just keyed for O(1) lookup
  // per row instead of scanning friendsFeed for each event.
  const friendsByEventId = (() => {
    const map = {}
    for (const ev of friendsFeed) {
      if (ev.event_id && Array.isArray(ev.friends_going) && ev.friends_going.length) {
        map[ev.event_id] = ev.friends_going
      }
    }
    return map
  })()

  // Upcoming RSVPd events (future only) — drives the "Confirmados" count.
  // Computed directly from state.rsvps (which stores dateStart per RSVP)
  // so the count is accurate even if the live `allEvents` catalog doesn't
  // include this specific event (paginated, filtered by mood, or a custom
  // user-created event). Entries without a dateStart are legacy holdovers
  // from the old boolean-shaped rsvps; they DON'T count, so the tile
  // doesn't inflate with stale data the user can't easily clean up.
  const now = Date.now()
  const upcomingRsvpIds = Object.entries(state.rsvps)
    .filter(([_id, info]) => {
      if (!info?.dateStart) return false
      const t = Date.parse(info.dateStart)
      return !Number.isNaN(t) && t > now
    })
    .map(([id]) => id)
  const rsvpCount = upcomingRsvpIds.length

  // upcomingRsvps drives "Seus próximos eventos" — every planned event
  // beyond the END of the week the calendar is currently showing. Catalog
  // RSVPs + accepted group/personal-plan invites; events inside the
  // visible week already render under "Seus eventos essa semana" so we
  // drop them here to avoid the same row appearing in both places.
  // The horizon shifts with calendarWeekOffset: navigating the calendar
  // to next week pushes the próximos cutoff by another 7 days.
  const calendarHorizon = (() => {
    const d = getAnchorToday()
    d.setDate(d.getDate() + (calendarWeekOffset + 1) * 7)
    return d.getTime()
  })()
  const upcomingRsvps = (() => {
    const catalog = allEvents.filter(ev =>
      state.rsvps[ev.id] && ev.dateStart && new Date(ev.dateStart).getTime() > now
    )
    const groupAccepted = groupEventsAccepted.filter(ev => {
      const ds = ev.dateStart || ev.date_start
      if (!ds) return false
      const t = Date.parse(ds)
      return !Number.isNaN(t) && t > now
    })
    const merged = [...catalog, ...groupAccepted]
    // Drop the events that already render in the calendar's 7-day strip.
    const beyondHorizon = merged.filter(ev => {
      const ds = ev.dateStart || ev.date_start
      if (!ds) return false
      return Date.parse(ds) >= calendarHorizon
    })
    // De-dup by id in case a row exists in both lists.
    const seen = new Set()
    return beyondHorizon.filter(ev => {
      if (seen.has(ev.id)) return false
      seen.add(ev.id)
      return true
    }).sort((a, b) => Date.parse(a.dateStart || a.date_start || '') - Date.parse(b.dateStart || b.date_start || ''))
  })()

  // Accept a pending invite — local RSVP + backend sync + move from
  // pending to accepted bucket. Used by both the WeekCalendar's invite
  // button and the new "Convites pendentes" section above the calendar.
  function handleAcceptInvite(ev) {
    const ds = ev.date_start || ev.dateStart || ''
    const venue = ev.group_name || ev.groupName || ev.venue || ''
    dispatch({
      type: 'TOGGLE_RSVP',
      payload: { eventId: ev.id, dateStart: ds, name: ev.name, venue },
    })
    if (state.googleUser?.id && (state.privacy?.shareRsvps ?? true)) {
      syncRsvp(state.googleUser.id, {
        id: ev.id, name: ev.name, venue, dateStart: ds, url: '',
      }, true)
    }
    setGroupEventsPending(prev => prev.filter(e => e.id !== ev.id))
    setGroupEventsAccepted(prev => [...prev, ev])
  }

  // Suggested events — events the user hasn't RSVPd to, ordered by the
  // user's profile preference (if set) then by date. Profile picks the
  // priority order of moods; events matching priority[0] come first,
  // then priority[1], etc. Events not in any priority mood drop to the
  // bottom but still surface.
  const profile = state.profile ? PROFILES[state.profile] : null
  const priorityMoods = profile?.priorityMoods ?? []
  const suggestedEvents = allEvents
    .filter(ev => !state.rsvps[ev.id])
    .sort((a, b) => {
      const ra = eventPriorityRank(a, priorityMoods)
      const rb = eventPriorityRank(b, priorityMoods)
      if (ra !== rb) return ra - rb
      const da = a.dateStart ? new Date(a.dateStart).getTime() : 0
      const db = b.dateStart ? new Date(b.dateStart).getTime() : 0
      return da - db
    })
    .slice(0, 3)

  // Activity ticker counts — replaces the previous stat tiles.
  // "rolando" = total events in the live catalog; falls back to a
  // skeleton zero while the fetch resolves.
  const rolandoCount = allEvents.length
  // CWB.NIGHT.LOG version stamp. ISO week of year, padded — matches the
  // mockup's `V.207` format. Live so it stays current without a deploy.
  const _now = new Date()
  const _start = new Date(_now.getFullYear(), 0, 1)
  const _weekOfYear = Math.ceil((((_now - _start) / 86400000) + _start.getDay() + 1) / 7)
  const versionStamp = `V.${String(_now.getFullYear() % 100).padStart(2, '0')}${String(_weekOfYear).padStart(2, '0')}`
  const semana = String(_weekOfYear).padStart(2, '0')

  return (
    <div>
      {/* Brand block — Neon Boteco direction. 84px "auê" wordmark in
          magenta with magenta glow, mono caption underneath. Avatar tap
          shortcuts to Profile (replaces the old Perfil nav tab). */}
      <div style={{ padding: '20px 18px 16px' }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start',
          justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div className="neon-display neon-glow-mag" style={{
              fontSize: 84, lineHeight: 0.85,
            }}>
              auê
            </div>
            <div className="neon-mono" style={{
              fontSize: 10, marginTop: 8,
              letterSpacing: '0.24em', textTransform: 'uppercase',
              color: 'var(--cyan)',
            }}>
              ▸ CWB.NIGHT.LOG // {versionStamp}
            </div>
          </div>
          <button
            onClick={() => navigate('/profile')}
            aria-label={t.nav_profile ?? 'Perfil'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 0, flexShrink: 0, borderRadius: '50%',
              marginTop: 6,
            }}
          >
            <Avatar
              src={state.googleUser?.picture}
              name={state.userName || state.googleUser?.givenName || state.googleUser?.name}
              size={40}
            />
          </button>
        </div>
      </div>

      {/* Activity ticker — three colored counts in mono, separated by
          line dividers top + bottom. Replaces the old stat tiles; the
          tile-tap routes are folded into the friends/confirmed section
          headers below (each "Ver tudo →" jumps to /my-rsvps). */}
      <div className="neon-mono" style={{
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
        padding: '8px 18px',
        display: 'flex', gap: 20, overflowX: 'auto',
        scrollbarWidth: 'none',
      }}>
        <span style={{
          fontSize: 11, color: 'var(--lime)', letterSpacing: '0.1em',
          whiteSpace: 'nowrap',
        }}>
          ● {rsvpCount} {rsvpCount === 1 ? 'confirmado' : 'confirmados'}
        </span>
        <span style={{
          fontSize: 11, color: 'var(--magenta)', letterSpacing: '0.1em',
          whiteSpace: 'nowrap',
        }}>
          ● {friendGoingCount} {friendGoingCount === 1 ? 'amigo vai' : 'amigos vão'}
        </span>
        <span style={{
          fontSize: 11, color: 'var(--cyan)', letterSpacing: '0.1em',
          whiteSpace: 'nowrap',
        }}>
          ● {rolandoCount} rolando
        </span>
      </div>

      {/* Greeting — "Boa, {name}. Bora?" with cyan glow on Bora? */}
      <div style={{ padding: '24px 18px 14px' }}>
        <div className="neon-mono" style={{
          fontSize: 10, letterSpacing: '0.24em',
          color: 'var(--text3)', marginBottom: 8,
        }}>
          {'>>'} {getEyebrowLabel()}
        </div>
        <div className="neon-display" style={{
          fontSize: 30, color: 'var(--text)', letterSpacing: '-0.025em',
        }}>
          {t[getGreetingKey()]}, <span style={{ color: 'var(--text)' }}>
            {state.userName || t.home_default_name}
          </span>. <span className="neon-glow-cyan">Bora?</span>
        </div>
      </div>

      {/* Create-plan CTA — was tucked into the Events header as a small
          icon pill, then promoted back to a full-width CTA after the
          greeting since this is "Bora?" → "or organize your own thing".
          Lime accent reads as the create affordance distinct from the
          discovery/RSVP affordances elsewhere on Home. */}
      {state.googleUser?.id && (
        <div style={{ padding: '0 18px 14px' }}>
          <button
            onClick={() => setShowPlanSheet(true)}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '14px 16px',
              background: 'transparent',
              border: '1px solid var(--lime)',
              borderRadius: 14, cursor: 'pointer',
              boxShadow: '0 0 18px rgba(198, 255, 0, 0.15)',
              textAlign: 'left',
            }}
          >
            <span style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: 'rgba(198, 255, 0, 0.10)',
              border: '1px solid rgba(198, 255, 0, 0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18,
              filter: 'drop-shadow(0 0 6px rgba(198, 255, 0, 0.5))',
            }}>🎲</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="neon-display" style={{
                fontSize: 15, color: 'var(--lime)',
                letterSpacing: '-0.01em',
                textShadow: '0 0 8px rgba(198, 255, 0, 0.4)',
              }}>
                Criar um evento com amigos
              </div>
              <div className="neon-mono" style={{
                fontSize: 10, color: 'var(--text2)',
                letterSpacing: '0.16em', textTransform: 'uppercase',
                marginTop: 4,
              }}>
                Plano privado · convide a galera
              </div>
            </div>
            <span className="neon-mono" style={{
              fontSize: 18, color: 'var(--lime)', flexShrink: 0,
            }}>→</span>
          </button>
        </div>
      )}

      {/* Pending invites — surfaces personal plans and group events the
          user was invited to but hasn't RSVP'd yet. Capped to the next 3
          (closest-in-time first) so Home stays a glanceable preview;
          full list lives in My RSVPs > Pendentes. */}
      {groupEventsPending.length > 0 && (() => {
        const sortedPending = [...groupEventsPending].sort((a, b) => {
          const ta = Date.parse(a.dateStart || a.date_start || '') || Infinity
          const tb = Date.parse(b.dateStart || b.date_start || '') || Infinity
          return ta - tb
        })
        const visible = sortedPending.slice(0, 3)
        const hidden = sortedPending.length - visible.length
        return (
          <>
            <div
              className="section-label"
              onClick={() => navigate('/my-rsvps')}
              style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                cursor: 'pointer', color: 'var(--magenta)',
              }}
            >
              <span>// {(t.home_pending_label ?? 'Convites pendentes').toUpperCase()} · {String(groupEventsPending.length).padStart(2, '0')}</span>
              <span style={{ fontSize: 10, color: 'var(--text3)', letterSpacing: '0.16em' }}>
                {(t.home_see_all ?? 'Ver tudo').toUpperCase()} →
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 18px', marginBottom: 14 }}>
              {visible.map(ev => (
                <PendingInviteRow
                  key={ev.id}
                  event={ev}
                  onOpen={() => {
                    if (ev.group_id || ev.groupId) {
                      navigate(`/groups/${ev.group_id || ev.groupId}`)
                    } else {
                      navigate('/events', { state: { openEventId: ev.id } })
                    }
                  }}
                  onAccept={() => handleAcceptInvite(ev)}
                />
              ))}
              {hidden > 0 && (
                <button
                  onClick={() => navigate('/my-rsvps')}
                  className="neon-mono"
                  style={{
                    background: 'transparent', border: '1px dashed var(--line)',
                    borderRadius: 12, padding: '10px 12px',
                    fontSize: 11, fontWeight: 500,
                    letterSpacing: '0.18em', textTransform: 'uppercase',
                    color: 'var(--text2)', cursor: 'pointer',
                  }}
                >
                  + {hidden} {hidden === 1 ? 'outro convite' : 'outros convites'} →
                </button>
              )}
            </div>
          </>
        )
      })()}

      {/* Week Calendar */}
      <div className="section-label" style={{
        color: 'var(--cyan)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      }}>
        <span>// {(t.home_calendar_label ?? 'Seu calendário').toUpperCase()}</span>
        <span style={{ color: 'var(--text3)' }}>SEMANA {semana}</span>
      </div>
      <WeekCalendar
        weekOffset={calendarWeekOffset}
        onWeekOffsetChange={setCalendarWeekOffset}
        rsvpEvents={[
          ...allEvents.filter(ev => state.rsvps[ev.id] && ev.dateStart),
          ...groupEventsAccepted.map(ev => ({
            ...ev,
            // dateStart is already camelCase from /events/group; fall back
            // to date_start in case any caller still hands us that shape.
            dateStart: ev.dateStart || ev.date_start,
            icon: ev.isPersonalPlan ? '🎲' : '👥',
            headerBg: 'linear-gradient(135deg, var(--sage-pale), #e8f0e9)',
            venue: ev.group_name || ev.venue || '',
            _isGroup: true,
          })),
        ]}
        groupEvents={groupEventsPending}
        friendsByEventId={friendsByEventId}
        language={state.language || 'pt'}
        onEventTap={(ev, type) => {
          if ((type === 'group' || ev._isGroup) && ev.group_id) {
            navigate(`/groups/${ev.group_id}`)
          } else {
            navigate('/events', { state: { openEventId: ev.id } })
          }
        }}
        onGroupRsvp={handleAcceptInvite}
      />

      {/* Upcoming RSVPs */}
      {upcomingRsvps.length > 0 && (
        <>
          <div className="section-label" style={{
            color: 'var(--lime)',
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          }}>
            <span>// {(t.home_upcoming_label ?? 'Seus próximos eventos').toUpperCase()} · {String(upcomingRsvps.length).padStart(2, '0')}</span>
          </div>
          <div style={{ margin: '0 18px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {upcomingRsvps.slice(0, 3).map(ev => {
              const friends = friendsByEventId[ev.id] || []
              return (
              <HomeEventRow
                key={ev.id}
                name={ev.name}
                dateStart={ev.dateStart}
                time={ev.time}
                venue={ev.venue}
                isRecurring={!!ev.isRecurring}
                dateEnd={ev.dateEnd}
                featured={!!ev.featured}
                isGroupEvent={!!ev.isGroupEvent}
                onClick={() => navigate('/events', { state: { openEventId: ev.id } })}
                trailing={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {friends.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        {friends.slice(0, 3).map((friend, i) => (
                          <div
                            key={(friend.google_id || friend.name) + i}
                            style={{
                              marginLeft: i === 0 ? 0 : -8,
                              boxShadow: '0 0 0 2px var(--bg2)',
                              borderRadius: '50%',
                            }}
                          >
                            <Avatar name={friend.name} src={friend.picture} size={22} />
                          </div>
                        ))}
                        <span className="neon-mono" style={{
                          fontSize: 10, color: 'var(--magenta)',
                          marginLeft: 5, letterSpacing: '0.1em',
                        }}>
                          {friends.length}
                        </span>
                      </div>
                    )}
                    <span className="neon-pill" style={{
                      color: 'var(--lime)', background: 'var(--lime-soft)',
                      flexShrink: 0,
                    }}>
                      ✓ ON
                    </span>
                  </div>
                }
              />
              )
            })}
          </div>
        </>
      )}

      {/* Friends activity feed — events friends are going to. Includes
          events the user hasn't RSVPd to yet, so it works as discovery
          ("oh, the gang is going to that"). Events the user is already
          attending are filtered out — those already show under "Seus
          eventos essa semana" with the same friends avatar stack, so
          surfacing them twice would just be noise. Tap a row to open
          the event; tap the section header to see the full list in
          Community. */}
      {(() => {
        const friendsFeedFiltered = friendsFeed.filter(ev => !state.rsvps[ev.event_id])
        if (friendsFeedFiltered.length === 0 || state.privacy?.showInFriendSuggestions === false) {
          return null
        }
        return (
        <>
          <div
            className="section-label"
            onClick={() => navigate('/my-rsvps')}
            style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              cursor: 'pointer', color: 'var(--magenta)',
            }}
          >
            <span>// {(t.home_friends_going_label ?? 'Amigos vão').toUpperCase()}</span>
            <span style={{ fontSize: 10, color: 'var(--text3)', letterSpacing: '0.16em' }}>
              {(t.home_see_all ?? 'Ver tudo').toUpperCase()} →
            </span>
          </div>
          <div style={{ margin: '0 18px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {friendsFeedFiltered.slice(0, 3).map(ev => {
              const userIsGoing = !!state.rsvps[ev.event_id]
              const time = (ev.event_date || '').slice(11, 16)  // "HH:MM" if present
              return (
                <HomeEventRow
                  key={ev.event_id}
                  name={ev.event_name}
                  dateStart={ev.event_date}
                  time={time}
                  venue={ev.event_venue || ''}
                  onClick={() => navigate('/events', { state: { openEventId: ev.event_id } })}
                  trailing={
                    <>
                      {userIsGoing && (
                        <span className="neon-pill" style={{
                          color: 'var(--lime)', background: 'var(--lime-soft)',
                          marginRight: 8,
                        }}>
                          ✓ VOCÊ
                        </span>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        {ev.friends_going.slice(0, 3).map((friend, i) => (
                          <div
                            key={friend.name + i}
                            style={{
                              marginLeft: i === 0 ? 0 : -8,
                              boxShadow: '0 0 0 2px var(--bg2)',
                              borderRadius: '50%',
                            }}
                          >
                            <Avatar name={friend.name} src={friend.picture} size={24} />
                          </div>
                        ))}
                        <span className="neon-mono" style={{
                          fontSize: 10, color: 'var(--magenta)', marginLeft: 6,
                          letterSpacing: '0.1em',
                        }}>
                          {ev.friends_going.length}
                        </span>
                      </div>
                    </>
                  }
                />
              )
            })}
          </div>
        </>
        )
      })()}

      {/* Suggested events — tap a row to open the full hero on the
          Events tab; RSVP happens there. */}
      <div className="section-label" style={{
        color: 'var(--cyan)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      }}>
        <span>// {(t.home_suggested_label ?? 'Pra você').toUpperCase()} · {String(rolandoCount).padStart(2, '0')}</span>
      </div>
      <div style={{ margin: '0 18px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {suggestedEvents.map(ev => (
          <HomeEventRow
            key={ev.id}
            name={ev.name}
            dateStart={ev.dateStart}
            time={ev.time}
            venue={ev.venue}
            isRecurring={!!ev.isRecurring}
            isGroupEvent={!!ev.isGroupEvent}
            onClick={() => navigate('/events', { state: { openEventId: ev.id } })}
            trailing={null}
          />
        ))}
        <button
          onClick={() => navigate('/events')}
          className="neon-mono"
          style={{
            width: '100%', padding: 12, borderRadius: 12,
            fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
            cursor: 'pointer', border: '1px solid var(--line)',
            background: 'transparent', color: 'var(--cyan)',
          }}
        >
          {(t.home_see_all_events ?? 'Ver todos os eventos').toUpperCase()} ↗
        </button>
      </div>

      {/* Community highlights */}
      <div className="section-label" style={{ color: 'var(--magenta)' }}>
        // {(t.home_community_label ?? 'Comunidade').toUpperCase()}
      </div>
      <div style={{ margin: '0 18px 12px' }}>
        <div
          onClick={() => navigate('/community')}
          style={{
            background:
              'radial-gradient(circle at 20% 20%, rgba(255, 43, 214, 0.35) 0%, transparent 55%),' +
              ' radial-gradient(circle at 80% 80%, rgba(0, 229, 255, 0.30) 0%, transparent 55%),' +
              ' var(--bg2)',
            border: '1px solid var(--line)',
            borderRadius: 16, padding: '18px 20px', cursor: 'pointer',
            color: 'var(--text)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ minWidth: 0 }}>
              <div className="neon-mono" style={{
                fontSize: 10, color: 'var(--lime)',
                letterSpacing: '0.22em', textTransform: 'uppercase',
                marginBottom: 4,
              }}>
                // REDE
              </div>
              <div className="neon-display" style={{
                fontSize: 18, color: 'var(--text)', marginBottom: 4,
              }}>
                {t.home_community_cta ?? 'Amigos & Grupos'}
              </div>
              <div className="neon-mono" style={{
                fontSize: 11, color: 'var(--text2)', letterSpacing: '0.04em',
              }}>
                {t.home_community_sub ?? 'Conecte-se com pessoas e entre em grupos'}
              </div>
            </div>
            <span className="neon-mono" style={{
              fontSize: 22, color: 'var(--cyan)', flexShrink: 0, marginLeft: 12,
            }}>→</span>
          </div>
        </div>
      </div>

      {/* Personal-plan creation sheet — opened by the "Criar um evento
          com amigos" CTA above. Same component Events.jsx mounts; both
          surfaces converge on the same backend POST /events/personal. */}
      <PersonalPlanSheet
        open={showPlanSheet}
        onClose={() => setShowPlanSheet(false)}
        googleId={state.googleUser?.id}
        onCreated={(event) => {
          // Backend auto-RSVPs the creator into the rsvps table; mirror
          // it client-side so My RSVPs picks up the new plan without a
          // refetch.
          if (event?.id) {
            dispatch({
              type: 'TOGGLE_RSVP',
              payload: {
                eventId: event.id,
                name: event.name,
                venue: event.venue,
                dateStart: event.date_start,
              },
            })
          }
          // Refresh the user's group/personal-plan feed so the new
          // event surfaces in pending/upcoming sections of Home.
          const gid = state.googleUser?.id
          if (gid) fetchUserGroupEvents(gid).then(events => {
            const now = Date.now()
            const accepted = []
            for (const ev of (events || [])) {
              const tt = ev.dateStart ? Date.parse(ev.dateStart) : NaN
              if (Number.isNaN(tt) || tt <= now) continue
              const norm = { ...ev, group_name: ev.groupName || ev.group_name || '' }
              if (state.rsvps[ev.id] || ev.id === event?.id) accepted.push(norm)
            }
            setGroupEventsAccepted(prev => {
              const ids = new Set(prev.map(e => e.id))
              return [...prev, ...accepted.filter(e => !ids.has(e.id))]
            })
          })
        }}
      />

      {/* Notification toast */}
      <AnimatePresence>
        {notifToast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.2 }}
            className="neon-card"
            style={{
              position: 'fixed', bottom: 90, left: 16, right: 16, zIndex: 300,
              padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 10,
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6), 0 0 24px rgba(198, 255, 0, 0.25)',
            }}
          >
            <span style={{ fontSize: 16, color: 'var(--lime)' }}>●</span>
            <div style={{ flex: 1 }}>
              <div className="neon-mono" style={{
                fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
                color: 'var(--lime)',
              }}>
                {t.home_notif_confirmed ?? 'Confirmado'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{notifToast}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}


// ── Pending invite row — Home page ─────────────────────────

function PendingInviteRow({ event: ev, onOpen, onAccept }) {
  const ds = ev.date_start || ev.dateStart || ''
  const dateLabel = formatFriendsFeedDate(ds)
  const venue = ev.group_name || ev.groupName || ev.venue || ''
  const isPlan = ev.isPersonalPlan
  return (
    <div
      onClick={onOpen}
      className="neon-card"
      style={{
        boxShadow: 'inset 3px 0 0 var(--magenta)',
        padding: '12px 14px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
        background: 'rgba(255, 43, 214, 0.10)',
        border: '1px solid rgba(255, 43, 214, 0.30)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--magenta)', fontSize: 18,
        textShadow: '0 0 10px rgba(255, 43, 214, 0.6)',
      }}>
        {isPlan ? '◆' : '◌'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="neon-display" style={{
          fontSize: 14, color: 'var(--text)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {ev.name}
        </div>
        <div className="neon-mono" style={{
          fontSize: 10, color: 'var(--text3)', marginTop: 4,
          letterSpacing: '0.06em',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {dateLabel}{venue ? ` · ${venue}` : ''}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onAccept() }}
        className="neon-mono"
        style={{
          background: 'transparent', border: '1px solid var(--lime)',
          color: 'var(--lime)',
          padding: '6px 12px', borderRadius: 999,
          fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
          cursor: 'pointer', flexShrink: 0,
        }}
      >
        ✓ ON
      </button>
    </div>
  )
}


// ── Formatters ─────────────────────────────────────────────

const _PT_WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const _PT_MONTHS   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']

function formatFriendsFeedDate(isoStr) {
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
