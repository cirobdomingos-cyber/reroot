// Distance helpers for the map's "Mais perto de você" list. Pure, so the
// ranking is unit-tested without a map or a GPS.

const EARTH_KM = 6371

// Great-circle distance in km between [lat, lng] pairs (haversine).
export function distanceKm([lat1, lng1], [lat2, lng2]) {
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a))
}

// The `limit` closest events to `pos`, one per venue (the map already
// collapses a venue into one pin; listing it five times would too).
export function nearestEvents(events, pos, limit = 5) {
  const seen = new Set()
  return (events || [])
    .filter((e) => typeof e.lat === 'number' && typeof e.lng === 'number')
    .map((event) => ({ event, km: distanceKm(pos, [event.lat, event.lng]) }))
    .sort((a, b) => a.km - b.km)
    .filter(({ event }) => {
      const key = `${event.lat.toFixed(4)},${event.lng.toFixed(4)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

// "350 m" under a kilometre, "1,2 km" under ten, "14 km" beyond.
export function formatDistance(km) {
  if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m`
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`
  return `${Math.round(km)} km`
}
