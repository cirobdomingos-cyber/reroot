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
