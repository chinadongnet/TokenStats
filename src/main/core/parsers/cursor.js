import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { CLI_ROOTS, CONFIG_DIR } from '../paths.js'

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
// it). Successful requests use a 20-second minimum interval; HTTP 403/429
// backs off for 15 minutes while keeping the previously archived records.

function decodeJwtPart(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function decodeJwt(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 3) return null
  return decodeJwtPart(parts[1])
}

// SQLite B-tree leaf cells pack the next cell's varint header (payload_size,
// rowid) immediately after the previous cell's value with no delimiter. When
// those varint bytes happen to fall in [A-Za-z0-9_-] (e.g. 0x33 0x74 = "3t"),
// a greedy regex appends them to the JWT signature and cursor.com returns 401.
// HS256 (32-byte HMAC-SHA256) signatures are always 43 base64url chars.
function normalizeJwt(rawToken) {
  const parts = String(rawToken || '').split('.')
  if (parts.length !== 3) return null
  const header = decodeJwtPart(parts[0])
  const payload = decodeJwtPart(parts[1])
  if (!payload?.sub) return null
  let sig = parts[2]
  if (header?.alg === 'HS256' && sig.length > 43) {
    sig = sig.slice(0, 43)
  }
  return `${parts[0]}.${parts[1]}.${sig}`
}

function isTokenExpired(payload, nowMs = Date.now()) {
  return Boolean(payload?.exp && payload.exp * 1000 <= nowMs)
}

function tokenTimestamp(payload) {
  return Number(payload?.time) || Number(payload?.iat) || Number(payload?.exp) || 0
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
const TOKEN_SCAN_LIMIT = 512 * 1024 * 1024
const DIRECT_JWT_RE = /^[\x00-\x20"']*(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/

function extractCandidateFromBlock(block, keyAt) {
  const valueStart = keyAt + ACCESS_TOKEN_KEY.length
  // In SQLite's ItemTable record format, the 22-byte key 'cursorAuth/accessToken'
  // has serial type 57 (0x39 = 22 * 2 + 13), followed by the value column's
  // serial-type varint. Index B-tree pages follow 0x39 with a small integer
  // serial type (< 13) for the rowid and carry no JWT value at all.
  if (keyAt >= 2 && block[keyAt - 2] === 0x39 && (block[keyAt - 1] & 0x80) === 0) {
    const serial = block[keyAt - 1]
    if (serial < 13) return null
  }
  if (keyAt >= 3 && block[keyAt - 3] === 0x39 && (block[keyAt - 2] & 0x80) !== 0 && (block[keyAt - 1] & 0x80) === 0) {
    const serial = ((block[keyAt - 2] & 0x7f) << 7) | block[keyAt - 1]
    if (serial >= 13 && (serial - 13) % 2 === 0) {
      const exactLen = (serial - 13) / 2
      if (exactLen >= 32 && exactLen <= TOKEN_LOOKAHEAD && valueStart + exactLen <= block.length) {
        const exactText = block.subarray(valueStart, valueStart + exactLen).toString('latin1')
        const m = exactText.match(DIRECT_JWT_RE)
        if (m) {
          const tok = normalizeJwt(m[1])
          if (tok) return tok
        }
      }
    }
  }
  const text = block.subarray(valueStart, Math.min(block.length, valueStart + TOKEN_LOOKAHEAD)).toString('latin1')
  const match = text.match(DIRECT_JWT_RE)
  if (!match) return null
  return normalizeJwt(match[1])
}

async function scanFileForToken(file, { scanAll = false } = {}) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch {
    return null
  }
  try {
    const stat = await handle.stat()
    const limit = Math.min(stat.size, TOKEN_SCAN_LIMIT)
    const chunk = Buffer.allocUnsafe(TOKEN_SCAN_CHUNK)
    const overlapSize = ACCESS_TOKEN_KEY.length + TOKEN_LOOKAHEAD + 8
    let overlap = Buffer.alloc(0)
    let position = 0
    let bestValid = null
    let bestValidTs = -Infinity
    let expiredFallback = null

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
        // If the key is too close to the end of a non-final chunk, wait for the
        // next chunk's overlap so a split JWT is never truncated mid-token.
        if (position + bytesRead < limit && block.length - valueStart < TOKEN_LOOKAHEAD) break
        const token = extractCandidateFromBlock(block, keyAt)
        if (token) {
          const payload = decodeJwt(token)
          if (payload?.sub) {
            if (!isTokenExpired(payload)) {
              if (!scanAll) return token
              const ts = tokenTimestamp(payload)
              if (ts >= bestValidTs) {
                bestValid = token
                bestValidTs = ts
              }
            } else {
              expiredFallback = token
            }
          }
        }
        from = valueStart
      }

      overlap = Buffer.from(block.subarray(Math.max(0, block.length - overlapSize)))
      position += bytesRead
    }
    return bestValid || expiredFallback
  } finally {
    await handle.close()
  }
}

