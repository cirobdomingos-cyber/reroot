import { createContext, useContext, useReducer, useEffect } from 'react'

// ── Week computation (derived from join date) ──────────────
export function computeCurrentWeek(joinedAt) {
  if (!joinedAt) return 1
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const elapsed = Date.now() - joinedAt
  return Math.min(Math.max(Math.floor(elapsed / MS_PER_WEEK) + 1, 1), 12)
}

// ── Chapter system ─────────────────────────────────────────
export const CHAPTERS = [
  { id: 'reentry', name: 'Re-entry',  weeks: [1, 2, 3],    color: '#C4724A', pale: '#F5DDD1', desc: 'Easing back in. Showing your nervous system it\'s safe to show up again.' },
  { id: 'roots',   name: 'Roots',     weeks: [4, 5, 6],    color: '#7A9E7E', pale: '#E4EFE5', desc: 'Building consistency. The people and places that start to feel familiar.' },
  { id: 'reach',   name: 'Reach',     weeks: [7, 8, 9],    color: '#D4A256', pale: '#FFF3E0', desc: 'Expanding your range. Saying yes to things that used to feel impossible.' },
  { id: 'thrive',  name: 'Thrive',    weeks: [10, 11, 12], color: '#9B7EB8', pale: '#EDE7F6', desc: 'Living it. Social life isn\'t a project anymore — it\'s just life.' },
]

export function getChapter(week) {
  return CHAPTERS.find(c => c.weeks.includes(week)) ?? CHAPTERS[0]
}

// ── Initial state ──────────────────────────────────────────
const INITIAL_STATE = {
  hasJoined: false,
  identityMirrorCompleted: false,
  questionnaireCompleted: false,
  joinedAt: null,               // timestamp — drives week computation
  userName: 'Ana',
  neighborhood: 'Água Verde · Curitiba',
  interests: ['Coffee & Conversation', 'Creative Writing', 'Book Clubs'],
  totalWeeks: 12,
  language: 'pt',               // 'pt' | 'en'
  rsvps: {},            // eventId → true
  eventsAttended: 0,    // incremented via "Mark attended"
  frameworkRead: false,

  // Identity mirror onboarding
  identityPastLife: null,       // e.g. 'gallery_openings'
  identityCurrentFeel: null,    // e.g. 'hopeful'

  // Day-zero: first event saved
  dayZeroSaved: false,
  dayZeroEventId: null,

  // Reflections journal
  reflections: [],              // [{ date: ISO, word: string, eventId?: string }]

  // Weeks shown up tracking (week numbers where user took action)
  weeksShownUp: [],             // [1, 2, 3, ...] — week numbers

  // Diagnostic seen
  diagnosticSeen: false,

  // Pause mode
  isPaused: false,

  // Month-end card dismissed
  monthEndDismissed: false,

  // Google account linked
  googleUser: null, // { id, name, givenName, email, picture }

  // Weekly check-ins: { [week]: { emoji, timestamp } }
  weeklyCheckIns: {},
}

