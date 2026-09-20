import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'

import { API_BASE } from '../lib/apiBase'
import { fetchNotifications } from '../services/api'
import { useIsDesktop } from '../lib/useIsDesktop'

// Bottom tab bar on phones; on a PC the same component renders as the left
// sidebar (layout in globals.css), with the auê wordmark on top and Perfil
// as its own item — on the phone Perfil lives behind the Home avatar.
export default function BottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { state } = useApp()
  const t = useT()
  const a11y = state.accessibilityMode
  const isDesktop = useIsDesktop()

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
  // Unread count for the Notificações badge. Derived server-side from
  // the same query the inbox renders, so the number on the tab and the
  // list behind it can't disagree.
  //
  // Refetched when the tab regains focus rather than polled: acting on
  // an item happens on another screen, and a badge still showing what
  // you just answered is how people learn to ignore it.
  const [unread, setUnread] = useState(0)
  const googleId = state.googleUser?.id

  useEffect(() => {
    if (!googleId) { setUnread(0); return }
    let cancelled = false
    const load = () => fetchNotifications(googleId, email)
      .then(d => { if (!cancelled) setUnread(d.unread_count || 0) })
    load()
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', load)
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
      document.removeEventListener('visibilitychange', load)
    }
  }, [googleId, email, pathname])

  const stroke = (active) => active ? 'var(--magenta)' : 'var(--text3)'
  const glowStyle = (active) => active
    ? { filter: 'drop-shadow(0 0 6px rgba(255, 43, 214, 0.7))' }
    : undefined

  // Home dissolved in Sep 2026. People opened the app wanting the
  // catalog and went to community second, so Eventos is the landing
  // screen and the tab bar is what's left once Home's pieces found
  // real homes: pendências and the digest card went to Notificações,
  // the friends feed to Comunidade, the week strip was already
  // duplicated inside Eventos, and the create-plan CTA already lived
  // in the Eventos header.
  //
  // RSVPs lost its slot too — it was a tab nobody used, and it belongs
  // next to friends and channels rather than beside the catalog.
  const NAV_ITEMS = [
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
    // On phones Perfil used to live behind the Home avatar. Home is
    // gone, so it needs a slot of its own everywhere.
    {
      path: '/profile',
      label: t.nav_profile ?? 'Perfil',
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          style={glowStyle(active)}
          stroke={stroke(active)}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4"/>
          <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1"/>
        </svg>
      ),
    },
    // Notificações sits at the end rather than beside Eventos. It's
    // where you go when the badge says to, not somewhere you browse —
    // and a count that pulses next to the catalog competes with the
    // thing people actually opened the app for.
    //
    // Labelled "Notificações", not "Avisos": "aviso" in pt-BR reads as
    // a warning, which is the wrong register for a friend invite.
    {
      path: '/notifications',
      label: 'Notificações',
      badge: unread,
      icon: (active) => (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
          style={glowStyle(active)}
          stroke={stroke(active)}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 01-3.46 0"/>
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
      {isDesktop && (
        <div className="nav-brand neon-display neon-glow-mag" onClick={() => navigate('/events')}>
          auê
        </div>
      )}
      {NAV_ITEMS.map(({ path, label, icon, badge }) => {
        const active = pathname === path || (path === '/admin/ig' && pathname.startsWith('/admin'))
        return (
          <div
            key={path}
            className={`nav-item${active ? ' nav-item--active' : ''}`}
            onClick={() => navigate(path)}
          >
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              {icon(active)}
              {/* Only ever a count of things that need YOU. Capped so a
                  backlog renders as "9+" instead of stretching the tab. */}
              {badge > 0 && (
                <span style={{
                  position: 'absolute', top: -5, right: -7,
                  minWidth: 16, height: 16, padding: '0 4px',
                  borderRadius: 8, background: 'var(--magenta)',
                  color: 'var(--bg)', fontSize: 10, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 0 8px rgba(255, 43, 214, 0.6)',
                }}>
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
            </span>
            <span className={
              'nav-item__label'
              + (a11y ? ' nav-item__label--a11y' : '')
              + (label.length > 10 ? ' nav-item__label--long' : '')
            }>{label}</span>
          </div>
        )
      })}
    </nav>
  )
}
