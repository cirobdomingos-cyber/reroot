import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Avatar from './Avatar'
import { getFriends, createPersonalPlan, createGroupEvent, fetchGroups, fetchGroupDetail } from '../services/api'

// The single event-creation sheet. Both entry points use it — the Home
// "criar evento com amigos" CTA and "+ Novo Evento" inside a group, the
// latter passing initialGroupId so the group arrives pre-connected.
// GroupDetail used to carry its own AddEventSheet — a near-duplicate that
// drifted: it had no "recado" field and, though it could invite outsiders,
// never warned that those people can't see the group. Same action, two
// behaviors depending on which button you pressed.
//
// Two modes, one form:
//   - **No group connected**: hand-picked invitee list, POSTs to
//     /events/private. The creator auto-RSVPs.
//   - **Group connected**: all current members come as a unit, plus any
//     extras you add. POSTs to /groups/{id}/events so the event shows in
//     the group's feed and carries the group label — for members only.
//     Outsiders never learn the group exists (see the note in the UI).
//
// Connecting a group is ATOMIC on purpose: everyone comes together, so
// nobody is quietly left off a group event. Need a subset? Disconnect —
// that expands the members into the individual picker so you can drop
// whoever, rather than starting from an empty list.

export default function PersonalPlanSheet({ open, onClose, googleId, onCreated, initialGroupId = null }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [description, setDescription] = useState('')
  const [dateStart, setDateStart] = useState('')
  // Multi-day runs (Carnaval, a long weekend, a festival). Empty means a
  // one-off, which is the overwhelming majority — so the field stays
  // behind a toggle instead of adding a second date picker everyone has
  // to scroll past. Backend and payload have carried date_end all along;
  // this form was the last thing not asking for it.
  const [multiDay, setMultiDay] = useState(false)
  const [dateEnd, setDateEnd] = useState('')
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
  // People who are invitable but aren't in the friends list — group
  // members dropped here by disconnectGroup(). Without this they'd be
  // unreachable: the picker only renders `friends`, so a member who
  // isn't your friend could never be re-added after a disconnect.
  const [extraPeople, setExtraPeople] = useState([])
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
    // fetchGroups resolves to the ARRAY of groups, not { groups: [...] }.
    // This destructured `{ groups }` off an array, got undefined every
    // time, and fell through to []. Net effect: the "Conectar a um grupo"
    // control never rendered for anyone, for any account — so every event
    // created from Home has silently been a standalone plan, never
    // group-tagged. The .catch(() => {}) hid it from the console too.
    // Groups.jsx and AddToGroupSheet.jsx both read it correctly.
    fetchGroups(googleId).then(list => {
      if (!cancelled) setUserGroups(Array.isArray(list) ? list : [])
    }).catch(err => {
      console.warn('PersonalPlanSheet: could not load groups', err)
    })
    return () => { cancelled = true }
  }, [open, googleId])

  // Reset form when reopened so a stale draft doesn't haunt the next
  // creation.
  useEffect(() => {
    if (open) {
      setName(''); setVenue(''); setDateStart(''); setNote(''); setDescription('')
      setMultiDay(false); setDateEnd('')
      setSelected(new Set()); setSearch(''); setError(null); setExtraPeople([])
      setConnectedGroup(null); setShowGroupPicker(false); setConnectingGroupId(null)
    }
  }, [open])

  // Opened from inside a group: pre-connect it, so this is the same sheet
  // as the Home CTA with one field already filled. Declared after the
  // reset effect so it wins — reset clears connectedGroup on open, then
  // this puts the group back.
  useEffect(() => {
    if (!open || !googleId || !initialGroupId) return
    let cancelled = false
    fetchGroupDetail(initialGroupId, googleId).then(detail => {
      if (cancelled) return
      setConnectedGroup({ id: detail.id, name: detail.name, members: detail.members || [] })
    }).catch(err => {
      console.warn('PersonalPlanSheet: could not pre-connect group', err)
    })
    return () => { cancelled = true }
  }, [open, googleId, initialGroupId])

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

  // Disconnecting expands the group into individual invitees instead of
  // dropping them. Connecting a group is deliberately atomic — everyone
  // comes as a unit, so nobody gets quietly left off a group event — and
  // this is the escape hatch for when you genuinely want a subset (a
  // surprise for one of them, say). The file has promised this behavior
  // in a comment since it was written; it was never wired, so "atomic"
  // in practice meant "all of them or start over from an empty list".
  function disconnectGroup() {
    const members = connectedGroup?.members || []
    const invitable = members.filter(m => m.google_id && m.google_id !== googleId)
    setSelected(prev => new Set([...prev, ...invitable.map(m => m.google_id)]))
    setExtraPeople(prev => {
      const known = new Set(prev.map(p => p.google_id))
      return [...prev, ...invitable.filter(m => !known.has(m.google_id))]
    })
    setConnectedGroup(null)
  }

  // Members of the connected group, minus the creator. These are part of
  // the invitee list automatically when a group is connected.
  const connectedMemberIds = (connectedGroup?.members || [])
    .map(m => m.google_id)
    .filter(gid => gid && gid !== googleId)
  // Invitable pool = friends + anyone carried over from a disconnect.
  // Deduped by google_id, friends winning (their row has the fresher
  // name/picture).
  const peoplePool = (() => {
    const byId = new Map()
    for (const f of friends) if (f.google_id) byId.set(f.google_id, f)
    for (const p of extraPeople) if (p.google_id && !byId.has(p.google_id)) byId.set(p.google_id, p)
    return [...byId.values()]
  })()
  // People not already covered by the connected group.
  const memberSet = new Set((connectedGroup?.members || []).map(m => m.google_id))
  const eligibleFriends = peoplePool.filter(f => !memberSet.has(f.google_id))

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
    if (trimmedName.length < 3) { setError('Dá um nome pro evento (mín 3 letras)'); return }
    if (!dateStart) { setError('Escolhe uma data'); return }
    // Only send an end date when the user actually opted into a range and
    // filled it in — an empty or backwards value degrades to a one-off
    // rather than blocking the create.
    const endValue = multiDay && dateEnd ? dateEnd : null
    if (endValue && endValue < dateStart) {
      setError('O fim não pode ser antes do começo')
      return
    }
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
          date_end: endValue,
          description: description.trim(),
          note: note.trim(),
          invitee_google_ids: inviteeIds,
        })
      } else {
        event = await createPersonalPlan(googleId, {
          name: trimmedName,
          venue: venue.trim(),
          date_start: dateStart,
          date_end: endValue,
          description: description.trim(),
          note: note.trim(),
          invitee_google_ids: [...selected],
        })
      }
      onCreated?.(event)
      onClose()
    } catch (e) {
      setError(e?.message || 'Erro ao criar o evento')
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
                ? `🎲 Novo evento em ${connectedGroup.name}`
                : '🎲 Criar um evento com amigos'}
            </h3>

            <Field label="O que vai rolar?">
              <input
                value={name} onChange={e => setName(e.target.value)}
                placeholder="Ex: Pizza no Madá sexta"
                style={inputStyle} maxLength={120}
              />
            </Field>

            <Field label={multiDay ? 'Começa quando?' : 'Quando?'}>
              <input
                type="datetime-local"
                value={dateStart} onChange={e => setDateStart(e.target.value)}
                style={inputStyle}
              />
            </Field>

            {multiDay ? (
              <Field label="Vai até quando?">
                <input
                  type="datetime-local"
                  value={dateEnd} onChange={e => setDateEnd(e.target.value)}
                  // Can't end before it starts. The submit handler checks
                  // this too — min= is advisory on some mobile browsers.
                  min={dateStart || undefined}
                  style={inputStyle}
                />
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6, lineHeight: 1.45 }}>
                  O evento aparece em todos os dias entre as duas datas.
                </div>
              </Field>
            ) : (
              <button
                type="button"
                onClick={() => setMultiDay(true)}
                style={{
                  background: 'none', border: 'none', padding: 0, marginBottom: 10,
                  fontSize: 12, fontWeight: 600, color: 'var(--cyan)', cursor: 'pointer',
                }}
              >
                + Dura mais de um dia
              </button>
            )}

            <Field label="Detalhes (opcional)">
              <textarea
                value={description} onChange={e => setDescription(e.target.value)}
                placeholder="Ex: leva uma garrafa, começa 20h em ponto"
                rows={2}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                maxLength={1000}
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
                {/* Privacy contract, stated where the decision is made.
                    Outsiders on the invitee list never learn the group
                    exists: the payload gates groupId/groupName on
                    membership, /groups/{id} refuses non-members, and the
                    push drops the group framing for them. Saying so here
                    is what makes people comfortable mixing the two —
                    otherwise you either don't invite outsiders, or you
                    do and quietly worry about what they can see. */}
                {selected.size > 0 && (
                  <div style={{
                    marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)',
                    fontSize: 11, color: 'var(--text3)', lineHeight: 1.5,
                  }}>
                    🔒 {selected.size === 1 ? 'A pessoa convidada de fora' : `As ${selected.size} pessoas convidadas de fora`}
                    {' '}não {selected.size === 1 ? 'faz' : 'fazem'} parte de{' '}
                    <strong style={{ color: 'var(--text2)' }}>{connectedGroup.name}</strong>
                    {' '}— {selected.size === 1 ? 'ela vê' : 'elas veem'} só este evento, sem saber que o grupo existe.
                  </div>
                )}
              </div>
            ) : userGroups.length > 0 ? (
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
            ) : (
              /* No groups yet — say so instead of hiding the control.
                 This branch used to be `userGroups.length > 0 && (...)`,
                 so someone with zero groups just saw the option missing
                 with no explanation and reasonably concluded the feature
                 didn't exist. Signed-out users land here too, since the
                 fetch effect bails without a googleId. */
              <div style={{
                marginBottom: 10, padding: '10px 12px', borderRadius: 12,
                border: '1.5px dashed var(--line)',
                fontSize: 12, color: 'var(--text3)', lineHeight: 1.5,
              }}>
                {googleId ? (
                  <>
                    🔗 Você ainda não tem grupos.{' '}
                    <button
                      type="button"
                      onClick={() => { onClose?.(); navigate('/community') }}
                      style={{
                        background: 'none', border: 'none', padding: 0,
                        font: 'inherit', color: 'var(--cyan)', fontWeight: 600,
                        cursor: 'pointer', textDecoration: 'underline',
                      }}
                    >
                      Criar um grupo
                    </button>{' '}
                    pra convidar a galera toda de uma vez.
                  </>
                ) : (
                  <>🔗 Entra com o Google pra convidar amigos e conectar grupos.</>
                )}
              </div>
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
