import { useNavigate, useLocation } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'

export default function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { state } = useApp()
  const t = useT()
  const a11y = state.accessibilityMode

  const NAV_ITEMS = [
    {
      path: '/home',
      label: t.nav_home,
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke={active ? 'var(--terra)' : 'var(--charcoal-light)'}
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
          stroke={active ? 'var(--terra)' : 'var(--charcoal-light)'}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8"  y1="2" x2="8"  y2="6"/>
          <line x1="3"  y1="10" x2="21" y2="10"/>
        </svg>
      ),
    },
    {
      path: '/groups',
      label: t.nav_groups,
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke={active ? 'var(--terra)' : 'var(--charcoal-light)'}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87"/>
          <path d="M16 3.13a4 4 0 010 7.75"/>
        </svg>
      ),
    },
    {
      path: '/journey',
      label: t.nav_journey,
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke={active ? 'var(--terra)' : 'var(--charcoal-light)'}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/>
          <path d="M2 12l10 5 10-5"/>
        </svg>
      ),
    },
    {
      path: '/profile',
      label: t.nav_profile,
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          stroke={active ? 'var(--terra)' : 'var(--charcoal-light)'}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
      ),
    },
  ]

  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map(({ path, label, icon }) => {
        const active = pathname === path
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
