import { createContext, useContext, useReducer, useEffect, useRef } from 'react'
import { loadUserState, saveUserState, isLoadInFlight } from '../services/api'

// ── Week computation (derived from join date) ──────────────
export function computeCurrentWeek(joinedAt) {
  if (!joinedAt) return 1
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000
  const elapsed = Date.now() - joinedAt
  return Math.min(Math.max(Math.floor(elapsed / MS_PER_WEEK) + 1, 1), 12)
}

// ── Profile system ─────────────────────────────────────────
// Profiles are vibe shortcuts — they don't gate anything, they just set
// the user's default mood and the priority order of moods on the Home
// "Eventos para você" suggestions. A user can always switch moods
// manually on the Events screen regardless of their profile.
//
// Each profile lists `priorityMoods` from highest to lowest preference.
// The Home prescription sorts events so those matching priority[0] come
// first, then priority[1], etc. Events not in any priority mood drop to
// the bottom but still show.
export const PROFILES = {
  tranquilo: {
    id: 'tranquilo',
    label: 'Tranquilo',
    emoji: '🌿',
    blurb: 'Lugares calmos, encontros pequenos, pra ir no seu ritmo.',
    defaultMood: 'tranquilo',
    priorityMoods: ['tranquilo', 'criativo', 'cultural'],
  },
  curioso: {
    id: 'curioso',
    label: 'Curioso',
    emoji: '🎭',
    blurb: 'Exposições, peças, oficinas — tudo que tá em cartaz.',
    defaultMood: 'cultural',
    priorityMoods: ['cultural', 'criativo', 'comunidade'],
  },
  animado: {
    id: 'animado',
    label: 'Animado',
    emoji: '🎉',
    blurb: 'Encontros maiores, esportes, gente nova.',
    defaultMood: 'comunidade',
    priorityMoods: ['comunidade', 'ativo', 'all'],
  },
  familia: {
    id: 'familia',
    label: 'Família',
    emoji: '👨‍👩‍👧',
    blurb: 'Programas que cabem com criança junto.',
    defaultMood: 'familia',
    priorityMoods: ['familia', 'comunidade', 'cultural'],
  },
}

export function getProfile(profileId) {
  return PROFILES[profileId] ?? null
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
  // eventId → { dateStart, name, venue } when RSVPd; undefined when not.
  // Stores enough metadata to compute the upcoming-events count without
  // having to cross-reference the live catalog (which may be paginated/
  // filtered and miss the event the user RSVPd to).
  rsvps: {},
  // Favorited venues — separate from rsvps. RSVP = "I'm going to this dated
  // event"; favorite = "I want to remember this place". Stored as
  // {placeId: {name, venue, icon}} keyed by event id (venues are events
  // with category in VENUE_CATEGORIES). Synced via the user_state blob.
  favorites: {},
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

  // User profile — picks a default mood and the priority order of moods
  // on Home suggestions. One of: 'tranquilo' | 'curioso' | 'animado' |
  // 'familia' | null (skipped). Can be changed any time on the Profile
  // screen. See PROFILES dict above for what each one means.
  profile: null,

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

  // Push notifications
  pushOptedIn: false,         // true once the device has an active subscription
  pushDismissed: false,       // true if user explicitly declined a permission ask
  pushPrimerSeen: false,      // primer modal at end of onboarding has been shown
  pushBannerDismissed: false, // user X'd the Home banner reminder (persistent)

  // Social feed privacy toggle (legacy — migrated into privacy object)
  shareRsvps: true,     // kept for backward compat; canonical source is privacy.shareRsvps

  // Granular privacy + notification controls. The `privacy` namespace
  // is shared with notification prefs so the existing SET_PRIVACY_OPTION
  // reducer covers both — the backend reads any key off `state.privacy`.
  privacy: {
    shareRsvps: true,              // show my RSVPs in friend feed
    showInFriendSuggestions: true,  // appear in "people near you" / friend suggestions
    showProfileToStrangers: false,  // non-friends can see my full profile
    dailyDigest: true,              // receive daily push w/ new events from the scrape
  },

  // Accessibility mode — large fonts + enhanced nav labels for older users
  accessibilityMode: false,

  // Custom events created by the user via companion chat suggestions
  customEvents: [],
}

