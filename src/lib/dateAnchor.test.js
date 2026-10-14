import { describe, it, expect } from 'vitest'
import {
  cityTodayIso, getAnchorToday, wallTs, isOngoing, eventCoversDay,
} from './dateAnchor'

// Wednesday 14 Oct 2026 in Curitiba (UTC-3, no DST). The bug: at 03:20
// the strip opened on Tuesday 13, because "today" flipped at 06:00
// device-local. Instants are given in UTC so the tests mean the same
// thing whatever timezone the runner is in.
const AT_0300_BRT = new Date('2026-10-14T06:00:00Z')
const AT_2300_BRT = new Date('2026-10-15T02:00:00Z')

// Feed shape: Curitiba wall-clock time with a "+00:00" suffix.
const lastNightShow = { dateStart: '2026-10-13T22:00:00+00:00' }
const tuesdayAfternoon = { dateStart: '2026-10-13T15:00:00+00:00' }
const tonight = { dateStart: '2026-10-14T21:00:00+00:00' }
const exhibition = { dateStart: '2026-10-10T10:00:00+00:00', dateEnd: '2026-10-20T18:00:00+00:00' }
const wednesdays = { isRecurring: true, recurrenceDays: [3], dateStart: '2026-10-21T20:00:00+00:00' }
const tuesdays = { isRecurring: true, recurrenceDays: [2], dateStart: '2026-10-20T20:00:00+00:00' }

describe('today in Curitiba', () => {
  it.each([
    ['03:00 BRT', AT_0300_BRT],
    ['23:00 BRT', AT_2300_BRT],
  ])('is Wednesday 14 at %s', (_, now) => {
    expect(cityTodayIso(now)).toBe('2026-10-14')
    const d = getAnchorToday(now)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getDay()]).toEqual([2026, 10, 14, 3])
  })
})

describe('wallTs', () => {
  it('reads the wall-clock time and ignores the offset suffix', () => {
    expect(wallTs('2026-10-14T21:00:00+00:00')).toBe(Date.UTC(2026, 9, 14, 21))
    expect(wallTs('2026-10-14T21:00:00-03:00')).toBe(Date.UTC(2026, 9, 14, 21))
    expect(wallTs('2026-10-14')).toBe(Date.UTC(2026, 9, 14))
    expect(wallTs('')).toBeNaN()
  })
})

describe('eventCoversDay at 03:00 BRT', () => {
  const now = AT_0300_BRT
  it('lists last night\'s show, still running, under today', () => {
    expect(isOngoing(lastNightShow, now)).toBe(true)
    expect(eventCoversDay(lastNightShow, '2026-10-14', now)).toBe(true)
  })
  it('does not list an event that ended yesterday', () => {
    expect(eventCoversDay(tuesdayAfternoon, '2026-10-14', now)).toBe(false)
  })
  it('lists tonight, ranges and today\'s weekday residency under today', () => {
    expect(eventCoversDay(tonight, '2026-10-14', now)).toBe(true)
    expect(eventCoversDay(exhibition, '2026-10-14', now)).toBe(true)
    expect(eventCoversDay(wednesdays, '2026-10-14', now)).toBe(true)
  })
  it('treats Tuesday as past for a residency', () => {
    expect(eventCoversDay(tuesdays, '2026-10-13', now)).toBe(false)
    expect(eventCoversDay(tuesdays, '2026-10-20', now)).toBe(true)
  })
})

describe('eventCoversDay at 23:00 BRT', () => {
  const now = AT_2300_BRT
  it('has dropped last night\'s show from today', () => {
    expect(isOngoing(lastNightShow, now)).toBe(false)
    expect(eventCoversDay(lastNightShow, '2026-10-14', now)).toBe(false)
  })
  it('still lists tonight, which started at 21:00, under today', () => {
    expect(isOngoing(tonight, now)).toBe(true)
    expect(eventCoversDay(tonight, '2026-10-14', now)).toBe(true)
    expect(eventCoversDay(tonight, '2026-10-15', now)).toBe(false)
  })
  it('lists the range and the Wednesday residency under today', () => {
    expect(eventCoversDay(exhibition, '2026-10-14', now)).toBe(true)
    expect(eventCoversDay(wednesdays, '2026-10-14', now)).toBe(true)
  })
})
