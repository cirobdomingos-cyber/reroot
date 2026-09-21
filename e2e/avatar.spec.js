import { test, expect } from '@playwright/test'

// Your photo, on every screen; tap it to change it. It rides the page
// shell, hides on Perfil (own photo UI) and when signed out.

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

test('the photo is there on Eventos, and it is a button to change it', async ({ page }) => {
  await open(page, { signedIn: true, path: '/#/events' })
  await expect(page.getByTestId('avatar-corner')).toBeVisible()
})

test('and on Comunidade — it rides the shell, not a screen', async ({ page }) => {
  await open(page, { signedIn: true, path: '/#/community' })
  await expect(page.getByTestId('avatar-corner')).toBeVisible()
})

test('not on Perfil, which has its own photo UI', async ({ page }) => {
  // Perfil's own photo button is also called "Trocar foto" — which is
  // right, it's the same action — so the corner is targeted by test id
  // rather than by name.
  await open(page, { signedIn: true, path: '/#/profile' })
  await expect(page.getByTestId('avatar-corner')).toHaveCount(0)
})

test('not when signed out — there is no photo to be yours', async ({ page }) => {
  await open(page, { signedIn: false, path: '/#/events' })
  await expect(page.getByTestId('avatar-corner')).toHaveCount(0)
})
