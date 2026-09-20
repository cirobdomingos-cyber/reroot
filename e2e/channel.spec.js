import { test, expect } from '@playwright/test'

// One screen, two kinds of channel. A public one is run by auê, a
// private one by whoever made it — and the difference is who is allowed
// to do what, not which affordances exist. So the guard these tests
// carry is per-permission: each one says which kind it opened, and what
// that kind should and should not offer.
//
// is_public is set explicitly in every fixture. It used to be absent,
// which made the public-only assertions below pass for the reason a
// missing field is falsy rather than because the screen decided
// anything — a test that certifies the bug as absent.
//
// The backend stub keeps them honest about the shape without needing a
// live channel.

const CHANNEL = {
  channel: {
    id: 'grp_rock', name: 'Rockzão', kind: 'channel',
    description: 'Tudo que tem guitarra em Curitiba, num lugar só.',
    follower_count: 2, is_following: true, notify: true,
    upcoming_event_count: 2, feed_token: 'tok_abc', can_curate: false,
    // Matches the followers array below: the hero reads the count,
    // the sheet counts the array, and a fixture where they disagree
    // tests a state the backend never produces.
    is_public: true, viewer_role: null,
  },
  events: [
    { id: 'e1', name: 'Terno Rei na Pedreira', dateStart: '2099-10-04T21:00:00',
      time: '21:00', venue: 'Pedreira Paulo Leminski · Abranches' },
    { id: 'e2', name: 'Noite Grunge', dateStart: '2099-10-09T22:00:00',
      time: '22:00', venue: 'Hard Rock Café · Batel' },
  ],
  past_events: [],
  followers: [
    { google_id: 'u9', name: 'Marina Lima', picture: '', role: 'admin' },
    { google_id: 'u8', name: 'Pedro Sax', picture: '', role: 'member' },
  ],
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
  await expect(page.getByText(/2 rolês · 2 seguindo/i)).toBeVisible()
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

test('following is the one action, and it is the only one', async ({ page }) => {
  await openChannel(page)
  await expect(page.getByRole('button', { name: /Seguindo/ })).toBeVisible()
  // The 🔔 and ⭐ switches are gone. Notification moved to the daily
  // novidades push, which says how many of the day's events came from
  // your channels — one push, not one per channel. Ordering stopped
  // being a setting: a switch for "put the channel I joined at the top"
  // asks people to turn on the reason they joined.
  await expect(page.getByTitle(/Avisamos|Sem aviso/)).toHaveCount(0)
  await expect(page.getByTitle(/Aparece no topo|Só aqui dentro/)).toHaveCount(0)
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
  // is the badge and the noun, not the layout. What's on is the number
  // on the right; the subtitle stopped repeating it in words.
  await expect(page.getByText(/8 membros/)).toBeVisible()
  await expect(page.getByTitle('3 rolês por vir')).toBeVisible()
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
  await expect(page.getByTitle(/Adicionar rolê/i)).toHaveCount(0)
})

test('no channel offers a calendar subscription any more', async ({ page }) => {
  // One place puts a night in your calendar: Meus rolês, next to the
  // ones you said yes to. Subscribing to a whole channel's schedule was
  // a calendar decision taken while deciding whether to follow.
  await openChannel(page, { is_following: true, can_curate: true })
  await expect(page.getByRole('button', { name: /Assinar calendário/ })).toHaveCount(0)
})

test('a curator gets the catalog picker', async ({ page }) => {
  await openChannel(page, { is_following: true, can_curate: true })
  await page.getByTitle(/Adicionar rolê/i).click()
  await expect(page.getByText('Adicionar do catálogo')).toBeVisible()
})

test('no channel carries a stats panel, public or private', async ({ page }) => {
  // Removed Sep 2026: counters are for whoever runs a crew, and on a
  // channel they sat between the thing you came for — what's on — and
  // the list of it. Merging the crew screen in did not bring them back.
  await openChannel(page, { is_following: true, can_curate: true })
  await expect(page.getByText('Mural do canal')).toHaveCount(0)
  await openChannel(page, { is_public: false, viewer_role: 'admin' })
  await expect(page.getByText('Mural do canal')).toHaveCount(0)
})

test('a public channel never offers to invite people into it', async ({ page }) => {
  // You follow a public channel from an open list. There is nobody to
  // invite into something anyone can already find — so this stays gone
  // even now that the same screen serves private channels, where it is
  // exactly the right button.
  await openChannel(page, { is_following: true, can_curate: true })
  await expect(page.getByTitle(/Convidar pro canal/i)).toHaveCount(0)
})

// ── The private half of the same screen ──
//
// A private channel is the old crew. It is not public, so it is not
// discovered — you are let in. That changes three things and nothing
// else: it says it is private, it can be invited into, and anyone
// inside can add an event (control is administration, not publishing).

test('a private channel says so instead of wearing the auê badge', async ({ page }) => {
  await openChannel(page, { is_public: false, viewer_role: 'member' })
  await expect(page.getByText('🔒 privado')).toBeVisible()
  // Scoped to the title row: the app shell carries its own auê
  // wordmark, so an unscoped count matches the brand, not the badge.
  const titleRow = page.locator('h1', { hasText: 'Rockzão' }).locator('..')
  await expect(titleRow.getByText('auê', { exact: true })).toHaveCount(0)
})

test('a private channel invites by passing the link along', async ({ page }) => {
  // The separate invite ➕ is gone. Sharing IS the invitation, so the
  // link has to be the one that lets someone in — /channels/:id 403s a
  // non-member, which sent people to a locked door.
  await openChannel(page, {
    is_public: false, viewer_role: 'member', invite_code: 'AB12CD34',
  })
  await expect(page.getByTitle(/Convidar pro canal/i)).toHaveCount(0)
  await expect(page.getByTitle(/Compartilhar canal/i)).toBeVisible()
})

test('anyone inside a private channel can add an event', async ({ page }) => {
  // Not can_curate — that is the public-channel curation team. Here the
  // plain member gets it, which is the whole point of option A.
  await openChannel(page, {
    is_public: false, viewer_role: 'member', can_curate: false,
  })
  await expect(page.getByTitle(/Adicionar rolê/i)).toBeVisible()
})

test('one icon covers both ways of adding one', async ({ page }) => {
  // It was ＋ for a new one and 🌍 for the catalog, which made the
  // reader pick a mechanism before picking a night.
  await openChannel(page, {
    is_public: false, viewer_role: 'admin', can_curate: true,
  })
  await expect(page.getByTitle(/Adicionar do catálogo/i)).toHaveCount(0)
  await page.getByTitle(/Adicionar rolê/i).click()
  await expect(page.getByText('Do catálogo', { exact: true })).toBeVisible()
  await expect(page.getByText('Novo rolê', { exact: true })).toBeVisible()
})

test('a public channel curator goes straight to the catalog', async ({ page }) => {
  // Publishing into a public channel goes through the catalog, and only
  // for a curator — no free-form event, so no chooser either. A chooser
  // with one choice is a tap that asks nothing.
  await openChannel(page, { is_following: true, can_curate: true })
  await page.getByTitle(/Adicionar rolê/i).click()
  // The chooser's own option, exact — "Do catálogo" is a substring of
  // the catalog sheet's title, and getByText matches substrings.
  await expect(page.getByText('Do catálogo', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Adicionar do catálogo')).toBeVisible()
})

test('the old crew URL still opens the channel', async ({ page }) => {
  // Crews became channels, but their ids did not change and their links
  // are already out there — in invites, in pushes, in pasted messages.
  // /#/groups/:id is a rename of the path, so it must land on the same
  // screen rather than on a blank route.
  await openChannel(page, { is_public: false, viewer_role: 'member' })
  await page.goto('/#/groups/grp_rock')
  await page.waitForTimeout(1200)
  await expect(page).toHaveURL(/#\/channels\/grp_rock/)
  await expect(page.getByText('Rockzão')).toBeVisible()
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

async function openEvents(page, channelEvents, groupEvents = []) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/events?**', route => route.fulfill({ json: CATALOG }))
  // AFTER the catalog route, not before: Playwright tries the
  // last-registered match first, and '**/events?**' also matches
  // /events/group?google_id=… — registering this first handed the
  // group fetch the whole catalog.
  await page.route('**/events/group**', route =>
    route.fulfill({ json: { events: groupEvents } }))
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

test('the list splits into your channels and the rest of the city', async ({ page }) => {
  await openEvents(page, FROM_CHANNEL)
  await expect(page.getByText('Dos teus canais')).toBeVisible()
  await expect(page.getByText('Explorar')).toBeVisible()
})

test('a channel event appears once, named, not twice in two shapes', async ({ page }) => {
  await openEvents(page, FROM_CHANNEL)
  // This replaced a horizontal band. The band showed the channel's fork
  // as a small card while the catalog showed the original as a row, so
  // one night appeared twice in two different shapes and the marker on
  // the row existed to connect them. Now it is one row, in the first
  // section, named on the right — so exactly one mention of the channel
  // and exactly one of the event.
  await expect(page.getByText('auê Rockzera')).toHaveCount(1)
  await expect(page.getByText('Terno Rei na Pedreira')).toHaveCount(1)
})

test("the other event stays under Explorar and carries no channel name", async ({ page }) => {
  await openEvents(page, FROM_CHANNEL)
  // Guards the partition from the lazy version of itself: marking every
  // row, or moving every row up, would pass the test above too.
  const explorar = page.getByText('Explorar')
  const feira = page.getByText('Feira do Passeio')
  await expect(feira).toHaveCount(1)
  const [hy, fy] = await Promise.all([
    explorar.boundingBox().then(b => b.y),
    feira.boundingBox().then(b => b.y),
  ])
  expect(fy).toBeGreaterThan(hy)
})

test('nothing is marked or split when you follow no channel', async ({ page }) => {
  await openEvents(page, [])
  // No headings at all, rather than an "Explorar" heading over the whole
  // catalog — a section label with nothing to contrast against is noise.
  await expect(page.getByText('Dos teus canais')).toHaveCount(0)
  await expect(page.getByText('Explorar')).toHaveCount(0)
  await expect(page.getByText(/auê Rockzera/i)).toHaveCount(0)
})

// The same post can sit in a private channel and a public one at once.
// It then arrives twice — the private fork through /events/group, the
// catalog original through /events — and used to render as two rows.

const PRIVATE_FORK = [{
  id: 'grp_priv_1', name: 'Terno Rei na Pedreira',
  sourceEventId: 'instagram_ig_x_A',
  isGroupEvent: true, groupId: 'g_turma', groupName: 'Turma A',
  groupNames: ['Turma A'], groupIds: ['g_turma'], viewerGroupCount: 1,
  dateStart: '2099-10-04T21:00:00', time: '21:00',
  date: 'Sáb, 04 Out', venue: 'Pedreira · Abranches',
}]

test('an event in a private and a public channel is one row, not two', async ({ page }) => {
  await openEvents(page, FROM_CHANNEL, PRIVATE_FORK)
  await expect(page.getByText('Terno Rei na Pedreira')).toHaveCount(1)
})

test('...and that row names both channels', async ({ page }) => {
  await openEvents(page, FROM_CHANNEL, PRIVATE_FORK)
  // The private fork is the row that survives, so it has to carry the
  // public channel's name too — attaching the name to the row that gets
  // dropped is how one of the two silently disappears.
  await expect(page.getByText('Turma A')).toHaveCount(1)
  await expect(page.getByText('auê Rockzera')).toHaveCount(1)
})

test('an event in two private channels is one row naming both', async ({ page }) => {
  await openEvents(page, [], [{
    ...PRIVATE_FORK[0],
    groupNames: ['Turma A', 'Rolê do Sábado'],
    groupIds: ['g_turma', 'g_role'], viewerGroupCount: 2,
  }])
  await expect(page.getByText('Terno Rei na Pedreira')).toHaveCount(1)
  await expect(page.getByText('Turma A')).toHaveCount(1)
  await expect(page.getByText('Rolê do Sábado')).toHaveCount(1)
})

test('a private event with no catalog twin still shows', async ({ page }) => {
  // Guards the dedupe from over-reaching: a channel event made from
  // scratch has no sourceEventId and nothing to be deduped against.
  await openEvents(page, [], [{
    ...PRIVATE_FORK[0],
    id: 'grp_priv_2', name: 'Churrasco do Zé', sourceEventId: '',
  }])
  await expect(page.getByText('Churrasco do Zé')).toHaveCount(1)
  await expect(page.getByText('Turma A')).toHaveCount(1)
})


// ── One RSVP control ──
//
// A catalog event used to get a lone "Confirmar presença" that flipped
// to "Cancelar confirmação"; an event from a channel got "Vou / Não
// vou". Same act, two vocabularies, two shapes — and after the dedupe,
// which one you saw depended on how the night happened to reach you.

async function openDetail(page, { channelEvents = [], groupEvents = [], id }) {
  await openEvents(page, channelEvents, groupEvents)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.getByText(id).first().click()
  await page.waitForTimeout(900)
}

test('a catalog event says Vou, not Confirmar presença', async ({ page }) => {
  await openDetail(page, { id: 'Feira do Passeio' })
  await expect(page.getByRole('button', { name: 'Vou', exact: true })).toBeVisible()
  await expect(page.getByText('Confirmar presença')).toHaveCount(0)
})

test('a catalog event is not asked a question nobody put to it', async ({ page }) => {
  // "Não vou" takes you off an invitee list and tells the host. The
  // city posting a show is neither, and the endpoint 404s on it.
  await openDetail(page, { id: 'Feira do Passeio' })
  // Anchored on something positive first: an assertion that only counts
  // absences passes just as well when the panel never opened.
  await expect(page.getByRole('button', { name: 'Vou', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Não vou/ })).toHaveCount(0)
})

test('a channel event keeps both answers', async ({ page }) => {
  await openDetail(page, { groupEvents: PRIVATE_FORK, id: 'Terno Rei na Pedreira' })
  await expect(page.getByRole('button', { name: 'Vou', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Não vou', exact: true })).toBeVisible()
})

// ── Who else is here ──
//
// The faces used to be tappable only on a private channel, so on an auê
// one there was no way to see who else was there — and on a private one
// the target was three 22px circles with nothing saying they were a
// button. Who is in a channel is most of the answer to "is this worth
// following", which is the question the screen exists to answer.

test('an auê channel tells you who else is following it', async ({ page }) => {
  await openChannel(page, { is_following: true })
  await page.getByText(/2 seguindo/).click()
  await expect(page.getByText('Marina Lima')).toBeVisible()
  await expect(page.getByText('Pedro Sax')).toBeVisible()
})

test('a private channel does too, and calls them members', async ({ page }) => {
  await openChannel(page, { is_public: false, viewer_role: 'member' })
  await page.getByText(/2 membros/).click()
  await expect(page.getByText('Marina Lima')).toBeVisible()
})

test('the list is read-only for someone who does not run the channel', async ({ page }) => {
  // Names and "+ amigo" is what a follower came for. Promote and remove
  // belong to whoever runs it.
  await openChannel(page, { is_following: true, viewer_role: null })
  await page.getByText(/2 seguindo/).click()
  await expect(page.getByText('Marina Lima')).toBeVisible()
  await expect(page.getByRole('button', { name: /remover/i })).toHaveCount(0)
})

// ── Leaving is not unfollowing ──
//
// A private channel carried a "Seguir / ✓ Seguindo" button that could
// not be turned off: unfollow_channel only deletes rows with
// role='follower', and a member's row says 'member'. The button had
// nothing to undo. Follow is a public-channel decision — you find one
// and opt in — and a private channel isn't found, you're let in.

test('a private channel offers no follow button', async ({ page }) => {
  await openChannel(page, { is_public: false, viewer_role: 'member', is_following: true })
  await expect(page.getByRole('button', { name: /Seguindo|^Seguir$/ })).toHaveCount(0)
})

test('it offers the action that actually exists: leaving', async ({ page }) => {
  await openChannel(page, { is_public: false, viewer_role: 'member' })
  await expect(page.getByRole('button', { name: 'Sair do canal' })).toBeVisible()
})

test('leaving asks first, because it costs you the way back in', async ({ page }) => {
  await openChannel(page, { is_public: false, viewer_role: 'member' })
  let asked = ''
  page.on('dialog', d => { asked = d.message(); d.dismiss() })
  await page.getByRole('button', { name: 'Sair do canal' }).click()
  await page.waitForTimeout(400)
  expect(asked).toContain('Sair de')
  expect(asked).toMatch(/convidar de novo/)
})

test('a private channel carries no switches either', async ({ page }) => {
  await openChannel(page, { is_public: false, viewer_role: 'member' })
  await expect(page.getByTitle(/Avisamos|Sem aviso/)).toHaveCount(0)
  await expect(page.getByTitle(/Aparece no topo|Só aqui dentro/)).toHaveCount(0)
})

// ── One night, one row, whatever produced the copies ──
//
// Reported from production: the same event rendered three identical
// cards. Adding a night to three channels writes three group_events
// rows — the per-group dedupe only stops a second copy in the SAME
// channel — and nothing downstream knew they were one post.

const THREE_FORKS = ['A', 'B', 'C'].map((k, i) => ({
  id: `grp_ev_${k}`, name: 'Masterclass DJ', sourceEventId: 'instagram_ig_x_A',
  isGroupEvent: true, groupId: `g_${k}`, groupName: `Canal ${k}`,
  groupNames: [`Canal ${k}`], groupIds: [`g_${k}`], viewerGroupCount: 1,
  dateStart: '2099-10-04T21:00:00', time: '21:00',
  date: 'Sáb, 04 Out', venue: `MACRO ${i}`,
}))

test('three forks of one night render one row', async ({ page }) => {
  await openEvents(page, [], THREE_FORKS)
  await expect(page.getByText('Masterclass DJ')).toHaveCount(1)
})

test('and that row still names all three channels', async ({ page }) => {
  // Collapsing without merging the names would silently drop two of the
  // three channels the night actually came from.
  await openEvents(page, [], THREE_FORKS)
  await expect(page.getByText('Canal A')).toHaveCount(1)
  await expect(page.getByText('Canal B')).toHaveCount(1)
})

test('an event from a channel is never labelled Plano', async ({ page }) => {
  // isPersonalPlan means "the viewer is in none of this event's groups",
  // which is the right rule for hiding a private channel's name and the
  // wrong one for calling something your plan.
  await openEvents(page, [], [{
    ...THREE_FORKS[0], isPersonalPlan: true, groupNames: [], groupName: '',
  }])
  await expect(page.getByText('Masterclass DJ')).toHaveCount(1)
  await expect(page.getByText('PLANO')).toHaveCount(0)
})

test('a plan with no channel at all is still called Plano', async ({ page }) => {
  await openEvents(page, [], [{
    id: 'grp_ev_solo', name: 'Jantar em casa', sourceEventId: '',
    isGroupEvent: true, isPersonalPlan: true,
    groupId: null, groupIds: [], groupNames: [],
    dateStart: '2099-10-04T21:00:00', time: '21:00', date: 'Sáb, 04 Out',
  }])
  await expect(page.getByText('Plano')).toBeVisible()
})

// ── The Canais tab answers "what's on", not just "what exists" ──

const CHANNEL_ROWS = {
  channels: [
    { id: 'c1', name: 'auê Rockzera', kind: 'channel', description: 'Guitarra',
      follower_count: 12, is_following: true, upcoming_event_count: 7,
      can_curate: false, visibility: 'public' },
    { id: 'c2', name: 'auê Deu Risada', kind: 'channel', description: 'Comédia',
      follower_count: 4, is_following: false, upcoming_event_count: 0,
      can_curate: false, visibility: 'public' },
  ],
}

async function openChannels(page) {
  await page.route('**/*', route => {
    const t = route.request().resourceType()
    return ['document', 'script', 'stylesheet', 'image', 'font', 'manifest'].includes(t)
      ? route.continue() : route.abort()
  })
  await page.route('**/groups?**', route => route.fulfill({ json: { groups: [] } }))
  await page.route('**/channels?**', route => route.fulfill({ json: CHANNEL_ROWS }))
  await page.addInitScript(() =>
    localStorage.setItem('aue_state', JSON.stringify({
      hasJoined: true, googleUser: { id: 'u1', email: 'a@b.com', name: 'Ana' },
    })))
  await page.goto('/#/community')
  await page.waitForTimeout(1400)
}

test('a channel with events leads with the number', async ({ page }) => {
  await openChannels(page)
  await expect(page.getByTitle('7 rolês por vir')).toBeVisible()
})

test('a channel with nothing coming up shows no number at all', async ({ page }) => {
  // A zero is a number competing for the same attention as a seven.
  await openChannels(page)
  await expect(page.getByText('auê Deu Risada')).toBeVisible()
  await expect(page.getByTitle(/0 rolês/)).toHaveCount(0)
})

test('Seguindo groups by kind before counting events', async ({ page }) => {
  // Sorting by count alone interleaved the two kinds — a busy auê
  // channel above your own crew — so the list had no shape and the
  // badge was the only thing telling you which was which.
  await openTab(page, [
    { id: 'c1', name: 'auê Movimentado', kind: 'channel', follower_count: 9,
      is_following: true, upcoming_event_count: 40, visibility: 'public' },
  ], [
    { id: 'g1', name: 'Crew Parada', member_count: 3, visibility: 'private',
      upcoming_event_count: 1, role: 'admin' },
  ])
  const [crewY, aueY] = await Promise.all([
    page.getByText('Crew Parada').boundingBox().then(b => b.y),
    page.getByText('auê Movimentado').boundingBox().then(b => b.y),
  ])
  expect(crewY).toBeLessThan(aueY)
})
