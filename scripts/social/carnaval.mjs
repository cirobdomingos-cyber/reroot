#!/usr/bin/env node
// Render the "Chegou o Pré-Carnaval no auê" Instagram carousel for
// @auecuritiba: a cover, two real screenshots of auecuritiba.com in a phone
// frame (the season band on Home, the channel screen), a slide naming the
// blocos the channel follows, and the closing "Baixa o auê" slide.
//
// Renders files for a human to review; it never publishes anything. The
// screenshots are taken signed out on purpose: the band shows only to
// people who don't follow the channel yet, which is who the post is for.
//
//   node scripts/social/carnaval.mjs                       # production
//   node scripts/social/carnaval.mjs --app https://staging.example
//
// Output in social/out/carnaval/ (gitignored): 01..05 slides, caption.txt,
// contact-sheet.png, plus the raw screenshots in shots/.

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { TOKENS, page, top, closingSlide, contactSheet } from './slides.mjs'
import { ROOT, loadFontCss, launchChromium, renderPng } from './render.mjs'
import { CTA_DOWNLOAD, CTA_IPHONE, CTA_ANDROID } from './format.mjs'

const t = TOKENS

// The production channel. Staging has its own id; pass --channel there.
export const CHANNEL_ID = 'grp_7f9046c616f43074'

// The blocos the channel follows (scripts/import_blocos.py), shown on the
// "quem tá lá" slide and tagged in the caption so each one is notified —
// a bloco that sees itself listed has a reason to repost.
export const BLOCOS = [
  ['Afro Pretinhosidade', 'blocoafropretinhosidadeoficial'],
  ['Astrobloco', 'astro.bloco'],
  ['Backstreet Bloco', 'backstreet.bloco'],
  ['Baque Mulher', 'baquemulhercwb'],
  ['Batucannabis', 'batucannabis'],
  ['Bicibloco', 'bicibloco'],
  ['Ela Pode, Ela Vai', 'elapodeelavai'],
  ['Brasilidades', 'brasilidadess'],
  ['Burlesco Cachorras', 'bbcachorras'],
  ['Pífanos de Curitiba', 'blocodepifanoscwb'],
  ['Bloco de Segunda', 'blocodesegunda'],
  ['Bloco dos Blocos', 'blocodosblocos'],
  ['Ecoorquestra', 'ecoorquestra'],
  ['Bloco Secreto', 'blocosecreto.curitiba'],
  ['Bocas Malditas', 'bocasmalditas'],
  ['Caiu no Cavalo Babão', 'caiunocavalobabao'],
  ['Carreta SapaPan Bi Bi', 'carretasapapanbibi'],
  ['Trupe Guará', 'trupeguara'],
  ['Devagar & Sempre', 'devagaresemprecwb'],
  ['Garibaldis & Sacis', 'garibaldisesacis'],
  ['Malinski-se', 'blocomalinski_se'],
  ['Maracatu Aroeira', 'maracatuaroeira'],
  ['Marcha das 1000 Drags', 'juana.profunda'],
  ['Marginais', 'bloco_marginais'],
  ['O Amor é Brega', 'blocooamorebrega'],
  ['Saí do Armário e Me Dei Bem', 'saidoarmarioemedeibem'],
  ['Segura o CUritiba', 'seguraocuritiba'],
  ['Siribloco', 'siribloco'],
]

export const FEATURES = [
  { shot: 'home', kicker: 'na tela inicial', title: 'Abre o app: o próximo bloco, com dia e hora', sub: 'A faixa no topo da tela mostra a próxima saída e quanto falta. Toca em Seguir e pronto.' },
  { shot: 'channel', kicker: 'canal auê pré-carnaval', title: 'Toda saída dos blocos, num canal só', sub: 'O que os blocos postam com data entra sozinho. Quem segue recebe o resumo da semana toda quinta.' },
]

