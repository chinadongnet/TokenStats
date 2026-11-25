import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { AGY_DESKTOP_ROOT, CLI_ROOTS } from '../paths.js'
import { readSqliteSnapshot, sqliteSignature } from '../sqliteSnapshot.js'

const require = createRequire(import.meta.url)

// Antigravity CLI and desktop app store each conversation as a SQLite database:
//   ~/.gemini/antigravity-cli/conversations/<uuid>.db
//   ~/.gemini/antigravity/conversations/<uuid>.db
// Inside, the `gen_metadata` table has one protobuf blob per model turn. The
// blob layout (reverse-engineered, no published schema) that we rely on:
//   field 1 (message) = generation info
//     .4  (message) = token usage: 2=fresh input, 3=output total,
//                     5=cached context (absent on turn 1), 9=thinking (subset
//                     of 3), 10=visible output (3 = 9 + 10)
//     .9.4 (message) = timestamp {1: epoch seconds, 2: nanos}
//     .21 (string)  = model display name, e.g. "Gemini 3.1 Pro (High)"
//     .19 (string)  = model fallback id, e.g. "gemini-pro-default"
// The per-conversation workspace lives in `trajectory_metadata_blob` as a
// file:// URI. Whole-file re-parse on change (SQLite pages get rewritten in
// place, so there is no stable append offset to tail).

// sql.js is initialized lazily and recycled after large databases or errors so
// WASM linear memory (which cannot shrink) and any orphaned MEMFS buffers are
// periodically released back to the OS instead of staying pinned at peak.
let wasmBinaryCache = null
let sqlPromise = null
let sqlUseCount = 0
let activeDbs = 0
const RECYCLE_AFTER_BYTES = 32 * 1024 * 1024
const RECYCLE_AFTER_USES = 200

function getSql() {
  if (!sqlPromise) {
    const initSqlJs = require('sql.js')
    if (!wasmBinaryCache) {
      const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
      wasmBinaryCache = fs.readFileSync(wasmPath)
    }
    sqlUseCount = 0
    sqlPromise = initSqlJs({ wasmBinary: wasmBinaryCache }).catch((err) => {
      sqlPromise = null
      throw err instanceof Error ? err : new Error(String(err))
    })
  }
  return sqlPromise
}

function resetSqlInstance() {
  if (activeDbs === 0) {
    sqlPromise = null
    sqlUseCount = 0
  }
}

// Minimal protobuf wire-format walker: returns [field, wireType, value] tuples
// (varints as Number, length-delimited as Buffer), or null on malformed input.
function decodeProto(buf) {
  const out = []
  let i = 0
  try {
    while (i < buf.length) {
      let key = 0
      let shift = 0
      for (;;) {
        const b = buf[i++]
        key |= (b & 0x7f) << shift
        shift += 7
        if (!(b & 0x80)) break
      }
      const field = key >>> 3
      const wt = key & 7
      if (wt === 0) {
        let v = 0n
        let s = 0n
        for (;;) {
          const b = buf[i++]
          v |= BigInt(b & 0x7f) << s
          s += 7n
          if (!(b & 0x80)) break
        }
        out.push([field, 0, Number(v)])
      } else if (wt === 2) {
        let len = 0
        let s = 0
        for (;;) {
          const b = buf[i++]
          len |= (b & 0x7f) << s
          s += 7
          if (!(b & 0x80)) break
        }
        out.push([field, 2, buf.slice(i, i + len)])
        i += len
      } else if (wt === 5) {
        i += 4
        out.push([field, 5, null])
      } else if (wt === 1) {
        i += 8
        out.push([field, 1, null])
      } else {
        return null
      }
    }
  } catch {
    return null
  }
  return i === buf.length ? out : null
}

const first = (msg, field) => msg?.find((t) => t[0] === field)?.[2]
const sub = (msg, field) => {
  const v = first(msg, field)
  return Buffer.isBuffer(v) ? decodeProto(v) : null
}

function timestamp(msg) {
  const seconds = first(msg, 1)
  if (typeof seconds !== 'number' || seconds < 1e9 || seconds > 1e10) return null
  return seconds * 1000 + Math.floor((first(msg, 2) || 0) / 1e6)
}

