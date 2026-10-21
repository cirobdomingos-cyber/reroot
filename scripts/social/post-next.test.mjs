import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQueue, publishedFlags, dueState, loadQueue, publishNext } from './post-next.mjs'

const BASE = 'https://assets.test'
const item = (over = {}) => ({ folder: '2026-10-22-beta', slides: ['01.jpg', '02.jpg', '03.jpg'], tags: {}, caption: 'Ajuda o auê a chegar na Play Store 🙏\n\nmais', ...over })

/** A fake Composio: records calls, answers with ids, and lists `posted` captions on the profile. */
function fakeTool(posted = []) {
  const calls = []
  let n = 0
  const run = async (slug, args) => {
    calls.push({ slug, args })
    if (slug === 'INSTAGRAM_GET_IG_USER_MEDIA') return { data: posted.map((caption, i) => ({ id: `m${i}`, caption })) }
    return { id: `${slug}-${++n}` }
  }
  return { run, calls, slugs: () => calls.map((c) => c.slug) }
}

test('the nth item with a caption counts as published once the profile has n posts with it', () => {
  assert.deepEqual(publishedFlags(['A', 'B', 'A'], ['A x', 'B y']), [true, true, false])
  assert.deepEqual(publishedFlags(['A', 'A'], ['A', 'A']), [true, true])
})

test('queue items are validated', () => {
  assert.throws(() => parseQueue({}), /array/)
  assert.throws(() => parseQueue([{ folder: 'x' }]), /folder and slides/)
  assert.throws(() => parseQueue([{ folder: 'x', slides: ['a.jpg'] }]), /2 to 10/)
  assert.throws(() => parseQueue([{ folder: 'x', slides: ['a.jpg', 'b.jpg'], not_before: 'tomorrow' }]), /unreadable not_before/)
  assert.throws(() => parseQueue([{ folder: 'x', slides: ['a.jpg', 'b.jpg'], tags: { 'c.jpg': 'v' } }]), /not one of its slides/)
  assert.equal(parseQueue([{ folder: 'x', slides: ['a.jpg', 'b.jpg'] }])[0].tags.constructor, Object)
})

test('held before not_before, expired after not_after, due in between', () => {
  const it = { not_before: '2026-10-22T21:00:00Z', not_after: '2026-10-25T03:00:00Z' }
  assert.equal(dueState(it, new Date('2026-10-22T20:59:00Z')), 'held')
  assert.equal(dueState(it, new Date('2026-10-22T21:00:00Z')), 'due')
  assert.equal(dueState(it, new Date('2026-10-26T00:00:00Z')), 'expired')
})

test('loadQueue reads the queue and each caption from the content branch', async () => {
  const files = {
    [`${BASE}/queue.json`]: JSON.stringify([{ folder: 'f', slides: ['01.jpg', '02.jpg'] }]),
    [`${BASE}/f/caption.txt`]: 'Legenda\n',
  }
  const fetchImpl = async (url) => ({ ok: url in files, status: url in files ? 200 : 404, text: async () => files[url] })
  const [it] = await loadQueue(BASE, fetchImpl)
  assert.equal(it.caption, 'Legenda\n')
  await assert.rejects(loadQueue('https://nothing.test', fetchImpl), /HTTP 404/)
})

test('an untagged carousel is one container from the image URLs, then publish', async () => {
  const t = fakeTool()
  const out = await publishNext({ base: BASE, igUser: '1', items: [item()], run: t.run, log: () => {} })
  assert.deepEqual(t.slugs(), ['INSTAGRAM_GET_IG_USER_MEDIA', 'INSTAGRAM_CREATE_CAROUSEL_CONTAINER', 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH'])
  assert.deepEqual(t.calls[1].args.child_image_urls, [`${BASE}/2026-10-22-beta/01.jpg`, `${BASE}/2026-10-22-beta/02.jpg`, `${BASE}/2026-10-22-beta/03.jpg`])
  assert.equal(t.calls[2].args.creation_id, 'INSTAGRAM_CREATE_CAROUSEL_CONTAINER-1')
  assert.equal(out.folder, '2026-10-22-beta')
})

test('tagged slides get their venue tag on their own child container, in slide order', async () => {
  const t = fakeTool()
  await publishNext({ base: BASE, igUser: '1', items: [item({ tags: { '02.jpg': 'portalkirin' } })], run: t.run, log: () => {} })
  const kids = t.calls.filter((c) => c.slug === 'INSTAGRAM_POST_IG_USER_MEDIA')
  assert.equal(kids.length, 3)
  assert.equal(kids[0].args.user_tags, undefined)
  assert.deepEqual(kids[1].args.user_tags, [{ username: 'portalkirin', x: 0.5, y: 0.72 }])
  assert.ok(kids.every((k) => k.args.is_carousel_item))
  const parent = t.calls.find((c) => c.slug === 'INSTAGRAM_CREATE_CAROUSEL_CONTAINER')
  assert.deepEqual(parent.args.children, ['INSTAGRAM_POST_IG_USER_MEDIA-1', 'INSTAGRAM_POST_IG_USER_MEDIA-2', 'INSTAGRAM_POST_IG_USER_MEDIA-3'])
})

test('a post already on the profile is never posted again; the next due one goes', async () => {
  const t = fakeTool(['Ajuda o auê a chegar na Play Store 🙏\n\nmais'])
  const out = await publishNext({ base: BASE, igUser: '1', items: [item(), item({ folder: 'b', caption: 'Rola esse fim de semana\n' })], run: t.run, log: () => {} })
  assert.equal(out.folder, 'b')
  assert.equal(t.slugs().filter((s) => s.includes('PUBLISH')).length, 1)
})

test('held and expired items are skipped; nothing due posts nothing', async () => {
  const t = fakeTool()
  const now = new Date('2026-10-22T12:00:00Z')
  const items = [item({ not_before: '2026-10-22T21:00:00Z' }), item({ folder: 'old', caption: 'Velho\n', not_after: '2026-10-20T00:00:00Z' })]
  const lines = []
  assert.equal(await publishNext({ base: BASE, igUser: '1', items, run: t.run, log: (l) => lines.push(l), now }), null)
  assert.deepEqual(t.slugs(), ['INSTAGRAM_GET_IG_USER_MEDIA'])
  assert.match(lines.join('\n'), /held: 2026-10-22-beta[\s\S]*expired: old/)
})

test('--dry-run names the next post and publishes nothing', async () => {
  const t = fakeTool()
  const out = await publishNext({ base: BASE, igUser: '1', items: [item()], run: t.run, log: () => {}, dry: true })
  assert.deepEqual(out, { folder: '2026-10-22-beta', dry: true })
  assert.deepEqual(t.slugs(), ['INSTAGRAM_GET_IG_USER_MEDIA'])
})
