import fsp from 'node:fs/promises'
import path from 'node:path'
import { CLI_ROOTS } from '../paths.js'

// Cursor's IDE keeps a local chat/composer db (state.vscdb, table cursorDiskKV)
// but — verified 2026-07 by raw-scanning the whole db + WAL for token fields —
// current Cursor versions write every bubble's `tokenCount` as {0,0} and leave
// composer `usageData` empty. Real token usage is tracked **server-side only**
// and shown on the cursor.com dashboard. So this parser does not read local
// chat data at all; instead it:
//   1. opens state.vscdb just far enough to read `cursorAuth/accessToken`
//      (the session JWT the IDE itself stores after login), and
//   2. uses that token to call the same CSV export the cursor.com dashboard's
//      "Usage" tab uses, which returns real per-request token counts.
//
// This is the one exception to "no network" in this codebase, added at the
// user's explicit request after confirming the local files carry no real
// data. The endpoint is UNDOCUMENTED (found via the dashboard's own network
// traffic, not the public https://cursor.com/docs/api) and reverse-engineered:
//   GET https://cursor.com/api/dashboard/export-usage-events-csv
//       ?startDate=0&endDate=<nowMs>&strategy=tokens
//   Cookie: WorkosCursorSessionToken=<userId>::<jwt>   (userId = jwt.sub's "|"-suffix)
// Returns CSV, one row per request, columns include Date, Model,
// "Input (w/ Cache Write)" (cache-creation tokens), "Input (w/o Cache Write)"
// (fresh input), "Cache Read", "Output Tokens", "Total Tokens" — confirmed
// Total = sum of the four token columns. No conversationId/project is
// included, so all cloud records are attributed to a single synthetic
// project/session ('cursor'/'cloud') rather than per-conversation.
// A sibling JSON endpoint (get-filtered-usage-events) returns the same data
// plus conversationId, but only accepts short (~7 day) date ranges and started
// 403-ing after a handful of rapid calls during testing — the CSV export
// tolerated a full-history (startDate=0) call fine, so it's what's used here.
// Re-validate both the endpoint and the column names after Cursor updates —
// this can change or disappear with no notice since it isn't a public API.
//
// Fetches are cached per account (keyed by the JWT's user id, since an
// account's usage is identical regardless of which device's token fetched
// it) and throttled to at most once every 15 minutes to stay well clear of
// whatever rate limit produced the 403s above.

function decodeJwt(token) {
  try {
    const [, payloadB64] = token.split('.')
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

// Cursor's SQLite database can become enormous (multi-gigabyte on active
// installs). Loading it into sql.js first requires one Buffer for the entire
// file, while Node's fs.readFile rejects files at 2 GiB. The ItemTable record
// stores this key immediately before its JWT value, so locate and validate that
// small record with bounded, overlapping reads instead. This also keeps the
// parser free of native SQLite modules that need Electron-specific rebuilds.
const ACCESS_TOKEN_KEY = Buffer.from('cursorAuth/accessToken')
const TOKEN_LOOKAHEAD = 2048
const TOKEN_SCAN_CHUNK = 256 * 1024
const TOKEN_SCAN_LIMIT = 256 * 1024 * 1024
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g

export async function readAccessToken(file) {
  const handle = await fsp.open(file, 'r')
  try {
    const stat = await handle.stat()
    const limit = Math.min(stat.size, TOKEN_SCAN_LIMIT)
    const chunk = Buffer.allocUnsafe(TOKEN_SCAN_CHUNK)
    const overlapSize = ACCESS_TOKEN_KEY.length + TOKEN_LOOKAHEAD
    let overlap = Buffer.alloc(0)
    let position = 0

    while (position < limit) {
      const length = Math.min(chunk.length, limit - position)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (!bytesRead) break
      const block = overlap.length
        ? Buffer.concat([overlap, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead)

      let from = 0
      while (from < block.length) {
        const keyAt = block.indexOf(ACCESS_TOKEN_KEY, from)
        if (keyAt < 0) break
        const valueStart = keyAt + ACCESS_TOKEN_KEY.length
        const text = block.subarray(valueStart, Math.min(block.length, valueStart + TOKEN_LOOKAHEAD)).toString('latin1')
        for (const match of text.matchAll(JWT_RE)) {
          const token = match[0]
          if (decodeJwt(token)?.sub) return token
        }
        from = valueStart
      }

      overlap = Buffer.from(block.subarray(Math.max(0, block.length - overlapSize)))
      position += bytesRead
    }
    return null
  } finally {
    await handle.close()
  }
}

// Minimal CSV line parser. The export quotes data-row fields ("a","b") but
// *not* the header row (a,b) — a naive split on `","` misparses the header
// into one field and silently drops every row, so this walks char-by-char
// and handles both quoted and unquoted fields (plus doubled-quote escapes).
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out
}

function parseUsageCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0])
  const col = Object.fromEntries(header.map((h, i) => [h, i]))
  const records = []
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const ts = Date.parse(cells[col['Date']])
    const total = Number(cells[col['Total Tokens']])
    if (!ts || !total) continue // errored/no-usage rows leave the token columns blank
    const model = cells[col['Model']] || 'auto'
    records.push({
      cli: 'cursor',
      ts,
      model,
      sessionId: 'cloud',
      project: 'cursor',
      input: Number(cells[col['Input (w/o Cache Write)']]) || 0,
      output: Number(cells[col['Output Tokens']]) || 0,
      cacheRead: Number(cells[col['Cache Read']]) || 0,
      cacheCreate: Number(cells[col['Input (w/ Cache Write)']]) || 0,
      reasoning: 0,
      total,
      dedupKey: `cursor-cloud:${ts}:${model}:${total}`,
    })
  }
  return records
}

