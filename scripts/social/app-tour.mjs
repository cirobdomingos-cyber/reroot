#!/usr/bin/env node
// Render the "O que é o auê?" Instagram carousel for @auecuritiba: a cover,
// one slide per app feature with a real screenshot of auecuritiba.com in a
// phone frame, and the closing "Baixa o auê" slide.
//
// Renders files for a human to review; it never publishes anything.
//
//   node scripts/social/app-tour.mjs                 # screenshots from production
//   node scripts/social/app-tour.mjs --app https://staging.example --day Sex
//
// Output in social/out/app-tour/ (gitignored): 01..06 slides, caption.txt,
// contact-sheet.png, plus the raw screenshots in shots/.

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { TOKENS, page, top, closingSlide, contactSheet } from './slides.mjs'
import { ROOT, loadFontCss, launchChromium, renderPng } from './render.mjs'
import { CTA_DOWNLOAD, CTA_IPHONE, CTA_ANDROID } from './format.mjs'

const t = TOKENS

// One slide per feature, in the order a new user meets them. `shot` names
// the screenshot taken by captureShots(); copy is ours, short and descriptive.
export const FEATURES = [
  { shot: 'events', kicker: 'todo dia', title: 'Tudo que rola na cidade, por dia', sub: 'Shows, expos, bares, comédia e teatro de mais de 80 perfis de Curitiba.' },
  { shot: 'map', kicker: 'no mapa', title: 'Vê o que tá perto de você', sub: 'Abre o mapa e escolhe o rolê pelo bairro.' },
  { shot: 'event', kicker: 'num toque', title: 'Lugar, horário e o post original', sub: 'Cada evento leva direto pro perfil de quem organiza.' },
  { shot: 'channels', kicker: 'canais', title: 'Segue os canais que são a tua cara', sub: 'Rock, samba, eletrônica, comédia, livros: a gente separa por gênero e vibe.' },
]

