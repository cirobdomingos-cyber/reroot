import { test, expect } from '@playwright/test'

// The channel screen is deliberately NOT GroupDetail with the crew
// parts switched off. GroupDetail answers "what is this crew" — members,
// roles, invite code, mural, primeiros passos — and a channel needs
// almost none of it. Rendering it and hiding pieces is how an
// "...unless it's a channel" branch spreads through a file, which is
// the failure docs/NEXT.md warned about before any of this was built.
//
// These tests are the guard. The backend stub keeps them honest about
// the shape without needing a live channel.

const CHANNEL = {
  channel: {
    id: 'grp_rock', name: 'Rockzão', kind: 'channel',
    description: 'Tudo que tem guitarra em Curitiba, num lugar só.',
    follower_count: 128, is_following: true, notify: true,
    upcoming_event_count: 2,
  },
  events: [
    { id: 'e1', name: 'Terno Rei na Pedreira', dateStart: '2099-10-04T21:00:00',
      time: '21:00', venue: 'Pedreira Paulo Leminski · Abranches' },
    { id: 'e2', name: 'Noite Grunge', dateStart: '2099-10-09T22:00:00',
      time: '22:00', venue: 'Hard Rock Café · Batel' },
  ],
  past_events: [],
  followers: [],
}

async function openChannel(page, overrides = {}) {
  // Catch-all first: Playwright runs the LAST-registered matching route
  // first, so registering it second would abort the fetch being stubbed.
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/channels/**', route => route.fulfill({
    json: { ...CHANNEL, channel: { ...CHANNEL.channel, ...overrides } },
  }))
  await page.addInitScript(() =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true, googleUser: { id: 'u1', email: 'a@b.com', name: 'Ana' },
    })))
  await page.goto('/#/channels/grp_rock')
  await page.waitForTimeout(1200)
}

test('a channel leads with what it publishes', async ({ page }) => {
  await openChannel(page)
  await expect(page.getByText('Rockzão')).toBeVisible()
  await expect(page.getByText(/Tudo que tem guitarra/)).toBeVisible()
  // What's in it before who else is in it — a channel reporting only
  // followers asks for a follow without saying what for.
  await expect(page.getByText(/2 rolês marcados · 128 seguindo/i)).toBeVisible()
  await expect(page.getByText('Terno Rei na Pedreira')).toBeVisible()
  await expect(page.getByText('Noite Grunge')).toBeVisible()
})

test('a channel shows none of the crew machinery', async ({ page }) => {
  await openChannel(page)
  for (const gone of [/convidar/i, /membros/i, /código de convite/i,
                      /mural/i, /primeiros passos/i, /sair do canal/i]) {
    await expect(page.getByText(gone)).toHaveCount(0)
  }
})

test('following is the one action, and it carries a notification choice', async ({ page }) => {
  await openChannel(page)
  await expect(page.getByRole('button', { name: /Seguindo/ })).toBeVisible()
  await expect(page.getByText(/Te avisamos quando entrar rolê novo/)).toBeVisible()
})

test('the notification switch only exists once you follow', async ({ page }) => {
  // A switch for something you don't receive is a setting with no
  // subject.
  await openChannel(page, { is_following: false })
  await expect(page.getByRole('button', { name: /^Seguir$/ })).toBeVisible()
  await expect(page.getByText(/Te avisamos quando/)).toHaveCount(0)
})

test('an empty channel says what following would get you', async ({ page }) => {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/channels/**', route => route.fulfill({
    json: { ...CHANNEL, events: [], channel: { ...CHANNEL.channel, upcoming_event_count: 0 } },
  }))
  await page.goto('/#/channels/grp_rock')
  await page.waitForTimeout(1200)
  await expect(page.getByText(/Nada marcado agora/)).toBeVisible()
})

// The channels tab has to answer two questions at a glance: what do I
// follow, and what else is there. One flat list with a button on every
// row makes them the same pile — you have to read every button to
// answer either one.

const LIST = [
  { id: 'c1', name: 'De Graça', description: 'Tudo que não custa nada.',
    follower_count: 30, is_following: true, notify: true, upcoming_event_count: 42 },
  { id: 'c2', name: 'Vai Ter Festa', description: 'Sexta e sábado até tarde.',
    follower_count: 8, is_following: false, notify: true, upcoming_event_count: 28 },
]

async function openTab(page, channels) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/channels?**', route => route.fulfill({ json: { channels } }))
  await page.addInitScript(() =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true, googleUser: { id: 'u1', email: 'a@b.com', name: 'Ana' },
    })))
  await page.goto('/#/community')
  await page.waitForTimeout(1200)
}

test('followed and available channels are separate piles', async ({ page }) => {
  await openTab(page, LIST)
  await expect(page.getByText(/^Seguindo/).first()).toBeVisible()
  await expect(page.getByText('Descobrir')).toBeVisible()
  // And the private ones are labelled too — that section had no heading
  // at all, so the reader fell out of "Descobrir" into a create button
  // with nothing saying what it belonged to.
  await expect(page.getByText('Meus canais')).toBeVisible()
})

test('the split does not appear before the first follow', async ({ page }) => {
  // Everything IS discovery then, and a "Seguindo (0)" heading over
  // nothing is noise.
  await openTab(page, LIST.map(c => ({ ...c, is_following: false })))
  await expect(page.getByText('Descobrir')).toHaveCount(0)
  await expect(page.getByText(/^Seguindo/)).toHaveCount(0)
  await expect(page.getByText('Canais do auê', { exact: true }).first()).toBeVisible()
})

test('Descobrir goes away once everything is followed', async ({ page }) => {
  await openTab(page, LIST.map(c => ({ ...c, is_following: true })))
  await expect(page.getByText(/^Seguindo/).first()).toBeVisible()
  await expect(page.getByText('Descobrir')).toHaveCount(0)
})
