import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import Avatar from '../components/Avatar'
import AttendeesRow from '../components/AttendeesRow'
import { shareLink, appLink } from '../lib/share'
import {
  fetchGroupDetail, createGroupEvent, deleteGroupEvent,
  leaveGroup, deleteGroup, getGroupCalendarFeedUrl, syncRsvp, fetchEvents, updateGroup,
  setGroupMemberRole,
} from '../services/api'

export default function GroupDetail() {
  const { groupId } = useParams()
  const { state, dispatch } = useApp()
  const t = useT()
  const navigate = useNavigate()
  const googleId = state.googleUser?.id

  const [group, setGroup] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showInvite, setShowInvite] = useState(false)
  const [showCalendar, setShowCalendar] = useState(false)
  const [showAddEvent, setShowAddEvent] = useState(false)
  const [showCatalog, setShowCatalog]   = useState(false)
  const [showMembers, setShowMembers]   = useState(false)
  // Hero drawer for an individual group event. We hold the full event
  // object (not just the id) so the drawer has everything it needs
  // without a re-fetch — group payload already includes all events.
  const [selectedEvent, setSelectedEvent] = useState(null)
  // Inline rename — admin-only. nameEdit = null when not editing,
  // otherwise the draft string.
  const [nameEdit, setNameEdit] = useState(null)
  const [renaming, setRenaming] = useState(false)

  useEffect(() => {
    if (!googleId || !groupId) return
    fetchGroupDetail(groupId, googleId)
      .then(data => { setGroup(data); setLoading(false) })
      .catch(() => { setError('Failed to load group'); setLoading(false) })
  }, [groupId, googleId])

  async function handleAddEvent(eventData) {
    const newEvent = await createGroupEvent(groupId, googleId, eventData)
    setGroup(prev => ({ ...prev, events: [...prev.events, newEvent] }))
    setShowAddEvent(false)
  }

  async function handleDeleteEvent(eventId) {
    await deleteGroupEvent(groupId, eventId, googleId)
    setGroup(prev => ({ ...prev, events: prev.events.filter(e => e.id !== eventId) }))
  }

  async function handleRename() {
    const trimmed = (nameEdit || '').trim()
    if (!trimmed || trimmed === group.name) {
      setNameEdit(null)
      return
    }
    setRenaming(true)
    try {
      await updateGroup(groupId, googleId, { name: trimmed })
      setGroup(prev => ({ ...prev, name: trimmed }))
      setNameEdit(null)
    } catch {
      alert('Falha ao renomear o grupo. Tenta de novo.')
    }
    setRenaming(false)
  }

  async function handleLeave() {
    await leaveGroup(groupId, googleId)
    navigate('/groups')
  }

  async function handleDelete() {
    // Two-step confirmation. The group has events + members + a shared
    // calendar feed; one stray tap shouldn't take it all out. Spell out
    // exactly what'll be lost so the admin doesn't claim ambush later.
    const memberCount = group?.members?.length ?? 0
    const eventCount = group?.events?.length ?? 0
    const warning =
      `⚠️ CUIDADO\n\n` +
      `Você está prestes a apagar o grupo "${group?.name}" PARA TODO MUNDO.\n\n` +
      `Vão sumir:\n` +
      `• ${memberCount} membro${memberCount === 1 ? '' : 's'}\n` +
      `• ${eventCount} evento${eventCount === 1 ? '' : 's'} de grupo\n` +
      `• O feed de calendário e o link de convite\n\n` +
      `Essa ação não pode ser desfeita.\n\n` +
      `Quer mesmo apagar?`
    if (!window.confirm(warning)) return
    // Second step — typed confirm for groups with any content. Empty
    // throwaway groups skip this so testers don't get stuck.
    if (memberCount > 1 || eventCount > 0) {
      const typed = window.prompt(`Pra confirmar, digite o nome do grupo:\n\n"${group?.name}"`)
      if ((typed || '').trim() !== (group?.name || '').trim()) {
        alert('Nome não bateu — ação cancelada.')
        return
      }
    }
    try {
      await deleteGroup(groupId, googleId)
      navigate('/groups')
    } catch {
      alert(t.groups_delete_error ?? 'Could not delete the group.')
    }
  }

  function handleRsvp(event) {
    const eventId = event.id
    const willBeRsvped = !state.rsvps[eventId]
    dispatch({
      type: 'TOGGLE_RSVP',
      payload: {
        eventId,
        dateStart: event.date_start || event.dateStart || '',
        name: event.name,
        venue: event.venue || '',
      },
    })
    syncRsvp(googleId, {
      id: eventId, name: event.name, venue: event.venue || '',
      date: event.date_start || '', url: '',
    }, willBeRsvped)
  }

  if (loading) return <p style={{ textAlign: 'center', marginTop: 60, color: 'var(--charcoal-mid)' }}>{t.events_loading}</p>
  if (error || !group) return <p style={{ textAlign: 'center', marginTop: 60, color: '#e74c3c' }}>{error || 'Group not found'}</p>

  const isAdmin = group.role === 'admin'
  const feedUrl = getGroupCalendarFeedUrl(group.feed_token)
  const now = new Date().toISOString()
  const upcomingEvents = (group.events || []).filter(e => e.date_start >= now.slice(0, 10))
  const pastEvents = (group.events || []).filter(e => e.date_start < now.slice(0, 10))

  return (
    <div style={{ padding: '16px 16px 100px' }}>
      {/* Back button */}
      <button onClick={() => navigate('/groups')} style={backBtnStyle}>
        ← {t.groups_back}
      </button>

      {/* Header — admin can rename inline by tapping the name */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 28 }}>👥</span>
          {nameEdit !== null ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <input
                value={nameEdit}
                onChange={e => setNameEdit(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleRename()
                  if (e.key === 'Escape') setNameEdit(null)
                }}
                autoFocus maxLength={80}
                disabled={renaming}
                style={{
                  flex: 1, fontSize: 20, fontWeight: 700, color: 'var(--charcoal)',
                  padding: '4px 10px', borderRadius: 8,
                  border: '1.5px solid var(--sage)', background: 'white', outline: 'none',
                }}
              />
              <button
                onClick={handleRename}
                disabled={renaming}
                style={{
                  background: 'var(--sage)', color: 'white', border: 'none',
                  padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                  fontSize: 13, fontWeight: 700,
                }}
              >
                ✓
              </button>
              <button
                onClick={() => setNameEdit(null)}
                disabled={renaming}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 14, color: 'var(--charcoal-light)', padding: 4,
                }}
              >
                ✕
              </button>
            </div>
          ) : (
            <>
              <h1
                onClick={() => isAdmin && setNameEdit(group.name)}
                title={isAdmin ? 'Tocar pra renomear' : undefined}
                style={{
                  fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', margin: 0,
                  cursor: isAdmin ? 'pointer' : 'default',
                }}
              >
                {group.name}
              </h1>
              {isAdmin && (
                <button
                  onClick={() => setNameEdit(group.name)}
                  title="Renomear grupo"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 12, color: 'var(--charcoal-light)', padding: 2,
                  }}
                >
                  ✎
                </button>
              )}
              {group.visibility === 'private' && <span>🔒</span>}
            </>
          )}
        </div>
        {group.description && (
          <p style={{ fontSize: 13, color: 'var(--charcoal-mid)', marginTop: 4, marginLeft: 38 }}>{group.description}</p>
        )}
      </div>

      {/* Member avatars — tap to open the full members list. The whole
          row + count is one tap target since avatars overlap and stacking
          a per-avatar handler felt cluttered. */}
      <button
        onClick={() => setShowMembers(true)}
        aria-label="Ver todos os membros"
        style={{
          display: 'flex', alignItems: 'center', marginBottom: 16,
          flexWrap: 'wrap', background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', textAlign: 'left',
        }}
      >
        {(group.members || []).slice(0, 8).map((m, i) => (
          <div
            key={m.google_id}
            title={m.name}
            style={{
              marginLeft: i > 0 ? -8 : 0,
              boxShadow: '0 0 0 2px white',
              borderRadius: '50%',
            }}
          >
            <Avatar name={m.name} src={m.picture} size={32} />
          </div>
        ))}
        <span style={{
          fontSize: 12, color: 'var(--charcoal-mid)', marginLeft: 8,
          textDecoration: 'underline', textDecorationColor: 'var(--border)',
          textUnderlineOffset: 3,
        }}>
          {group.members?.length} {t.groups_members}
        </span>
      </button>

      {/* Action buttons. Inviting is admin-only — admins manage the
          guest list (promote/demote happens in MembersSheet). Members
          can still see who's in via the members header tap. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {isAdmin && (
          <ActionBtn label={`💬 ${t.groups_invite}`} onClick={() => setShowInvite(true)} />
        )}
        <ActionBtn label={`📅 ${t.groups_calendar}`} onClick={() => setShowCalendar(true)} />
        <ActionBtn label="🌍 Do catálogo" onClick={() => setShowCatalog(true)} />
        <ActionBtn label={`+ ${t.groups_add_event}`} onClick={() => setShowAddEvent(true)} accent />
      </div>

      {/* Upcoming events */}
      <h2 style={sectionTitleStyle}>{t.groups_next_event} ({upcomingEvents.length})</h2>
      {upcomingEvents.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--charcoal-light)', marginBottom: 20 }}>{t.groups_no_events}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {upcomingEvents.map(ev => (
            <EventCard key={ev.id} event={ev} isRsvped={!!state.rsvps[ev.id]}
              onOpen={() => setSelectedEvent(ev)}
              onRsvp={() => handleRsvp(ev)} onDelete={isAdmin || ev.created_by === googleId ? () => handleDeleteEvent(ev.id) : null}
              members={group.members} t={t} />
          ))}
        </div>
      )}

      {/* Past events */}
      {pastEvents.length > 0 && (
        <>
          <h2 style={{ ...sectionTitleStyle, color: 'var(--charcoal-light)' }}>Past ({pastEvents.length})</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20, opacity: 0.6 }}>
            {pastEvents.map(ev => (
              <EventCard key={ev.id} event={ev} isRsvped={!!state.rsvps[ev.id]} past
                onOpen={() => setSelectedEvent(ev)}
                members={group.members} t={t} />
            ))}
          </div>
        </>
      )}

      {/* Footer actions */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
        <button onClick={handleLeave} style={{ ...textBtnStyle, color: '#e74c3c' }}>
          {t.groups_leave}
        </button>
        {isAdmin && (
          <button onClick={handleDelete} style={{ ...textBtnStyle, color: '#e74c3c', marginLeft: 16 }}>
            {t.groups_delete}
          </button>
        )}
      </div>

      {/* Sheets */}
      <InviteSheet open={showInvite} onClose={() => setShowInvite(false)} group={group} t={t} />
      <CalendarSheet open={showCalendar} onClose={() => setShowCalendar(false)} group={group} feedUrl={feedUrl} t={t} />
      <AddEventSheet open={showAddEvent} onClose={() => setShowAddEvent(false)} onSave={handleAddEvent} t={t} />
      <CatalogPickerSheet open={showCatalog} onClose={() => setShowCatalog(false)} onPick={handleAddEvent} />
      <MembersSheet
        open={showMembers}
        onClose={() => setShowMembers(false)}
        group={group}
        t={t}
        viewerIsAdmin={isAdmin}
        viewerGoogleId={googleId}
        onRoleChanged={() => {
          // Re-pull the group so the updated role propagates to the
          // header chip, action-bar gating, and the open MembersSheet.
          fetchGroupDetail(groupId, googleId).then(setGroup).catch(() => {})
        }}
      />
      <GroupEventHero
        event={selectedEvent}
        group={group}
        googleId={googleId}
        isRsvped={selectedEvent ? !!state.rsvps[selectedEvent.id] : false}
        canDelete={selectedEvent ? (isAdmin || selectedEvent.created_by === googleId) : false}
        onClose={() => setSelectedEvent(null)}
        onRsvp={() => selectedEvent && handleRsvp(selectedEvent)}
        onDelete={async () => {
          if (!selectedEvent) return
          await handleDeleteEvent(selectedEvent.id)
          setSelectedEvent(null)
        }}
        t={t}
      />
    </div>
  )
}


