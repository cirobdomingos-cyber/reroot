import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useApp, PROFILES } from '../context/AppContext'
import { useT } from '../i18n'
import { scheduleEventReminder } from '../lib/notifications'
import AddToCalendar from '../components/AddToCalendar'
import { fetchEvents, fetchFriendsFeed, fetchGroups, fetchUserGroupEvents, syncRsvp } from '../services/api'
import WeekCalendar from '../components/WeekCalendar'
import Avatar from '../components/Avatar'

function getGreetingKey() {
  const h = new Date().getHours()
  if (h < 12) return 'greeting_morning'
  if (h < 18) return 'greeting_afternoon'
  return 'greeting_evening'
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
  const [friendsFeed, setFriendsFeed] = useState([])
  const [groupEventsPending, setGroupEventsPending] = useState([])
  const [groupEventsAccepted, setGroupEventsAccepted] = useState([])
  // Live event catalog — fetched from backend instead of using the stale
  // static EVENTS array. Drives suggestions, RSVP cards, and reconnect.
  const [allEvents, setAllEvents] = useState([])

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

  // "Amigos vão" tile — counts UNIQUE friends across all upcoming events
  // (not the number of events). User-facing label says "amigos", so the
  // count should match the noun: 2 friends going to 5 events = "2", not "5".
  const uniqueFriendsCount = (() => {
    const seen = new Set()
    for (const ev of friendsFeed) {
      for (const f of (ev.friends_going || [])) {
        if (f.google_id) seen.add(f.google_id)
      }
    }
    return seen.size
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

  // upcomingRsvps below is used for the "Seus próximos eventos" card —
  // there we DO need full event metadata, so we fall back to allEvents.
  const upcomingRsvps = allEvents.filter(ev =>
    state.rsvps[ev.id] && ev.dateStart && new Date(ev.dateStart).getTime() > now
  )

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

  // Post-event reconnect — the most recent past RSVP (if any)
  const reconnectEvent = allEvents.find(ev =>
    state.rsvps[ev.id] && ev.dateStart && new Date(ev.dateStart).getTime() <= now
  )

  async function handleQuickRsvp(ev) {
    dispatch({
      type: 'TOGGLE_RSVP',
      payload: { eventId: ev.id, dateStart: ev.dateStart, name: ev.name, venue: ev.venue },
    })
    const ok = await scheduleEventReminder(ev)
    if (ok) {
      setNotifToast(ev.name)
      setTimeout(() => setNotifToast(null), 3000)
    }
  }

  return (
    <div>
      {/* Brand + avatar. Home is the anchor screen, so we lead with the
          "auê" wordmark (sage, mirrors the Onboarding mark) and tuck the
          greeting into a secondary line. The avatar shortcuts to Profile —
          replaces the old Perfil bottom-nav tab. */}
      <div style={{ padding: '14px 20px 4px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, marginBottom: 6,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
            <div style={{
              fontSize: 32, fontWeight: 800, letterSpacing: -0.8,
              color: 'var(--sage)', lineHeight: 1,
            }}>
              auê
            </div>
            <div style={{
              fontSize: 9, fontWeight: 700, color: 'var(--charcoal-light)',
              textTransform: 'uppercase', letterSpacing: 1.5,
              whiteSpace: 'nowrap',
            }}>
              Curitiba que acontece
            </div>
          </div>
          <button
            onClick={() => navigate('/profile')}
            aria-label={t.nav_profile ?? 'Perfil'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 0, flexShrink: 0,
              borderRadius: '50%',
            }}
          >
            <Avatar
              src={state.googleUser?.picture}
              name={state.userName || state.googleUser?.givenName || state.googleUser?.name}
              size={40}
            />
          </button>
        </div>
        <div style={{
          fontSize: 13, color: 'var(--charcoal-mid)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {t[getGreetingKey()]}, <span style={{ color: 'var(--charcoal)', fontWeight: 700 }}>
            {state.userName || t.home_default_name}
          </span> 👋
        </div>
      </div>

      {/* Quick stats bar — both tiles route to /my-rsvps (RSVPs tab),
          which now shows the user's RSVPs *and* friends' upcoming RSVPs
          in one place. */}
      <div style={{
        display: 'flex', gap: 8, margin: '8px 16px 14px', justifyContent: 'space-between',
      }}>
        {[
          {
            val: rsvpCount, lbl: t.home_stat_rsvpd, color: 'var(--sage)',
            onTap: rsvpCount > 0 ? () => navigate('/my-rsvps') : null,
          },
          {
            val: uniqueFriendsCount, lbl: t.home_stat_friends_going ?? 'Amigos vão', color: '#5B8DD9',
            onTap: uniqueFriendsCount > 0 ? () => navigate('/my-rsvps') : null,
          },
        ].map(({ val, lbl, color, onTap }) => (
          <div
            key={lbl}
            onClick={onTap || undefined}
            style={{
              flex: 1, background: 'white', borderRadius: 14, padding: '12px 10px',
              textAlign: 'center', border: '1px solid var(--border)',
              cursor: onTap ? 'pointer' : 'default',
              transition: 'transform 0.1s',
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, color }}>{val}</div>
            <div style={{ fontSize: 10, color: 'var(--charcoal-mid)', marginTop: 2 }}>{lbl}</div>
          </div>
        ))}
      </div>

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
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
            >
              <span>
                {t.home_pending_label ?? 'Convites pendentes'} · {groupEventsPending.length}
              </span>
              <span style={{ fontSize: 11, color: 'var(--charcoal-light)', fontWeight: 600 }}>
                {t.home_see_all ?? 'Ver tudo'} →
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px', marginBottom: 14 }}>
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
                  style={{
                    background: 'transparent', border: '1px dashed var(--border)',
                    borderRadius: 12, padding: '9px 12px',
                    fontSize: 12, fontWeight: 600, color: 'var(--charcoal-mid)',
                    cursor: 'pointer',
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
      <div className="section-label">{t.home_calendar_label ?? 'Seu calendário'}</div>
      <WeekCalendar
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
        language={state.language || 'pt'}
        onEventTap={(ev, type) => {
          if ((type === 'group' || ev._isGroup) && ev.group_id) {
            navigate(`/groups/${ev.group_id}`)
          } else {
            navigate('/events', { state: { openEventId: ev.id } })
          }
        }}
        onGroupRsvp={handleAcceptInvite}
        onDayClick={(dayIso) => {
          // Tap a day in the calendar → jump to the Events tab with
          // that day pre-selected on the week strip. Easier than
          // scrolling the home calendar's events list, and keeps
          // discovery in the surface that's built for it.
          navigate('/events', { state: { openDay: dayIso } })
        }}
      />

      {/* Post-event reconnect nudge */}
      {reconnectEvent && (
        <div
          style={{
            margin: '0 16px 12px', background: 'var(--sage-pale)', borderRadius: 16,
            padding: '14px 16px', border: '1px solid rgba(122,158,126,0.25)', cursor: 'pointer',
          }}
          onClick={() => navigate('/events', { state: { openEventId: reconnectEvent.id } })}
        >
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--sage)', marginBottom: 4 }}>
            🤝 {t.home_reconnect_label ?? 'Você foi ao evento?'}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
            {reconnectEvent.name}
          </div>
          <div style={{ fontSize: 12, color: 'var(--charcoal-mid)' }}>
            {t.home_reconnect_cta ?? 'Veja quem esteve lá e conecte-se →'}
          </div>
        </div>
      )}

      {/* Upcoming RSVPs */}
      {upcomingRsvps.length > 0 && (
        <>
          <div className="section-label">{t.home_upcoming_label ?? 'Seus próximos eventos'}</div>
          <div style={{ margin: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {upcomingRsvps.slice(0, 3).map(ev => (
              <HomeEventRow
                key={ev.id}
                name={ev.name}
                dateStart={ev.dateStart}
                time={ev.time}
                venue={ev.venue}
                isRecurring={!!ev.isRecurring}
                isGroupEvent={!!ev.isGroupEvent}
                onClick={() => navigate('/events', { state: { openEventId: ev.id } })}
                trailing={<AddToCalendar event={ev} />}
              />
            ))}
          </div>
        </>
      )}

      {/* Friends activity feed — events friends are going to. Includes
          events the user hasn't RSVPd to yet, so it works as discovery
          ("oh, the gang is going to that"). Tap a row to open the event;
          tap the section header to see the full list in Community. */}
      {friendsFeed.length > 0 && state.privacy?.showInFriendSuggestions !== false && (
        <>
          <div
            className="section-label"
            onClick={() => navigate('/my-rsvps')}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <span>{t.home_friends_going_label ?? 'Amigos vão'}</span>
            <span style={{ fontSize: 11, color: 'var(--charcoal-light)', fontWeight: 600 }}>
              {t.home_see_all ?? 'Ver tudo'} →
            </span>
          </div>
          <div style={{ margin: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {friendsFeed.slice(0, 3).map(ev => {
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
                        <span style={{
                          fontSize: 9, fontWeight: 700,
                          padding: '2px 6px', borderRadius: 5,
                          background: 'var(--sage-pale)', color: 'var(--sage)',
                          letterSpacing: 0.3, marginRight: 8,
                          whiteSpace: 'nowrap',
                        }}>
                          VOCÊ TAMBÉM
                        </span>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        {ev.friends_going.slice(0, 3).map((friend, i) => (
                          <div
                            key={friend.name + i}
                            style={{
                              marginLeft: i === 0 ? 0 : -8,
                              boxShadow: '0 0 0 2px white',
                              borderRadius: '50%',
                            }}
                          >
                            <Avatar name={friend.name} src={friend.picture} size={24} />
                          </div>
                        ))}
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--terra)', marginLeft: 6 }}>
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
      )}

      {/* Suggested events */}
      <div className="section-label">{t.home_suggested_label ?? 'Eventos para você'}</div>
      <div style={{ margin: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            trailing={
              <button
                onClick={(e) => { e.stopPropagation(); handleQuickRsvp(ev) }}
                style={{
                  padding: '6px 12px', borderRadius: 10, fontSize: 11,
                  fontWeight: 700, cursor: 'pointer', border: 'none',
                  background: 'var(--sage)', color: 'white',
                }}
              >
                {t.home_rsvp ?? 'Vou!'}
              </button>
            }
          />
        ))}
        <button
          onClick={() => navigate('/events')}
          style={{
            width: '100%', padding: '12px', borderRadius: 14, fontSize: 13,
            fontWeight: 600, cursor: 'pointer', border: '1.5px solid var(--border)',
            background: 'none', color: 'var(--charcoal-mid)',
          }}
        >
          {t.home_see_all_events ?? 'Ver todos os eventos →'}
        </button>
      </div>

      {/* Community highlights */}
      <div className="section-label">{t.home_community_label ?? 'Comunidade'}</div>
      <div style={{ margin: '0 16px 12px' }}>
        <div
          onClick={() => navigate('/community')}
          style={{
            background: 'linear-gradient(135deg, #E8623F 0%, #F08869 100%)',
            borderRadius: 16, padding: '16px 18px', cursor: 'pointer',
            color: 'white',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                {t.home_community_cta ?? 'Amigos & Grupos'}
              </div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>
                {t.home_community_sub ?? 'Conecte-se com pessoas e entre em grupos'}
              </div>
            </div>
            <span style={{ fontSize: 24 }}>👥</span>
          </div>
        </div>
      </div>

      {/* Notification toast */}
      <AnimatePresence>
        {notifToast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.2 }}
            style={{
              position: 'fixed', bottom: 90, left: 16, right: 16, zIndex: 300,
              background: 'var(--charcoal)', color: 'white',
              borderRadius: 14, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            }}
          >
            <span style={{ fontSize: 18 }}>🔔</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{t.home_notif_confirmed ?? '🎉 Confirmado!'}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 1 }}>{notifToast}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}


// ── HomeEventRow — shared row layout for Home sections ─────────────────────
//
// Mirrors the Events tab EventCard: day number on the left (color-coded
// by kind), event name + single metadata row in the middle, optional
// trailing slot on the right (AddToCalendar, friend avatars, Vou button).
// Slimmer than EventCard since Home shows several sections side by side.

const _HOME_PT_WEEKDAY = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']

function _homeDayLabels(iso) {
  if (!iso) return { day: '—', weekday: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { day: '—', weekday: '' }
  return {
    day: String(d.getDate()).padStart(2, '0'),
    weekday: _HOME_PT_WEEKDAY[d.getDay()] || '',
  }
}

function HomeEventRow({
  name,
  dateStart,
  time,           // optional, "HH:MM"
  venue,          // pass already with " · bairro" if you have one
  isRecurring = false,
  isGroupEvent = false,
  trailing = null,
  onClick,
}) {
  const { day, weekday } = _homeDayLabels(dateStart)
  // Three distinct hues mirror EventCard:
  //   group → sage (orange in this palette)
  //   one-off → honey (amber)
  //   recurring → terra-light (medium blue, no stripe)
  const dayColor = isGroupEvent ? 'var(--sage)'
                 : isRecurring ? 'var(--terra-light)'
                 : 'var(--honey)'
  const stripe = isGroupEvent ? 'inset 3px 0 0 var(--sage)'
               : isRecurring ? 'none'
               : 'inset 3px 0 0 var(--honey)'
  return (
    <div
      onClick={onClick}
      style={{
        background: 'white', borderRadius: 12,
        border: '1px solid var(--border)',
        boxShadow: stripe,
        padding: '10px 13px',
        display: 'flex', alignItems: 'center', gap: 12,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{
        flexShrink: 0, width: 38, textAlign: 'left',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          fontSize: 22, fontWeight: 800, lineHeight: 1,
          color: dayColor, letterSpacing: -0.5,
        }}>
          {day}
        </div>
        <div style={{
          fontSize: 9, fontWeight: 700, marginTop: 2,
          color: 'var(--charcoal-mid)', letterSpacing: 1,
        }}>
          {weekday}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--charcoal)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {isGroupEvent && '🔒 '}
          {name}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {time}
          {time && venue && <> · </>}
          {venue}
        </div>
      </div>
      {trailing && (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {trailing}
        </div>
      )}
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
      style={{
        background: 'white', borderRadius: 14,
        border: '1px solid var(--border)',
        boxShadow: 'inset 4px 0 0 var(--terra)',
        padding: '10px 12px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 10,
      }}
    >
      <div style={{
        width: 38, height: 38, borderRadius: 11, flexShrink: 0,
        background: 'var(--terra-pale)', fontSize: 18,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {isPlan ? '🎲' : '👥'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {ev.name}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {dateLabel}{venue ? ` · ${venue}` : ''}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onAccept() }}
        style={{
          background: 'var(--terra)', color: 'white', border: 'none',
          padding: '7px 14px', borderRadius: 999,
          fontSize: 12, fontWeight: 700, cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Confirmar
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
