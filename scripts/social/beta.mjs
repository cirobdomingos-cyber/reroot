#!/usr/bin/env node
// Render the "Ajuda o auê a chegar na Play Store" call for Android testers:
// a feed carousel (cover with the testers still missing, the steps with a
// real screenshot of the /install beta page, what staying 14 days means, and
// the closing slide) plus one 1080x1920 Story with room for a link sticker.
//
// Why a post of its own: Play opens production for a new personal account
// only after 12 testers stay opted in to the closed test for 14 days in a
// row. The other posts sell the app; this one asks for that help.
//
// Renders files for a human to review; it never publishes anything.
//
//   node scripts/social/beta.mjs --missing 9          # "faltam 9" (read it in Play Console first)
//   node scripts/social/beta.mjs --app https://staging.example
//
// Output in social/out/beta/ (gitignored): 01..04 slides, story.png,
// caption.txt, contact-sheet.png and the raw screenshot in shots/.

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { TOKENS, WIDTH, page, top, closingSlide, contactSheet } from './slides.mjs'
import { ROOT, loadFontCss, launchChromium, renderPng } from './render.mjs'
import { CTA_IPHONE } from './format.mjs'

const t = TOKENS
export const TESTERS_NEEDED = 12
export const TEST_DAYS = 14
export const STORY_HEIGHT = 1920

// The same four taps the /install beta page asks for, in its order and words
// (backend/main.py, _install_android_beta_html). From Instagram the first one
// is "Abrir no Chrome"; in Chrome the page starts at the group.
export const STEPS = [
  { title: 'Link na bio → Abrir no Chrome', sub: 'Dentro do Instagram o Google não deixa entrar na conta.' },
  { title: 'Entra no grupo de testers', sub: 'Toca "Participar do grupo".' },
  { title: 'Aceita o teste', sub: 'Na Play Store, "Quero ser testador".' },
  { title: 'Instala o auê', sub: 'Pronto. Usa a mesma conta Google nos três.' },
]

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** "faltam 9 pessoas" when the count is known, else the whole goal. */
export function missingLabel(missing) {
  if (missing == null) return `${TESTERS_NEEDED} pessoas · ${TEST_DAYS} dias`
  if (missing <= 0) return 'meta batida, valeu!'
  return missing === 1 ? 'falta 1 pessoa' : `faltam ${missing} pessoas`
}

export function buildBetaCaption({ missing } = {}) {
  const need = missing == null ? `${TESTERS_NEEDED} pessoas` : missingLabel(missing).replace(/^f/, 'F')
  const lines = [
    'Ajuda o auê a chegar na Play Store 🙏',
    '',
    `No iPhone o auê já tá na App Store. No Android, o Google só libera o app depois que ${TESTERS_NEEDED} pessoas testam por ${TEST_DAYS} dias seguidos.`,
    missing == null ? `Precisamos de ${need} com Android.` : `${need} com Android.`,
    '',
    'Leva 2 minutos:',
    ...STEPS.map((s, i) => `${i + 1}️⃣ ${s.title}`),
    '',
    `Depois é só deixar instalado por ${TEST_DAYS} dias e abrir quando quiser ver o que tá rolando em Curitiba. Achou bug ou tem ideia? Manda DM.`,
    '',
    `📲 ${CTA_IPHONE} · Android: beta, link na bio`,
    '',
    '#curitiba #agendacuritiba #oquefazeremcuritiba #appcuritiba #android',
  ]
  return `${lines.join('\n')}\n`
}

