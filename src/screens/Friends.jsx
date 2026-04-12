/**
 * Friends — social tab for discovering and managing your cohort connections.
 *
 * Sections (top to bottom):
 *   1. My code card — shareable friend code + copy button.
 *   2. Add by code — input + button to claim a friend.
 *   3. Friend list — people you're connected to.
 *   4. Activity feed — events your friends are going to.
 *
 * All sections degrade gracefully when the backend is unavailable
 * (each API helper in services/api.js returns null/[] on failure).
 */
import { useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import {
  getMyFriendCode,
  addFriend,
  getFriends,
  fetchFriendsFeed,
  trackEvent,
} from '../services/api'

function LoginGate({ t }) {
  return (
    <div style={{
      margin: '16px', padding: '20px',
      background: 'white', borderRadius: 16,
      border: '1px solid var(--border)', textAlign: 'center',
      color: 'var(--charcoal-mid)', fontSize: 13, lineHeight: 1.5,
    }}>
      {t.friends_login_required}
    </div>
  )
}

function Section({ label, children, style }) {
  return (
    <div style={{ margin: '0 16px 14px', ...style }}>
      <div className="section-label" style={{ marginLeft: 0, marginBottom: 8 }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function Avatar({ name, picture, size = 42 }) {
  if (picture) {
    return (
      <img
        src={picture}
        alt={name}
        referrerPolicy="no-referrer"
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    )
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: 'var(--terra-pale)', color: 'var(--terra)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: 700,
    }}>
      {(name || '?')[0].toUpperCase()}
    </div>
  )
}

export default function Friends({ embedded = false }) {
  const { state } = useApp()
  const t = useT()
  const googleId = state.googleUser?.id

  const [myCode, setMyCode] = useState(null)
  const [copied, setCopied] = useState(false)
  const [codeInput, setCodeInput] = useState('')
  const [addState, setAddState] = useState('idle') // 'idle' | 'sending' | 'success' | 'error'
  const [friends, setFriends] = useState([])
  const [feed, setFeed] = useState([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!googleId) { setLoading(false); return }
    setLoading(true)
    const [code, friendList, feedEvents] = await Promise.all([
      getMyFriendCode(googleId),
      getFriends(googleId),
      fetchFriendsFeed(googleId),
    ])
    setMyCode(code)
    setFriends(friendList || [])
    setFeed(feedEvents || [])
    setLoading(false)
  }, [googleId])

  useEffect(() => { reload() }, [reload])
  useEffect(() => { trackEvent('friends_tab_viewed') }, [])

  async function handleCopy() {
    if (!myCode) return
    try {
      await navigator.clipboard.writeText(myCode)
      setCopied(true)
      trackEvent('friend_code_copied')
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard unavailable — no-op
    }
  }

  async function handleAdd(e) {
    e.preventDefault()
    const code = codeInput.trim().toUpperCase()
    if (!code || addState === 'sending') return

    setAddState('sending')
    const result = await addFriend(googleId, code)
    if (result && (result.status === 'ok' || result.status === 'already_friends')) {
      setAddState('success')
      setCodeInput('')
      trackEvent('friend_added_by_code')
      await reload()
      setTimeout(() => setAddState('idle'), 2000)
    } else {
      setAddState('error')
      setTimeout(() => setAddState('idle'), 2500)
    }
  }

  if (!googleId) {
    return (
      <div>
        {!embedded && (
          <div className="screen-header">
            <div className="screen-header__title">{t.friends_title}</div>
            <div className="screen-header__sub">{t.friends_sub}</div>
          </div>
        )}
        <LoginGate t={t} />
      </div>
    )
  }

  const friendCount = friends.length
  const countLabel = friendCount === 1 ? t.friends_count_one : t.friends_count_many

  return (
    <div>
      {/* Header */}
      {!embedded && (
        <div className="screen-header">
          <div className="screen-header__title">{t.friends_title}</div>
          <div className="screen-header__sub">
            {friendCount} {countLabel} · {t.friends_sub}
          </div>
        </div>
      )}

      {/* My code card */}
      <div style={{ margin: '4px 16px 14px' }}>
        <motion.div
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          style={{
            background: 'linear-gradient(135deg, #C4724A 0%, #E08D5E 100%)',
            borderRadius: 20, padding: '18px 20px', color: 'white',
            boxShadow: '0 6px 18px rgba(196,114,74,0.35)',
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2, opacity: 0.85, marginBottom: 4 }}>
            {t.friends_my_code_label}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          }}>
            <div style={{
              fontSize: 30, fontWeight: 800, letterSpacing: 4,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}>
              {myCode || '— — — —'}
            </div>
            <button
              onClick={handleCopy}
              disabled={!myCode}
              style={{
                padding: '8px 14px', borderRadius: 10, border: 'none',
                background: 'rgba(255,255,255,0.22)', color: 'white',
                fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
                opacity: myCode ? 1 : 0.5,
              }}
            >
              {copied ? t.friends_code_copied : t.friends_code_copy}
            </button>
          </div>
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 8 }}>
            {t.friends_my_code_hint}
          </div>
        </motion.div>
      </div>

      {/* Add by code */}
      <Section label={t.friends_add_label}>
        <form
          onSubmit={handleAdd}
          style={{
            display: 'flex', gap: 8,
            background: 'white', borderRadius: 14, padding: 8,
            border: '1px solid var(--border)',
          }}
        >
          <input
            value={codeInput}
            onChange={e => setCodeInput(e.target.value.toUpperCase())}
            placeholder={t.friends_add_placeholder}
            maxLength={10}
            style={{
              flex: 1, border: 'none', outline: 'none',
              background: 'transparent', fontSize: 15, fontWeight: 600,
              letterSpacing: 2, padding: '8px 10px',
              color: 'var(--charcoal)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          />
          <button
            type="submit"
            disabled={!codeInput.trim() || addState === 'sending'}
            style={{
              padding: '10px 16px', borderRadius: 10, border: 'none',
              background: 'var(--sage)', color: 'white',
              fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
              opacity: (!codeInput.trim() || addState === 'sending') ? 0.45 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {addState === 'sending' ? t.friends_add_adding : t.friends_add_btn}
          </button>
        </form>
        {addState === 'success' && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            style={{ fontSize: 12, fontWeight: 600, color: 'var(--sage)', marginTop: 8, paddingLeft: 4 }}
          >
            ✓ {t.friends_add_success}
          </motion.div>
        )}
        {addState === 'error' && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            style={{ fontSize: 12, fontWeight: 600, color: '#c0392b', marginTop: 8, paddingLeft: 4 }}
          >
            {t.friends_add_error}
          </motion.div>
        )}
      </Section>

      {/* Friend list */}
      <Section label={t.friends_list_label}>
        {loading ? (
          <div style={{ display: 'flex', gap: 10, padding: '6px 2px' }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: 42, height: 42, borderRadius: '50%',
                background: '#f0ede8',
              }}/>
            ))}
          </div>
        ) : friends.length === 0 ? (
          <div style={{
            background: 'white', borderRadius: 14, padding: '18px 16px',
            border: '1px dashed var(--border)',
            fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5,
          }}>
            {t.friends_list_empty}
          </div>
        ) : (
          <div style={{
            background: 'white', borderRadius: 16, padding: '6px 14px',
            border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
          }}>
            {friends.map((f, i) => (
              <div key={f.google_id ?? f.friend_code ?? i} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 0',
                borderBottom: i < friends.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <Avatar name={f.name} picture={f.picture} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14, fontWeight: 600, color: 'var(--charcoal)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {f.name}
                  </div>
                  {f.neighborhood && (
                    <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
                      📍 {f.neighborhood}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Activity feed */}
      <Section label={t.friends_feed_label}>
        {loading ? null : feed.length === 0 ? (
          <div style={{
            background: 'white', borderRadius: 14, padding: '14px 16px',
            border: '1px dashed var(--border)',
            fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5,
          }}>
            {t.friends_feed_empty}
          </div>
        ) : (
          feed.map(ev => (
            <div key={ev.id} style={{
              background: 'white', borderRadius: 14, padding: '12px 14px',
              border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
              marginBottom: 8,
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--charcoal)', marginBottom: 4 }}>
                {ev.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginBottom: 8 }}>
                {ev.date} {ev.time ? `· ${ev.time}` : ''} {ev.venue ? `· ${ev.venue}` : ''}
              </div>
              {ev.friends_going && ev.friends_going.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex' }}>
                    {ev.friends_going.slice(0, 4).map((f, i) => (
                      <div key={f.google_id ?? i} style={{ marginLeft: i === 0 ? 0 : -8 }}>
                        <Avatar name={f.name} picture={f.picture} size={26} />
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--terra)' }}>
                    {ev.friends_going.length} {t.friends_feed_going}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </Section>

      <div style={{ height: 24 }}/>
    </div>
  )
}
