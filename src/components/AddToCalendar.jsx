import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { generateICS, getGoogleCalendarURL } from '../lib/calendar'

function GoogleIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}

export default function AddToCalendar({ event, style }) {
  const [open, setOpen] = useState(false)

  function handleGoogle() {
    window.open(getGoogleCalendarURL(event), '_blank', 'noopener')
    setOpen(false)
  }

  function handleICS() {
    generateICS(event)
    setOpen(false)
  }

  function handleWhatsApp() {
    const link = event.url || 'reroot.app'
    const msg = `Vou ao ${event.name} no ${event.venue}! 🌿 Você topa também? ${link}`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener')
    setOpen(false)
  }

  return (
    <>
      {/* Single-tap trigger */}
      <button
        onClick={() => setOpen(true)}
        style={{
          width: 32, height: 32, borderRadius: 10, flexShrink: 0,
          background: 'var(--terra-pale)', color: 'var(--terra)',
          fontSize: 15, border: 'none', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          WebkitTapHighlightColor: 'transparent',
          ...style,
        }}
        title="Compartilhar"
      >
        📤
      </button>

      {/* Bottom sheet overlay */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setOpen(false)}
              style={{
                position: 'fixed', inset: 0,
                background: 'rgba(0,0,0,0.35)',
                zIndex: 200,
              }}
            />
            {/* Sheet */}
            <motion.div
              key="sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 350 }}
              style={{
                position: 'fixed', bottom: 0, left: 0, right: 0,
                background: 'white',
                borderRadius: '20px 20px 0 0',
                padding: '8px 16px 28px',
                zIndex: 201,
              }}
            >
              {/* Drag handle */}
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
              </div>

              {/* Event name context */}
              <div style={{
                fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
                marginBottom: 14, textAlign: 'center',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {event.icon} {event.name}
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <SheetButton
                  icon={<GoogleIcon size={20} />}
                  label="Google Calendar"
                  onClick={handleGoogle}
                />
                <SheetButton
                  icon={<span style={{ fontSize: 18 }}>📅</span>}
                  label="Baixar .ics"
                  sublabel="Apple Calendar, Outlook"
                  onClick={handleICS}
                />
                <SheetButton
                  icon={<span style={{ fontSize: 18 }}>💬</span>}
                  label="WhatsApp"
                  sublabel="Convidar amigos"
                  onClick={handleWhatsApp}
                  accent="#25D366"
                />
              </div>

              {/* Close */}
              <button
                onClick={() => setOpen(false)}
                style={{
                  width: '100%', marginTop: 10, padding: '13px 0',
                  borderRadius: 14, border: '1.5px solid var(--border)',
                  background: 'none', fontSize: 14, fontWeight: 600,
                  color: 'var(--charcoal-mid)', cursor: 'pointer',
                }}
              >
                Voltar
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}

function SheetButton({ icon, label, sublabel, onClick, accent }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        width: '100%', padding: '13px 14px',
        borderRadius: 14, border: 'none', cursor: 'pointer',
        background: accent ? `${accent}12` : 'var(--cream)',
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 0.12s',
      }}
    >
      <div style={{ width: 24, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ flex: 1, textAlign: 'left' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: accent || 'var(--charcoal)' }}>
          {label}
        </div>
        {sublabel && (
          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>
            {sublabel}
          </div>
        )}
      </div>
      <span style={{ fontSize: 14, color: 'var(--charcoal-light)' }}>›</span>
    </button>
  )
}
