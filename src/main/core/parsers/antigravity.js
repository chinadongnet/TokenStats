import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { CLI_ROOTS } from '../paths.js'

const require = createRequire(import.meta.url)

// Antigravity CLI (agy) stores each conversation as a SQLite database:
//   ~/.gemini/antigravity-cli/conversations/<uuid>.db
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

// sql.js is initialized once and shared; loading the wasm by path keeps this
// module pure-Node (testable via npm run test:parsers) and packager-safe.
let sqlPromise = null
function getSql() {
  if (!sqlPromise) {
    const initSqlJs = require('sql.js')
    const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
    sqlPromise = initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) })
  }
  return sqlPromise
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

function workspaceOf(db) {
  try {
    const res = db.exec('SELECT data FROM trajectory_metadata_blob LIMIT 1')
    const blob = res[0]?.values?.[0]?.[0]
    if (!blob) return null
    const m = Buffer.from(blob).toString('utf8').match(/file:\/\/\/([A-Za-z0-9._~:/%@&+=,;!$'()*-]+)/)
    if (!m) return null
    return path.basename(decodeURIComponent(m[1]))
  } catch {
    return null
  }
}

export const antigravity = {
  cli: 'agy',
  roots: CLI_ROOTS.agy,
  kind: 'binary',
  match: (file) => file.endsWith('.db'),
  async parseFile(buf, file) {
    const SQL = await getSql()
    let db
    try {
      db = new SQL.Database(buf)
    } catch {
      return []
    }
    const sessionId = path.basename(file, '.db')
    const records = []
    try {
      const project = workspaceOf(db) || 'antigravity'
      const res = db.exec('SELECT data FROM gen_metadata ORDER BY idx')
      for (const [blob] of res[0]?.values || []) {
        const top = decodeProto(Buffer.from(blob))
        const gen = top && sub(top, 1)
        const usage = gen && sub(gen, 4)
        if (!usage) continue
        const input = first(usage, 2) || 0
        const output = first(usage, 3) || 0
        const cacheRead = first(usage, 5) || 0
        const reasoning = first(usage, 9) || 0
        const tsMsg = sub(sub(gen, 9) || [], 4)
        const sec = tsMsg && first(tsMsg, 1)
        const modelRaw = first(gen, 21) || first(gen, 19)
        records.push({
          cli: 'agy',
          ts: sec ? sec * 1000 : Date.now(),
          model: modelRaw ? modelRaw.toString('utf8') : 'antigravity',
          sessionId,
          project,
          input,
          output,
          cacheRead,
          cacheCreate: 0,
          reasoning,
          total: input + output + cacheRead,
        })
      }
    } catch {
      // table missing or schema changed; treat as no usage
    } finally {
      db.close()
    }
    return records
  },
}
