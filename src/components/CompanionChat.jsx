import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp, computeCurrentWeek, getChapter, getProfile } from '../context/AppContext'
import { useT } from '../i18n'
import { askCompanion, fetchEvents } from '../services/api'
import { EVENTS } from '../data/events'

const SUGGESTIONS = {
  pt: [
    'Quero fazer algo diferente essa semana',
    'Estou nervosa pra sair sozinha',
    'Me indica algo tranquilo',
    'Quero conhecer gente nova',
  ],
  en: [
    'I want to do something different this week',
    'I\'m nervous about going out alone',
    'Suggest something chill',
    'I want to meet new people',
  ],
}

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', gap: 4, padding: '12px 16px', alignItems: 'center' }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        background: 'var(--sage)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 16, flexShrink: 0,
      }}>
        🌿
      </div>
      <div style={{
        background: 'white', borderRadius: '18px 18px 18px 4px',
        padding: '10px 16px', display: 'flex', gap: 4, alignItems: 'center',
      }}>
        {[0, 1, 2].map(i => (
          <motion.div
            key={i}
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
            style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--charcoal-light)' }}
          />
        ))}
      </div>
    </div>
  )
}

const CATEGORY_COLORS = {
  quiet_social: { bg: 'linear-gradient(135deg, #F5DDD1, #EDCBB8)', pale: '#F5DDD1' },
  active:       { bg: 'linear-gradient(135deg, #E4EFE5, #CDDECE)', pale: '#E4EFE5' },
  creative:     { bg: 'linear-gradient(135deg, #EDE7F6, #D1C4E9)', pale: '#EDE7F6' },
  community:    { bg: 'linear-gradient(135deg, #FFF3E0, #FFE0B2)', pale: '#FFF3E0' },
  bars_cafes:   { bg: 'linear-gradient(135deg, #FCE4EC, #F8BBD0)', pale: '#FCE4EC' },
}

function SuggestionCard({ suggestion, onCreateEvent, lang }) {
  const colors = CATEGORY_COLORS[suggestion.category] || CATEGORY_COLORS.quiet_social
  return (
    <div style={{
      background: 'white', borderRadius: 14, padding: '10px 12px',
      border: '1.5px dashed var(--sage)', transition: 'all 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: colors.pale,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18,
        }}>
          {suggestion.emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
          }}>
            {suggestion.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 2, lineHeight: 1.4 }}>
            {suggestion.description}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        <button
          onClick={() => onCreateEvent(suggestion)}
          style={{
            width: '100%', padding: '9px 0', borderRadius: 10,
            border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
            background: 'var(--terra)', color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            transition: 'all 0.15s',
          }}
        >
          ✨ {lang === 'pt' ? 'Criar esse evento' : 'Create this event'}
        </button>
      </div>
    </div>
  )
}

function CreateEventForm({ suggestion, onSubmit, onCancel, lang }) {
  const [name, setName] = useState(suggestion.name)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('19:00')
  const [venue, setVenue] = useState('')

  function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim() || !date) return
    onSubmit({ name: name.trim(), date, time, venue: venue.trim(), suggestion })
  }

  const isPt = lang === 'pt'

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'white', borderRadius: 16, padding: 16,
        border: '2px solid var(--sage)', margin: '8px 16px',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 20 }}>{suggestion.emoji}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--charcoal)' }}>
          {isPt ? 'Criar evento privado' : 'Create private event'}
        </span>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={isPt ? 'Nome do evento' : 'Event name'}
          style={{
            padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border)',
            fontSize: 14, outline: 'none', background: 'var(--cream)',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            min={new Date().toISOString().split('T')[0]}
            required
            style={{
              flex: 1, padding: '10px 12px', borderRadius: 10,
              border: '1.5px solid var(--border)', fontSize: 13,
              outline: 'none', background: 'var(--cream)',
            }}
          />
          <input
            type="time"
            value={time}
            onChange={e => setTime(e.target.value)}
            style={{
              width: 100, padding: '10px 12px', borderRadius: 10,
              border: '1.5px solid var(--border)', fontSize: 13,
              outline: 'none', background: 'var(--cream)',
            }}
          />
        </div>
        <input
          value={venue}
          onChange={e => setVenue(e.target.value)}
          placeholder={isPt ? 'Local (ex: minha casa, Parque Barigui)' : 'Venue (e.g. my place, Central Park)'}
          style={{
            padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border)',
            fontSize: 14, outline: 'none', background: 'var(--cream)',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              flex: 1, padding: '10px 0', borderRadius: 10,
              border: '1.5px solid var(--border)', background: 'none',
              fontSize: 13, fontWeight: 600, color: 'var(--charcoal-mid)',
              cursor: 'pointer',
            }}
          >
            {isPt ? 'Cancelar' : 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={!name.trim() || !date}
            style={{
              flex: 2, padding: '10px 0', borderRadius: 10,
              border: 'none', fontSize: 13, fontWeight: 700,
              background: name.trim() && date ? 'var(--sage)' : 'var(--border)',
              color: 'white', cursor: name.trim() && date ? 'pointer' : 'default',
              transition: 'all 0.15s',
            }}
          >
            {isPt ? 'Criar e convidar amigos' : 'Create & invite friends'}
          </button>
        </div>
      </form>
    </motion.div>
  )
}

