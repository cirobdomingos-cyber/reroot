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

test('the tab bar carries exactly the four screens it should, in order', async ({ page }) => {
  await page.goto('/#/events')
  const labels = await page.locator('.bottom-nav .nav-item__label').allTextContents()
  // Admin only renders for a signed-in founder; these tests are signed out.
  //
  // Notificações sits near the end: it's where you go when the badge
  // says to, not somewhere you browse. Perfil keeps the last slot,
  // which is where every other app puts it.
  expect(labels).toEqual(['Eventos', 'Comunidade', 'Notificações', 'Perfil'])
})

test('no tab label clips on a narrow phone', async ({ page }) => {
  // "NOTIFICAÇÕES" is 12 characters against a 90px slot at 360px, which
  // is where it clipped to "NOTIFICAÇÕ" before the tracking on long
  // labels was tightened. 360px is a real device width (iPhone SE and
  // most budget Androids), not a hypothetical.
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/#/events')
  await expect(page.locator('.bottom-nav')).toBeVisible()

  const clipped = await page.locator('.bottom-nav .nav-item__label').evaluateAll(
    els => els.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent),
  )
  expect(clipped, 'labels wider than their slot').toEqual([])
})

// The Canais tab has to explain the word before the list uses it. The
// same noun covers an auê-curated feed and a private crew since the
// Sep 2026 rename, and someone landing cold can't tell them apart from
// the rows alone — they look similar by design.
test('the Canais tab explains what a canal is to someone landing on it', async ({ page }) => {
  await page.goto('/#/community')
  await page.waitForTimeout(1200)

  await expect(page.getByText('O que é um canal')).toBeVisible()
  // Both kinds named, because the difference is the whole confusion.
  // "Canais do auê" appears twice by design — once explaining the kind,
  // once as the section heading over the list itself.
  await expect(page.getByText('Canais do auê', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Seus canais', { exact: true })).toBeVisible()

  // The section used to render nothing at all when there were no
  // channels, which hid the concept from exactly the people meeting it
  // for the first time.
  await expect(page.getByText(/Ainda não tem canal nosso no ar/)).toBeVisible()
})

test('the landing copy does not stack sign-in prompts', async ({ page }) => {
  // Three asks down one screen reads as a paywall. The explainer
  // deliberately carries none — the lists below already do.
  await page.goto('/#/community')
  await page.waitForTimeout(1200)
  const prompts = await page.getByText(/Entr[ae] com/i).count()
  expect(prompts).toBeLessThanOrEqual(1)
})