export async function readAccessToken(file) {
  // Check the WAL first: when Cursor refreshes its auth session while running,
  // the new ItemTable page lands in state.vscdb-wal before checkpointing to
  // state.vscdb. WAL frames are append-only, so scanAll picks the newest one.
  const walToken = await scanFileForToken(file + '-wal', { scanAll: true })
  if (walToken && !isTokenExpired(decodeJwt(walToken))) return walToken
  const dbToken = await scanFileForToken(file, { scanAll: false })
  return dbToken || walToken
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

export function parseUsageCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []
  const header = parseCsvLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim())
  const col = Object.fromEntries(header.map((h, i) => [h, i]))
  if (col.Date == null || col.Model == null || col['Output Tokens'] == null) throw new Error('Unrecognized Cursor CSV columns')
  const records = []
  const occurrences = new Map()
  const number = (s) => Number(String(s || '').replace(/,/g, '')) || 0
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const ts = Date.parse(cells[col['Date']])
    const input = number(cells[col['Input (w/o Cache Write)']])
    const output = number(cells[col['Output Tokens']])
    const cacheRead = number(cells[col['Cache Read']])
    const cacheCreate = number(cells[col['Input (w/ Cache Write)']])
    const total = number(cells[col['Total Tokens']]) || input + output + cacheRead + cacheCreate
    if (!Number.isFinite(ts) || total <= 0) continue
    const model = cells[col['Model']] || 'auto'
    const key = `cursor-cloud:${ts}:${model}:${input}:${output}:${cacheRead}:${cacheCreate}:${total}`
    const occurrence = occurrences.get(key) || 0
    occurrences.set(key, occurrence + 1)
    records.push({
      cli: 'cursor',
      ts,
      model,
      sessionId: 'cloud',
      project: 'cursor',
      input,
      output,
      cacheRead,
      cacheCreate,
      reasoning: 0,
      total,
      dedupKey: `${key}:${occurrence}`,
    })
  }
  return records
}

// Wrap both fetch() and body reading (.text()/.json()) in an explicit timer race.
// In Node/Electron undici, AbortSignal.timeout() can fail to reject a stalled body
// stream, which would otherwise wedge single-flight locks (entry.inFlight) forever.
async function fetchWithTimeout(url, options, timeoutMs, readBody = 'text') {
  const ctrl = new AbortController()
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      const err = new Error(`Cursor request timed out after ${timeoutMs}ms`)
      err.code = 'ETIMEDOUT'
      reject(err)
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, { ...options, signal: ctrl.signal })
        if (!res.ok) throw Object.assign(new Error(`cursor usage HTTP ${res.status}`), { status: res.status })
        const body = readBody === 'json' ? await res.json() : await res.text()
        if (ctrl.signal.aborted) throw new Error('Cursor response aborted on timeout')
        return body
      })(),
      timeoutPromise,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchUsageCsvRange(cookie, startDate, endDate, timeoutMs = 20000) {
  const url = `https://cursor.com/api/dashboard/export-usage-events-csv?startDate=${startDate}&endDate=${endDate}&strategy=tokens`
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await fetchWithTimeout(url, { headers: { Cookie: cookie, Accept: 'text/csv,*/*' } }, timeoutMs, 'text')
      return parseUsageCsv(text)
    } catch (err) {
      lastErr = err
      if ([401, 403, 429].includes(err?.status) || err?.code === 'ETIMEDOUT') break
    }
  }
  throw lastErr
}

async function fetchUsageCsvChunks(cookie, startDate, endDate, chunkMs = 3 * 86400000) {
  const byKey = new Map()
  for (let cursorMs = startDate; cursorMs < endDate; cursorMs += chunkMs) {
    const chunkEnd = Math.min(endDate, cursorMs + chunkMs)
    const rows = await fetchUsageCsvRange(cookie, cursorMs, chunkEnd, 25000)
    for (const r of rows) {
      if (r.ts >= startDate && r.ts <= endDate) byKey.set(r.dedupKey, r)
    }
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts)
}

