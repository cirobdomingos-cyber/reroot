import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { updateCatalogEvent } from '../services/api'
import { CATEGORY_META, CATEGORY_ORDER } from '../data/categories'

// Curator sheet for correcting a CATALOG event — the ones scraped from
// Instagram and enriched by Claude. Distinct from EditEventSheet, which
// edits a group's own fork of an event and is scoped to its creator.
//
// Why it exists: the only lever over a bad extraction used to be DELETE,
// which throws away a real event because one field is wrong. A user
// reported an event "in the wrong place" and there was nothing to do
// about it short of deleting the night.
//
// Permission: caller mounts this only for curators. The backend
// re-checks (PATCH /admin/events/:id runs _require_curator), so this is
// about not teasing an option, not about security.
//
// Only changed fields are sent, and the backend pins exactly what it
// receives — so an untouched field keeps refreshing from Instagram on
// the next scrape, while a corrected one survives it.
//
// Not here: the map pin. Coordinates live on the venues row keyed by
// venue name and are shared by every event at that venue, so moving a
// pin from inside one event would silently move the others. That's
// PUT /admin/venues/{name_normalized}.

const FIELD_LIMITS = { name: 200, venue: 200, neighborhood: 100, description: 1000 }

// Same closed vocabulary as GENRES in backend/enrichment.py. Kept in
// sync by hand — the backend rejects anything outside it, so a drift
// here surfaces as a 400 with the valid list rather than bad data.
const GENRES = [
  ['', '— sem gênero —'],
  ['rock', 'Rock'],
  ['samba_pagode', 'Samba / Pagode'],
  ['sertanejo', 'Sertanejo'],
  ['eletronica', 'Eletrônica'],
  ['mpb', 'MPB'],
  ['rap_trap', 'Rap / Trap'],
  ['forro', 'Forró'],
  ['jazz_blues', 'Jazz / Blues'],
  ['classica', 'Clássica'],
  ['pop', 'Pop'],
]

// "Bar Folia · Água Verde" → ['Bar Folia', 'Água Verde']. The bairro is
// part of the rendered string rather than its own field on the event
// payload the frontend receives.
function splitVenue(venue) {
  if (!venue) return ['', '']
  const i = venue.indexOf(' · ')
  return i === -1 ? [venue.trim(), ''] : [venue.slice(0, i).trim(), venue.slice(i + 3).trim()]
}

// Backend ISO → the "YYYY-MM-DDTHH:MM" that <input type="datetime-local">
// expects. Slicing keeps the event's own local time rather than shifting
// it into the curator's timezone, which is what you want when fixing a
// date read off a flyer.
function toLocalInputValue(iso) {
  return iso ? iso.slice(0, 16) : ''
}

