import { createContext, useContext, useReducer, useEffect } from 'react'

// ── Initial state ──────────────────────────────────────────
const INITIAL_STATE = {
  hasJoined: false,
  userName: 'Sandra',
  neighborhood: 'Pearl District · NW Portland',
  interests: ['Coffee & Conversation', 'Creative Writing', 'Book Clubs'],
  currentWeek: 3,
  totalWeeks: 12,
  rsvps: {},            // eventId → true
  eventsAttended: 0,    // incremented via "Mark attended"
  frameworkRead: false,
}

// ── Reducer ────────────────────────────────────────────────
function reducer(state, action) {
  switch (action.type) {
    case 'JOIN_COHORT':
      return { ...state, hasJoined: true }

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
      return {
        ...state,
        rsvps: { ...state.rsvps, [eventId]: !current },
      }
    }

    case 'MARK_ATTENDED':
      return { ...state, eventsAttended: state.eventsAttended + 1 }

    case 'SET_FRAMEWORK_READ':
      return { ...state, frameworkRead: true }

    case 'RESET':
      return { ...INITIAL_STATE }

    default:
      return state
  }
}

// ── Badge derivation (computed, not stored) ────────────────
export function computeBadges(state) {
  const rsvpCount = Object.values(state.rsvps).filter(Boolean).length
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
      earned: state.frameworkRead && state.currentWeek >= 3,
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
      earned: state.currentWeek >= 12,
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