function EventCard({ event, isRsvped, onOpen, onRsvp, onDelete, past, t, members }) {
  // Find who added the event using the group's member list — the same
  // payload `created_by` that the backend stamps. Fallback: hide if we
  // can't resolve (member left the group, etc.).
  const creator = (members || []).find(m => m.google_id === event.created_by)

  // Catalog imports have "Ver original: <url>" appended to description.
  // Strip it for the card preview; the drawer surfaces the link properly.
  const cleanDesc = (event.description || '').replace(/\n*Ver original:.*$/, '').trim()

  return (
    <div
      onClick={onOpen}
      style={{
        background: 'white', borderRadius: 14, padding: '12px 14px',
        border: '1px solid var(--border)',
        cursor: onOpen ? 'pointer' : 'default',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--charcoal)' }}>{event.name}</div>
          {event.venue && <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 2 }}>📍 {event.venue}</div>}
          <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 2 }}>
            📅 {event.date_start?.slice(0, 10)} {event.date_start?.slice(11, 16)}
          </div>
          {cleanDesc && <div style={{ fontSize: 12, color: 'var(--charcoal-light)', marginTop: 4 }}>{cleanDesc}</div>}
          {event.note && (
            <div style={{
              marginTop: 8, padding: '8px 11px',
              background: 'var(--cream)',
              borderLeft: '3px solid var(--terra)',
              borderRadius: 8,
              fontSize: 12, color: 'var(--charcoal)',
              lineHeight: 1.45,
              fontStyle: 'italic',
            }}>
              💬 {event.note}
            </div>
          )}
          {creator && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginTop: 8,
              fontSize: 11, color: 'var(--charcoal-light)',
            }}>
              <Avatar name={creator.name} src={creator.picture} size={18} />
              <span>Adicionado por <strong style={{ color: 'var(--charcoal-mid)' }}>{creator.name}</strong></span>
            </div>
          )}
        </div>
        {!past && onRsvp && (
          <button
            onClick={e => { e.stopPropagation(); onRsvp() }}
            style={{
              padding: '6px 14px', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: isRsvped ? 'var(--sage)' : 'var(--cream)', color: isRsvped ? 'white' : 'var(--charcoal)',
            }}
          >
            {isRsvped ? t.events_rsvped : t.events_rsvp}
          </button>
        )}
      </div>
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{ fontSize: 11, color: '#e74c3c', background: 'none', border: 'none', cursor: 'pointer', marginTop: 6 }}
        >
          Delete
        </button>
      )}
    </div>
  )
}


