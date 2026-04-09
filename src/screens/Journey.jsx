import { useApp, computeCurrentWeek, getChapter } from '../context/AppContext'
import { useT } from '../i18n'
import { getFramework } from '../data/framework'

function getWeeklyCompanionMessage(week, chapter, situation, fallback) {
  const messages = {
    1:  'Você apareceu. Isso já é o suficiente por hoje.',
    2:  'Uma semana dentro. Seu sistema nervoso está aprendendo que é seguro.',
    3:  'Três semanas. Algo pequeno está mudando — você consegue sentir?',
    4:  'Agora é sobre consistência. Apareça, mesmo quando não tiver vontade.',
    5:  'Semana 5. Os mesmos lugares começam a parecer seus.',
    6:  'Metade da jornada. O que você notou sobre si mesmo até aqui?',
    7:  'Hora de expandir um pouco. Diga sim para algo que te assusta levemente.',
    8:  'Semana 8. Você está maior do que quando começou.',
    9:  'Falta pouco. O que antes parecia impossível agora é só improvável?',
    10: 'Dez semanas. A vida social não é mais um projeto — é só vida.',
    11: 'Quase lá. Como você está diferente de quando chegou?',
    12: 'Doze semanas. Você construiu algo real. Isso não some.',
  }
  return messages[week] ?? fallback
}

function bold(text) {
  const parts = text.split(/\*\*(.*?)\*\*/g)
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part
  )
}

