import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { joinGroup, lookupGroupInvite } from '../services/api'

// Landing screen for group invite links: /#/join/<code>
//
// Flow:
//   1. Look up the group's public info from the code (no commit yet).
//   2. Show "Entrar no grupo X?" with a confirm/cancel.
//   3. On confirm, call /groups/join.
//
// Different from the old auto-join behavior — users now actively decide.
// Reduces accidental joins from clicking a link by mistake.

export default function JoinGroup() {
  const { inviteCode } = useParams()
  const { state } = useApp()
  const navigate = useNavigate()
  const googleId = state.googleUser?.id

  // 'looking-up' | 'ready' | 'no_auth' | 'not_found' | 'joining' | 'success' | 'already' | 'error'
  const [status, setStatus] = useState('looking-up')
  const [group, setGroup] = useState(null)

  useEffect(() => {
    if (!inviteCode) { setStatus('not_found'); return }
    let cancelled = false
    lookupGroupInvite(inviteCode).then(data => {
      if (cancelled) return
      if (!data) { setStatus('not_found'); return }
      setGroup(data)
      if (!googleId) setStatus('no_auth')
      else setStatus('ready')
    })
    return () => { cancelled = true }
  }, [inviteCode, googleId])

  async function confirmJoin() {
    if (!googleId || !inviteCode) return
    setStatus('joining')
    try {
      const result = await joinGroup(googleId, inviteCode)
      if (result.status === 'ok') setStatus('success')
      else if (result.status === 'already_member') setStatus('already')
      else setStatus('not_found')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '40px 24px',
    }}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        style={{ textAlign: 'center', maxWidth: 360, width: '100%' }}
      >
        {status === 'looking-up' && <Loading />}
        {status === 'not_found' && <NotFound onBack={() => navigate('/community')} />}
        {status === 'no_auth' && (
          <NeedSignIn group={group} onSignIn={() => navigate('/profile')} />
        )}
        {status === 'ready' && (
          <Confirm group={group} onConfirm={confirmJoin} onCancel={() => navigate('/community')} />
        )}
        {status === 'joining' && <Loading text="Entrando…" />}
        {(status === 'success' || status === 'already') && (
          <Success
            group={group}
            already={status === 'already'}
            onOpen={() => navigate(`/groups/${group.id}`)}
          />
        )}
        {status === 'error' && (
          <ErrorState onRetry={confirmJoin} onBack={() => navigate('/community')} />
        )}
      </motion.div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────

function GroupCard({ group, big = false }) {
  return (
    <div style={{
      background: 'var(--cream)', borderRadius: 16,
      padding: big ? '20px 18px' : '14px 16px',
      border: '1px solid var(--border)',
      marginBottom: 20, textAlign: 'left',
    }}>
      <div style={{
        fontSize: big ? 18 : 15, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4,
      }}>
        👥 {group?.name || 'Grupo'}
      </div>
      {group?.description && (
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 6 }}>
          {group.description}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
        {group?.member_count || 0} {(group?.member_count || 0) === 1 ? 'membro' : 'membros'}
        {group?.visibility === 'public' && ' · Público'}
        {group?.visibility === 'private' && ' · Privado'}
      </div>
    </div>
  )
}

function Loading({ text = 'Carregando…' }) {
  return (
    <>
      <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
      <div style={{ fontSize: 14, color: 'var(--charcoal-mid)' }}>{text}</div>
    </>
  )
}

function NotFound({ onBack }) {
  return (
    <>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🤷</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Grupo não encontrado</div>
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 24 }}>
        Esse convite não existe ou já foi revogado. Peça um novo pra quem te chamou.
      </div>
      <SecondaryBtn label="Voltar" onClick={onBack} />
    </>
  )
}

function NeedSignIn({ group, onSignIn }) {
  return (
    <>
      <GroupCard group={group} big />
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 20 }}>
        Pra entrar no grupo, faça login com Google primeiro.
      </div>
      <PrimaryBtn label="Entrar com Google" onClick={onSignIn} />
    </>
  )
}

function Confirm({ group, onConfirm, onCancel }) {
  return (
    <>
      <GroupCard group={group} big />
      <div style={{ fontSize: 14, color: 'var(--charcoal-mid)', marginBottom: 20 }}>
        Entrar nesse grupo?
      </div>
      <PrimaryBtn label="Entrar no grupo" onClick={onConfirm} />
      <div style={{ height: 10 }} />
      <SecondaryBtn label="Agora não" onClick={onCancel} />
    </>
  )
}

function Success({ group, already, onOpen }) {
  return (
    <>
      <div style={{ fontSize: 32, marginBottom: 12 }}>{already ? '👥' : '🎉'}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
        {already ? 'Você já está nesse grupo' : `Bem-vindo a ${group?.name || 'esse grupo'}!`}
      </div>
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 24 }}>
        Os eventos do grupo aparecem na Home + na tela do grupo.
      </div>
      <PrimaryBtn label="Abrir grupo →" onClick={onOpen} />
    </>
  )
}

function ErrorState({ onRetry, onBack }) {
  return (
    <>
      <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Falhou</div>
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 24 }}>
        Não consegui te adicionar agora. Tenta de novo em uns segundos.
      </div>
      <PrimaryBtn label="Tentar de novo" onClick={onRetry} />
      <div style={{ height: 10 }} />
      <SecondaryBtn label="Voltar" onClick={onBack} />
    </>
  )
}

function PrimaryBtn({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', padding: '13px 24px', borderRadius: 14, border: 'none',
        background: 'var(--sage)', color: '#14081E',
        fontSize: 15, fontWeight: 700, cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

function SecondaryBtn({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', padding: '13px 24px', borderRadius: 14,
        border: '1.5px solid var(--border)', background: 'var(--white)',
        color: 'var(--charcoal-mid)',
        fontSize: 15, fontWeight: 600, cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}