async function fetchUsageCsv(token) {
  const payload = decodeJwt(token)
  if (!payload?.sub) return []
  if (payload.exp && payload.exp * 1000 < Date.now()) return [] // stale session; needs a fresh IDE login
  const userId = String(payload.sub).split('|').pop()
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(userId + '::' + token)}`
  const url = `https://cursor.com/api/dashboard/export-usage-events-csv?startDate=0&endDate=${Date.now()}&strategy=tokens`
  const res = await fetch(url, { headers: { Cookie: cookie, Accept: 'text/csv,*/*' } })
  if (!res.ok) throw new Error(`cursor usage export HTTP ${res.status}`)
  return parseUsageCsv(await res.text())
}

// Cursor's monthly included-usage quota, from the same surface the dashboard's
// Spending page (cursor.com/dashboard/spending) uses. Unlike the CSV export this
// carries the plan's billing cycle and % consumed — `totalPercentUsed` is the
// "Total" figure on that page (auto/api are its sub-breakdowns). Returned in the
// standard live-window shape so it can overlay the Cursor plan's monthly window.
function parseUsageSummary(json) {
  const p = json?.individualUsage?.plan
  if (!p || typeof p.totalPercentUsed !== 'number') return []
  const used = Math.max(0, Math.min(100, p.totalPercentUsed))
  const start = Date.parse(json.billingCycleStart)
  const end = Date.parse(json.billingCycleEnd)
  return [
    {
      label: 'monthly',
      windowMinutes: Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 60000) : 43200,
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      resetsAt: Number.isFinite(end) ? end : null,
    },
  ]
}

async function fetchUsageSummary(token) {
  const payload = decodeJwt(token)
  if (!payload?.sub) return []
  if (payload.exp && payload.exp * 1000 < Date.now()) return []
  const userId = String(payload.sub).split('|').pop()
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(userId + '::' + token)}`
  const res = await fetch('https://cursor.com/api/usage-summary', { headers: { Cookie: cookie, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`cursor usage-summary HTTP ${res.status}`)
  return parseUsageSummary(await res.json())
}

const MIN_FETCH_INTERVAL_MS = 15 * 60 * 1000
const cacheByUser = new Map() // userId -> { records, fetchedAt }

// Newest monthly quota window (used %, reset), refreshed on the same 15-min
// cadence as the CSV fetch. Read by the `cursor:limits` path (via index.js) to
// overlay the Cursor plan's Quota window.
let latestWindows = []
export function cursorResetWindows() {
  return latestWindows
}

async function getCloudRecords(token) {
  const payload = decodeJwt(token)
  const userId = payload?.sub ? String(payload.sub) : 'unknown'
  const entry = cacheByUser.get(userId) || { records: [], fetchedAt: 0 }
  if (Date.now() - entry.fetchedAt < MIN_FETCH_INTERVAL_MS) return entry.records
  entry.fetchedAt = Date.now() // set before awaiting so overlapping triggers don't pile up calls
  cacheByUser.set(userId, entry)
  try {
    entry.records = await fetchUsageCsv(token)
  } catch {
    // undocumented endpoint: keep the previous cache on rate-limit/expired-session/network errors
  }
  try {
    latestWindows = await fetchUsageSummary(token)
  } catch {
    // keep the previous quota window on error (same reasoning as the CSV fetch)
  }
  return entry.records
}

export const cursor = {
  cli: 'cursor',
  roots: CLI_ROOTS.cursor,
  kind: 'path',
  // Usage is fetched over the network (see header comment), not read from the
  // local file — so it must be re-run on a timer, not only when state.vscdb
  // changes on disk. The IDE stops rewriting state.vscdb once it goes idle, so
  // without a timer the last fetch (often the app-startup one) goes stale and
  // newer cloud usage never shows up. This flag opts the parser into the
  // store's periodic refreshNetworkParsers() sweep; the getCloudRecords cache
  // still throttles the real HTTP call to once every 15 min.
  network: true,
  match: (file) => path.basename(file) === 'state.vscdb',
  async parseFile(file) {
    const token = await readAccessToken(file)
    if (!token) return []
    return getCloudRecords(token)
  },
}