async function fetchUsageCsv(token, fromMs = 0, { backfillBeforeMs = 0, recentFromMs = 0 } = {}) {
  const payload = decodeJwt(token)
  if (!payload?.sub || (payload.exp && payload.exp * 1000 < Date.now())) throw new Error('Cursor session expired; sign in again')
  const userId = String(payload.sub).split('|').pop()
  const cookie = `WorkosCursorSessionToken=${encodeURIComponent(userId + '::' + token)}`
  const endDate = Date.now()
  const spanMs = fromMs > 0 ? endDate - fromMs : Infinity
  const initialTimeoutMs = fromMs === 0 || spanMs > 5 * 86400000 ? 15000 : 25000
  try {
    const rows = await fetchUsageCsvRange(cookie, fromMs, endDate, initialTimeoutMs)
    return { rows, replacedFromMs: fromMs, backfillBeforeMs: 0 }
  } catch (err) {
    if ([401, 403, 429].includes(err?.status)) throw err
    // Large multi-day or full-history CSV exports can time out on high-volume
    // accounts (~3k events/day). Fall back to bounded 3-day chunks.
    if (fromMs > 0 && spanMs > 86400000) {
      const rows = await fetchUsageCsvChunks(cookie, fromMs, endDate, 3 * 86400000)
      return { rows, replacedFromMs: fromMs, backfillBeforeMs }
    }
    if (fromMs === 0) {
      const historyFloorMs = endDate > Date.UTC(2023, 0, 1) + 90 * 86400000 ? Date.UTC(2023, 0, 1) : 0
      if (backfillBeforeMs > 0) {
        const olderStart = Math.max(historyFloorMs, backfillBeforeMs - 30 * 86400000)
        const olderRows = await fetchUsageCsvChunks(cookie, olderStart, backfillBeforeMs, 3 * 86400000)
        const tailStart = recentFromMs > backfillBeforeMs ? recentFromMs : backfillBeforeMs
        const recentRows = await fetchUsageCsvChunks(cookie, tailStart, endDate, 3 * 86400000)
        return {
          rows: [...olderRows, ...recentRows],
          olderRange: [olderStart, backfillBeforeMs],
          replacedFromMs: tailStart,
          backfillBeforeMs: olderStart > historyFloorMs ? olderStart : 0,
        }
      }
      const partialStart = Math.max(historyFloorMs, endDate - 30 * 86400000)
      const rows = await fetchUsageCsvChunks(cookie, partialStart, endDate, 3 * 86400000)
      return { rows, replacedFromMs: partialStart, backfillBeforeMs: partialStart > historyFloorMs ? partialStart : 0 }
    }
    throw err
  }
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
  const json = await fetchWithTimeout(
    'https://cursor.com/api/usage-summary',
    { headers: { Cookie: cookie, Accept: 'application/json' } },
    10000,
    'json'
  )
  return parseUsageSummary(json)
}

const MIN_FETCH_INTERVAL_MS = 20 * 1000
const cacheByUser = new Map() // userId -> { records, fetchedAt, retryAt }
let archive = {}
let activeUserId = null
export function configureCursorArchive(hooks) {
  archive = hooks || {}
  activeUserId = null
  cacheByUser.clear()
}

export function cursorActiveUserId() {
  return activeUserId
}

export function forceRefreshCursor() {
  for (const entry of cacheByUser.values()) {
    entry.fetchedAt = 0
    entry.retryAt = 0
  }
}

