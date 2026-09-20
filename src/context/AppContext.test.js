import { describe, it, expect } from 'vitest'
import { reducer } from './AppContext'

// The display name is identity, and identity lives on the server.
// Reported from production: "mudei meu nome mas não refletiu pros
// outros" and "não persistiu ao sair e entrar" — one bug, two symptoms.

const google = { id: 'u1', name: 'Ciro Beduschi', givenName: 'Ciro', email: 'c@x.com', picture: '' }

function loginAndRestore(remote) {
  let s = reducer({ userName: '', googleUser: null }, { type: 'SET_GOOGLE_USER', payload: null })
  s = reducer(s, { type: 'SET_GOOGLE_USER', payload: google })
  return reducer(s, { type: 'RESTORE_STATE', payload: remote })
}

describe('the name you chose survives logging out and back in', () => {
  it('prefers the remote name over the one the provider seeded', () => {
    // Login seeds "Ciro" from Google; the server holds what the person
    // typed. Local used to win, which put "Ciro" back every time and
    // then saved it — so everyone else saw the revert too.
    const s = loginAndRestore({ userName: 'Beduschi' })
    expect(s.userName).toBe('Beduschi')
  })

  it('keeps the seeded name for an account with no remote name yet', () => {
    const s = loginAndRestore({})
    expect(s.userName).toBe('Ciro')
  })

  it('keeps the seeded name when the remote one is empty', () => {
    const s = loginAndRestore({ userName: '' })
    expect(s.userName).toBe('Ciro')
  })
})

describe('logging out', () => {
  it('clears the cached name so the next person does not inherit it', () => {
    const s = reducer({ userName: 'Beduschi', googleUser: google }, { type: 'SET_GOOGLE_USER', payload: null })
    expect(s.userName).toBe('')
    expect(s.googleUser).toBeNull()
  })
})
