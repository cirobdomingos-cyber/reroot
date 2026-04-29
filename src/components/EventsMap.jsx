import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Curitiba center (Praça Tiradentes). Default zoom keeps the whole city
// roughly in frame at 14, which works on a phone.
const CTBA_CENTER = [-25.4284, -49.2733]
const DEFAULT_ZOOM = 13

// Round coords to ~10m so two events at the same venue collapse into one
// pin. 4 decimals = ~11m precision, plenty for venue-level dedup. Two
// events with slightly-different geocoded coords (e.g. one Nominatim + one
// AI) for the same place still cluster together.
function venueKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

// Custom DivIcon for a single-event pin. DivIcons sidestep Leaflet's
// default marker asset issues under Vite.
function singleIcon(emoji) {
  return L.divIcon({
    className: 'aue-event-pin',
    html: `<div style="
      display:flex;align-items:center;justify-content:center;
      width:34px;height:34px;
      background:var(--terra,#E8623F);
      color:white;border:2px solid white;border-radius:50%;
      font-size:16px;
      box-shadow:0 2px 6px rgba(0,0,0,0.25);
    ">${emoji || '📍'}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -16],
  })
}

// Cluster pin — bigger circle with a count badge. Used when ≥2 events
// share a venue under the current filter ("3 shows na Pedreira this
// weekend"). Keeps the map readable when the user picks a hot venue.
function clusterIcon(count) {
  return L.divIcon({
    className: 'aue-event-cluster',
    html: `<div style="
      position:relative;display:flex;align-items:center;justify-content:center;
      width:38px;height:38px;
      background:var(--terra,#E8623F);
      color:white;border:2px solid white;border-radius:50%;
      font-size:14px;font-weight:700;
      box-shadow:0 2px 8px rgba(0,0,0,0.3);
    ">${count}<div style="
      position:absolute;top:-4px;right:-4px;
      width:14px;height:14px;border-radius:50%;
      background:white;color:var(--terra,#E8623F);
      font-size:9px;font-weight:800;
      display:flex;align-items:center;justify-content:center;
      border:1px solid var(--terra,#E8623F);
    ">📍</div></div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -18],
  })
}

// Pulse dot for the user's geolocation. Animated via CSS keyframes
// injected once at the file scope so we don't pay for per-icon style
// re-injection.
const userLocationCss = `
  @keyframes aue-pulse {
    0%   { transform: scale(0.6); opacity: 1; }
    100% { transform: scale(2.4); opacity: 0; }
  }
`
function userIcon() {
  return L.divIcon({
    className: 'aue-user-pin',
    html: `<style>${userLocationCss}</style>
      <div style="position:relative;width:20px;height:20px">
        <div style="
          position:absolute;inset:0;border-radius:50%;
          background:#3B82F6;animation:aue-pulse 1.6s ease-out infinite;
        "></div>
        <div style="
          position:absolute;inset:0;width:20px;height:20px;
          background:#3B82F6;border:3px solid white;border-radius:50%;
          box-shadow:0 1px 4px rgba(0,0,0,0.4);
        "></div>
      </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  })
}

// Auto-fit the map to the markers when the set of pinned events changes.
// Without this, opening the map on a different filter would leave you
// staring at the default Praça Tiradentes view with all your pins on the
// edge of the canvas.
function FitToMarkers({ points }) {
  const map = useMap()
  useEffect(() => {
    if (!points.length) return
    const bounds = L.latLngBounds(points)
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 })
    }
  }, [points, map])
  return null
}

export default function EventsMap({ events, onPinTap }) {
  // Only events with coords are pinnable; everything else is silently
  // dropped from the map view. The empty-state banner (rendered by
  // the parent) explains why some events might be missing.
  const pinned = useMemo(
    () => (events || []).filter(e =>
      typeof e.lat === 'number' && typeof e.lng === 'number'
    ),
    [events],
  )

  // Cluster events by rounded coords. {key: {lat, lng, events: [...]}}.
  // Single-event clusters render as the normal pin; multi-event clusters
  // use the count icon and a list popup.
  const clusters = useMemo(() => {
    const m = new Map()
    for (const ev of pinned) {
      const k = venueKey(ev.lat, ev.lng)
      let bucket = m.get(k)
      if (!bucket) {
        bucket = { key: k, lat: ev.lat, lng: ev.lng, events: [] }
        m.set(k, bucket)
      }
      bucket.events.push(ev)
    }
    return Array.from(m.values())
  }, [pinned])

  // User geolocation — opt-in via browser prompt the first time. We
  // never ship coords anywhere; pin is local-only.
  const [userPos, setUserPos] = useState(null)
  const [geoError, setGeoError] = useState(null)
  function requestLocation() {
    if (!navigator.geolocation) {
      setGeoError('Seu navegador não suporta geolocalização')
      return
    }
    setGeoError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => setUserPos([pos.coords.latitude, pos.coords.longitude]),
      (err) => setGeoError(err?.message || 'Não consegui pegar sua localização'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
    )
  }

  // FitToMarkers gets every pin position PLUS the user when present, so
  // "fit bounds" zooms out to include both you and the catalog.
  const fitPoints = useMemo(
    () => [...clusters.map(c => [c.lat, c.lng]), ...(userPos ? [userPos] : [])],
    [clusters, userPos],
  )

  return (
    <div style={{
      position: 'relative',
      height: 'calc(100vh - 220px)',
      minHeight: 360,
      borderRadius: 12, overflow: 'hidden',
      margin: '0 16px 12px',
      border: '1px solid var(--border)',
    }}>
      <MapContainer
        center={CTBA_CENTER}
        zoom={DEFAULT_ZOOM}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitToMarkers points={fitPoints} />
        {clusters.map(c => {
          const single = c.events.length === 1
          const ev = c.events[0]
          return (
            <Marker
              key={c.key}
              position={[c.lat, c.lng]}
              icon={single ? singleIcon(ev.categoryEmoji || ev.icon) : clusterIcon(c.events.length)}
              // No eager click handler — let Leaflet open the Popup. The
              // detail drawer only opens when the user taps "Ver detalhes"
              // inside the popup. Previously a pin tap fired both at once,
              // which loaded the drawer behind the map z-index.
            >
              <Popup>
                {single ? (
                  <div style={{ minWidth: 180, maxWidth: 240 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#2C2C2C', marginBottom: 4 }}>
                      {ev.name}
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>
                      {ev.venue}{ev.date ? ` · ${ev.date}` : ''}
                      {ev.time ? ` · ${ev.time}` : ''}
                    </div>
                    <button
                      onClick={() => onPinTap?.(ev)}
                      style={{
                        marginTop: 8, padding: '5px 10px',
                        background: 'var(--terra,#E8623F)', color: 'white',
                        border: 'none', borderRadius: 6,
                        fontSize: 11, fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      Ver detalhes →
                    </button>
                  </div>
                ) : (
                  <div style={{ minWidth: 200, maxWidth: 280 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#2C2C2C', marginBottom: 6 }}>
                      📍 {c.events.length} eventos no mesmo local
                    </div>
                    <div style={{ fontSize: 10, color: '#888', marginBottom: 8 }}>
                      {c.events[0].venue}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
                      {c.events.map(e => (
                        <button
                          key={e.id}
                          onClick={() => onPinTap?.(e)}
                          style={{
                            textAlign: 'left', padding: '6px 8px',
                            background: '#FAFAFA', border: '1px solid #EEE',
                            borderRadius: 6, cursor: 'pointer',
                          }}
                        >
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#2C2C2C' }}>
                            {e.name}
                          </div>
                          <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
                            {e.date}{e.time ? ` · ${e.time}` : ''}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Popup>
            </Marker>
          )
        })}
        {userPos && (
          <Marker position={userPos} icon={userIcon()}>
            <Popup>
              <div style={{ fontSize: 12, fontWeight: 700 }}>📍 Você está aqui</div>
            </Popup>
          </Marker>
        )}
      </MapContainer>

      {/* "Onde estou" button — hovers the bottom-right of the map, asks
          for geolocation on tap. Single-press flow; if denied, we surface
          the error inline so the user knows what happened. */}
      <button
        onClick={requestLocation}
        title="Mostrar minha localização"
        style={{
          position: 'absolute', bottom: 16, right: 16,
          width: 44, height: 44, borderRadius: '50%',
          background: 'white', border: 'none',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          fontSize: 18, cursor: 'pointer', zIndex: 500,
        }}
      >
        📍
      </button>
      {geoError && (
        <div style={{
          position: 'absolute', bottom: 70, right: 16, left: 16,
          padding: '8px 12px', background: '#FFEBEE', color: '#B71C1C',
          borderRadius: 8, fontSize: 11, zIndex: 500,
        }}>
          {geoError}
        </div>
      )}

      {/* Empty-state badge when filters yielded zero pinnable events. */}
      {pinned.length === 0 && (
        <div style={{
          position: 'absolute', top: 12, left: 12, right: 12,
          padding: '10px 14px', background: 'rgba(255,255,255,0.95)',
          borderRadius: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          fontSize: 12, color: 'var(--charcoal-mid)', textAlign: 'center',
          zIndex: 500,
        }}>
          Nenhum evento mapeado com esse filtro. Tenta outra categoria
          ou volta pra <b>Lista</b>.
        </div>
      )}
    </div>
  )
}