function ActionBtn({ label, onClick, accent }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 14px', borderRadius: 10, border: accent ? 'none' : '1.5px solid var(--border)',
      background: accent ? 'var(--sage)' : 'none', color: accent ? 'white' : 'var(--charcoal)',
      fontSize: 12, fontWeight: 600, cursor: 'pointer',
    }}>
      {label}
    </button>
  )
}


function InviteSheet({ open, onClose, group, t }) {
  const [copied, setCopied] = useState(false)
  const [shareStatus, setShareStatus] = useState(null)
  const inviteUrl = appLink(`/join/${group.invite_code}`)

  function handleCopyCode() {
    navigator.clipboard.writeText(group.invite_code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleShare() {
    const result = await shareLink({
      url: inviteUrl,
      title: 'auê',
      text: `Bora entrar no grupo "${group.name}" no auê?`,
    })
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
    const msg = `Bora pro grupo "${group.name}" no auê! 🎉 ${inviteUrl}`
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


function CalendarSheet({ open, onClose, group, feedUrl, t }) {
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


function AddEventSheet({ open, onClose, onSave, t }) {
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [dateEnd, setDateEnd] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState('members')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim() || !dateStart) return
    setSaving(true)
    try {
      await onSave({ name: name.trim(), venue: venue.trim(), date_start: dateStart, date_end: dateEnd || null, description: description.trim(), visibility })
      setName(''); setVenue(''); setDateStart(''); setDateEnd(''); setDescription(''); setVisibility('members')
    } finally {
      setSaving(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t.groups_add_event}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={labelStyle}>{t.groups_event_name}</label>
        <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} required />

        <label style={labelStyle}>{t.groups_event_venue}</label>
        <input value={venue} onChange={e => setVenue(e.target.value)} style={inputStyle} />

        <label style={labelStyle}>{t.groups_event_date}</label>
        <input type="datetime-local" value={dateStart} onChange={e => setDateStart(e.target.value)} style={inputStyle} required />

        <label style={labelStyle}>{t.groups_event_end}</label>
        <input type="datetime-local" value={dateEnd} onChange={e => setDateEnd(e.target.value)} style={inputStyle} />

        <label style={labelStyle}>{t.groups_event_desc}</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'none' }} />

        <label style={labelStyle}>{t.groups_event_visibility}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {['members', 'public'].map(v => (
            <button key={v} type="button" onClick={() => setVisibility(v)} style={{
              flex: 1, padding: '9px', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: visibility === v ? 'var(--sage)' : 'var(--cream)',
              color: visibility === v ? 'white' : 'var(--charcoal)', fontWeight: 600, fontSize: 12,
            }}>
              {v === 'members' ? `🔒 ${t.groups_event_members}` : `🌍 ${t.groups_event_public}`}
            </button>
          ))}
        </div>

        <button type="submit" disabled={saving || !name.trim() || !dateStart} style={{
          padding: '13px 0', borderRadius: 14, border: 'none',
          background: 'var(--sage)', color: 'white', fontSize: 14, fontWeight: 600, cursor: 'pointer', marginTop: 4,
        }}>
          {saving ? '...' : t.groups_event_save}
        </button>
      </form>
    </BottomSheet>
  )
}


// ── Catalog picker — import a public Curitiba event into this group ──
//
// Loads the upcoming events catalog (same source as the Events tab),
// hides AI-curated entries (catalog convention), and lets the member
// search + tap one to add. Selected event is mirrored into group_events
// — name, venue, ISO start, description (with "Ver original" footer
// when a URL exists). Visibility defaults to 'members'.
function CatalogPickerSheet({ open, onClose, onPick }) {
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
        date_end: null,
        description: (desc + urlSuffix).slice(0, 1000),
        visibility: 'members',
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
                  background: 'white', border: '1px solid var(--border)',
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


// ── Shared components ──

// Full-screen "Hero" drawer for an individual group event. Mirrors the
// look of the catalog DetailPanel (Events tab) but reads directly from
// the group_events shape — no shape conversion, no extra fetch (the
// group payload already includes every event). Works the same whether
// the event is a user-created one or a catalog import; the catalog
// "Ver original" footer is parsed out of description and surfaced as
// a button.
function GroupEventHero({ event, group, googleId, isRsvped, canDelete, onClose, onRsvp, onDelete, t }) {
  const { state } = useApp()
  const open = !!event
  const [shareStatus, setShareStatus] = useState(null)

  // Hide the Companion FAB while the hero is up, same pattern as BottomSheet.
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: 1 } }))
    return () => window.dispatchEvent(new CustomEvent('aue-modal', { detail: { delta: -1 } }))
  }, [open])

  if (typeof document === 'undefined') return null

  // Pull "Ver original: <url>" out of description (catalog imports add it).
  const urlMatch = (event?.description || '').match(/Ver original:\s*(\S+)/)
  const sourceUrl = urlMatch ? urlMatch[1] : null
  const cleanDesc = (event?.description || '').replace(/\n*Ver original:.*$/, '').trim()
  const creator = event && (group?.members || []).find(m => m.google_id === event.created_by)

  const dateLabel = event?.date_start
    ? `${event.date_start.slice(0, 10)}${event.date_start.length > 10 ? ` · ${event.date_start.slice(11, 16)}` : ''}`
    : ''
  const isPublic = event?.visibility === 'public'

  async function handleShare() {
    if (!event) return
    // Always share the in-app deep link — keeps recipients in auê (and
    // reachable even when they're not in the group). The Events tab
    // reads `?event=<id>` and opens the hero drawer for both catalog
    // events and group events (backend's /events/{id} handles both
    // shapes; group ids are prefixed `grp_ev_`).
    const url = appLink(`/events?event=${encodeURIComponent(event.id)}`)
    const venueStr = event.venue ? ` no ${event.venue}` : ''
    const dateStr = dateLabel ? ` · ${dateLabel}` : ''
    const text = `${event.name}${venueStr}${dateStr}`
    const result = await shareLink({ url, title: event.name, text })
    setShareStatus(result)
    setTimeout(() => setShareStatus(null), 2200)
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="group-event-hero"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          style={{
            position: 'fixed', inset: 0,
            background: 'var(--cream)', zIndex: 1000,
            overflowY: 'auto', WebkitOverflowScrolling: 'touch',
          }}
        >
          {/* Hero band — sage gradient as default since group events have
              no headerBg from the catalog enrichment pipeline. */}
          <div style={{
            height: 130,
            background: sourceUrl
              ? 'linear-gradient(135deg, #E8623F 0%, #F08869 100%)'
              : 'linear-gradient(135deg, var(--sage) 0%, #9ec0a0 100%)',
            position: 'relative',
          }}>
            <button onClick={onClose} aria-label="Fechar" style={{
              position: 'absolute', top: 12, left: 12,
              width: 32, height: 32, borderRadius: '50%',
              background: 'rgba(255,255,255,0.92)', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
            }}>←</button>
            <div style={{ position: 'absolute', bottom: 12, left: 16, fontSize: 32 }}>
              {sourceUrl ? '🌍' : '📅'}
            </div>
          </div>

          {/* Content */}
          <div style={{ padding: '14px 20px calc(env(safe-area-inset-bottom, 0px) + 28px)' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 8 }}>
              {event?.name}
            </div>

            {/* Pills row: visibility + source */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '4px 10px', borderRadius: 8,
                background: isPublic ? 'var(--sage-pale)' : 'var(--terra-pale)',
                fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                color: isPublic ? 'var(--sage)' : 'var(--terra)',
                textTransform: 'uppercase',
              }}>
                {isPublic ? '🌍 Público' : '🔒 Só membros'}
              </span>
              {sourceUrl && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '4px 10px', borderRadius: 8,
                  background: 'rgba(232, 98, 63, 0.10)',
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                  color: 'var(--terra)', textTransform: 'uppercase',
                }}>
                  🌐 Do catálogo
                </span>
              )}
            </div>

            {/* Date + venue */}
            {dateLabel && (
              <div style={{ fontSize: 14, color: 'var(--charcoal)', marginBottom: 4 }}>
                📅 {dateLabel}
              </div>
            )}
            {event?.venue && (
              <div style={{ fontSize: 14, color: 'var(--charcoal)', marginBottom: 4 }}>
                📍 {event.venue}
              </div>
            )}

            {/* Description */}
            {cleanDesc && (
              <p style={{
                fontSize: 14, color: 'var(--charcoal-mid)',
                lineHeight: 1.5, marginTop: 12, whiteSpace: 'pre-wrap',
              }}>
                {cleanDesc}
              </p>
            )}

            {/* Free-text note from whoever added the event — shown
                prominently in the drawer so the crew sees the framing */}
            {event?.note && (
              <div style={{
                marginTop: 14, padding: '12px 14px',
                background: 'var(--cream)',
                borderLeft: '4px solid var(--terra)',
                borderRadius: 10,
                fontSize: 14, color: 'var(--charcoal)',
                lineHeight: 1.5,
                fontStyle: 'italic',
              }}>
                💬 {event.note}
              </div>
            )}

            {/* Adicionado por */}
            {creator && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginTop: 16,
                padding: '8px 12px', borderRadius: 12, background: 'white',
                border: '1px solid var(--border)',
              }}>
                <Avatar name={creator.name} src={creator.picture} size={28} />
                <span style={{ fontSize: 12, color: 'var(--charcoal-mid)' }}>
                  Adicionado por <strong style={{ color: 'var(--charcoal)' }}>{creator.name}</strong>
                </span>
              </div>
            )}

            {/* Quem vai — RSVP roster. Includes the viewer (if RSVPed) plus
                everyone else the backend will reveal (friends always, plus
                strangers who opted into showProfileToStrangers). Tap to
                expand the per-attendee list inside the row itself. */}
            <AttendeesRow
              eventId={event?.id}
              googleId={googleId}
              isRsvped={isRsvped}
              refreshKey={isRsvped ? 'rsvp-on' : 'rsvp-off'}
              viewerName={state.googleUser?.given_name || state.googleUser?.name || 'Você'}
              viewerPicture={state.googleUser?.picture}
              onFriend={(gid) => navigate(`/friends/${encodeURIComponent(gid)}`)}
            />

            {/* Actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 20 }}>
              {onRsvp && (
                <button onClick={onRsvp} style={{
                  padding: '13px', borderRadius: 14, border: 'none', cursor: 'pointer',
                  background: isRsvped ? 'var(--sage)' : 'var(--cream)',
                  color: isRsvped ? 'white' : 'var(--charcoal)',
                  fontSize: 14, fontWeight: 700,
                }}>
                  {isRsvped ? `✓ ${t.events_rsvped}` : t.events_rsvp}
                </button>
              )}

              <button onClick={handleShare} style={{
                padding: '13px', borderRadius: 14, border: '1.5px solid var(--border)',
                background: 'white', color: 'var(--charcoal)',
                fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}>
                {shareStatus === 'shared' ? '✓ Compartilhado'
                  : shareStatus === 'copied' ? '✓ Link copiado'
                  : shareStatus === 'failed' ? '✕ Não consegui compartilhar'
                  : '📤 Compartilhar'}
              </button>

              {sourceUrl && (
                <a href={sourceUrl} target="_blank" rel="noopener noreferrer" style={{
                  padding: '13px', borderRadius: 14,
                  background: 'white', border: '1.5px solid var(--border)',
                  fontSize: 14, fontWeight: 600,
                  color: 'var(--terra)', textAlign: 'center',
                  textDecoration: 'none',
                }}>
                  🔗 Ver original
                </a>
              )}

              {canDelete && (
                <button onClick={onDelete} style={{
                  padding: '11px', borderRadius: 14, border: 'none',
                  background: 'none', color: '#e74c3c',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}>
                  Excluir evento
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

// Portaled to document.body so the sheet anchors to the real viewport
// instead of being clipped by AnimatedPage's stacking context (framer-
// motion sets an inline transform, which makes it the containing block
// for `position: fixed` descendants — that's what was hiding the
// "Criar evento" button on smaller phones).
// Full members list — uses the BottomSheet pattern but with a taller
// max height since the list can be long. Each row is a hero-sized avatar
// + name + admin/member role badge + joined date. Sorted: admins first,
// then by joined_at ASC (oldest first), so the founder always reads
// at the top.
function MembersSheet({ open, onClose, group, t, viewerIsAdmin, viewerGoogleId, onRoleChanged }) {
  const members = group?.members || []
  const sorted = [...members].sort((a, b) => {
    const ra = (a.role === 'admin') ? 0 : 1
    const rb = (b.role === 'admin') ? 0 : 1
    if (ra !== rb) return ra - rb
    return (a.joined_at || '').localeCompare(b.joined_at || '')
  })
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

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
      // Optimistic refresh — let parent re-fetch the group so the role
      // chip + admin-only affordances update everywhere.
      onRoleChanged?.()
    } catch (e) {
      setError(e?.message || 'Não consegui atualizar o papel')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={`${members.length} ${t.groups_members}`}>
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
            <div key={m.google_id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 4px',
            }}>
              <Avatar name={m.name} src={m.picture} size={48} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 14, fontWeight: 600, color: 'var(--charcoal)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {m.name || m.google_id}
                </div>
                {m.joined_at && (
                  <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2 }}>
                    Entrou em {fmtJoinedAt(m.joined_at)}
                  </div>
                )}
              </div>
              {isAdmin && (
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                  color: 'var(--terra)', background: 'var(--terra-pale)',
                  padding: '3px 8px', borderRadius: 6,
                  textTransform: 'uppercase', flexShrink: 0,
                }}>
                  Admin
                </span>
              )}
              {canActOnMember && (
                <button
                  onClick={() => handleRole(m, isAdmin ? 'member' : 'admin')}
                  disabled={busyId === m.google_id}
                  style={{
                    padding: '6px 10px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'white',
                    fontSize: 11, fontWeight: 600, color: 'var(--charcoal)',
                    cursor: busyId === m.google_id ? 'wait' : 'pointer',
                    flexShrink: 0,
                  }}
                  title={isAdmin ? 'Tirar admin' : 'Tornar admin'}
                >
                  {busyId === m.google_id ? '…' : isAdmin ? 'Tirar admin' : 'Tornar admin'}
                </button>
              )}
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


function BottomSheet({ open, onClose, title, children }) {
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
            onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 999 }} />
          <motion.div key="sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'white',
              borderRadius: '20px 20px 0 0',
              padding: '8px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
              zIndex: 1000, maxHeight: '85vh', overflowY: 'auto',
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

function SheetButton({ icon, label, sublabel, onClick, accent }) {
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

// ── Styles ──

const backBtnStyle = {
  background: 'none', border: 'none', fontSize: 14, fontWeight: 600,
  color: 'var(--charcoal-mid)', cursor: 'pointer', marginBottom: 12, padding: 0,
}

const sectionTitleStyle = {
  fontSize: 14, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 10,
}

const textBtnStyle = {
  background: 'none', border: 'none', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', padding: 0,
}

const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--charcoal-mid)' }

const inputStyle = {
  width: '100%', padding: '11px 14px', borderRadius: 12,
  border: '1.5px solid var(--border)', fontSize: 14,
  outline: 'none', boxSizing: 'border-box',
}
