/**
 * One-shot render of the auê raster brand assets from their SVG sources.
 *
 * Outputs:
 *   - public/icon-{192,512,1024}x.png (PWA manifest fallbacks)
 *   - public/og-image.png (1200×630 link preview card — unfurlers don't
 *     render SVG, most reject it outright, so og:image must be a PNG)
 *   - ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
 *     (iOS native app icon — 1024×1024 universal, all sizes derived
 *      from this single asset since iOS 15+)
 *   - android/app/src/main/res/mipmap-*dpi/ic_launcher{,_round,_foreground}.png
 *     (legacy square + round launcher icons, and the adaptive icon's
 *      foreground layer; the background layer is the color in
 *      values/ic_launcher_background.xml)
 *   - android/app/src/main/res/drawable{,-port-*,-land-*}/splash.png
 *     (pre-Android-12 launch screen; 12+ draws the adaptive foreground
 *      on windowSplashScreenBackground, see values/styles.xml)
 *
 * Wiring this into the CI workflows (TestFlight pre-Archive, Google Play
 * pre-build) keeps both store icons in sync with the SVG forever — no
 * manual Xcode or Android Studio dance when we tweak the brand. Until
 * Oct 2026 Android still shipped the old Reroot leaf from the Capacitor
 * scaffold, splash included.
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

const OG_SVG_PATH = path.join(ROOT, 'public', 'og-image.svg')
const OG_PNG_PATH = path.join(ROOT, 'public', 'og-image.png')
const OG_SIZE = { width: 1200, height: 630 }

const IOS_ICON_DIR = path.join(
  ROOT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset',
)
const IOS_ICON_PATH = path.join(IOS_ICON_DIR, 'AppIcon-512@2x.png')

const ANDROID_RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
// The icon's own background (the <rect> in icon.svg). Android's adaptive
// background layer and the splash use the same color, so the mark sits on
// one continuous field.
const BRAND_BG = '#14081E'
// Launcher icons are 48dp, adaptive layers 108dp, per density bucket.
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
// Adaptive icons: launchers mask the 108dp layer down to as little as a
// 66dp circle. The mark (spark included) must fit inside it, so the art
// is drawn at 66/108 of the layer.
const ADAPTIVE_ART_SCALE = 66 / 108
// Splash: portrait sizes per bucket (landscape is the transpose); the
// mark is drawn at this fraction of the short side.
const SPLASH_PORT = {
  mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280],
  xxhdpi: [960, 1600], xxxhdpi: [1280, 1920],
}
const SPLASH_MARK = 0.42

/** icon.svg without its background rect: the mark on transparency. */
function markOnly(svg) {
  const out = svg.toString().replace(/<rect\b[^>]*\/>/, '')
  if (out === svg.toString()) throw new Error('icon.svg: background <rect> not found')
  return Buffer.from(out)
}

async function renderMark(sharp, markSvg, size) {
  return sharp(markSvg, { density: 300 }).resize(size, size).png().toBuffer()
}

async function renderAndroid(sharp, svg) {
  try {
    await readFile(path.join(ANDROID_RES, 'values', 'styles.xml'))
  } catch {
    console.warn(`(skipped Android icons: ${ANDROID_RES} not present)`)
    return
  }
  const mark = markOnly(svg)

  for (const [bucket, scale] of Object.entries(DENSITIES)) {
    const dir = path.join(ANDROID_RES, `mipmap-${bucket}`)
    await mkdir(dir, { recursive: true })

    // Legacy launcher icon (pre-Android 8, and launchers that ignore
    // adaptive icons): the full square icon, the OS masks it.
    const legacy = Math.round(48 * scale)
    await sharp(svg, { density: 300 }).resize(legacy, legacy).png()
      .toFile(path.join(dir, 'ic_launcher.png'))

    // Round variant: the same art clipped to a circle, transparent corners.
    const circle = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${legacy}" height="${legacy}">` +
      `<circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}" fill="#fff"/></svg>`,
    )
    await sharp(svg, { density: 300 }).resize(legacy, legacy)
      .composite([{ input: circle, blend: 'dest-in' }])
      .png().toFile(path.join(dir, 'ic_launcher_round.png'))

    // Adaptive foreground: 108dp transparent layer, mark in the safe zone.
    const layer = Math.round(108 * scale)
    const art = Math.round(layer * ADAPTIVE_ART_SCALE)
    const offset = Math.round((layer - art) / 2)
    await sharp({
      create: { width: layer, height: layer, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: await renderMark(sharp, mark, art), left: offset, top: offset }])
      .png().toFile(path.join(dir, 'ic_launcher_foreground.png'))
  }
  console.log(`✓ ${path.relative(ROOT, ANDROID_RES)}/mipmap-*/ic_launcher{,_round,_foreground}.png`)

  const splash = async (w, h, file) => {
    const size = Math.round(Math.min(w, h) * SPLASH_MARK)
    await mkdir(path.dirname(file), { recursive: true })
    await sharp({ create: { width: w, height: h, channels: 4, background: BRAND_BG } })
      .composite([{
        input: await renderMark(sharp, mark, size),
        left: Math.round((w - size) / 2), top: Math.round((h - size) / 2),
      }])
      .png().toFile(file)
  }
  for (const [bucket, [w, h]] of Object.entries(SPLASH_PORT)) {
    await splash(w, h, path.join(ANDROID_RES, `drawable-port-${bucket}`, 'splash.png'))
    await splash(h, w, path.join(ANDROID_RES, `drawable-land-${bucket}`, 'splash.png'))
  }
  await splash(480, 320, path.join(ANDROID_RES, 'drawable', 'splash.png'))
  console.log(`✓ ${path.relative(ROOT, ANDROID_RES)}/drawable*/splash.png`)
}

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

  await renderAndroid(sharp, svg)

  // Link preview card. Rendered at its exact final size rather than
  // resized from a square — 1200×630 is the ratio every unfurler crops
  // to, and letting sharp resize would letterbox it.
  const ogSvg = await readFile(OG_SVG_PATH)
  await sharp(ogSvg, { density: 300 })
    .resize(OG_SIZE.width, OG_SIZE.height)
    .png()
    .toFile(OG_PNG_PATH)
  console.log(`✓ ${path.relative(ROOT, OG_PNG_PATH)}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
