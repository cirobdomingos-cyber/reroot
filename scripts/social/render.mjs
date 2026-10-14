// Shared rendering for the @auecuritiba carousels: Google Fonts inlined into
// the slide HTML, a Chromium that works with the installed browsers, and the
// PNG render with the text-fit and safe-margin check.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIDTH, HEIGHT } from './slides.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@500&display=swap'
// Google serves woff2 only to a browser user agent.
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'


/** Google Fonts CSS with every font file inlined, cached so a re-run works offline. */
export async function loadFontCss() {
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

export async function launchChromium() {
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

export async function renderPng(browser, html, file, { width = WIDTH, height = HEIGHT, check = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const problems = check ? await page.evaluate(fitAndCheck) : []
  await page.screenshot({ path: file, type: 'png' })
  await page.close()
  return problems
}
