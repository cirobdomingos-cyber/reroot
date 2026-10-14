#!/usr/bin/env node
// Render the "Rola esse fim de semana em Curitiba" Instagram carousel for
// @auecuritiba from the public events feed.
//
// Renders files for a human to review; it never publishes anything.
//
//   node scripts/social/weekend-list.mjs                       # the coming Fri..Sun
//   node scripts/social/weekend-list.mjs --from 2026-10-16 --to 2026-10-18
//   node scripts/social/weekend-list.mjs --input feed.json --no-images
//
// Output in social/out/<from>/ (gitignored): 01-capa.png, 02..NN event
// slides, the closing slide, caption.txt, picks.json, contact-sheet.png.
// See docs/SOCIAL.md for what to check before posting.

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { selectWeekend, comingWeekend, addDays } from './select.mjs'
import { buildCaption, whenLabel, priceLabel, pitchLine } from './format.mjs'
import { coverSlide, eventSlide, closingSlide, contactSheet, WIDTH, HEIGHT } from './slides.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@500&display=swap'
// Google serves woff2 only to a browser user agent.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function todayInCuritiba() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      api: { type: 'string', default: 'https://auecuritiba.com' },
      input: { type: 'string' },
      count: { type: 'string', default: '7' },
      out: { type: 'string' },
      'no-images': { type: 'boolean', default: false },
      exclude: { type: 'string', default: '' },
      pick: { type: 'string', default: '' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log('Usage: weekend-list.mjs [--from YYYY-MM-DD --to YYYY-MM-DD] [--api URL | --input file.json] [--count 7] [--out dir] [--no-images] [--exclude id,id] [--pick id,id]')
    process.exit(0)
  }
  const week = comingWeekend(todayInCuritiba())
  const from = values.from || week.from
  // --from alone means that Friday's weekend: from + 2 days.
  const to = values.to || (values.from ? addDays(values.from, 2) : week.to)
  const count = Number.parseInt(values.count, 10)
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('--count must be 1..8 (a carousel holds 10 slides: cover + picks + closing)')
  return {
    from,
    to,
    api: values.api.replace(/\/+$/, ''),
    input: values.input,
    count,
    out: path.resolve(values.out || path.join(ROOT, 'social', 'out', from)),
    images: !values['no-images'],
    excludeIds: values.exclude.split(',').map((s) => s.trim()).filter(Boolean),
    pinIds: values.pick.split(',').map((s) => s.trim()).filter(Boolean),
  }
}

async function loadFeed({ input, api }) {
  if (input) return { source: path.resolve(input), feed: JSON.parse(await readFile(input, 'utf8')) }
  const url = `${api}/events?limit=300`
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return { source: url, feed: await res.json() }
}

/** Google Fonts CSS with every font file inlined, cached so a re-run works offline. */
async function loadFontCss() {
  const cache = path.join(ROOT, 'social', 'out', '.cache', 'fonts.css')
  if (existsSync(cache)) return readFile(cache, 'utf8')
  try {
    let css = await (await fetch(FONT_CSS_URL, { headers: { 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) })).text()
    // Keep the latin and latin-ext subsets (pt-BR needs both: ê, ç, ã).
    css = css.replace(/\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{[^}]*\}/g, (block, subset) => (['latin', 'latin-ext'].includes(subset) ? block : ''))
    const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))]
    for (const u of urls) {
      const buf = Buffer.from(await (await fetch(u, { signal: AbortSignal.timeout(20000) })).arrayBuffer())
      const type = u.endsWith('.woff2') ? 'font/woff2' : 'font/ttf'
      css = css.split(u).join(`data:${type};base64,${buf.toString('base64')}`)
    }
    await mkdir(path.dirname(cache), { recursive: true })
    await writeFile(cache, css)
    return css
  } catch (err) {
    console.warn(`! fonts: could not load Google Fonts (${err.message}); slides fall back to system fonts and will not match the app`)
    return ''
  }
}

async function loadThumb(api, imageUrl) {
  if (!imageUrl) return null
  const url = /^https?:/.test(imageUrl) ? imageUrl : `${api}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const input = Buffer.from(await res.arrayBuffer())
    const { default: sharp } = await import('sharp')
    const jpg = await sharp(input).resize(264, 264, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer()
    return `data:image/jpeg;base64,${jpg.toString('base64')}`
  } catch (err) {
    console.warn(`! image ${url}: ${err.message} (slide renders without a thumbnail)`)
    return null
  }
}

async function launchChromium() {
  const { chromium } = await import('@playwright/test')
  try {
    return await chromium.launch()
  } catch (err) {
    // The installed browsers may be an older revision than this Playwright
    // expects (e.g. a shared /opt/pw-browsers); any recent Chromium renders this.
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
    const candidates = [process.env.CHROMIUM_PATH, path.join(base, 'chromium')]
    if (existsSync(base)) {
      for (const dir of (await readdir(base)).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        candidates.push(path.join(base, dir, 'chrome-linux', 'chrome'))
      }
    }
    const exe = candidates.find((c) => c && existsSync(c))
    if (!exe) throw err
    return chromium.launch({ executablePath: exe })
  }
}

/* global document, getComputedStyle -- fitAndCheck runs inside the page, not in Node */
// Runs in the page: shrink [data-shrink] text until it fits its line clamp,
// then report anything clamped or spilling past the safe margin.
function fitAndCheck() {
  const problems = []
  const unclampedHeight = (el) => {
    const keep = [el.style.webkitLineClamp, el.style.maxHeight, el.style.display]
    el.style.webkitLineClamp = 'unset'; el.style.maxHeight = 'none'; el.style.display = 'block'
    const h = el.getBoundingClientRect().height
    ;[el.style.webkitLineClamp, el.style.maxHeight, el.style.display] = keep
    return h
  }
  for (const el of document.querySelectorAll('[data-shrink]')) {
    let size = parseFloat(getComputedStyle(el).fontSize)
    const lineFactor = parseFloat(getComputedStyle(el).lineHeight) / size
    while (size > 60 && unclampedHeight(el) > size * lineFactor * 3.05) {
      size -= 4
      el.style.fontSize = `${size}px`
      el.style.maxHeight = `${Math.round(size * lineFactor * 4) + 6}px`
    }
  }
  for (const el of document.querySelectorAll('[data-fit]')) {
    const clamped = unclampedHeight(el) > el.getBoundingClientRect().height + 2 || el.scrollWidth > el.clientWidth + 2
    if (clamped) problems.push(`clamped: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 50)}"`)
  }
  const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight
  for (const el of document.querySelectorAll('.slide *')) {
    const r = el.getBoundingClientRect()
    if (r.width && (r.right > W - 40 || r.bottom > H - 40 || r.left < 40)) problems.push(`outside the safe margin: ${el.className || el.tagName}`)
  }
  return problems
}

