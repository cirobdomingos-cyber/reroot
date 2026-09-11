import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { useT } from '../i18n'
import Avatar from '../components/Avatar'
import HomeEventRow from '../components/HomeEventRow'
import EditEventSheet from '../components/EditEventSheet'
import PersonalPlanSheet from '../components/PersonalPlanSheet'
import EventDetail, { EventDetailDrawer } from '../components/EventDetail'
import { shareLink, appLink } from '../lib/share'
import {
  fetchGroupDetail, createGroupEvent, deleteGroupEvent,
  leaveGroup, deleteGroup, getGroupCalendarFeedUrl, syncRsvp, fetchEvents, updateGroup,
  setGroupMemberRole, removeGroupMember, fetchGroupStats, fetchFriendsFeed,
  getFriends, addFriendById, BASE_URL,
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
  // Edit-event sheet target. null = sheet closed.
  const [editingEvent, setEditingEvent] = useState(null)
  const [showCalendar, setShowCalendar] = useState(false)
  const [showAddEvent, setShowAddEvent] = useState(false)
  const [showCatalog, setShowCatalog]   = useState(false)
  const [showMembers, setShowMembers]   = useState(false)
  const [stats, setStats]               = useState(null)
  // Hero drawer for an individual group event. We hold the full event
  // object (not just the id) so the drawer has everything it needs
  // without a re-fetch — group payload already includes all events.
  const [selectedEvent, setSelectedEvent] = useState(null)
  // Inline rename — admin-only. nameEdit = null when not editing,
  // otherwise the draft string.
  const [nameEdit, setNameEdit] = useState(null)
  const [renaming, setRenaming] = useState(false)
  // event_id → [{name, picture, google_id}] so each event card can show
  // the same friends-going avatar stack as Home + RSVPs. Sourced from
  // /friends/feed; the backend already gates group events behind
  // membership so anything that comes back here is safe to render.
  const [friendsByEventId, setFriendsByEventId] = useState({})

  useEffect(() => {
    if (!googleId || !groupId) return
    fetchGroupDetail(groupId, googleId)
      .then(data => { setGroup(data); setLoading(false) })
      .catch(() => { setError('Failed to load group'); setLoading(false) })
    fetchGroupStats(groupId, googleId).then(s => s && setStats(s))
    fetchFriendsFeed(googleId).then(events => {
      const map = {}
      for (const ev of (events || [])) {
        if (ev.event_id && Array.isArray(ev.friends_going) && ev.friends_going.length) {
          map[ev.event_id] = ev.friends_going
        }
      }
      setFriendsByEventId(map)
    })
  }, [groupId, googleId])

  // Catalog picker path: the user picked an existing catalog event to
  // fork into this group, so this screen still does the create. Distinct
  // from handleEventCreated below, where the shared sheet has already
  // created the row and just hands it back.
  async function handleAddEvent(eventData) {
    const newEvent = await createGroupEvent(groupId, googleId, eventData)
    setGroup(prev => ({ ...prev, events: [...(prev?.events || []), newEvent] }))
    fetchGroupStats(groupId, googleId).then(s => s && setStats(s))
  }

  // The shared sheet creates the event itself and hands back the row.
  // It also lets the user disconnect the group mid-flow (the subset
  // escape hatch), in which case what comes back is a standalone plan
  // that does NOT belong to this group — so only splice it into the
  // group's list when it actually carries this group's id.
  function handleEventCreated(newEvent) {
    const belongsHere = newEvent?.group_id === groupId ||
      (newEvent?.group_ids || []).includes(groupId)
    if (belongsHere) {
      setGroup(prev => ({ ...prev, events: [...(prev?.events || []), newEvent] }))
    }
    fetchGroupStats(groupId, googleId).then(s => s && setStats(s))
  }

  async function handleDeleteEvent(eventId) {
    await deleteGroupEvent(groupId, eventId, googleId)
    setGroup(prev => ({ ...prev, events: prev.events.filter(e => e.id !== eventId) }))
    fetchGroupStats(groupId, googleId).then(s => s && setStats(s))
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
        dateStart: event.dateStart || event.dateStart || '',
        name: event.name,
        venue: event.venue || '',
      },
    })
    syncRsvp(googleId, {
      id: eventId, name: event.name, venue: event.venue || '',
      date: event.dateStart || '', url: '',
    }, willBeRsvped)
  }

  if (loading) return <p style={{ textAlign: 'center', marginTop: 60, color: 'var(--charcoal-mid)' }}>{t.events_loading}</p>
  if (error || !group) return <p style={{ textAlign: 'center', marginTop: 60, color: '#e74c3c' }}>{error || 'Group not found'}</p>

  const isAdmin = group.role === 'admin'
  const feedUrl = getGroupCalendarFeedUrl(group.feed_token)
  const now = new Date().toISOString()
  const upcomingEvents = (group.events || []).filter(e => e.dateStart >= now.slice(0, 10))
  const pastEvents = (group.events || []).filter(e => e.dateStart < now.slice(0, 10))

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
                  border: '1.5px solid var(--sage)', background: 'var(--white)', outline: 'none',
                }}
              />
              <button
                onClick={handleRename}
                disabled={renaming}
                style={{
                  background: 'var(--sage)', color: '#14081E', border: 'none',
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
              {/* Lifetime event count pill — feeds into the crew_quente
                  badge ladder. Lives on the header so the metric is
                  always in sight, not buried inside Mural do grupo. */}
              {stats && stats.events_total > 0 && (
                <span
                  title={`${stats.events_total} eventos no histórico do grupo`}
                  style={{
                    fontSize: 11, fontWeight: 700, color: 'var(--terra)',
                    background: 'var(--terra-pale)',
                    padding: '3px 8px', borderRadius: 999,
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}
                >
                  📅 {stats.events_total}
                </span>
              )}
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
              boxShadow: '0 0 0 2px var(--bg2)',
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

      {/* Group stats — only shown when there's been activity, otherwise
          we'd be staring at a wall of zeros for fresh groups. Members-only
          on the backend; non-members can't even hit this endpoint. */}
      {stats && stats.events_total > 0 && (
        <GroupStatsPanel stats={stats} />
      )}

      {/* Upcoming events */}
      <h2 style={sectionTitleStyle}>{t.groups_next_event} ({upcomingEvents.length})</h2>
      {upcomingEvents.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--charcoal-light)', marginBottom: 20 }}>{t.groups_no_events}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {upcomingEvents.map(ev => (
            <EventCard key={ev.id} event={ev} isRsvped={!!state.rsvps[ev.id]}
              friends={friendsByEventId[ev.id] || []}
              onOpen={() => setSelectedEvent(ev)}
              onRsvp={() => handleRsvp(ev)} onDelete={isAdmin || ev.createdBy === googleId ? () => handleDeleteEvent(ev.id) : null}
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
                friends={friendsByEventId[ev.id] || []}
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
      {/* Same sheet as the Home CTA, with this group pre-connected.
          GroupDetail used to ship its own near-duplicate (AddEventSheet),
          which drifted: no "recado" field, and no warning that invited
          outsiders can't see the group. One sheet, one place to fix. */}
      <PersonalPlanSheet
        open={showAddEvent}
        onClose={() => setShowAddEvent(false)}
        googleId={googleId}
        initialGroupId={groupId}
        onCreated={handleEventCreated}
      />
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
      {/* Same detail view AND the same chrome as the Events feed — see
          components/EventDetail.jsx for why the group copy is gone. */}
      <EventDetailDrawer
        open={!!selectedEvent}
        onClose={() => setSelectedEvent(null)}
        idLabel={selectedEvent ? String(selectedEvent.id || '').slice(-4).toUpperCase() : ''}
      >
      {selectedEvent && (
      <EventDetail
        event={selectedEvent}
        googleId={googleId}
        viewerName={state.userName}
        viewerPicture={state.googleUser?.picture}
        rsvped={selectedEvent ? !!state.rsvps[selectedEvent.id] : false}
        canInvite={selectedEvent ? (
          selectedEvent.createdBy === googleId
          || (selectedEvent.coHostIds || []).includes(googleId)
        ) : false}
        canEdit={selectedEvent ? (
          selectedEvent.createdBy === googleId
          || (selectedEvent.coHostIds || []).includes(googleId)
        ) : false}
        onClose={() => setSelectedEvent(null)}
        onRsvp={() => selectedEvent && handleRsvp(selectedEvent)}
        onDelete={selectedEvent && (
          isAdmin
          || selectedEvent.createdBy === googleId
          || (selectedEvent.coHostIds || []).includes(googleId)
        ) ? async () => {
          await handleDeleteEvent(selectedEvent.id)
          setSelectedEvent(null)
        } : null}
        onInvited={({ invitee_google_ids }) => {
          // Mirror the new invitee list into the group's events array so
          // the next time the hero opens (or the user re-renders), the
          // "already invited" set is current and the picker filters
          // them out. AttendeesRow refresh is handled inside the hero.
          setGroup(prev => prev ? {
            ...prev,
            events: prev.events.map(e =>
              e.id === selectedEvent?.id
                ? { ...e, extraInviteeIds: invitee_google_ids }
                : e
            ),
          } : prev)
          setSelectedEvent(prev => prev && prev.id === selectedEvent?.id
            ? { ...prev, extraInviteeIds: invitee_google_ids }
            : prev)
        }}
        onCoHostsChanged={(newCoHostIds) => {
          setGroup(prev => prev ? {
            ...prev,
            events: prev.events.map(e =>
              e.id === selectedEvent?.id
                ? { ...e, coHostIds: newCoHostIds }
                : e
            ),
          } : prev)
          setSelectedEvent(prev => prev && prev.id === selectedEvent?.id
            ? { ...prev, coHostIds: newCoHostIds }
            : prev)
        }}
        onImageChanged={(newImageUrl) => {
          // Backend returns either '' (cleared) or '/event-images/...'
          // (set). Local-state mirroring keeps the hero responsive
          // without a fetchGroupDetail round-trip.
          setGroup(prev => prev ? {
            ...prev,
            events: prev.events.map(e =>
              e.id === selectedEvent?.id
                ? { ...e, imageUrl: newImageUrl || null }
                : e
            ),
          } : prev)
          setSelectedEvent(prev => prev && prev.id === selectedEvent?.id
            ? { ...prev, imageUrl: newImageUrl || null }
            : prev)
        }}
        onEdit={selectedEvent && (
          selectedEvent.createdBy === googleId
          || (selectedEvent.coHostIds || []).includes(googleId)
        ) ? () => setEditingEvent(selectedEvent) : null}
        t={t}
      />
      )}
      </EventDetailDrawer>

      <EditEventSheet
        open={!!editingEvent}
        onClose={() => setEditingEvent(null)}
        event={editingEvent}
        googleId={googleId}
        onSaved={(updatedRow) => {
          setGroup(prev => prev ? {
            ...prev,
            events: prev.events.map(e =>
              e.id === updatedRow.id ? { ...e, ...updatedRow } : e
            ),
          } : prev)
          setSelectedEvent(prev => prev && prev.id === updatedRow.id
            ? { ...prev, ...updatedRow }
            : prev)
        }}
      />
    </div>
  )
}


function EventCard({ event, isRsvped, onOpen, onRsvp, onDelete, past, t, members, friends = [] }) {
  // Find who added the event using the group's member list — the same
  // payload `created_by` that the backend stamps. Fallback: hide if we
  // can't resolve (member left the group, etc.).
  const creator = (members || []).find(m => m.google_id === event.createdBy)

  // Date column + ribbon come from the shared HomeEventRow so groups
  // read the same as Home and RSVPs. The trailing slot carries the
  // RSVP toggle (or "Já foi" pill for past). The note callout +
  // creator attribution + delete control sit below the row inside
  // the same outer container.
  const time = (event.dateStart || '').slice(11, 16)
  const friendsStack = friends.length > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {friends.slice(0, 3).map((f, i) => (
        <div
          key={(f.google_id || f.name) + i}
          style={{
            marginLeft: i === 0 ? 0 : -8,
            boxShadow: '0 0 0 2px var(--bg2)',
            borderRadius: '50%',
          }}
        >
          <Avatar name={f.name} src={f.picture} size={22} />
        </div>
      ))}
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--terra)', marginLeft: 5 }}>
        {friends.length}
      </span>
    </div>
  ) : null
  const statusOrAction = past
    ? (
      <span style={{
        fontSize: 10, fontWeight: 700, color: 'var(--charcoal-light)',
        background: 'var(--cream)', padding: '4px 8px', borderRadius: 6,
      }}>
        Já foi
      </span>
    )
    : onRsvp
    ? (
      <button
        onClick={e => { e.stopPropagation(); onRsvp() }}
        style={{
          padding: '6px 12px', borderRadius: 10, border: 'none',
          fontSize: 11, fontWeight: 700, cursor: 'pointer',
          background: isRsvped ? 'var(--sage)' : 'var(--cream)',
          color: isRsvped ? 'var(--on-lime)' : 'var(--charcoal)',
        }}
      >
        {isRsvped ? t.events_rsvped : t.events_rsvp}
      </button>
    )
    : null
  const trailing = (friendsStack || statusOrAction) ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {friendsStack}
      {statusOrAction}
    </div>
  ) : null

  // Group event rows always render with the group/plan accent (sage
  // ribbon + sage day number) — they're never catalog single events.
  return (
    <div>
      <HomeEventRow
        name={event.name}
        dateStart={event.dateStart}
        time={time}
        venue={event.venue}
        isGroupEvent
        onClick={onOpen}
        muted={past}
        trailing={trailing}
      />
      {event.note && (
        <div style={{
          margin: '6px 0 0 8px', padding: '8px 11px',
          background: 'var(--cream)',
          borderLeft: '3px solid var(--terra)',
          borderRadius: 8,
          fontSize: 12, color: 'var(--charcoal)',
          lineHeight: 1.45, fontStyle: 'italic',
        }}>
          💬 {event.note}
        </div>
      )}
      {creator && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          margin: '6px 0 0 8px',
          fontSize: 11, color: 'var(--charcoal-light)',
        }}>
          <Avatar name={creator.name} src={creator.picture} size={18} />
          <span>Adicionado por <strong style={{ color: 'var(--charcoal-mid)' }}>{creator.name}</strong></span>
        </div>
      )}
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{
            fontSize: 11, color: '#e74c3c', background: 'none',
            border: 'none', cursor: 'pointer', marginTop: 4, marginLeft: 8,
          }}
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
      background: accent ? 'var(--sage)' : 'none', color: accent ? 'var(--on-lime)' : 'var(--charcoal)',
      fontSize: 12, fontWeight: 600, cursor: 'pointer',
    }}>
      {label}
    </button>
  )
}

