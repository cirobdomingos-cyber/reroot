import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp, computeBadges, computeCurrentWeek, getChapter, CHAPTERS } from '../context/AppContext'
import { useT } from '../i18n'
import { TIMELINE } from '../data/framework'
import { getMyFriendCode, addFriend, getFriends } from '../services/api'

export default function Profile() {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()
  const [referralCode, setReferralCode] = useState('')
  const [referralApplied, setReferralApplied] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(state.userName)
  const [showPauseSheet, setShowPauseSheet] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [paused, setPaused] = useState(state.isPaused)
  const [selectedBadge, setSelectedBadge] = useState(null)

  // Friends state
  const [friendCode, setFriendCode] = useState(null)
  const [friendCodeLoading, setFriendCodeLoading] = useState(false)
  const [friends, setFriends] = useState([])
  const [friendsLoading, setFriendsLoading] = useState(false)
  const [addCodeInput, setAddCodeInput] = useState('')
  const [addResult, setAddResult] = useState(null) // { status, friend_name? }
  const [addLoading, setAddLoading] = useState(false)

  const googleId = state.googleUser?.id

  useEffect(() => {
    if (!googleId) return
    setFriendCodeLoading(true)
    getMyFriendCode(googleId).then(code => {
      setFriendCode(code)
      setFriendCodeLoading(false)
    })
    setFriendsLoading(true)
    getFriends(googleId).then(list => {
      setFriends(list ?? [])
      setFriendsLoading(false)
    })
  }, [googleId])

  async function handleAddFriend() {
    if (!addCodeInput.trim() || !googleId || addLoading) return
    setAddLoading(true)
    setAddResult(null)
    const result = await addFriend(googleId, addCodeInput.trim().toUpperCase())
    setAddResult(result)
    setAddLoading(false)
    if (result?.status === 'ok') {
      setAddCodeInput('')
      // Refresh friends list
      getFriends(googleId).then(list => setFriends(list ?? []))
    }
  }

  function handleWhatsApp() {
    const text = `Oi! Usa meu código ${friendCode} no Reroot para a gente conectar 🌿 reroot.app`
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank')
  }

  function handleCopyCode() {
    if (friendCode) navigator.clipboard.writeText(friendCode).catch(() => {})
  }

  const badges = computeBadges(state)
  const rsvpCount = Object.values(state.rsvps).filter(Boolean).length
  const currentWeek = computeCurrentWeek(state.joinedAt)
  const chapter = getChapter(currentWeek)

  function saveName() {
    if (nameInput.trim()) dispatch({ type: 'SET_NAME', payload: nameInput.trim() })
    setEditingName(false)
  }

  function handleReset() {
    dispatch({ type: 'RESET' })
    window.location.hash = '/'
    window.location.reload()
  }

  function handlePause() {
    dispatch({ type: 'SET_PAUSED', payload: true })
    setPaused(true)
    setShowPauseSheet(false)
  }

  function handleCancelTap() {
    setShowPauseSheet(false)
    setShowCancelConfirm(true)
  }

  const enrichedTimeline = TIMELINE.map(item => {
    const itemState = item.week < currentWeek ? 'done'
      : item.week === currentWeek ? 'current'
      : 'locked'
    const note = item.week === currentWeek
      ? `${rsvpCount} RSVP'd · ${state.eventsAttended} attended`
      : item.note
    return { ...item, state: itemState, note }
  })

  // 12-week grid for "weeks shown up"
  const weeksShownUp = state.weeksShownUp ?? []

  return (
    <div>
      {/* Hero */}
      <div style={{
        background: 'linear-gradient(135deg, #2C2C2C 0%, #3d2d25 100%)',
        padding: '16px 24px 28px', textAlign: 'center', color: 'white',
        position: 'relative',
      }}>
        {/* Gear icon */}
        <button
          onClick={() => setShowPauseSheet(true)}
          style={{
            position: 'absolute', top: 16, right: 20,
            background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: '50%',
            width: 34, height: 34, cursor: 'pointer', fontSize: 16,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >⚙️</button>

        {state.googleUser?.picture ? (
          <img
            src={state.googleUser.picture}
            alt={state.userName}
            style={{
              width: 72, height: 72, borderRadius: '50%',
              margin: '0 auto 12px', display: 'block',
              border: '3px solid rgba(255,255,255,0.2)',
              objectFit: 'cover',
            }}
          />
        ) : (
          <div className="avatar avatar--lg" style={{ background: 'var(--terra)', margin: '0 auto 12px' }}>
            {(state.userName || '?').charAt(0).toUpperCase()}
          </div>
        )}

        {editingName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            <input
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveName()}
              autoFocus maxLength={30}
              style={{
                fontSize: 18, fontWeight: 700, color: 'white',
                background: 'rgba(255,255,255,0.12)',
                border: '1.5px solid rgba(255,255,255,0.3)',
                borderRadius: 10, padding: '5px 12px',
                outline: 'none', textAlign: 'center', width: 160,
              }}
            />
            <button onClick={saveName} style={{ fontSize: 18, color: 'var(--sage-light)', background: 'none', border: 'none', cursor: 'pointer' }}>✓</button>
          </div>
        ) : (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', cursor: 'pointer' }}
            onClick={() => { setNameInput(state.userName); setEditingName(true) }}
          >
            <span style={{ fontSize: 20, fontWeight: 700 }}>{state.userName}</span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>✎</span>
          </div>
        )}

        {state.googleUser?.email && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
            {state.googleUser.email}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 3 }}>
          {t.profile_cohort}
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: paused ? 'rgba(255,255,255,0.15)' : 'var(--terra)', padding: '5px 14px',
          borderRadius: 20, fontSize: 11, fontWeight: 700, marginTop: 10,
        }}>
          {paused ? t.profile_paused_badge : t.profile_member_badge}
        </div>
        {paused && (
          <button
            onClick={() => {
              dispatch({ type: 'SET_PAUSED', payload: false })
              setPaused(false)
            }}
            style={{
              marginTop: 10, background: 'var(--sage)', color: 'white',
              border: 'none', borderRadius: 20, padding: '7px 20px',
              fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}
          >
            ▶ {t.profile_resume_btn ?? 'Retomar jornada'}
          </button>
        )}
      </div>

      {/* Weeks shown up — 12-week grid */}
      <div className="section-label">{t.profile_weeks_shown}</div>
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
          {Array.from({ length: 12 }, (_, i) => {
            const week = i + 1
            const shown = weeksShownUp.includes(week)
            const isCurrent = week === currentWeek
            const isPast = week < currentWeek
            const chapterForWeek = CHAPTERS.find(c => c.weeks.includes(week))
            return (
              <div key={week} style={{ textAlign: 'center' }}>
                <div style={{
                  width: '100%', aspectRatio: '1', borderRadius: 10,
                  background: shown ? chapterForWeek?.color ?? 'var(--sage)' : 'transparent',
                  border: shown ? 'none'
                    : isCurrent ? `2px solid ${chapter.color}`
                    : isPast ? '2px dashed var(--border)'
                    : '2px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: shown ? 12 : 11,
                  color: shown ? 'white' : 'var(--charcoal-light)',
                  fontWeight: 700,
                  opacity: !isPast && !isCurrent ? 0.5 : 1,
                }}>
                  {shown ? '✓' : week}
                </div>
                <div style={{
                  fontSize: 9, marginTop: 3,
                  color: isCurrent ? 'var(--charcoal)' : 'var(--charcoal-light)',
                  fontWeight: isCurrent ? 700 : 400,
                }}>
                  W{week}
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: 'var(--charcoal-mid)' }}>
          <strong style={{ color: 'var(--charcoal)' }}>{weeksShownUp.length}</strong> {t.profile_weeks_shown?.toLowerCase?.() ?? 'weeks shown up'}
        </div>
      </div>

      {/* Friends */}
      <div className="section-label">Amigos</div>
      <div style={{ margin: '0 16px 12px' }}>
        {!googleId ? (
          <div className="card" style={{ textAlign: 'center', fontSize: 13, color: 'var(--charcoal-mid)', padding: '16px' }}>
            Entre com Google para conectar com amigos 🌿
          </div>
        ) : (
          <>
            {/* Your invite code */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
                Seu código de convite
              </div>
              {friendCodeLoading ? (
                <div style={{ fontSize: 12, color: 'var(--charcoal-light)' }}>Carregando...</div>
              ) : friendCode ? (
                <>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
                  }}>
                    <div style={{
                      fontSize: 22, fontWeight: 800, letterSpacing: 3,
                      color: 'var(--terra)', flex: 1,
                    }}>
                      {friendCode}
                    </div>
                    <button
                      onClick={handleCopyCode}
                      style={{
                        padding: '7px 14px', borderRadius: 10, fontSize: 12,
                        fontWeight: 700, border: '1.5px solid var(--border)',
                        background: 'white', cursor: 'pointer', color: 'var(--charcoal)',
                      }}
                    >
                      Copiar
                    </button>
                    <button
                      onClick={handleWhatsApp}
                      style={{
                        padding: '7px 14px', borderRadius: 10, fontSize: 12,
                        fontWeight: 700, border: 'none',
                        background: '#25D366', cursor: 'pointer', color: 'white',
                      }}
                    >
                      WhatsApp
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
                    Compartilhe com amigos para conectar
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--charcoal-light)' }}>
                  Código não disponível no momento
                </div>
              )}
            </div>

            {/* Add a friend */}
            <div className="card" style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 10 }}>
                Adicionar amigo
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: addResult ? 10 : 0 }}>
                <input
                  value={addCodeInput}
                  onChange={e => { setAddCodeInput(e.target.value.toUpperCase()); setAddResult(null) }}
                  onKeyDown={e => e.key === 'Enter' && handleAddFriend()}
                  placeholder="Código do amigo"
                  maxLength={12}
                  style={{
                    flex: 1, padding: '10px 14px',
                    border: '1.5px solid var(--border)',
                    borderRadius: 12, fontSize: 13,
                    background: 'var(--cream)', outline: 'none',
                    color: 'var(--charcoal)', letterSpacing: 2, fontWeight: 700,
                  }}
                />
                <button
                  onClick={handleAddFriend}
                  disabled={addLoading || !addCodeInput.trim()}
                  className="btn btn--sage"
                  style={{ width: 'auto', padding: '10px 18px', fontSize: 13, opacity: addLoading || !addCodeInput.trim() ? 0.5 : 1 }}
                >
                  {addLoading ? '...' : 'Adicionar'}
                </button>
              </div>
              {addResult && (
                <div style={{
                  fontSize: 13, fontWeight: 600, padding: '8px 12px',
                  borderRadius: 10,
                  background: addResult.status === 'ok' ? 'var(--sage-pale)' : 'var(--terra-pale)',
                  color: addResult.status === 'ok' ? 'var(--sage)' : 'var(--terra)',
                }}>
                  {addResult.status === 'ok' && `✓ ${addResult.friend_name ?? 'Amigo'} adicionado!`}
                  {addResult.status === 'self' && 'Esse é o seu próprio código 😅'}
                  {addResult.status === 'already_friends' && 'Vocês já são amigos!'}
                  {addResult.status === 'not_found' && 'Código inválido'}
                  {!addResult.status && 'Erro ao conectar. Tente novamente.'}
                </div>
              )}
            </div>

            {/* Friends list */}
            <div className="card">
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 10 }}>
                Seus amigos
              </div>
              {friendsLoading ? (
                <div style={{ fontSize: 12, color: 'var(--charcoal-light)' }}>Carregando...</div>
              ) : friends.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--charcoal-light)', textAlign: 'center', fontStyle: 'italic', padding: '8px 0' }}>
                  Nenhum amigo ainda. Compartilhe seu código! 🌿
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {friends.map(friend => (
                    <div key={friend.google_id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      {friend.picture ? (
                        <img
                          src={friend.picture}
                          alt={friend.name}
                          style={{ width: 38, height: 38, borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)' }}
                        />
                      ) : (
                        <div style={{
                          width: 38, height: 38, borderRadius: '50%',
                          background: 'var(--terra)', color: 'white',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 16, fontWeight: 700, flexShrink: 0,
                        }}>
                          {(friend.name || '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--charcoal)' }}>{friend.name}</div>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--sage)', fontWeight: 700 }}>
                        Amigo ✓
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Reflections journal */}
      <div className="section-label">{t.profile_journal_label}</div>
      <div style={{ margin: '0 16px 12px' }} className="card">
        {state.reflections.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--charcoal-light)', textAlign: 'center', padding: '8px 0', fontStyle: 'italic' }}>
            {t.profile_journal_empty}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {state.reflections.map((r, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px',
                background: 'var(--cream)', borderRadius: 12,
              }}>
                <div style={{
                  width: 3, height: 24, borderRadius: 2,
                  background: 'var(--sage-light)', flexShrink: 0,
                }}/>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--charcoal)', fontStyle: 'italic' }}>
                    "{r.word}"
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--charcoal-light)', marginTop: 2 }}>
                    {new Date(r.date).toLocaleDateString(state.language === 'pt' ? 'pt-BR' : 'en-US', { month: 'short', day: 'numeric' })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="section-label">{t.profile_timeline_label}</div>
      <div style={{ padding: '0 16px' }}>
        {enrichedTimeline.map((item, idx) => {
          const isLast = idx === enrichedTimeline.length - 1
          const dotColor = item.state === 'done' ? 'var(--sage-pale)'
            : item.state === 'current' ? 'var(--terra-pale)' : '#F0F0F0'
          const dotEmoji = item.state === 'done' ? '✓' : item.state === 'current' ? '→' : '🔒'

          return (
            <div key={item.week} style={{ display: 'flex', gap: 12, position: 'relative' }}>
              {!isLast && (
                <div style={{ position: 'absolute', left: 15, top: 32, bottom: 0, width: 2, background: 'var(--border)' }}/>
              )}
              <div style={{ width: 32, flexShrink: 0 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', background: dotColor,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, position: 'relative', zIndex: 1,
                  opacity: item.state === 'locked' ? 0.45 : 1,
                  boxShadow: item.state === 'current' ? '0 0 0 4px var(--terra-pale)' : 'none',
                }}>
                  {dotEmoji}
                </div>
              </div>
              <div style={{ flex: 1, paddingBottom: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--charcoal-light)' }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--charcoal)', opacity: item.state === 'locked' ? 0.45 : 1 }}>
                  {item.event}
                </div>
                <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2 }}>{item.note}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Badges */}
      <div className="section-label">{t.profile_badges_label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '0 16px' }}>
        {badges.map(badge => {
          const isSelected = selectedBadge === badge.id
          return (
            <div
              key={badge.id}
              onClick={() => setSelectedBadge(isSelected ? null : badge.id)}
              style={{
                background: 'white', borderRadius: 14, padding: '12px 14px',
                flex: '1 1 calc(33% - 8px)', textAlign: 'center',
                boxShadow: isSelected ? '0 0 0 2px var(--sage)' : 'var(--shadow-sm)',
                opacity: badge.earned ? 1 : 0.35,
                filter: badge.earned ? 'none' : 'grayscale(1)',
                transition: 'all 0.2s', position: 'relative',
                cursor: 'pointer',
              }}
            >
              {badge.earned && (
                <div style={{
                  position: 'absolute', top: -4, right: -4,
                  width: 14, height: 14, borderRadius: '50%',
                  background: 'var(--sage)', border: '2px solid white',
                  fontSize: 8, color: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
                }}>✓</div>
              )}
              <div style={{ fontSize: 24, marginBottom: 4 }}>{badge.icon}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--charcoal)', lineHeight: 1.2 }}>{badge.name}</div>
              <AnimatePresence>
                {isSelected && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{ overflow: 'hidden' }}
                  >
                    <div style={{
                      fontSize: 10, color: badge.earned ? 'var(--sage)' : 'var(--charcoal-light)',
                      marginTop: 6, lineHeight: 1.4,
                    }}>
                      {badge.desc}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>

      {/* Membership */}
      <div className="section-label">{t.profile_membership_label}</div>
      <div style={{ margin: '0 16px 12px' }} className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--charcoal)' }}>{t.profile_membership_title}</div>
            <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', marginTop: 2 }}>{t.profile_membership_sub}</div>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--terra)' }}>
            {state.language === 'pt' ? 'R$99' : '$19.99'}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--charcoal-light)' }}>/mo</span>
          </div>
        </div>
        <div className="divider"/>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.8 }}>
          {t.profile_feature_1}<br/>
          {t.profile_feature_2}<br/>
          {t.profile_feature_3}<br/>
          {t.profile_feature_4}
        </div>
        <div className="divider"/>
        <button
          onClick={() => setShowPauseSheet(true)}
          style={{ fontSize: 12, color: 'var(--charcoal-mid)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
        >
          {t.profile_pause_btn} →
        </button>
      </div>

      {/* Referral */}
      <div style={{ margin: '0 16px 12px' }} className="card card--sage">
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 4 }}>
          {t.profile_referral_label}
        </div>
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.5, marginBottom: 14 }}>
          {t.profile_referral_sub}
        </div>
        {referralApplied ? (
          <div style={{ textAlign: 'center', padding: 12, background: 'var(--sage-pale)', borderRadius: 12, color: 'var(--sage)', fontSize: 13, fontWeight: 600 }}>
            {t.profile_referral_applied}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={referralCode}
              onChange={e => setReferralCode(e.target.value)}
              placeholder={t.profile_referral_placeholder}
              style={{
                flex: 1, padding: '11px 14px',
                border: '1.5px solid rgba(122,158,126,0.4)',
                borderRadius: 12, fontSize: 13,
                background: 'rgba(255,255,255,0.7)',
                outline: 'none', color: 'var(--charcoal)',
              }}
            />
            <button
              className="btn btn--sage"
              style={{ width: 'auto', padding: '11px 18px', fontSize: 13 }}
              onClick={() => referralCode.trim() && setReferralApplied(true)}
            >
              {t.profile_referral_btn}
            </button>
          </div>
        )}
      </div>

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
                color: state.language === code ? 'white' : 'var(--charcoal-mid)',
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
              width: 24, height: 24, borderRadius: '50%', background: 'white',
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
          { key: 'shareRsvps',             label: t.privacy_share_rsvps ?? 'Share RSVPs with friends',        desc: t.privacy_share_rsvps_desc ?? 'Your friends can see events you confirmed' },
          { key: 'showInFriendSuggestions', label: t.privacy_show_suggestions ?? 'Appear in friend suggestions', desc: t.privacy_show_suggestions_desc ?? 'Other people can find your profile' },
          { key: 'showProfileToStrangers',  label: t.privacy_show_profile ?? 'Profile visible to non-friends',   desc: t.privacy_show_profile_desc ?? 'Non-friends can see your full profile' },
        ].map(({ key, label, desc }) => {
          const value = state.privacy?.[key] ?? (key === 'shareRsvps' ? state.shareRsvps : false)
          return (
            <div key={key} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 0',
              borderBottom: key !== 'showProfileToStrangers' ? '1px solid var(--border)' : 'none',
            }}>
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
                  background: 'white', position: 'absolute', top: 3,
                  left: value ? 21 : 3,
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>
          )
        })}
      </div>

      {/* Redo onboarding + Reset */}
      <div style={{ padding: '4px 16px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => {
            dispatch({ type: 'REDO_ONBOARDING' })
            navigate('/')
          }}
          style={{ fontSize: 12, color: 'var(--terra)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
        >
          {t.profile_redo_onboarding ?? 'Redo onboarding'}
        </button>
        <button onClick={handleReset} style={{ fontSize: 11, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}>
          {t.profile_reset}
        </button>
      </div>

      {/* Pause/Cancel sheet */}
      <AnimatePresence>
        {showPauseSheet && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'flex-end', zIndex: 200,
            }}
            onClick={e => { if (e.target === e.currentTarget) setShowPauseSheet(false) }}
          >
            <motion.div
              initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
              transition={{ type: 'spring', damping: 25 }}
              style={{
                background: 'white', borderRadius: '24px 24px 0 0',
                padding: '24px 20px 44px', width: '100%',
              }}
            >
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto 20px' }}/>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--charcoal)', marginBottom: 20 }}>
                {t.profile_pause_title}
              </div>

              {/* Pause option — primary */}
              <button
                onClick={handlePause}
                style={{
                  width: '100%', background: 'var(--sage-pale)', border: 'none',
                  borderRadius: 16, padding: '16px', marginBottom: 10,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--sage)', marginBottom: 4 }}>
                  ⏸ {t.profile_pause_option}
                </div>
                <div style={{ fontSize: 12, color: 'var(--charcoal-mid)' }}>{t.profile_pause_sub}</div>
              </button>

              {/* Cancel option — secondary, smaller */}
              <button
                onClick={handleCancelTap}
                style={{
                  width: '100%', background: 'transparent', border: 'none',
                  padding: '10px 16px', marginBottom: 10,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--charcoal-light)' }}>
                  {t.profile_cancel_option}
                </div>
              </button>

              <button
                onClick={() => setShowPauseSheet(false)}
                style={{ width: '100%', padding: '10px', fontSize: 13, color: 'var(--charcoal-light)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {t.profile_close}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cancel confirmation — retention message */}
      <AnimatePresence>
        {showCancelConfirm && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'flex-end', zIndex: 200,
            }}
            onClick={e => { if (e.target === e.currentTarget) setShowCancelConfirm(false) }}
          >
            <motion.div
              initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }}
              transition={{ type: 'spring', damping: 25 }}
              style={{
                background: 'white', borderRadius: '24px 24px 0 0',
                padding: '28px 24px 44px', width: '100%',
              }}
            >
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '0 auto 24px' }}/>

              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🌿</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--charcoal)', lineHeight: 1.4, marginBottom: 8 }}>
                  {t.profile_cancel_msg_pre} {currentWeek} {t.profile_cancel_msg_of}
                </div>
                <div style={{ fontSize: 13, color: 'var(--charcoal-mid)', lineHeight: 1.6 }}>
                  {t.profile_cancel_msg_post}
                </div>
              </div>

              {/* Pause instead — primary offer */}
              <button
                onClick={() => { handlePause(); setShowCancelConfirm(false) }}
                className="btn btn--sage"
                style={{ marginBottom: 10 }}
              >
                ⏸ {t.profile_pause_offer}
              </button>

              {/* Final cancel */}
              <button
                onClick={() => setShowCancelConfirm(false)}
                style={{
                  width: '100%', padding: '12px', fontSize: 12,
                  color: 'var(--charcoal-light)', background: 'none',
                  border: 'none', cursor: 'pointer',
                }}
              >
                {t.profile_go_back}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