// ── Reducer ────────────────────────────────────────────────
function reducer(state, action) {
  switch (action.type) {
    case 'JOIN_COHORT':
      return { ...state, hasJoined: true, joinedAt: state.joinedAt ?? Date.now() }

    case 'COMPLETE_IDENTITY_MIRROR':
      // Vestigial — the IdentityMirror screen is bypassed. Kept so any
      // stale reducer call doesn't crash; never updates profile though.
      return {
        ...state,
        identityMirrorCompleted: true,
        identityPastLife: action.payload?.pastLife,
        identityCurrentFeel: action.payload?.currentFeel,
      }

    case 'SET_PROFILE':
      // payload is a profile id ('tranquilo', 'curioso', 'animado',
      // 'familia') or null to clear it.
      return { ...state, profile: action.payload }

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

    case 'TOGGLE_FAVORITE': {
      // payload: { placeId, name?, venue?, icon?, headerBg? }
      const { placeId, name, venue, icon, headerBg } = action.payload
      const next = { ...state.favorites }
      if (next[placeId]) {
        delete next[placeId]
      } else {
        next[placeId] = { name, venue, icon, headerBg }
      }
      return { ...state, favorites: next }
    }

    case 'TOGGLE_RSVP': {
      // payload: { eventId, dateStart?, name?, venue? }
      // dateStart/name/venue are optional but recommended — without them
      // the upcoming count can't filter past events accurately.
      const { eventId, dateStart, name, venue } = action.payload
      const wasRsvped = !!state.rsvps[eventId]
      const next = { ...state.rsvps }
      if (wasRsvped) {
        delete next[eventId]
      } else {
        next[eventId] = { dateStart, name, venue }
      }
      const currentWeek = computeCurrentWeek(state.joinedAt)
      const weeksShownUp = !wasRsvped && !state.weeksShownUp.includes(currentWeek)
        ? [...state.weeksShownUp, currentWeek]
        : state.weeksShownUp
      return { ...state, rsvps: next, weeksShownUp }
    }

    case 'SAVE_DAY_ZERO': {
      // payload: { eventId, dateStart?, name?, venue? }
      const { eventId, dateStart, name, venue } = action.payload
      const currentWeek = computeCurrentWeek(state.joinedAt)
      const weeksShownUp = !state.weeksShownUp.includes(currentWeek)
        ? [...state.weeksShownUp, currentWeek]
        : state.weeksShownUp
      return {
        ...state,
        dayZeroSaved: true,
        dayZeroEventId: eventId,
        rsvps: { ...state.rsvps, [eventId]: { dateStart, name, venue } },
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
      // Logout — clear the Google identity AND the cached display name.
      // Without clearing userName, Profile keeps showing the previous
      // user's name and avatar initial after they sign out.
      if (!action.payload) {
        return { ...state, googleUser: null, userName: '' }
      }
      const { id, name, givenName, email, picture } = action.payload
      // If a different Google account is signing in, take their name as the
      // new display name. (When the same account re-logs in, we preserve
      // a custom name the user might have edited via the Profile pencil.)
      const isSameUser = state.googleUser?.id === id
      return {
        ...state,
        googleUser: { id, name, givenName, email, picture },
        userName: isSameUser && state.userName
          ? state.userName
          : (givenName || name.split(' ')[0] || ''),
      }
    }

    case 'SET_PUSH_OPTED_IN':
      return { ...state, pushOptedIn: true }

    case 'SET_PUSH_OPTED_OUT':
      // Explicit opt-out from Profile toggle — the device's
      // subscription was removed, so the next visit shouldn't think
      // we're still subscribed. pushDismissed stays as-is so the
      // banner / primer don't re-prompt the same user.
      return { ...state, pushOptedIn: false }

    case 'SET_PUSH_DISMISSED':
      return { ...state, pushDismissed: true }

    case 'MARK_PUSH_PRIMER_SEEN':
      return { ...state, pushPrimerSeen: true }

    case 'DISMISS_PUSH_BANNER':
      return { ...state, pushBannerDismissed: true }

    case 'SET_SHARE_RSVPS':
      // Backward compat: update both top-level and privacy object
      return {
        ...state,
        shareRsvps: action.payload,
        privacy: { ...state.privacy, shareRsvps: action.payload },
      }

    case 'SET_PRIVACY_OPTION': {
      const { key, value } = action.payload
      const updated = { ...state, privacy: { ...state.privacy, [key]: value } }
      // Keep top-level shareRsvps in sync for backward compat
      if (key === 'shareRsvps') updated.shareRsvps = value
      return updated
    }

    case 'TOGGLE_ACCESSIBILITY':
      return { ...state, accessibilityMode: !state.accessibilityMode }

    case 'ADD_CUSTOM_EVENT': {
      const ev = action.payload
      return {
        ...state,
        customEvents: [...state.customEvents, ev],
        rsvps: {
          ...state.rsvps,
          [ev.id]: { dateStart: ev.dateStart, name: ev.name, venue: ev.venue },
        },
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
        profile:                  remote.profile                  ?? state.profile,
        userGoal:                 remote.userGoal                 ?? state.userGoal,
        frameworkRead:            remote.frameworkRead            ?? state.frameworkRead,
        diagnosticSeen:           remote.diagnosticSeen           ?? state.diagnosticSeen,
        language:     state.language     || remote.language,
        userName:     state.userName     || remote.userName,
        neighborhood: state.neighborhood || remote.neighborhood,
        // Merge privacy settings: remote wins, with migration from legacy shareRsvps
        privacy: remote.privacy
          ? { ...state.privacy, ...remote.privacy }
          : state.privacy,
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
        profile: null,
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

const STORAGE_KEY = 'aue_state'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return INITIAL_STATE
    const parsed = { ...INITIAL_STATE, ...JSON.parse(raw) }
    // Migrate legacy state: if privacy object is missing, build it from top-level shareRsvps
    if (!parsed.privacy || typeof parsed.privacy !== 'object') {
      parsed.privacy = {
        ...INITIAL_STATE.privacy,
        shareRsvps: parsed.shareRsvps ?? true,
      }
    }
    // Migrate legacy rsvps shape: boolean-true → empty metadata object.
    // Old shape was `{[id]: true}`; new shape is `{[id]: {dateStart, name, venue}}`.
    // Without dateStart we can't filter past events, but the entry counts.
    if (parsed.rsvps && typeof parsed.rsvps === 'object') {
      const migrated = {}
      for (const [id, value] of Object.entries(parsed.rsvps)) {
        if (value === true) migrated[id] = {}              // legacy truthy
        else if (value && typeof value === 'object') migrated[id] = value
        // value === false / null / undefined → not RSVPd, skip
      }
      parsed.rsvps = migrated
    }
    return parsed
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