// ── Reducer ────────────────────────────────────────────────
function reducer(state, action) {
  switch (action.type) {
    case 'JOIN_COHORT':
      return { ...state, hasJoined: true, joinedAt: state.joinedAt ?? Date.now() }

    case 'COMPLETE_IDENTITY_MIRROR':
      return {
        ...state,
        identityMirrorCompleted: true,
        identityPastLife: action.payload.pastLife,
        identityCurrentFeel: action.payload.currentFeel,
      }

    case 'COMPLETE_QUESTIONNAIRE':
      return {
        ...state,
        questionnaireCompleted: true,
        questionnaireAnswers: action.payload.answers,
        aiPartnerMessage: action.payload.message,
      }

    case 'SET_NAME':
      return { ...state, userName: action.payload }

    case 'SET_NEIGHBORHOOD':
      return { ...state, neighborhood: action.payload }

    case 'TOGGLE_INTEREST': {
      const { interest } = action.payload
      const has = state.interests.includes(interest)
      return {
        ...state,
        interests: has
          ? state.interests.filter(i => i !== interest)
          : [...state.interests, interest],
      }
    }

    case 'TOGGLE_RSVP': {
      const { eventId } = action.payload
      const current = !!state.rsvps[eventId]
      const currentWeek = computeCurrentWeek(state.joinedAt)
      const weeksShownUp = !current && !state.weeksShownUp.includes(currentWeek)
        ? [...state.weeksShownUp, currentWeek]
        : state.weeksShownUp
      return {
        ...state,
        rsvps: { ...state.rsvps, [eventId]: !current },
        weeksShownUp,
      }
    }

    case 'SAVE_DAY_ZERO': {
      const { eventId } = action.payload
      const currentWeek = computeCurrentWeek(state.joinedAt)
      const weeksShownUp = !state.weeksShownUp.includes(currentWeek)
        ? [...state.weeksShownUp, currentWeek]
        : state.weeksShownUp
      return {
        ...state,
        dayZeroSaved: true,
        dayZeroEventId: eventId,
        rsvps: { ...state.rsvps, [eventId]: true },
        weeksShownUp,
      }
    }

    case 'MARK_ATTENDED': {
      const currentWeek = computeCurrentWeek(state.joinedAt)
      const weeksShownUp = !state.weeksShownUp.includes(currentWeek)
        ? [...state.weeksShownUp, currentWeek]
        : state.weeksShownUp
      return { ...state, eventsAttended: state.eventsAttended + 1, weeksShownUp }
    }

    case 'SET_FRAMEWORK_READ': {
      const currentWeek = computeCurrentWeek(state.joinedAt)
      const weeksShownUp = !state.weeksShownUp.includes(currentWeek)
        ? [...state.weeksShownUp, currentWeek]
        : state.weeksShownUp
      return { ...state, frameworkRead: true, weeksShownUp }
    }

    case 'SAVE_REFLECTION': {
      const { word, eventId } = action.payload
      return {
        ...state,
        reflections: [...state.reflections, { date: new Date().toISOString(), word, eventId }],
      }
    }

    case 'MARK_DIAGNOSTIC_SEEN':
      return { ...state, diagnosticSeen: true }

    case 'DISMISS_MONTH_END':
      return { ...state, monthEndDismissed: true }

    case 'SAVE_WEEKLY_CHECKIN': {
      const { week, emoji } = action.payload
      return {
        ...state,
        weeklyCheckIns: { ...state.weeklyCheckIns, [week]: { emoji, timestamp: Date.now() } },
      }
    }

    case 'SET_PAUSED':
      return { ...state, isPaused: action.payload }

    case 'SET_LANGUAGE':
      return { ...state, language: action.payload }

    case 'SET_GOOGLE_USER': {
      const { id, name, givenName, email, picture } = action.payload
      return {
        ...state,
        googleUser: { id, name, givenName, email, picture },
        // Pre-fill first name only if user hasn't manually set one yet
        userName: state.userName === 'Ana' ? (givenName || name.split(' ')[0]) : state.userName,
      }
    }

    case 'REDO_ONBOARDING':
      return {
        ...state,
        hasJoined: false,
        identityMirrorCompleted: false,
        questionnaireCompleted: false,
        diagnosticSeen: false,
        questionnaireAnswers: undefined,
        aiPartnerMessage: undefined,
        identityPastLife: null,
        identityCurrentFeel: null,
      }

    case 'RESET':
      return { ...INITIAL_STATE }

    default:
      return state
  }
}

// ── Badge derivation (computed, not stored) ────────────────
export function computeBadges(state) {
  const rsvpCount = Object.values(state.rsvps).filter(Boolean).length
  const currentWeek = computeCurrentWeek(state.joinedAt)
  return [
    {
      id: 'first_step',
      icon: '🌱',
      name: 'First Step',
      earned: state.hasJoined,
      desc: 'Joined a cohort',
    },
    {
      id: 'said_yes',
      icon: '✋',
      name: 'Said Yes',
      earned: rsvpCount >= 1,
      desc: 'RSVP\'d to your first event',
    },
    {
      id: 'framework_3',
      icon: '📖',
      name: 'Framework 3',
      earned: state.frameworkRead && currentWeek >= 3,
      desc: 'Completed Week 3 framework',
    },
    {
      id: 'said_yes_twice',
      icon: '🔥',
      name: 'Said Yes Twice',
      earned: rsvpCount >= 2,
      desc: 'RSVP\'d to two events',
    },
    {
      id: 'cohort_connector',
      icon: '🤝',
      name: 'Cohort Connector',
      earned: state.eventsAttended >= 1,
      desc: 'Attended your first event',
    },
    {
      id: 'roots',
      icon: '🌳',
      name: 'Roots Established',
      earned: currentWeek >= 12,
      desc: 'Completed the 12-week program',
    },
  ]
}

// ── Context setup ──────────────────────────────────────────
const AppContext = createContext(null)

const STORAGE_KEY = 'reroot_state'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return INITIAL_STATE
    return { ...INITIAL_STATE, ...JSON.parse(raw) }
  } catch {
    return INITIAL_STATE
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState)

  // Persist to localStorage on every state change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