export function buildCarnavalCaption() {
  const handles = BLOCOS.map(([, h]) => `@${h}`).join(' ')
  return `${[
    'O app auê agora tem o Pré-Carnaval 🥁',
    'Baixa o app (link na bio), segue o canal auê Pré-Carnaval e recebe saída, concentração e percurso de cada bloco de Curitiba, direto do Instagram deles.',
    '',
    '📅 A próxima saída na tela inicial, com dia, hora e quanto falta',
    '📢 Segue o canal auê Pré-Carnaval e recebe o resumo toda quinta',
    '🥁 28 blocos acompanhados, do Garibaldis ao Siribloco',
    '',
    'Bloco que posta a data na legenda entra na hora. Faltou o seu? Manda DM.',
    '',
    CTA_DOWNLOAD,
    `${CTA_IPHONE} · ${CTA_ANDROID}`,
    '',
    handles,
    '',
    '#carnavalcuritiba #precarnaval #blocosdecuritiba #curitiba #agendacuritiba #oquefazeremcuritiba',
  ].join('\n')}\n`
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// The season's colour on the slides is the app's --hot in the Neon skin.
const SEASON = '#FF5A1F'

const css = `
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 28px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.lime}; }
  h1 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: -0.04em; text-wrap: balance; }
  h1 em { font-style: normal; color: ${SEASON}; text-shadow: 0 0 26px rgba(255, 90, 31, 0.55); }
  .sub { font-size: 34px; line-height: 1.35; color: ${t.text2}; text-wrap: pretty; }
  .foot b { color: ${t.lime}; }
`

export function carnavalCover({ fontCss, shot }) {
  const extra = `${css}
  .text { flex: none; margin-top: 20px; }
  .kicker { margin-bottom: 18px; }
  h1 { font-size: 100px; line-height: 0.95; }
  .sub { margin-top: 20px; max-width: 900px; font-size: 35px; }
  .chips { margin-top: 24px; display: flex; flex-wrap: wrap; gap: 16px; }
  .chip { height: 60px; padding: 0 26px; border-radius: 999px; border: 2px solid ${SEASON}; display: inline-flex; align-items: center;
    font-family: 'Space Grotesk', sans-serif; font-weight: 500; font-size: 28px; color: ${t.text}; background: rgba(255, 90, 31, 0.12); }
  .phone { position: relative; flex: none; margin: 26px auto 0;
    width: 540px; padding: 18px; border-radius: 74px; background: #05020a;
    border: 3px solid rgba(255,255,255,0.14); box-shadow: 0 0 90px rgba(255, 90, 31, 0.28), 0 30px 80px rgba(0,0,0,0.6); }
  .phone img { display: block; width: 100%; border-radius: 58px; }
  .foot { position: absolute; left: 80px; right: 80px; bottom: 40px; z-index: 2;
    padding: 18px 26px; border-radius: 22px; background: rgba(10,5,16,0.86); }
  `
  const chips = ['📲 é um app, de graça', '🍎 iPhone', '🤖 Android'].map((c) => `<span class="chip">${esc(c)}</span>`).join('')
  return page(fontCss, `<div class="slide">
    ${top('novidade no app')}
    <div class="text">
      <div class="kicker">no app auê</div>
      <h1 data-fit>Os blocos do <em>Pré-Carnaval</em>, no seu celular</h1>
      <div class="sub">Baixa o app, segue o canal e recebe saída, concentração e percurso de cada bloco de Curitiba.</div>
      <div class="chips">${chips}</div>
    </div>
    <div class="phone" data-bleed>${shot ? `<img src="${shot}" alt="">` : ''}</div>
    <div class="foot"><b>📲 baixa o app auê · link na bio</b><span class="swipe">arrasta →</span></div>
  </div>`, extra)
}

// The app-tour feature slide, with a footer that says "app" every time.
export function featureSlide({ fontCss, feature, index, total, shot }) {
  const extra = `${css}
  .text { flex: none; margin-top: 44px; }
  .kicker { margin-bottom: 22px; }
  h1 { font-size: 84px; line-height: 1.0; max-height: 2.05em; }
  .sub { margin-top: 22px; max-width: 900px; }
  .phone { position: relative; flex: none; margin: 48px auto 0;
    width: 540px; padding: 18px; border-radius: 74px; background: #05020a;
    border: 3px solid rgba(255,255,255,0.14); box-shadow: 0 0 90px rgba(255, 90, 31, 0.28), 0 30px 80px rgba(0,0,0,0.6); }
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
    <div class="foot"><b>📲 baixa o app auê · link na bio</b><span class="swipe">${index < total ? 'arrasta →' : 'tem mais →'}</span></div>
  </div>`, extra)
}

export function blocosSlide({ fontCss, index, total }) {
  const extra = `${css}
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .kicker { margin-bottom: 26px; }
  h1 { font-size: 92px; line-height: 0.98; }
  .sub { margin-top: 28px; max-width: 900px; }
  .chips { margin-top: 44px; display: flex; flex-wrap: wrap; gap: 14px; }
  .chip { height: 56px; padding: 0 22px; border-radius: 999px; border: 2px solid ${t.line}; display: inline-flex; align-items: center;
    font-family: 'Space Grotesk', sans-serif; font-weight: 500; font-size: 26px; color: ${t.text}; background: rgba(10,5,16,0.55); white-space: nowrap; }
  `
  const chips = BLOCOS.map(([name]) => `<span class="chip">${esc(name)}</span>`).join('')
  return page(fontCss, `<div class="slide">
    ${top(`${index} / ${total}`)}
    <div class="hero">
      <div class="kicker">quem tá lá</div>
      <h1 data-fit>28 blocos, do <em>Garibaldis</em> ao <em>Siribloco</em></h1>
      <div class="sub">Bloco que posta a saída com data na legenda entra na hora. Faltou o seu? Manda DM.</div>
      <div class="chips">${chips}</div>
    </div>
    <div class="foot"><b>📲 baixa o app auê · link na bio</b><span class="swipe">tem mais →</span></div>
  </div>`, extra)
}

