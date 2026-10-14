import { useState } from 'react'
import { SKINS, getSkin, setSkin } from '../lib/skins'

// Perfil → Visual: one row per skin, previewed with its own colours (bg,
// primary, secondary, yes) so the choice reads before it is tapped.
// Applies instantly and is remembered per device (src/lib/skins.js).
export default function SkinPicker({ t, lang }) {
  const [current, setCurrent] = useState(getSkin)

  return (
    <div style={{ margin: '0 16px 12px' }} className="card" data-testid="skin-picker">
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
        {t.profile_skin_label}
      </div>
      <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2, marginBottom: 12 }}>
        {t.profile_skin_hint}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} role="radiogroup" aria-label={t.profile_skin_label}>
        {SKINS.map((skin) => {
          const active = skin.id === current
          const s = skin.swatch
          return (
            <button
              key={skin.id}
              role="radio"
              aria-checked={active}
              data-skin-option={skin.id}
              onClick={() => setCurrent(setSkin(skin.id))}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
                background: s.bg,
                border: active ? `2px solid ${s.primary}` : `1px solid ${s.text3}`,
                boxShadow: active ? `0 0 14px ${s.primary}66` : 'none',
              }}
            >
              <span style={{ display: 'flex', gap: 4, flexShrink: 0 }} aria-hidden="true">
                {[s.primary, s.secondary, s.yes].map((c) => (
                  <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
                ))}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: s.text }}>
                  {skin.name}
                </span>
                <span style={{ display: 'block', fontSize: 11, color: s.text, opacity: 0.7, marginTop: 1 }}>
                  {skin.blurb[lang] || skin.blurb.pt}
                </span>
              </span>
              {active && (
                <span style={{ fontSize: 14, fontWeight: 700, color: s.yes }} aria-hidden="true">✓</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
