import { test, expect } from '@playwright/test'

// Smoke: every main screen renders at phone, tablet and PC width without a
// crash, with the right navigation for the layout, and without anything
// wider than the screen.
//
// The backend is unreachable on purpose: API calls are aborted, so these
// tests also hold the offline-first contract (CLAUDE.md) — a screen must
// degrade, not throw, when Railway is down.

const SCREENS = [
  { name: 'Home', path: '/#/home' },
  { name: 'Eventos', path: '/#/events' },
  { name: 'Avisos', path: '/#/notifications' },
  { name: 'Comunidade', path: '/#/community' },
  { name: 'RSVPs', path: '/#/my-rsvps' },
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
