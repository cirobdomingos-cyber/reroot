import { test, expect } from '@playwright/test'

// Link preview (Open Graph + Twitter card).
//
// These tags are the only part of the app nobody on the team ever sees:
// they render in someone else's WhatsApp. Before they existed, a shared
// auê link unfurled as a bare URL — which is why sharing the App Store
// link seemed better, and that one is worse (Apple forces "au%C3%AA"
// into the slug and the card shows that string).
//
// Nothing in the app reads them, so nothing else would notice if a
// refactor dropped them or made og:image relative. Unfurlers don't
// resolve relative image URLs, and they don't run JavaScript either —
// so this asserts against the served HTML, not the rendered DOM.

const REQUIRED = [
  ['og:type', 'website'],
  ['og:site_name', 'auê'],
  ['og:locale', 'pt_BR'],
  ['og:image:width', '1200'],
  ['og:image:height', '630'],
]

function metaContent(html, key) {
  // Match property= (OG) or name= (Twitter), attribute order either way.
  const pattern = new RegExp(
    `<meta[^>]*(?:property|name)=["']${key.replace(/[:]/g, '\\:')}["'][^>]*>`,
    'i',
  )
  const tag = html.match(pattern)?.[0]
  return tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? null
}

test('the page advertises a link preview', async ({ request, baseURL }) => {
  const html = await (await request.get(baseURL)).text()

  for (const [key, expected] of REQUIRED) {
    expect(metaContent(html, key), `${key} missing or wrong`).toBe(expected)
  }

  for (const key of ['og:title', 'og:description', 'twitter:title', 'twitter:description']) {
    expect(metaContent(html, key)?.length, `${key} is empty`).toBeGreaterThan(10)
  }

  // summary_large_image is what turns the card from a thumbnail strip
  // into the full-width image — the whole point of shipping a 1200×630.
  expect(metaContent(html, 'twitter:card')).toBe('summary_large_image')
})

test('image and url are absolute, since unfurlers do not resolve relative ones', async ({ request, baseURL }) => {
  const html = await (await request.get(baseURL)).text()

  for (const key of ['og:url', 'og:image', 'twitter:image']) {
    const value = metaContent(html, key)
    expect(value, `${key} must be absolute`).toMatch(/^https:\/\//)
  }
})

test('the preview image is actually served', async ({ request, baseURL }) => {
  const html = await (await request.get(baseURL)).text()
  const src = metaContent(html, 'og:image')

  // The tag points at the canonical origin, but the file has to exist
  // wherever this build is served from — that's what would break if the
  // asset stopped being emitted into dist.
  const path = new URL(src).pathname
  const res = await request.get(new URL(path, baseURL).toString())

  expect(res.status(), `${path} is not being served`).toBe(200)
  expect(res.headers()['content-type']).toContain('image/png')
  // A card that renders as a broken image is worse than no card. Guard
  // against the asset being emitted as a zero-byte or placeholder file.
  expect((await res.body()).length).toBeGreaterThan(10_000)
})
