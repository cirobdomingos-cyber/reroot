// ── The session: who this device is signed in as ──────────
//
// A sign-in verified by the backend (/auth/google, /auth/apple) answers
// with a bearer token. It lives in localStorage under `aue.session` and
// rides on every request to our own API as `Authorization: Bearer`, so
// the backend can hold a request to the account it names instead of
// taking the client's word for it.
//
// Only requests to API_BASE get the header. Google's and Apple's
// endpoints are called from here too, and a token of ours has no
// business travelling to them.

import { API_BASE } from './apiBase'

const KEY = 'aue.session'

export function getSessionToken() {
  try { return localStorage.getItem(KEY) || '' } catch { return '' }
}

export function setSessionToken(token) {
  try {
    if (token) localStorage.setItem(KEY, token)
    else localStorage.removeItem(KEY)
  } catch { /* private mode: the session lasts as long as the page */ }
}

export function clearSessionToken() { setSessionToken('') }

function isOurs(url) {
  const s = typeof url === 'string' ? url : String(url?.url || url || '')
  if (API_BASE) return s.startsWith(API_BASE)
  // Same-origin deploy: our calls are relative paths.
  return s.startsWith('/') && !s.startsWith('//')
}

/**
 * fetch() plus the session header for calls to our own backend. Drop-in:
 * same arguments, same return value.
 */
export function apiFetch(url, options = {}) {
  const token = getSessionToken()
  if (!token || !isOurs(url)) return fetch(url, options)
  const headers = new Headers(options.headers || {})
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, { ...options, headers })
}
