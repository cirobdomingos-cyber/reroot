import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// loadUserState has to tell "nothing there" from "couldn't ask". After
// the first it is safe to start saving (a new account); after the
// second it is not — the server may hold the only copy of this person's
// name and photo. Conflating them is how an Apple user lost both.

let loadUserState
beforeEach(async () => {
  vi.resetModules()
  ;({ loadUserState } = await import('./api'))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('loadUserState', () => {
  it('returns the state when there is one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ state: { userName: 'Bia' } }) })))
    expect(await loadUserState('u1')).toEqual({ state: { userName: 'Bia' } })
  })
  it('says notFound on 404 — a new account, safe to save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    expect(await loadUserState('u1')).toEqual({ notFound: true })
  })
  it('says failed on a 5xx — not safe to save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    expect(await loadUserState('u1')).toEqual({ failed: true })
  })
  it('says failed when the network throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await loadUserState('u1')).toEqual({ failed: true })
  })
})
