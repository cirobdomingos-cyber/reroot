/**
 * One-shot render of the auê app icons from public/icon.svg.
 *
 * Outputs:
 *   - public/icon-{192,512,1024}x.png (PWA manifest fallbacks)
 *   - ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
 *     (iOS native app icon — 1024×1024 universal, all sizes derived
 *      from this single asset since iOS 15+)
 *
 * Wiring this into the CI workflow's pre-Archive step keeps the
 * TestFlight icon in sync with the SVG forever — no manual Xcode dance
 * when we tweak the brand.
 *
 * Run locally:
 *   npm i -D sharp     # one-time
 *   node scripts/render-icons.js
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SVG_PATH = path.join(ROOT, 'public', 'icon.svg')
const SIZES = [192, 512, 1024]

const IOS_ICON_DIR = path.join(
  ROOT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset',
)
const IOS_ICON_PATH = path.join(IOS_ICON_DIR, 'AppIcon-512@2x.png')

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

  // iOS native app icon — copy the 1024×1024 we just rendered into the
  // Xcode asset catalog. The iOS folder might not exist on a fresh
  // checkout that hasn't run `npx cap add ios`, so guard the copy.
  try {
    await mkdir(IOS_ICON_DIR, { recursive: true })
    await copyFile(
      path.join(ROOT, 'public', 'icon-1024x1024.png'),
      IOS_ICON_PATH,
    )
    console.log(`✓ ${path.relative(ROOT, IOS_ICON_PATH)}`)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    console.warn(`(skipped iOS icon copy: ${IOS_ICON_DIR} not present)`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
