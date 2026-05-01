// ── Image compression for uploads ─────────────────────────
// Why this exists:
// - Modern iPhone photos are 8–15MB HEIC; backend caps uploads at 8MB.
// - Backend also rejects formats other than JPG/PNG/WebP/GIF/HEIC.
// - Web/Android browsers can't render HEIC, so even when the backend
//   accepts it, recipients on those platforms see a broken image.
//
// Strategy: client-side decode via <img> (Safari decodes HEIC natively;
// other browsers fail and we send the original through), draw to canvas,
// re-encode as JPEG with iterative quality reduction until under the cap.
// Keeps photos visually fine while cutting size by 5–10x typically.

const MAX_DIMENSION = 2400          // px on longest side; matches "high res"
const MAX_BYTES_AFTER_COMPRESS = 4 * 1024 * 1024  // 4MB — well under 8MB cap

/**
 * Compress an image File for upload. Returns a new File (JPEG) when
 * compression succeeds, or the original File when:
 *  - The browser can't decode the input (e.g. HEIC on Chrome desktop).
 *    The caller's upload code passes it through as-is.
 *  - The image is already small (<1MB) — no benefit to re-encoding.
 */
export async function compressImageForUpload(file) {
  if (!file || !file.type?.startsWith('image/')) return file
  // Skip compression for already-small images. 1MB is a heuristic — most
  // already-compressed JPEG/WebP files land under that.
  if (file.size < 1024 * 1024) return file

  let bitmap
  try {
    // createImageBitmap handles JPEG/PNG/WebP/GIF natively in every modern
    // browser AND HEIC on Safari (iOS WKWebView, macOS Safari). On other
    // browsers HEIC throws, which is fine — we let the caller upload the
    // original file and the backend rejects/accepts based on its own rules.
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }

  const { width, height } = bitmap
  const longest = Math.max(width, height)
  const scale = longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()

  // Iteratively drop quality until we're under the byte cap. Floor at
  // 0.55 so we never produce visibly mushy images — if we can't get
  // small enough at that quality, return what we have (still smaller
  // than the input most of the time).
  let quality = 0.85
  let blob = await canvasToBlob(canvas, quality)
  while (blob && blob.size > MAX_BYTES_AFTER_COMPRESS && quality > 0.55) {
    quality -= 0.1
    blob = await canvasToBlob(canvas, quality)
  }
  if (!blob) return file

  // Rename to .jpg since we re-encoded as JPEG. Backend uses the
  // content-type, not the filename, but a sensible name helps users
  // when they download the image later.
  const newName = file.name.replace(/\.[^.]+$/, '') + '.jpg'
  return new File([blob], newName, {
    type: 'image/jpeg',
    lastModified: Date.now(),
  })
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
  })
}