// "Mural do grupo" — at-a-glance counters + the most active organizer.
// Lightweight panel, four cards for the headline numbers and one row for
// the top organizer when there is one. Hidden by the parent for empty
// groups so the very first event still feels like an arrival, not a
// dashboard with zeros.
function GroupStatsPanel({ stats }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{
        fontSize: 13, fontWeight: 700, color: 'var(--charcoal-mid)',
        textTransform: 'uppercase', letterSpacing: 0.6,
        margin: '0 0 8px',
      }}>
        Mural do grupo
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


// ── Shared components ──

// Full-screen "Hero" drawer for an individual group event. Mirrors the
// look of the catalog DetailPanel (Events tab) but reads directly from
// the group_events shape — no shape conversion, no extra fetch (the
// group payload already includes every event). Works the same whether
// the event is a user-created one or a catalog import; the catalog
// "Ver original" footer is parsed out of description and surfaced as
// a button.

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
  // Who the viewer is already friends with, so the list can offer
  // "+ amigo" only where it means something. Fetched when the sheet
  // opens rather than lifted into GroupDetail — nothing else on the
  // screen needs it.
  const [friendIds, setFriendIds] = useState(new Set())
  const [addingId, setAddingId] = useState(null)

  useEffect(() => {
    if (!open || !viewerGoogleId) return
    let cancelled = false
    getFriends(viewerGoogleId).then(list => {
      if (cancelled) return
      setFriendIds(new Set((Array.isArray(list) ? list : []).map(f => f.google_id)))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [open, viewerGoogleId])

  // POST /friends/add-by-id auto-accepts, same as the invite-code flow —
  // adding someone you're already in a group with is a deliberate act, so
  // there's no request to wait on. Optimistic: flip the row immediately
  // and put it back if the call fails.
  async function handleAddFriend(member) {
    setError(null)
    setAddingId(member.google_id)
    setFriendIds(prev => new Set([...prev, member.google_id]))
    try {
      const res = await addFriendById(viewerGoogleId, member.google_id)
      if (res?.status && !['ok', 'already_friends'].includes(res.status)) {
        throw new Error('Não consegui adicionar')
      }
    } catch (e) {
      setFriendIds(prev => {
        const next = new Set(prev)
        next.delete(member.google_id)
        return next
      })
      setError(e?.message || 'Não consegui adicionar como amigo')
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
    if (!confirm(`Remover ${member.name || member.google_id} do grupo?`)) return
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
                    title="Remover do grupo"
                  >
                    Remover
                  </button>
                </div>
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
            onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 10500 }} />
          <motion.div key="sheet" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
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
