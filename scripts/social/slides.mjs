// HTML for each carousel slide (1080x1350, Instagram portrait).
//
// The look is the app's own "Neon Boteco" tokens (src/styles/globals.css):
// violet-black ground, magenta brand glow, cyan for "when", lime for "free"
// and the app icon's lime spark. Fonts are the ones index.html loads from
// Google Fonts (Space Grotesk, Inter, JetBrains Mono), embedded by the caller.
//
// Flyer rights: every slide is our own layout. A venue's flyer appears only
// as a small thumbnail next to its "@handle" credit, never as the slide.

import { pitchLine, priceLabel, venueLine, whenLabel, windowLabel, shortDay, timeLabel } from './format.mjs'

export const WIDTH = 1080
export const HEIGHT = 1350

export const TOKENS = {
  bg: '#0A0510',
  bg2: '#14081E',
  line: '#2A1640',
  magenta: '#FF2BD6',
  cyan: '#00E5FF',
  lime: '#C6FF00',
  text: '#F4ECFF',
  text2: '#B8A8D8',
  text3: '#6E5C8E',
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function baseCss(fontCss) {
  const t = TOKENS
  return `${fontCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: ${t.bg}; }
  body {
    font-family: 'Inter', sans-serif; color: ${t.text};
    -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision;
  }
  .slide {
    position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
    padding: 76px 80px 72px; display: flex; flex-direction: column;
    background:
      radial-gradient(900px 620px at 100% -6%, rgba(255, 43, 214, 0.20), transparent 62%),
      radial-gradient(760px 560px at -12% 108%, rgba(0, 229, 255, 0.13), transparent 60%),
      ${t.bg2};
  }
  .slide::after { /* the app's faint scanlines */
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(0deg, rgba(255,255,255,0.018) 0 2px, transparent 2px 5px);
  }
  .top { display: flex; align-items: center; justify-content: space-between; height: 64px; flex: none; }
  .mark { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 60px; letter-spacing: -0.04em;
    color: ${t.magenta}; text-shadow: 0 0 22px rgba(255, 43, 214, 0.55); line-height: 1; display: flex; align-items: center; gap: 18px; }
  .spark { width: 18px; height: 18px; border-radius: 50%; background: ${t.lime}; box-shadow: 0 0 16px rgba(198,255,0,0.55); }
  .meta { font-family: 'JetBrains Mono', monospace; font-weight: 500; font-size: 26px; letter-spacing: 0.08em;
    text-transform: uppercase; color: ${t.text2}; }
  .foot { flex: none; display: flex; align-items: center; justify-content: space-between;
    font-family: 'JetBrains Mono', monospace; font-size: 24px; letter-spacing: 0.06em; color: ${t.text3}; }
  .foot b { color: ${t.text2}; font-weight: 500; }
  .swipe { color: ${t.cyan}; }
  .pill { display: inline-flex; align-items: center; height: 64px; padding: 0 30px; border-radius: 999px;
    font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 32px; letter-spacing: 0.01em; white-space: nowrap; }
  .pill.lime { background: ${t.lime}; color: ${t.bg}; box-shadow: 0 0 26px rgba(198,255,0,0.35); }
  .pill.outline { border: 3px solid ${t.lime}; color: ${t.lime}; }
  .pill.cyan { border: 3px solid ${t.cyan}; color: ${t.cyan}; }
  [data-fit] { overflow: hidden; }
  `
}

function page(fontCss, body, extraCss = '') {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>${baseCss(fontCss)}${extraCss}</style></head><body>${body}</body></html>`
}

// A title dash stays at the end of its line ("Renato Russo –" / "O Musical").
const keepDashWithWord = (s) => s.replace(/ ([–—-]) /g, '\u00A0$1 ')

const top = (right) => `<div class="top"><div class="mark">auê<span class="spark"></span></div><div class="meta">${esc(right)}</div></div>`

export function coverSlide({ fontCss, from, to, picks }) {
  const t = TOKENS
  const css = `
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 28px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.cyan}; margin-bottom: 30px; }
  h1 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 142px; line-height: 0.94; letter-spacing: -0.045em; }
  h1 em { font-style: normal; color: ${t.magenta}; text-shadow: 0 0 30px rgba(255, 43, 214, 0.55); }
  .when { margin-top: 48px; }
  .list { margin-top: 60px; border-top: 2px solid ${t.line}; padding-top: 30px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .row { min-width: 0; display: flex; gap: 26px; align-items: baseline; font-size: 30px; line-height: 1.2; }
  .row .d { flex: none; width: 190px; font-family: 'JetBrains Mono', monospace; font-size: 24px; letter-spacing: 0.05em; color: ${t.cyan}; text-transform: uppercase; }
  .row .n { min-width: 0; color: ${t.text}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  `
  const rows = picks.map(({ event, day }) => {
    const d = [shortDay(day), timeLabel(event)].filter(Boolean).join(' ')
    return `<div class="row"><span class="d">${esc(d)}</span><span class="n">${esc(event.name)}</span></div>`
  }).join('')
  return page(fontCss, `<div class="slide">
    ${top('agenda da semana')}
    <div class="hero">
      <div class="kicker">${picks.length} rolês escolhidos pra você</div>
      <h1 data-fit><em>Rola</em> esse fim de semana em Curitiba</h1>
      <div class="when"><span class="pill lime">${esc(windowLabel(from, to))}</span></div>
      <div class="list">${rows}</div>
    </div>
    <div class="foot"><b style="color:${t.lime}">📲 tudo isso no app auê · link na bio</b><span class="swipe">arrasta →</span></div>
  </div>`, css)
}

export function eventSlide({ fontCss, pick, index, total, from, to, image }) {
  const t = TOKENS
  const e = pick.event
  const price = priceLabel(e)
  const free = price.startsWith('de graça')
  const line = pitchLine(e)
  const nameLen = e.name.trim().length
  const nameSize = nameLen <= 18 ? 120 : nameLen <= 32 ? 104 : nameLen <= 50 ? 88 : 74
  const css = `
  .body { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .main { flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 0; padding: 24px 0 8px; }
  .when { margin-top: 52px; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 60px; letter-spacing: -0.01em; color: ${t.cyan};
    text-shadow: 0 0 22px rgba(0, 229, 255, 0.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .type { margin-top: 14px; font-family: 'JetBrains Mono', monospace; font-size: 26px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.text3}; }
  h2 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: ${nameSize}px; line-height: 1.0;
    letter-spacing: -0.035em; max-height: ${Math.round(nameSize * 1.0 * 4) + 6}px; text-wrap: balance;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .venue { margin-top: 30px; font-size: 38px; line-height: 1.22; color: ${t.text2}; max-height: ${Math.round(38 * 1.22 * 2) + 4}px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .price { margin-top: 34px; }
  .pitch { margin-top: 56px; padding: 4px 0 4px 32px; border-left: 6px solid ${t.magenta}; font-size: 40px; line-height: 1.3; color: ${t.text};
    max-height: ${Math.round(40 * 1.3 * 3) + 10}px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .credit { margin-top: 32px; display: flex; align-items: center; gap: 28px; padding: 22px; border: 2px solid ${t.line};
    border-radius: 24px; background: rgba(10, 5, 16, 0.55); flex: none; }
  .thumb { width: 148px; height: 148px; border-radius: 16px; object-fit: cover; flex: none; border: 2px solid ${t.line}; }
  .handle { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 40px; color: ${t.text}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hint { margin-top: 6px; font-size: 26px; color: ${t.text3}; }
  .credit .txt { min-width: 0; }
  .foot { margin-top: 40px; }
  `
  const thumb = image ? `<img class="thumb" src="${image}" alt="">` : ''
  const hint = image ? 'flyer e infos no perfil' : 'infos e ingresso no perfil'
  return page(fontCss, `<div class="slide">
    ${top(`${index} / ${total}`)}
    <div class="body">
      <div class="when" data-fit>${esc(whenLabel(e, from, to))}</div>
      <div class="type">${esc(e.tipo || e.categoryLabel || '')}</div>
      <div class="main">
      <h2 data-fit data-shrink>${esc(keepDashWithWord(e.name.trim()))}</h2>
      <div class="venue" data-fit>${esc(venueLine(e))}</div>
      <div class="price"><span class="pill ${free ? 'lime' : 'outline'}">${esc(price)}</span></div>
      ${line ? `<div class="pitch" data-fit>${esc(line)}</div>` : ''}
      </div>
      <div class="credit">${thumb}<div class="txt"><div class="handle">@${esc(e.igHandle)}</div><div class="hint">${hint}</div></div></div>
    </div>
    <div class="foot"><b style="color:${t.lime}">+ rolês no app auê · link na bio</b><span class="swipe">${index < total ? 'arrasta →' : 'tem mais →'}</span></div>
  </div>`, css)
}

export function closingSlide({ fontCss, from, to, icon }) {
  const t = TOKENS
  const css = `
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 28px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.lime}; margin-bottom: 34px; }
  h1 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 150px; line-height: 0.94; letter-spacing: -0.045em; }
  h2 { margin-top: 30px; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 72px; line-height: 1.04; letter-spacing: -0.03em; text-wrap: balance; }
  h2 em { font-style: normal; color: ${t.magenta}; text-shadow: 0 0 26px rgba(255, 43, 214, 0.55); }
  .sub { margin-top: 30px; font-size: 36px; line-height: 1.35; color: ${t.text2}; max-width: 860px; }
  .cta { margin-top: 52px; }
  .stores { margin-top: auto; display: flex; flex-direction: column; gap: 22px; }
  .store { display: flex; align-items: center; gap: 30px; padding: 28px; border: 2px solid ${t.line}; border-radius: 28px; background: rgba(10,5,16,0.55); }
  .store img, .store .glyph { width: 104px; height: 104px; border-radius: 24px; flex: none; }
  .store .glyph { display: grid; place-items: center; font-size: 60px; background: rgba(255,255,255,0.06); }
  .store .a { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 42px; }
  .store .b { margin-top: 6px; font-size: 28px; color: ${t.text3}; }
  .foot { margin-top: 40px; }
  `
  return page(fontCss, `<div class="slide">
    ${top('baixa o app')}
    <div class="hero">
      <div class="kicker">o app da agenda de Curitiba</div>
      <h1>Baixa o <em>auê</em></h1>
      <h2>Todos os rolês da cidade num lugar só</h2>
      <div class="sub">Com a galera junto. De graça, atualizado todo dia.</div>
      <div class="cta"><span class="pill lime">link na bio</span></div>
    </div>
    <div class="stores">
      <div class="store">${icon ? `<img src="${icon}" alt="">` : '<div class="glyph">📱</div>'}<div><div class="a">iPhone</div><div class="b">já na App Store</div></div></div>
      <div class="store"><div class="glyph">🤖</div><div><div class="a">Android</div><div class="b">beta: entra antes de todo mundo</div></div></div>
    </div>
    <div class="foot"><b>@auecuritiba</b><span>${esc(windowLabel(from, to))}</span></div>
  </div>`, css)
}

export function contactSheet({ fontCss, slides, from, to }) {
  const t = TOKENS
  const cols = 3
  const w = 330, h = Math.round((w * HEIGHT) / WIDTH)
  const gap = 28, pad = 48
  const rows = Math.ceil(slides.length / cols)
  const sheetW = pad * 2 + cols * w + (cols - 1) * gap
  const sheetH = pad * 2 + 70 + rows * (h + 44) + (rows - 1) * gap
  const css = `
  html, body { width: ${sheetW}px; height: ${sheetH}px; background: ${t.bg}; }
  .sheet { padding: ${pad}px; }
  .head { height: 70px; white-space: nowrap; font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 30px; color: ${t.text}; }
  .head span { color: ${t.text3}; font-weight: 500; font-size: 20px; margin-left: 16px; font-family: 'JetBrains Mono', monospace; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, ${w}px); gap: ${gap}px; }
  .cell img { width: ${w}px; height: ${h}px; display: block; border-radius: 10px; border: 1px solid ${t.line}; }
  .cell div { height: 44px; padding-top: 10px; font-family: 'JetBrains Mono', monospace; font-size: 18px; color: ${t.text3}; }
  `
  const cells = slides.map((s) => `<div class="cell"><img src="${s.src}"><div>${esc(s.label)}</div></div>`).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}*{margin:0;padding:0;box-sizing:border-box}${css}</style></head><body><div class="sheet"><div class="head">Rola esse fim de semana<span>${esc(windowLabel(from, to))} · ${slides.length} slides · revisar antes de postar</span></div><div class="grid">${cells}</div></div></body></html>`
  return { html, width: sheetW, height: sheetH }
}
