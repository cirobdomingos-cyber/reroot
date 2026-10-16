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
// "Teatro Guaíra – Auditório Bento Munhoz da Rocha Netto · Centro" -> "Teatro Guaíra":
// the room and the bairro push the @handle, the part that gets tagged, off the line.
const shortVenue = (e) => (e.venue || '').split(/\s+[–—-]\s+|·/)[0].trim()

export const emojiOf = (title) => CHANNEL_EMOJI[title] || '📍'

export const moreLabel = (slide) => {
  const more = slide.total - slide.picks.length
  return more > 0 ? `+${more} no canal` : 'tudo no canal'
}

// The cover's first job is to say "this is an app, install it": people saw
// the earlier posts and never tapped through (2026-10-15), so the app,
// its icon and both stores sit above the headline, not on the last slide.
export function channelCoverSlide({ fontCss, from, to, slides, icon }) {
  const t = TOKENS
  const css = `
  .app { margin-top: 44px; display: flex; align-items: center; gap: 28px; padding: 26px 30px; border-radius: 30px;
    border: 3px solid ${t.lime}; background: rgba(198,255,0,0.07); box-shadow: 0 0 34px rgba(198,255,0,0.18); flex: none; }
  .app img, .app .glyph { width: 112px; height: 112px; border-radius: 26px; flex: none; }
  .app .glyph { display: grid; place-items: center; font-size: 64px; background: rgba(255,255,255,0.06); }
  .app .a { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 46px; line-height: 1.05; letter-spacing: -0.02em; color: ${t.lime}; }
  .app .b { margin-top: 8px; font-size: 28px; color: ${t.text2}; }
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 0; }
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 28px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.cyan}; margin-bottom: 26px; }
  h1 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 112px; line-height: 0.95; letter-spacing: -0.045em; text-wrap: balance; }
  h1 em { font-style: normal; color: ${t.magenta}; text-shadow: 0 0 30px rgba(255, 43, 214, 0.55); }
  .chips { margin-top: 44px; display: flex; flex-wrap: wrap; gap: 14px; }
  .chip { display: inline-flex; align-items: center; gap: 10px; height: 56px; padding: 0 22px; border-radius: 999px;
    border: 2px solid ${t.line}; background: rgba(10,5,16,0.55); font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 27px; white-space: nowrap; }
  .stores { flex: none; display: flex; gap: 16px; margin-top: 30px; }
  .foot { margin-top: 30px; }
  `
  const chips = slides.map((s) => `<span class="chip">${emojiOf(s.title)} ${esc(s.title)}</span>`).join('')
  return page(fontCss, `<div class="slide">
    ${top(windowLabel(from, to))}
    <div class="app">${icon ? `<img src="${icon}" alt="">` : '<div class="glyph">📲</div>'}<div><div class="a">Baixa o app auê</div><div class="b">a agenda de Curitiba no seu celular</div></div></div>
    <div class="hero">
      <div class="kicker">novo no app: canais</div>
      <h1 data-fit>Segue um <em>canal</em>, recebe o fim de semana dele</h1>
      <div class="chips">${chips}</div>
    </div>
    <div class="stores"><span class="pill lime">📱 iPhone · App Store</span><span class="pill outline">🤖 Android · beta</span></div>
    <div class="foot"><b style="color:${t.lime}">baixa de graça · link na bio</b><span class="swipe">arrasta →</span></div>
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
    return `<div class="ev"><div class="w">${esc(when)}</div><div class="n" data-fit>${esc(keepDashWithWord(e.name.trim()))}</div><div class="v" data-fit>${esc(shortVenue(e))} · <b>@${esc(e.igHandle)}</b></div></div>`
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

const whenOf = (e) => [shortDay(spanOf(e).start), timeLabel(e)].filter(Boolean).join(' · ')

// One slide for the channels that do not get their own: each with its
// weekend count and one headline, so the carousel stays short and every
// channel is still named (and its venue still tagged).
export function moreChannelsSlide({ fontCss, slides, index, total }) {
  const t = TOKENS
  const css = `
  .head { margin-top: 40px; flex: none; }
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 26px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.text3}; }
  h2 { margin-top: 14px; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 104px; line-height: 1.0; letter-spacing: -0.04em; }
  h2 em { font-style: normal; color: ${t.magenta}; text-shadow: 0 0 28px rgba(255, 43, 214, 0.5); }
  .list { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 20px; min-height: 0; }
  .ch { display: flex; gap: 24px; align-items: center; padding: 22px 26px; border: 2px solid ${t.line}; border-radius: 26px; background: rgba(10,5,16,0.55); }
  .ch .e { font-size: 64px; flex: none; width: 80px; text-align: center; }
  .ch .txt { min-width: 0; flex: 1; }
  .ch .t { display: flex; align-items: baseline; gap: 18px; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 46px; letter-spacing: -0.02em; white-space: nowrap; }
  .ch .t span { font-family: 'JetBrains Mono', monospace; font-weight: 500; font-size: 24px; letter-spacing: 0.06em; text-transform: uppercase; color: ${t.lime}; }
  .ch .x { margin-top: 6px; font-size: 27px; color: ${t.text2}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ch .y { margin-top: 4px; font-size: 25px; color: ${t.text3}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ch .y b { color: ${t.cyan}; font-weight: 600; font-family: 'JetBrains Mono', monospace; font-size: 23px; text-transform: uppercase; letter-spacing: 0.04em; }
  .cta { flex: none; margin-top: 24px; }
  .foot { margin-top: 40px; }
  `
  const rows = slides.map((s) => {
    const e = s.picks[0]
    return `<div class="ch"><div class="e">${emojiOf(s.title)}</div><div class="txt"><div class="t">${esc(s.title)}<span>${s.total} rolê${s.total === 1 ? '' : 's'}</span></div><div class="x" data-fit>${esc(e.name.trim())}</div><div class="y"><b>${esc(whenOf(e))}</b> · @${esc(e.igHandle)}</div></div></div>`
  }).join('')
  return page(fontCss, `<div class="slide">
    ${top(`canais ${index} / ${total}`)}
    <div class="head">
      <div class="kicker">e tem mais no app</div>
      <h2>Mais <em>canais</em></h2>
    </div>
    <div class="list">${rows}</div>
    <div class="cta"><span class="pill lime">segue o seu no app</span></div>
    <div class="foot"><b style="color:${t.lime}">📲 app auê · link na bio</b><span class="swipe">baixa →</span></div>
  </div>`, css)
}

/** Caption: every channel and every venue handle, so each one is tagged. */
export function buildChannelCaption(slides, from, to, more = []) {
  const lines = [
    `Agora tem canais no auê 📲 Segue o seu e recebe os rolês dele em Curitiba (${windowLabel(from, to)}) 👇`,
    'Escolhe o canal no app auê, de graça. Link na bio.',
    '',
  ]
  for (const s of slides) {
    lines.push(`${emojiOf(s.title)} ${s.title} (${moreLabel(s)})`)
    for (const e of s.picks) lines.push(`· ${[shortDay(spanOf(e).start), timeLabel(e)].filter(Boolean).join(' ')} — ${e.name.trim()} @${e.igHandle}`)
    lines.push('')
  }
  if (more.length) {
    lines.push('E mais canais no app:')
    for (const s of more) lines.push(`${emojiOf(s.title)} ${s.title} (${s.total} rolê${s.total === 1 ? '' : 's'}) · ${[shortDay(spanOf(s.picks[0]).start), timeLabel(s.picks[0])].filter(Boolean).join(' ')} — ${s.picks[0].name.trim()} @${s.picks[0].igHandle}`)
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
