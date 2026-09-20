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
    upcoming_event_count: 2, feed_token: 'tok_abc', can_curate: false,
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
  await page.route('**/groups/**/stats**', route => route.fulfill({
    json: {
      events_total: 7, events_upcoming: 3, events_past: 4, rsvps_total: 21,
      // Populated, so the avatar branch actually renders.
      top_organizer: { google_id: 'u9', name: 'Marina Lima', picture: '', events: 4 },
    },
  }))
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
  await expect(page.getByText(/2 rolês · 128 seguindo/i)).toBeVisible()
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
  // The notification choice is an icon now, not a row with a sentence.
  // Six full-width rows pushed the first event to 478px of an 844px
  // screen; the meaning lives in the accessible name instead.
  await expect(
    page.getByRole('button', { name: /Avisamos quando entrar rolê novo/ }),
  ).toBeVisible()
})

test('the notification switch only exists once you follow', async ({ page }) => {
  // A switch for something you don't receive is a setting with no
  // subject.
  await openChannel(page, { is_following: false })
  await expect(page.getByRole('button', { name: /^Seguir$/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Avisamos quando/ })).toHaveCount(0)
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

async function openTab(page, channels, groups = []) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/channels?**', route => route.fulfill({ json: { channels } }))
  await page.route('**/groups?**', route => route.fulfill({ json: { groups } }))
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
  await expect(page.getByText('Explorar')).toBeVisible()
})

test('your own private channels sit in Seguindo, not a section of their own', async ({ page }) => {
  // "Meus canais" was a third section that split one idea — channels in
  // your life — by who happened to create them. The reader had to do
  // bookkeeping the app should be doing.
  await openTab(page, LIST, [
    { id: 'g1', name: 'Role do Sax', member_count: 8, visibility: 'private',
      upcoming_event_count: 3, role: 'admin' },
  ])
  await expect(page.getByText('Meus canais')).toHaveCount(0)
  await expect(page.getByText('Role do Sax')).toBeVisible()
  // Same card, counting members instead of followers — the difference
  // is the badge and the noun, not the layout.
  await expect(page.getByText(/3 rolês · 8 membros/)).toBeVisible()
})

test('the split does not appear before the first follow', async ({ page }) => {
  // Everything IS discovery then, and a "Seguindo (0)" heading over
  // nothing is noise.
  await openTab(page, LIST.map(c => ({ ...c, is_following: false })))
  await expect(page.getByText('Explorar')).toHaveCount(0)
  await expect(page.getByText(/^Seguindo/)).toHaveCount(0)
  await expect(page.getByText('Canais do auê', { exact: true }).first()).toBeVisible()
})

test('Explorar goes away once everything is followed', async ({ page }) => {
  await openTab(page, LIST.map(c => ({ ...c, is_following: true })))
  await expect(page.getByText(/^Seguindo/).first()).toBeVisible()
  await expect(page.getByText('Explorar')).toHaveCount(0)
})

// Creating an auê channel had an endpoint and no button, so the only
// ways in were curl or the ordinary "criar canal" form two rows down —
// which makes a PRIVATE channel nobody else can find. That's how an
// "AUÊ Samba e Pagode" ends up invisible to everyone.

async function openAsFounder(page, isFounder) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/admin/curators**', route =>
    route.fulfill({ json: { is_founder: isFounder, is_curator: isFounder } }))
  await page.route('**/channels?**', route => route.fulfill({ json: { channels: [] } }))
  await page.addInitScript(() =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true, googleUser: { id: 'u1', email: 'f@b.com', name: 'Ciro' },
    })))
  await page.goto('/#/community')
  await page.waitForTimeout(1300)
}

