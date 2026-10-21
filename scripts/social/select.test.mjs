// node --test scripts/social/
// Selection and wording rules for the weekend carousel, on a small fixture.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectWeekend, overlaps, spanOf, timeOf, comingWeekend, isKids } from './select.mjs'
import { pitchLine, dayLabel, venueLine, buildCaption } from './format.mjs'

const W = { from: '2026-10-16', to: '2026-10-18' }

// Feed shape: wall-clock times with a "+00:00" suffix.
let n = 0
function ev(over = {}) {
  n += 1
  const day = over.day || '2026-10-16'
  const time = over.time ?? '21:00'
  const { day: _d, ...rest } = over
  return {
    id: `e${n}`,
    name: `Evento ${n}`,
    venue: `Lugar ${n} · Centro`,
    bairro: 'Centro',
    category: 'community',
    tipo: `tipo${n}`,
    priceTier: 'low',
    price: 'R$ 20',
    igHandle: `lugar${n}`,
    isRecurring: false,
    kidsWelcome: false,
    attendeesConfirmed: 0,
    pitch: 'Bora porque rola som ao vivo',
    dateStart: `${day}T${time || '00:00'}:00+00:00`,
    dateEnd: '',
    time,
    ...rest,
  }
}

test('window overlap uses the wall-clock date, including multi-day runs', () => {
  assert.equal(overlaps(ev({ day: '2026-10-15' }), W.from, W.to), false) // Thursday only
  assert.equal(overlaps(ev({ day: '2026-10-19' }), W.from, W.to), false) // Monday
  assert.equal(overlaps(ev({ day: '2026-10-18', time: '23:30' }), W.from, W.to), true) // late Sunday, not shifted by UTC
  assert.equal(overlaps(ev({ day: '2026-09-01', dateEnd: '2026-12-01T23:59:59+00:00' }), W.from, W.to), true)
  assert.equal(overlaps(ev({ day: '2026-09-01', dateEnd: '2026-10-15T23:59:59+00:00' }), W.from, W.to), false)
})

test('a party ending after midnight is a one-day event', () => {
  const party = ev({ day: '2026-10-16', dateEnd: '2026-10-17T04:00:00+00:00' })
  assert.deepEqual(spanOf(party), { start: '2026-10-16', end: '2026-10-16', days: 1 })
})

test('"00:00" in the feed means no time', () => {
  assert.equal(timeOf(ev({ time: '00:00' })), null)
  assert.equal(timeOf(ev({ time: '9:30' })), '09:30')
})

test('caps: 2 per category, 1 per venue, 1 kids, 1 long run, 1 recurring', () => {
  const events = [
    ...[1, 2, 3, 4].map((i) => ev({ tipo: 'show', name: `Show ${i}` })),
    ev({ tipo: 'teatro', venue: 'Teatro X · Centro', igHandle: 'teatrox' }),
    ev({ tipo: 'festa', venue: 'Teatro X · Centro', igHandle: 'teatrox2' }),
    ev({ tipo: 'kids', name: 'Show infantil A' }),
    ev({ tipo: 'kids', name: 'Show infantil B', day: '2026-10-17' }),
    ev({ tipo: 'expo', name: 'Expo A', day: '2026-09-01', dateEnd: '2026-12-01T23:59:59+00:00', time: '' }),
    ev({ tipo: 'expo2', name: 'Expo B', day: '2026-09-02', dateEnd: '2026-11-30T23:59:59+00:00', time: '' }),
    ev({ tipo: 'samba', name: 'Roda semanal A', isRecurring: true, day: '2026-10-17' }),
    ev({ tipo: 'jazz', name: 'Roda semanal B', isRecurring: true, day: '2026-10-18' }),
  ]
  const { picks } = selectWeekend(events, { ...W, count: 20 })
  const names = picks.map((p) => p.event.name)
  assert.equal(names.filter((x) => x.startsWith('Show ') && !x.includes('infantil')).length, 2)
  assert.equal(picks.filter((p) => p.event.venue.startsWith('Teatro X')).length, 1)
  assert.equal(picks.filter((p) => isKids(p.event)).length, 1)
  assert.equal(names.filter((x) => x.startsWith('Expo')).length, 1)
  assert.equal(picks.filter((p) => p.event.isRecurring).length, 1)
})