const betaCss = `
  .kicker { font-family: 'JetBrains Mono', monospace; font-size: 28px; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.lime}; }
  h1 { font-family: 'Space Grotesk', sans-serif; font-weight: 700; letter-spacing: -0.04em; text-wrap: balance; }
  h1 em { font-style: normal; color: ${t.magenta}; text-shadow: 0 0 26px rgba(255, 43, 214, 0.55); }
  .sub { font-size: 36px; line-height: 1.35; color: ${t.text2}; text-wrap: pretty; }
  .foot b { color: ${t.lime}; }
  .count { display: inline-flex; align-items: baseline; gap: 22px; padding: 26px 36px; border-radius: 32px;
    border: 3px solid ${t.cyan}; background: rgba(0, 229, 255, 0.08); box-shadow: 0 0 40px rgba(0, 229, 255, 0.18); }
  .count .big { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 64px; color: ${t.cyan}; letter-spacing: -0.02em; white-space: nowrap; }
  .count .small { font-family: 'JetBrains Mono', monospace; font-size: 24px; letter-spacing: 0.08em; text-transform: uppercase; color: ${t.text2}; white-space: nowrap; }
  .steps { display: flex; flex-direction: column; gap: 18px; }
  .step { display: flex; align-items: center; gap: 26px; padding: 22px 28px; border: 2px solid ${t.line}; border-radius: 28px; background: rgba(10,5,16,0.55); }
  .step .n { flex: none; width: 60px; height: 60px; border-radius: 50%; display: grid; place-items: center; background: ${t.magenta}; color: ${t.bg};
    font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 32px; box-shadow: 0 0 22px rgba(255, 43, 214, 0.5); }
  .step .a { font-family: 'Space Grotesk', sans-serif; font-weight: 700; font-size: 36px; line-height: 1.1; }
  .step .b { margin-top: 6px; font-size: 26px; line-height: 1.3; color: ${t.text3}; }
  .step .txt { min-width: 0; }
`

const stepRows = (steps = STEPS) => steps.map((s, i) => `<div class="step"><span class="n">${i + 1}</span><div class="txt"><div class="a">${esc(s.title)}</div><div class="b">${esc(s.sub)}</div></div></div>`).join('')

export function betaCover({ fontCss, missing }) {
  const css = `${betaCss}
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .kicker { margin-bottom: 36px; }
  h1 { font-size: 128px; line-height: 0.96; }
  .sub { margin-top: 44px; max-width: 900px; font-size: 40px; }
  .count { margin-top: 60px; align-self: flex-start; }
  `
  return page(fontCss, `<div class="slide">
    ${top('android · beta')}
    <div class="hero">
      <div class="kicker">tem Android? ajuda a gente</div>
      <h1 data-fit>Leva o auê pra <em>Play Store</em></h1>
      <div class="sub">O Google só libera o app depois que ${TESTERS_NEEDED} pessoas testam por ${TEST_DAYS} dias seguidos.</div>
      <div class="count"><span class="big">${esc(missingLabel(missing))}</span>${missing == null ? '' : `<span class="small">de ${TESTERS_NEEDED}</span>`}</div>
    </div>
    <div class="foot"><b>📲 link na bio · leva 2 minutos</b><span class="swipe">arrasta →</span></div>
  </div>`, css)
}

export function betaSteps({ fontCss, index, total, shot }) {
  // The phone bleeds off the bottom edge on purpose, as in the app tour.
  const css = `${betaCss}
  .text { flex: none; margin-top: 40px; }
  .kicker { margin-bottom: 20px; }
  h1 { font-size: 80px; line-height: 1.0; }
  .steps { margin-top: 34px; gap: 14px; }
  .step { padding: 16px 24px; }
  .step .n { width: 52px; height: 52px; font-size: 28px; }
  .step .a { font-size: 32px; }
  .step .b { display: none; }
  .phone { position: relative; flex: none; margin: 40px auto 0;
    width: 500px; padding: 16px; border-radius: 70px; background: #05020a;
    border: 3px solid rgba(255,255,255,0.14); box-shadow: 0 0 90px rgba(255, 43, 214, 0.28), 0 30px 80px rgba(0,0,0,0.6); }
  .phone img { display: block; width: 100%; border-radius: 56px; }
  .foot { position: absolute; left: 80px; right: 80px; bottom: 40px; z-index: 2;
    padding: 18px 26px; border-radius: 22px; background: rgba(10,5,16,0.86); }
  `
  return page(fontCss, `<div class="slide">
    ${top(`${index} / ${total}`)}
    <div class="text">
      <div class="kicker">como entra</div>
      <h1 data-fit>Quatro toques, uma vez só</h1>
      <div class="steps">${stepRows()}</div>
    </div>
    <div class="phone" data-bleed>${shot ? `<img src="${shot}" alt="">` : ''}</div>
    <div class="foot"><b>📲 link na bio</b><span class="swipe">arrasta →</span></div>
  </div>`, css)
}

