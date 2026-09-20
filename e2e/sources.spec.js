import { test, expect } from '@playwright/test'

// Fontes is for looking. Curation lives on the Curadoria tab.

const SOURCES = { institutional: [], instagram: [
  { handle: 'barfolia', label: 'Bar Folia', category: 'bar', future_events: 3 },
  { handle: 'pedreira', label: 'Pedreira', category: 'musica', future_events: 7 },
] }

async function openSources(page, { curator }) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/sources**', route => route.fulfill({ json: SOURCES }))
  await page.route('**/admin/curators**', route => route.fulfill({ json: {
    curators: [], is_curator: !!curator, is_founder: false,
  } }))
  await page.addInitScript(() =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true, googleUser: { id: 'u1', email: 'c@example.com', name: 'Cura', givenName: 'Cura' },
    })))
  await page.goto('/#/sources')
  await page.waitForTimeout(1500)
}

test('a curator sees no curation tools on Fontes any more', async ({ page }) => {
  // They used to sit at the top: the add-handle form and the queue
  // link. Both made the screen read as an admin tool to everyone else.
  await openSources(page, { curator: true })
  await expect(page.getByText('Bar Folia')).toBeVisible()
  await expect(page.getByText(/Adicionar nova fonte/)).toHaveCount(0)
  await expect(page.getByText(/Pedidos pro catálogo/)).toHaveCount(0)
})

test('the personal choice stays: Seguindo on every source', async ({ page }) => {
  await openSources(page, { curator: false })
  expect(await page.getByRole('button', { name: 'Seguindo', exact: true }).count()).toBe(2)
})

test('suggesting a source is offered at the bottom, to anyone', async ({ page }) => {
  await openSources(page, { curator: true })
  const suggest = page.getByRole('button', { name: /Sugerir uma conta/ })
  await expect(suggest).toBeVisible()
  const [sy, ly] = await Promise.all([
    suggest.boundingBox().then(b => b.y),
    page.getByText('Pedreira', { exact: true }).boundingBox().then(b => b.y),
  ])
  expect(sy).toBeGreaterThan(ly)
})
