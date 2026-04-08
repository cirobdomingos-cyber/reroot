import { useApp } from '../context/AppContext'
import { FRAMEWORK } from '../data/framework'

function bold(text) {
  // Render **bold** markdown
  const parts = text.split(/\*\*(.*?)\*\*/g)
  return parts.map((part, i) =>
    i % 2 === 1
      ? <strong key={i}>{part}</strong>
      : part
  )
}

export default function Journey() {
  const { state, dispatch } = useApp()
  const alreadyRead = state.frameworkRead

  function handleMarkRead() {
    dispatch({ type: 'SET_FRAMEWORK_READ' })
  }

  return (
    <div>
      {/* Header */}
      <div className="screen-header">
        <div className="screen-header__title">Weekly Framework</div>
        <div className="screen-header__sub">Week {FRAMEWORK.week} of 12 · Updated every Monday</div>
      </div>

      {/* Hero card */}
      <div style={{
        margin: '8px 16px 0',
        background: 'linear-gradient(135deg, var(--sage) 0%, #5d8861 100%)',
        borderRadius: 24, padding: 24, color: 'white',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Decorative circle */}
        <div style={{
          position: 'absolute', right: -20, bottom: -20,
          width: 120, height: 120, borderRadius: '50%',
          background: 'rgba(255,255,255,0.07)',
          pointerEvents: 'none',
        }}/>

        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'rgba(255,255,255,0.18)',
          padding: '4px 10px', borderRadius: 20,
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8,
          marginBottom: 10,
        }}>
          📖 Week {FRAMEWORK.week} Framework
        </div>

        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, marginBottom: 8 }}>
          {FRAMEWORK.title}
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.5 }}>
          {FRAMEWORK.subtitle}
        </div>

        <div style={{
          marginTop: 14,
          background: 'rgba(255,255,255,0.12)',
          borderRadius: 10, padding: '8px 12px',
          fontSize: 11, color: 'rgba(255,255,255,0.75)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          🛡️ {FRAMEWORK.methodology}
        </div>
      </div>

      {/* ── Reflection prompts ── */}
      <div className="section-label">Reflection prompts</div>

      {FRAMEWORK.prompts.map(p => (
        <div
          key={p.num}
          style={{
            margin: '0 16px 10px',
            background: 'white',
            borderRadius: 16,
            padding: '15px 16px',
            boxShadow: 'var(--shadow-sm)',
            borderLeft: '3px solid var(--terra)',
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--terra)', marginBottom: 6 }}>
            Prompt {p.num}
          </div>
          <div style={{ fontSize: 14, color: 'var(--charcoal)', lineHeight: 1.6, fontWeight: 500 }}>
            {p.question}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 6 }}>
            {p.hint}
          </div>
        </div>
      ))}

      {/* ── Reframe exercises ── */}
      <div className="section-label">Reframe exercises</div>

      {FRAMEWORK.reframes.map((r, i) => (
        <div
          key={i}
          style={{
            margin: '0 16px 10px',
            background: 'linear-gradient(135deg, #2C2C2C, #3d2d25)',
            borderRadius: 16, padding: 18, color: 'white',
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--terra-light)', marginBottom: 10 }}>
            {r.label}
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 8, textDecoration: 'line-through' }}>
            {r.from}
          </div>
          <div style={{ fontSize: 20, marginBottom: 6 }}>↓</div>
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{r.to}</div>
        </div>
      ))}

      {/* ── Action steps ── */}
      <div className="section-label">This week's actions</div>

      {FRAMEWORK.actions.map(a => (
        <div
          key={a.step}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 12,
            background: 'white', borderRadius: 14,
            padding: '13px 16px', margin: '0 16px 8px',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div style={{
            width: 26, height: 26, borderRadius: '50%',
            background: 'var(--terra)', color: 'white',
            fontSize: 12, fontWeight: 700, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {a.step}
          </div>
          <div style={{ fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.55 }}>
            {bold(a.text)}
          </div>
        </div>
      ))}

      {/* ── Methodology note ── */}
      <div style={{ margin: '12px 16px 0' }}>
        <div style={{
          background: 'white', borderRadius: 16,
          padding: '15px 16px', boxShadow: 'var(--shadow-sm)',
          borderLeft: '3px solid var(--sage)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--sage)', marginBottom: 6 }}>
            A note from the methodology
          </div>
          <div style={{ fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.6 }}>
            {bold(FRAMEWORK.note)}
          </div>
        </div>
      </div>

      {/* ── Mark as read ── */}
      <div style={{ padding: '20px 16px 0' }}>
        {alreadyRead ? (
          <div style={{
            textAlign: 'center', padding: '14px',
            background: 'var(--sage-pale)', borderRadius: 16,
            color: 'var(--sage)', fontSize: 14, fontWeight: 600,
          }}>
            📖 Framework complete — Badge earned!
          </div>
        ) : (
          <button className="btn btn--sage" onClick={handleMarkRead}>
            Mark framework as complete
          </button>
        )}
      </div>
      <div style={{ height: 16 }} />
    </div>
  )
}
