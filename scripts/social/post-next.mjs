#!/usr/bin/env node
/**
 * Publishes the next queued @auecuritiba carousel. Runs as the Railway cron service
 * `social-poster` (project auê), so no chat session has to be open at post time.
 * Ported from template-niche-brand (scripts/post-next.mjs, 2026-10-21), carousels only.
 *
 * Grain: one run = at most one post. Stateless and idempotent: it reads the profile's recent
 * captions, treats a queue item as published when a caption starts with that item's first
 * caption line, and publishes the first due item that is not there yet. Re-running never posts
 * twice; an exhausted queue is a no-op.
 *
 * Content lives on the `social-assets` branch (never merged), read over SOCIAL_BASE, so a new
 * post is a push to that branch, not a release of the app:
 *   <base>/queue.json          ordered items
 *   <base>/<folder>/<slide>    JPEG slides, fetched by Instagram from the same URL
 *   <base>/<folder>/caption.txt
 * An item:
 *   {"folder": "2026-10-22-beta", "slides": ["01-capa.jpg", ...],
 *    "tags": {"02-x.jpg": "venuehandle"},          optional: tag that profile on that slide
 *    "not_before": "2026-10-22T21:00:00Z",         optional: held until then
 *    "not_after": "2026-10-25T03:00:00Z"}          optional: skipped once past (a weekend list
 *                                                  posted on Monday is worse than none)
 *
 * Env:
 *   COMPOSIO_CONSUMER_KEY, COMPOSIO_ACCOUNT  see composio-mcp.mjs
 *   IG_USER_ID      numeric id of @auecuritiba; the run refuses when the connection is another profile
 *   SOCIAL_BASE     default https://raw.githubusercontent.com/cirobdomingos-cyber/reroot/social-assets
 *
 *   node scripts/social/post-next.mjs [--dry-run | --plan] [--now <iso>]
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTool } from './composio-mcp.mjs'

export const DEFAULT_BASE = 'https://raw.githubusercontent.com/cirobdomingos-cyber/reroot/social-assets'
// Where the venue tag sits on a slide: on the "@handle" credit card near the bottom.
const TAG_X = 0.5
const TAG_Y = 0.72

export function firstLine(text) {
  return (String(text ?? '').split('\n').find((l) => l.trim()) ?? '').trim()
}

/**
 * Whether each queue item is on the profile already. The nth item whose caption starts with a
 * given first line is published once n posts on the profile start with it. Pure.
 */
export function publishedFlags(firsts, posted) {
  const seen = new Map()
  return firsts.map((first) => {
    const n = (seen.get(first) ?? 0) + 1
    seen.set(first, n)
    return posted.filter((p) => p.startsWith(first)).length >= n
  })
}

/** Queue entries validated: folder and 2-10 slides, readable times, tags only on listed slides. */
export function parseQueue(raw) {
  if (!Array.isArray(raw)) throw new Error('queue.json must be an array')
  return raw.map((it) => {
    if (!it?.folder || !Array.isArray(it.slides)) throw new Error(`queue item needs folder and slides: ${JSON.stringify(it)}`)
    if (it.slides.length < 2 || it.slides.length > 10) throw new Error(`${it.folder}: a carousel takes 2 to 10 slides, got ${it.slides.length}`)
    for (const k of ['not_before', 'not_after']) {
      if (it[k] !== undefined && Number.isNaN(Date.parse(it[k]))) throw new Error(`${it.folder}: unreadable ${k} ${it[k]}`)
    }
    const tags = it.tags ?? {}
    for (const slide of Object.keys(tags)) {
      if (!it.slides.includes(slide)) throw new Error(`${it.folder}: tag on ${slide}, which is not one of its slides`)
    }
    return { folder: it.folder, slides: it.slides, tags, not_before: it.not_before, not_after: it.not_after }
  })
}