test('the founder can create an auê channel from the channels tab', async ({ page }) => {
  await openAsFounder(page, true)
  const button = page.getByRole('button', { name: /Novo canal do auê/i })
  await expect(button).toBeVisible()

  await button.click()
  await expect(page.getByPlaceholder(/Nome \(ex/)).toBeVisible()
  // Says what it makes, because the other create button a few rows down
  // makes the opposite thing.
  await expect(page.getByText(/Público e seguível por qualquer pessoa/)).toBeVisible()
})

test('an ordinary user sees no way to create an auê channel', async ({ page }) => {
  await openAsFounder(page, false)
  await expect(page.getByRole('button', { name: /Novo canal do auê/i })).toHaveCount(0)
})

test('the visibility option no longer promises discovery it cannot deliver', async ({ page }) => {
  // `visibility` is read in exactly one place — the check that blocks a
  // non-member from opening a PRIVATE channel. Nothing lists public
  // ones, so "qualquer pessoa pode encontrar" sent people looking for
  // an audience that was never coming.
  await openAsFounder(page, false)
  await page.getByRole('button', { name: /Criar canal/i }).first().click()
  await page.waitForTimeout(400)

  // Default is private, and it explains itself now too — the _desc
  // strings existed in i18n and were never rendered at all.
  await expect(page.getByText(/Só quem você convidar/)).toBeVisible()

  await page.getByRole('button', { name: /Por link/ }).click()
  await expect(page.getByText(/Quem tiver o link consegue ver/)).toBeVisible()
  await expect(page.getByText(/não aparece na lista de canais do auê/)).toBeVisible()
  await expect(page.getByText(/pode encontrar/i)).toHaveCount(0)
})

test('anyone can pass a channel along, follower or not', async ({ page }) => {
  // A channel is public and the link just opens it — that's the whole
  // difference from a private one, where the link IS the invitation and
  // opening it puts you in.
  await openChannel(page, { is_following: false, can_curate: false })
  await expect(page.getByRole('button', { name: /Compartilhar canal/ })).toBeVisible()
})

test('the curator-only actions stay curator-only', async ({ page }) => {
  await openChannel(page, { is_following: true, can_curate: false })
  await expect(page.getByRole('button', { name: /Adicionar do catálogo/ })).toHaveCount(0)
  // But the calendar is for anyone following — a channel with a
  // schedule is more useful in a calendar than a private one is.
  await expect(page.getByRole('button', { name: /Assinar calendário/ })).toBeVisible()
})

test('a curator gets the catalog picker', async ({ page }) => {
  await openChannel(page, { is_following: true, can_curate: true })
  await expect(page.getByRole('button', { name: /Adicionar do catálogo/ })).toBeVisible()
})

test('a channel carries no stats panel', async ({ page }) => {
  // Removed Sep 2026: counters are for whoever runs a crew, and on a
  // channel they sat between the thing you came for — what's on — and
  // the list of it.
  await openChannel(page, { is_following: true, can_curate: true })
  await expect(page.getByText('Mural do canal')).toHaveCount(0)
})

test('a channel never offers to invite people into it', async ({ page }) => {
  // The one thing that genuinely doesn't belong: you follow a channel,
  // you are not invited to one.
  await openChannel(page, { is_following: true, can_curate: true })
  await expect(page.getByText(/convidar/i)).toHaveCount(0)
})

// A catalog event added to a channel becomes a separate row — a fork
// carrying source_event_id — so without a marker the same night shows
// in the band above and again down the list with nothing connecting
// them.

const CATALOG = { events: [
  { id: 'instagram_ig_x_A', name: 'Terno Rei na Pedreira', category: 'community',
    categoryLabel: 'Comunidade', categoryEmoji: '🤝', venue: 'Pedreira · Abranches',
    date: 'Sáb, 04 Out', time: '21:00', dateStart: '2099-10-04T21:00:00',
    headerBg: 'g', icon: '🎵', price: 'R$ 40', priceTier: 'low', source: 'instagram',
    url: 'u', vibeSummary: '', pitch: '', attendeesConfirmed: 0, expectedSize: 'medium',
    hasFood: false, isLowPressure: false, kidsWelcome: false, bairro: 'Abranches' },
  { id: 'instagram_ig_y_B', name: 'Feira do Passeio', category: 'community',
    categoryLabel: 'Comunidade', categoryEmoji: '🤝', venue: 'Passeio · Centro',
    date: 'Dom, 05 Out', time: '10:00', dateStart: '2099-10-05T10:00:00',
    headerBg: 'g', icon: '🛍', price: 'Grátis', priceTier: 'free', source: 'instagram',
    url: 'u', vibeSummary: '', pitch: '', attendeesConfirmed: 0, expectedSize: 'medium',
    hasFood: false, isLowPressure: false, kidsWelcome: false, bairro: 'Centro' } ] }

async function openEvents(page, channelEvents) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/events?**', route => route.fulfill({ json: CATALOG }))
  await page.route('**/channels/feed**', route =>
    route.fulfill({ json: { events: channelEvents } }))
  await page.addInitScript(() =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true, googleUser: { id: 'u1', email: 'a@b.com', name: 'Ana' },
    })))
  await page.goto('/#/events')
  await page.waitForTimeout(1800)
}

const FROM_CHANNEL = [{
  id: 'grp_ev_1', name: 'Terno Rei na Pedreira', sourceEventId: 'instagram_ig_x_A',
  groupName: 'auê Rockzera', dateStart: '2099-10-04T21:00:00', time: '21:00',
  date: 'Sáb, 04 Out', venue: 'Pedreira · Abranches',
}]

test('the band sits above the catalog, not inside the filters panel', async ({ page }) => {
  // It spent one round mounted inside {filtersOpen && ...}, which meant
  // it only appeared while the filter panel was open — invisible in
  // every normal visit.
  await openEvents(page, FROM_CHANNEL)
  await expect(page.getByText('Dos teus canais')).toBeVisible()
})

test('a catalog row names the channel it came from', async ({ page }) => {
  await openEvents(page, FROM_CHANNEL)
  // Named, not badged generically: "auê Rockzera" says why it's here,
  // "de um canal" doesn't. The ▌ prefix is gone — the card carries a
  // real lime stripe now, the same one a plan of your own gets.
  await expect(page.getByText('auê Rockzera', { exact: false }).first()).toBeVisible()
  // Once in the band, once on the catalog row it belongs to — and not
  // on the other event.
  expect(await page.getByText(/auê Rockzera/i).count()).toBe(2)
})

test('nothing is marked when you follow no channel', async ({ page }) => {
  await openEvents(page, [])
  await expect(page.getByText('Dos teus canais')).toHaveCount(0)
  await expect(page.getByText(/auê Rockzera/i)).toHaveCount(0)
})
