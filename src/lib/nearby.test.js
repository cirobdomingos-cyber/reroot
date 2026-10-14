import { describe, it, expect } from 'vitest'
import { distanceKm, nearestEvents, formatDistance } from './nearby'

const PRACA_TIRADENTES = [-25.4284, -49.2733]

describe('distanceKm', () => {
  it('is zero for the same point and ~1.1 km for 0.01° of latitude', () => {
    expect(distanceKm(PRACA_TIRADENTES, PRACA_TIRADENTES)).toBe(0)
    expect(distanceKm([0, 0], [0.01, 0])).toBeCloseTo(1.112, 2)
  })
})

describe('nearestEvents', () => {
  const ev = (id, lat, lng) => ({ id, lat, lng })
  const events = [
    ev('far', -25.30, -49.50),
    ev('near', -25.4290, -49.2740),
    ev('mid', -25.44, -49.29),
    ev('same-venue-as-near', -25.42901, -49.27401),
    { id: 'no-coords' },
  ]

  it('orders by distance, skips events without coords and repeats of a venue', () => {
    expect(nearestEvents(events, PRACA_TIRADENTES).map((r) => r.event.id)).toEqual(['near', 'mid', 'far'])
  })

  it('respects the limit', () => {
    expect(nearestEvents(events, PRACA_TIRADENTES, 1)).toHaveLength(1)
  })
})

describe('formatDistance', () => {
  it('reads like a person would say it', () => {
    expect(formatDistance(0.01)).toBe('50 m')
    expect(formatDistance(0.34)).toBe('350 m')
    expect(formatDistance(1.24)).toBe('1,2 km')
    expect(formatDistance(14.6)).toBe('15 km')
  })
})