let defaultSqlPromise = null
async function loadDefaultArchive(userId) {
  if (process.env.AIMON_CURSOR_ROOT || process.env.AIMON_CONFIG) return []
  const dbPath = path.join(CONFIG_DIR, 'usage.sqlite')
  if (!fs.existsSync(dbPath)) return []
  try {
    if (!defaultSqlPromise) defaultSqlPromise = initSqlJs()
    const SQL = await defaultSqlPromise
    const bytes = await fsp.readFile(dbPath)
    const db = new SQL.Database(bytes)
    try {
      const res = db.exec('SELECT records_json FROM cursor_usage_archive WHERE user_id = ?', [userId])
      const json = res[0]?.values?.[0]?.[0]
      return json ? JSON.parse(json) : []
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

// Newest monthly quota window (used %, reset), refreshed on the same
// cadence as the CSV fetch. Read by the `cursor:limits` path (via index.js) to
// overlay the Cursor plan's Quota window.
let latestWindows = []
export function cursorResetWindows() {
  return latestWindows
}

async function getCloudRecords(token) {
  const payload = decodeJwt(token)
  const userId = payload?.sub ? String(payload.sub) : 'unknown'
  const tagUser = (rows, backfillMs = 0) => {
    const out = (rows || []).map((r) => {
      if (!r) return r
      const next = { ...r }
      if (userId && userId !== 'unknown') next.userId = userId
      if (backfillMs > 0) next.backfillBeforeMs = backfillMs
      else delete next.backfillBeforeMs
      return next
    })
    if (backfillMs > 0) {
      Object.defineProperty(out, 'backfillBeforeMs', { value: backfillMs, enumerable: false, configurable: true })
    }
    return out
  }
  if (userId && userId !== 'unknown') {
    activeUserId = userId
    archive.activate?.(userId)
  }
  let entry = cacheByUser.get(userId)
  if (!entry) {
    const initialRecords = typeof archive.load === 'function'
      ? (archive.load(userId) || [])
      : await loadDefaultArchive(userId)
    const savedBackfill = (initialRecords || []).reduce(
      (min, r) => (Number(r?.backfillBeforeMs) > 0 && (min === 0 || r.backfillBeforeMs < min) ? Number(r.backfillBeforeMs) : min),
      Number(initialRecords?.backfillBeforeMs) > 0 ? Number(initialRecords.backfillBeforeMs) : 0
    )
    entry = {
      records: tagUser(initialRecords, savedBackfill),
      fetchedAt: 0,
      retryAt: 0,
      coveredUntilMs: 0,
      backfillBeforeMs: savedBackfill,
    }
    cacheByUser.set(userId, entry)
  }
  if (entry.inFlight) return entry.inFlight
  if (Date.now() < entry.retryAt || Date.now() - entry.fetchedAt < MIN_FETCH_INTERVAL_MS) return entry.records
  entry.inFlight = (async () => {
    // Replace recent complete hourly buckets and retain archived history. When
    // the local archive is more than 48h behind (e.g. PC was asleep or offline
    // for several days), rewind fromMs to 2 hours before the newest archived
    // cloud record so multi-day gaps are never skipped.
    let latestCloudTs = 0
    for (const r of entry.records) {
      if (String(r.dedupKey || '').startsWith('cursor-cloud:') && r.ts > latestCloudTs) {
        latestCloudTs = r.ts
      }
    }
    const resumeAnchor = Math.max(latestCloudTs, entry.coveredUntilMs || 0)
    const twoDaysAgo = Date.now() - 2 * 86400000
    const resumeBase = resumeAnchor > 0 ? Math.min(twoDaysAgo, resumeAnchor - 2 * 3600000) : twoDaysAgo
    const backfillBeforeMs = Number(entry.backfillBeforeMs) > 0 ? Number(entry.backfillBeforeMs) : 0
    const recentFromMs =
      entry.records.length || backfillBeforeMs > 0
        ? Math.max(0, Math.floor(resumeBase / 3600000) * 3600000)
        : 0
    const fromMs = backfillBeforeMs > 0 ? 0 : recentFromMs
    const fetchStartedAt = Date.now()
    const [usage, summary] = await Promise.allSettled([
      fetchUsageCsv(token, fromMs, { backfillBeforeMs, recentFromMs }),
      fetchUsageSummary(token),
    ])
    if (usage.status === 'fulfilled') {
      const { rows: fetchedRows, olderRange, replacedFromMs, backfillBeforeMs: nextBackfill } = usage.value
      const byKey = new Map()
      for (const r of entry.records) {
        if (r.ts < replacedFromMs && (!olderRange || r.ts < olderRange[0] || r.ts >= olderRange[1])) {
          byKey.set(r.dedupKey, r)
        }
      }
      for (const r of fetchedRows) {
        byKey.set(r.dedupKey, r)
      }
      const merged = [...byKey.values()].sort((a, b) => a.ts - b.ts)
      const records = tagUser(merged, nextBackfill)
      const prevJson = JSON.stringify(entry.records)
      entry.records = records
      entry.backfillBeforeMs = nextBackfill
      entry.coveredUntilMs = fetchStartedAt
      if (JSON.stringify(records) !== prevJson) {
        cursor.revision++
      }
      archive.save?.(userId, entry.records, nextBackfill)
      entry.fetchedAt = Date.now()
      entry.retryAt = 0
    } else {
      const err = usage.reason
      entry.retryAt = Date.now() + ([403, 429].includes(err?.status) ? 15 * 60000 : MIN_FETCH_INTERVAL_MS)
      console.warn('Cursor usage refresh failed; retaining history:', err?.message || err)
    }
    if (summary.status === 'fulfilled' && JSON.stringify(latestWindows) !== JSON.stringify(summary.value)) {
      latestWindows = summary.value
      cursor.revision++
    }
    return entry.records
  })().finally(() => { entry.inFlight = null })
  return entry.inFlight
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
  // throttles real HTTP calls and applies rate-limit backoff.
  network: true,
  revision: 0,
  forceRefresh: forceRefreshCursor,
  match: (file) => path.basename(file) === 'state.vscdb',
  async parseFile(file) {
    const token = await readAccessToken(file)
    if (!token) {
      activeUserId = null
      archive.activate?.(null)
      throw new Error('Cursor access token unavailable')
    }
    return getCloudRecords(token)
  },
}
