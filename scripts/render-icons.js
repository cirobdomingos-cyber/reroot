/**
 * One-shot render of the auê app icons from public/icon.svg.
 *
 * Why: PWA manifest references icon-192x192.png, icon-512x512.png, and
 * icon-1024x1024.png. When the SVG changes (rebrand, tweak), those PNGs
 * have to be regenerated — most browsers prefer the SVG on install but
 * Android home-screen icons sometimes still pick the PNG.
 *
 * Run:
 *   npm i -D sharp
 *   node scripts/render-icons.js
 *
 * Outputs to public/icon-{size}.png.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SVG_PATH = path.join(ROOT, 'public', 'icon.svg')
const SIZES = [192, 512, 1024]

async function main() {
  let sharp
  try {
    ({ default: sharp } = await import('sharp'))
  } catch {
    console.error('sharp is not installed. Run: npm i -D sharp')
    process.exit(1)
  }

  const svg = await readFile(SVG_PATH)
  for (const size of SIZES) {
    const out = path.join(ROOT, 'public', `icon-${size}x${size}.png`)
    await sharp(svg, { density: 300 })
      .resize(size, size)
      .png()
      .toFile(out)
    console.log(`✓ ${path.relative(ROOT, out)}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
