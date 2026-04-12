import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp, computeCurrentWeek, getChapter, getProfile } from '../context/AppContext'
import { useT } from '../i18n'
import { EVENTS } from '../data/events'
import { scheduleEventReminder } from '../lib/notifications'
import AddToCalendar from '../components/AddToCalendar'
import { fetchFriendsFeed, fetchGroups } from '../services/api'
import WeekCalendar from '../components/WeekCalendar'

function getGreetingKey() {
  const h = new Date().getHours()
  if (h < 12) return 'greeting_morning'
  if (h < 18) return 'greeting_afternoon'
  return 'greeting_evening'
}

export default function Home() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()

  const [notifToast, setNotifToast] = useState(null)
  const [friendsFeed, setFriendsFeed] = useState([])
  const [groupEventsPending, setGroupEventsPending] = useState([])
  const [groupEventsAccepted, setGroupEventsAccepted] = useState([])
  const [journeyOpen, setJourneyOpen] = useState(false)

  useEffect(() => {
    const googleId = state.googleUser?.id
    if (!googleId) return
    fetchFriendsFeed(googleId).then(events => {
      setFriendsFeed(events.filter(ev => ev.friends_going?.length > 0))
    })
    // Fetch group events — split into pending vs already RSVPd
    fetchGroups(googleId).then(groups => {
      const pending = []
      const accepted = []
      for (const g of groups) {
        if (g.next_event) {
          const ev = { ...g.next_event, group_name: g.name, group_id: g.id }
          if (state.rsvps[g.next_event.id]) {
            accepted.push(ev)
          } else {
            pending.push(ev)
          }
        }
      }
      setGroupEventsPending(pending)
      setGroupEventsAccepted(accepted)
    })
  }, [state.googleUser?.id])

  const currentWeek = computeCurrentWeek(state.joinedAt)
  const chapter = getChapter(currentWeek)
  const rsvpCount = Object.values(state.rsvps).filter(Boolean).length

  // Upcoming RSVPd events (future only)
  const now = Date.now()
  const upcomingRsvps = EVENTS.filter(ev =>
    state.rsvps[ev.id] && ev.dateStart && new Date(ev.dateStart).getTime() > now
  ).slice(0, 3)

  // Suggested events (not RSVPd, low pressure first)
  const profile = getProfile(state.userSituation)
  const priorityCats = profile?.priorityCategories ?? []
  const suggestedEvents = EVENTS
    .filter(ev => !state.rsvps[ev.id])
    .sort((a, b) => {
      const ai = priorityCats.indexOf(a.category)
      const bi = priorityCats.indexOf(b.category)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
    .slice(0, 3)

  // Post-event reconnect
  const reconnectEvent = EVENTS.find(ev =>
    state.rsvps[ev.id] && ev.dateStart && new Date(ev.dateStart).getTime() <= now
  )

  async function handleQuickRsvp(ev) {
    dispatch({ type: 'TOGGLE_RSVP', payload: { eventId: ev.id } })
    const ok = await scheduleEventReminder(ev)
    if (ok) {
      setNotifToast(ev.name)
      setTimeout(() => setNotifToast(null), 3000)
    }
  }

<<<<<<< Updated upstream
  function saveReflection() {
    if (!reflectWord.trim()) return
    dispatch({ type: 'SAVE_REFLECTION', payload: { word: reflectWord.trim() } })
    setReflectWord('')
    setShowReflectModal(false)
  }

  async function handleShare() {
    const text = `Semana ${currentWeek} no Reroot: ${state.eventsAttended} eventos, ${Object.values(state.rsvps).filter(Boolean).length} confirmados. Reconectando aos poucos. 🌿`
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Minha jornada no Reroot', text })
      } catch {
        // user cancelled or share failed
      }
    } else {
      // Fallback: copy to clipboard
      await navigator.clipboard.writeText(text)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 2000)
    }
  }

  const rsvpCount = Object.values(state.rsvps).filter(Boolean).length
  const showReflectNudge = rsvpCount > 0 && state.reflections.length === 0
  const daysLeft = daysUntilMonday()

  // Weekly check-in: show whenever current week > 1 and check-in not done yet
  const prevWeek = currentWeek - 1
  const showWeeklyCheckIn = currentWeek > 1 && !state.weeklyCheckIns?.[currentWeek] && !checkInDone
  const showPushPrompt = currentWeek > 1 && !state.pushOptedIn && !state.pushDismissed && !pushSuccess && 'PushManager' in window

  // Event-day banner: any RSVPd event tagged as this_week
  const thisWeekRsvp = EVENTS.find(ev => state.rsvps[ev.id] && ev.dateTag === 'this_week')

  // Post-event reconnect nudge: only for RSVPd events that have already started/passed
  const now = Date.now()
  const reconnectEvent = EVENTS.find(ev =>
    state.rsvps[ev.id] &&
    ev.dateStart &&
    new Date(ev.dateStart).getTime() <= now
  )

  // Pick 3 random-ish activities for "Ideias" section (rotate by week)
  const activitySlice = ACTIVITIES.slice((currentWeek - 1) % 3, ((currentWeek - 1) % 3) + 3)

  // Month-end card: show in first 10 days of the month if user joined over a week ago
  const joinedOverAWeek = state.joinedAt && (Date.now() - state.joinedAt) > 7 * 24 * 60 * 60 * 1000
  const showMonthEnd = joinedOverAWeek && !state.monthEndDismissed && new Date().getDate() <= 10

  // Milestone dots for progress bar
  const MILESTONE_WEEKS = [1, 2, 3, 6, 9, 12]
  const weekMilestones = MILESTONE_WEEKS.map(w => ({
    week: w, label: `W${w}`,
    state: w < currentWeek ? 'done' : w === currentWeek ? 'current' : 'future',
  }))

