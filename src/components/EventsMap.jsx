import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { nearestEvents, formatDistance } from '../lib/nearby'

// Leaflet caches the container size, so a map whose box changed keeps
// drawing at the old dimensions (grey bands, pins in the wrong place)
// until it's told. The wrapper below resizes with the filters, so this
// has to run on every height change, not just on mount.
function InvalidateOnResize({ height }) {
  const map = useMap()
  useEffect(() => {
    const id = setTimeout(() => map.invalidateSize(), 60)
    return () => clearTimeout(id)
  }, [map, height])
  return null
}

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
      <div style="position:relative;width:24px;height:24px">
        <div style="
          position:absolute;inset:0;border-radius:50%;
          background:#3B82F6;animation:aue-pulse 1.6s ease-out infinite;
        "></div>
        <div style="
          position:absolute;inset:0;width:24px;height:24px;
          background:#3B82F6;border:4px solid white;border-radius:50%;
          box-shadow:0 1px 6px rgba(0,0,0,0.5);
        "></div>
      </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
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

// When "Perto de mim" resolves, centre on the person at neighbourhood
// zoom instead of fitting every pin: one out-of-town event used to pull
// the frame out to the whole metro area and bury the blue dot.
function FlyToUser({ pos }) {
  const map = useMap()
  useEffect(() => {
    if (pos) map.flyTo(pos, USER_ZOOM, { duration: 0.6 })
  }, [pos, map])
  return null
}
const USER_ZOOM = 14

// The map shares the screen with the list of what is nearby, so it stops
// at this share of the viewport instead of running to the tab bar.
const MAP_MAX_VH = 0.45

export default function EventsMap({ events, onPinTap }) {
  // The map used to be calc(100vh - 220px) — a guess at how much sat
  // above it. With the filter rows open that guess was ~100px short, so
  // the bottom of the map (and the "onde estou" button parked in its
  // corner) fell below the fold with nothing left to scroll. Measure the
  // real distance from the top of the map to the bottom of the screen
  // instead, and redo it whenever the page reflows — opening a filter
  // row, rotating the phone, the iOS toolbar sliding away.
  const wrapRef = useRef(null)
  const [mapHeight, setMapHeight] = useState(360)
  useEffect(() => {
    function measure() {
      const el = wrapRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top
      const vh = window.visualViewport?.height || window.innerHeight
      // BOTTOM_NAV + the wrapper's own bottom margin.
      const available = vh - top - 72 - 12
      setMapHeight(Math.max(260, Math.round(Math.min(available, vh * MAP_MAX_VH))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(document.body)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [])
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
  const [locating, setLocating] = useState(false)
  function requestLocation() {
    if (!navigator.geolocation) {
      setGeoError('Seu aparelho não deixa o app ver a localização.')
      return
    }
    setGeoError(null)
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        // A new array each time, so tapping again re-centres (FlyToUser).
        setUserPos([pos.coords.latitude, pos.coords.longitude])
      },
      (err) => {
        setLocating(false)
        setGeoError(err?.code === 1
          ? 'Localização bloqueada. Libere nos ajustes do aparelho para ver o que rola perto de você.'
          : 'Não consegui achar sua localização. Tenta de novo.')
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
    )
  }

  // Pins only: the person is framed by FlyToUser, not by fitting bounds.
  const fitPoints = useMemo(() => clusters.map(c => [c.lat, c.lng]), [clusters])
  const nearby = useMemo(
    () => (userPos ? nearestEvents(pinned, userPos, 5) : []),
    [pinned, userPos],
  )

  return (
    <>
    <div ref={wrapRef} style={{
      position: 'relative',
      height: mapHeight,
      minHeight: 260,
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
        <FlyToUser pos={userPos} />
        <InvalidateOnResize height={mapHeight} />
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
          <Marker position={userPos} icon={userIcon()} zIndexOffset={1000}>
            <Popup>
              <div style={{ fontSize: 12, fontWeight: 700 }}>📍 Você está aqui</div>
            </Popup>
          </Marker>
        )}
      </MapContainer>

      {/* "Perto de mim": a labelled pill in the primary colour at the top
          right, where the eye already is. It used to be a 📍 on a dark
          circle in the bottom corner, the same colour as the pins. */}
      <button
        data-testid="map-locate"
        onClick={requestLocation}
        disabled={locating}
        aria-label="Mostrar eventos perto de mim"
        style={{
          position: 'absolute', top: 12, right: 12,
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '9px 14px', borderRadius: 999,
          background: 'var(--magenta)', color: 'var(--on-magenta)',
          border: 'none', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
          fontSize: 13, fontWeight: 700, cursor: locating ? 'wait' : 'pointer',
          zIndex: 500,
        }}
      >
        <span aria-hidden="true">◎</span>
        {locating ? 'Localizando…' : userPos ? 'Recentralizar' : 'Perto de mim'}
      </button>
      {geoError && (
        <div role="alert" style={{
          position: 'absolute', top: 60, right: 12, left: 12,
          padding: '10px 12px', background: 'var(--bg2)', color: 'var(--text)',
          border: '1px solid var(--hot)', borderRadius: 10, fontSize: 12,
          zIndex: 500,
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
          fontSize: 12, color: 'var(--on-light)', textAlign: 'center',
          zIndex: 500,
        }}>
          Nenhum evento mapeado com esse filtro. Tenta outra categoria
          ou volta pra <b>Lista</b>.
        </div>
      )}
    </div>

    {/* What is closest, once we know where you are. The map answers
        "where", this answers "what can I get to" without hunting pins. */}
    {!userPos && !locating && pinned.length > 0 && (
      <div style={{ margin: '0 16px 16px', fontSize: 12, color: 'var(--text2)', textAlign: 'center' }}>
        Toque em <b style={{ color: 'var(--magenta)' }}>◎ Perto de mim</b> para ver o que rola mais perto de você.
      </div>
    )}
    {nearby.length > 0 && (
      <div data-testid="map-nearby" style={{ margin: '0 16px 16px' }}>
        <div className="neon-mono" style={{
          fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase',
          color: 'var(--text2)', marginBottom: 8,
        }}>
          Mais perto de você
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {nearby.map(({ event: ev, km }) => (
            <button
              key={ev.id}
              onClick={() => onPinTap?.(ev)}
              className="card"
              style={{
                display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                padding: '10px 12px', cursor: 'pointer', width: '100%',
              }}
            >
              <span style={{ fontSize: 18 }} aria-hidden="true">{ev.categoryEmoji || ev.icon || '📍'}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{ev.name}</span>
                <span style={{
                  display: 'block', fontSize: 11, color: 'var(--text2)', marginTop: 2,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {ev.venue}{ev.time ? ` · ${ev.time}` : ''}
                </span>
              </span>
              <span className="neon-mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--cyan)', flexShrink: 0 }}>
                {formatDistance(km)}
              </span>
            </button>
          ))}
        </div>
      </div>
    )}
    </>
  )
}
