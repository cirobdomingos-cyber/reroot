import { test, expect } from '@playwright/test'

// The daily scrape publishes and queues for curation in one step. Three
// surfaces: one banner in Notificações, bulk approve in /curadoria, and a
// detail that says "tá certo / tirar do catálogo" for a public event.

const QUEUE = { requests: [
  { id: 1, status: 'review', source: 'scrape', in_catalog: true, catalog_event_id: 'instagram_ig_barfolia_ABC', name: 'Samba do Folia', venue_name: 'Bar Folia', date_start: '2099-09-20T18:00:00', ig_handle: 'barfolia', image_url: '/event-images/instagram_ig_barfolia_ABC.jpg' },
  { id: 2, status: 'review', source: 'scrape', in_catalog: true, catalog_event_id: 'instagram_ig_pedreira_DEF', name: 'Terno Rei', venue_name: 'Pedreira', date_start: '2099-10-04T21:00:00', ig_handle: 'pedreira', image_url: '' },
  { id: 3, status: 'review', source: 'suggestion', in_catalog: false, catalog_event_id: '', name: 'Feira do Passeio', venue_name: 'Passeio', date_start: '2099-10-05T10:00:00', submitted_by_name: 'Bia', image_url: '' },
] }

async function open(page, { curator, path }) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  // The catch-all above aborts images, and Thumb swaps a broken image
  // for a grey box — so serve the flyer as a 1x1 PNG.
  await page.route('**/event-images/**', route => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  }))
  await page.route('**/admin/curators**', route => route.fulfill({ json: { curators: [], is_curator: !!curator, is_founder: false } }))
  await page.route('**/admin/catalog-requests/approve-many', route => route.fulfill({ json: {
    ok: true, approved: 3, results: [{ id: 1, ok: true }, { id: 2, ok: true }, { id: 3, ok: true }],
  } }))
  await page.route(/\/admin\/catalog-requests(\?|$)/, route => route.fulfill({ json: QUEUE }))
  await page.route(/\/admin\/catalog-requests\/1(\?|$)/, route => route.fulfill({ json: QUEUE.requests[0] }))
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
  await expect(banner).toContainText('3 eventos novos sem curadoria')
})

test('nobody else sees it', async ({ page }) => {
  await open(page, { curator: false, path: '/#/notifications' })
  await expect(page.getByTestId('curation-banner')).toHaveCount(0)
})

test('a scraped request shows its rehosted flyer', async ({ page }) => {
  await open(page, { curator: true, path: '/#/curadoria' })
  const img = page.locator('img[src*="instagram_ig_barfolia_ABC.jpg"]')
  await expect(img).toHaveCount(1)
})

test('the queue says where each item came from', async ({ page }) => {
  await open(page, { curator: true, path: '/#/curadoria' })
  await expect(page.getByText('Do scrape · @barfolia · no catálogo')).toBeVisible()
  await expect(page.getByText('Bia sugeriu')).toBeVisible()
})

test('select all, approve all, queue empties', async ({ page }) => {
  await open(page, { curator: true, path: '/#/curadoria' })
  await page.getByRole('button', { name: /Selecionar todos \(3\)/ }).click()
  await page.getByRole('button', { name: /Aprovar 3 selecionados/ }).click()
  await expect(page.getByText('Tudo curado')).toBeVisible()
})

test('a public event reads "tá certo / tirar do catálogo", with a link to it', async ({ page }) => {
  await open(page, { curator: true, path: '/#/curadoria/1' })
  await expect(page.getByRole('button', { name: 'Tá certo' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tirar do catálogo' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ver no catálogo' })).toBeVisible()
  await expect(page.getByText('Aprovar e publicar')).toHaveCount(0)
})
