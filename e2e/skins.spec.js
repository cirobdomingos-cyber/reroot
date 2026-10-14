import { test, expect } from '@playwright/test'

// Perfil → Configurações → Visual. A skin applies on tap (data-skin on
// <html>, which re-points every colour token) and survives a reload,
// because initSkin() runs before React mounts.

async function openProfile(page) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.addInitScript(() => {
    if (!localStorage.getItem('aue_state')) {
      localStorage.setItem('aue_state', JSON.stringify({
        hasJoined: true,
        googleUser: { id: 'u1', email: 'a@b.com', name: 'Ana Lima', givenName: 'Ana' },
      }))
    }
  })
  await page.goto('/#/profile')
  await page.getByText('Configurações').click()
}

const bg = page => page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toUpperCase())

test('Neon Boteco is the default and sets no attribute', async ({ page }) => {
  await openProfile(page)
  await expect(page.getByTestId('skin-picker')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBeUndefined()
  expect(await bg(page)).toBe('#0A0510')
  await expect(page.locator('[data-skin-option="neon"]')).toHaveAttribute('aria-checked', 'true')
})

test('picking Garoa repaints the app and survives a reload', async ({ page }) => {
  await openProfile(page)
  await page.locator('[data-skin-option="garoa"]').click()
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe('garoa')
  expect(await bg(page)).toBe('#0A0E13')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0A0E13')

  await page.reload()
  expect(await page.evaluate(() => document.documentElement.dataset.skin)).toBe('garoa')
  expect(await bg(page)).toBe('#0A0E13')
})