function modelStepTimes(db) {
  let stmt = null
  try {
    // Join generation usage to step completion by response ID. Positional
    // fallback is only for old rows without IDs; retries can shift step order.
    const byResponse = new Map()
    const byIndex = []
    stmt = db.prepare('SELECT step_type, metadata FROM steps ORDER BY idx')
    while (stmt.step()) {
      const [type, blob] = stmt.get()
      if (!blob) {
        if (type === 15) byIndex.push(null)
        continue
      }
      const meta = decodeProto(Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength))
      const ts = timestamp(sub(meta, 8)) || timestamp(sub(meta, 7)) || timestamp(sub(meta, 6)) || timestamp(sub(meta, 1))
      const responseId = first(sub(meta, 9), 11)
      if (Buffer.isBuffer(responseId) && ts) byResponse.set(responseId.toString('utf8'), ts)
      if (type === 15) byIndex.push(ts)
    }
    return { byResponse, byIndex }
  } catch {
    return { byResponse: new Map(), byIndex: [] }
  } finally {
    if (stmt) {
      try { stmt.free() } catch {}
    }
  }
}

function workspaceOf(db) {
  let stmt = null
  try {
    stmt = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1')
    if (!stmt.step()) return null
    const [blob] = stmt.get()
    if (!blob) return null
    const m = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
      .toString('utf8')
      .match(/file:\/\/\/([A-Za-z0-9._~:/%@&+=,;!$'()*-]+)/)
    if (!m) return null
    return path.basename(decodeURIComponent(m[1]))
  } catch {
    return null
  } finally {
    if (stmt) {
      try { stmt.free() } catch {}
    }
  }
}

export const antigravity = {
  cli: 'agy',
  roots: CLI_ROOTS.agy,
  desktopRoot: AGY_DESKTOP_ROOT,
  kind: 'path',
  sidecars: ['-wal', '-journal'],
  signature: sqliteSignature,
  match: (file) => file.endsWith('.db'),
  async parseFile(file) {
    const buf = await readSqliteSnapshot(file)
    const fallbackTs = (await fs.promises.stat(file)).mtimeMs
    const SQL = await getSql()
    const bufBytes = buf?.length || 0
    let db = null
    let shouldReset = bufBytes >= RECYCLE_AFTER_BYTES
    activeDbs++
    try {
      try {
        db = new SQL.Database(buf)
      } catch (err) {
        // If Database() threw after creating /dbfile_<rand> in MEMFS, drop the
        // WASM instance so the orphaned buffer cannot leak permanently.
        shouldReset = true
        throw err instanceof Error ? err : new Error(String(err))
      }
      sqlUseCount++
      if (sqlUseCount >= RECYCLE_AFTER_USES) shouldReset = true
      const sessionId = path.basename(file, '.db')
      const records = []
      const project = workspaceOf(db) || 'antigravity'
      const stepTimes = modelStepTimes(db)
      let stmt = null
      try {
        stmt = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx')
        while (stmt.step()) {
          const [idx, blob] = stmt.get()
          if (!blob) continue
          const top = decodeProto(Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength))
          const gen = top && sub(top, 1)
          const usage = gen && sub(gen, 4)
          if (!usage) continue
          const input = first(usage, 2) || 0
          const output = first(usage, 3) || 0
          const cacheRead = first(usage, 5) || 0
          const reasoning = first(usage, 9) || 0
          const responseId = first(usage, 11)?.toString('utf8')
          const tsMsg = sub(sub(gen, 9) || [], 4)
          const modelRaw = first(gen, 21) || first(gen, 19)
          records.push({
            cli: 'agy',
            ts: timestamp(tsMsg) || stepTimes.byResponse.get(responseId) || (!responseId && stepTimes.byIndex[idx]) || fallbackTs,
            model: modelRaw ? modelRaw.toString('utf8') : 'antigravity',
            sessionId,
            project,
            input,
            output,
            cacheRead,
            cacheCreate: 0,
            reasoning,
            reasoningIncludedInOutput: true,
            total: input + output + cacheRead,
            dedupKey: responseId ? `agy-response:${responseId}` : `agy:${sessionId}:${idx}`,
          })
        }
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err))
      } finally {
        if (stmt) {
          try { stmt.free() } catch {}
        }
      }
      return records
    } finally {
      if (db) {
        try {
          db.close()
        } catch {
          shouldReset = true
        }
      }
      activeDbs--
      if (shouldReset) resetSqlInstance()
    }
  },
}