/* global document -- the hide step runs inside the page */
/** Screenshots of the live web app at phone size, signed out. */
async function captureShots(browser, { app, channel, dir }) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
  })
  const p = await ctx.newPage()
  const shots = {}
  const snap = async (name) => { const file = path.join(dir, `${name}.png`); await p.screenshot({ path: file }); shots[name] = file }
  const hideLeaves = (pattern) => p.evaluate((src) => {
    const re = new RegExp(src, 'i')
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length === 0 && re.test(el.textContent || '')) el.style.visibility = 'hidden'
    }
  }, pattern)
  try {
    // 1. Home with the season band. The band loads after the list.
    await p.goto(`${app}/#/events`, { waitUntil: 'networkidle', timeout: 60000 })
    await p.waitForTimeout(2500)
    const enter = p.getByText('Bora ver')
    if (await enter.count()) { await enter.click(); await p.waitForTimeout(2500) }
    const skip = p.getByText(/agora não/i).last()
    if (await skip.count()) { await skip.click(); await p.waitForTimeout(2500) }
    await p.waitForTimeout(3000)
    await snap('home')

    // 2. The channel screen. Follower counts are still tiny; keep them out.
    await p.goto(`${app}/#/channels/${channel}`, { waitUntil: 'networkidle', timeout: 60000 })
    await p.waitForTimeout(5000)
    // The install strip is for web visitors; inside a post about the app
    // it reads as the app asking you to download the app.
    const strip = p.getByLabel('Fechar').first()
    if (await strip.count()) { await strip.click(); await p.waitForTimeout(500) }
    await hideLeaves('^\\s*\\d+\\s+seguindo\\s*$')
    await snap('channel')
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
      channel: { type: 'string', default: CHANNEL_ID },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log('Usage: carnaval.mjs [--app URL] [--channel id] [--out dir]')
    return
  }
  const out = path.resolve(values.out || path.join(ROOT, 'social', 'out', 'carnaval'))
  const shotsDir = path.join(out, 'shots')
  await mkdir(shotsDir, { recursive: true })
  for (const f of await readdir(out)) if (/\.png$/.test(f)) await unlink(path.join(out, f))

  const fontCss = await loadFontCss()
  const iconFile = path.join(ROOT, 'public', 'icon-192x192.png')
  const icon = existsSync(iconFile) ? `data:image/png;base64,${(await readFile(iconFile)).toString('base64')}` : null

  const browser = await launchChromium()
  const problems = []
  try {
    const shots = await captureShots(browser, { app: values.app.replace(/\/+$/, ''), channel: values.channel, dir: shotsDir })
    const total = FEATURES.length + 1
    const dataUrl = async (file) => (file ? `data:image/png;base64,${(await readFile(file)).toString('base64')}` : null)
    const slides = [
      { name: '01-capa.png', label: 'capa', html: carnavalCover({ fontCss, shot: await dataUrl(shots.home) }) },
      ...(await Promise.all(FEATURES.map(async (feature, i) => ({
        name: `${String(i + 2).padStart(2, '0')}-${feature.shot}.png`,
        label: `${i + 1}/${total} ${feature.shot}`,
        html: featureSlide({ fontCss, feature, index: i + 1, total, shot: await dataUrl(shots[feature.shot]) }),
      })))),
      { name: `${String(FEATURES.length + 2).padStart(2, '0')}-blocos.png`, label: `${total}/${total} blocos`, html: blocosSlide({ fontCss, index: total, total }) },
      { name: `${String(FEATURES.length + 3).padStart(2, '0')}-baixa.png`, label: 'fechamento', html: closingSlide({ fontCss, icon, footRight: 'Curitiba que acontece' }) },
    ]
    for (const s of slides) {
      const file = path.join(out, s.name)
      for (const prob of await renderPng(browser, s.html, file)) if (!/phone|IMG/.test(prob)) problems.push(`${s.name}: ${prob}`)
      s.src = `data:image/png;base64,${(await readFile(file)).toString('base64')}`
    }
    const sheet = contactSheet({ fontCss, slides, title: 'Chegou o Pré-Carnaval', subtitle: 'novidade no app' })
    await renderPng(browser, sheet.html, path.join(out, 'contact-sheet.png'), { width: sheet.width, height: sheet.height, check: false })
  } finally {
    await browser.close()
  }
  await writeFile(path.join(out, 'caption.txt'), buildCarnavalCaption())
  if (problems.length) { console.warn('! layout warnings (check these slides):'); for (const prob of problems) console.warn(`  ${prob}`) }
  console.log(`-> ${path.relative(process.cwd(), out) || '.'}/ (review contact-sheet.png and caption.txt before posting)`)
  if (problems.some((prob) => prob.includes('outside the safe margin'))) process.exitCode = 2
}

// pathToFileURL, not a string prefix: on Windows argv[1] is `D:\...` and
// the URL is `file:///D:/...`, so the plain comparison never ran main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`carnaval: ${err.message}`)
    process.exit(1)
  })
}
