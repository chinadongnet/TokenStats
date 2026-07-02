import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { claude } from './parsers/claude.js'
import { codex } from './parsers/codex.js'
import { geminiJsonl, geminiJson } from './parsers/gemini.js'
import { antigravity } from './parsers/antigravity.js'
import { costFor } from './pricing.js'
import { CLIS } from './paths.js'

const PARSERS = [claude, codex, geminiJsonl, geminiJson, antigravity]

// In-memory index of every parsed file:
//   path -> { parser, size, mtimeMs, state, records[] }
// JSONL files are tailed incrementally from the last byte offset; JSON files
// (Gemini) are re-parsed whole. Aggregation is computed on demand from records.
export class Store extends EventEmitter {
  constructor() {
    super()
    this.files = new Map()
    this.watchers = []
    this._scanTimer = null
  }

  parserFor(file) {
    const f = norm(file)
    return PARSERS.find((p) => p.roots.some((r) => f.startsWith(norm(r))) && p.match(file))
  }

  async ingestFile(file) {
    const parser = this.parserFor(file)
    if (!parser) return false
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      this.files.delete(file)
      return false
    }
    if (!stat.isFile()) return false

    let entry = this.files.get(file)
    if (!entry) {
      entry = { parser, size: 0, mtimeMs: 0, state: {}, records: [] }
      this.files.set(file, entry)
    }
    if (stat.mtimeMs === entry.mtimeMs && stat.size === entry.size) return false

    if (parser.kind === 'json') {
      const text = await fsp.readFile(file, 'utf8')
      entry.records = parser.parseFile(text, file)
    } else if (parser.kind === 'binary') {
      // whole-file binary formats (Antigravity SQLite): re-parse on change
      const buf = await fsp.readFile(file)
      entry.records = await parser.parseFile(buf, file)
    } else {
      // jsonl: if the file shrank/rotated, restart from scratch
      let start = entry.size
      if (stat.size < entry.size) {
        entry.records = []
        entry.state = {}
        start = 0
      }
      if (stat.size > start) {
        const chunk = await readRange(file, start, stat.size)
        const lines = chunk.split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          const rec = parser.parseLine(line, entry.state, file)
          if (rec) entry.records.push(rec)
        }
      }
    }
    entry.size = stat.size
    entry.mtimeMs = stat.mtimeMs
    return true
  }

  async scanAll() {
    for (const parser of PARSERS) {
      for (const root of parser.roots) {
        for (const file of await walk(root, parser.match)) {
          await this.ingestFile(file)
        }
      }
    }
  }

  // All normalized records across every file, newest last. Includes the
  // on-disk duplicates (Claude content-block lines, Gemini re-appends); use
  // dedupedRecords() for anything that aggregates token counts.
  allRecords() {
    const out = []
    for (const entry of this.files.values()) out.push(...entry.records)
    return out
  }

  // Records with the per-message duplicates collapsed. Records that carry a
  // `dedupKey` are counted once per key (first occurrence wins; the duplicates
  // are byte-identical so the choice is immaterial); records without a key
  // (Codex, Antigravity) always pass through.
  dedupedRecords() {
    return dedupe(this.allRecords())
  }

  // Per-request rows for the report's request log. One deduped record per
  // request (exactly what feeds the totals), optionally filtered to a single
  // local day and/or CLI, newest first. Returns { rows, count } where `count`
  // is the unclamped total so the UI can show "showing N of M".
  requestLog({ dayStartMs = null, cli = null, limit = 2000 } = {}) {
    const dayEnd = dayStartMs != null ? dayStartMs + 24 * 3600 * 1000 : null
    const out = []
    for (const r of this.dedupedRecords()) {
      if (cli && r.cli !== cli) continue
      if (dayStartMs != null && (r.ts < dayStartMs || r.ts >= dayEnd)) continue
      out.push({
        ts: r.ts,
        cli: r.cli,
        model: r.model,
        sessionId: r.sessionId,
        project: r.project,
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheCreate: r.cacheCreate,
        reasoning: r.reasoning,
        total: r.total,
        cost: costFor(r),
      })
    }
    out.sort((a, b) => b.ts - a.ts)
    return { rows: out.slice(0, limit), count: out.length }
  }

  // Per-project (directory) token totals over an optional time range / CLI.
  // Served live from the deduped records (the DB only buckets by cli/model, so
  // it can't answer this). One row per (cli, project), biggest first.
  projectStats({ fromMs = null, toMs = null, cli = null } = {}) {
    const map = new Map() // key: cli|project
    for (const r of this.dedupedRecords()) {
      if (cli && r.cli !== cli) continue
      if (fromMs != null && r.ts < fromMs) continue
      if (toMs != null && r.ts >= toMs) continue
      const project = r.project || '(unknown)'
      const key = r.cli + '|' + project
      let p = map.get(key)
      if (!p) {
        p = { cli: r.cli, project, total: 0, cost: 0, turns: 0, lastTs: 0 }
        map.set(key, p)
      }
      p.total += r.total
      p.cost += costFor(r)
      p.turns += 1
      if (r.ts > p.lastTs) p.lastTs = r.ts
    }
    return [...map.values()].sort((a, b) => b.total - a.total)
  }

  // Build the snapshot consumed by the UI.
  snapshot() {
    const records = this.dedupedRecords()
    const now = new Date()
    const todayKey = dayKey(now.getTime())

    const blank = () => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, cost: 0, count: 0 })
    const perCli = Object.fromEntries(CLIS.map((c) => [c, blank()]))
    const todayPerCli = Object.fromEntries(CLIS.map((c) => [c, blank()]))
    const perModel = new Map()
    const todayPerModel = new Map()
    const perDay = new Map() // dayKey -> { [cli]: total }
    let latest = null

    for (const r of records) {
      const cost = costFor(r)
      add(perCli[r.cli], r, cost)
      const dk = dayKey(r.ts)
      if (dk === todayKey) add(todayPerCli[r.cli], r, cost)

      if (!perModel.has(r.model)) perModel.set(r.model, { model: r.model, cli: r.cli, ...blank() })
      add(perModel.get(r.model), r, cost)

      if (dk === todayKey) {
        if (!todayPerModel.has(r.model)) todayPerModel.set(r.model, { model: r.model, cli: r.cli, ...blank() })
        add(todayPerModel.get(r.model), r, cost)
      }

      if (!perDay.has(dk)) perDay.set(dk, { day: dk, total: 0, ...Object.fromEntries(CLIS.map((c) => [c, 0])) })
      const d = perDay.get(dk)
      d[r.cli] += r.total
      d.total += r.total

      if (!latest || r.ts > latest.ts) latest = r
    }

    const sessions = sessionSummary(records)

    return {
      generatedAt: now.getTime(),
      totals: {
        all: sumCli(perCli),
        today: sumCli(todayPerCli),
      },
      perCli,
      todayPerCli,
      perModel: [...perModel.values()].sort((a, b) => b.total - a.total),
      todayPerModel: [...todayPerModel.values()].sort((a, b) => b.total - a.total),
      perDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-30),
      recentSessions: sessions.slice(0, 12),
      sessionCount: sessions.length,
      live: latest
        ? { cli: latest.cli, model: latest.model, project: latest.project, ts: latest.ts }
        : null,
    }
  }

  // ---- live watching -------------------------------------------------------

  async start() {
    await this.scanAll()
    const chokidar = (await import('chokidar')).default
    const roots = [...new Set(PARSERS.flatMap((p) => p.roots))]
    for (const root of roots) {
      if (!fs.existsSync(root)) continue
      const watcher = chokidar.watch(root, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      })
      const onChange = (file) => {
        if (this.parserFor(file)) this._queueRescan(file)
      }
      watcher.on('add', onChange).on('change', onChange)
      this.watchers.push(watcher)
    }
    this.emit('update', this.snapshot())
  }

  _queueRescan(file) {
    // Debounce bursts of fs events into one snapshot emit.
    this._pending = this._pending || new Set()
    this._pending.add(file)
    if (this._scanTimer) return
    this._scanTimer = setTimeout(async () => {
      this._scanTimer = null
      const files = [...this._pending]
      this._pending.clear()
      let changed = false
      for (const f of files) changed = (await this.ingestFile(f)) || changed
      if (changed) this.emit('update', this.snapshot())
    }, 400)
  }

  async stop() {
    for (const w of this.watchers) await w.close()
    this.watchers = []
  }
}

