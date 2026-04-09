import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getSyncStatus, onSyncStatusChange } from '../services/api'

/**
 * Floating toast that appears when cloud sync fails.
 * Auto-dismisses when sync recovers. Shows retry status.
 *
 * Design: non-blocking — appears at the top, doesn't cover navigation.
 * The user knows their data is local-only and can keep using the app.
 */
export default function SyncStatus({ lang = 'pt' }) {
  const [status, setStatus] = useState(getSyncStatus)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    return onSyncStatusChange((s) => {
      setStatus(s)
      // Auto-show again if a new failure happens after user dismissed
      if (!s.ok) setDismissed(false)
    })
  }, [])

  const show = !status.ok && !dismissed
  const isPt = lang === 'pt'

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: -60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -60, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          style={{
            position: 'fixed', top: 48, left: 16, right: 16,
            zIndex: 200,
            background: '#FFF3E0',
            border: '1.5px solid #FFB74D',
            borderRadius: 14,
            padding: '10px 14px',
            display: 'flex', alignItems: 'center', gap: 10,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          }}
        >
          <span style={{ fontSize: 18 }}>
            {status.retrying ? '🔄' : '⚠️'}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#E65100' }}>
              {status.retrying
                ? (isPt ? 'Tentando salvar...' : 'Retrying save...')
                : (isPt ? 'Salvamento na nuvem falhou' : 'Cloud save failed')
              }
            </div>
            <div style={{ fontSize: 11, color: '#BF360C', marginTop: 2 }}>
              {isPt
                ? 'Seus dados estao salvos localmente. Vamos tentar de novo.'
                : 'Your data is saved locally. We\'ll keep trying.'
              }
            </div>
          </div>
          <button
            onClick={() => setDismissed(true)}
            style={{
              width: 28, height: 28, borderRadius: '50%',
              border: 'none', background: '#FFE0B2', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, color: '#E65100', flexShrink: 0,
            }}
          >
            ×
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
