import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * Listens for `badge-unlocked` window CustomEvents (fired by api.js after
 * an action that earned a badge) and shows a celebratory toast at the
 * bottom of the screen. Multiple unlocks queue and play one after another.
 *
 * Mounted once at the App level — any screen action that hits a write
 * endpoint can earn a badge, so the listener has to live above the route.
 *
 * Event detail: full badge object {id, label, emoji, desc, instance?, tier, ...}
 * — backend already composes the display label (e.g. "Local da casa II em
 * Café Lucca"); we layer on the metallic gradient/name (Bronze · Prata ·
 * Ouro · Platina) when a tier ladder is involved so the toast doesn't
 * read identical for tier I and tier IV.
 */

// Mirror of TIER_TONE in screens/Profile.jsx — duplicated locally so this
// component stays standalone (not a deep dep on Profile internals).
const TIER_TONE = {
  1: { name: 'Bronze',  color: '#B87333', gradient: 'linear-gradient(135deg, #DA9863 0%, #8B5A2B 100%)' },
  2: { name: 'Prata',   color: '#8B8B8B', gradient: 'linear-gradient(135deg, #E5E5E5 0%, #6F6F6F 100%)' },
  3: { name: 'Ouro',    color: '#D4A017', gradient: 'linear-gradient(135deg, #FFE680 0%, #B88500 100%)' },
  4: { name: 'Platina', color: '#7C8FA3', gradient: 'linear-gradient(135deg, #C8D4DE 0%, #5A748A 100%)' },
}
const TIER_NUMERAL = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' }

export default function BadgeUnlockToast() {
  const navigate = useNavigate()
  const [queue, setQueue] = useState([])     // pending badge objects
  const [current, setCurrent] = useState(null) // currently-shown badge object

  // Clicking the toast takes the user to /profile and pre-opens the
  // detail modal for the badge they just earned. The modal carries the
  // tier ladder + medal styling, so it doubles as an "intro to the
  // achievement system" without needing a separate tutorial.
  function openInProfile() {
    if (current?.base_id) {
      navigate('/profile', { state: { openBadge: current.base_id } })
    }
    setCurrent(null)
  }

  useEffect(() => {
    function onUnlock(ev) {
      const badge = ev?.detail
      if (!badge || typeof badge !== 'object' || !badge.label) return
      setQueue(prev => [...prev, badge])
    }
    window.addEventListener('badge-unlocked', onUnlock)
    return () => window.removeEventListener('badge-unlocked', onUnlock)
  }, [])

  // Drain queue: when there's no current toast and queue has items, pop one.
  useEffect(() => {
    if (current || queue.length === 0) return
    const [next, ...rest] = queue
    setCurrent(next)
    setQueue(rest)
    // Auto-dismiss after 4s
    const tid = setTimeout(() => setCurrent(null), 4000)
    return () => clearTimeout(tid)
  }, [queue, current])

  // Tone selection — only when the badge has a tier > 0 and a known tone.
  // Otherwise fall back to the warm honey gradient that matched the
  // pre-tier toast design.
  const tone = current && current.tier > 0 ? TIER_TONE[current.tier] : null

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          key={current.id}
          initial={{ opacity: 0, y: 24, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.95 }}
          transition={{ type: 'spring', damping: 22, stiffness: 280 }}
          onClick={openInProfile}
          style={{
            position: 'fixed', bottom: 90, left: 16, right: 16,
            background: 'linear-gradient(135deg, #FFF4E5 0%, #FFE6C7 100%)',
            border: `1.5px solid ${tone ? tone.color : '#E8A93F'}`,
            color: 'var(--charcoal)',
            borderRadius: 16, padding: '14px 16px',
            display: 'flex', alignItems: 'center', gap: 14,
            boxShadow: tone
              ? `0 12px 32px ${tone.color}55`
              : '0 12px 32px rgba(232, 169, 63, 0.35)',
            zIndex: 400, cursor: 'pointer',
          }}
        >
          <div style={{
            fontSize: 32, lineHeight: 1, flexShrink: 0,
            position: 'relative',
          }}>
            {current.emoji}
            {tone && (
              <span style={{
                position: 'absolute', bottom: -4, right: -8,
                fontSize: 8, fontWeight: 800,
                background: tone.gradient, color: 'white',
                padding: '2px 5px', borderRadius: 4,
                letterSpacing: 0.5, lineHeight: 1,
                textShadow: '0 1px 1px rgba(0,0,0,0.25)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }}>{TIER_NUMERAL[current.tier] || current.tier}</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 11, fontWeight: 800, letterSpacing: 1,
              textTransform: 'uppercase',
              color: tone ? tone.color : '#B8761F',
              marginBottom: 2,
            }}>
              {tone
                ? (current.previous_tier > 0 ? `Subiu pra ${tone.name}` : `${tone.name} desbloqueada`)
                : 'Conquista desbloqueada'}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.2 }}>
              {current.label}
            </div>
            <div style={{
              fontSize: 12, color: 'var(--charcoal-mid)',
              marginTop: 2, lineHeight: 1.35,
            }}>{current.desc}</div>
            <div style={{
              fontSize: 11, fontWeight: 600,
              color: tone ? tone.color : '#B8761F',
              marginTop: 6,
            }}>Toque pra ver →</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