test('one-off events with a time beat exhibitions and recurring ones', () => {
  const events = [
    ev({ name: 'Expo', tipo: 'expo', day: '2026-09-01', dateEnd: '2026-12-01T23:59:59+00:00', time: '' }),
    ev({ name: 'Semanal', tipo: 'roda', isRecurring: true }),
    ev({ name: 'Show único', tipo: 'show' }),
  ]
  const { picks } = selectWeekend(events, { ...W, count: 1 })
  assert.equal(picks[0].event.name, 'Show único')
})

test('mixes free and paid when both exist', () => {
  const paid = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ev({ tipo: `p${i}`, attendeesConfirmed: 50 }))
  const free = [1, 2].map((i) => ev({ tipo: `f${i}`, priceTier: 'free', price: '', day: '2026-10-17' }))
  const { picks } = selectWeekend([...paid, ...free], { ...W, count: 7 })
  assert.equal(picks.length, 7)
  assert.equal(picks.filter((p) => p.event.priceTier === 'free').length, 2)
})

test('drops rows without a handle, outside Curitiba or not events', () => {
  const events = [
    ev({ igHandle: '' }),
    ev({ name: 'Capi Run Paranavaí' }),
    ev({ name: '10 musicais e peças de teatro em Curitiba' }),
    ev({ name: 'Ok' }),
  ]
  const { picks, rejected } = selectWeekend(events, { ...W, count: 7 })
  assert.deepEqual(picks.map((p) => p.event.name), ['Ok'])
  assert.equal(rejected['no Instagram handle to credit'], 1)
  assert.equal(rejected['outside Curitiba'], 1)
  assert.equal(rejected['not an event'], 1)
})

test('deterministic, ordered by date then time, whatever the input order', () => {
  const events = [
    ev({ tipo: 'a', day: '2026-10-18', time: '19:00' }),
    ev({ tipo: 'b', day: '2026-10-16', time: '22:00' }),
    ev({ tipo: 'c', day: '2026-10-17', time: '14:00' }),
    ev({ tipo: 'd', day: '2026-10-16', time: '18:30' }),
    ev({ tipo: 'e', day: '2026-10-17', time: '09:00' }),
  ]
  const a = selectWeekend(events, { ...W, count: 4 }).picks.map((p) => p.event.id)
  const b = selectWeekend([...events].reverse(), { ...W, count: 4 }).picks.map((p) => p.event.id)
  assert.deepEqual(a, b)
  const order = selectWeekend(events, { ...W, count: 5 }).picks.map((p) => `${p.day} ${timeOf(p.event)}`)
  assert.deepEqual(order, [...order].sort())
})

test('round-robin over days so one day cannot fill the carousel', () => {
  const fri = [1, 2, 3, 4, 5].map((i) => ev({ tipo: `fri${i}`, attendeesConfirmed: 100 }))
  const sun = [ev({ tipo: 'sun', day: '2026-10-18' })]
  const { picks } = selectWeekend([...fri, ...sun], { ...W, count: 3 })
  assert.ok(picks.some((p) => p.day === '2026-10-18'))
})

test('coming weekend in Curitiba', () => {
  assert.deepEqual(comingWeekend('2026-10-14'), W) // Wednesday
  assert.deepEqual(comingWeekend('2026-10-17'), W) // Saturday: the current weekend
  assert.deepEqual(comingWeekend('2026-10-19'), { from: '2026-10-23', to: '2026-10-25' })
})

test('rejects a bad window', () => {
  assert.throws(() => selectWeekend([], { from: '2026-10-18', to: '2026-10-16' }))
})

test('pitch line is only trimmed, never rewritten', () => {
  const long = 'Bora porque rola 110 artesãos + gastronomia na Praça Osório, formato caminhada entre barracas e muita coisa pra ver com calma'
  const line = pitchLine({ pitch: long }, 90)
  assert.ok(long.startsWith(line.replace(/…$/, '')))
  assert.ok(line.length <= 91)
  assert.equal(pitchLine({ pitch: '', vibeSummary: 'Show curto' }), 'Show curto')
})

test('day and venue labels', () => {
  assert.equal(dayLabel(ev({ day: '2026-10-17' }), W.from, W.to), 'Sáb 17')
  assert.equal(dayLabel(ev({ day: '2026-10-15', dateEnd: '2026-10-18T23:00:00+00:00' }), W.from, W.to), 'Sex 16 a Dom 18')
  assert.equal(dayLabel(ev({ day: '2026-09-01', dateEnd: '2027-02-28T23:59:59+00:00' }), W.from, W.to), 'Até 28 fev')
  assert.equal(venueLine({ venue: 'Dreamis | Ahú · Ahú', bairro: 'Ahú' }), 'Dreamis | Ahú')
  assert.equal(venueLine({ venue: 'Cataia Bar', bairro: 'São Francisco' }), 'Cataia Bar · São Francisco')
})