async function renderPng(browser, html, file, { width = WIDTH, height = HEIGHT, check = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const problems = check ? await page.evaluate(fitAndCheck) : []
  await page.screenshot({ path: file, type: 'png' })
  await page.close()
  return problems
}

async function main() {
  const opts = parseCli(process.argv.slice(2))
  let loaded
  try {
    loaded = await loadFeed(opts)
  } catch (err) {
    throw new Error(`could not load the feed (${err.message}); pass --input <file.json> to run offline`)
  }
  const events = Array.isArray(loaded.feed) ? loaded.feed : loaded.feed.events || []
  const { picks, considered, rejected } = selectWeekend(events, { from: opts.from, to: opts.to, count: opts.count, excludeIds: opts.excludeIds, pinIds: opts.pinIds })
  if (!picks.length) throw new Error(`no events for ${opts.from}..${opts.to} in ${loaded.source}`)
  if (picks.length < opts.count) console.warn(`! only ${picks.length} of ${opts.count} picks after the caps`)

  await mkdir(opts.out, { recursive: true })
  for (const f of await readdir(opts.out)) if (/\.png$/.test(f)) await unlink(path.join(opts.out, f))

  const fontCss = await loadFontCss()
  const api = opts.input && !process.argv.includes('--api') ? 'https://auecuritiba.com' : opts.api
  const thumbs = opts.images ? await Promise.all(picks.map((p) => loadThumb(api, p.event.imageUrl))) : picks.map(() => null)
  const iconFile = path.join(ROOT, 'public', 'icon-192x192.png')
  const icon = existsSync(iconFile) ? `data:image/png;base64,${(await readFile(iconFile)).toString('base64')}` : null

  const total = picks.length
  const slides = [
    { name: '01-capa.png', label: 'capa', html: coverSlide({ fontCss, from: opts.from, to: opts.to, picks }) },
    ...picks.map((pick, i) => ({
      name: `${String(i + 2).padStart(2, '0')}-${(pick.event.igHandle || 'evento').replace(/[^a-z0-9]+/gi, '-')}.png`,
      label: `${i + 1}/${total} @${pick.event.igHandle}`,
      html: eventSlide({ fontCss, pick, index: i + 1, total, from: opts.from, to: opts.to, image: thumbs[i] }),
    })),
    { name: `${String(total + 2).padStart(2, '0')}-android.png`, label: 'fechamento', html: closingSlide({ fontCss, from: opts.from, to: opts.to, icon }) },
  ]

  const browser = await launchChromium()
  const problems = []
  try {
    for (const s of slides) {
      const file = path.join(opts.out, s.name)
      for (const p of await renderPng(browser, s.html, file)) problems.push(`${s.name}: ${p}`)
      s.src = `data:image/png;base64,${(await readFile(file)).toString('base64')}`
    }
    const sheet = contactSheet({ fontCss, slides, from: opts.from, to: opts.to })
    await renderPng(browser, sheet.html, path.join(opts.out, 'contact-sheet.png'), { width: sheet.width, height: sheet.height, check: false })
  } finally {
    await browser.close()
  }

  await writeFile(path.join(opts.out, 'caption.txt'), buildCaption(picks, opts.from, opts.to))
  await writeFile(path.join(opts.out, 'picks.json'), `${JSON.stringify({
    window: { from: opts.from, to: opts.to },
    source: loaded.source,
    considered,
    rejected,
    images: opts.images,
    picks: picks.map(({ event, day, score, reasons }, i) => ({
      slide: slides[i + 1].name,
      id: event.id,
      name: event.name,
      day,
      when: whenLabel(event, opts.from, opts.to),
      venue: event.venue,
      igHandle: event.igHandle,
      price: priceLabel(event),
      line: pitchLine(event),
      url: event.url,
      score,
      reasons,
    })),
    problems,
  }, null, 2)}\n`)

  console.log(`${opts.from}..${opts.to}: ${considered} candidates, ${picks.length} picks from ${loaded.source}`)
  for (const { event } of picks) console.log(`  ${whenLabel(event, opts.from, opts.to).padEnd(22)} ${event.name} @${event.igHandle}`)
  if (problems.length) { console.warn('! layout warnings (check these slides):'); for (const p of problems) console.warn(`  ${p}`) }
  console.log(`-> ${path.relative(process.cwd(), opts.out) || '.'}/ (review contact-sheet.png and caption.txt before posting)`)
  // Clamped text is cut with an ellipsis (a warning to read); anything past
  // the safe margin is a broken slide.
  if (problems.some((p) => p.includes('outside the safe margin'))) process.exitCode = 2
}

main().catch((err) => {
  console.error(`weekend-list: ${err.message}`)
  process.exit(1)
})
