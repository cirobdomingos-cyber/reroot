import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp, computeCurrentWeek, getChapter } from '../context/AppContext'
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

function CompanionMessage({ msg, onEventClick }) {
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
        {/* Recommended events — clickable cards that navigate to event detail */}
        {msg.events?.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {msg.events.map(ev => (
              <div
                key={ev.id}
                onClick={() => onEventClick?.(ev)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: 'white', borderRadius: 14, padding: '10px 12px',
                  border: '1.5px solid var(--sage-pale)', textDecoration: 'none',
                  cursor: 'pointer', transition: 'all 0.15s',
                }}
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
                <div style={{
                  fontSize: 11, fontWeight: 700, color: 'var(--sage)',
                  padding: '4px 10px', borderRadius: 8,
                  background: 'var(--sage-pale)', flexShrink: 0,
                }}>
                  Ver →
                </div>
              </div>
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
  const { state } = useApp()
  const navigate = useNavigate()
  const t = useT()
  const lang = state.language ?? 'pt'
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [allEvents, setAllEvents] = useState([])
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  const currentWeek = computeCurrentWeek(state.joinedAt)
  const chapter = getChapter(currentWeek)

  // Load all available events once (static + live) so we can send them as context
  useEffect(() => {
    async function loadEvents() {
      // Start with static embedded events (always available)
      let events = [...EVENTS]
      // Try to fetch live events as bonus
      try {
        const { events: liveEvents } = await fetchEvents('all')
        if (liveEvents?.length > 0) {
          const ids = new Set(events.map(e => e.id))
          for (const ev of liveEvents) {
            if (!ids.has(ev.id)) events.push(ev)
          }
        }
      } catch { /* static events are enough */ }
      setAllEvents(events)
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
    // Close companion and navigate to events page
    // The event ID is stored so Events screen can open its detail
    onClose()
    navigate('/events', { state: { openEventId: ev.id } })
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
    ? `Oi${state.userName ? `, ${state.userName}` : ''}! Sou seu companheiro Reroot. Me conta como se sente ou o que tem vontade de fazer — eu te ajudo a encontrar algo bom pra essa semana.`
    : `Hey${state.userName ? `, ${state.userName}` : ''}! I'm your Reroot companion. Tell me how you're feeling or what you'd like to do — I'll help you find something good for this week.`

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
                {lang === 'pt' ? 'Companheiro Reroot' : 'Reroot Companion'}
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
                : <CompanionMessage key={i} msg={msg} onEventClick={handleEventClick} />
            ))}

            {loading && <TypingIndicator />}
          </div>

          {/* Input */}
          <div style={{
            padding: '10px 16px 24px',
            background: 'white', borderTop: '1px solid var(--border)',
          }}>
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
