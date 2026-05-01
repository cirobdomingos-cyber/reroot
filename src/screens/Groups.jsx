import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import { fetchGroups, createGroup, joinGroup } from '../services/api'

// Tells App.jsx to hide the FAB while this sheet is open. Without this the
// FAB visually overlaps the sheet because AnimatedPage establishes its own
// stacking context (framer-motion transform), trapping the sheet inside it
// while the FAB sits one level up at the phone-shell.
function useModalBroadcast(open) {
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: 1 } }))
    return () => window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: -1 } }))
  }, [open])
}

// Portal target for bottom-sheets. We portal to document.body so the sheet
// anchors to the real viewport instead of being trapped inside AnimatedPage
// (whose framer-motion transform creates a containing block that clips
// `position: fixed; bottom: 0`, hiding the action row on smaller phones).
function SheetPortal({ children }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

export default function Groups({ embedded = false }) {
  const { state } = useApp()
  const t = useT()
  const navigate = useNavigate()
  const googleId = state.googleUser?.id

  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showJoin, setShowJoin] = useState(false)

  useEffect(() => {
    if (!googleId) { setLoading(false); return }
    fetchGroups(googleId).then(g => { setGroups(g); setLoading(false) }).catch(() => setLoading(false))
  }, [googleId])

  async function handleCreate(data) {
    try {
      console.log('[Groups] createGroup', { googleId, data })
      const group = await createGroup(googleId, data)
      console.log('[Groups] created', group)
      setGroups(prev => [{ ...group, member_count: 1, role: 'admin', next_event: null }, ...prev])
      setShowCreate(false)
    } catch (err) {
      console.error('[Groups] create failed', err)
      alert(t.groups_create_error ?? 'Erro ao criar grupo. Verifique sua conexão.')
    }
  }

  async function handleJoin(code) {
    const result = await joinGroup(googleId, code)
    if (result.status === 'ok' || result.status === 'already_member') {
      // Refresh the list
      const updated = await fetchGroups(googleId)
      setGroups(updated)
      setShowJoin(false)
      if (result.group) navigate(`/groups/${result.group.id}`)
    }
    return result
  }

  if (!googleId) {
    return (
      <div style={{ padding: '16px 16px 100px' }}>
        {!embedded && (
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', margin: 0, marginBottom: 16 }}>
            {t.groups_title}
          </h1>
        )}
        <div style={{
          margin: '16px 0', padding: '20px', background: 'white', borderRadius: 16,
          border: '1px solid var(--border)', textAlign: 'center',
          color: 'var(--charcoal-mid)', fontSize: 13, lineHeight: 1.5,
        }}>
          {t.groups_login_required ?? 'Entre com Google para criar e participar de grupos.'}
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 16px 100px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        {!embedded && (
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', margin: 0 }}>
            {t.groups_title}
          </h1>
        )}
        <div style={{ display: 'flex', gap: 8, marginLeft: embedded ? 0 : 'auto' }}>
          <button onClick={() => setShowJoin(true)} style={actionBtnStyle}>
            {t.groups_join_btn}
          </button>
          <button onClick={() => setShowCreate(true)} style={{ ...actionBtnStyle, background: 'var(--sage)', color: 'white' }}>
            + {t.groups_create}
          </button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <p style={{ color: 'var(--charcoal-mid)', textAlign: 'center', marginTop: 40 }}>{t.events_loading}</p>
      ) : groups.length === 0 ? (
        <div style={{ textAlign: 'center', marginTop: 60, color: 'var(--charcoal-mid)' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>👥</div>
          <p style={{ fontSize: 15, fontWeight: 600 }}>{t.groups_empty}</p>
          <p style={{ fontSize: 13 }}>{t.groups_empty_sub}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {groups.map(g => (
            <motion.div
              key={g.id}
              whileTap={{ scale: 0.98 }}
              onClick={() => navigate(`/groups/${g.id}`)}
              style={cardStyle}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>👥</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--charcoal)' }}>{g.name}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 4, marginLeft: 26 }}>
                    {g.member_count} {t.groups_members}
                    {g.visibility === 'private' && <span style={{ marginLeft: 6 }}>🔒</span>}
                  </div>
                </div>
                {g.role === 'admin' && (
                  <span style={adminBadgeStyle}>{t.groups_admin}</span>
                )}
              </div>
              {g.next_event ? (
                <div style={{ fontSize: 12, color: 'var(--sage)', marginTop: 8, marginLeft: 26 }}>
                  {t.groups_next_event}: {g.next_event.name} — {g.next_event.date_start?.slice(0, 10)}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--charcoal-light)', marginTop: 8, marginLeft: 26 }}>
                  {t.groups_no_events}
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {/* Create group sheet */}
      <CreateGroupSheet open={showCreate} onClose={() => setShowCreate(false)} onCreate={handleCreate} t={t} />
      {/* Join group sheet */}
      <JoinGroupSheet open={showJoin} onClose={() => setShowJoin(false)} onJoin={handleJoin} t={t} />
    </div>
  )
}


function CreateGroupSheet({ open, onClose, onCreate, t }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('private')
  const [saving, setSaving] = useState(false)

  useModalBroadcast(open)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      await onCreate({ name: name.trim(), description: description.trim(), visibility })
      setName(''); setDescription(''); setVisibility('private')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SheetPortal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={onClose} style={backdropStyle} />
            <motion.div key="sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 350 }} style={sheetStyle}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 700, textAlign: 'center', marginBottom: 16, color: 'var(--charcoal)' }}>
                {t.groups_create_title}
              </h3>
              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label style={labelStyle}>{t.groups_name}</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder={t.groups_name_placeholder}
                  style={inputStyle} required />

                <label style={labelStyle}>{t.groups_description}</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t.groups_desc_placeholder}
                  rows={2} style={{ ...inputStyle, resize: 'none' }} />

                <label style={labelStyle}>{t.groups_visibility}</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['private', 'public'].map(v => (
                    <button key={v} type="button" onClick={() => setVisibility(v)}
                      style={{
                        flex: 1, padding: '10px 12px', borderRadius: 12, border: 'none', cursor: 'pointer',
                        background: visibility === v ? 'var(--sage)' : 'var(--cream)',
                        color: visibility === v ? 'white' : 'var(--charcoal)',
                        fontWeight: 600, fontSize: 13,
                      }}>
                      {v === 'private' ? `🔒 ${t.groups_private}` : `🌍 ${t.groups_public}`}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button type="button" onClick={onClose} style={cancelBtnStyle}>{t.groups_cancel}</button>
                  <button type="submit" disabled={saving || !name.trim()} style={submitBtnStyle}>
                    {saving ? '...' : t.groups_save}
                  </button>
                </div>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </SheetPortal>
  )
}


function JoinGroupSheet({ open, onClose, onJoin, t }) {
  const [code, setCode] = useState('')
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)

  useModalBroadcast(open)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!code.trim()) return
    setLoading(true)
    setStatus(null)
    try {
      const result = await onJoin(code.trim())
      if (result.status === 'ok') setStatus('success')
      else if (result.status === 'already_member') setStatus('already')
      else setStatus('not_found')
    } catch {
      setStatus('not_found')
    } finally {
      setLoading(false)
    }
  }

  return (
    <SheetPortal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={onClose} style={backdropStyle} />
            <motion.div key="sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 350 }} style={sheetStyle}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 700, textAlign: 'center', marginBottom: 16, color: 'var(--charcoal)' }}>
                {t.groups_join_title}
              </h3>
              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <label style={labelStyle}>{t.groups_join_code_label}</label>
                <input value={code} onChange={e => setCode(e.target.value.toUpperCase())}
                  placeholder={t.groups_join_code_placeholder} style={{ ...inputStyle, letterSpacing: 2, textAlign: 'center', fontWeight: 700 }}
                  maxLength={8} required />

                {status === 'success' && <p style={{ color: 'var(--sage)', fontSize: 13, textAlign: 'center' }}>{t.groups_join_success}</p>}
                {status === 'already' && <p style={{ color: 'var(--terra)', fontSize: 13, textAlign: 'center' }}>{t.groups_join_already}</p>}
                {status === 'not_found' && <p style={{ color: '#e74c3c', fontSize: 13, textAlign: 'center' }}>{t.groups_join_not_found}</p>}

                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button type="button" onClick={onClose} style={cancelBtnStyle}>{t.groups_cancel}</button>
                  <button type="submit" disabled={loading || !code.trim()} style={submitBtnStyle}>
                    {loading ? '...' : t.groups_join_btn}
                  </button>
                </div>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </SheetPortal>
  )
}


// ── Shared styles ──

const cardStyle = {
  background: 'white', borderRadius: 16, padding: '14px 16px',
  border: '1px solid var(--border)', cursor: 'pointer',
}

const actionBtnStyle = {
  padding: '7px 14px', borderRadius: 10, border: '1.5px solid var(--border)',
  background: 'none', fontSize: 12, fontWeight: 600,
  color: 'var(--charcoal)', cursor: 'pointer',
}

const adminBadgeStyle = {
  fontSize: 10, fontWeight: 700, color: 'var(--sage)',
  background: 'var(--sage-pale, #e8f0e9)', padding: '3px 8px', borderRadius: 6,
}

const backdropStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 10500,
}

// Cap at 85% viewport + scroll internally so the submit stays reachable
// even when iOS keyboard pushes content up. The sheet is portaled to
// document.body, so `bottom: 0` is the real viewport bottom — we add
// generous bottom padding (safe-area + 24px) to lift the Cancel/Create
// row clear of the iPhone home indicator on every device.
const sheetStyle = {
  position: 'fixed', bottom: 0, left: 0, right: 0, background: 'white',
  borderRadius: '20px 20px 0 0',
  padding: '8px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
  // Above DetailPanel (10000) so sheets opened from inside an event
  // detail aren't hidden behind it.
  zIndex: 10501,
  maxHeight: '85vh',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  WebkitOverflowScrolling: 'touch',
}

const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--charcoal-mid)' }

const inputStyle = {
  width: '100%', padding: '11px 14px', borderRadius: 12,
  border: '1.5px solid var(--border)', fontSize: 14,
  outline: 'none', boxSizing: 'border-box',
}

const cancelBtnStyle = {
  flex: 1, padding: '13px 0', borderRadius: 14, border: '1.5px solid var(--border)',
  background: 'none', fontSize: 14, fontWeight: 600, color: 'var(--charcoal-mid)', cursor: 'pointer',
}

const submitBtnStyle = {
  flex: 1, padding: '13px 0', borderRadius: 14, border: 'none',
  background: 'var(--sage)', color: 'white', fontSize: 14, fontWeight: 600, cursor: 'pointer',
}