export function betaStay({ fontCss, index, total }) {
  const css = `${betaCss}
  .hero { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .kicker { margin-bottom: 30px; }
  h1 { font-size: 104px; line-height: 0.98; }
  .sub { margin-top: 36px; max-width: 900px; }
  .steps { margin-top: 56px; }
  `
  const asks = [
    { title: `Deixa instalado por ${TEST_DAYS} dias`, sub: 'Se sair do teste antes, a contagem do Google volta pro zero.' },
    { title: 'Abre quando quiser um rolê', sub: 'O que rola hoje, no fim de semana, perto de você.' },
    { title: 'Achou bug? Manda DM', sub: 'Cada ideia vira ajuste no app.' },
  ]
  const rows = asks.map((s) => `<div class="step"><span class="n">✓</span><div class="txt"><div class="a">${esc(s.title)}</div><div class="b">${esc(s.sub)}</div></div></div>`).join('')
  return page(fontCss, `<div class="slide">
    ${top(`${index} / ${total}`)}
    <div class="hero">
      <div class="kicker">depois de instalar</div>
      <h1 data-fit>Fica com a gente <em>${TEST_DAYS} dias</em></h1>
      <div class="sub">É isso que o Google conta. Você testa o app antes de todo mundo e ajuda ele a chegar pra toda Curitiba.</div>
      <div class="steps">${rows}</div>
    </div>
    <div class="foot"><b>📲 link na bio</b><span class="swipe">arrasta →</span></div>
  </div>`, css)
}

/** One 1080x1920 Story: the ask, the count, the steps, and a clear area for the link sticker. */
export function betaStory({ fontCss, missing }) {
  const css = `${betaCss}
  html, body { height: ${STORY_HEIGHT}px; }
  .slide { height: ${STORY_HEIGHT}px; padding: 150px 80px 120px; }
  .kicker { margin-top: 70px; margin-bottom: 28px; }
  h1 { font-size: 112px; line-height: 0.96; }
  .count { margin-top: 44px; align-self: flex-start; }
  .steps { margin-top: 56px; }
  /* Empty band at the bottom: the link sticker is placed here in Instagram. */
  .sticker { margin-top: auto; height: 220px; display: flex; align-items: flex-start; justify-content: center;
    font-family: 'JetBrains Mono', monospace; font-size: 30px; letter-spacing: 0.1em; text-transform: uppercase; color: ${t.lime}; }
  `
  return page(fontCss, `<div class="slide">
    ${top('android · beta')}
    <div class="kicker">tem Android? ajuda a gente</div>
    <h1 data-fit>Leva o auê pra <em>Play Store</em></h1>
    <div class="count"><span class="big">${esc(missingLabel(missing))}</span><span class="small">${TEST_DAYS} dias seguidos</span></div>
    <div class="steps">${stepRows()}</div>
    <div class="sticker">toca no link ↓</div>
  </div>`, css)
}

