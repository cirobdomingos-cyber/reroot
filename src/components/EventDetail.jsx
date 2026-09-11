/**
 * The event detail view — one implementation, both entry points.
 *
 * Lived inside Events.jsx as DetailPanel while GroupDetail.jsx carried a
 * 421-line near-copy called GroupEventHero. Same event, two renderings:
 * the group one used a 180px hero against the feed's 240px, and its
 * no-image fallback was still `linear-gradient(135deg, var(--sage),
 * #9ec0a0)` — the pre-rebrand sage green. So an event with no photo
 * looked like old auê inside a group and like Neon Boteco in the feed.
 *
 * The copy was never necessary: this component has always handled group
 * events (the feed lists them and opens them here) and already takes
 * canInvite / canEdit / onCoHostsChanged / onDelete. GroupDetail just
 * grew its own before that was true.
 *
 * Callers pass the frontend-normalized camelCase event shape. GroupDetail
 * holds raw snake_case DB rows from /groups/{id}, so it normalizes at the
 * call site — see toDetailShape there.
 */
import { useState, useEffect, useRef } from 'react'
import AddToCalendar from './AddToCalendar'
import PostEventAttendees from './PostEventAttendees'
import Avatar from './Avatar'
import InviteRequestsPanel from './InviteRequestsPanel'
import AttendeesRow from './AttendeesRow'
import InvitePeopleSheet from './InvitePeopleSheet'
import CoHostsSheet from './CoHostsSheet'
import { compressImageForUpload } from '../lib/image-compress'
import { shareLink, shortEventLink } from '../lib/share'
import { trackEvent, uploadEventImage, deleteEventImage } from '../services/api'

function cleanDescription(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const decode = s => s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  let text = decode(raw)
  if (/&(lt|gt|amp|quot|#\d+);/.test(text)) text = decode(text)
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim()
  return text
}

function SymplaBuyButton({ ev }) {
  const igHandle = (ev.id || '').startsWith('instagram_ig_')
    ? (() => {
        const rest = ev.id.slice('instagram_ig_'.length)
        const i = rest.lastIndexOf('_')
        return i > 0 ? rest.slice(0, i) : ''
      })()
    : ''
  function buildUrl() {
    try {
      const u = new URL(ev.symplaUrl)
      u.searchParams.set('utm_source', 'aue')
      u.searchParams.set('utm_medium', 'referral')
      u.searchParams.set('utm_campaign', `event_${ev.id}`)
      return u.toString()
    } catch {
      return ev.symplaUrl
    }
  }
  function handleClick(e) {
    trackEvent('sympla_click', {
      event_id: ev.id,
      ig_handle: igHandle,
      sympla_url: ev.symplaUrl,
    })
  }
  return (
    <a
      href={buildUrl()}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 8, marginTop: 12, padding: '12px 16px',
        borderRadius: 12, textDecoration: 'none',
        background: 'var(--terra)', color: 'white',
        fontSize: 14, fontWeight: 700, letterSpacing: 0.3,
      }}
    >
      🎟️ Comprar ingresso na Sympla →
    </a>
  )
}

