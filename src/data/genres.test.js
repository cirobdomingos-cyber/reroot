import { describe, expect, it } from 'vitest'
import { GENRE_META, GENRE_ORDER, genreLabel, groupByGenre } from './genres'

// groupByGenre decides whether the Novidades digest renders as sections
// or as a plain list. The interesting part isn't the grouping, it's the
// refusal to group: headings cost vertical space, and five events under
// three headings reads as three thin sections rather than as
// organisation. These pin the thresholds so a later tweak is a
// deliberate change rather than a drift.

const ev = (id, genre = '') => ({ id, genre })
const many = (n, genre) => Array.from({ length: n }, (_, i) => ev(`${genre}${i}`, genre))

describe('groupByGenre — when NOT to group', () => {
  it('leaves a short digest flat however varied it is', () => {
    expect(groupByGenre([...many(2, 'rock'), ...many(2, 'forro'), ev('x')])).toBeNull()
  })

  it('leaves a single-genre digest flat', () => {
    expect(groupByGenre(many(12, 'rock'))).toBeNull()
  })

  it('leaves it flat when only one genre has enough to be a section', () => {
    // Seven rock nights and one lone forró is a rock list with a
    // footnote, not two sections.
    expect(groupByGenre([...many(7, 'rock'), ev('f', 'forro')])).toBeNull()
  })

  it('handles an empty or missing list', () => {
    expect(groupByGenre([])).toBeNull()
    expect(groupByGenre(null)).toBeNull()
  })
})

describe('groupByGenre — when it does group', () => {
  const digest = [
    ...many(5, 'rock'),
    ...many(2, 'forro'),
    ev('u1'), ev('u2'),
  ]

  it('groups once two genres each carry enough', () => {
    const sections = groupByGenre(digest)
    expect(sections).not.toBeNull()
    expect(sections.map(s => s.label)).toEqual(['Rock', 'Forró', 'E mais'])
  })

  it('orders sections by size, biggest first', () => {
    const sections = groupByGenre([
      ...many(2, 'forro'), ...many(4, 'rock'), ...many(2, 'pop'), ev('u1'), ev('u2'),
    ])
    expect(sections.map(s => s.events.length)).toEqual([4, 2, 2, 2])
    expect(sections[0].label).toBe('Rock')
  })

  it('keeps the untagged remainder last', () => {
    const sections = groupByGenre(digest)
    expect(sections.at(-1).genre).toBe('')
  })

  it('does not call the untagged section "sem gênero"', () => {
    // Most of those events aren't music at all. Naming the absence of a
    // tag describes our data model rather than the reader's night.
    const label = groupByGenre(digest).at(-1).label
    expect(label).toBe('E mais')
    expect(label.toLowerCase()).not.toContain('gênero')
  })

  it('omits the remainder section entirely when everything is tagged', () => {
    const sections = groupByGenre([...many(5, 'rock'), ...many(3, 'forro')])
    expect(sections.map(s => s.genre)).toEqual(['rock', 'forro'])
  })

  it('loses no events', () => {
    const sections = groupByGenre(digest)
    const total = sections.reduce((n, s) => n + s.events.length, 0)
    expect(total).toBe(digest.length)
  })

  it('treats a genre outside the vocabulary as untagged', () => {
    // The backend drops invented genres, but an old cached payload or a
    // future vocabulary change could still put one here. It must not
    // become a section with an undefined label.
    const sections = groupByGenre([
      ...many(5, 'rock'), ...many(2, 'forro'), ev('x', 'axe_paulista'),
    ])
    expect(sections.every(s => s.label)).toBe(true)
    expect(sections.at(-1).events.map(e => e.id)).toContain('x')
  })
})

describe('the vocabulary itself', () => {
  it('has a label and emoji for every listed genre', () => {
    for (const genre of GENRE_ORDER) {
      expect(GENRE_META[genre]?.label, genre).toBeTruthy()
      expect(GENRE_META[genre]?.emoji, genre).toBeTruthy()
    }
  })

  it('lists exactly the genres it describes — no orphans either way', () => {
    expect([...GENRE_ORDER].sort()).toEqual(Object.keys(GENRE_META).sort())
  })

  it('matches the closed vocabulary the backend enforces', () => {
    // GENRES in backend/enrichment.py. Kept in sync by hand; the backend
    // rejects anything outside it, so a drift here would surface as a
    // 400 from the curator edit sheet naming the valid values.
    expect([...GENRE_ORDER].sort()).toEqual([
      'classica', 'eletronica', 'forro', 'jazz_blues', 'mpb',
      'pop', 'rap_trap', 'rock', 'samba_pagode', 'sertanejo',
    ])
  })

  it('returns an empty label for no genre', () => {
    expect(genreLabel('')).toBe('')
    expect(genreLabel('axe_paulista')).toBe('')
  })
})
