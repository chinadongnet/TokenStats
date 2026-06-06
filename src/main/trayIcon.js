import { nativeImage } from 'electron'

// Render the tray icon at runtime as a raw BGRA bitmap so the app needs no
// image asset files. Draws a filled rounded square with a small "pulse" bar,
// tinted by activity. size is in physical pixels (32 works for 1x/1.25x DPI).
export function makeTrayIcon({ size = 32, color = [217, 119, 87], active = false } = {}) {
  const buf = Buffer.alloc(size * size * 4)
  const [r, g, b] = color
  const radius = size * 0.28
  const cx = size / 2
  const cy = size / 2
  const half = size * 0.34 // square half-extent

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dx = Math.abs(x + 0.5 - cx)
      const dy = Math.abs(y + 0.5 - cy)
      // rounded-rect signed distance
      const qx = dx - (half - radius)
      const qy = dy - (half - radius)
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
      const inside = Math.min(Math.max(qx, qy), 0)
      const d = outside + inside
      const alpha = clamp01(0.5 - d) // ~1px antialiased edge

      let pr = r
      let pg = g
      let pb = b
      // draw three little bars (a mini chart) in white inside the square
      const inBars = bars(x, y, size)
      if (inBars) {
        pr = pg = pb = 245
      }
      // premultiplied BGRA
      buf[i] = Math.round(pb * alpha)
      buf[i + 1] = Math.round(pg * alpha)
      buf[i + 2] = Math.round(pr * alpha)
      buf[i + 3] = Math.round(255 * alpha)
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
  return img
}

function bars(x, y, size) {
  const s = size
  const heights = [0.32, 0.55, 0.42]
  const barW = s * 0.12
  const gap = s * 0.07
  const groupW = heights.length * barW + (heights.length - 1) * gap
  const startX = (s - groupW) / 2
  const baseY = s * 0.66
  for (let k = 0; k < heights.length; k++) {
    const bx = startX + k * (barW + gap)
    const bh = s * heights[k]
    if (x >= bx && x < bx + barW && y >= baseY - bh && y < baseY) return true
  }
  return false
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
