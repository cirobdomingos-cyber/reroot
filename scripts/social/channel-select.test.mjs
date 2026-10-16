// node --test scripts/social/
// Picking rules for the channels carousel, on a small fixture.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectChannels, handleOf, channelTitle } from './channel-select.mjs'

const W = { from: '2026-10-16', to: '2026-10-18' }
let n = 0
function ev({ day = '2026-10-16', time = '21:00', handle, name, ...rest } = {}) {
  n += 1
  return {
    id: `e${n}`, name: name || `Evento ${n}`, venue: `Lugar ${handle || n}`, time,
    dateStart: `${day}T${time}:00-03:00`, dateEnd: `${day}T23:30:00-03:00`,
    igHandle: null, sourceIgHandle: handle || `lugar${n}`, city: 'Curitiba', ...rest,
  }
}
const ch = (name, events) => ({ channel: { id: `grp_${name}`, name: `auê ${name}` }, events })

test('handles lose the importer dedup suffix; titles lose the auê prefix', () => {
  assert.equal(handleOf({ sourceIgHandle: 'torkandroll_denj73' }), 'torkandroll')
  assert.equal(handleOf({ sourceIgHandle: 'ceu.bar' }), 'ceu.bar')
  assert.equal(channelTitle('auê Samba e Pagode'), 'Samba e Pagode')
})

test('the same show posted three times counts once; two sessions count twice', () => {
  const { slides } = selectChannels([ch('Rock', [
    ev({ handle: 'tork', name: 'Texas Experience' }), ev({ handle: 'tork', name: 'Pay In Cash' }),
    ev({ handle: 'tork', name: 'Texas Experience com Pay In Cash' }), ev({ handle: 'tork', time: '23:00' }),
  ])], W)
  assert.equal(slides[0].total, 2)
  assert.equal(slides[0].picks[0].name, 'Pay In Cash')
})

test('a night shared by two channels goes to the smaller one; tiny channels are skipped', () => {
  const shared = { handle: 'casa', day: '2026-10-17', name: 'Lançamento' }
  const { slides, skipped } = selectChannels([
    ch('Cultura', [ev(shared), ev(), ev(), ev({ day: '2026-10-18' })]),
    ch('Livros', [ev(shared), ev({ day: '2026-10-18' })]),
    ch('Comédia', [ev()]),
  ], W)
  assert.deepEqual(slides.map((s) => s.title), ['Cultura', 'Livros'])
  assert.ok(slides[1].picks.some((e) => e.name === 'Lançamento'))
  assert.ok(!slides[0].picks.some((e) => e.name === 'Lançamento'))
  assert.equal(skipped[0].title, 'Comédia')
})

test('evening events and spread days win; excluded and out-of-town events never show', () => {
  const morning = ev({ time: '09:00', name: 'Curso de manhã' })
  const gone = ev({ day: '2026-10-17' })
  const { slides } = selectChannels([ch('Cultura', [
    morning, ev({ time: '20:00' }), gone, ev({ day: '2026-10-17', time: '19:00' }),
    ev({ day: '2026-10-18', name: 'Show em Londrina' }), ev({ day: '2026-10-18', time: '18:00' }),
  ])], { ...W, excludeIds: [gone.id] })
  const picks = slides[0].picks
  assert.equal(picks.length, 3)
  assert.deepEqual(picks.map((e) => e.dateStart.slice(0, 10)), ['2026-10-16', '2026-10-17', '2026-10-18'])
  assert.ok(!picks.some((e) => e.id === gone.id || e.id === morning.id || /Londrina/.test(e.name)))
})

test('a night is grouped by place or by name, but one shared word across venues is not enough', () => {
  const { slides } = selectChannels([ch('MPB', [
    ev({ handle: 'teatro', name: 'Roberto Carlos no Teatro', time: '20:00' }),
    ev({ handle: 'curitibacult', venue: 'Curitiba', name: 'Roberto Carlos', time: '21:00' }),
    ev({ handle: 'cine', name: 'Temporada do Terror - Carrie', time: '19:00', day: '2026-10-17' }),
    ev({ handle: 'lala', name: 'A Casa do Terror', time: '19:00', day: '2026-10-17' }),
    ev({ handle: 'tork', name: 'Black Bulls', time: '22:00' }),
    ev({ handle: 'tork', name: 'Texas Experience — Jack Vermouth', day: '2026-10-17', time: '00:30' }),
    ev({ handle: 'tork', name: 'Texas Experience', time: '20:30' }),
  ])], W)
  // Roberto Carlos x2 -> 1, Carrie and Casa do Terror -> 2, the Tork night -> 1
  assert.equal(slides[0].total, 4)
})