=======
>>>>>>> Stashed changes
  return (
    <div>
      {/* Greeting */}
      <div style={{ padding: '14px 20px 4px' }}>
        <div style={{ fontSize: 13, color: 'var(--charcoal-mid)' }}>{t[getGreetingKey()]},</div>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--charcoal)' }}>
          {state.userName || t.home_default_name} 👋
        </div>
      </div>

<<<<<<< Updated upstream
      {/* Chapter banner */}
      <div style={{ margin: '6px 16px 0' }}>
        <div style={{
          background: chapter.pale,
          border: `1.5px solid ${chapter.color}22`,
          borderRadius: 14, padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: chapter.color, flexShrink: 0,
          }}/>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: chapter.color }}>
              {profileCopy ? profileCopy.tag : t.home_chapter_label}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)', marginTop: 1 }}>
              {chapter.name} — {chapter.desc.split('.')[0]}.
            </div>
          </div>
        </div>
      </div>

      {/* Progress card */}
      <div style={{ margin: '8px 16px 12px' }} className="card card--dark">
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
          {t.home_journey_label}
        </div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>
          {t.home_week} {currentWeek}{' '}
          <span style={{ fontSize: 15, fontWeight: 400, color: 'rgba(255,255,255,0.55)' }}>
            {t.home_of} {state.totalWeeks}
          </span>
        </div>

        {/* Progress bar */}
        <div style={{ margin: '14px 0 8px' }}>
          <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${progressPct}%`, borderRadius: 4,
              background: `linear-gradient(90deg, ${chapter.color}, var(--sage-light))`,
              transition: 'width 0.8s ease',
            }}/>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            {weekMilestones.map(m => (
              <div key={m.week} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: m.state === 'done' ? 'var(--sage-light)'
                    : m.state === 'current' ? chapter.color
                    : 'rgba(255,255,255,0.2)',
                  boxShadow: m.state === 'current' ? `0 0 0 3px ${chapter.color}55` : 'none',
                }}/>
                <span style={{
                  fontSize: 10,
                  color: m.state === 'done' ? 'var(--sage-light)'
                    : m.state === 'current' ? chapter.color
                    : 'rgba(255,255,255,0.3)',
                }}>{m.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 22, marginTop: 6 }}>
          {[
            { val: rsvpCount, lbl: t.home_stat_rsvpd },
            { val: state.frameworkRead ? 1 : 0, lbl: t.home_stat_frameworks },
            { val: state.eventsAttended, lbl: t.home_stat_attended },
          ].map(({ val, lbl }) => (
            <div key={lbl}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{lbl}</div>
            </div>
          ))}
        </div>
=======
      {/* Quick stats bar */}
      <div style={{
        display: 'flex', gap: 8, margin: '8px 16px 14px', justifyContent: 'space-between',
      }}>
        {[
          { val: rsvpCount, lbl: t.home_stat_rsvpd, color: 'var(--sage)' },
          { val: state.eventsAttended ?? 0, lbl: t.home_stat_attended, color: 'var(--terra)' },
          { val: friendsFeed.length, lbl: t.home_stat_friends_going ?? 'Amigos vão', color: '#5B8DD9' },
        ].map(({ val, lbl, color }) => (
          <div key={lbl} style={{
            flex: 1, background: 'white', borderRadius: 14, padding: '12px 10px',
            textAlign: 'center', border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color }}>{val}</div>
            <div style={{ fontSize: 10, color: 'var(--charcoal-mid)', marginTop: 2 }}>{lbl}</div>
          </div>
        ))}
>>>>>>> Stashed changes
      </div>

      {/* Week Calendar */}
      <div className="section-label">{t.home_calendar_label ?? 'Seu calendário'}</div>
      <WeekCalendar
        rsvpEvents={[
          ...EVENTS.filter(ev => state.rsvps[ev.id] && ev.dateStart),
          ...groupEventsAccepted.map(ev => ({
            ...ev, dateStart: ev.date_start, icon: '👥',
            headerBg: 'linear-gradient(135deg, var(--sage-pale), #e8f0e9)',
            venue: ev.group_name,
          })),
        ]}
        groupEvents={groupEventsPending}
        language={state.language || 'pt'}
        onEventTap={(ev, type) => {
          if (type === 'group' && ev.group_id) navigate(`/groups/${ev.group_id}`)
          else navigate('/events', { state: { openEventId: ev.id } })
        }}
        onGroupRsvp={(ev) => {
          dispatch({ type: 'TOGGLE_RSVP', payload: { eventId: ev.id } })
          // Move from pending to accepted
          setGroupEventsPending(prev => prev.filter(e => e.id !== ev.id))
          setGroupEventsAccepted(prev => [...prev, ev])
        }}
      />

<<<<<<< Updated upstream
      {/* Social sharing privacy toggle */}
      {state.googleUser?.id && (
        <div style={{
          margin: '0 16px 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 14px',
          background: 'white',
          borderRadius: 12,
          border: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--charcoal-mid)' }}>
            Compartilhar minha agenda com amigos
          </span>
          <button
            onClick={() => dispatch({ type: 'SET_PRIVACY_OPTION', payload: { key: 'shareRsvps', value: !(state.privacy?.shareRsvps ?? state.shareRsvps) } })}
            style={{
              fontSize: 14,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
              color: (state.privacy?.shareRsvps ?? state.shareRsvps) ? 'var(--sage)' : 'var(--charcoal-mid)',
              fontWeight: 700,
            }}
            title={(state.privacy?.shareRsvps ?? state.shareRsvps) ? 'Clique para desativar' : 'Clique para ativar'}
          >
            {(state.privacy?.shareRsvps ?? state.shareRsvps) ? '✓' : '✗'}
          </button>
        </div>
      )}

      {/* Post-event reconnect card — surfaces PostEventAttendees to users who don't tap back into past events */}
=======
      {/* Post-event reconnect nudge */}
>>>>>>> Stashed changes
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
            {upcomingRsvps.map(ev => (
              <div key={ev.id} onClick={() => navigate('/events', { state: { openEventId: ev.id } })} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: 'white', borderRadius: 14, padding: '11px 14px',
                cursor: 'pointer', boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)',
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, background: ev.headerBg, flexShrink: 0,
                }}>{ev.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>{ev.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>{ev.date} · {ev.time}</div>
                </div>
                <AddToCalendar event={ev} />
              </div>
            ))}
          </div>
        </>
      )}

      {/* Friends activity feed */}
      {friendsFeed.length > 0 && state.privacy?.showInFriendSuggestions !== false && (
        <>
          <div className="section-label">{t.home_friends_going_label ?? 'Amigos também vão'}</div>
          <div style={{ margin: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {friendsFeed.slice(0, 3).map(ev => (
              <div key={ev.event_id} style={{
                background: 'white', borderRadius: 14, border: '1px solid var(--border)',
                padding: '10px 13px', display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {ev.event_name}
                  </div>
                  {ev.event_venue && (
                    <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>{ev.event_venue}</div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  {ev.friends_going.slice(0, 3).map((friend, i) => (
                    <img key={friend.name + i} src={friend.picture} alt={friend.name}
                      referrerPolicy="no-referrer"
                      style={{
                        width: 26, height: 26, borderRadius: '50%', border: '2px solid white',
                        marginLeft: i === 0 ? 0 : -8, objectFit: 'cover',
                      }}
                      onError={e => { e.currentTarget.style.display = 'none' }}
                    />
                  ))}
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--terra)', marginLeft: 6 }}>
                    {ev.friends_going.length} {t.friends_feed_going ?? 'vão'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

<<<<<<< Updated upstream
      {/* Activity ideas section */}
      <div className="section-label">{t.home_activities_label}</div>
      <div style={{ fontSize: 11, color: 'var(--charcoal-light)', margin: '-6px 16px 10px', lineHeight: 1.4 }}>
        {t.home_activities_sub}
      </div>
      {activitySlice.map(act => (
        <div key={act.id} style={{ margin: '0 16px 10px' }}>
          <div style={{
            background: 'white', borderRadius: 18, overflow: 'hidden',
            boxShadow: 'var(--shadow-sm)',
          }}>
            {/* Activity header strip */}
            <div style={{ height: 64, background: act.headerBg, position: 'relative', display: 'flex', alignItems: 'flex-end', padding: '0 14px 10px' }}>
              <span style={{ fontSize: 28 }}>{act.icon}</span>
              {act.soloFriendly && (
                <span style={{
                  position: 'absolute', top: 8, right: 10,
                  fontSize: 9, fontWeight: 700,
                  background: 'rgba(255,255,255,0.88)', color: 'var(--sage)',
                  padding: '3px 8px', borderRadius: 6,
                }}>
                  {t.home_activity_solo}
                </span>
              )}
            </div>
            {/* Activity body */}
            <div style={{ padding: '12px 14px 14px' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 2 }}>
                {act.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginBottom: 8 }}>
                📍 {act.address} · {act.when}
=======
      {/* Suggested events */}
      <div className="section-label">{t.home_suggested_label ?? 'Eventos para você'}</div>
      <div style={{ margin: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {suggestedEvents.map(ev => {
          const going = ev.cohortGoing.length
          return (
            <div key={ev.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: 'white', borderRadius: 14, padding: '11px 14px',
              boxShadow: 'var(--shadow-sm)', border: '1px solid var(--border)',
            }}>
              <div onClick={() => navigate('/events', { state: { openEventId: ev.id } })} style={{
                display: 'flex', alignItems: 'center', gap: 12, flex: 1, cursor: 'pointer',
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, background: ev.headerBg, flexShrink: 0,
                }}>{ev.icon}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>{ev.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>{ev.date} · {ev.time}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {going > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--sage)' }}>
                    {going} {t.home_going ?? 'vão'}
                  </span>
                )}
                <button
                  onClick={() => handleQuickRsvp(ev)}
                  style={{
                    padding: '6px 12px', borderRadius: 10, fontSize: 11,
                    fontWeight: 700, cursor: 'pointer', border: 'none',
                    background: 'var(--sage)', color: 'white',
                  }}
                >
                  {t.home_rsvp ?? 'Vou!'}
                </button>
>>>>>>> Stashed changes
              </div>
            </div>
          )
        })}
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
            background: 'linear-gradient(135deg, #C4724A 0%, #E08D5E 100%)',
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

      {/* Your Journey — collapsed, secondary */}
      <div style={{ margin: '0 16px 16px' }}>
        <div
          onClick={() => setJourneyOpen(o => !o)}
          style={{
            background: 'white', borderRadius: journeyOpen ? '16px 16px 0 0' : 16,
            padding: '14px 16px', cursor: 'pointer',
            border: '1px solid var(--border)',
            borderBottom: journeyOpen ? '1px dashed var(--border)' : '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🌿</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
                {t.home_journey_card_title ?? 'Sua Jornada'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--charcoal-mid)' }}>
                {t.home_week ?? 'Semana'} {currentWeek} · {chapter.name}
              </div>
            </div>
          </div>
          <motion.span
            animate={{ rotate: journeyOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            style={{ fontSize: 14, color: 'var(--charcoal-mid)' }}
          >
            ▼
          </motion.span>
        </div>

        <AnimatePresence>
          {journeyOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25 }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{
                background: 'white', borderRadius: '0 0 16px 16px',
                padding: '14px 16px', border: '1px solid var(--border)', borderTop: 'none',
              }}>
                {/* Progress bar */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--cream)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${Math.round((currentWeek / (state.totalWeeks || 12)) * 100)}%`,
                      borderRadius: 3, background: chapter.color, transition: 'width 0.8s ease',
                    }}/>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--charcoal-mid)', marginTop: 4 }}>
                    {t.home_week ?? 'Semana'} {currentWeek} {t.home_of ?? 'de'} {state.totalWeeks || 12}
                  </div>
                </div>

                {/* Stats */}
                <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
                  {[
                    { val: rsvpCount, lbl: t.home_stat_rsvpd },
                    { val: state.eventsAttended ?? 0, lbl: t.home_stat_attended },
                    { val: state.reflections?.length ?? 0, lbl: 'Reflexões' },
                  ].map(({ val, lbl }) => (
                    <div key={lbl}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--charcoal)' }}>{val}</div>
                      <div style={{ fontSize: 10, color: 'var(--charcoal-mid)' }}>{lbl}</div>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => navigate('/journey')}
                  style={{
                    width: '100%', padding: '11px', borderRadius: 12, fontSize: 13,
                    fontWeight: 600, cursor: 'pointer', border: 'none',
                    background: 'var(--sage)', color: 'white',
                  }}
                >
                  {t.home_framework_open ?? 'Abrir Jornada →'}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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
              <div style={{ fontSize: 12, fontWeight: 700 }}>{t.home_notif_confirmed ?? 'Lembrete agendado'}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 1 }}>{notifToast}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
