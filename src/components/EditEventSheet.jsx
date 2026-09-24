import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { updateGroupEvent, extractIgEvent } from '../services/api'

// Bottom sheet for editing the content fields of a group event or
// personal plan. Co-hosts, visibility, and invitees have their own
// dedicated affordances — this sheet covers what the PATCH endpoint
// accepts: name, venue, date, description, note, and — for an event
// that has no Instagram link yet — the post it came from. Pasting a
// post link reads the post (same call as the creation sheet) to fill
// what's still empty, and saving attaches link + flyer. An event the
// catalog already has can instead be picked from `catalogEvents` (the
// list the screen has loaded): the row then reads its facts and cover
// off that catalog event, keeping whatever was edited by hand.
//
// Permission: caller is responsible for only mounting this when the
// viewer is creator, co-host or the founder. The backend re-checks
// anyway, but the UI shouldn't tease the option to people who can't
// use it.

const FIELD_LIMITS = { name: 200, venue: 200, description: 1000, note: 280 }
const IG_POST_RE = /instagram\.com\/(p|reel)\//i

// Convert backend ISO 8601 ("2026-05-15T20:00:00") to the shape iOS's
// <input type="datetime-local"> expects: same format minus seconds and
// timezone. Backend tolerates both on the round-trip.
function toLocalInputValue(iso) {
  if (!iso) return ''
  // Strip seconds + tz to fit "YYYY-MM-DDTHH:MM"
  return iso.slice(0, 16)
}