function PromoCodeBlock({ ev }) {
  // Two-state pill: collapsed "🎁 Mostrar código no balcão" → tap →
  // expanded card with the code monospaced + perk copy + a "copiar"
  // button. Tracks `code_view` on first reveal so the venue Painel
  // can count tighter conversions than view→RSVP.
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)

  function reveal() {
    if (revealed) return
    setRevealed(true)
    const igHandle = (ev.id || '').startsWith('instagram_ig_')
      ? (() => {
          const rest = ev.id.slice('instagram_ig_'.length)
          const i = rest.lastIndexOf('_')
          return i > 0 ? rest.slice(0, i) : ''
        })()
      : ''
    trackEvent('code_view', { event_id: ev.id, ig_handle: igHandle })
  }

  function copyCode() {
    try {
      navigator.clipboard.writeText(ev.promoCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch { /* swallow — copy is best-effort */ }
  }

  if (!revealed) {
    return (
      <button
        onClick={reveal}
        style={{
          width: '100%', marginBottom: 10,
          padding: '12px', borderRadius: 12,
          background: 'var(--honey-pale)',
          border: '1.5px solid var(--honey)',
          color: '#8D6E10', fontSize: 13, fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        🎁 Mostrar código no balcão
      </button>
    )
  }
  return (
    <div style={{
      marginBottom: 10, padding: '12px 14px',
      background: 'var(--honey-pale)',
      border: '1.5px solid var(--honey)', borderRadius: 12,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: '#8D6E10',
        textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4,
      }}>
        🎁 Cupom Seleção auê
      </div>
      <div style={{
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 18, fontWeight: 800, color: 'var(--charcoal)',
        letterSpacing: 0.6, marginBottom: 6, wordBreak: 'break-all',
      }}>
        {ev.promoCode}
      </div>
      {ev.promoPerk && (
        <div style={{ fontSize: 12, color: 'var(--charcoal-mid)', lineHeight: 1.4, marginBottom: 8 }}>
          {ev.promoPerk}
        </div>
      )}
      <button
        onClick={copyCode}
        style={{
          padding: '7px 14px', borderRadius: 10,
          background: 'var(--white)', border: '1px solid var(--honey)',
          color: '#8D6E10', fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}
      >
        {copied ? '✓ Copiado' : '📋 Copiar código'}
      </button>
      <div style={{
        fontSize: 10, color: 'var(--charcoal-light)',
        marginTop: 8, lineHeight: 1.4,
      }}>
        Mostre esse código no balcão pra resgatar. Cupom oferecido pelo
        local — auê só conecta.
      </div>
    </div>
  )
}

export default function EventDetail({ event: ev, googleId, viewerName, viewerPicture, rsvped, friendsGoing = [], onClose, onRsvp, onFriend, onSourceTap, onAddToGroup, onDelete, canInvite, onInvited, onCoHostsChanged, canEdit, onImageChanged, onEdit, userNeighborhood, t }) {
  const isVenue = VENUE_CATEGORIES.has(ev.category)
  const [shareStatus, setShareStatus] = useState(null) // 'shared' | 'copied' | 'failed' | null
  // Post-creation invite sheet — only opens for the creator/co-hosts
  // of a private event. Bumped invitedTick refetches AttendeesRow so
  // the newly added pending invitees show up immediately.
  const [showInvite, setShowInvite] = useState(false)
  const [showCoHosts, setShowCoHosts] = useState(false)
  const [invitedTick, setInvitedTick] = useState(0)
  const [imageZoomed, setImageZoomed] = useState(false)
  // Track image load failure separately. IG CDN URLs are signed and
  // expire after a few days, so by the time a user opens an older
  // event the URL 403s. background-image has no error event, so we
  // render via <img> and flip this flag from onError to fall back
  // cleanly to the gradient (and hide the zoom affordance).
  const [imageBroken, setImageBroken] = useState(false)
  const showImage = !!ev.imageUrl && !imageBroken
  // Reset imageBroken whenever the underlying URL changes (e.g.,
  // after a successful upload). Without this, a single onError
  // would permanently mask any future uploaded image too.
  useEffect(() => { setImageBroken(false) }, [ev.imageUrl])
  const [imageUploading, setImageUploading] = useState(false)
  const [imageError, setImageError] = useState(null)
  const fileInputRef = useRef(null)

  async function handleImagePicked(e) {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked || !ev.id) return
    setImageError(null); setImageUploading(true)
    try {
      // Compress on the client first — handles iPhone HEIC photos
      // (which canvas decodes on Safari and we re-encode as JPEG)
      // and shrinks 8-15MB originals under the backend's 8MB cap.
      const file = await compressImageForUpload(picked)
      const result = await uploadEventImage(ev.id, googleId, file)
      onImageChanged?.(result.image_url)
    } catch (err) {
      setImageError(err?.message || 'Não consegui enviar a foto')
    } finally {
      setImageUploading(false)
    }
  }

  async function handleImageRemove(e) {
    e?.stopPropagation()
    if (!ev.id) return
    if (!confirm('Remover a foto do evento?')) return
    setImageError(null); setImageUploading(true)
    try {
      await deleteEventImage(ev.id, googleId)
      onImageChanged?.('')
    } catch (err) {
      setImageError(err?.message || 'Não consegui remover a foto')
    } finally {
      setImageUploading(false)
    }
  }

  // Share the in-app deep link (/#/events?event=<id>) for every event —
  // catalog, group, custom — so recipients land in auê with the hero
  // open, not on the original ticketing page. Backend's GET /events/{id}
  // resolves catalog events and group events (ids prefixed grp_ev_); the
  // Events screen reads `?event=` and opens the drawer on mount.
  async function handleShare() {
    const url = shortEventLink(ev.id)
    const dateStr = ev.date ? ` · ${ev.date}` : ''
    const venueStr = ev.venue ? ` no ${ev.venue}` : ''
    const text = `${ev.name}${venueStr}${dateStr}`
    const result = await shareLink({ url, title: ev.name, text })
    setShareStatus(result)
    setTimeout(() => setShareStatus(null), 2200)
  }

  return (
    <>
      {/* Hero — uses the existing 120px banner slot. IG post image when
          available + loadable, gradient fallback otherwise. Tap an
          image hero to open the lightbox. Subtle dark overlay keeps
          the back button + category emoji readable against bright
          photos. */}
      <div
        onClick={showImage ? () => setImageZoomed(true) : undefined}
        style={{
          // Image hero gets more room (240px) so faces/posters/flyers
          // actually read at a glance — 180 was enough to know "yes,
          // there is a photo" but cropped most of the content. Neon
          // Boteco gradient hero is taller (180) so the layered radial
          // wash has room to breathe before the metadata slab below.
          height: showImage ? 240 : 180,
          // No-image hero: layered cyan + magenta radial gradients on
          // bg2. Image case keeps the per-event ev.headerBg so any
          // legacy callers still render their custom background under
          // the photo overlay.
          background: showImage ? ev.headerBg :
            'radial-gradient(circle at 20% 20%, rgba(255, 43, 214, 0.4) 0%, transparent 50%),' +
            ' radial-gradient(circle at 80% 80%, rgba(0, 229, 255, 0.4) 0%, transparent 50%),' +
            ' var(--bg2)',
          borderBottom: showImage ? 'none' : '1px solid var(--line)',
          position: 'relative',
          overflow: 'hidden',
          cursor: showImage ? 'zoom-in' : 'default',
        }}
      >
        {/* Image rendered via <img> so onError can flip imageBroken
            and we degrade to the gradient cleanly when an IG CDN URL
            has expired. Hidden image still loads — onError fires and
            removes it from view. */}
        {ev.imageUrl && !imageBroken && (
          <>
            <img
              src={ev.imageUrl}
              alt=""
              onError={() => setImageBroken(true)}
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%',
                objectFit: 'cover',
              }}
            />
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0) 35%, rgba(0,0,0,0) 65%, rgba(0,0,0,0.30) 100%)',
              pointerEvents: 'none',
            }} />
          </>
        )}
        {/* The hero used to carry its own back button, because the
            drawer's nav strip was hidden whenever there was an image.
            The strip is always rendered and sticky now, so a second
            control here would just be two ways to do one thing — and the
            hero one scrolled out of reach anyway. */}
        {/* Category emoji removed — collided with the back/upload buttons
            on short heroes and the surrounding chips already convey
            "type of event" (Grupo / Plano / Música / etc.) without it. */}
        {/* Top-right slot: editor controls (canEdit) win priority over
            the zoom hint. For non-editors viewing an image we keep the
            zoom hint so they know it expands. Stop propagation on
            buttons so the hero's tap-to-zoom doesn't fire from a tap
            on the upload control. */}
        {canEdit ? (
          <div style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
            right: 12,
            display: 'flex', gap: 6, zIndex: 2,
          }}>
            <button
              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click() }}
              disabled={imageUploading}
              aria-label={showImage ? 'Trocar foto' : 'Adicionar foto'}
              style={{
                padding: '6px 12px', borderRadius: 16,
                background: 'rgba(255,255,255,0.92)', border: 'none',
                fontSize: 12, fontWeight: 700, cursor: imageUploading ? 'wait' : 'pointer',
                boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
                opacity: imageUploading ? 0.7 : 1,
              }}
            >
              {imageUploading ? '...' : showImage ? '📷 Trocar' : '📷 Adicionar foto'}
            </button>
            {showImage && !imageUploading && (
              <button
                onClick={handleImageRemove}
                aria-label="Remover foto"
                style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'rgba(255,255,255,0.92)', border: 'none',
                  cursor: 'pointer', fontSize: 14,
                  boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
                }}
              >
                🗑
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif"
              // Keep the input in the layout (not display:none) so iOS
              // WKWebView fires the file picker reliably on programmatic
              // .click(). Visually invisible via 0×0 + opacity:0.
              style={{
                position: 'absolute', width: 0, height: 0, opacity: 0,
                pointerEvents: 'none',
              }}
              onChange={handleImagePicked}
            />
          </div>
        ) : showImage ? (
          <div style={{
            position: 'absolute',
            top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
            right: 12,
            padding: '5px 8px', borderRadius: 999,
            background: 'rgba(0,0,0,0.45)', color: 'white',
            fontSize: 11, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 4,
            zIndex: 1,
          }}>
            🔍 Ver
          </div>
        ) : null}
        {imageError && (
          <div style={{
            position: 'absolute', bottom: 8, left: 12, right: 12,
            padding: '6px 10px', borderRadius: 8,
            background: '#FFEBEE', color: '#B71C1C', fontSize: 11,
            zIndex: 2,
          }}>
            {imageError}
          </div>
        )}

        {/* Hero content — Neon Boteco spec. Renders only when there's no
            photo (the image case keeps the photo unobstructed; the title
            still renders below in the content slab). Mono lime eyebrow
            with the date stamp, chunky display title, neon-pill row. */}
        {!showImage && (
          <div style={{
            position: 'absolute',
            inset: 0,
            padding: '32px 22px 22px',
            display: 'flex', flexDirection: 'column',
            justifyContent: 'flex-end',
            zIndex: 2,
          }}>
            <div className="neon-mono" style={{
              fontSize: 10, letterSpacing: '0.24em',
              color: 'var(--lime)',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}>
              ◯ {(ev.date || '').toUpperCase()}{ev.time ? ` // ${ev.time}` : ''}
            </div>
            <div className="neon-display" style={{
              fontSize: 32, lineHeight: 0.95, letterSpacing: '-0.03em',
              color: 'var(--text)',
              textShadow: '0 2px 24px rgba(0, 0, 0, 0.6)',
            }}>
              {ev.name}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {ev.priceTier === 'free' ? (
                <span className="neon-pill" style={{ color: 'var(--lime)' }}>$0</span>
              ) : ev.price ? (
                <span className="neon-pill" style={{ color: 'var(--text)' }}>
                  {ev.price.replace(/R\$\s*/g, '').replace(/\s*-\s*/g, '–').trim()}
                </span>
              ) : (
                <span
                  className="neon-pill"
                  title="Preço não informado"
                  style={{ color: 'var(--cyan)' }}
                >
                  $ ?
                </span>
              )}
              {ev.categoryLabel && !ev.isGroupEvent && (
                <span className="neon-pill" style={{ color: 'var(--cyan)' }}>
                  {ev.categoryLabel}
                </span>
              )}
              {ev.kidsWelcome && (
                <span className="neon-pill" style={{ color: 'var(--magenta)' }}>
                  PRA TODOS
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Lightbox — fullscreen overlay with the original-resolution image.
          Tap anywhere outside the image (or on it) to close. zIndex sits
          above the drawer (drawer is 9999) so the lightbox fully covers.
          Only shown when the image actually loaded — protects against
          a stale-URL banner trying to expand into a 403. */}
      {imageZoomed && showImage && (
        <div
          onClick={() => setImageZoomed(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, cursor: 'zoom-out',
          }}
        >
          <img
            src={ev.imageUrl}
            alt={ev.name}
            style={{
              maxWidth: '100%', maxHeight: '100%',
              objectFit: 'contain', borderRadius: 8,
              boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            }}
          />
          <button
            onClick={(e) => { e.stopPropagation(); setImageZoomed(false) }}
            aria-label="Fechar"
            style={{
              position: 'absolute', top: 16, right: 16,
              width: 36, height: 36, borderRadius: '50%',
              background: 'rgba(255,255,255,0.9)', border: 'none',
              fontSize: 18, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
            }}
          >✕</button>
        </div>
      )}

      {/* Content — bottom padding clears iOS home bar so "Adicionar a um
          grupo" / "Editar evento" / "Excluir" don't sit under the
          gesture zone when you scroll to the end. */}
      <div style={{
        padding: '14px 20px calc(env(safe-area-inset-bottom, 0px) + 32px)',
      }}>
        {/* Title only when an image hero is rendered — the no-image case
            already shows the chunky title overlaid on the gradient hero
            above, so duplicating it here would just push the metadata
            slab down. */}
        {showImage && (
          <div className="neon-display" style={{
            fontSize: 26, color: 'var(--text)',
            letterSpacing: '-0.03em', lineHeight: 1,
            marginBottom: 10,
          }}>
            {ev.name}
          </div>
        )}

        {/* Vibe summary — short LLM-extracted sentence about the event.
            Sits right under the title as the "what is this in one line"
            glance before the user scrolls into the metadata + actions.
            Hidden when the LLM echoed the event name (noise filter). */}
        {ev.vibeSummary && ev.vibeSummary !== ev.name && (
          <div style={{
            fontSize: 13, color: 'var(--charcoal-mid)',
            fontStyle: 'italic', lineHeight: 1.4, marginBottom: 10,
          }}>
            {ev.vibeSummary}
          </div>
        )}

        {/* Source badge — clickable, opens the source's page on /sources.
            For Instagram events, surfaces the actual handle (@<handle>) so
            the user knows which monitored profile this came from. */}
        {(ev.source && SOURCE_CONFIG[ev.source]) ? (() => {
          const isIg = ev.source === 'instagram' && ev.igHandle
          const src = SOURCE_CONFIG[ev.source]
          const label = isIg ? `@${ev.igHandle}` : src.label
          const targetId = isIg ? `ig:${ev.igHandle}` : ev.source
          return (
            <button
              onClick={() => onSourceTap?.(targetId)}
              title={isIg ? `Ver eventos de @${ev.igHandle}` : `Ver eventos de ${src.label}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 8, marginBottom: 10,
                background: src.bg, border: `1px solid ${src.border}`,
                cursor: 'pointer',
              }}
            >
              {!isIg && (
                <span style={{ fontSize: 12 }}>{src.icon}</span>
              )}
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: src.color, textTransform: isIg ? 'none' : 'uppercase' }}>
                {label}
              </span>
              <span style={{ fontSize: 10, color: src.color, opacity: 0.6 }}>→</span>
            </button>
          )
        })() : ev.isCustom ? (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 12px', borderRadius: 8, marginBottom: 10,
            background: '#FFF3E0', border: '1px solid #FFB74D',
          }}>
            <span style={{ fontSize: 12 }}>★</span>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: 'var(--terra)', textTransform: 'uppercase' }}>
              {t.tag_private_long}
            </span>
          </div>
        ) : null}

        {isVenue && (() => {
          // Open-now status comes from Google Places (open_now boolean).
          // True/false → live status pill; null → fallback to "Sempre aberto".
          if (ev.openNow === true) {
            return (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'var(--sage-pale)', padding: '4px 10px', borderRadius: 8,
                fontSize: 10, fontWeight: 700, color: 'var(--sage)',
                textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: 'var(--sage)',
                }}/>
                Aberto agora
              </div>
            )
          }
          if (ev.openNow === false) {
            return (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'rgba(44,44,44,0.07)', padding: '4px 10px', borderRadius: 8,
                fontSize: 10, fontWeight: 700, color: 'var(--charcoal-mid)',
                textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
              }}>
                Fechado agora
              </div>
            )
          }
          return (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--terra-pale)', padding: '4px 10px', borderRadius: 8,
              fontSize: 10, fontWeight: 700, color: 'var(--terra)',
              textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10,
            }}>
              {t.events_venue_open}
            </div>
          )
        })()}

        {/* Rating row for venues */}
        {isVenue && ev.rating > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--terra)' }}>⭐ {ev.rating}</div>
            {ev.attendeesConfirmed > 0 && (
              <div style={{ fontSize: 12, color: 'var(--charcoal-mid)' }}>
                {ev.attendeesConfirmed.toLocaleString('pt-BR')} avaliações no Google
              </div>
            )}
          </div>
        )}

        {/* Spec table — Neon Boteco direction. Mono key/value rows with
            label-specific accent colors. Replaces the previous emoji-
            prefixed metadata list. Only rows with values render, so the
            slab tightens cleanly for sparse events. */}
        {(() => {
          const venueValue = ev.venue
            ? `${ev.venue}${ev.city && !ev.venue.includes(ev.city) ? ` · ${ev.city}` : ''}`
            : ev.city || null
          const whenValue = isVenue
            ? t.events_venue_open
            : (ev.date && (ev.duration || ev.time))
              ? `${ev.date} · ${ev.duration || ev.time}`
              : (ev.date || ev.time || null)
          const costValue = ev.price
            || (ev.priceTier === 'free' ? 'Grátis' : '? não informado')
          const sourceValue = ev.source === 'instagram' && ev.igHandle
            ? `@${ev.igHandle}`
            : (ev.isCustom ? 'auê plano' : (ev.categoryLabel || null))
          const rows = [
            ['ONDE',   venueValue,  'var(--cyan)'],
            ['QUANDO', whenValue,   'var(--magenta)'],
            ['CUSTO',  costValue,   'var(--lime)'],
            ['FONTE',  sourceValue, 'var(--text2)'],
          ].filter(([, v]) => v)
          if (rows.length === 0) return null
          return (
            <div style={{ marginBottom: 16 }}>
              {rows.map(([label, value, color]) => (
                <div
                  key={label}
                  style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: 12,
                    padding: '12px 0',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <span className="neon-mono" style={{
                    fontSize: 10, letterSpacing: '0.22em',
                    textTransform: 'uppercase', color,
                    flexShrink: 0,
                  }}>
                    {label}
                  </span>
                  <span className="neon-mono" style={{
                    fontSize: 12, color: 'var(--text)',
                    textAlign: 'right',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {value}
                  </span>
                </div>
              ))}
              {ev.venueAddress && (
                <div className="neon-mono" style={{
                  fontSize: 11, color: 'var(--text3)',
                  marginTop: 6, letterSpacing: '0.04em',
                }}>
                  {ev.venueAddress}
                </div>
              )}
              {ev.hasFood && (
                <div className="neon-mono" style={{
                  fontSize: 11, color: 'var(--text3)',
                  marginTop: 8, letterSpacing: '0.04em',
                }}>
                  {t.events_food_drink}
                </div>
              )}
            </div>
          )
        })()}

        {/* Price badge + Kids Welcome tag in detail view */}
        {(ev.priceTier === 'free' || ev.kidsWelcome) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {ev.priceTier === 'free' && (
              <span className="tag tag--sage">{t.tag_free}</span>
            )}
            {ev.kidsWelcome && (
              <span className="tag" style={{ background: '#FFF3E0', color: '#E65100' }}>
                {t.tag_kids}
              </span>
            )}
          </div>
        )}

        {/* Adicionado por — group events / personal plans surface the
            creator so the recipient knows who put this on the calendar.
            Catalog (IG) events leave createdByName empty and skip this.
            Chip is tappable on private events so creator/co-host can
            manage co-organizers and viewers can see who's organizing. */}
        {ev.createdByName && (() => {
          const coHostCount = (ev.coHostIds || []).length
          const isPrivate = !!ev.isGroupEvent
          const ChipTag = isPrivate ? 'button' : 'div'
          return (
            <ChipTag
              {...(isPrivate ? { onClick: () => setShowCoHosts(true) } : {})}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
                padding: '8px 12px', borderRadius: 12, background: 'var(--white)',
                border: '1px solid var(--border)',
                width: '100%', textAlign: 'left',
                cursor: isPrivate ? 'pointer' : 'default',
              }}
            >
              <Avatar name={ev.createdByName} src={ev.createdByPicture} size={28} />
              <span style={{ flex: 1, fontSize: 12, color: 'var(--charcoal-mid)' }}>
                {ev.isPersonalPlan ? 'Convite de ' : 'Adicionado por '}
                <strong style={{ color: 'var(--charcoal)' }}>{ev.createdByName}</strong>
                {coHostCount > 0 && (
                  <span> · {coHostCount} co-organizador{coHostCount === 1 ? '' : 'es'}</span>
                )}
              </span>
              {isPrivate && (
                <span style={{ fontSize: 11, color: 'var(--charcoal-light)' }}>›</span>
              )}
            </ChipTag>
          )
        })()}

        {/* Quem vai — full RSVP roster (friends + strangers + viewer if
            confirmed). Replaces the older "Amigos vão" block: this row
            covers both populations in one expandable strip, with friends
            still tappable so the post-event "people you met" flow works
            from the hero too. */}
        {googleId && (
          <div style={{ marginBottom: 12 }}>
            <AttendeesRow
              eventId={ev.id}
              googleId={googleId}
              isRsvped={rsvped}
              refreshKey={`${rsvped ? 'rsvp-on' : 'rsvp-off'}-${invitedTick}`}
              viewerName={viewerName}
              viewerPicture={viewerPicture}
              onFriend={onFriend}
              canManage={
                ev.isGroupEvent && (
                  ev.createdBy === googleId ||
                  (ev.coHostIds || []).includes(googleId)
                )
              }
            />
          </div>
        )}

        {(() => {
          const desc = cleanDescription(ev.description)
          return desc ? (
            <div style={{ fontSize: 14, color: 'var(--charcoal)', lineHeight: 1.5, marginBottom: 12, whiteSpace: 'pre-line' }}>
              {desc}
            </div>
          ) : null
        })()}

        {/* Source link — prominent so users can verify on the original site */}
        {ev.url && !isVenue && (() => {
          // When the URL is a Google Maps fallback (no canonical event URL),
          // label it as a map link instead of pretending it's a Sympla page.
          const isMapsUrl = ev.url.includes('google.com/maps')
          const src = ev.source && SOURCE_CONFIG[ev.source]
          const icon = isMapsUrl ? '📍' : '🔗'
          const label = isMapsUrl
            ? 'Ver no mapa →'
            : src ? `Ver no ${src.label} →` : t.events_view_original
          return (
            <a
              href={ev.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '7px 12px', borderRadius: 10, marginBottom: 12,
                background: 'var(--sage-pale)', color: 'var(--sage)',
                fontSize: 12, fontWeight: 700, textDecoration: 'none',
                border: '1px solid var(--sage)',
              }}
            >
              {icon} {label}
            </a>
          )
        })()}

        {/* "Bora?" pitch block removed — copy was prescriptive ("Não
            recomendado…") which clashes with auê's voice (descriptive,
            not judgmental). The vibe summary on the EventCard plus the
            event description below cover the same ground without the
            "should you go" framing. */}

        {/* Post-event attendees — "People you met" */}
        {!isVenue && (
          <PostEventAttendees
            eventId={ev.id}
            eventDate={ev.dateStart || ev.date}
          />
        )}

        {/* Promo code reveal — only on featured (paid) venues that
            set a code. Tap to expand, copy-able pill, perk copy
            below. Logs `code_view` so the venue Painel can track
            "of N viewers, M tapped the code" as a tighter
            conversion signal than RSVP alone. */}
        {ev.promoCode && <PromoCodeBlock ev={ev} />}

        {/* Sympla buy-link — set by the matching pipeline when the
            catalog event aligns with a CWB Sympla event. Tracks
            sympla_click + appends utm_source=aue so we can show
            venues we drove X visits to their event. */}
        {ev.symplaUrl && <SymplaBuyButton ev={ev} />}

        {/* Pending invite requests — visible to creator + co-hosts. The
            panel hides itself when there are zero requests, so this
            doesn't add visual weight on the typical event hero. */}
        {ev.isGroupEvent && googleId && (ev.createdBy === googleId || (ev.coHostIds || []).includes(googleId)) && (
          <InviteRequestsPanel
            eventId={ev.id}
            googleId={googleId}
            canManage
          />
        )}

        <button className="btn btn--primary" onClick={onRsvp}>
          {rsvped
            ? (isVenue ? t.events_venue_remove : t.events_cancel_rsvp)
            : (isVenue ? t.events_venue_save : t.events_rsvp_btn)
          }
        </button>

        {onAddToGroup && !isVenue && (
          <button
            onClick={onAddToGroup}
            style={{
              width: '100%', marginTop: 10,
              padding: '12px', borderRadius: 12,
              background: 'transparent', border: '1.5px solid var(--border)',
              color: 'var(--charcoal-mid)', fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            👥 Adicionar a um grupo
          </button>
        )}

        {onEdit && (
          <button
            onClick={onEdit}
            style={{
              width: '100%', marginTop: 10,
              padding: '12px', borderRadius: 12,
              background: 'transparent', border: '1.5px solid var(--border)',
              color: 'var(--charcoal-mid)', fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ✏️ Editar evento
          </button>
        )}

        {canInvite && (
          <button
            onClick={() => setShowInvite(true)}
            style={{
              width: '100%', marginTop: 10,
              padding: '12px', borderRadius: 12,
              background: 'transparent', border: '1.5px solid var(--border)',
              color: 'var(--charcoal-mid)', fontSize: 13, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            👥 Convidar mais gente
          </button>
        )}

        <button
          onClick={handleShare}
          style={{
            width: '100%', marginTop: 10,
            padding: '12px', borderRadius: 12,
            background: 'transparent', border: '1.5px solid var(--border)',
            color: shareStatus ? 'var(--sage)' : 'var(--charcoal-mid)',
            borderColor: shareStatus ? 'var(--sage)' : 'var(--border)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {shareStatus === 'shared' ? '✓ Compartilhado'
            : shareStatus === 'copied' ? '✓ Link copiado'
            : shareStatus === 'failed' ? '✕ Falhou'
            : '🔗 Compartilhar'}
        </button>

        {/* Delete — only when caller decides the user has authority
            (personal plan creator). Red text + ghost background so it
            reads as destructive without a loud full-color button. */}
        {onDelete && (
          <button
            onClick={onDelete}
            style={{
              width: '100%', marginTop: 10,
              padding: '12px', borderRadius: 12,
              background: 'transparent', border: '1.5px solid #FFCDD2',
              color: '#C62828',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            🗑 Apagar plano
          </button>
        )}

        {rsvped && (
          <div style={{ marginTop: 10 }}>
            <AddToCalendar event={ev} />
          </div>
        )}

        {/* Venues keep the Google Maps link at the bottom; non-venue source link is shown above the description. */}
        {ev.url && isVenue && (
          <a
            href={ev.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'block', textAlign: 'center', marginTop: 14, fontSize: 12, color: 'var(--charcoal-light)', textDecoration: 'underline' }}
          >
            📍 Ver no Google Maps →
          </a>
        )}
      </div>
      <InvitePeopleSheet
        open={showInvite}
        onClose={() => setShowInvite(false)}
        eventId={ev.id}
        googleId={googleId}
        eventName={ev.name}
        existingInviteeIds={ev.extraInviteeIds || []}
        onInvited={(result) => {
          setInvitedTick(t => t + 1)
          onInvited?.(result)
        }}
      />
      <CoHostsSheet
        open={showCoHosts}
        onClose={() => setShowCoHosts(false)}
        eventId={ev.id}
        googleId={googleId}
        creatorId={ev.createdBy}
        creatorName={ev.createdByName}
        creatorPicture={ev.createdByPicture}
        coHostIds={ev.coHostIds || []}
        inviteeIds={ev.extraInviteeIds || []}
        onChange={(newCoHostIds) => onCoHostsChanged?.(newCoHostIds)}
      />
    </>
  )
}
