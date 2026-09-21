import { useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useApp, myPicture } from '../context/AppContext'
import { compressImageForUpload } from '../lib/image-compress'
import { uploadAvatar } from '../services/api'
import Avatar from './Avatar'

// Your photo, on every screen; tap it to change it.
//
// Asked for a long time ago: "deixar a foto do usuário em cima em todas
// as telas, se clicar já abre direto opção de mudar foto, em vez de ir
// pra aba perfil". It rides the page shell (AnimatedPage), so no screen
// has to know about it. Hidden on Perfil, which has its own photo UI,
// and when signed out, when there is no photo to be yours.
//
// Same path Perfil takes: compress on the device (phone photos are
// 3–6 MB; the server caps at 5 MB), upload, dispatch. If that ever
// changes it should change in one place — this component and Perfil
// both call the same two functions.
export default function AvatarCorner() {
  const { state, dispatch } = useApp()
  const { pathname } = useLocation()
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)

  const signedIn = !!state.googleUser?.id
  if (!signedIn || pathname.startsWith('/profile')) return null

  const name = state.userName || state.googleUser?.givenName || state.googleUser?.name || ''

  async function onPicked(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const compressed = await compressImageForUpload(file)
      const { picture } = await uploadAvatar(state.googleUser.id, compressed)
      dispatch({ type: 'SET_CUSTOM_PICTURE', payload: picture })
    } catch (err) {
      alert(err?.message || 'Não deu pra trocar a foto. Tenta de novo.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Trocar foto"
        aria-label="Trocar foto"
        data-testid="avatar-corner"
        style={{
          position: 'fixed',
          top: 'calc(10px + env(safe-area-inset-top, 0px))',
          right: 12,
          zIndex: 50,
          width: 36, height: 36, borderRadius: '50%',
          padding: 0, border: '1.5px solid var(--line)',
          background: 'var(--bg2)', cursor: busy ? 'wait' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy
          ? <span style={{ fontSize: 14, color: 'var(--text2)' }}>…</span>
          : <Avatar src={myPicture(state)} name={name} size={32} />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={onPicked}
        style={{ display: 'none' }}
      />
    </>
  )
}