function CompanionMessage({ msg, onEventClick, onRsvp, rsvps, onCreateEvent, lang }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '6px 16px', alignItems: 'flex-start' }}>
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        background: 'var(--sage)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 16, flexShrink: 0,
      }}>
        🌿
      </div>
      <div style={{ flex: 1 }}>
        <div style={{
          background: 'white', borderRadius: '18px 18px 18px 4px',
          padding: '10px 14px', fontSize: 14, lineHeight: 1.5,
          color: 'var(--charcoal)', boxShadow: 'var(--shadow-sm)',
        }}>
          {msg.message}
        </div>
        {/* Recommended catalog events — clickable cards with inline RSVP */}
        {msg.events?.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {msg.events.map(ev => {
              const isRsvped = !!rsvps?.[ev.id]
              return (
                <div
                  key={ev.id}
                  style={{
                    background: 'white', borderRadius: 14, padding: '10px 12px',
                    border: isRsvped ? '1.5px solid var(--sage)' : '1.5px solid var(--sage-pale)',
                    transition: 'all 0.15s',
                  }}
                >
                  <div
                    onClick={() => onEventClick?.(ev)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                  >
                    <div style={{
                      width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                      background: ev.headerBg || 'var(--sage-pale)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 16,
                    }}>
                      {ev.icon || ev.categoryEmoji || '🌿'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 700, color: 'var(--charcoal)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {ev.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--charcoal-mid)', marginTop: 1 }}>
                        📍 {ev.venue}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--terra)', marginTop: 2, fontWeight: 600 }}>
                        {ev.date} {ev.time && `· ${ev.time}`} {ev.price && `· ${ev.price}`}
                      </div>
                    </div>
                  </div>
                  {/* RSVP action row */}
                  <div style={{
                    display: 'flex', gap: 6, marginTop: 8,
                    borderTop: '1px solid var(--border)', paddingTop: 8,
                  }}>
                    <button
                      onClick={() => onRsvp?.(ev)}
                      style={{
                        flex: 1, padding: '8px 0', borderRadius: 10,
                        border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                        background: isRsvped ? 'var(--sage-pale)' : 'var(--sage)',
                        color: isRsvped ? 'var(--sage)' : 'white',
                        transition: 'all 0.15s',
                      }}
                    >
                      {isRsvped ? '✓ Confirmado' : 'Confirmar presença'}
                    </button>
                    <button
                      onClick={() => onEventClick?.(ev)}
                      style={{
                        padding: '8px 12px', borderRadius: 10,
                        border: '1.5px solid var(--border)', background: 'none',
                        cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        color: 'var(--charcoal-mid)',
                      }}
                    >
                      Ver →
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {/* Custom activity suggestions — create your own event */}
        {msg.suggestions?.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 0.8, color: 'var(--charcoal-light)', padding: '4px 2px 0',
            }}>
              {lang === 'pt' ? '✨ Ideias pra você criar' : '✨ Ideas you can create'}
            </div>
            {msg.suggestions.map((s, i) => (
              <SuggestionCard
                key={i}
                suggestion={s}
                onCreateEvent={onCreateEvent}
                lang={lang}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function UserMessage({ text }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 16px' }}>
      <div style={{
        background: 'var(--charcoal)', color: 'white',
        borderRadius: '18px 18px 4px 18px',
        padding: '10px 14px', fontSize: 14, lineHeight: 1.5,
        maxWidth: '80%',
      }}>
        {text}
      </div>
    </div>
  )
}

export default function CompanionChat({ open, onClose }) {
  const { state, dispatch } = useApp()
  const navigate = useNavigate()
  const t = useT()
  const lang = state.language ?? 'pt'
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [allEvents, setAllEvents] = useState([])
  const [creatingFrom, setCreatingFrom] = useState(null) // suggestion being turned into event
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  const currentWeek = computeCurrentWeek(state.joinedAt)
  const chapter = getChapter(currentWeek)

  // Load the live event catalog so the companion can recommend from it.
  // Falls back to the embedded EVENTS list only when the backend is offline
  // — those static events have stale hardcoded dates and shouldn't be the
  // primary source.
  useEffect(() => {
    async function loadEvents() {
      try {
        const { events: liveEvents } = await fetchEvents('all')
        if (liveEvents?.length > 0) {
          setAllEvents(liveEvents)
          return
        }
      } catch { /* fall through to static */ }
      setAllEvents([...EVENTS])
    }
    if (open && allEvents.length === 0) loadEvents()
  }, [open, allEvents.length])

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, loading])

  // Focus input when drawer opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 300)
    }
  }, [open])

  function handleEventClick(ev) {
    onClose()
    navigate('/events', { state: { openEventId: ev.id } })
  }

  function handleRsvp(ev) {
    dispatch({
      type: 'TOGGLE_RSVP',
      payload: { eventId: ev.id, dateStart: ev.dateStart, name: ev.name, venue: ev.venue },
    })
  }

  function handleStartCreate(suggestion) {
    setCreatingFrom(suggestion)
  }

  function handleCreateEvent({ name, date, time, venue, suggestion }) {
    const colors = CATEGORY_COLORS[suggestion.category] || CATEGORY_COLORS.quiet_social
    const dateObj = new Date(date + 'T' + (time || '19:00'))
    const dayNames = lang === 'pt'
      ? ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const monthNames = lang === 'pt'
      ? ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const dateLabel = `${dayNames[dateObj.getDay()]}, ${dateObj.getDate()} ${monthNames[dateObj.getMonth()]}`

    const event = {
      id: `custom-${Date.now()}`,
      name,
      category: suggestion.category,
      categoryLabel: lang === 'pt' ? 'Evento Privado' : 'Private Event',
      categoryEmoji: suggestion.emoji,
      venue: venue || (lang === 'pt' ? 'A definir' : 'TBD'),
      date: dateLabel,
      dateStart: date + 'T' + (time || '19:00'),
      time: time || '',
      headerBg: colors.bg,
      icon: suggestion.emoji,
      description: suggestion.description,
      price: lang === 'pt' ? 'Gratuito' : 'Free',
      priceTier: 'free',
      isLowPressure: true,
      isCustom: true,
      createdBy: state.userName || 'You',
    }

    dispatch({ type: 'ADD_CUSTOM_EVENT', payload: event })
    setCreatingFrom(null)

    // Confirmation message from companion
    const confirmMsg = lang === 'pt'
      ? `Pronto! "${name}" foi criado. Você já está confirmada — agora é só chamar suas amigas!`
      : `Done! "${name}" has been created. You're already confirmed — now invite your friends!`
    setMessages(prev => [...prev, {
      role: 'assistant',
      message: confirmMsg,
      events: [event],
      suggestions: [],
      tone: 'excited',
    }])
  }

  async function handleSend(text) {
    const msg = text || input.trim()
    if (!msg || loading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: msg }])
    setLoading(true)

    try {
      const history = messages.map(m => ({
        role: m.role,
        content: m.role === 'user' ? m.content : m.message,
      }))

      const res = await askCompanion({
        message: msg,
        situation: state.userSituation,
        goal: state.userGoal,
        week: currentWeek,
        language: lang,
        history,
        eventsContext: allEvents,
      })

      setMessages(prev => [...prev, {
        role: 'assistant',
        message: res.message,
        events: res.events || [],
        suggestions: res.suggestions || [],
        tone: res.tone,
      }])
    } catch {
      // Offline fallback — show a friendly error
      const fallback = lang === 'pt'
        ? 'Desculpe, estou offline agora. Tente novamente em alguns minutos.'
        : 'Sorry, I\'m offline right now. Try again in a few minutes.'
      setMessages(prev => [...prev, {
        role: 'assistant',
        message: fallback,
        events: [],
        tone: 'gentle',
      }])
    } finally {
      setLoading(false)
    }
  }

  const suggestions = SUGGESTIONS[lang] || SUGGESTIONS.pt
  const welcomeMsg = lang === 'pt'
    ? `Oi${state.userName ? `, ${state.userName}` : ''}! Sou seu companheiro do auê. Me conta o que tem vontade de fazer ou com quem quer sair — eu te ajudo a achar algo bom pra essa semana.`
    : `Hey${state.userName ? `, ${state.userName}` : ''}! I'm your auê companion. Tell me what you'd like to do or who you want to go with — I'll help you find something good for this week.`

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'var(--cream)', zIndex: 100,
            display: 'flex', flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div style={{
            padding: '48px 16px 12px',
            background: 'white', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <button
              onClick={onClose}
              style={{
                width: 36, height: 36, borderRadius: '50%', border: 'none',
                background: 'var(--cream)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18,
              }}
            >
              ←
            </button>
            <div style={{
              width: 40, height: 40, borderRadius: '50%',
              background: 'var(--sage)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 20,
            }}>
              🌿
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--charcoal)' }}>
                {lang === 'pt' ? 'Companheiro do auê' : 'auê Companion'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--charcoal-mid)' }}>
                {lang === 'pt'
                  ? `Semana ${currentWeek} · ${chapter.name}`
                  : `Week ${currentWeek} · ${chapter.name}`
                }
              </div>
            </div>
            <div style={{
              fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8,
              padding: '3px 8px', borderRadius: 6,
              background: 'var(--sage-pale)', color: 'var(--sage)',
            }}>
              AI
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            style={{
              flex: 1, overflowY: 'auto', scrollbarWidth: 'none',
              padding: '12px 0',
            }}
          >
            {/* Welcome message */}
            {messages.length === 0 && (
              <>
                <CompanionMessage msg={{ message: welcomeMsg, events: [] }} />
                <div style={{ padding: '12px 16px 4px' }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: 0.8, color: 'var(--charcoal-light)', marginBottom: 8,
                  }}>
                    {lang === 'pt' ? 'Sugestões' : 'Try asking'}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {suggestions.map(s => (
                      <button
                        key={s}
                        onClick={() => handleSend(s)}
                        style={{
                          padding: '8px 14px', borderRadius: 20,
                          fontSize: 12, fontWeight: 500,
                          border: '1.5px solid var(--border)',
                          background: 'white', color: 'var(--charcoal)',
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Chat messages */}
            {messages.map((msg, i) => (
              msg.role === 'user'
                ? <UserMessage key={i} text={msg.content} />
                : <CompanionMessage
                    key={i}
                    msg={msg}
                    onEventClick={handleEventClick}
                    onRsvp={handleRsvp}
                    rsvps={state.rsvps}
                    onCreateEvent={handleStartCreate}
                    lang={lang}
                  />
            ))}

            {loading && <TypingIndicator />}

            {/* Inline event creation form */}
            {creatingFrom && (
              <CreateEventForm
                suggestion={creatingFrom}
                onSubmit={handleCreateEvent}
                onCancel={() => setCreatingFrom(null)}
                lang={lang}
              />
            )}
          </div>

          {/* Input */}
          <div style={{
            padding: '10px 16px 24px',
            background: 'white', borderTop: '1px solid var(--border)',
          }}>
            {/* AI disclaimer */}
            <div style={{
              textAlign: 'center', fontSize: 10, color: 'var(--charcoal-light)',
              padding: '0 16px 8px', lineHeight: 1.4,
            }}>
              {lang === 'pt'
                ? 'Respostas geradas por IA · Não substituem apoio profissional'
                : 'AI-generated responses · Not a substitute for professional support'}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--cream)', borderRadius: 24,
              padding: '6px 6px 6px 16px',
              border: '1.5px solid var(--border)',
            }}>
              <input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                placeholder={lang === 'pt' ? 'Me conta como se sente...' : 'Tell me how you feel...'}
                style={{
                  flex: 1, border: 'none', outline: 'none',
                  fontSize: 14, color: 'var(--charcoal)', background: 'transparent',
                }}
              />
              <button
                onClick={() => handleSend()}
                disabled={!input.trim() || loading}
                style={{
                  width: 36, height: 36, borderRadius: '50%', border: 'none',
                  background: input.trim() && !loading ? 'var(--sage)' : 'var(--border)',
                  color: 'white', cursor: input.trim() && !loading ? 'pointer' : 'default',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, transition: 'background 0.15s', flexShrink: 0,
                }}
              >
                ↑
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