test('caption tags every handle, ends with the CTA and at most 5 hashtags', () => {
  const picks = [ev({ igHandle: 'cataiabarcwb', categoryEmoji: '🎵' }), ev({ igHandle: 'teatroguaira', day: '2026-10-18' })]
    .map((event) => ({ event, day: spanOf(event).start }))
  const caption = buildCaption(picks, W.from, W.to)
  assert.match(caption, /@cataiabarcwb/)
  assert.match(caption, /@teatroguaira/)
  assert.match(caption, /Baixa o auê de graça — link na bio/)
  assert.match(caption, /iPhone: já na App Store · Android: entra no beta/)
  assert.ok((caption.match(/#\w+/g) || []).length <= 5)
  assert.doesNotMatch(caption, /recomendado|baixa press|introvertid|acolhedor/i)
})

test('a show outranks a workshop at the same slot', () => {
  const workshop = ev({ tipo: 'oficina', day: '2026-10-16', time: '20:00' })
  const show = ev({ tipo: 'show', day: '2026-10-16', time: '21:00' })
  const { picks } = selectWeekend([workshop, show], { ...W, count: 1 })
  assert.equal(picks[0].event.id, show.id)
})

test('hand picks come first, skip the caps, and unknown ids fail loudly', () => {
  const a = ev({ tipo: 'show', igHandle: 'same', day: '2026-10-17' })
  const b = ev({ tipo: 'show', igHandle: 'same', day: '2026-10-17', time: '22:00' })
  const c = ev({ tipo: 'teatro', day: '2026-10-18' })
  const { picks } = selectWeekend([a, b, c], { ...W, count: 3, pinIds: [a.id, b.id] })
  assert.deepEqual(picks.map((p) => p.event.id), [a.id, b.id, c.id]) // two from one venue: the human chose it
  assert.equal(picks[0].reasons[0], 'picked by hand')
  assert.throws(() => selectWeekend([a], { ...W, pinIds: ['nope'] }), /--pick nope/)
})

test('drops rows whose own pitch says they are outside Curitiba', () => {
  const bh = ev({ pitch: 'Show do Amorphis em Belo Horizonte — fora de Curitiba', venue: 'Mister Rock · Água Verde' })
  const ok = ev({ pitch: 'Bora pro som pesado na noite de Curitiba' })
  const { picks, rejected } = selectWeekend([bh, ok], { ...W, count: 2 })
  assert.deepEqual(picks.map((p) => p.event.id), [ok.id])
  assert.equal(rejected['outside Curitiba'], 1)
})

test('pitch line never carries a price', () => {
  assert.equal(pitchLine({ pitch: 'Show com ingresso a R$ 30 na porta', vibeSummary: 'Show de rock no Changes' }), 'Show de rock no Changes')
  assert.equal(pitchLine({ pitch: 'Bora porque rola rock ao vivo', vibeSummary: '' }), '') // the old "Bora porque" line is gone from the app
  assert.equal(pitchLine({ pitch: 'Três shows seguidos no Dizzy', vibeSummary: 'Show com R$ 10 de entrada' }), 'Três shows seguidos no Dizzy')
  assert.equal(pitchLine({ pitch: 'Entrada free até 22h e drinks', vibeSummary: 'Tudo por R$ 20' }), '')
  assert.equal(pitchLine({ pitch: 'Corrida gratuita de 5km', vibeSummary: 'Corrida de rua de 5 e 10km' }), 'Corrida de rua de 5 e 10km') // no 'free' claims either
  assert.equal(pitchLine({ vibeSummary: 'Festa house com DJ set e drink com desconto', pitch: 'Festa house no Portal Kirin com DJ set' }), 'Festa house no Portal Kirin com DJ set') // a discount is a price claim too
  assert.equal(pitchLine({ vibeSummary: 'Open bar de chopp até meia-noite' }), '')
})

test('pitch line drops the attendance clause', () => {
  assert.equal(pitchLine({ vibeSummary: 'Show de João Bosco no Teatro Guaíra, auditório de 648 lugares confirmados' }), 'Show de João Bosco no Teatro Guaíra')
  assert.equal(pitchLine({ vibeSummary: 'Show de rock no Bar Crossroads, público confirmado e animado' }), 'Show de rock no Bar Crossroads')
})
