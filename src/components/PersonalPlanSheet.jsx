import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Avatar from './Avatar'
import { getFriends, createPersonalPlan, createGroupEvent, fetchGroups, fetchGroupDetail } from '../services/api'

// Plan creation sheet. Two modes share the same form:
//   - **Standalone plan** (no group connected): hand-picked invitee
//     list, posts to /events/private. The creator auto-RSVPs.
//   - **Connected to a group**: "🔗 Conectar a Grupo" pulls all current
//     members (atomic), then the user can add extras. Posts to
//     /groups/{id}/events so the event shows up in the group's feed
//     and inherits the group label for members.
//
// Connecting a group is atomic: all current members come as a unit. To
// exclude someone, you'd need to disconnect (resets to standalone plan
// with the members as individual invitees) — wired as a follow-up.

export default function PersonalPlanSheet({ open, onClose, googleId, onCreated }) {
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [note, setNote] = useState('')
  const [friends, setFriends] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  // Group connection state. When `connectedGroup` is non-null, the
  // submit routes through /groups/{id}/events and the event picks up
  // the group_id tag. The members snapshot lives in connectedGroup.members.
  const [userGroups, setUserGroups] = useState([])
  const [connectedGroup, setConnectedGroup] = useState(null)
  const [showGroupPicker, setShowGroupPicker] = useState(false)
  const [connectingGroupId, setConnectingGroupId] = useState(null)

  // Hide the Companion FAB while this sheet is up — same convention
  // every modal in the app uses.
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: 1 } }))
    return () => window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: -1 } }))
  }, [open])

  // Fetch friends + the user's groups when the sheet opens. Both cache
  // in component state so toggling fields doesn't re-fetch.
  useEffect(() => {
    if (!open || !googleId) return
    let cancelled = false
    getFriends(googleId).then(list => {
      if (!cancelled) setFriends(Array.isArray(list) ? list : [])
    })
    fetchGroups(googleId).then(({ groups }) => {
      if (!cancelled) setUserGroups(Array.isArray(groups) ? groups : [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, [open, googleId])

  // Reset form when reopened so a stale draft doesn't haunt the next
  // creation.
  useEffect(() => {
    if (open) {
      setName(''); setVenue(''); setDateStart(''); setNote('')
      setSelected(new Set()); setSearch(''); setError(null)
      setConnectedGroup(null); setShowGroupPicker(false); setConnectingGroupId(null)
    }
  }, [open])

  async function connectGroup(group) {
    setConnectingGroupId(group.id)
    setError(null)
    try {
      const detail = await fetchGroupDetail(group.id, googleId)
      setConnectedGroup({
        id: detail.id,
        name: detail.name,
        members: detail.members || [],
      })
      setShowGroupPicker(false)
    } catch (e) {
      setError(e?.message || 'Não consegui carregar o grupo')
    } finally {
      setConnectingGroupId(null)
    }
  }

  function disconnectGroup() {
    setConnectedGroup(null)
  }

  // Members of the connected group, minus the creator. These are part of
  // the invitee list automatically when a group is connected.
  const connectedMemberIds = (connectedGroup?.members || [])
    .map(m => m.google_id)
    .filter(gid => gid && gid !== googleId)
  // Friends not already covered by the connected group.
  const memberSet = new Set((connectedGroup?.members || []).map(m => m.google_id))
  const eligibleFriends = friends.filter(f => !memberSet.has(f.google_id))

  const q = search.trim().toLowerCase()
  const visibleFriends = q
    ? eligibleFriends.filter(f => (f.name || '').toLowerCase().includes(q))
    : eligibleFriends

  function toggleFriend(gid) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid); else next.add(gid)
      return next
    })
  }

  // Total invitees = group members (when connected) + extras the user
  // picked. Drives the submit-button enable rule and copy.
  const totalInviteeCount = connectedMemberIds.length + selected.size

  async function submit() {
    setError(null)
    const trimmedName = name.trim()
    if (trimmedName.length < 3) { setError('Dá um nome pro plano (mín 3 letras)'); return }
    if (!dateStart) { setError('Escolhe uma data'); return }
    if (totalInviteeCount === 0) { setError('Convida pelo menos um amigo'); return }
    setSubmitting(true)
    try {
      // Routing rule: a connected group means the event is tagged to
      // that group (appears in its calendar feed and group label
      // surfaces to fellow members). Standalone plans just live in the
      // creator + invitees scope.
      let event
      if (connectedGroup) {
        const inviteeIds = Array.from(new Set([...connectedMemberIds, ...selected]))
        event = await createGroupEvent(connectedGroup.id, googleId, {
          name: trimmedName,
          venue: venue.trim(),
          date_start: dateStart,
          note: note.trim(),
          invitee_google_ids: inviteeIds,
        })
      } else {
        event = await createPersonalPlan(googleId, {
          name: trimmedName,
          venue: venue.trim(),
          date_start: dateStart,
          note: note.trim(),
          invitee_google_ids: [...selected],
        })
      }
      onCreated?.(event)
      onClose()
    } catch (e) {
      setError(e?.message || 'Erro ao criar plano')
    } finally {
      setSubmitting(false)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={submitting ? undefined : onClose}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 10500 }} />
          <motion.div key="sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--white)',
              borderRadius: '20px 20px 0 0',
              padding: '8px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
              zIndex: 10501, maxHeight: '90vh', overflowY: 'auto',
              overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
            }}>
            {/* Drag handle */}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
            </div>
            <h3 style={{ fontSize: 17, fontWeight: 700, textAlign: 'center', marginBottom: 14, color: 'var(--charcoal)' }}>
              {connectedGroup
                ? `🎲 Plano em ${connectedGroup.name}`
                : '🎲 Convidar amigos pra um plano'}
            </h3>

            <Field label="O que vai rolar?">
              <input
                value={name} onChange={e => setName(e.target.value)}
                placeholder="Ex: Pizza no Madá sexta"
                style={inputStyle} maxLength={120}
              />
            </Field>

            <Field label="Quando?">
              <input
                type="datetime-local"
                value={dateStart} onChange={e => setDateStart(e.target.value)}
                style={inputStyle}
              />
            </Field>

            <Field label="Onde? (opcional)">
              <input
                value={venue} onChange={e => setVenue(e.target.value)}
                placeholder="Ex: Bar Quermesse, Prudente de Morais"
                style={inputStyle} maxLength={200}
              />
            </Field>

            <Field label="Recado pros convidados (opcional)">
              <textarea
                value={note} onChange={e => setNote(e.target.value)}
                placeholder="Ex: Bora celebrar a sexta? :)"
                rows={2}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                maxLength={200}
              />
            </Field>

            {/* Group connection — atomic invitee block. Connecting pulls
                the whole crew in as a unit; "X" disconnects to revert
                back to standalone-plan mode. The picker is a popover-
                style list of the user's groups. */}
            {connectedGroup ? (
              <div style={{
                marginBottom: 12, padding: '10px 12px', borderRadius: 12,
                background: 'var(--sage-pale)',
                border: '1px solid var(--sage)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
                    color: 'var(--sage)', textTransform: 'uppercase',
                  }}>
                    🔗 {connectedGroup.name} — todos os membros
                  </div>
                  <button
                    type="button"
                    onClick={disconnectGroup}
                    style={{
                      border: 'none', background: 'transparent',
                      color: 'var(--charcoal-mid)', fontSize: 11, fontWeight: 600,
                      cursor: 'pointer', padding: '2px 6px',
                    }}
                  >
                    Desconectar
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {connectedGroup.members.map(m => (
                    <Avatar key={m.google_id} name={m.name} src={m.picture} size={22} />
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 6 }}>
                  {connectedMemberIds.length + 1} pessoas — você + crew
                </div>
              </div>
            ) : userGroups.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowGroupPicker(v => !v)}
                  style={{
                    marginBottom: 8, padding: '10px 12px', borderRadius: 12,
                    background: 'transparent',
                    border: '1.5px dashed var(--border)',
                    color: 'var(--charcoal-mid)', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', width: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}
                >
                  <span>🔗 Conectar a um grupo (opcional)</span>
                  <span style={{ fontSize: 11 }}>{showGroupPicker ? '▲' : '▼'}</span>
                </button>
                {showGroupPicker && (
                  <div style={{
                    marginBottom: 10,
                    display: 'flex', flexDirection: 'column', gap: 4,
                    border: '1px solid var(--border)', borderRadius: 10, padding: 4,
                  }}>
                    {userGroups.map(g => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => connectGroup(g)}
                        disabled={connectingGroupId === g.id}
                        style={{
                          padding: '8px 10px', borderRadius: 8,
                          border: 'none', background: 'transparent',
                          textAlign: 'left', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          color: 'var(--charcoal)',
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>👥 {g.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
                          {connectingGroupId === g.id ? 'carregando…' : `${g.member_count || 0} pessoas`}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Friend picker — when a group is connected, this picks
                extras outside the group; otherwise it's the full
                invitee list. */}
            <div style={{ marginTop: 6, marginBottom: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--charcoal)', marginBottom: 6 }}>
                {connectedGroup ? 'Convidar mais alguém de fora?' : 'Quem você convida?'}{' '}
                <span style={{ color: 'var(--charcoal-light)', fontWeight: 400 }}>
                  ({selected.size} selecionado{selected.size === 1 ? '' : 's'})
                </span>
              </div>
              {eligibleFriends.length > 0 && (
                <input
                  type="search"
                  placeholder="Buscar amigo…"
                  value={search} onChange={e => setSearch(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 8 }}
                />
              )}
              {friends.length === 0 ? (
                <div style={{
                  padding: '14px 12px', background: 'var(--cream)', borderRadius: 12,
                  fontSize: 12, color: 'var(--charcoal-mid)', textAlign: 'center',
                }}>
                  {connectedGroup
                    ? 'Sem amigos de fora pra adicionar — só o crew do grupo então.'
                    : 'Você ainda não tem amigos no auê. Adicione alguns na aba Comunidade primeiro.'}
                </div>
              ) : eligibleFriends.length === 0 ? (
                <div style={{
                  padding: '12px', background: 'var(--cream)', borderRadius: 10,
                  fontSize: 12, color: 'var(--charcoal-mid)', textAlign: 'center',
                }}>
                  Todos os seus amigos já estão no grupo.
                </div>
              ) : visibleFriends.length === 0 ? (
                <div style={{ padding: 12, fontSize: 12, color: 'var(--charcoal-light)', textAlign: 'center' }}>
                  Ninguém com "{search}".
                </div>
              ) : (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  maxHeight: 220, overflowY: 'auto',
                  border: '1px solid var(--border)', borderRadius: 12, padding: 4,
                }}>
                  {visibleFriends.map(f => {
                    const isSel = selected.has(f.google_id)
                    return (
                      <button
                        key={f.google_id}
                        type="button"
                        onClick={() => toggleFriend(f.google_id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 10px', borderRadius: 8,
                          border: 'none', cursor: 'pointer',
                          background: isSel ? 'var(--sage-pale)' : 'transparent',
                          textAlign: 'left',
                        }}
                      >
                        <Avatar name={f.name} src={f.picture} size={32} />
                        <span style={{
                          flex: 1, minWidth: 0, fontSize: 13,
                          fontWeight: isSel ? 600 : 500,
                          color: isSel ? 'var(--sage)' : 'var(--charcoal)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {f.name || f.google_id}
                        </span>
                        {isSel && <span style={{ color: 'var(--sage)', fontSize: 14 }}>✓</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {error && (
              <div style={{
                marginTop: 12, padding: '9px 12px', background: '#FFF3E0',
                color: '#BF360C', borderRadius: 8, fontSize: 12, textAlign: 'center',
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={{
                  flex: 1, padding: '12px 14px', borderRadius: 12,
                  border: '1px solid var(--border)', background: 'var(--white)',
                  fontSize: 13, fontWeight: 600, color: 'var(--charcoal-mid)',
                  cursor: 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting || !name.trim() || !dateStart || totalInviteeCount === 0}
                style={{
                  flex: 2, padding: '12px 14px', borderRadius: 12,
                  border: 'none',
                  background: 'var(--terra)', color: 'white',
                  fontSize: 13, fontWeight: 700,
                  cursor: submitting ? 'wait' : 'pointer',
                  opacity: (submitting || !name.trim() || !dateStart || totalInviteeCount === 0) ? 0.55 : 1,
                }}
              >
                {submitting
                  ? 'Convidando…'
                  : `Convidar ${totalInviteeCount} ${totalInviteeCount === 1 ? 'pessoa' : 'pessoas'}`}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--charcoal)', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </label>
  )
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  padding: '10px 12px',
  fontSize: 13, fontFamily: 'inherit',
  background: 'var(--white)',
  border: '1px solid var(--border)', borderRadius: 10,
  outline: 'none', color: 'var(--charcoal)',
}
