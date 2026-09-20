import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import {
  addFriendById, fetchEvents, getFriendRequests, getFriends,
  removeGroupMember, setGroupMemberRole, trackEvent,
} from '../services/api'
import { appLink, shareLink } from '../lib/share'
import Avatar from './Avatar'

// Extracted from the old GroupDetail (Sep 2026) so the channel screen can use
// them too.
//
// The first version of the channel screen dropped all of this as "crew
// machinery". Seeing the two side by side, that was the wrong cut: a
// calendar feed, a catalog picker and an activity panel aren't about
// there being other people in the room. Only the invite and the
// "convida a galera" nudge are, and those two stay out.
//
// The real difference isn't which features exist, it's who may use
// them: on a channel the picker and the stats are curator-only, while
// the calendar is for anyone following. Differentiating by permission
// instead of by capability keeps one surface and costs the reader
// nothing for being on either side of the line.

export function GroupStatsPanel({ stats }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{
        fontSize: 13, fontWeight: 700, color: 'var(--charcoal-mid)',
        textTransform: 'uppercase', letterSpacing: 0.6,
        margin: '0 0 8px',
      }}>
        Mural do canal
      </h2>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
        marginBottom: stats.top_organizer ? 8 : 0,
      }}>
        <StatTile emoji="📅" label="Eventos no total" value={stats.events_total} />
        <StatTile emoji="🚀" label="Por vir" value={stats.events_upcoming} />
        <StatTile emoji="✅" label="Já rolaram" value={stats.events_past} />
        <StatTile emoji="🙌" label="Confirmações" value={stats.rsvps_total} />
      </div>
      {stats.top_organizer && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', background: 'var(--white)',
          border: '1px solid var(--border)', borderRadius: 12,
        }}>
          <Avatar
            name={stats.top_organizer.name}
            src={stats.top_organizer.picture}
            size={32}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--charcoal-light)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Quem mais bota evento aqui
            </div>
            <div style={{
              fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {stats.top_organizer.name}{' '}
              <span style={{ fontWeight: 500, color: 'var(--charcoal-mid)' }}>
                · {stats.top_organizer.count} {stats.top_organizer.count === 1 ? 'evento' : 'eventos'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatTile({ emoji, label, value }) {
  return (
    <div style={{
      background: 'var(--white)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '10px 12px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
        {emoji} {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 800, color: 'var(--charcoal)',
        marginTop: 2, fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
    </div>
  )
}

export function CalendarSheet({ open, onClose, group, feedUrl, t }) {
  const [copied, setCopied] = useState(false)

  function handleGoogle() {
    const webcalUrl = feedUrl.replace(/^https?:/, 'webcal:')
    window.open(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`, '_blank', 'noopener')
    onClose()
  }

  function handleCopyIcal() {
    navigator.clipboard.writeText(feedUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleWhatsApp() {
    const webcalUrl = feedUrl.replace(/^https?:/, 'webcal:')
    const msg = `Subscribe to "${group.name}" calendar 📅 ${webcalUrl}`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener')
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t.groups_calendar_title}>
      <SheetButton icon="📅" label={t.groups_calendar_google} sublabel="Google Calendar" onClick={handleGoogle} />
      <SheetButton icon="🔗" label={copied ? t.groups_calendar_copied : t.groups_calendar_ics}
        sublabel="Apple Calendar, Outlook" onClick={handleCopyIcal} />
      <SheetButton icon="💬" label={t.groups_invite_whatsapp} sublabel="Share feed link" onClick={handleWhatsApp} accent="#25D366" />
    </BottomSheet>
  )
}

export function CatalogPickerSheet({ open, onClose, onPick }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(null) // event id being submitted

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetchEvents('all').then(({ events: evs }) => {
      if (cancelled) return
      const now = Date.now()
      const future = (evs || [])
        .filter(ev => !ev.isCurated)
        .filter(ev => ev.dateStart && Date.parse(ev.dateStart) > now)
        .sort((a, b) => Date.parse(a.dateStart) - Date.parse(b.dateStart))
      setEvents(future)
      setLoading(false)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  const filtered = query.trim()
    ? events.filter(ev => {
        const q = query.toLowerCase()
        return ev.name.toLowerCase().includes(q) || ev.venue?.toLowerCase().includes(q)
      })
    : events

  async function handlePick(ev) {
    if (adding) return
    setAdding(ev.id)
    const desc = (ev.description || '').trim()
    const urlSuffix = ev.url ? `\n\nVer original: ${ev.url}` : ''
    try {
      await onPick({
        name: ev.name,
        venue: ev.venue || '',
        date_start: ev.dateStart,
        // Preserve multi-day ranges across the fork — see AddToGroupSheet.
        date_end: ev.dateEnd || null,
        description: (desc + urlSuffix).slice(0, 1000),
      })
      onClose()
    } finally {
      setAdding(null)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Adicionar do catálogo">
      <input
        placeholder="Buscar evento ou local…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{
          width: '100%', padding: '10px 12px',
          borderRadius: 10, border: '1px solid var(--border)',
          fontSize: 13, marginBottom: 10,
        }}
      />
      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--charcoal-mid)', fontSize: 13 }}>
          Carregando…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--charcoal-mid)', fontSize: 13 }}>
          {query ? 'Nada encontrado.' : 'Sem eventos próximos.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '52vh', overflowY: 'auto' }}>
          {filtered.slice(0, 60).map(ev => {
            const day = ev.dateStart?.slice(0, 10)
            const time = ev.dateStart?.slice(11, 16)
            const isAdding = adding === ev.id
            return (
              <button
                key={ev.id}
                onClick={() => handlePick(ev)}
                disabled={isAdding}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: 'var(--white)', border: '1px solid var(--border)',
                  borderRadius: 12, padding: '10px 12px',
                  textAlign: 'left', cursor: isAdding ? 'default' : 'pointer',
                  opacity: isAdding ? 0.6 : 1,
                }}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, background: ev.headerBg || 'var(--cream)',
                }}>
                  {ev.icon || '📅'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {ev.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>
                    {day}{time ? ` · ${time}` : ''}{ev.venue ? ` · ${ev.venue}` : ''}
                  </div>
                </div>
                <div style={{ fontSize: 14, color: 'var(--charcoal-light)' }}>
                  {isAdding ? '…' : '+'}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </BottomSheet>
  )
}

export function BottomSheet({ open, onClose, title, children }) {
  // Hide the Companion FAB while this sheet is up.
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: 1 } }))
    return () => window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: -1 } }))
  }, [open])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 10500 }} />
          <motion.div key="sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            className="aue-sheet"
            style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--white)',
              borderRadius: '20px 20px 0 0',
              padding: '8px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
              zIndex: 10501, maxHeight: '85vh', overflowY: 'auto',
              overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
            </div>
            <h3 style={{ fontSize: 15, fontWeight: 700, textAlign: 'center', marginBottom: 14, color: 'var(--charcoal)' }}>
              {title}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

export function SheetButton({ icon, label, sublabel, onClick, accent }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      width: '100%', padding: '13px 14px', borderRadius: 14, border: 'none', cursor: 'pointer',
      background: accent ? `${accent}12` : 'var(--cream)',
    }}>
      <span style={{ fontSize: 18, width: 24, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, textAlign: 'left' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: accent || 'var(--charcoal)' }}>{label}</div>
        {sublabel && <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>{sublabel}</div>}
      </div>
      <span style={{ fontSize: 14, color: 'var(--charcoal-light)' }}>›</span>
    </button>
  )
}


export function InviteSheet({ open, onClose, group, t }) {
  const [copied, setCopied] = useState(false)
  const [shareStatus, setShareStatus] = useState(null)
  const inviteUrl = appLink(`/join/${group.invite_code}`)

  function handleCopyCode() {
    navigator.clipboard.writeText(group.invite_code)
    trackEvent('group_invite_shared', { method: 'code' })
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleShare() {
    const result = await shareLink({
      url: inviteUrl,
      title: 'auê',
      text: `Bora entrar no canal "${group.name}" no auê?`,
    })
    trackEvent('group_invite_shared', { method: result === 'shared' ? 'share' : 'link' })
    setShareStatus(result)
    if (result === 'copied') {
      // The link (not just the code) was copied to clipboard
      setTimeout(() => setShareStatus(null), 2500)
    } else if (result === 'shared') {
      onClose()
    } else {
      setTimeout(() => setShareStatus(null), 2500)
    }
  }

  function handleWhatsApp() {
    const msg = `Bora pro canal "${group.name}" no auê! 🎉 ${inviteUrl}`
    trackEvent('group_invite_shared', { method: 'whatsapp' })
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener')
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t.groups_invite_title}>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginBottom: 4 }}>{t.groups_invite_code}</div>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: 3, color: 'var(--charcoal)' }}>
          {group.invite_code}
        </div>
        <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 6 }}>
          ou compartilhe o link direto abaixo
        </div>
      </div>
      <SheetButton
        icon="🔗"
        label={
          shareStatus === 'copied' ? 'Link copiado ✓'
          : shareStatus === 'shared' ? 'Compartilhado ✓'
          : 'Compartilhar link de convite'
        }
        onClick={handleShare}
        accent="var(--sage)"
      />
      <SheetButton icon="💬" label={t.groups_invite_whatsapp} onClick={handleWhatsApp} accent="#25D366" />
      <SheetButton icon="📋" label={copied ? 'Código copiado ✓' : 'Copiar só o código'} onClick={handleCopyCode} />
    </BottomSheet>
  )
}

export function MembersSheet({ open, onClose, group, t, viewerIsAdmin, viewerGoogleId, onRoleChanged,
  // What these people are called on this channel. A public one has
  // followers, a private one has members, and the sheet is the same
  // sheet — so the word is a prop rather than a branch. Falls back to
  // the i18n string for the callers that predate the channel screen.
  peopleWord = '' }) {
  const members = group?.members || []
  const sorted = [...members].sort((a, b) => {
    const ra = (a.role === 'admin') ? 0 : 1
    const rb = (b.role === 'admin') ? 0 : 1
    if (ra !== rb) return ra - rb
    return (a.joined_at || '').localeCompare(b.joined_at || '')
  })
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  // Who the viewer is already friends with, so the list can offer
  // "+ amigo" only where it means something. Fetched when the sheet
  // opens rather than lifted into the channel screen — nothing else on the
  // screen needs it.
  const [friendIds, setFriendIds] = useState(new Set())
  // People the viewer already asked — "Pedido enviado" instead of "+ amigo".
  const [requestedIds, setRequestedIds] = useState(new Set())
  const [addingId, setAddingId] = useState(null)

  useEffect(() => {
    if (!open || !viewerGoogleId) return
    let cancelled = false
    Promise.all([getFriends(viewerGoogleId), getFriendRequests(viewerGoogleId)])
      .then(([list, requests]) => {
        if (cancelled) return
        setFriendIds(new Set((Array.isArray(list) ? list : []).map(f => f.google_id)))
        setRequestedIds(new Set(requests?.outgoing_ids || []))
      }).catch(() => {})
    return () => { cancelled = true }
  }, [open, viewerGoogleId])

  // POST /friends/add-by-id sends a request — sharing a group with someone
  // isn't their consent to be your friend. If they had already asked you,
  // the backend answers 'accepted' and you're friends right away.
  async function handleAddFriend(member) {
    setError(null)
    setAddingId(member.google_id)
    try {
      const res = await addFriendById(viewerGoogleId, member.google_id)
      if (res?.status === 'accepted' || res?.status === 'already_friends') {
        setFriendIds(prev => new Set([...prev, member.google_id]))
      } else if (res?.status === 'requested' || res?.status === 'already_requested') {
        setRequestedIds(prev => new Set([...prev, member.google_id]))
      } else {
        throw new Error('Não consegui mandar o pedido')
      }
    } catch (e) {
      setError(e?.message || 'Não consegui mandar o pedido de amizade')
    } finally {
      setAddingId(null)
    }
  }

  function fmtJoinedAt(iso) {
    if (!iso) return ''
    try {
      const d = new Date(iso)
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
    } catch { return '' }
  }

  async function handleRole(member, nextRole) {
    setError(null)
    setBusyId(member.google_id)
    try {
      await setGroupMemberRole(group.id, member.google_id, viewerGoogleId, nextRole)
      onRoleChanged?.()
    } catch (e) {
      setError(e?.message || 'Não consegui atualizar o papel')
    } finally {
      setBusyId(null)
    }
  }

  async function handleRemove(member) {
    if (!confirm(`Remover ${member.name || member.google_id} do canal?`)) return
    setError(null)
    setBusyId(member.google_id)
    try {
      await removeGroupMember(group.id, member.google_id, viewerGoogleId)
      onRoleChanged?.()
    } catch (e) {
      setError(e?.message || 'Não consegui remover o membro')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`${members.length} ${peopleWord || t.groups_members}`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 8 }}>
        {error && (
          <div style={{
            background: '#FFEBEE', color: '#B71C1C', padding: '8px 12px',
            borderRadius: 8, fontSize: 12, marginBottom: 8,
          }}>
            {error}
          </div>
        )}
        {sorted.map(m => {
          const isAdmin = m.role === 'admin'
          const canActOnMember = viewerIsAdmin && m.google_id !== viewerGoogleId
          return (
            // Two-line row: identity on top, actions underneath. With
            // badge + friend chip + two admin buttons on the same line as
            // the name, the text column collapsed to one character wide on
            // a phone ("E" / "Entrou em 10 de set. de 2026" stacked word
            // by word). The action line wraps instead of squeezing.
            <div key={m.google_id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 12,
              padding: '10px 4px',
            }}>
              <Avatar name={m.name} src={m.picture} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14, fontWeight: 600, color: 'var(--charcoal)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    minWidth: 0,
                  }}>
                    {m.name || m.google_id}
                  </div>
                  {isAdmin && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                      color: 'var(--terra)', background: 'var(--terra-pale)',
                      padding: '2px 7px', borderRadius: 6,
                      textTransform: 'uppercase', flexShrink: 0,
                    }}>
                      Admin
                    </span>
                  )}
                </div>
                {m.joined_at && (
                  <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
                    Entrou em {fmtJoinedAt(m.joined_at)}
                  </div>
                )}
                <div style={{
                  display: 'flex', flexWrap: 'wrap', alignItems: 'center',
                  gap: 6, marginTop: 8,
                }}>
              {/* Add as friend, straight from the member list. The backend
                  has had /friends/add-by-id (auto-accepting, built for
                  exactly this "someone you saw in the app" case) all
                  along — the group list just never offered it, so being
                  in a group with someone told you nothing and you both
                  still had to trade invite codes. Hidden for yourself and
                  for people you already know. */}
              {m.google_id && m.google_id !== viewerGoogleId && (
                friendIds.has(m.google_id) ? (
                  <span style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--text3)',
                    flexShrink: 0, whiteSpace: 'nowrap',
                  }}>
                    ✓ amigos
                  </span>
                ) : requestedIds.has(m.google_id) ? (
                  <span style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--text3)',
                    flexShrink: 0, whiteSpace: 'nowrap',
                  }}>
                    Pedido enviado
                  </span>
                ) : (
                  <button
                    onClick={() => handleAddFriend(m)}
                    disabled={addingId === m.google_id}
                    style={{
                      padding: '6px 10px', borderRadius: 8, flexShrink: 0,
                      border: '1px solid var(--cyan)', background: 'transparent',
                      fontSize: 11, fontWeight: 700, color: 'var(--cyan)',
                      cursor: addingId === m.google_id ? 'wait' : 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                    title={`Adicionar ${m.name || 'essa pessoa'} como amigo`}
                  >
                    {addingId === m.google_id ? '…' : '+ amigo'}
                  </button>
                )
              )}
              {canActOnMember && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handleRole(m, isAdmin ? 'member' : 'admin')}
                    disabled={busyId === m.google_id}
                    style={{
                      padding: '6px 10px', borderRadius: 8,
                      border: '1px solid var(--border)', background: 'var(--white)',
                      fontSize: 11, fontWeight: 600, color: 'var(--charcoal)',
                      cursor: busyId === m.google_id ? 'wait' : 'pointer',
                    }}
                    title={isAdmin ? 'Tirar admin' : 'Tornar admin'}
                  >
                    {busyId === m.google_id ? '…' : isAdmin ? 'Tirar admin' : 'Tornar admin'}
                  </button>
                  <button
                    onClick={() => handleRemove(m)}
                    disabled={busyId === m.google_id}
                    style={{
                      padding: '6px 10px', borderRadius: 8,
                      border: '1px solid #FFCDD2', background: 'var(--white)',
                      fontSize: 11, fontWeight: 600, color: '#C62828',
                      cursor: busyId === m.google_id ? 'wait' : 'pointer',
                    }}
                    title="Remover do canal"
                  >
                    Remover
                  </button>
                </div>
              )}
                </div>
              </div>
            </div>
          )
        })}
        {members.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--charcoal-light)', fontSize: 13 }}>
            Nenhum membro ainda.
          </div>
        )}
      </div>
    </BottomSheet>
  )
}
