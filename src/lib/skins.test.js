import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SKINS, DEFAULT_SKIN, getSkin, setSkin, applySkin, isSkin } from './skins'

// WCAG 2.x relative luminance and contrast ratio.
function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')

function cssBlock(id) {
  if (id === DEFAULT_SKIN) return css.slice(css.indexOf(':root {'), css.indexOf('/* Legacy semantic vars'))
  const start = css.indexOf(`:root[data-skin="${id}"]`)
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
}
function cssVar(block, name) {
  return block.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toUpperCase()
}

describe('skins', () => {
  it('has unique ids and Neon Boteco first as the default', () => {
    expect(SKINS[0].id).toBe(DEFAULT_SKIN)
    expect(new Set(SKINS.map((s) => s.id)).size).toBe(SKINS.length)
  })

  for (const skin of SKINS) {
    describe(skin.name, () => {
      const block = cssBlock(skin.id)
      const s = skin.swatch

      it('swatch matches globals.css', () => {
        expect(block).not.toBe('')
        expect(cssVar(block, 'bg')).toBe(s.bg.toUpperCase())
        expect(cssVar(block, 'magenta')).toBe(s.primary.toUpperCase())
        expect(cssVar(block, 'cyan')).toBe(s.secondary.toUpperCase())
        expect(cssVar(block, 'lime')).toBe(s.yes.toUpperCase())
        expect(cssVar(block, 'text')).toBe(s.text.toUpperCase())
        expect(cssVar(block, 'text3')).toBe(s.text3.toUpperCase())
      })

      it('declares the ink it promises on its fills', () => {
        if (skin.id === DEFAULT_SKIN) return // neon inherits --on-* from :root
        const ink = (name) => block.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toUpperCase()
        expect(ink('on-magenta')).toBe(s.ink.toUpperCase())
        if (skin.light) {
          expect(ink('on-lime')).toBe(s.accentInk.toUpperCase())
          expect(ink('on-cyan')).toBe(s.accentInk.toUpperCase())
        }
      })

      it('every hex token has a matching rgb twin', () => {
        for (const [hex, rgb] of [['bg', 'bg-rgb'], ['magenta', 'magenta-rgb'], ['cyan', 'cyan-rgb'], ['lime', 'lime-rgb']]) {
          const h = cssVar(block, hex)
          const twin = block.match(new RegExp(`--${rgb}:\\s*(\\d+) (\\d+) (\\d+);`))
          expect(twin, `${skin.id} --${rgb}`).toBeTruthy()
          const expected = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
          expect(twin.slice(1, 4).map(Number), `${skin.id} --${rgb}`).toEqual(expected)
        }
      })

      it('is readable', () => {
        expect(contrast(s.text, s.bg)).toBeGreaterThanOrEqual(7)
        expect(contrast(s.text3, s.bg)).toBeGreaterThanOrEqual(3)
        // Accents as text on the page, and the ink on filled accents.
        for (const accent of [s.primary, s.secondary, s.yes]) {
          expect(contrast(accent, s.bg)).toBeGreaterThanOrEqual(4.5)
        }
        expect(contrast(s.accentInk, s.yes)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(s.accentInk, s.secondary)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(s.ink, s.primary)).toBeGreaterThanOrEqual(4.5)
      })
    })
  }
})

describe('skin persistence', () => {
  const memory = () => {
    const m = new Map()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }
  }

  it('falls back to the default for unknown, missing or unreadable values', () => {
    const st = memory()
    expect(getSkin(st)).toBe(DEFAULT_SKIN)
    st.setItem('aue_skin', 'vaporwave')
    expect(getSkin(st)).toBe(DEFAULT_SKIN)
    expect(getSkin({ getItem: () => { throw new Error('blocked') } })).toBe(DEFAULT_SKIN)
  })

  it('remembers a valid choice', () => {
    const st = memory()
    expect(setSkin('garoa', st, null)).toBe('garoa')
    expect(getSkin(st)).toBe('garoa')
    expect(isSkin('garoa')).toBe(true)
  })

  it('sets data-skin and theme-color, and clears the attribute for the default', () => {
    const attrs = {}
    const meta = { content: '', setAttribute: (_k, v) => { meta.content = v } }
    const doc = {
      documentElement: {
        setAttribute: (k, v) => { attrs[k] = v },
        removeAttribute: (k) => { delete attrs[k] },
      },
      querySelector: () => meta,
    }
    applySkin('garoa-clara', doc)
    expect(attrs['data-skin']).toBe('garoa-clara')
    expect(meta.content).toBe('#EEF2F5')
    applySkin('neon', doc)
    expect(attrs['data-skin']).toBeUndefined()
    expect(meta.content).toBe('#0A0510')
  })
})
