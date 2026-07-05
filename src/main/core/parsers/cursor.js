import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { CLI_ROOTS } from '../paths.js'

const require = createRequire(import.meta.url)

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

let sqlPromise = null
function getSql() {
  if (!sqlPromise) {
    const initSqlJs = require('sql.js')
    const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
    sqlPromise = initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) })
  }
  return sqlPromise
}

function toText(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return Buffer.from(value).toString('utf8')
  } catch {
    return null
  }
}

function decodeJwt(token) {
  try {
    const [, payloadB64] = token.split('.')
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
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

const MIN_FETCH_INTERVAL_MS = 15 * 60 * 1000
const cacheByUser = new Map() // userId -> { records, fetchedAt }

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
  return entry.records
}

export const cursor = {
  cli: 'cursor',
  roots: CLI_ROOTS.cursor,
  kind: 'binary',
  match: (file) => path.basename(file) === 'state.vscdb',
  async parseFile(buf) {
    const SQL = await getSql()
    let db
    try {
      db = new SQL.Database(buf)
    } catch {
      return []
    }
    let token = null
    try {
      const res = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
      token = toText(res[0]?.values?.[0]?.[0])
    } catch {
      // ItemTable missing/schema changed
    } finally {
      db.close()
    }
    if (!token) return []
    return getCloudRecords(token)
  },
}
