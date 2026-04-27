import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * Listens for `badge-unlocked` window CustomEvents (fired by api.js after
 * an action that earned a badge) and shows a celebratory toast at the
 * bottom of the screen. Multiple unlocks queue and play one after another.
 *
 * Mounted once at the App level — any screen action that hits a write
 * endpoint can earn a badge, so the listener has to live above the route.
 *
 * Event detail: full badge object {id, label, emoji, desc, instance?, ...}
 * — backend already composes the display label (e.g. "Local da casa em
 * Café Lucca"), no catalog lookup needed here.
 */
export default function BadgeUnlockToast() {
  const [queue, setQueue] = useState([])     // pending badge objects
  const [current, setCurrent] = useState(null) // currently-shown badge object

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

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          key={current.id}
          initial={{ opacity: 0, y: 24, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.95 }}
          transition={{ type: 'spring', damping: 22, stiffness: 280 }}
          onClick={() => setCurrent(null)}
          style={{
            position: 'fixed', bottom: 90, left: 16, right: 16,
            background: 'linear-gradient(135deg, #FFF4E5 0%, #FFE6C7 100%)',
            border: '1.5px solid #E8A93F',
            color: 'var(--charcoal)',
            borderRadius: 16, padding: '14px 16px',
            display: 'flex', alignItems: 'center', gap: 14,
            boxShadow: '0 12px 32px rgba(232, 169, 63, 0.35)',
            zIndex: 400, cursor: 'pointer',
          }}
        >
          <div style={{
            fontSize: 32, lineHeight: 1, flexShrink: 0,
          }}>{current.emoji}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 11, fontWeight: 800, letterSpacing: 1,
              textTransform: 'uppercase', color: '#B8761F',
              marginBottom: 2,
            }}>Conquista desbloqueada</div>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.2 }}>
              {current.label}
            </div>
            <div style={{
              fontSize: 12, color: 'var(--charcoal-mid)',
              marginTop: 2, lineHeight: 1.35,
            }}>{current.desc}</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
