import { Capacitor } from '@capacitor/core'
import { NATIVE_PUBLIC_ORIGIN } from './share'

/**
 * Where the backend lives. ONE definition, imported everywhere.
 *
 * There were seven copies of this expression, and all but one resolved it
 * as `import.meta.env.VITE_API_URL ?? ''`. That is wrong in a way that
 * only bites native builds shipped over the air:
 *
 *   - The Dockerfile declares `ARG VITE_API_URL` + `ENV VITE_API_URL=$VITE_API_URL`,
 *     so with no build arg the variable exists as an EMPTY STRING, not absent.
 *   - `??` only falls through on null/undefined, so the empty string wins
 *     and the value stays ''.
 *   - '' means "same origin", which is right on the web and catastrophic in
 *     the Capacitor wrapper, where the document origin is capacitor://localhost.
 *
 * The binary never showed it because the iOS workflow sets VITE_API_URL
 * explicitly. Only the OTA bundle — built by the Dockerfile — carried the
 * empty value, so the failure appeared the first time a live update landed:
 * cloud saves failed, then Sign in with Apple failed, each traced to a
 * different copy of the same line.
 *
 * Hence `||`, and hence one module. An explicitly empty value means
 * "not configured", exactly like an absent one.
 */
const CONFIGURED = (import.meta.env.VITE_API_URL || '').trim()

export const API_BASE = CONFIGURED || (
  import.meta.env.DEV
    ? 'http://localhost:8000'
    // Native must be absolute; web stays relative so calls are same-origin.
    : (Capacitor.isNativePlatform?.() ? NATIVE_PUBLIC_ORIGIN : '')
)

export default API_BASE
