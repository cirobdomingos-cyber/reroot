import { useState } from 'react'
import { motion } from 'framer-motion'
import { useT } from '../i18n'
import Friends from './Friends'
import Groups from './Groups'

export default function Community() {
  const t = useT()
  const [tab, setTab] = useState('friends') // 'friends' | 'groups'

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
          {['friends', 'groups'].map(key => {
            const active = tab === key
            const label = key === 'friends' ? t.community_tab_friends : t.community_tab_groups
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 11,
                  border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600,
                  background: active ? 'white' : 'transparent',
                  color: active ? 'var(--terra)' : 'var(--charcoal-mid)',
                  boxShadow: active ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                  transition: 'all 0.2s',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Content */}
      <motion.div
        key={tab}
        initial={{ opacity: 0, x: tab === 'friends' ? -12 : 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.18 }}
      >
        {tab === 'friends' ? <FriendsInline /> : <GroupsInline />}
      </motion.div>
    </div>
  )
}

// Render Friends content without its own header (Community provides the header)
function FriendsInline() {
  return <Friends embedded />
}

function GroupsInline() {
  return <Groups embedded />
}
