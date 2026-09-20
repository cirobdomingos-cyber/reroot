import { test, expect } from '@playwright/test'

// /admin is a menu first. Each card is a job with the one number that
// says whether to open it; /admin/<section> is the job. These pin the
// shape for the two people who use it: the founder, and a curator.

const ACCOUNTS = { accounts: [
  { handle: 'barfolia', label: 'Bar Folia', category: 'bar', enabled: true, future_events: 4, last_scraped_at: '2026-09-20T10:00:00Z' },
  { handle: 'pedreira', label: 'Pedreira', category: 'musica', enabled: true, future_events: 9, last_scraped_at: '2026-09-20T10:00:00Z' },
  { handle: 'dormindo', label: 'Dormindo', category: 'bar', enabled: false, future_events: 0 },
] }
const USERS = { total: 2, users: [
  { google_id: 'u1', name: 'Ana Founder', email: 'founder@example.com', joined: '2026-01-01', last_seen: '2026-09-21', days_active: 40, rsvps: 3, friends: 5, groups: 2, events_created: 1, push_devices: 1 },
  { google_id: 'u2', name: 'Bia', email: 'bia@example.com', joined: '2026-05-01', last_seen: '2026-09-20', days_active: 8, rsvps: 1, friends: 2, groups: 1, events_created: 0, push_devices: 0 },
] }
const USAGE = { total_users: 2, dau: 1, wau: 2, mau: 2, new_today: 0,
  daily: [{ date: '2026-09-20', active: 1, new: 0, returning: 1 }], funnel: [{ step: 'abriu', count: 2 }],
  counts: { rsvps: 4, friendships: 3, groups: 3, feedback: 1 }, recent: [] }

async function openAdmin(page, { founder, path = '/#/admin' } = {}) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  const flags = { is_curator: true, is_founder: !!founder }
  await page.route('**/admin/ig-accounts**', route => route.fulfill({ json: { ...ACCOUNTS, ...flags } }))
  await page.route('**/admin/curators**', route => route.fulfill({ json: {
    curators: [{ email: 'founder@example.com', is_founder: true, is_curator: true },
               { email: 'ghost@example.com', is_founder: false, is_curator: true }],
    ...flags,
  } }))
  await page.route('**/admin/catalog-requests**', route => route.fulfill({ json: { requests: [{ id: 1 }, { id: 2 }] } }))
  await page.route('**/admin/account-requests**', route => route.fulfill({ json: { requests: [{ id: 9 }] } }))
  await page.route('**/admin/users**', route => route.fulfill({ json: USERS }))
  await page.route('**/admin/usage-stats**', route => route.fulfill({ json: USAGE }))
  await page.route('**/admin/feedback**', route => route.fulfill({ json: { feedback: [{ id: 1, text: 'top', status: 'new' }] } }))
  await page.route('**/admin/client-errors**', route => route.fulfill({ json: { errors: [] } }))
  await page.route('**/admin/venues/leaderboard**', route => route.fulfill({ json: { venues: [
    { handle: 'pedreira', label: 'Pedreira', views: 120, rsvps: 8, conversion_rate: 0.066, future_events: 9 },
    { handle: 'barfolia', label: 'Bar Folia', views: 40, rsvps: 2, conversion_rate: 0.05, future_events: 4 },
  ] } }))
  await page.route('**/health**', route => route.fulfill({ json: { ok: true, env_name: 'staging' } }))
  await page.addInitScript(() =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true,
      googleUser: { id: 'u1', email: 'founder@example.com', name: 'Ana Founder', givenName: 'Ana' },
    })))
  await page.goto(path)
  await page.waitForTimeout(1500)
}

test('the founder lands on a menu, not a page', async ({ page }) => {
  await openAdmin(page, { founder: true })
  for (const card of ['Pedidos', 'Contas @', 'Locais e pins', 'Pessoas', 'Uso', 'Feedback', 'Ferramentas']) {
    await expect(page.getByRole('button', { name: new RegExp(card) })).toBeVisible()
  }
  // The one line that says whether anything is waiting: 2 events + 1 @.
  await expect(page.getByText(/3 pedidos esperando você/)).toBeVisible()
})

test('a curator gets the three cards that are theirs', async ({ page }) => {
  await openAdmin(page, { founder: false })
  await expect(page.getByRole('button', { name: /Contas @/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Pedidos/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Locais e pins/ })).toBeVisible()
  for (const gone of ['Pessoas', 'Feedback', 'Ferramentas']) {
    await expect(page.getByRole('button', { name: new RegExp(`^.*${gone}`) })).toHaveCount(0)
  }
})

test('the old /admin/ig still opens, on the @ list', async ({ page }) => {
  await openAdmin(page, { founder: true, path: '/#/admin/ig' })
  await expect(page).toHaveURL(/#\/admin\/contas/)
  await expect(page.getByText('@barfolia')).toBeVisible()
})

test('one @ row carries the founder overlay and the pin', async ({ page }) => {
  await openAdmin(page, { founder: true, path: '/#/admin/contas' })
  // 30d metrics from the leaderboard, on the same row curators see.
  await expect(page.getByText('👀 120')).toBeVisible()
  // Sorted by activity for the founder: pedreira (rank 1) above barfolia.
  const [ped, fol] = await Promise.all([
    page.getByText('@pedreira').boundingBox().then(b => b.y),
    page.getByText('@barfolia').boundingBox().then(b => b.y),
  ])
  expect(ped).toBeLessThan(fol)
  // The door to the map, on every row.
  expect(await page.getByTitle(/Localização no mapa/).count()).toBe(3)
})

test('a curator sees the same rows without the founder overlay', async ({ page }) => {
  await openAdmin(page, { founder: false, path: '/#/admin/contas' })
  await expect(page.getByText('@barfolia')).toBeVisible()
  await expect(page.getByText(/👀 /)).toHaveCount(0)
  await expect(page.getByTitle(/Localização no mapa/).first()).toBeVisible()
})

test('people is one table, with a role column and grant on the row', async ({ page }) => {
  await openAdmin(page, { founder: true, path: '/#/admin/pessoas' })
  await expect(page.getByText('PESSOAS · 2')).toBeVisible()
  await expect(page.getByText('FUNDADOR', { exact: true })).toBeVisible()
  // Bia isn't a curator: her row offers to make her one.
  await expect(page.getByRole('button', { name: /\+ curador/ })).toHaveCount(1)
  // Granted by email, never signed in: still visible, still revocable.
  await expect(page.getByText('ghost@example.com')).toBeVisible()
  // No grant-by-email form any more.
  await expect(page.getByPlaceholder('email@exemplo.com')).toHaveCount(0)
})

test('a curator asking for a founder section is told so', async ({ page }) => {
  await openAdmin(page, { founder: false, path: '/#/admin/pessoas' })
  await expect(page.getByText('Essa parte é do fundador.')).toBeVisible()
})
