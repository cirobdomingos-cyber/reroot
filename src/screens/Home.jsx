import { useNavigate } from 'react-router-dom'
import { useApp, computeCurrentWeek } from '../context/AppContext'
import { EVENTS } from '../data/events'

const MILESTONE_WEEKS = [1, 2, 3, 6, 9, 12]

// The 2 events prescribed this week
const PRESCRIBED_IDS = ['coffee', 'writing']

export default function Home() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()

  const currentWeek = computeCurrentWeek(state.joinedAt)
  const progressPct = Math.round((currentWeek / state.totalWeeks) * 100)

  const weekMilestones = MILESTONE_WEEKS.map(w => ({
    week: w,
    label: `W${w}`,
    state: w < currentWeek ? 'done' : w === currentWeek ? 'current' : 'future',
  }))
  const prescribedEvents = EVENTS.filter(e => PRESCRIBED_IDS.includes(e.id))

  // Social proof: events with cohort members going (excluding prescribed)
  const socialEvent = EVENTS.find(e => e.id === 'coffee')
  const rsvpCount = socialEvent
    ? socialEvent.cohortGoing.length + (state.rsvps['coffee'] ? 1 : 0)
    : 0

  return (
    <div>
      {/* Greeting */}
      <div style={{ padding: '14px 20px 4px' }}>
        <div style={{ fontSize: 13, color: 'var(--charcoal-mid)' }}>Good morning,</div>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--charcoal)' }}>
          {state.userName} 👋
        </div>
      </div>

      {/* ── Progress card ── */}
      <div style={{ margin: '8px 16px 12px' }} className="card card--dark">
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
          Your Journey
        </div>
        <div style={{ fontSize: 28, fontWeight: 700 }}>
          Week {currentWeek}{' '}
          <span style={{ fontSize: 15, fontWeight: 400, color: 'rgba(255,255,255,0.55)' }}>
            of {state.totalWeeks}
          </span>
        </div>

        {/* Progress bar */}
        <div style={{ margin: '14px 0 8px' }}>
          <div style={{
            height: 8, borderRadius: 4,
            background: 'rgba(255,255,255,0.15)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${progressPct}%`,
              borderRadius: 4,
              background: 'linear-gradient(90deg, var(--terra-light), var(--sage-light))',
              transition: 'width 0.8s ease',
            }}/>
          </div>

          {/* Milestones */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            {weekMilestones.map(m => (
              <div key={m.week} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: m.state === 'done' ? 'var(--sage-light)'
                    : m.state === 'current' ? 'var(--terra-light)'
                    : 'rgba(255,255,255,0.2)',
                  boxShadow: m.state === 'current' ? '0 0 0 3px rgba(232,149,109,0.3)' : 'none',
                }}/>
                <span style={{
                  fontSize: 10,
                  color: m.state === 'done' ? 'var(--sage-light)'
                    : m.state === 'current' ? 'var(--terra-light)'
                    : 'rgba(255,255,255,0.3)',
                }}>
                  {m.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 22, marginTop: 6 }}>
          {[
            { val: Object.values(state.rsvps).filter(Boolean).length, lbl: 'Events RSVP\'d' },
            { val: state.frameworkRead ? 1 : 0, lbl: 'Frameworks read' },
            { val: state.eventsAttended, lbl: 'Events attended' },
          ].map(({ val, lbl }) => (
            <div key={lbl}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{lbl}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Prescription ── */}
      <div className="section-label">Your prescription this week</div>
      <div style={{ margin: '0 16px 12px' }} className="card card--terra">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 18 }}>💊</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--charcoal)' }}>2 events · Week {currentWeek} protocol</div>
            <div style={{ fontSize: 11, color: 'var(--charcoal-mid)' }}>Curated for your re-entry stage</div>
          </div>
        </div>

        {prescribedEvents.map(ev => {
          const rsvped = !!state.rsvps[ev.id]
          const going = ev.cohortGoing.length + (rsvped ? 1 : 0)
          return (
            <div
              key={ev.id}
              onClick={() => navigate('/events')}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: 'white', borderRadius: 14, padding: '11px 14px',
                marginBottom: 8, cursor: 'pointer',
                boxShadow: 'var(--shadow-sm)',
                transition: 'transform 0.15s',
              }}
            >
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, background: ev.headerBg, flexShrink: 0,
              }}>
                {ev.icon}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>{ev.name}</div>
                <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
                  {ev.date} · {ev.time}
                </div>
              </div>
              <div style={{
                fontSize: 10, fontWeight: 700, color: 'var(--sage)',
                background: 'var(--sage-pale)', padding: '3px 8px', borderRadius: 8, flexShrink: 0,
              }}>
                {going === 0 ? 'Be first' : `${going} going`}
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Social proof ── */}
      <div className="section-label">Cohort activity</div>
      <div style={{ margin: '0 16px 12px' }} className="card">
        {/* Row 1 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="avatar-stack">
            {socialEvent?.cohortGoing.slice(0, 3).map(p => (
              <div key={p.name} className="avatar" style={{ background: p.color, width: 30, height: 30, fontSize: 11 }}>
                {p.initial}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.4 }}>
            <strong style={{ color: 'var(--charcoal)' }}>{rsvpCount} cohort members</strong> are going to Sunday Coffee Walk
          </div>
          <button
            className="btn btn--primary"
            style={{ width: 'auto', padding: '6px 14px', fontSize: 11, borderRadius: 10 }}
            onClick={() => {
              dispatch({ type: 'TOGGLE_RSVP', payload: { eventId: 'coffee' } })
            }}
          >
            {state.rsvps['coffee'] ? 'Going ✓' : 'RSVP'}
          </button>
        </div>

        <div className="divider"/>

        {/* Row 2 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="avatar" style={{ background: '#5B8DD9', width: 30, height: 30, fontSize: 11 }}>J</div>
          <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.4 }}>
            <strong style={{ color: 'var(--charcoal)' }}>Jamie</strong> just completed their Week 3 framework
          </div>
        </div>
      </div>

      {/* ── Framework teaser ── */}
      <div className="section-label">This week's framework</div>
      <div
        style={{ margin: '0 16px 16px', cursor: 'pointer' }}
        className="card card--sage"
        onClick={() => navigate('/journey')}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1,
            background: 'white', color: 'var(--sage)', padding: '3px 8px', borderRadius: 6,
          }}>
            AI Framework · Week {currentWeek}
          </span>
          <span style={{ fontSize: 18, color: 'var(--sage)' }}>→</span>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
          The Re-entry Ritual
        </div>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5 }}>
          Structured reflection + reframe exercises for showing up socially after a long pause.
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--sage)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
          🛡️ Generated with therapist-reviewed methodology
        </div>
      </div>
    </div>
  )
}
