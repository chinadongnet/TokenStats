// Render a public-safe SVG token-usage card from the local TokenStats snapshot.
// TOKENS ONLY — no cost figures are emitted (the profile README is public).
//
//   node scripts/profile-card.mjs [outPath]
//
// Default output: out/profile/tokenstats-card.svg
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/main/core/store.js'
import { CLI_META, CLIS } from '../src/main/core/paths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../out/profile/tokenstats-card.svg')

const compact = (n) => {
  n = Number(n) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const store = new Store()
await store.scanAll()
const snap = store.snapshot()

// Per-CLI token totals (no cost), highest first, drop empty CLIs.
const rows = CLIS.map((c) => ({
  cli: c,
  label: CLI_META[c].label,
  color: CLI_META[c].color,
  total: snap.perCli[c]?.total || 0,
})).filter((r) => r.total > 0).sort((a, b) => b.total - a.total)

const grandTotal = snap.totals.all.total
const todayTotal = snap.totals.today.total
const barMax = Math.max(1, ...rows.map((r) => r.total))

// 30-day daily totals -> mini sparkline bars.
const days = snap.perDay // [{day, total, ...}]
const dayMax = Math.max(1, ...days.map((d) => d.total))

// ---- layout ----
const W = 500
const padX = 26
const rowH = 34
const rowsTop = 150
const trendTop = rowsTop + rows.length * rowH + 14
const trendH = 46
const H = trendTop + trendH + 48

const trackX = 190
const trackW = W - padX - trackX - 64 // leave room for the number on the right

// per-CLI bar rows
const cliBars = rows
  .map((r, i) => {
    const y = rowsTop + i * rowH
    const w = Math.max(3, (trackW * r.total) / barMax)
    return `
    <g transform="translate(${padX}, ${y})">
      <circle cx="6" cy="9" r="6" fill="${r.color}" />
      <text x="22" y="13" class="lbl">${esc(r.label)}</text>
      <rect x="${trackX - padX}" y="2" width="${trackW}" height="14" rx="7" class="track" />
      <rect x="${trackX - padX}" y="2" width="${w}" height="14" rx="7" fill="${r.color}" />
      <text x="${W - padX * 2}" y="13" class="num" text-anchor="end">${compact(r.total)}</text>
    </g>`
  })
  .join('')

// mini trend bars
const n = days.length || 1
const slot = (W - padX * 2) / n
const bw = Math.max(2, slot * 0.6)
const trendBars = days
  .map((d, i) => {
    const h = Math.max(1, (trendH - 6) * (d.total / dayMax))
    const x = padX + slot * i + (slot - bw) / 2
    const y = trendTop + (trendH - h)
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="#3a4150" />`
  })
  .join('')

const updated = new Date(snap.generatedAt).toLocaleDateString('en-CA') // YYYY-MM-DD

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="AI coding token usage">
  <style>
    .bg { fill: #14161b; }
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .title { fill: #e6e8ec; font-size: 18px; font-weight: 700; }
    .sub { fill: #8b929e; font-size: 11px; }
    .hero { fill: #e6e8ec; font-size: 40px; font-weight: 800; }
    .herolbl { fill: #8b929e; font-size: 12px; }
    .lbl { fill: #c5cbd6; font-size: 13px; }
    .num { fill: #e6e8ec; font-size: 13px; font-weight: 700; }
    .track { fill: #232730; }
    .foot { fill: #6b7280; font-size: 10px; }
  </style>
  <rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" />
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="#232730" />

  <text class="title" x="${padX}" y="40">AI Coding · Token Usage</text>
  <text class="sub" x="${padX}" y="58">tracked locally by TokenStats · ${rows.length} CLIs</text>

  <text class="hero" x="${padX}" y="116">${compact(grandTotal)}</text>
  <text class="herolbl" x="${padX}" y="134">tokens all-time · ${compact(todayTotal)} today</text>

  ${cliBars}

  <text class="sub" x="${padX}" y="${trendTop - 6}">Last ${days.length} days</text>
  ${trendBars}

  <text class="foot" x="${padX}" y="${H - 20}">Updated ${updated} · counts are de-duplicated, local-only · github.com/chinadongnet/TokenStats</text>
</svg>
`

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, svg)
console.log('wrote', outPath, `(${svg.length} bytes)`)
console.log('grand total:', compact(grandTotal), '| today:', compact(todayTotal))
for (const r of rows) console.log('  ', r.label.padEnd(14), compact(r.total))