export default function Journey() {
  const { state, dispatch } = useApp()
  const t = useT()
  const currentWeek = computeCurrentWeek(state.joinedAt)
  const chapter = getChapter(currentWeek)
  const framework = getFramework(currentWeek, state.userSituation)
  const alreadyRead = state.frameworkRead

  return (
    <div>
      {/* Header */}
      <div className="screen-header">
        <div className="screen-header__title">{t.journey_title}</div>
        <div className="screen-header__sub">
          {t.journey_framework_badge} {currentWeek} {t.journey_of} 12 {t.journey_sub}
        </div>
      </div>

      {/* Chapter card */}
      <div style={{ margin: '4px 16px 4px' }}>
        <div style={{
          background: chapter.pale,
          border: `1.5px solid ${chapter.color}22`,
          borderRadius: 18, padding: '14px 16px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: chapter.color }}/>
            <span style={{ fontSize: 11, fontWeight: 700, color: chapter.color, textTransform: 'uppercase', letterSpacing: 1 }}>
              {chapter.name}
            </span>
            <span style={{ fontSize: 11, color: 'var(--charcoal-mid)' }}>
              · {t.journey_of} {chapter.weeks[0]}–{chapter.weeks[chapter.weeks.length - 1]}
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.5 }}>
            {chapter.desc}
          </div>
          {/* Chapter progress bar */}
          <div style={{ marginTop: 10, height: 4, borderRadius: 2, background: `${chapter.color}22`, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${((currentWeek - chapter.weeks[0]) / chapter.weeks.length) * 100}%`,
              borderRadius: 2, background: chapter.color,
              transition: 'width 0.6s ease',
            }}/>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ fontSize: 9, color: 'var(--charcoal-light)' }}>W{chapter.weeks[0]}</span>
            <span style={{ fontSize: 9, color: 'var(--charcoal-light)' }}>W{chapter.weeks[chapter.weeks.length - 1]}</span>
          </div>
        </div>
      </div>

      {/* AI Companion message */}
      {(state.aiPartnerMessage || (currentWeek >= 1 && currentWeek <= 12)) && (
        <div style={{ margin: '8px 16px 0' }}>
          <div style={{
            background: 'linear-gradient(135deg, #1e2d2e 0%, #2C3A2D 100%)',
            borderRadius: 20, padding: '16px 18px',
            display: 'flex', gap: 12, alignItems: 'flex-start',
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, #7A9E7E, #9EC9A2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }}>🌿</div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: 'rgba(158,201,162,0.7)', marginBottom: 5 }}>
                {t.journey_companion_label}
              </div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.82)', lineHeight: 1.6 }}>
                {getWeeklyCompanionMessage(currentWeek, chapter, state.userSituation, state.aiPartnerMessage)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hero card */}
      <div style={{
        margin: '10px 16px 0',
        background: `linear-gradient(135deg, ${chapter.color} 0%, ${chapter.color}bb 100%)`,
        borderRadius: 24, padding: 24, color: 'white',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', right: -20, bottom: -20,
          width: 120, height: 120, borderRadius: '50%',
          background: 'rgba(255,255,255,0.07)', pointerEvents: 'none',
        }}/>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'rgba(255,255,255,0.18)', padding: '4px 10px', borderRadius: 20,
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10,
        }}>
          📖 {t.journey_framework_badge} {currentWeek}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, marginBottom: 8 }}>
          {framework.title}
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.5 }}>
          {framework.subtitle}
        </div>
        <div style={{
          marginTop: 14, background: 'rgba(255,255,255,0.12)',
          borderRadius: 10, padding: '8px 12px',
          fontSize: 11, color: 'rgba(255,255,255,0.75)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          🛡️ {framework.methodology}
        </div>
      </div>

      {/* Reflection prompts */}
      <div className="section-label">{t.journey_prompts_label}</div>
      {framework.prompts.map(p => (
        <div key={p.num} style={{
          margin: '0 16px 10px', background: 'white',
          borderRadius: 16, padding: '15px 16px',
          boxShadow: 'var(--shadow-sm)', borderLeft: '3px solid var(--terra)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--terra)', marginBottom: 6 }}>
            {t.journey_prompt_prefix} {p.num}
          </div>
          <div style={{ fontSize: 14, color: 'var(--charcoal)', lineHeight: 1.6, fontWeight: 500 }}>
            {p.question}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 6 }}>
            💭 {p.hint}
          </div>
        </div>
      ))}

      {/* Reframe exercises */}
      <div className="section-label">{t.journey_reframes_label}</div>
      {framework.reframes.map((r, i) => (
        <div key={i} style={{
          margin: '0 16px 10px',
          background: 'linear-gradient(135deg, #2C2C2C, #3d2d25)',
          borderRadius: 16, padding: 18, color: 'white',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--terra-light)', marginBottom: 10 }}>
            {r.label}
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', marginBottom: 8, textDecoration: 'line-through' }}>
            {r.from}
          </div>
          <div style={{ fontSize: 20, marginBottom: 6, color: 'var(--terra-light)' }}>↓</div>
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{r.to}</div>
        </div>
      ))}

      {/* Actions */}
      <div className="section-label">{t.journey_actions_label}</div>
      {framework.actions.map(a => (
        <div key={a.step} style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          background: 'white', borderRadius: 14,
          padding: '13px 16px', margin: '0 16px 8px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%',
            background: 'var(--terra)', color: 'white',
            fontSize: 12, fontWeight: 700, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{a.step}</div>
          <div style={{ fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.55, paddingTop: 4 }}>
            {bold(a.text)}
          </div>
        </div>
      ))}

      {/* Methodology note */}
      <div style={{ margin: '12px 16px 0' }}>
        <div style={{
          background: 'white', borderRadius: 16, padding: '15px 16px',
          boxShadow: 'var(--shadow-sm)', borderLeft: '3px solid var(--sage)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--sage)', marginBottom: 6 }}>
            {t.journey_note_label}
          </div>
          <div style={{ fontSize: 13, color: 'var(--charcoal)', lineHeight: 1.6 }}>
            {bold(framework.note)}
          </div>
        </div>
      </div>

      {/* Mark as read */}
      <div style={{ padding: '20px 16px 0' }}>
        {alreadyRead ? (
          <div style={{
            textAlign: 'center', padding: '14px',
            background: 'var(--sage-pale)', borderRadius: 16,
            color: 'var(--sage)', fontSize: 14, fontWeight: 600,
          }}>
            {t.journey_completed_msg}
          </div>
        ) : (
          <button className="btn btn--sage" onClick={() => dispatch({ type: 'SET_FRAMEWORK_READ' })}>
            {t.journey_complete_btn}
          </button>
        )}
      </div>
      <div style={{ height: 16 }} />
    </div>
  )
}