export function buildTourCaption() {
  return `${[
    'O que é o auê? 👇',
    'Todo dia a gente junta o que tá rolando em Curitiba (shows, expos, bares, comédia, teatro) de mais de 80 perfis da cidade, num app só.',
    '',
    '📅 O que rola hoje, amanhã e no fim de semana',
    '🗺️ No mapa, perto de você',
    '📸 O post original do lugar, a um toque',
    '📢 Canais por vibe: rock, samba, eletrônica, comédia, livros',
    '🔒 Cria o teu canal com os amigos e combina o rolê ali',
    '',
    CTA_DOWNLOAD,
    `${CTA_IPHONE} · ${CTA_ANDROID}`,
    '',
    '#curitiba #agendacuritiba #oquefazeremcuritiba #appcuritiba #curitibacultural',
  ].join('\n')}\n`
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const tourCss = `
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 28px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.lime}; }
  h1 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: -0.04em; text-wrap: balance; }
  h1 em { font-style: normal; color: ${t.magenta}; text-shadow: 0 0 26px rgba(255, 43, 214, 0.55); }
  .sub { font-size: 34px; line-height: 1.35; color: ${t.text2}; text-wrap: pretty; }
  .foot b { color: ${t.lime}; }
`

export function tourCover({ fontCss }) {
  const css = `${tourCss}
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .kicker { margin-bottom: 36px; }
  h1 { font-size: 132px; line-height: 0.96; }
  .sub { margin-top: 44px; max-width: 880px; font-size: 40px; }
  .chips { margin-top: 56px; display: flex; flex-wrap: wrap; gap: 18px; }
  .chip { height: 64px; padding: 0 28px; border-radius: 999px; border: 2px solid ${t.line}; display: inline-flex; align-items: center;
    font-family: 'Space Grotesk', sans-serif; font-weight: 500; font-size: 30px; color: ${t.text}; background: rgba(10,5,16,0.55); }
  `
  const chips = ['🎸 shows', '😂 comédia', '🖼️ expos', '🍻 bares', '🎭 teatro', '📚 livrarias'].map((c) => `<span class="chip">${esc(c)}</span>`).join('')
  return page(fontCss, `<div class="slide">
    ${top('conhece o app?')}
    <div class="hero">
      <div class="kicker">o que é o auê</div>
      <h1 data-fit>Tudo que tá rolando em <em>Curitiba</em>, num lugar só</h1>
      <div class="sub">Um app que junta a agenda da cidade todo dia, direto dos perfis de quem organiza.</div>
      <div class="chips">${chips}</div>
    </div>
    <div class="foot"><b>📲 link na bio</b><span class="swipe">arrasta →</span></div>
  </div>`, css)
}

export function tourFeature({ fontCss, feature, index, total, shot }) {
  // The phone bleeds off the bottom edge on purpose; only the text above it
  // must stay inside the safe margin.
  const css = `${tourCss}
  .text { flex: none; margin-top: 44px; }
  .kicker { margin-bottom: 22px; }
  h1 { font-size: 84px; line-height: 1.0; max-height: 2.05em; }
  .sub { margin-top: 22px; max-width: 900px; }
  .phone { position: relative; flex: none; margin: 48px auto 0;
    width: 540px; padding: 18px; border-radius: 74px; background: #05020a;
    border: 3px solid rgba(255,255,255,0.14); box-shadow: 0 0 90px rgba(255, 43, 214, 0.28), 0 30px 80px rgba(0,0,0,0.6); }
  .phone img { display: block; width: 100%; border-radius: 58px; }
  .foot { position: absolute; left: 80px; right: 80px; bottom: 40px; z-index: 2;
    padding: 18px 26px; border-radius: 22px; background: rgba(10,5,16,0.86); }
  `
  return page(fontCss, `<div class="slide">
    ${top(`${index} / ${total}`)}
    <div class="text">
      <div class="kicker">${esc(feature.kicker)}</div>
      <h1 data-fit>${esc(feature.title)}</h1>
      <div class="sub">${esc(feature.sub)}</div>
    </div>
    <div class="phone" data-bleed>${shot ? `<img src="${shot}" alt="">` : ''}</div>
    <div class="foot"><b>📲 baixa o auê · link na bio</b><span class="swipe">${index < total ? 'arrasta →' : 'tem mais →'}</span></div>
  </div>`, css)
}

export function tourSocial({ fontCss, index, total }) {
  const css = `${tourCss}
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .kicker { margin-bottom: 30px; }
  h1 { font-size: 104px; line-height: 0.98; }
  .sub { margin-top: 36px; max-width: 880px; font-size: 38px; }
  .steps { margin-top: 60px; display: flex; flex-direction: column; gap: 20px; }
  .step { display: flex; align-items: center; gap: 28px; padding: 26px 30px; border: 2px solid ${t.line}; border-radius: 28px; background: rgba(10,5,16,0.55);
    font-family: 'Space Grotesk', sans-serif; font-weight: 500; font-size: 38px; }
  .step .n { flex: none; width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: ${t.magenta}; color: ${t.bg};
    font-weight: 700; font-size: 34px; box-shadow: 0 0 22px rgba(255, 43, 214, 0.5); }
  `
  const steps = ['Toca em "+ Criar canal"', 'Chama os amigos pelo link do canal', 'Cada um põe rolê e todo mundo vê quem vai']
    .map((s, i) => `<div class="step"><span class="n">${i + 1}</span><span>${esc(s)}</span></div>`).join('')
  return page(fontCss, `<div class="slide">
    ${top(`${index} / ${total}`)}
    <div class="hero">
      <div class="kicker">canal privado</div>
      <h1 data-fit>Cria o teu canal com a <em>galera</em></h1>
      <div class="sub">Só entra quem você convidar. Sem rede social nova pra cuidar: só primeiro nome.</div>
      <div class="steps">${steps}</div>
    </div>
    <div class="foot"><b>📲 baixa o auê · link na bio</b><span class="swipe">arrasta →</span></div>
  </div>`, css)
}

/* global document -- the hide-price step runs inside the page */
/** Screenshots of the live web app at phone size (1170x2532, iPhone-like). */
async function captureShots(browser, { app, day, event, eventDay, filter, dir }) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
  })
  const p = await ctx.newPage()
  const shots = {}
  const snap = async (name) => { const file = path.join(dir, `${name}.png`); await p.screenshot({ path: file }); shots[name] = file }
  // Every shot starts from a fresh load of the events screen, so one shot's
  // day or filter never leaks into the next.
  const openEvents = async () => {
    await p.goto(`${app}/`, { waitUntil: 'networkidle', timeout: 60000 })
    await p.waitForTimeout(1500)
    const enter = p.getByText('Bora ver')
    if (await enter.count()) { await enter.click(); await p.waitForTimeout(2500) }
    const skip = p.getByText(/agora não/i).last()
    if (await skip.count()) { await skip.click(); await p.waitForTimeout(3000) }
  }
  // The day the post talks about, not whatever the strip picked.
  const pickDay = async (d) => {
    if (!d) return
    const btn = p.getByText(d, { exact: true }).first()
    if (await btn.count()) { await btn.click(); await p.waitForTimeout(2000) }
  }
  const hideLeaves = (pattern, how) => p.evaluate(({ src, mode }) => {
    const re = new RegExp(src, 'i')
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length !== 0 || !re.test(el.textContent || '')) continue
      if (mode === 'row') {
        let row = el
        while (row.parentElement && row.parentElement.children.length < 2) row = row.parentElement
        ;(row.parentElement || row).style.display = 'none'
      } else {
        el.style.visibility = 'hidden'
      }
    }
  }, { src: pattern, mode: how })
  try {
    // 1-2. The list on `day`, narrowed to a category chip ("🎵 Música · 41")
    // so it leads with shows instead of long-running exhibitions; then the map.
    await openEvents()
    await pickDay(day)
    if (filter) {
      const chip = p.getByText(new RegExp(`${filter}\\s*·`, 'i')).first()
      if (await chip.count()) { await chip.click(); await p.waitForTimeout(2500) }
    }
    await snap('events')
    await p.getByText(/Mapa/).first().click()
    await p.waitForTimeout(5000)
    await snap('map')

    // 3. One event's detail, from the unfiltered list on `eventDay`. A named
    // card when given (--event), else the first one (the venue line
    // "📍 Lugar · Bairro" is on every card).
    await openEvents()
    await pickDay(eventDay)
    const named = event ? p.getByText(event).first() : null
    await (named && (await named.count()) ? named : p.getByText(/📍/).first()).click({ timeout: 8000 })
    await p.waitForTimeout(7000) // the cover image fades in
    // No prices on @auecuritiba posts (the feed's price is a guess).
    await hideLeaves('^\\s*custo\\s*$', 'row')
    await snap('event')

    // 4. Comunidade -> Canais (the default tab). Follower counts are still
    // tiny, so they stay out of the post.
    await openEvents()
    await p.getByText(/comunidade/i).last().click()
    await p.waitForTimeout(3500)
    await hideLeaves('^\\s*\\d+\\s+seguindo\\s*$', 'hide')
    await snap('channels')
  } finally {
    await ctx.close()
  }
  return shots
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      app: { type: 'string', default: 'https://auecuritiba.com' },
      day: { type: 'string', default: 'Sáb' },
      event: { type: 'string', default: 'Renato Russo' },
      'event-day': { type: 'string', default: 'Dom' },
      filter: { type: 'string', default: 'Música' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log('Usage: app-tour.mjs [--app URL] [--day Sáb] [--event "name on the card"] [--out dir]')
    return
  }
  const out = path.resolve(values.out || path.join(ROOT, 'social', 'out', 'app-tour'))
  const shotsDir = path.join(out, 'shots')
  await mkdir(shotsDir, { recursive: true })
  for (const f of await readdir(out)) if (/\.png$/.test(f)) await unlink(path.join(out, f))

  const fontCss = await loadFontCss()
  const iconFile = path.join(ROOT, 'public', 'icon-192x192.png')
  const icon = existsSync(iconFile) ? `data:image/png;base64,${(await readFile(iconFile)).toString('base64')}` : null

  const browser = await launchChromium()
  const problems = []
  try {
    const shots = await captureShots(browser, { app: values.app.replace(/\/+$/, ''), day: values.day, event: values.event, eventDay: values['event-day'], filter: values.filter, dir: shotsDir })
    const total = FEATURES.length + 1
    const dataUrl = async (file) => (file ? `data:image/png;base64,${(await readFile(file)).toString('base64')}` : null)
    const slides = [
      { name: '01-capa.png', label: 'capa', html: tourCover({ fontCss }) },
      ...(await Promise.all(FEATURES.map(async (feature, i) => ({
        name: `${String(i + 2).padStart(2, '0')}-${feature.shot}.png`,
        label: `${i + 1}/${total} ${feature.shot}`,
        html: tourFeature({ fontCss, feature, index: i + 1, total, shot: await dataUrl(shots[feature.shot]) }),
      })))),
      { name: `${String(FEATURES.length + 2).padStart(2, '0')}-canal-privado.png`, label: `${total}/${total} canal privado`, html: tourSocial({ fontCss, index: total, total }) },
      { name: `${String(FEATURES.length + 3).padStart(2, '0')}-baixa.png`, label: 'fechamento', html: closingSlide({ fontCss, icon, footRight: 'Curitiba que acontece' }) },
    ]
    for (const s of slides) {
      const file = path.join(out, s.name)
      // The phone frame bleeds off the bottom by design; everything else must fit.
      for (const prob of await renderPng(browser, s.html, file)) if (!/phone|IMG/.test(prob)) problems.push(`${s.name}: ${prob}`)
      s.src = `data:image/png;base64,${(await readFile(file)).toString('base64')}`
    }
    const sheet = contactSheet({ fontCss, slides, title: 'O que é o auê?', subtitle: 'tour do app' })
    await renderPng(browser, sheet.html, path.join(out, 'contact-sheet.png'), { width: sheet.width, height: sheet.height, check: false })
  } finally {
    await browser.close()
  }
  await writeFile(path.join(out, 'caption.txt'), buildTourCaption())
  if (problems.length) { console.warn('! layout warnings (check these slides):'); for (const prob of problems) console.warn(`  ${prob}`) }
  console.log(`-> ${path.relative(process.cwd(), out) || '.'}/ (review contact-sheet.png and caption.txt before posting)`)
  if (problems.some((prob) => prob.includes('outside the safe margin'))) process.exitCode = 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`app-tour: ${err.message}`)
    process.exit(1)
  })
}
