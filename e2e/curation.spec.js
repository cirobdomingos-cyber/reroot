import { test, expect } from '@playwright/test'

// The daily scrape goes through curators. Two surfaces: one banner in
// Notificações, and bulk approve in /curadoria.

const QUEUE = { requests: [
  { id: 1, status: 'review', source: 'scrape', name: 'Samba do Folia', venue_name: 'Bar Folia', date_start: '2099-09-20T18:00:00', ig_handle: 'barfolia', image_url: '' },
  { id: 2, status: 'review', source: 'scrape', name: 'Terno Rei', venue_name: 'Pedreira', date_start: '2099-10-04T21:00:00', ig_handle: 'pedreira', image_url: '' },
  { id: 3, status: 'review', source: 'suggestion', name: 'Feira do Passeio', venue_name: 'Passeio', date_start: '2099-10-05T10:00:00', submitted_by_name: 'Bia', image_url: '' },
] }

async function open(page, { curator, path }) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/admin/curators**', route => route.fulfill({ json: { curators: [], is_curator: !!curator, is_founder: false } }))
  await page.route('**/admin/catalog-requests/approve-many', route => route.fulfill({ json: {
    ok: true, approved: 3, results: [{ id: 1, ok: true }, { id: 2, ok: true }, { id: 3, ok: true }],
  } }))
  await page.route(/\/admin\/catalog-requests(\?|$)/, route => route.fulfill({ json: QUEUE }))
  await page.route('**/admin/account-requests**', route => route.fulfill({ json: { requests: [] } }))
  await page.route(/\/notifications\?/, route => route.fulfill({ json: { items: [], unread_count: 0 } }))
  await page.addInitScript(() =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true, googleUser: { id: 'u1', email: 'c@example.com', name: 'Cura', givenName: 'Cura' },
    })))
  await page.goto(path)
  await page.waitForTimeout(1500)
}

test('a curator sees one banner in Notificações, with the count', async ({ page }) => {
  await open(page, { curator: true, path: '/#/notifications' })
  const banner = page.getByTestId('curation-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('3 eventos esperando revisão')
})

test('nobody else sees it', async ({ page }) => {
  await open(page, { curator: false, path: '/#/notifications' })
  await expect(page.getByTestId('curation-banner')).toHaveCount(0)
})

test('the queue says where each item came from', async ({ page }) => {
  await open(page, { curator: true, path: '/#/curadoria' })
  await expect(page.getByText('Do scrape · @barfolia')).toBeVisible()
  await expect(page.getByText('Bia sugeriu')).toBeVisible()
})

test('select all, approve all, queue empties', async ({ page }) => {
  await open(page, { curator: true, path: '/#/curadoria' })
  await page.getByRole('button', { name: /Selecionar todos \(3\)/ }).click()
  await page.getByRole('button', { name: /Aprovar 3 selecionados/ }).click()
  await expect(page.getByText('Nada esperando revisão')).toBeVisible()
})