// Collapse records that share a `dedupKey` to a single occurrence. Parsers set
// the key on formats that write the same usage row to disk more than once
// (Claude per-content-block lines + resume copies, Gemini re-appended logs).
// Keyless records (Codex deltas, Antigravity turns) are always kept.
function dedupe(records) {
  const seen = new Set()
  const out = []
  for (const r of records) {
    if (r.dedupKey) {
      if (seen.has(r.dedupKey)) continue
      seen.add(r.dedupKey)
    }
    out.push(r)
  }
  return out
}

function add(acc, r, cost) {
  acc.total += r.total
  acc.input += r.input
  acc.output += r.output
  acc.cacheRead += r.cacheRead
  acc.cacheCreate += r.cacheCreate
  acc.reasoning += r.reasoning
  acc.cost += cost
  acc.count += 1
}

function sumCli(perCli) {
  const out = { total: 0, cost: 0, count: 0 }
  for (const c of Object.values(perCli)) {
    out.total += c.total
    out.cost += c.cost
    out.count += c.count
  }
  return out
}

function sessionSummary(records) {
  const map = new Map()
  for (const r of records) {
    const key = r.cli + '|' + r.sessionId
    let s = map.get(key)
    if (!s) {
      s = { cli: r.cli, sessionId: r.sessionId, project: r.project, model: r.model, total: 0, cost: 0, lastTs: 0 }
      map.set(key, s)
    }
    s.total += r.total
    s.cost += costFor(r)
    if (r.ts > s.lastTs) {
      s.lastTs = r.ts
      s.model = r.model
      s.project = r.project
    }
  }
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs)
}

// Local-day key (YYYY-MM-DD) so "today" matches the user's wall clock.
function dayKey(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Canonical path form for slash/case-insensitive prefix matching on Windows,
// so config roots tolerate forward or back slashes.
function norm(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase()
}

function readRange(file, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = []
    fs.createReadStream(file, { start, end: end - 1, encoding: 'utf8' })
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolve(chunks.join('')))
      .on('error', reject)
  })
}

async function walk(root, match) {
  const out = []
  async function rec(dir) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await rec(full)
      else if (match(full)) out.push(full)
    }
  }
  await rec(root)
  return out
}
