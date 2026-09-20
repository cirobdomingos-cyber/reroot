import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useT } from '../i18n'
import Friends from './Friends'
import Groups from './Groups'
import MyRsvps from './MyRsvps'
import FriendsFeed from '../components/FriendsFeed'
import ChannelList from '../components/ChannelList'

export default function Community() {
  const t = useT()
  // Callers can deep-link a sub-tab — navigate('/community', { state: { tab: 'friends' } }).
  // Home's friend-request notice uses it so the aviso lands on the list
  // that has the Aceitar buttons instead of on Canais.
  const location = useLocation()
  // 'groups' (canais) | 'friends' | 'rsvps'
  //
  // RSVPs moved in here when it lost its own tab (Sep 2026). It was the
  // least-used slot in the bar, and "what I said I'd go to" belongs
  // next to the people and channels it came from rather than beside
  // the catalog.
  const [tab, setTab] = useState(() => {
    const requested = location.state?.tab
    return ['friends', 'rsvps'].includes(requested) ? requested : 'groups'
  })

  return (
    <div>
      {/* Header */}
      <div style={{ padding: '16px 16px 0' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', margin: '0 0 12px' }}>
          {t.nav_community}
        </h1>

        {/* Tab switcher */}
        <div style={{
          display: 'flex', gap: 4, padding: 3,
          background: 'var(--cream)', borderRadius: 14,
          border: '1px solid var(--border)',
        }}>
          {['groups', 'friends', 'rsvps'].map(key => {
            const active = tab === key
            const label = key === 'friends' ? t.community_tab_friends
              : key === 'rsvps' ? 'Meus rolês'
              : t.community_tab_groups
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 11,
                  border: 'none', cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
                  background: active ? 'var(--magenta)' : 'transparent',
                  color: active ? 'var(--bg)' : 'var(--text2)',
                  boxShadow: active ? '0 0 18px rgba(255, 43, 214, 0.35)' : 'none',
                  transition: 'all 0.2s',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Where friends are going — first thing on the tab, above both
          sub-tabs, since it's the only part of Community that changes
          day to day. Hidden when empty. */}
      {tab !== 'rsvps' && <FriendsFeed />}

      {/* Content */}
      <motion.div
        key={tab}
        initial={{ opacity: 0, x: tab === 'groups' ? -12 : 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.18 }}
      >
        {tab === 'friends' && <FriendsInline />}
        {tab === 'rsvps' && <MyRsvps embedded />}
        {tab === 'groups' && (
          <>
            {/* Channels sit above your own ones, not mixed into them.
                They're a different relationship — you follow an auê
                channel, you don't join it — and the list hides itself
                when empty. */}
            {/* One list: Seguindo (auê channels you follow + your own
                private ones) and Explorar. "Meus canais" used to be a
                third section, which split one idea — channels in your
                life — by who happened to create them. */}
            <ChannelList />
            <GroupsInline />
          </>
        )}
      </motion.div>
    </div>
  )
}

// Render Friends content without its own header (Community provides the header)
function FriendsInline() {
  return <Friends embedded />
}

// Actions only — Entrar / + Criar canal and their sheets. The rows
// live in ChannelList now.
function GroupsInline() {
  return <Groups embedded actionsOnly />
}
