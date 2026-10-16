#!/usr/bin/env node
// Render the "canais" Instagram carousel for @auecuritiba: a cover, one
// slide per public auê channel with a few of its events in the window, and
// the closing "Baixa o auê" slide.
//
// Renders files for a human to review; it never publishes anything.
//
//   node scripts/social/channels.mjs                        # the coming Fri..Sun
//   node scripts/social/channels.mjs --from 2026-10-16 --to 2026-10-18
//   node scripts/social/channels.mjs --exclude <event id>,<event id>
//
// Output in social/out/channels-<from>/ (gitignored). See docs/SOCIAL.md.

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { comingWeekend, addDays, spanOf } from './select.mjs'
import { selectChannels } from './channel-select.mjs'
import { channelCoverSlide, channelSlide, moreChannelsSlide, buildChannelCaption, moreLabel } from './channel-slides.mjs'
import { closingSlide, contactSheet } from './slides.mjs'
import { timeLabel, shortDay } from './format.mjs'
import { ROOT, loadFontCss, launchChromium, renderPng } from './render.mjs'

const todayInCuritiba = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      api: { type: 'string', default: 'https://auecuritiba.com' },
      out: { type: 'string' },
      exclude: { type: 'string', default: '' },
      'per-channel': { type: 'string', default: '3' },
      order: { type: 'string', default: '' },
      featured: { type: 'string', default: '0' },
      first: { type: 'string', default: '' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log('Usage: channels.mjs [--from YYYY-MM-DD --to YYYY-MM-DD] [--api URL] [--out dir] [--exclude id,id] [--per-channel 3] [--order "MPB & Jazz,Rock"] [--featured 4] [--first <event id>,...]')
    process.exit(0)
  }
  const week = comingWeekend(todayInCuritiba())
  const from = values.from || week.from
  const to = values.to || (values.from ? addDays(values.from, 2) : week.to)
  const perChannel = Number.parseInt(values['per-channel'], 10)
  if (!Number.isInteger(perChannel) || perChannel < 1 || perChannel > 4) throw new Error('--per-channel must be 1..4 (more does not fit a slide)')
  return {
    from, to, perChannel,
    api: values.api.replace(/\/+$/, ''),
    out: path.resolve(values.out || path.join(ROOT, 'social', 'out', `channels-${from}`)),
    excludeIds: values.exclude.split(',').map((s) => s.trim()).filter(Boolean),
    // Channel titles to show first, in this order; the rest keep theirs.
    order: values.order.split(',').map((s) => s.trim()).filter(Boolean),
    // How many channels get a slide of their own; the rest share one
    // "Mais canais" slide. 0 = every channel gets its own.
    featured: Number.parseInt(values.featured, 10) || 0,
    // Events to list first on their channel's slide (by event id).
    firstIds: values.first.split(',').map((s) => s.trim()).filter(Boolean),
  }
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