/* global document -- runs inside the page */
/** The /install beta page as an Android Chrome visitor sees it, phone size. */
async function captureInstall(browser, { app, dir }) {
  // "HeadlessChrome" keeps this render out of the funnel (_BOT_UA_RE).
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 HeadlessChrome',
  })
  const p = await ctx.newPage()
  try {
    await p.goto(`${app}/install`, { waitUntil: 'networkidle', timeout: 60000 })
    await p.waitForTimeout(1500)
    if (!(await p.locator('#android-beta').isVisible())) {
      console.warn('! /install shows no Android beta section (PLAY_BETA_GROUP_URL unset?); the steps slide goes without a screenshot')
      return null
    }
    // Start the shot at the beta heading, not the logo.
    await p.evaluate(() => document.querySelector('#android-beta').scrollIntoView())
    const file = path.join(dir, 'install.png')
    await p.screenshot({ path: file })
    return file
  } finally {
    await ctx.close()
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      app: { type: 'string', default: 'https://auecuritiba.com' },
      missing: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log('Usage: beta.mjs [--missing N] [--app URL] [--out dir]')
    return
  }
  const missing = values.missing == null ? null : Number.parseInt(values.missing, 10)
  if (missing != null && !Number.isFinite(missing)) throw new Error('--missing takes a number (testers still needed)')
  if (missing == null) console.warn('! no --missing: the slides show the whole goal; read the opted-in count in Play Console (Closed testing -> Alpha -> Testers) to show "faltam N"')

  const out = path.resolve(values.out || path.join(ROOT, 'social', 'out', 'beta'))
  const shotsDir = path.join(out, 'shots')
  await mkdir(shotsDir, { recursive: true })
  for (const f of await readdir(out)) if (/\.png$/.test(f)) await unlink(path.join(out, f))

  const fontCss = await loadFontCss()
  const iconFile = path.join(ROOT, 'public', 'icon-192x192.png')
  const icon = existsSync(iconFile) ? `data:image/png;base64,${(await readFile(iconFile)).toString('base64')}` : null

  const browser = await launchChromium()
  const problems = []
  try {
    const shotFile = await captureInstall(browser, { app: values.app.replace(/\/+$/, ''), dir: shotsDir })
    const shot = shotFile ? `data:image/png;base64,${(await readFile(shotFile)).toString('base64')}` : null
    const total = 3
    const slides = [
      { name: '01-capa.png', label: 'capa', html: betaCover({ fontCss, missing }) },
      { name: '02-passos.png', label: '2/3 passos', html: betaSteps({ fontCss, index: 2, total, shot }) },
      { name: '03-14-dias.png', label: '3/3 14 dias', html: betaStay({ fontCss, index: 3, total }) },
      { name: '04-baixa.png', label: 'fechamento', html: closingSlide({ fontCss, icon, footRight: 'Curitiba que acontece' }) },
    ]
    for (const s of slides) {
      const file = path.join(out, s.name)
      for (const prob of await renderPng(browser, s.html, file)) if (!/phone|IMG/.test(prob)) problems.push(`${s.name}: ${prob}`)
      s.src = `data:image/png;base64,${(await readFile(file)).toString('base64')}`
    }
    for (const prob of await renderPng(browser, betaStory({ fontCss, missing }), path.join(out, 'story.png'), { width: WIDTH, height: STORY_HEIGHT })) {
      problems.push(`story.png: ${prob}`)
    }
    const sheet = contactSheet({ fontCss, slides, title: 'Ajuda o auê a chegar na Play Store', subtitle: missingLabel(missing) })
    await renderPng(browser, sheet.html, path.join(out, 'contact-sheet.png'), { width: sheet.width, height: sheet.height, check: false })
  } finally {
    await browser.close()
  }
  await writeFile(path.join(out, 'caption.txt'), buildBetaCaption({ missing }))
  if (problems.length) { console.warn('! layout warnings (check these slides):'); for (const prob of problems) console.warn(`  ${prob}`) }
  console.log(`-> ${path.relative(process.cwd(), out) || '.'}/ (review contact-sheet.png, story.png and caption.txt before posting)`)
  if (problems.some((prob) => prob.includes('outside the safe margin'))) process.exitCode = 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`beta: ${err.message}`)
    process.exit(1)
  })
}
