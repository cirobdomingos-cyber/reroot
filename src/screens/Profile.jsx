import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp, myPicture } from '../context/AppContext'
import { compressImageForUpload } from '../lib/image-compress'
import { useT } from '../i18n'
import { mountGoogleButton, isGoogleConfigured, MOCK_GOOGLE_USER } from '../lib/google-auth'
import { signInWithApple, isAppleSignInAvailable } from '../lib/apple-auth'
import { Capacitor } from '@capacitor/core'
import { API_BASE } from '../lib/apiBase'
import { getPublicOrigin } from '../lib/share'
import { fetchUserStats, deleteUserAccount, uploadAvatar } from '../services/api'
import { usePushNotifications, isPushSupported } from '../lib/usePushNotifications'
import Avatar from '../components/Avatar'
import Aue from '../components/Aue'

const heroPillStyle = {
  padding: '7px 14px', borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.35)',
  background: 'rgba(255,255,255,0.08)', color: 'white',
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
}

export default function Profile() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(state.userName)
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  // Account deletion has two entry points — next to the email at the top
  // (where App Review looks for it, per Guideline 5.1.1(v)) and in the
  // settings footer. Both drive the same confirmation block, so the top
  // link expands it and scrolls it into view rather than duplicating the UI.
  const deleteSectionRef = useRef(null)
  function saveName() {
    if (nameInput.trim()) dispatch({ type: 'SET_NAME', payload: nameInput.trim() })
    setEditingName(false)
  }

  // Profile photo. Compressed on the device first (phone photos are
  // 3–6MB; the server caps uploads at 5MB after compression).
  const photoInputRef = useRef(null)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  async function handlePhotoPicked(e) {
    const file = e.target.files?.[0]
    e.target.value = ''  // picking the same file again should still fire
    if (!file || !state.googleUser?.id) return
    setUploadingPhoto(true)
    try {
      const compressed = await compressImageForUpload(file)
      const { picture } = await uploadAvatar(state.googleUser.id, compressed)
      dispatch({ type: 'SET_CUSTOM_PICTURE', payload: picture })
    } catch (err) {
      alert(err?.message || 'Não deu pra trocar a foto. Tenta de novo.')
    } finally {
      setUploadingPhoto(false)
    }
  }

  function handleReset() {
    dispatch({ type: 'RESET' })
    window.location.hash = '/'
    window.location.reload()
  }

  function openDeleteConfirm() {
    setDeleteConfirm(true)
    // Wait for the confirmation block to render before scrolling to it.
    setTimeout(() => {
      deleteSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  async function handleDeleteAccount() {
    const googleId = state.googleUser?.id
    if (!googleId) { handleReset(); return }
    setDeletingAccount(true)
    try {
      await deleteUserAccount(googleId)
    } catch (_) {
      // Ignore network errors — still wipe local state so user is unblocked
    } finally {
      setDeletingAccount(false)
      setDeleteConfirm(false)
      dispatch({ type: 'RESET' })
      window.location.hash = '/'
      window.location.reload()
    }
  }

  return (
    <div>
      {/* Sign-in card — only when no Google account is connected. Lets
          users who skipped onboarding sign in later (needed for curator
          access, friend code, RSVP sync). */}
      {!state.googleUser && <SignInCard dispatch={dispatch} />}

      {/* Hero — Neon Boteco palette: dark bg2 base with cyan + magenta
          radial gradients in opposite corners (mirrors the community
          card on Home, the event hero in Detail). */}
      <div style={{
        background:
          'radial-gradient(circle at 20% 20%, rgba(255, 43, 214, 0.35) 0%, transparent 55%),' +
          ' radial-gradient(circle at 80% 80%, rgba(0, 229, 255, 0.30) 0%, transparent 55%),' +
          ' var(--bg2)',
        borderBottom: '1px solid var(--line)',
        padding: '20px 24px 28px', textAlign: 'center', color: 'var(--text)',
      }}>
        {/* Photo — tap the picture (or the camera badge) to change it.
            Signed-in only: the upload is tied to the account. */}
        <div style={{ margin: '0 auto 12px', width: 88, position: 'relative' }}>
          <button
            onClick={() => state.googleUser && photoInputRef.current?.click()}
            disabled={!state.googleUser || uploadingPhoto}
            aria-label="Trocar foto"
            style={{
              background: 'none', border: 'none', padding: 0, borderRadius: '50%',
              cursor: state.googleUser ? 'pointer' : 'default',
              opacity: uploadingPhoto ? 0.5 : 1, display: 'block',
            }}
          >
            <Avatar
              src={myPicture(state)}
              name={state.userName || state.googleUser?.givenName || state.googleUser?.name}
              size={88}
              bordered
            />
          </button>
          {state.googleUser && (
            <button
              onClick={() => photoInputRef.current?.click()}
              disabled={uploadingPhoto}
              aria-label="Trocar foto"
              style={{
                position: 'absolute', right: -2, bottom: -2,
                width: 30, height: 30, borderRadius: '50%',
                background: 'var(--cyan)', color: '#14081E',
                border: '2px solid var(--bg2)', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', padding: 0,
              }}
            >
              {uploadingPhoto ? '…' : '📷'}
            </button>
          )}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            onChange={handlePhotoPicked}
            style={{ display: 'none' }}
          />
        </div>

        {editingName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveName()
                if (e.key === 'Escape') setEditingName(false)
              }}
              autoFocus maxLength={30}
              placeholder="Seu nome"
              style={{
                fontSize: 18, fontWeight: 700, color: 'white',
                background: 'rgba(255,255,255,0.12)',
                border: '1.5px solid var(--cyan)',
                borderRadius: 10, padding: '6px 12px',
                outline: 'none', textAlign: 'center', width: 180,
              }}
            />
            <button
              onClick={saveName}
              style={{
                padding: '8px 12px', borderRadius: 10, border: 'none',
                background: 'var(--cyan)', color: '#14081E',
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            >Salvar</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{state.userName || '—'}</div>
            {/* Name is what friends and groups see — the old "✎" was a
                12px glyph at 35% opacity that nobody found. */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <button
                onClick={() => { setNameInput(state.userName || ''); setEditingName(true) }}
                style={heroPillStyle}
              >
                ✎ Editar nome
              </button>
              {state.googleUser && (
                <button
                  onClick={() => photoInputRef.current?.click()}
                  disabled={uploadingPhoto}
                  style={heroPillStyle}
                >
                  {uploadingPhoto ? 'Enviando…' : '📷 Trocar foto'}
                </button>
              )}
              {state.customPicture && !uploadingPhoto && (
                <button
                  onClick={() => {
                    if (confirm('Voltar pra foto da sua conta?')) {
                      dispatch({ type: 'SET_CUSTOM_PICTURE', payload: '' })
                    }
                  }}
                  style={{ ...heroPillStyle, borderColor: 'transparent', color: 'rgba(255,255,255,0.55)' }}
                >
                  remover foto
                </button>
              )}
            </div>
          </>
        )}

        {state.googleUser?.email && (
          <div style={{
            fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            {state.googleUser.email}
            <button
              onClick={() => {
                if (confirm('Sair da conta Google? Você pode voltar a entrar quando quiser.')) {
                  dispatch({ type: 'SET_GOOGLE_USER', payload: null })
                }
              }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.55)', fontSize: 11, padding: 0,
                textDecoration: 'underline',
              }}
            >
              sair
            </button>
            <span style={{ color: 'rgba(255,255,255,0.25)' }}>·</span>
            <button
              onClick={openDeleteConfirm}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.55)', fontSize: 11, padding: 0,
                textDecoration: 'underline',
              }}
            >
              deletar conta
            </button>
          </div>
        )}
      </div>

      {/* Compartilhar / Instalar — drives PWA distribution to friends */}
      <ShareInstallSection />

      {/* Notifications — high on the screen so the push opt-in is an
          early decision. It used to sit below Privacy at the bottom,
          which left it discoverable only to people who scrolled into
          settings. */}
      <NotificationsCard t={t} state={state} dispatch={dispatch} />

      {/* Conquistas removed from the UI Sep 2026. The backend keeps
          awarding and storing them (badges.py, /badges/*), so the
          history is intact if it comes back — this is a display
          decision, not a data one. */}

      {/* Recordes — lifetime counters that only go up. No streak anxiety. */}
      <RecordsSection googleId={state.googleUser?.id} />

      {/* Feedback — only visible to users granted the feedbacker role */}
      <FeedbackSection state={state} />

      {/* Settings you set once and forget: language, accessibility,
          privacy. They used to sit open in the middle of the screen,
          which made the whole thing read as a settings dump.
          Notifications stays outside — it's an opt-in people need to
          stumble on. */}
      <SettingsGroup t={t}>

      {/* Language toggle */}
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 12 }}>
          {t.profile_language_label}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { code: 'pt', label: '🇧🇷  Português' },
            { code: 'en', label: '🇺🇸  English' },
          ].map(({ code, label }) => (
            <button
              key={code}
              onClick={() => dispatch({ type: 'SET_LANGUAGE', payload: code })}
              style={{
                flex: 1, padding: '10px 0', borderRadius: 12, fontSize: 13, fontWeight: 600,
                cursor: 'pointer', transition: 'all 0.15s',
                border: state.language === code ? 'none' : '1.5px solid var(--border)',
                background: state.language === code ? 'var(--charcoal)' : 'transparent',
                color: state.language === code ? 'var(--on-light)' : 'var(--charcoal-mid)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Accessibility mode toggle */}
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
              {t.accessibility_mode}
            </div>
            <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
              {t.accessibility_description}
            </div>
          </div>
          <button
            onClick={() => dispatch({ type: 'TOGGLE_ACCESSIBILITY' })}
            style={{
              width: 52, height: 30, borderRadius: 15, border: 'none',
              background: state.accessibilityMode ? 'var(--sage)' : 'var(--border)',
              cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
              flexShrink: 0, marginLeft: 12,
            }}
          >
            <div style={{
              width: 24, height: 24, borderRadius: '50%', background: 'var(--white)',
              position: 'absolute', top: 3,
              left: state.accessibilityMode ? 25 : 3,
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
            }} />
          </button>
        </div>
      </div>

      {/* Privacy settings */}
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 12 }}>
          🔒 {t.privacy_title ?? 'Privacy'}
        </div>
        {[
          { key: 'shareRsvps',              label: t.privacy_share_rsvps ?? 'Share RSVPs with friends',         desc: t.privacy_share_rsvps_desc ?? 'Your friends can see events you confirmed' },
          { key: 'showInFriendSuggestions', label: t.privacy_show_suggestions ?? 'Appear in friend suggestions', desc: t.privacy_show_suggestions_desc ?? 'Other people can find your profile' },
          { key: 'showProfileToStrangers',  label: t.privacy_show_profile ?? 'Profile visible to non-friends',   desc: t.privacy_show_profile_desc ?? 'Non-friends can see your full profile' },
        ].map(({ key, label, desc }, i, arr) => {
          const value = state.privacy?.[key] ?? (key === 'shareRsvps' ? state.shareRsvps : false)
          return (
            <div
              key={key}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 0',
                borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <div style={{ flex: 1, paddingRight: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>{label}</div>
                <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2, lineHeight: 1.4 }}>{desc}</div>
              </div>
              <button
                onClick={() => dispatch({ type: 'SET_PRIVACY_OPTION', payload: { key, value: !value } })}
                style={{
                  width: 44, height: 26, borderRadius: 13, border: 'none',
                  background: value ? 'var(--sage)' : 'var(--border)',
                  position: 'relative', cursor: 'pointer', flexShrink: 0,
                  transition: 'background 0.2s',
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  background: 'var(--white)', position: 'absolute', top: 3,
                  left: value ? 21 : 3,
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>
          )
        })}
      </div>

      </SettingsGroup>

      {/* Transparency: link to the sources catalog */}
      <div style={{ margin: '0 16px 12px' }} className="card">
        <button
          onClick={() => navigate('/sources')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            width: '100%', textAlign: 'left', padding: 0,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
              📡 Fontes monitoradas
            </div>
            <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
              Veja de onde vem o catálogo do <Aue />.
            </div>
          </div>
          <span style={{ fontSize: 16, color: 'var(--charcoal-light)' }}>→</span>
        </button>
      </div>

      {/* Running-bundle diagnostic (native only). Down here with the
          other developer affordances — it's also where you find the
          device id to put in OTA_CANARY_DEVICES. */}
      <BundleInfo />

      {/* Redo onboarding + Reset (dev affordances) */}
      <div style={{ padding: '4px 16px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => {
            dispatch({ type: 'REDO_ONBOARDING' })
            navigate('/')
          }}
          style={{ fontSize: 12, color: 'var(--terra)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
        >
          {t.profile_redo_onboarding ?? 'Refazer onboarding'}
        </button>
        <button
          onClick={handleReset}
          style={{ fontSize: 11, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          {t.profile_reset}
        </button>

        {/* Account deletion — required by Apple Guideline 5.1.1(v) */}
        <div ref={deleteSectionRef} style={{ marginTop: 4 }}>
        {!deleteConfirm ? (
          <button
            onClick={openDeleteConfirm}
            style={{ fontSize: 12, color: 'var(--charcoal-mid)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
          >
            Deletar conta
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--bg2)', borderRadius: 10, border: '1px solid var(--line)' }}>
            <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.4 }}>
              Apaga teus RSVPs, amigos e histórico permanentemente.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setDeleteConfirm(false)}
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, border: '1px solid var(--line)', background: 'none', color: 'var(--charcoal-mid)', cursor: 'pointer' }}
              >
                Cancelar
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deletingAccount}
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, border: 'none', background: '#c0392b', color: '#fff', cursor: deletingAccount ? 'default' : 'pointer', opacity: deletingAccount ? 0.6 : 1 }}
              >
                {deletingAccount ? 'Deletando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}


// One collapsed row instead of three open cards of settings. Closed by
// default: these are decisions you make once.
function SettingsGroup({ t, children }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        className="card"
        style={{
          margin: '16px 16px 12px', width: 'calc(100% - 32px)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
          ⚙️ {t.profile_settings_label ?? 'Configurações'}
        </span>
        <span style={{ fontSize: 12, color: 'var(--charcoal-light)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && children}
    </>
  )
}


// ── Notifications card ──────────────────────────────────
//
// Subscribe-then-toggle pattern: the device must explicitly opt into
// push (browser perm + pushManager.subscribe + backend register) before
// the per-type toggles do anything. Without this gate, flipping
// "Resumo diário" ON would silently set a preference no channel can
// honor, and the user would assume push is broken.
function NotificationsCard({ t, state, dispatch }) {
  const { subscribed, subscribe, unsubscribe, loading, error } = usePushNotifications()
  const supported = isPushSupported()
  const dailyDigest = state.privacy?.dailyDigest ?? true

  if (!supported) {
    return (
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 8 }}>
          🔔 {t.notifications_title ?? 'Notificações'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5 }}>
          {t.notif_unsupported
            ?? 'Push não funciona neste navegador. Instale o auê na tela inicial (Adicionar à Tela de Início) ou use Chrome/Firefox.'}
        </div>
      </div>
    )
  }

  return (
    <div style={{ margin: '0 16px 12px' }} className="card">
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 12 }}>
        🔔 {t.notifications_title ?? 'Notificações'}
      </div>

      {/* Step 1 — device subscription. When already subscribed, shows a
          confirmation pill + a "Desativar" link. When not, shows a
          single primary CTA. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, paddingBottom: 12, marginBottom: 12,
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>
            {subscribed
              ? (t.notif_status_on ?? '✓ Push ativado neste dispositivo')
              : (t.notif_status_off ?? 'Push desativado')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2, lineHeight: 1.4 }}>
            {subscribed
              ? (t.notif_status_on_desc ?? 'Você vai receber as notificações abaixo nesse browser.')
              : (t.notif_status_off_desc ?? 'Ative pra receber pings de novos rolês e convites.')}
          </div>
          {error && (
            <div style={{ fontSize: 11, color: '#C62828', marginTop: 6 }}>
              {error}
            </div>
          )}
        </div>
        {subscribed ? (
          <button
            onClick={unsubscribe}
            disabled={loading}
            style={{
              fontSize: 11, fontWeight: 600,
              padding: '8px 12px', borderRadius: 8,
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--charcoal-mid)', cursor: 'pointer',
              opacity: loading ? 0.6 : 1, flexShrink: 0,
            }}
          >
            {loading ? '...' : (t.notif_disable ?? 'Desativar')}
          </button>
        ) : (
          <button
            onClick={subscribe}
            disabled={loading}
            style={{
              fontSize: 12, fontWeight: 700,
              padding: '10px 14px', borderRadius: 10, border: 'none',
              background: 'var(--sage)', color: '#14081E',
              cursor: 'pointer', opacity: loading ? 0.6 : 1, flexShrink: 0,
            }}
          >
            {loading ? '...' : (t.notif_enable ?? 'Ativar push')}
          </button>
        )}
      </div>

      {/* Step 2 — per-type toggles. Disabled (greyed) when not subscribed
          so users don't think they're armed. Clicking the disabled label
          could prompt to subscribe, but for v1 keep it simple — they
          tap "Ativar push" above first. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 0',
        opacity: subscribed ? 1 : 0.45,
      }}>
        <div style={{ flex: 1, paddingRight: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--charcoal)' }}>
            {t.notif_daily_digest ?? 'Resumo diário do auê'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 2, lineHeight: 1.4 }}>
            {t.notif_daily_digest_desc
              ?? 'Toda tarde, depois do scrape — uma push com os novos rolês de Curitiba. Toque pra ver o evento.'}
          </div>
        </div>
        <button
          onClick={() => {
            if (!subscribed) return
            dispatch({ type: 'SET_PRIVACY_OPTION', payload: { key: 'dailyDigest', value: !dailyDigest } })
          }}
          disabled={!subscribed}
          style={{
            width: 44, height: 26, borderRadius: 13, border: 'none',
            background: dailyDigest ? 'var(--sage)' : 'var(--border)',
            position: 'relative',
            cursor: subscribed ? 'pointer' : 'not-allowed',
            flexShrink: 0, transition: 'background 0.2s',
          }}
        >
          <div style={{
            width: 20, height: 20, borderRadius: '50%',
            background: 'var(--white)', position: 'absolute', top: 3,
            left: dailyDigest ? 21 : 3,
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }} />
        </button>
      </div>
    </div>
  )
}


// ── Feedback — open to any signed-in user ────────────────
function FeedbackSection({ state }) {
  const email = state.googleUser?.email
  const googleId = state.googleUser?.id
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState(null) // 'sent' | 'error' | null
  // API_BASE imported at module scope — see lib/apiBase.js

  async function submit() {
    if (text.trim().length < 5 || submitting) return
    setSubmitting(true)
    setStatus(null)
    try {
      const r = await fetch(`${API_BASE}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          context: window.location.hash || '',
          requesting_email: email,
          google_id: googleId || '',
        }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setText('')
      setStatus('sent')
      setTimeout(() => { setOpen(false); setStatus(null) }, 1500)
    } catch {
      setStatus('error')
    }
    setSubmitting(false)
  }

  if (!email) return null

  return (
    <div style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: open ? 12 : 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)' }}>
            💬 Mandar feedback
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>
            Sugestões, bugs, ideias — manda direto pra equipe.
          </div>
        </div>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 10, padding: '6px 12px', fontSize: 12, fontWeight: 600,
            color: 'var(--charcoal-mid)', cursor: 'pointer', flexShrink: 0, marginLeft: 12,
          }}
        >
          {open ? 'fechar' : 'abrir'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 6 }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="O que tá funcionando, o que tá travando, o que faltaria…"
            rows={4}
            maxLength={4000}
            style={{
              width: '100%', resize: 'vertical', minHeight: 80,
              padding: '10px 12px', borderRadius: 10,
              border: '1px solid var(--border)',
              fontSize: 13, fontFamily: 'inherit', outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 8, gap: 10,
          }}>
            <div style={{ fontSize: 11, color: status === 'sent' ? 'var(--sage)' : status === 'error' ? '#B71C1C' : 'var(--charcoal-light)' }}>
              {status === 'sent' ? 'Enviado, valeu! ✓'
                : status === 'error' ? 'Falhou — tenta de novo.'
                : `${text.length}/4000`}
            </div>
            <button
              onClick={submit}
              disabled={text.trim().length < 5 || submitting}
              style={{
                padding: '8px 16px', borderRadius: 10, border: 'none',
                background: 'var(--sage)', color: '#14081E',
                fontSize: 12, fontWeight: 700,
                cursor: text.trim().length < 5 || submitting ? 'not-allowed' : 'pointer',
                opacity: text.trim().length < 5 || submitting ? 0.5 : 1,
              }}
            >
              {submitting ? 'Enviando…' : 'Mandar'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}




// ── Share + Install (PWA distribution) ───────────────────
// Two complementary CTAs:
//   - "Compartilhar" uses Web Share API (mobile native sheet) with a
//     clipboard fallback. Always visible.
//   - "Instalar como app" only appears in browsers that fired the
//     beforeinstallprompt event (Chrome/Edge/Brave on Android+desktop).
//     iOS Safari never fires it — those users go to /install for the
//     manual Add to Home Screen walkthrough.
// Which JS bundle is actually running, on native only.
//
// Doubles as the live-update test: the TestFlight binary was built before
// this component existed, so if it appears on the phone at all, a bundle
// was downloaded and applied. After that it stays useful — "which version
// is this person actually on" is otherwise unanswerable once updates stop
// going through the App Store, and "did my fix reach them?" becomes the
// most common question to ask about a bug report.
function BundleInfo() {
  const [info, setInfo] = useState(null)

  useEffect(() => {
    if (!Capacitor.isNativePlatform?.()) return
    let cancelled = false
    import('@capgo/capacitor-updater')
      .then(async ({ CapacitorUpdater }) => {
        const current = await CapacitorUpdater.current()
        // The id OTA_CANARY_DEVICES lists to get a build before everyone
        // else (backend/ota.py, docs/RELEASE_PROCESS.md).
        const { deviceId } = await CapacitorUpdater.getDeviceId().catch(() => ({}))
        return { ...current, deviceId }
      })
      .then(res => { if (!cancelled) setInfo(res) })
      .catch(err => { if (!cancelled) setInfo({ error: String(err?.message || err) }) })
    return () => { cancelled = true }
  }, [])
  const [copied, setCopied] = useState(false)

  if (!info) return null
  // bundle.id === 'builtin' means no update has been applied and the app
  // is running the JS compiled into the binary.
  const onBuiltin = !info.error && (info.bundle?.id === 'builtin' || !info.bundle?.id)
  return (
    <div style={{
      margin: '14px 16px 0', padding: '10px 14px', borderRadius: 12,
      background: 'var(--bg2)', border: '1px solid var(--line)',
      fontSize: 11, color: 'var(--text3)', lineHeight: 1.5,
    }}>
      <span className="neon-mono" style={{ letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        Bundle
      </span>{' '}
      {info.error
        ? `indisponível (${info.error})`
        : onBuiltin
          ? `nativo ${info.native || ''} (sem atualização aplicada)`
          : `${info.bundle?.version || info.bundle?.id} · nativo ${info.native || ''}`}
      {info.deviceId && (
        <button
          onClick={() => {
            navigator.clipboard?.writeText(info.deviceId).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1800)
            }).catch(() => {})
          }}
          className="neon-mono"
          style={{
            display: 'block', marginTop: 4, padding: 0, background: 'none', border: 'none',
            color: 'var(--text3)', fontSize: 10, cursor: 'pointer', textAlign: 'left',
          }}
        >
          {copied ? '✓ id copiado' : `device ${info.deviceId}`}
        </button>
      )}
    </div>
  )
}

function ShareInstallSection() {
  const [canInstall, setCanInstall] = useState(
    typeof window !== 'undefined' && !!window.__aueDeferredInstallPrompt
  )
  const [feedback, setFeedback] = useState(null)
  const isStandalone = typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(display-mode: standalone)').matches

  useEffect(() => {
    function onAvailable() { setCanInstall(true) }
    function onInstalled() { setCanInstall(false) }
    window.addEventListener('aue-install-available', onAvailable)
    window.addEventListener('aue-install-installed', onInstalled)
    return () => {
      window.removeEventListener('aue-install-available', onAvailable)
      window.removeEventListener('aue-install-installed', onInstalled)
    }
  }, [])

  function flashFeedback(msg) {
    setFeedback(msg)
    setTimeout(() => setFeedback(null), 3000)
  }

  async function handleShare() {
    const url = `${getPublicOrigin()}/install`
    const text = 'Olha o auê — app de eventos em Curitiba. Bora ver o que tá rolando? 🎉'
    if (navigator.share) {
      try {
        await navigator.share({ title: 'auê — Curitiba que acontece', text, url })
      } catch {
        // User cancelled — silent
      }
      return
    }
    // Fallback: copy to clipboard
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url)
        flashFeedback('✓ Link copiado — cola onde quiser mandar.')
      } catch {
        flashFeedback('Não foi possível copiar — tenta colar manualmente: ' + url)
      }
    } else {
      window.prompt('Copie o link:', url)
    }
  }

  async function handleInstall() {
    const ev = window.__aueDeferredInstallPrompt
    if (!ev) return
    try {
      ev.prompt()
      const choice = await ev.userChoice
      if (choice?.outcome === 'accepted') flashFeedback('✓ Instalando…')
    } catch {
      // Browser rejected — likely already installed or blocked
    } finally {
      window.__aueDeferredInstallPrompt = null
      setCanInstall(false)
    }
  }

  return (
    <div style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
        📲 Compartilhar auê
      </div>
      <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginBottom: 12, lineHeight: 1.5 }}>
        {isStandalone
          ? 'Você já tem o auê instalado. Manda pra galera testar.'
          : 'Manda pros amigos pelo WhatsApp/SMS. Cada um instala como app no celular.'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={handleShare}
          style={{
            width: '100%', padding: '11px 14px',
            border: 'none', borderRadius: 12,
            background: 'radial-gradient(circle at 20% 20%, rgba(255, 43, 214, 0.35) 0%, transparent 55%), radial-gradient(circle at 80% 80%, rgba(0, 229, 255, 0.30) 0%, transparent 55%), var(--bg2)',
            color: 'white', fontWeight: 700, fontSize: 13,
            cursor: 'pointer', fontFamily: 'inherit',
            boxShadow: '0 4px 14px rgba(255, 43, 214, 0.25)',
          }}
        >
          Compartilhar com amigos
        </button>
        {canInstall && !isStandalone && (
          <button
            onClick={handleInstall}
            style={{
              width: '100%', padding: '11px 14px',
              border: '1.5px solid var(--terra)',
              borderRadius: 12, background: 'transparent',
              color: 'var(--terra)', fontWeight: 700, fontSize: 13,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            📥 Instalar como app
          </button>
        )}
      </div>
      {feedback && (
        <div style={{
          fontSize: 11, color: 'var(--sage)', marginTop: 8, textAlign: 'center',
          fontWeight: 600,
        }}>
          {feedback}
        </div>
      )}

    </div>
  )
}


// ── Recordes pessoais ────────────────────────────────────
// Lifetime / personal-best counters that only ever go up. Anxiety-free —
// no current-streak that can break, just the all-time best week run.
function RecordsSection({ googleId }) {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let canceled = false
    async function load() {
      const data = googleId ? await fetchUserStats(googleId) : null
      if (canceled) return
      setStats(data)
      setLoading(false)
    }
    load()
    // Recompute when a badge unlock fires — likely the underlying counters
    // also moved.
    function onUnlock() { if (googleId) fetchUserStats(googleId).then(setStats) }
    window.addEventListener('badge-unlocked', onUnlock)
    return () => {
      canceled = true
      window.removeEventListener('badge-unlocked', onUnlock)
    }
  }, [googleId])

  if (loading || !stats || !googleId) return null
  if (stats.total_rsvps === 0) return null  // no signal yet, hide section

  const cards = [
    { label: 'RSVPs no total',     value: stats.total_rsvps,                  icon: '🎟' },
    { label: 'Lugares diferentes', value: stats.distinct_venues,              icon: '📍' },
    { label: 'Bairros visitados',  value: stats.distinct_bairros,             icon: '🗺' },
    { label: 'Recorde de semanas', value: stats.best_week_streak,             icon: '🔥', sub: 'seguidas com RSVP' },
    stats.top_venue && {
      label: 'Lugar predileto', value: stats.top_venue, icon: '⭐',
      sub: `${stats.top_venue_count} RSVPs`,
    },
    stats.top_month && {
      label: 'Mês mais ativo', value: _formatMonth(stats.top_month), icon: '📅',
      sub: `${stats.top_month_count} eventos`,
    },
  ].filter(Boolean)

  return (
    <div style={{ margin: '16px 16px 0' }} className="card">
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
        📈 Recordes
      </div>
      <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginBottom: 12 }}>
        Números que só sobem — sem streak pra quebrar.
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
      }}>
        {cards.map(c => (
          <div key={c.label} style={{
            background: 'var(--cream)',
            border: '1px solid var(--terra-pale)',
            borderRadius: 12, padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: 2,
            minWidth: 0,
          }}>
            <div style={{ fontSize: 10, color: 'var(--charcoal-mid)', fontWeight: 600 }}>
              {c.icon} {c.label}
            </div>
            <div style={{
              fontSize: 18, fontWeight: 800, color: 'var(--charcoal)',
              lineHeight: 1.1,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {c.value}
            </div>
            {c.sub && (
              <div style={{ fontSize: 10, color: 'var(--charcoal-light)' }}>{c.sub}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function _formatMonth(yyyymm) {
  if (!yyyymm || !yyyymm.includes('-')) return yyyymm
  const [y, m] = yyyymm.split('-')
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
  const idx = parseInt(m, 10) - 1
  return idx >= 0 && idx < 12 ? `${months[idx]}/${y.slice(2)}` : yyyymm
}


// ── Sign-in card for unauthenticated users ────────────────
function SignInCard({ dispatch }) {
  const googleBtnRef = useRef(null)
  const googleConfigured = isGoogleConfigured()

  useEffect(() => {
    if (!googleConfigured) return
    const cleanup = mountGoogleButton(googleBtnRef, (googleUser) => {
      dispatch({ type: 'SET_GOOGLE_USER', payload: googleUser })
      if (googleUser.givenName || googleUser.name) {
        dispatch({
          type: 'SET_NAME',
          payload: googleUser.givenName || googleUser.name.split(' ')[0],
        })
      }
    })
    return cleanup
  }, [dispatch, googleConfigured])

  function handleMockSignIn() {
    dispatch({ type: 'SET_GOOGLE_USER', payload: MOCK_GOOGLE_USER })
    dispatch({ type: 'SET_NAME', payload: MOCK_GOOGLE_USER.givenName })
  }

  async function handleApple() {
    try {
      const user = await signInWithApple()
      dispatch({ type: 'SET_GOOGLE_USER', payload: user })
      if (user.givenName || user.name) {
        dispatch({ type: 'SET_NAME', payload: user.givenName || user.name?.split(' ')[0] || '' })
      }
    } catch (err) {
      if (err?.message && err.message !== 'Login cancelado.') {
        alert(err.message)
      }
    }
  }

  return (
    <div style={{
      margin: '14px 16px 0',
      background: 'var(--white)',
      borderRadius: 14,
      padding: 16,
      border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
        Entrar
      </div>
      <div style={{ fontSize: 12, color: 'var(--charcoal-light)', lineHeight: 1.5, marginBottom: 12 }}>
        Faça login pra salvar eventos, virar curador de Instagram e
        sincronizar entre dispositivos.
      </div>
      {googleConfigured ? (
        <div ref={googleBtnRef} style={{ marginBottom: 8 }} />
      ) : (
        <button
          onClick={handleMockSignIn}
          style={{
            width: '100%', padding: '10px 16px', marginBottom: 8,
            border: 'none', borderRadius: 10,
            background: 'var(--charcoal)', color: 'var(--on-light)',
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}
        >
          Entrar (modo demo)
        </button>
      )}
      {/* Apple Sign-In — white button style (one of Apple's three
          sanctioned variants), matching Onboarding's. This card's own
          background (--white) resolves to a dark violet in the "Neon
          Boteco" theme, so the black variant barely stood out from it. */}
      {isAppleSignInAvailable() && (
      <button
        onClick={handleApple}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 8, height: 40, borderRadius: 10,
          background: '#fff', color: '#000', border: 'none',
          fontSize: 14, fontWeight: 600,
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
          cursor: 'pointer',
        }}
      >
        {/* Apple's own logo glyph, from the system font (San Francisco) —
            not a redrawn path. HIG requires the mark come from Apple, and
            U+F8FF is how Apple ships it for exactly this use. */}
        <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>{'\uF8FF'}</span>
        <span>Continuar com Apple</span>
      </button>
      )}
    </div>
  )
}