function parseMoney(value) {
  const n = Number(String(value).replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export default function EditCatalogEventSheet({ open, onClose, event, requestingEmail, onSaved }) {
  const [name, setName] = useState('')
  const [venueName, setVenueName] = useState('')
  const [neighborhood, setNeighborhood] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [priceMin, setPriceMin] = useState('')
  const [priceMax, setPriceMax] = useState('')
  const [kind, setKind] = useState('')
  const [genre, setGenre] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Repopulate only when the sheet opens for an event, so a re-render
  // while typing doesn't clobber in-progress edits.
  useEffect(() => {
    if (!open || !event) return
    const [vName, vBairro] = splitVenue(event.venue)
    setName(event.name || '')
    setVenueName(vName)
    setNeighborhood(vBairro)
    setDateStart(toLocalInputValue(event.dateStart || ''))
    setPriceMin(event.priceMin != null ? String(event.priceMin) : '')
    setPriceMax(event.priceMax != null ? String(event.priceMax) : '')
    setKind(event.category || '')
    setGenre(event.genre || '')
    setError('')
  }, [open, event?.id])

  // Send only what actually changed. The backend pins every field it
  // receives against the next scrape, so submitting an untouched field
  // would freeze it at its current value for no reason.
  function changedFields() {
    const [vName, vBairro] = splitVenue(event?.venue)
    const fields = {}
    if (name.trim() !== (event?.name || '')) fields.name = name.trim()
    if (venueName.trim() !== vName) fields.venue_name = venueName.trim()
    if (neighborhood.trim() !== vBairro) fields.neighborhood = neighborhood.trim()
    if (dateStart !== toLocalInputValue(event?.dateStart || '')) fields.date_start = dateStart
    if (kind !== (event?.category || '')) fields.kind = kind
    if (genre !== (event?.genre || '')) fields.genre = genre

    const pMin = priceMin === '' ? null : parseMoney(priceMin)
    const pMax = priceMax === '' ? null : parseMoney(priceMax)
    if (priceMin !== '' && pMin !== event?.priceMin) fields.price_min = pMin
    if (priceMax !== '' && pMax !== event?.priceMax) fields.price_max = pMax
    return fields
  }

  async function handleSave() {
    if (!event || saving) return
    if (!name.trim()) { setError('Nome não pode ficar vazio'); return }
    if (!venueName.trim()) { setError('Local não pode ficar vazio'); return }
    if (priceMin !== '' && parseMoney(priceMin) === null) { setError('Preço mínimo inválido'); return }
    if (priceMax !== '' && parseMoney(priceMax) === null) { setError('Preço máximo inválido'); return }

    const fields = changedFields()
    if (Object.keys(fields).length === 0) { onClose(); return }

    setSaving(true)
    setError('')
    try {
      const result = await updateCatalogEvent(event.id, requestingEmail, fields)
      onSaved?.(result.event, result.edited_fields || [])
      onClose()
    } catch (err) {
      // The backend's message is the useful one — it names the field and
      // the valid values (unknown genre, inverted price, bad date).
      setError(err?.message || 'Falha ao salvar. Tenta de novo.')
    }
    setSaving(false)
  }

  // Portal to body so the sheet escapes AnimatedPage's framer-motion
  // transform — otherwise BottomNav paints over it whatever the z-index.
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={saving ? undefined : onClose}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 10500 }}
          />
          <motion.div
            key="sheet"
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 350 }}
            className="aue-sheet"
            style={{
              position: 'fixed', bottom: 0, left: 0, right: 0,
              background: 'var(--white)', borderRadius: '20px 20px 0 0',
              zIndex: 10501, maxHeight: '85vh',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ flexShrink: 0, padding: '6px 20px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }} />
              </div>
              <h3 style={{
                fontSize: 16, fontWeight: 700, textAlign: 'center',
                marginBottom: 4, color: 'var(--charcoal)',
              }}>
                Corrigir evento
              </h3>
              <p style={{
                fontSize: 11, textAlign: 'center', color: 'var(--charcoal-light)',
                marginBottom: 16, lineHeight: 1.4,
              }}>
                O que você corrigir fica fixo — o próximo scrape não desfaz.
              </p>
            </div>

            <div style={{
              flex: 1, overflowY: 'auto', padding: '0 20px 8px',
              WebkitOverflowScrolling: 'touch',
            }}>
              <Field label="Nome">
                <input
                  type="text" value={name} maxLength={FIELD_LIMITS.name}
                  onChange={(e) => setName(e.target.value)} style={inputStyle}
                />
              </Field>

              <Field label="Local">
                <input
                  type="text" value={venueName} maxLength={FIELD_LIMITS.venue}
                  onChange={(e) => setVenueName(e.target.value)}
                  placeholder="Ex.: Bar Folia" style={inputStyle}
                />
              </Field>

              <Field label="Bairro">
                <input
                  type="text" value={neighborhood} maxLength={FIELD_LIMITS.neighborhood}
                  onChange={(e) => setNeighborhood(e.target.value)}
                  placeholder="Ex.: Água Verde" style={inputStyle}
                />
                <Hint>
                  Só vale pra local sem pin no mapa. Se o local já foi
                  geocodificado, o bairro vem de lá e ganha deste campo.
                </Hint>
              </Field>

              <Field label="Data e hora">
                <input
                  type="datetime-local" value={dateStart}
                  onChange={(e) => setDateStart(e.target.value)} style={inputStyle}
                />
              </Field>

              <Field label="Preço (R$)">
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text" inputMode="decimal" value={priceMin}
                    onChange={(e) => setPriceMin(e.target.value)}
                    placeholder="mín." style={inputStyle}
                  />
                  <input
                    type="text" inputMode="decimal" value={priceMax}
                    onChange={(e) => setPriceMax(e.target.value)}
                    placeholder="máx." style={inputStyle}
                  />
                </div>
                <Hint>Zero nos dois = grátis.</Hint>
              </Field>

              <Field label="Categoria">
                <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle}>
                  {CATEGORY_ORDER.map(c => (
                    <option key={c} value={c}>
                      {CATEGORY_META[c]?.emoji} {CATEGORY_META[c]?.label || c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Gênero musical">
                <select value={genre} onChange={(e) => setGenre(e.target.value)} style={inputStyle}>
                  {GENRES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </Field>

              {error && (
                <div style={{
                  padding: '10px 12px', marginTop: 4, marginBottom: 8,
                  background: '#FFEBEE', border: '1px solid #EF9A9A', borderRadius: 10,
                  color: '#B71C1C', fontSize: 12,
                }}>
                  {error}
                </div>
              )}
            </div>

            <div style={{
              flexShrink: 0, display: 'flex', gap: 10,
              padding: '12px 20px calc(12px + env(safe-area-inset-bottom, 0px))',
              borderTop: '1px solid var(--border)', background: 'var(--white)',
            }}>
              <button
                onClick={onClose} disabled={saving}
                style={{
                  flex: 1, padding: '12px', borderRadius: 12,
                  background: 'transparent', border: '1.5px solid var(--border)',
                  color: 'var(--charcoal-mid)', fontSize: 14, fontWeight: 600,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                onClick={handleSave} disabled={saving}
                style={{
                  flex: 1.4, padding: '12px', borderRadius: 12,
                  background: 'var(--terra)', border: 'none',
                  color: 'white', fontSize: 14, fontWeight: 700,
                  cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'Salvando...' : 'Salvar correção'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: 'block', fontSize: 11, fontWeight: 700,
        color: 'var(--charcoal-mid)', marginBottom: 5, letterSpacing: 0.3,
      }}>
        {label.toUpperCase()}
      </label>
      {children}
    </div>
  )
}

function Hint({ children }) {
  return (
    <div style={{
      fontSize: 10, color: 'var(--charcoal-light)', marginTop: 4, lineHeight: 1.4,
    }}>
      {children}
    </div>
  )
}

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1.5px solid var(--border)',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
  background: 'var(--cream)',
  color: 'var(--charcoal)',
}
