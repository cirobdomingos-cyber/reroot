import { useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Curitiba center (Praça Tiradentes). Default zoom keeps the whole city
// roughly in frame at 14, which works on a phone.
const CTBA_CENTER = [-25.4284, -49.2733]
const DEFAULT_ZOOM = 13

// Custom DivIcon — Leaflet's default marker requires bundler-specific
// asset hacks (the asset URLs go missing under Vite). A DivIcon is
// dependency-free, scales fine, and matches the auê palette.
function eventIcon(emoji) {
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

// Auto-fit the map to the markers when the set of pinned events changes.
// Without this, opening the map on a different filter would leave you
// staring at the default Praça Tiradentes view with all your pins on the
// edge of the canvas.
function FitToMarkers({ events }) {
  const map = useMap()
  useEffect(() => {
    if (!events.length) return
    const bounds = L.latLngBounds(events.map(e => [e.lat, e.lng]))
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 })
    }
  }, [events, map])
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
        <FitToMarkers events={pinned} />
        {pinned.map(ev => (
          <Marker
            key={ev.id}
            position={[ev.lat, ev.lng]}
            icon={eventIcon(ev.categoryEmoji || ev.icon)}
            eventHandlers={{ click: () => onPinTap?.(ev) }}
          >
            <Popup>
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
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {/* Empty-state badge when filters yielded zero pinnable events.
          Live above the map so the user sees both the empty state AND
          the map (in case they want to pan around the city while the
          filter is on). */}
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
