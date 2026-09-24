import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'

// One photo viewer for the whole app. Tapping any person's <Avatar>
// opens their picture big, wherever it is — a friends list, "Quem vai",
// a group's members, the creator on an event. Mounted once in main.jsx;
// Avatar reaches it through useAvatarViewer(), so no screen has to wire
// anything to get the behavior.
//
// The provider value is the `open` function, null when there is no
// provider (an Avatar rendered outside the app tree just doesn't expand).

const AvatarViewerContext = createContext(null)

export function useAvatarViewer() {
  return useContext(AvatarViewerContext)
}

export function AvatarViewerProvider({ children }) {
  const [viewing, setViewing] = useState(null)   // { src, name } | null
  const open = useCallback((person) => setViewing(person), [])
  const close = useCallback(() => setViewing(null), [])

  return (
    <AvatarViewerContext.Provider value={open}>
      {children}
      <AvatarLightbox person={viewing} onClose={close} />
    </AvatarViewerContext.Provider>
  )
}

// Google account pictures come sized for a list row ("…=s96-c"). The
// same URL serves any size, so ask for one that fills a phone screen.
export function largePictureUrl(src) {
  if (!src) return ''
  return src.replace(/=s\d+(-c)?$/, '=s512-c')
}

function AvatarLightbox({ person, onClose }) {
  // Fall back from the large URL to the row-sized one the app already
  // shows: a source that isn't Google ignores the size suffix rewrite,
  // and a broken large URL shouldn't leave a black square.
  const [failedLarge, setFailedLarge] = useState(false)
  useEffect(() => { setFailedLarge(false) }, [person?.src])

  useEffect(() => {
    if (!person) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [person, onClose])

  const src = person && (failedLarge ? person.src : (largePictureUrl(person.src) || person.src))

  return createPortal(
    <AnimatePresence>
      {person && (
        <motion.div
          key="avatar-lightbox"
          role="dialog"
          aria-label={person.name || 'Foto'}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0,
            // Above every sheet (10501) and the detail drawer.
            zIndex: 20000,
            background: 'rgba(10, 4, 18, 0.88)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            padding: '24px 16px calc(24px + env(safe-area-inset-bottom, 0px))',
            cursor: 'zoom-out',
          }}
        >
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            style={{
              width: 'min(86vw, 420px)', aspectRatio: '1 / 1',
              borderRadius: 28, overflow: 'hidden',
              background: 'var(--magenta)',
              boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
            }}
          >
            {src ? (
              <img
                src={src}
                alt={person.name || 'Foto'}
                referrerPolicy="no-referrer"
                onError={() => { if (!failedLarge) setFailedLarge(true) }}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <div style={{
                width: '100%', height: '100%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'white', fontSize: 120, fontWeight: 700,
              }}>
                {(person.name || '?').trim().charAt(0).toUpperCase() || '?'}
              </div>
            )}
          </motion.div>
          {person.name && (
            <div style={{
              marginTop: 18, fontSize: 18, fontWeight: 700, color: '#F4ECFF',
              textAlign: 'center', maxWidth: '86vw',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {person.name}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(244,236,255,0.6)' }}>
            Toca pra fechar
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
