// Slides for the "canais" carousel: one cover, one slide per auê channel
// with a few of its weekend events, then the shared closing slide.
// Same 1080x1350 frame and Neon Boteco tokens as slides.mjs.

import { page, top, TOKENS } from './slides.mjs'
import { shortDay, timeLabel, windowLabel } from './format.mjs'
import { spanOf } from './select.mjs'

// A title dash stays at the end of its line, as on the weekend slides.
const keepDashWithWord = (s) => s.replace(/ ([–—-]) /g, '\u00A0$1 ')
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// By title, because channel rows have no emoji of their own.
export const CHANNEL_EMOJI = {
  'Cultura': '🎭', 'Eletrônica': '🪩', 'Samba e Pagode': '🥁', 'Gastronomia': '🍽️',
  'Livros': '📚', 'MPB & Jazz': '🎷', 'Rock': '🎸', 'Comédia': '😂',
}
export const emojiOf = (title) => CHANNEL_EMOJI[title] || '📍'

export const moreLabel = (slide) => {
  const more = slide.total - slide.picks.length
  return more > 0 ? `+${more} no canal` : 'tudo no canal'
}

export function channelCoverSlide({ fontCss, from, to, slides }) {
  const t = TOKENS
  const css = `
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 28px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.cyan}; margin-bottom: 30px; }
  h1 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 128px; line-height: 0.95; letter-spacing: -0.045em; text-wrap: balance; }
  h1 em { font-style: normal; color: ${t.magenta}; text-shadow: 0 0 30px rgba(255, 43, 214, 0.55); }
  .sub { margin-top: 36px; font-size: 38px; line-height: 1.3; color: ${t.text2}; max-width: 880px; }
  .when { margin-top: 44px; }
  .chips { margin-top: 56px; display: flex; flex-wrap: wrap; gap: 16px; }
  .chip { display: inline-flex; align-items: center; gap: 12px; height: 62px; padding: 0 26px; border-radius: 999px;
    border: 2px solid ${t.line}; background: rgba(10,5,16,0.55); font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 30px; white-space: nowrap; }
  `
  const chips = slides.map((s) => `<span class="chip">${emojiOf(s.title)} ${esc(s.title)}</span>`).join('')
  return page(fontCss, `<div class="slide">
    ${top('novo: canais')}
    <div class="hero">
      <div class="kicker">no app auê</div>
      <h1 data-fit>Segue um <em>canal</em>, recebe o fim de semana dele</h1>
      <div class="sub">Escolhe o teu som ou tua vibe. Os rolês de Curitiba chegam sozinhos.</div>
      <div class="when"><span class="pill lime">${esc(windowLabel(from, to))}</span></div>
      <div class="chips">${chips}</div>
    </div>
    <div class="foot"><b style="color:${t.lime}">📲 canais no app auê · link na bio</b><span class="swipe">arrasta →</span></div>
  </div>`, css)
}

export function channelSlide({ fontCss, slide, index, total }) {
  const t = TOKENS
  const css = `
  .head { margin-top: 40px; flex: none; }
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 26px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.text3}; }
  h2 { margin-top: 14px; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: ${slide.title.length > 12 ? 104 : 124}px; line-height: 1.0; letter-spacing: -0.04em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  h2 em { font-style: normal; color: ${t.magenta}; text-shadow: 0 0 28px rgba(255, 43, 214, 0.5); }
  .list { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 34px; min-height: 0; }
  .ev { padding: 4px 0 4px 30px; border-left: 6px solid ${t.magenta}; }
  .ev .w { font-family: 'JetBrains Mono', monospace; font-weight: 500; font-size: 28px; letter-spacing: 0.06em; text-transform: uppercase; color: ${t.cyan}; }
  .ev .n { margin-top: 8px; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 52px; line-height: 1.06; letter-spacing: -0.02em;
    max-height: ${Math.round(52 * 1.06 * 2) + 4}px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; text-wrap: balance; }
  .ev .v { margin-top: 8px; font-size: 30px; color: ${t.text2}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ev .v b { color: ${t.text}; font-weight: 600; }
  .cta { flex: none; display: flex; align-items: center; gap: 20px; margin-top: 24px; }
  .foot { margin-top: 40px; }
  `
  const rows = slide.picks.map((e) => {
    const when = [shortDay(spanOf(e).start), timeLabel(e)].filter(Boolean).join(' · ')
    return `<div class="ev"><div class="w">${esc(when)}</div><div class="n" data-fit>${esc(keepDashWithWord(e.name.trim()))}</div><div class="v" data-fit>${esc((e.venue || '').split('·')[0].trim())} · <b>@${esc(e.igHandle)}</b></div></div>`
  }).join('')
  return page(fontCss, `<div class="slide">
    ${top(`canal ${index} / ${total}`)}
    <div class="head">
      <div class="kicker">esse fim de semana no canal</div>
      <h2 data-fit>${emojiOf(slide.title)} <em>${esc(slide.title)}</em></h2>
    </div>
    <div class="list">${rows}</div>
    <div class="cta"><span class="pill lime">${esc(moreLabel(slide))}</span><span class="pill outline">segue no app</span></div>
    <div class="foot"><b style="color:${t.lime}">📲 app auê · link na bio</b><span class="swipe">${index < total ? 'arrasta →' : 'baixa →'}</span></div>
  </div>`, css)
}

/** Caption: every channel and every venue handle, so each one is tagged. */
export function buildChannelCaption(slides, from, to) {
  const lines = [
    `Agora tem canais no auê 📲 Segue o teu e recebe os rolês dele em Curitiba (${windowLabel(from, to)}) 👇`,
    'Escolhe o canal no app auê, de graça. Link na bio.',
    '',
  ]
  for (const s of slides) {
    lines.push(`${emojiOf(s.title)} ${s.title} (${moreLabel(s)})`)
    for (const e of s.picks) lines.push(`· ${[shortDay(spanOf(e).start), timeLabel(e)].filter(Boolean).join(' ')} — ${e.name.trim()} @${e.igHandle}`)
    lines.push('')
  }
  lines.push(
    'Horário e ingresso podem mudar: confere no perfil de cada lugar antes de sair.',
    '',
    '📲 Baixa o auê — link na bio',
    'iPhone: já na App Store · Android: entra no beta antes de todo mundo',
    '',
    '#curitiba #agendacuritiba #oquefazeremcuritiba #curitibacultural #fimdesemanacuritiba',
  )
  return `${lines.join('\n')}\n`
}
