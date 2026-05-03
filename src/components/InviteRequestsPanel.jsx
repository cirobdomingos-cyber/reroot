import { useEffect, useState } from 'react'
import {
  fetchEventInviteRequests,
  acceptEventInviteRequest,
  rejectEventInviteRequest,
} from '../services/api'
import Avatar from './Avatar'

// Inline panel on the event hero showing pending invite requests for
// creator + co-hosts to accept or reject. Hidden when the viewer isn't
// authorized OR when there are zero pending requests (so the hero
// stays clean for the typical case). Polls on mount + after each
// action to keep counts fresh; no continuous polling — the push
// notification system already alerts the creator about new requests.
export default function InviteRequestsPanel({ eventId, googleId, canManage }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)

  async function refresh() {
    if (!canManage || !eventId || !googleId) {
      setLoading(false)
      return
    }
    try {
      const { requests: rs } = await fetchEventInviteRequests(eventId, googleId)
      setRequests(rs || [])
    } catch {
      // Silent — section just stays empty.
    }
    setLoading(false)
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, googleId, canManage])

  async function handleAccept(req) {
    if (busyId) return
    setBusyId(req.google_id)
    try {
      await acceptEventInviteRequest(eventId, req.google_id, googleId)
      // Remove from list locally; backend already pushed to requester.
      setRequests(prev => prev.filter(r => r.google_id !== req.google_id))
    } catch {
      alert('Falha ao aceitar. Tenta de novo.')
    }
    setBusyId(null)
  }

  async function handleReject(req) {
    if (busyId) return
    if (!confirm(`Recusar pedido de ${req.name}? Ele(a) não vai poder pedir de novo.`)) return
    setBusyId(req.google_id)
    try {
      await rejectEventInviteRequest(eventId, req.google_id, googleId)
      setRequests(prev => prev.filter(r => r.google_id !== req.google_id))
    } catch {
      alert('Falha ao recusar. Tenta de novo.')
    }
    setBusyId(null)
  }

  if (!canManage || loading || requests.length === 0) return null

  return (
    <div style={{
      marginTop: 14, padding: '12px 14px',
      background: 'var(--terra-pale)', borderRadius: 12,
      border: '1px solid var(--terra)',
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
        color: 'var(--terra)', textTransform: 'uppercase',
        marginBottom: 10,
      }}>
        📩 Pedidos pendentes · {requests.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {requests.map(r => (
          <div key={r.google_id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--white)', borderRadius: 10, padding: '8px 10px',
          }}>
            <Avatar name={r.name} src={r.picture} size={32} />
            <div style={{
              flex: 1, minWidth: 0,
              fontSize: 13, fontWeight: 600, color: 'var(--charcoal)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {r.name}
            </div>
            <button
              onClick={() => handleAccept(r)}
              disabled={busyId === r.google_id}
              style={{
                padding: '6px 10px', borderRadius: 8,
                border: 'none', background: 'var(--sage)', color: '#14081E',
                fontSize: 11, fontWeight: 700,
                cursor: busyId === r.google_id ? 'wait' : 'pointer',
              }}
            >
              Aceitar
            </button>
            <button
              onClick={() => handleReject(r)}
              disabled={busyId === r.google_id}
              style={{
                padding: '6px 10px', borderRadius: 8,
                border: '1px solid #FFCDD2', background: 'var(--white)',
                color: '#C62828', fontSize: 11, fontWeight: 700,
                cursor: busyId === r.google_id ? 'wait' : 'pointer',
              }}
            >
              Recusar
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
