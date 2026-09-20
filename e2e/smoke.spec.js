import { test, expect } from '@playwright/test'

// Smoke: every main screen renders at phone, tablet and PC width without a
// crash, with the right navigation for the layout, and without anything
// wider than the screen.
//
// The backend is unreachable on purpose: API calls are aborted, so these
// tests also hold the offline-first contract (CLAUDE.md) — a screen must
// degrade, not throw, when Railway is down.

const SCREENS = [
  { name: 'Eventos', path: '/#/events' },
  { name: 'Avisos', path: '/#/notifications' },
  { name: 'Comunidade', path: '/#/community' },
  { name: 'Meus rolês', path: '/#/my-rsvps' },
  { name: 'Perfil', path: '/#/profile' },
  { name: 'Fontes', path: '/#/sources' },
]

const PAGE_RESOURCES = new Set(['document', 'script', 'stylesheet', 'image', 'font', 'manifest'])

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route =>
    PAGE_RESOURCES.has(route.request().resourceType()) ? route.continue() : route.abort(),
  )
})

for (const screen of SCREENS) {
  test(`${screen.name} renders`, async ({ page }, testInfo) => {
    const crashes = []
    page.on('pageerror', err => crashes.push(err.message))

    await page.goto(screen.path)
    await expect(page.locator('.bottom-nav')).toBeVisible()
    // Let the backend calls fail and the screen settle.
    await page.waitForTimeout(1500)

    expect(crashes, 'uncaught errors on the page').toEqual([])

    const nav = await page.locator('.bottom-nav').boundingBox()
    const viewport = page.viewportSize()
    if (testInfo.project.name === 'pc') {
      // Left sidebar with the wordmark, full height.
      expect(nav.x).toBeLessThan(10)
      expect(nav.height).toBeGreaterThan(viewport.height * 0.9)
      await expect(page.locator('.nav-brand')).toBeVisible()
    } else {
      // Tab bar along the bottom.
      expect(nav.y + nav.height).toBeGreaterThan(viewport.height - 20)
      await expect(page.locator('.nav-brand')).toHaveCount(0)
    }

    const overflow = await page.evaluate(() => {
      const el = document.querySelector('.screen')
      return el ? el.scrollWidth - el.clientWidth : 0
    })
    expect(overflow, 'content wider than the screen').toBeLessThanOrEqual(1)

    await page.screenshot({ path: testInfo.outputPath(`${screen.name}.png`), fullPage: false })
  })
}

// Where the app opens, and what happens to the old start screen.
//
// Home dissolved in Sep 2026: people opened the app wanting the
// catalog and went to community second. /#/home stays as a redirect
// rather than a 404 because it's the old start screen — it's in
// bookmarks, in push deep links sent before the change, and in any
// bundle a phone hasn't updated past.
test('a returning visitor opens on Eventos', async ({ page, baseURL }) => {
  // `/` is the onboarding gate for someone who has never joined, so
  // seed the flag the app persists — otherwise this would assert that
  // a brand-new visitor skips onboarding, which is the opposite of
  // what should happen.
  await page.goto(baseURL)
  await page.evaluate(() =>
    localStorage.setItem('aue_state', JSON.stringify({ hasJoined: true })))
  await page.goto('/')
  await expect(page.locator('.bottom-nav')).toBeVisible()
  await expect(page).toHaveURL(/#\/events/)
})

test('a brand-new visitor still gets onboarding, not the catalog', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.bottom-nav')).toHaveCount(0)
})

test('the old /home route still lands somewhere real', async ({ page }) => {
  await page.goto('/#/home')
  await expect(page.locator('.bottom-nav')).toBeVisible()
  await expect(page).toHaveURL(/#\/events/)
})

test('the tab bar carries exactly the four screens it should', async ({ page }) => {
  await page.goto('/#/events')
  const labels = await page.locator('.bottom-nav .nav-item__label').allTextContents()
  // Admin only renders for a signed-in founder; these tests are signed out.
  expect(labels).toEqual(['Eventos', 'Avisos', 'Comunidade', 'Perfil'])
})
