import { test, expect } from '@playwright/test'

// Your photo, on every screen — as the Perfil tab in the nav.
//
// It used to float fixed in the top-right corner of every screen, which
// is exactly where every screen puts its header buttons: on Eventos it
// sat on top of 🔍. The nav is the one place no screen draws on, so the
// photo lives there now, and the guard below is the bug itself: nothing
// may sit on top of a screen's header buttons.

async function open(page, { signedIn, path }) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/events?**', route => route.fulfill({ json: { events: [] } }))
  await page.route('**/channels/feed**', route => route.fulfill({ json: { events: [] } }))
  await page.route('**/events/group**', route => route.fulfill({ json: { events: [] } }))
  await page.route('**/admin/curators**', route => route.fulfill({ json: { curators: [], is_curator: false, is_founder: false } }))
  await page.addInitScript((signedIn) =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true,
      googleUser: signedIn ? { id: 'u1', email: 'a@b.com', name: 'Ana Lima', givenName: 'Ana' } : null,
    })), signedIn)
  await page.goto(path)
  await page.waitForTimeout(1200)
}

// Whatever is painted at the centre of `locator` must be the element
// itself (or something inside it). A fixed avatar over a button fails
// this; so would any future floating chrome.
async function expectNothingCovers(page, locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  const covered = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    return el ? el.outerHTML.slice(0, 120) : 'nothing'
  }, [box.x + box.width / 2, box.y + box.height / 2])
  const isSelf = await locator.evaluate((el, [x, y]) => {
    const hit = document.elementFromPoint(x, y)
    return !!hit && (hit === el || el.contains(hit))
  }, [box.x + box.width / 2, box.y + box.height / 2])
  expect(isSelf, `something covers the button: ${covered}`).toBe(true)
}

test('the photo is the Perfil tab on Eventos', async ({ page }) => {
  await open(page, { signedIn: true, path: '/#/events' })
  await expect(page.getByTestId('avatar-nav')).toBeVisible()
})

test('and on Comunidade — it rides the nav, not a screen', async ({ page }) => {
  await open(page, { signedIn: true, path: '/#/community' })
  await expect(page.getByTestId('avatar-nav')).toBeVisible()
})

test('tapping it opens Perfil, where "Trocar foto" is', async ({ page }) => {
  await open(page, { signedIn: true, path: '/#/events' })
  await page.getByTestId('avatar-nav').click()
  await expect(page).toHaveURL(/#\/profile/)
  await expect(page.getByLabel('Trocar foto').first()).toBeVisible()
})

test('nothing sits on top of the Eventos header buttons', async ({ page }) => {
  await open(page, { signedIn: true, path: '/#/events' })
  await expectNothingCovers(page, page.getByRole('button', { name: '🔍' }))
  await expectNothingCovers(page, page.getByRole('button', { name: /Fontes/ }))
})

test('signed out, the tab is the plain icon — there is no photo to be yours', async ({ page }) => {
  await open(page, { signedIn: false, path: '/#/events' })
  await expect(page.getByTestId('avatar-nav')).toHaveCount(0)
})
