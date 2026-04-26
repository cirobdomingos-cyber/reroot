import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useApp } from '../context/AppContext'
import { addFriend, lookupFriendInvite } from '../services/api'
import Avatar from '../components/Avatar'
import Aue from '../components/Aue'

// Landing screen for friend invite links: /#/friend/<code>
//
// Flow:
//   1. Look up the inviter's profile from the code (no commit yet).
//   2. Show "Adicionar Maria como amiga?" with avatar + confirm/cancel.
//   3. On confirm, dispatch addFriend with the current user's google_id.
//
// If the user is not signed in, prompt them to sign in first — without an
// auth identity we can't create the friendship row.

export default function AddFriend() {
  const { code } = useParams()
  const navigate = useNavigate()
  const { state } = useApp()
  const myGoogleId = state.googleUser?.id

  // 'looking-up' | 'ready' | 'self' | 'not_found' | 'no_auth' | 'adding' | 'success' | 'already' | 'error'
  const [status, setStatus] = useState('looking-up')
  const [inviter, setInviter] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!code) { setStatus('not_found'); return }
    let cancelled = false
    lookupFriendInvite(code).then(data => {
      if (cancelled) return
      if (!data) {
        setStatus('not_found')
        return
      }
      setInviter(data)
      // If the link belongs to me, show a friendly message instead of letting me self-friend.
      if (myGoogleId && data.google_id === myGoogleId) {
        setStatus('self')
      } else if (!myGoogleId) {
        setStatus('no_auth')
      } else {
        setStatus('ready')
      }
    })
    return () => { cancelled = true }
  }, [code, myGoogleId])

  async function confirmAdd() {
    if (!myGoogleId || !code) return
    setStatus('adding')
    const result = await addFriend(myGoogleId, code)
    if (!result) {
      setErrorMsg('Falha de conexão com o servidor.')
      setStatus('error')
      return
    }
    if (result.status === 'ok') {
      setStatus('success')
    } else if (result.status === 'already_friends') {
      setStatus('already')
    } else if (result.status === 'self') {
      setStatus('self')
    } else {
      setStatus('not_found')
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
          <NeedSignIn inviter={inviter} onSignIn={() => navigate('/profile')} />
        )}
        {status === 'self' && (
          <SelfMessage onBack={() => navigate('/community')} />
        )}
        {status === 'ready' && (
          <Confirm inviter={inviter} onConfirm={confirmAdd} onCancel={() => navigate('/community')} />
        )}
        {status === 'adding' && <Loading text="Adicionando…" />}
        {(status === 'success' || status === 'already') && (
          <Success
            inviter={inviter}
            already={status === 'already'}
            onBack={() => navigate('/community')}
          />
        )}
        {status === 'error' && (
          <ErrorState message={errorMsg} onRetry={() => setStatus('ready')} onBack={() => navigate('/community')} />
        )}
      </motion.div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────

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
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Convite não encontrado</div>
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 24 }}>
        Esse código de amigo não existe (ou expirou). Peça pra te mandarem um link novo.
      </div>
      <SecondaryBtn label="Voltar" onClick={onBack} />
    </>
  )
}

function NeedSignIn({ inviter, onSignIn }) {
  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        <Avatar src={inviter?.picture} name={inviter?.name} size={72} />
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
        {inviter?.name || 'Alguém'} quer te adicionar
      </div>
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 24 }}>
        Pra aceitar e virar amigo, faça login com Google. Sem cadastro complicado.
      </div>
      <PrimaryBtn label="Entrar com Google" onClick={onSignIn} />
    </>
  )
}

function SelfMessage({ onBack }) {
  return (
    <>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🪞</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Esse é o seu próprio link</div>
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 24 }}>
        Compartilha ele com outras pessoas pra que elas possam te adicionar como amigo.
      </div>
      <SecondaryBtn label="Voltar" onClick={onBack} />
    </>
  )
}

function Confirm({ inviter, onConfirm, onCancel }) {
  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        <Avatar src={inviter?.picture} name={inviter?.name} size={84} />
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
        {inviter?.name || 'Pessoa'}
      </div>
      <div style={{ fontSize: 14, color: 'var(--charcoal-mid)', marginBottom: 24 }}>
        Adicionar como amigo no <Aue />?
      </div>
      <PrimaryBtn label="Adicionar" onClick={onConfirm} />
      <div style={{ height: 10 }} />
      <SecondaryBtn label="Agora não" onClick={onCancel} />
    </>
  )
}

function Success({ inviter, already, onBack }) {
  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        <Avatar src={inviter?.picture} name={inviter?.name} size={84} />
      </div>
      <div style={{ fontSize: 32, marginBottom: 8 }}>{already ? '👋' : '🎉'}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
        {already
          ? `Vocês já são amigos`
          : `${inviter?.name || 'Pessoa'} agora é seu amigo`}
      </div>
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 24 }}>
        Vocês vão aparecer um pro outro no feed de eventos.
      </div>
      <PrimaryBtn label="Ver meus amigos →" onClick={onBack} />
    </>
  )
}

function ErrorState({ message, onRetry, onBack }) {
  return (
    <>
      <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Algo deu errado</div>
      <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 24 }}>
        {message || 'Tenta de novo em alguns segundos.'}
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
        background: 'var(--sage)', color: 'white',
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
        border: '1.5px solid var(--border)', background: 'white',
        color: 'var(--charcoal-mid)',
        fontSize: 15, fontWeight: 600, cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}
