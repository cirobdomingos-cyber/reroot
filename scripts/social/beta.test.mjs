import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingLabel, buildBetaCaption, STEPS, TESTERS_NEEDED, TEST_DAYS } from './beta.mjs'

test('the count reads the testers still missing, or the whole goal', () => {
  assert.equal(missingLabel(null), `${TESTERS_NEEDED} pessoas · ${TEST_DAYS} dias`)
  assert.equal(missingLabel(9), 'faltam 9 pessoas')
  assert.equal(missingLabel(1), 'falta 1 pessoa')
  assert.equal(missingLabel(0), 'meta batida, valeu!')
})

test('the caption lists the four page steps and asks for the 14 days', () => {
  const c = buildBetaCaption({ missing: 9 })
  for (const s of STEPS) assert.ok(c.includes(s.title), s.title)
  assert.ok(c.includes('Faltam 9 pessoas com Android.'))
  assert.ok(c.includes(`${TEST_DAYS} dias`))
  assert.ok(c.includes('App Store') && c.includes('Android'), 'both platforms named')
  assert.ok(buildBetaCaption().includes(`Precisamos de ${TESTERS_NEEDED} pessoas com Android.`))
})

test('post rules: você, never tu / teu / tua, and no "Bora porque"', () => {
  const c = buildBetaCaption({ missing: 3 })
  assert.doesNotMatch(c, /\b(tu|teu|tua)\b/i)
  assert.doesNotMatch(c, /bora porque/i)
})