/** Due state of an item at `now`: held (before not_before), expired (after not_after) or due. */
export function dueState(item, now) {
  if (item.not_before && new Date(item.not_before) > now) return 'held'
  if (item.not_after && new Date(item.not_after) < now) return 'expired'
  return 'due'
}

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`)
  return res.text()
}

/** The queue with each item's caption, read from the content branch. */
export async function loadQueue(base, fetchImpl = fetch) {
  const items = parseQueue(JSON.parse(await fetchText(`${base}/queue.json`, fetchImpl)))
  for (const it of items) it.caption = await fetchText(`${base}/${it.folder}/caption.txt`, fetchImpl)
  return items
}

async function postedFirstLines(igUser, run) {
  const data = await run('INSTAGRAM_GET_IG_USER_MEDIA', { ig_user_id: igUser, limit: 100, fields: 'id,caption' })
  return (data.data ?? data.items ?? []).map((m) => firstLine(m.caption ?? '')).filter(Boolean)
}

const idOf = (r) => String(r?.id ?? r?.data?.id ?? '')

/**
 * One run = at most one post: the first queue item not on the profile yet that is due now.
 * Slides with a tag become their own child container (Instagram takes user tags per child);
 * without any tag the carousel is built from the image URLs in one call.
 */
export async function publishNext({ base, igUser, items, run = runTool, log = console.log, now = new Date(), dry = false }) {
  const flags = publishedFlags(items.map((it) => firstLine(it.caption)), await postedFirstLines(igUser, run))
  for (const [i, item] of items.entries()) {
    if (flags[i]) continue
    const state = dueState(item, now)
    if (state !== 'due') { log(`${state}: ${item.folder}${state === 'held' ? ` until ${item.not_before}` : ` since ${item.not_after}`}`); continue }
    const urls = item.slides.map((s) => `${base}/${item.folder}/${s}`)
    log(`next: ${item.folder} (${urls.length} slides, ${Object.keys(item.tags).length} tagged)`)
    if (dry) return { folder: item.folder, dry: true }

    let parent
    if (Object.keys(item.tags).length) {
      const children = []
      for (const [k, slide] of item.slides.entries()) {
        const handle = item.tags[slide]
        const child = await run('INSTAGRAM_POST_IG_USER_MEDIA', {
          ig_user_id: igUser, is_carousel_item: true, image_url: urls[k],
          ...(handle ? { user_tags: [{ username: handle, x: TAG_X, y: TAG_Y }] } : {}),
        })
        children.push(idOf(child))
      }
      parent = await run('INSTAGRAM_CREATE_CAROUSEL_CONTAINER', { ig_user_id: igUser, children, caption: item.caption })
    } else {
      parent = await run('INSTAGRAM_CREATE_CAROUSEL_CONTAINER', { ig_user_id: igUser, child_image_urls: urls, caption: item.caption })
    }
    // PUBLISH waits for the container to finish; it is never retried (composio-mcp.mjs), so a
    // failure here is reported, and the next run's caption check decides whether it went out.
    const post = await run('INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', { ig_user_id: igUser, creation_id: idOf(parent), max_wait_seconds: 120 })
    log(`published ${item.folder}: media ${idOf(post)}`)
    return { folder: item.folder, media: idOf(post) }
  }
  log('nothing due: every queued post is on the profile, held or expired')
  return null
}

/** Every queued post with its state, for a person to read before trusting the cron. */
export function planLines(items, flags, now) {
  return items.map((it, i) => {
    const state = flags[i] ? 'published' : dueState(it, now)
    const when = it.not_before ? new Date(it.not_before).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'next run'
    return `${state.padEnd(10)} ${when.padEnd(18)} ${it.folder.padEnd(22)} ${firstLine(it.caption).slice(0, 60)}`
  })
}

function nowArg() {
  const i = process.argv.indexOf('--now')
  if (i < 0) return new Date()
  const d = new Date(process.argv[i + 1])
  if (Number.isNaN(d.getTime())) throw new Error(`--now needs an ISO time, got ${process.argv[i + 1]}`)
  return d
}

async function main() {
  const base = (process.env.SOCIAL_BASE || DEFAULT_BASE).replace(/\/+$/, '')
  const igUser = process.env.IG_USER_ID
  if (!igUser) throw new Error('missing env IG_USER_ID')
  const now = nowArg()
  const items = await loadQueue(base)

  // The connection must BE @auecuritiba: a Composio reconnect made while another profile was
  // logged in silently re-points it (happened on the niche sites, 2026-10-02).
  const me = await runTool('INSTAGRAM_GET_USER_INFO', {})
  if (String(me.id) !== String(igUser)) {
    throw new Error(`connected Instagram is @${me.username} (${me.id}), not IG_USER_ID ${igUser}; reconnect it in Composio before posting`)
  }
  console.log(`account: @${me.username}`)

  if (process.argv.includes('--plan')) {
    const flags = publishedFlags(items.map((it) => firstLine(it.caption)), await postedFirstLines(igUser, runTool))
    for (const line of planLines(items, flags, now)) console.log(line)
    return
  }
  await publishNext({ base, igUser, items, now, dry: process.argv.includes('--dry-run') })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1) })
}
