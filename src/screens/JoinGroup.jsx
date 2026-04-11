import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import { joinGroup } from '../services/api'

export default function JoinGroup() {
  const { inviteCode } = useParams()
  const { state } = useApp()
  const t = useT()
  const navigate = useNavigate()
  const googleId = state.googleUser?.id

  const [status, setStatus] = useState('loading') // loading | success | already | not_found | no_auth
  const [groupName, setGroupName] = useState('')

  useEffect(() => {
    if (!inviteCode) { setStatus('not_found'); return }
    if (!googleId) { setStatus('no_auth'); return }

    joinGroup(googleId, inviteCode).then(result => {
      if (result.status === 'ok') {
        setStatus('success')
        setGroupName(result.group?.name || '')
      } else if (result.status === 'already_member') {
        setStatus('already')
        setGroupName(result.group?.name || '')
      } else {
        setStatus('not_found')
      }
    }).catch(() => setStatus('not_found'))
  }, [inviteCode, googleId])

  const icons = { success: '🎉', already: '👥', not_found: '❌', loading: '⏳', no_auth: '🔒' }
  const messages = {
    success: t.groups_join_success,
    already: t.groups_join_already,
    not_found: t.groups_join_not_found,
    loading: t.events_loading,
    no_auth: 'Sign in to join this group',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', padding: 24 }}>
      <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>{icons[status]}</div>
        {groupName && (
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 8 }}>{groupName}</div>
        )}
        <p style={{ fontSize: 15, color: 'var(--charcoal-mid)', marginBottom: 24 }}>{messages[status]}</p>

        {(status === 'success' || status === 'already') && (
          <button onClick={() => navigate('/groups')} style={{
            padding: '13px 32px', borderRadius: 14, border: 'none',
            background: 'var(--sage)', color: 'white', fontSize: 15, fontWeight: 600, cursor: 'pointer',
          }}>
            {t.groups_back} →
          </button>
        )}

        {status === 'not_found' && (
          <button onClick={() => navigate('/groups')} style={{
            padding: '13px 32px', borderRadius: 14, border: '1.5px solid var(--border)',
            background: 'none', color: 'var(--charcoal)', fontSize: 15, fontWeight: 600, cursor: 'pointer',
          }}>
            {t.groups_back}
          </button>
        )}

        {status === 'no_auth' && (
          <button onClick={() => navigate('/')} style={{
            padding: '13px 32px', borderRadius: 14, border: 'none',
            background: 'var(--sage)', color: 'white', fontSize: 15, fontWeight: 600, cursor: 'pointer',
          }}>
            Sign in
          </button>
        )}
      </motion.div>
    </div>
  )
}