async function main() {
  const opts = parseCli(process.argv.slice(2))
  const { channels } = await getJson(`${opts.api}/channels`)
  const details = await Promise.all(channels.filter((c) => c.visibility !== 'private').map((c) => getJson(`${opts.api}/channels/${c.id}`)))
  const { slides, skipped } = selectChannels(details, { from: opts.from, to: opts.to, excludeIds: opts.excludeIds, perChannel: opts.perChannel })
  if (!slides.length) throw new Error(`no channel has events for ${opts.from}..${opts.to}`)
  for (const t of opts.order) if (!slides.some((s) => s.title === t)) console.warn(`! --order: no slide titled "${t}"`)
  const rank = (s) => { const i = opts.order.indexOf(s.title); return i < 0 ? opts.order.length : i }
  slides.sort((a, b) => rank(a) - rank(b))
  for (const id of opts.firstIds) {
    const slide = slides.find((s) => s.picks.some((e) => e.id === id))
    if (!slide) { console.warn(`! --first: ${id} is not on any slide`); continue }
    slide.picks.sort((a, b) => (b.id === id) - (a.id === id))
  }
  const featured = opts.featured > 0 && opts.featured < slides.length - 1 ? slides.slice(0, opts.featured) : slides
  const more = featured === slides ? [] : slides.slice(opts.featured)

  await mkdir(opts.out, { recursive: true })
  for (const f of await readdir(opts.out)) if (/\.png$/.test(f)) await unlink(path.join(opts.out, f))

  const fontCss = await loadFontCss()
  const iconFile = path.join(ROOT, 'public', 'icon-192x192.png')
  const icon = existsSync(iconFile) ? `data:image/png;base64,${(await readFile(iconFile)).toString('base64')}` : null
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const total = featured.length + (more.length ? 1 : 0)
  const pages = [
    { name: '01-capa.png', label: 'capa', html: channelCoverSlide({ fontCss, from: opts.from, to: opts.to, slides, icon }) },
    ...featured.map((slide, i) => ({
      name: `${String(i + 2).padStart(2, '0')}-${slug(slide.title)}.png`,
      label: `${i + 1}/${total} ${slide.title}`,
      html: channelSlide({ fontCss, slide, index: i + 1, total }),
    })),
    ...(more.length ? [{
      name: `${String(featured.length + 2).padStart(2, '0')}-mais-canais.png`,
      label: `${total}/${total} mais canais`,
      html: moreChannelsSlide({ fontCss, slides: more, index: total, total }),
    }] : []),
    { name: `${String(total + 2).padStart(2, '0')}-baixa.png`, label: 'fechamento', html: closingSlide({ fontCss, from: opts.from, to: opts.to, icon }) },
  ]

  const browser = await launchChromium()
  const problems = []
  try {
    for (const p of pages) {
      const file = path.join(opts.out, p.name)
      for (const msg of await renderPng(browser, p.html, file)) problems.push(`${p.name}: ${msg}`)
      p.src = `data:image/png;base64,${(await readFile(file)).toString('base64')}`
    }
    const sheet = contactSheet({ fontCss, slides: pages, from: opts.from, to: opts.to, title: 'Canais do auê' })
    await renderPng(browser, sheet.html, path.join(opts.out, 'contact-sheet.png'), { width: sheet.width, height: sheet.height, check: false })
  } finally {
    await browser.close()
  }

  await writeFile(path.join(opts.out, 'caption.txt'), buildChannelCaption(featured, opts.from, opts.to, more))
  await writeFile(path.join(opts.out, 'picks.json'), `${JSON.stringify({
    window: { from: opts.from, to: opts.to },
    source: `${opts.api}/channels`,
    excluded: opts.excludeIds,
    skipped,
    slides: slides.map((s, i) => ({
      slide: i < featured.length ? pages[i + 1].name : pages[featured.length + 1].name,
      channel: s.channel.id,
      title: s.title,
      total: s.total,
      more: moreLabel(s),
      picks: s.picks.map((e) => ({ id: e.id, name: e.name, when: [shortDay(spanOf(e).start), timeLabel(e)].filter(Boolean).join(' '), venue: e.venue, igHandle: e.igHandle, url: e.url })),
    })),
    problems,
  }, null, 2)}\n`)

  console.log(`${opts.from}..${opts.to}: ${slides.length} channel slides from ${opts.api}`)
  for (const s of slides) {
    console.log(`  ${s.title} (${moreLabel(s)})`)
    for (const e of s.picks) console.log(`    ${e.id}  ${e.name} @${e.igHandle}`)
  }
  for (const s of skipped) console.log(`  skipped ${s.title}: ${s.reason}`)
  if (problems.length) { console.warn('! layout warnings (check these slides):'); for (const p of problems) console.warn(`  ${p}`) }
  console.log(`-> ${path.relative(process.cwd(), opts.out) || '.'}/ (review contact-sheet.png and caption.txt before posting)`)
  if (problems.some((p) => p.includes('outside the safe margin'))) process.exitCode = 2
}

main().catch((err) => {
  console.error(`channels: ${err.message}`)
  process.exit(1)
})
