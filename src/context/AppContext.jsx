import { createContext, useContext, useReducer, useEffect, useRef } from 'react'
import { loadUserState, saveUserState } from '../services/api'

// ── Week computation (derived from join date) ──────────────
export function computeCurrentWeek(joinedAt) {
  if (!joinedAt) return 1
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const elapsed = Date.now() - joinedAt
  return Math.min(Math.max(Math.floor(elapsed / MS_PER_WEEK) + 1, 1), 12)
}

// ── Profile system ─────────────────────────────────────────
export const PROFILES = {
  heartbroken: {
    id: 'heartbroken', emoji: '💔',
    prescriptionIntensity: 1,
    priorityCategories: ['quiet_social', 'creative'],
    activityFirst: false,
  },
  transplant: {
    id: 'transplant', emoji: '📦',
    prescriptionIntensity: 2,
    priorityCategories: ['community', 'active', 'bars_cafes'],
    activityFirst: false,
  },
  burnout: {
    id: 'burnout', emoji: '🔋',
    prescriptionIntensity: 1,
    priorityCategories: ['quiet_social', 'active'],
    activityFirst: true,
  },
  remote: {
    id: 'remote', emoji: '💻',
    prescriptionIntensity: 1,
    priorityCategories: ['bars_cafes', 'quiet_social'],
    activityFirst: true,
  },
  reconnector: {
    id: 'reconnector', emoji: '🌀',
    prescriptionIntensity: 2,
    priorityCategories: ['community', 'active', 'creative'],
    activityFirst: false,
  },
  introvert: {
    id: 'introvert', emoji: '🌱',
    prescriptionIntensity: 1,
    priorityCategories: ['quiet_social', 'creative'],
    activityFirst: false,
  },
  grief: {
    id: 'grief', emoji: '🕊️',
    prescriptionIntensity: 1,
    priorityCategories: ['quiet_social', 'active'],
    activityFirst: true,
  },
}

export function getProfile(situation) {
  return PROFILES[situation] ?? null
}

// ── Chapter system ─────────────────────────────────────────
export const CHAPTERS = [
  { id: 'reentry', name: 'Reentrada',   weeks: [1, 2, 3],    color: '#C4724A', pale: '#F5DDD1', desc: 'Voltando aos poucos. Mostrando ao seu sistema nervoso que é seguro aparecer de novo.' },
  { id: 'roots',   name: 'Raízes',     weeks: [4, 5, 6],    color: '#7A9E7E', pale: '#E4EFE5', desc: 'Construindo consistência. As pessoas e lugares que começam a parecer familiares.' },
  { id: 'reach',   name: 'Expansão',   weeks: [7, 8, 9],    color: '#D4A256', pale: '#FFF3E0', desc: 'Ampliando seu alcance. Dizendo sim para coisas que antes pareciam impossíveis.' },
  { id: 'thrive',  name: 'Florescer',  weeks: [10, 11, 12], color: '#9B7EB8', pale: '#EDE7F6', desc: 'Vivendo. A vida social não é mais um projeto — é só vida.' },
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
  userName: '',
  neighborhood: '',
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

  // User profile (from IdentityMirror steps 0+1)
  userSituation: null,  // 'heartbroken' | 'transplant' | 'burnout' | 'remote' | 'reconnector' | 'introvert' | 'grief'
  userGoal: null,       // 'friends' | 'partner' | 'community' | 'self'

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
        userSituation: action.payload.situation ?? state.userSituation,
        userGoal: action.payload.goal ?? state.userGoal,
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
      if (!action.payload) return { ...state, googleUser: null }
      const { id, name, givenName, email, picture } = action.payload
      return {
        ...state,
        googleUser: { id, name, givenName, email, picture },
        userName: !state.userName ? (givenName || name.split(' ')[0]) : state.userName,
      }
    }

    case 'RESTORE_STATE': {
      // Remote wins for progress; local wins for preferences. googleUser always stays local.
      const remote = action.payload
      return {
        ...state,
        rsvps:                    remote.rsvps                    ?? state.rsvps,
        reflections:              remote.reflections              ?? state.reflections,
        weeksShownUp:             remote.weeksShownUp             ?? state.weeksShownUp,
        eventsAttended:           remote.eventsAttended           ?? state.eventsAttended,
        weeklyCheckIns:           remote.weeklyCheckIns           ?? state.weeklyCheckIns,
        hasJoined:                remote.hasJoined                ?? state.hasJoined,
        joinedAt:                 remote.joinedAt                 ?? state.joinedAt,
        identityMirrorCompleted:  remote.identityMirrorCompleted  ?? state.identityMirrorCompleted,
        questionnaireCompleted:   remote.questionnaireCompleted   ?? state.questionnaireCompleted,
        dayZeroSaved:             remote.dayZeroSaved             ?? state.dayZeroSaved,
        dayZeroEventId:           remote.dayZeroEventId           ?? state.dayZeroEventId,
        identityPastLife:         remote.identityPastLife         ?? state.identityPastLife,
        identityCurrentFeel:      remote.identityCurrentFeel      ?? state.identityCurrentFeel,
        userSituation:            remote.userSituation            ?? state.userSituation,
        userGoal:                 remote.userGoal                 ?? state.userGoal,
        frameworkRead:            remote.frameworkRead            ?? state.frameworkRead,
        diagnosticSeen:           remote.diagnosticSeen           ?? state.diagnosticSeen,
        language:     state.language     || remote.language,
        userName:     state.userName     || remote.userName,
        neighborhood: state.neighborhood || remote.neighborhood,
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
        userSituation: null,
        userGoal: null,
        googleUser: null,
        userName: '',
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

  // Load remote state once per Google login — fire-and-forget
  const lastLoadedGoogleId = useRef(null)
  useEffect(() => {
    const googleId = state.googleUser?.id
    if (!googleId || googleId === lastLoadedGoogleId.current) return
    lastLoadedGoogleId.current = googleId
    loadUserState(googleId).then(remoteState => {
      if (remoteState) dispatch({ type: 'RESTORE_STATE', payload: remoteState })
    })
  }, [state.googleUser?.id])

  // Debounce-save to backend on any state change while logged in
  const saveTimerRef = useRef(null)
  useEffect(() => {
    const googleId = state.googleUser?.id
    if (!googleId) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => saveUserState(googleId, state), 500)
    return () => clearTimeout(saveTimerRef.current)
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