export default function EditEventSheet({ open, onClose, event, googleId, onSaved, catalogEvents = [] }) {
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [dateStart, setDateStart] = useState('')
  const [description, setDescription] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Instagram link, offered only when the event has none yet.
  const [igUrl, setIgUrl] = useState('')
  const [postData, setPostData] = useState(null)
  const [extracting, setExtracting] = useState(false)
  const [extractMsg, setExtractMsg] = useState('')
  const extractTimer = useRef(null)
  const extractSeq = useRef(0)
  // Catalog pick: a search over the loaded list, then one chosen row.
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogPick, setCatalogPick] = useState(null)

  const hasIgLink = IG_POST_RE.test(event?.url || '')
  const hasCatalogLink = !!event?.sourceEventId
  const q = catalogQuery.trim().toLowerCase()
  const catalogMatches = q.length < 2 ? [] : catalogEvents
    .filter(e => !e.isGroupEvent && (
      (e.name || '').toLowerCase().includes(q) || (e.venue || '').toLowerCase().includes(q)
    ))
    .slice(0, 6)

  // Reset form whenever the sheet opens for a new event. Only repopulate
  // when `open` flips true so we don't clobber in-progress edits if the
  // event prop reference changes during typing.
  useEffect(() => {
    if (!open || !event) return
    setName(event.name || '')
    setVenue(event.venue || '')
    setDateStart(toLocalInputValue(event.dateStart || event.date_start || ''))
    setDescription(event.description || '')
    setNote(event.note || '')
    setIgUrl('')
    setPostData(null)
    setExtractMsg('')
    setCatalogQuery('')
    setCatalogPick(null)
    setError('')
  }, [open, event?.id])

  useEffect(() => () => clearTimeout(extractTimer.current), [])

  function handleLinkChange(val) {
    setIgUrl(val)
    setExtractMsg('')
    clearTimeout(extractTimer.current)
    if (!val.trim()) { setPostData(null); return }
    if (!IG_POST_RE.test(val)) return
    // Debounced: fires once the user stops typing/pasting. Apify can take
    // several seconds on a cold start, so the fields fill in when it lands.
    extractTimer.current = setTimeout(async () => {
      const seq = ++extractSeq.current
      setExtracting(true)
      try {
        const data = await extractIgEvent(val.trim())
        if (seq !== extractSeq.current) return
        setPostData(data)
        // Fill only what's still empty — never overwrite something typed.
        if (data.name) setName(prev => prev || data.name)
        if (data.venue_name) setVenue(prev => prev || data.venue_name)
        if (data.description) setDescription(prev => prev || data.description)
        if (data.date_start) setDateStart(prev => prev || String(data.date_start).slice(0, 16))
        const filled = data.name || data.date_start || data.venue_name
        setExtractMsg(data.image_url
          ? (filled ? '✓ Li o post — flyer vem junto ao salvar' : '✓ Flyer vem junto ao salvar')
          : 'Não consegui ler o post. O link fica salvo mesmo assim.')
      } catch {
        if (seq !== extractSeq.current) return
        setPostData(null)
        setExtractMsg('Não consegui ler o post. O link fica salvo mesmo assim.')
      } finally {
        if (seq === extractSeq.current) setExtracting(false)
      }
    }, 800)
  }

  async function handleSave() {
    if (!event || saving) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Nome não pode ficar vazio')
      return
    }
    const link = igUrl.trim()
    if (link && !IG_POST_RE.test(link)) {
      setError('Cola o link de um post do Instagram (instagram.com/p/… ou /reel/…)')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await updateGroupEvent(event.id, googleId, {
        name: trimmedName.slice(0, FIELD_LIMITS.name),
        venue: venue.trim().slice(0, FIELD_LIMITS.venue),
        date_start: dateStart || null,
        description: description.trim().slice(0, FIELD_LIMITS.description),
        note: note.trim().slice(0, FIELD_LIMITS.note),
        // Only when the person attached a post: the backend leaves the
        // link alone otherwise. Same four fields the creation sheet
        // sends from its link field.
        ...(link ? {
          source_url: link,
          image_url: postData?.image_url || '',
          source_ig_handle: postData?.handle || '',
          post: postData,
        } : {}),
        ...(catalogPick ? { source_event_id: catalogPick.id } : {}),
      })
      onSaved?.(result.event, result.view)
      onClose()
    } catch (err) {
      setError('Falha ao salvar. Tenta de novo.')
    }
    setSaving(false)
  }

  // Portal to document.body so the sheet escapes AnimatedPage's
  // framer-motion transform stacking context — otherwise BottomNav
  // sits ON TOP of the sheet no matter the z-index.
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
              zIndex: 10501,
              // Cap at 85% of viewport so on small phones (and with the
              // iOS keyboard up) you can always see what's behind the
              // sheet to confirm context. Content area below scrolls;
              // the action footer is sticky.
              maxHeight: '85vh',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ flexShrink: 0, padding: '6px 20px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 12px' }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }}/>
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 700, textAlign: 'center', marginBottom: 18, color: 'var(--charcoal)' }}>
                Editar evento
              </h3>
            </div>

            {/* Scrollable content area — form fields. Pads the bottom so
                the last field doesn't sit flush against the sticky footer. */}
            <div style={{
              flex: 1, overflowY: 'auto', padding: '0 20px 8px',
              WebkitOverflowScrolling: 'touch', // iOS momentum scroll
            }}>

            <Field label="Nome">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={FIELD_LIMITS.name}
                style={inputStyle}
              />
            </Field>

            <Field label="Local">
              <input
                type="text"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="Ex.: Bar Brahma"
                maxLength={FIELD_LIMITS.venue}
                style={inputStyle}
              />
            </Field>

            <Field label="Data e hora">
              <input
                type="datetime-local"
                value={dateStart}
                onChange={(e) => setDateStart(e.target.value)}
                style={inputStyle}
              />
            </Field>

            <Field label="Descrição">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={FIELD_LIMITS.description}
                placeholder="Detalhes opcionais do evento"
                style={{ ...inputStyle, resize: 'none', fontFamily: 'inherit' }}
              />
            </Field>

            {!hasCatalogLink && (
              <Field label="É um evento do catálogo? (opcional)">
                {catalogPick ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', borderRadius: 10,
                    background: 'var(--sage-pale)', border: '1px solid var(--sage)',
                    fontSize: 13, color: 'var(--charcoal)',
                  }}>
                    <span style={{ flex: 1 }}>
                      🔗 {catalogPick.name}{catalogPick.venue ? ` · ${catalogPick.venue}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCatalogPick(null)}
                      aria-label="Desfazer"
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, color: 'var(--charcoal-mid)' }}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      type="search"
                      value={catalogQuery}
                      onChange={(e) => setCatalogQuery(e.target.value)}
                      placeholder="Busca pelo nome ou local"
                      style={inputStyle}
                    />
                    {catalogMatches.length > 0 && (
                      <div style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                        {catalogMatches.map((e, i) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => { setCatalogPick(e); setCatalogQuery('') }}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left',
                              padding: '9px 12px', border: 'none', cursor: 'pointer',
                              background: 'var(--white)',
                              borderTop: i ? '1px solid var(--border)' : 'none',
                              fontSize: 13, color: 'var(--charcoal)',
                            }}
                          >
                            <div style={{ fontWeight: 600 }}>{e.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>
                              {[e.venue, e.date, e.time].filter(Boolean).join(' · ')}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    {q.length >= 2 && catalogMatches.length === 0 && (
                      <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 4 }}>
                        Nada com esse nome nos próximos rolês. Se tem post, cola o link abaixo.
                      </div>
                    )}
                  </>
                )}
              </Field>
            )}

            {!hasIgLink && !catalogPick && (
              <Field label="Link do Instagram (opcional)">
                <input
                  type="url"
                  inputMode="url"
                  value={igUrl}
                  onChange={(e) => handleLinkChange(e.target.value)}
                  placeholder="https://www.instagram.com/p/…"
                  style={inputStyle}
                />
                {(extracting || extractMsg) && (
                  <div style={{ fontSize: 11, color: 'var(--charcoal-light)', marginTop: 4 }}>
                    {extracting ? 'Lendo o post…' : extractMsg}
                  </div>
                )}
              </Field>
            )}

            <Field label="Mensagem pra galera (opcional)">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={FIELD_LIMITS.note}
                placeholder='"Bora porque..."'
                style={{ ...inputStyle, resize: 'none', fontFamily: 'inherit' }}
              />
              <CharCount value={note} max={FIELD_LIMITS.note} />
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

            </div>{/* /scrollable content area */}

            {/* Sticky footer — action buttons stay visible no matter
                how tall the form is or where the keyboard pushes the
                viewport. Bottom padding accommodates the iOS home bar. */}
            <div style={{
              flexShrink: 0,
              display: 'flex', gap: 10,
              padding: '12px 20px calc(12px + env(safe-area-inset-bottom, 0px))',
              borderTop: '1px solid var(--border)',
              background: 'var(--white)',
            }}>
              <button
                onClick={onClose}
                disabled={saving}
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
                onClick={handleSave}
                disabled={saving}
                style={{
                  flex: 1.4, padding: '12px', borderRadius: 12,
                  background: 'var(--terra)', border: 'none',
                  color: 'white', fontSize: 14, fontWeight: 700,
                  cursor: saving ? 'wait' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'Salvando...' : 'Salvar alterações'}
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

function CharCount({ value, max }) {
  if (!value) return null
  return (
    <div style={{ fontSize: 10, color: 'var(--charcoal-light)', textAlign: 'right', marginTop: 2 }}>
      {value.length} / {max}
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
