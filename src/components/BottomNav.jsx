import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'

const API_BASE = import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV ? 'http://localhost:8000' : '')

export default function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { state } = useApp()
  const t = useT()
  const a11y = state.accessibilityMode

  // Founder status — the Curar tab is now founder-only (full admin
  // shell: handle CRUD, curators management, usage stats, feedback).
  // Regular curators access handle ADD via the Sources page instead, so
  // this tab is reserved for the deepest admin surface.
  const [isFounder, setIsFounder] = useState(false)
  const email = state.googleUser?.email

  useEffect(() => {
    if (!email) { setIsFounder(false); return }
    let cancelled = false
    fetch(`${API_BASE}/admin/curators?requesting_email=${encodeURIComponent(email)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) setIsFounder(!!data?.is_founder) })
      .catch(() => { if (!cancelled) setIsFounder(false) })
    return () => { cancelled = true }
  }, [email])

  // Neon Boteco active vs. inactive: active strokes magenta with a drop-
  // shadow glow filter; inactive strokes text3. Stroke is set via CSS var
  // resolution so we get the live theme color without re-reading the
  // value here.
  const stroke = (active) => active ? 'var(--magenta)' : 'var(--text3)'
  const glowStyle = (active) => active
    ? { filter: 'drop-shadow(0 0 6px rgba(255, 43, 214, 0.7))' }
    : undefined

  const NAV_ITEMS = [
    {
      path: '/home',
      label: t.nav_home,
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          style={glowStyle(active)}
          stroke={stroke(active)}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/>
          <path d="M9 21V12h6v9"/>
        </svg>
      ),
    },
    {
      path: '/events',
      label: t.nav_events,
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          style={glowStyle(active)}
          stroke={stroke(active)}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8"  y1="2" x2="8"  y2="6"/>
          <line x1="3"  y1="10" x2="21" y2="10"/>
        </svg>
      ),
    },
    {
      path: '/my-rsvps',
      label: 'RSVPs',
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          style={glowStyle(active)}
          stroke={stroke(active)}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4"/>
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
        </svg>
      ),
    },
    {
      path: '/community',
      label: t.nav_community,
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          style={glowStyle(active)}
          stroke={stroke(active)}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87"/>
          <path d="M16 3.13a4 4 0 010 7.75"/>
        </svg>
      ),
    },
    // Founder-only tab. Curators (non-founder) get a narrower 'add
    // handle' affordance on the Sources page; this tab is the full admin
    // shell. Rightmost slot when present (Profile lives behind the Home
    // avatar tap, not in this nav).
    isFounder && {
      path: '/admin/ig',
      label: 'Admin',
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          style={glowStyle(active)}
          stroke={stroke(active)}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l2.39 4.84L20 8l-4 3.9.94 5.5L12 14.77l-4.94 2.6L8 11.9 4 8l5.61-1.16L12 2z"/>
        </svg>
      ),
    },
  ].filter(Boolean)

  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map(({ path, label, icon }) => {
        const active = pathname === path || (path === '/admin/ig' && pathname.startsWith('/admin'))
        return (
          <div
            key={path}
            className={`nav-item${active ? ' nav-item--active' : ''}`}
            onClick={() => navigate(path)}
          >
            {icon(active)}
            <span className={`nav-item__label${a11y ? ' nav-item__label--a11y' : ''}`}>{label}</span>
          </div>
        )
      })}
    </nav>
  )
}
