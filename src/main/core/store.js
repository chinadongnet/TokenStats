import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { claude } from './parsers/claude.js'
import { codex } from './parsers/codex.js'
import { geminiJsonl, geminiJson } from './parsers/gemini.js'
import { antigravity } from './parsers/antigravity.js'
import { cursor } from './parsers/cursor.js'
import { costFor } from './pricing.js'
import { CLIS } from './paths.js'

const PARSERS = [claude, codex, geminiJsonl, geminiJson, antigravity, cursor]

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
    this._pollTimers = []
    // Pollers are usage sources with no local files to watch — currently just
    // LiteLLM providers, whose usage lives entirely on the proxy server(s).
    // Unlike PARSERS this is NOT a static list: each LiteLLM provider row in
    // the Settings DB becomes its own poller with a dynamic `litellm:<id>`
    // cli id, so index.js rebuilds this array (via setPollers()) whenever
    // providers are added/edited/removed/toggled. Each entry exposes `cli`
    // and an async `poll()` returning that source's current full record set.
    this.pollers = []
  }

  // Replaces the active poller set (called by index.js after any LiteLLM
  // provider CRUD). Immediately purges live records for any poller that's no
  // longer present (deleted/disabled provider) so it stops contributing to
  // totals right away instead of lingering until the next snapshot happens
  // to overwrite that key.
  setPollers(pollers) {
    const keep = new Set(pollers.map((p) => `poller:${p.cli}`))
    for (const key of this.files.keys()) {
      if (key.startsWith('poller:') && !keep.has(key)) this.files.delete(key)
    }
    this.pollers = pollers
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

  // Runs every poller once and stores its full record set under a synthetic
  // key, the same shape as a file entry so allRecords()/dedupedRecords() pick
  // it up unchanged. Each poller throttles/caches its own network calls, so
  // calling this often (e.g. on a timer) is cheap.
  async pollAll() {
    let changed = false
    for (const p of this.pollers) {
      const records = await p.poll()
      const key = `poller:${p.cli}`
      const prev = this.files.get(key)
      if (!prev || prev.records !== records) changed = true
      this.files.set(key, { parser: p, size: 0, mtimeMs: Date.now(), state: {}, records })
    }
    return changed
  }

  // Forces one poller to refresh immediately (bypassing its own throttle),
  // used right after a provider is saved so the UI updates without waiting
  // for the next timer tick. Returns false if no matching poller is active.
  async forcePoll(cli) {
    const p = this.pollers.find((x) => x.cli === cli)
    if (!p) return false
    const records = await (p.forceRefresh ? p.forceRefresh() : p.poll())
    this.files.set(`poller:${cli}`, { parser: p, size: 0, mtimeMs: Date.now(), state: {}, records })
    return true
  }

  // Re-applies a poller's live settings (LiteLLM model visibility/rename)
  // against its already-cached data, with no network call — used right after
  // a per-model Settings edit. Returns false if no matching poller is active.
  reapplyPoller(cli) {
    const p = this.pollers.find((x) => x.cli === cli)
    if (!p || !p.reapplySettings) return false
    const records = p.reapplySettings()
    this.files.set(`poller:${cli}`, { parser: p, size: 0, mtimeMs: Date.now(), state: {}, records })
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

  // Force-refresh the network-backed file parsers (currently just Cursor, whose
  // "file" is only a token store — the real usage is fetched from cursor.com).
  // ingestFile normally short-circuits when a file's mtime/size is unchanged,
  // which is correct for genuine on-disk formats but wrong here: Cursor's cloud
  // usage keeps growing while state.vscdb sits untouched, so we clear the cached
  // stat to force a re-parse (and thus a re-fetch). The parser self-throttles
  // the actual HTTP call to every 15 min, so calling this on a timer or from
  // "Refresh now" is cheap. Returns true if any record set actually changed.
  async refreshNetworkParsers() {
    let changed = false
    for (const parser of PARSERS) {
      if (!parser.network) continue
      for (const root of parser.roots) {
        for (const file of await walk(root, parser.match)) {
          const entry = this.files.get(file)
          const before = entry ? entry.records.length : -1
          if (entry) {
            entry.mtimeMs = 0
            entry.size = 0
          }
          await this.ingestFile(file)
          const after = this.files.get(file)?.records.length ?? -1
          if (after !== before) changed = true
        }
      }
    }
    return changed
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
      p.turns += r.turns || 1
      if (r.ts > p.lastTs) p.lastTs = r.ts
    }
    return [...map.values()].sort((a, b) => b.total - a.total)
  }

  // Build the snapshot consumed by the UI.
  snapshot(nowMs = Date.now()) {
    const records = this.dedupedRecords()
    const now = new Date(nowMs)
    const todayKey = dayKey(now.getTime())
    // Day and week are calendar-aligned. Month is the latest 30 local calendar
    // days (including today), so it remains a useful monthly view on the first
    // day of a new calendar month instead of collapsing to the day view.
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    // Week starts Monday (ISO), the common convention in both UI languages.
    const weekStart = midnight.getTime() - ((midnight.getDay() + 6) % 7) * 86400000
    const monthStartDate = new Date(midnight)
    monthStartDate.setDate(monthStartDate.getDate() - 29)
    const monthStart = monthStartDate.getTime()

    // 5 fixed built-in CLIs + whatever LiteLLM providers are currently active,
    // so a dynamic `litellm:<id>` cli id never hits a missing blank accumulator.
    const dynamicIds = this.pollers.map((p) => p.cli)
    const allCliIds = [...CLIS, ...dynamicIds]
    // Poller (LiteLLM) records carry synthetic timestamps — noon UTC of the
    // usage day, which can even sit in the local future — so they must never
    // win the "live" race below; pollers report real sync times instead.
    const pollerClis = new Set(dynamicIds)
    const blank = () => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, cost: 0, count: 0 })
    const perCli = Object.fromEntries(allCliIds.map((c) => [c, blank()]))
    const todayPerCli = Object.fromEntries(allCliIds.map((c) => [c, blank()]))
    const weekPerCli = Object.fromEntries(allCliIds.map((c) => [c, blank()]))
    const monthPerCli = Object.fromEntries(allCliIds.map((c) => [c, blank()]))
    const perModel = new Map()
    const todayPerModel = new Map()
    const weekPerModel = new Map()
    const monthPerModel = new Map()
    const perDay = new Map() // dayKey -> { [cli]: total }
    let latest = null

    for (const r of records) {
      const cost = costFor(r)
      add(perCli[r.cli], r, cost)
      const dk = dayKey(r.ts)
      if (dk === todayKey) add(todayPerCli[r.cli], r, cost)
      if (r.ts >= weekStart && weekPerCli[r.cli]) add(weekPerCli[r.cli], r, cost)
      if (r.ts >= monthStart && monthPerCli[r.cli]) add(monthPerCli[r.cli], r, cost)

      if (!perModel.has(r.model)) perModel.set(r.model, { model: r.model, cli: r.cli, ...blank() })
      add(perModel.get(r.model), r, cost)

      if (dk === todayKey) {
        if (!todayPerModel.has(r.model)) todayPerModel.set(r.model, { model: r.model, cli: r.cli, ...blank() })
        add(todayPerModel.get(r.model), r, cost)
      }
      if (r.ts >= weekStart) {
        if (!weekPerModel.has(r.model)) weekPerModel.set(r.model, { model: r.model, cli: r.cli, ...blank() })
        add(weekPerModel.get(r.model), r, cost)
      }
      if (r.ts >= monthStart) {
        if (!monthPerModel.has(r.model)) monthPerModel.set(r.model, { model: r.model, cli: r.cli, ...blank() })
        add(monthPerModel.get(r.model), r, cost)
      }

      if (!perDay.has(dk)) perDay.set(dk, { day: dk, total: 0, ...Object.fromEntries(allCliIds.map((c) => [c, 0])) })
      const d = perDay.get(dk)
      d[r.cli] += r.total
      d.total += r.total

      if (!pollerClis.has(r.cli) && (!latest || r.ts > latest.ts)) latest = r
    }

    // Pollers compete for "live" via their real last-sync-with-new-usage time.
    for (const p of this.pollers) {
      const lc = p.liveCandidate?.()
      if (lc && (!latest || lc.ts > latest.ts)) latest = lc
    }

    const todayRecords = records.filter((r) => dayKey(r.ts) === todayKey)
    const sessions = sessionSummary(records)
    const todaySessions = sessionSummary(todayRecords)

    return {
      generatedAt: now.getTime(),
      // Local scope boundaries, so the popup can say exactly what range a
      // scope covers. `monthStart` is the start of the 30-day monthly view.
      ranges: { dayStart: midnight.getTime(), weekStart, monthStart },
      totals: {
        all: sumCli(perCli),
        today: sumCli(todayPerCli),
        week: sumCli(weekPerCli),
        month: sumCli(monthPerCli),
      },
      perCli,
      todayPerCli,
      weekPerCli,
      monthPerCli,
      perModel: [...perModel.values()].sort((a, b) => b.total - a.total),
      todayPerModel: [...todayPerModel.values()].sort((a, b) => b.total - a.total),
      weekPerModel: [...weekPerModel.values()].sort((a, b) => b.total - a.total),
      monthPerModel: [...monthPerModel.values()].sort((a, b) => b.total - a.total),
      perDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-30),
      recentSessions: sessions.slice(0, 12),
      todayRecentSessions: todaySessions.slice(0, 12),
      recentProjects: projectSummary(records).slice(0, 12),
      sessionCount: sessions.length,
      live: latest
        ? { cli: latest.cli, model: latest.model, project: latest.project, ts: latest.ts }
        : null,
      // Active LiteLLM providers, for the renderer to merge onto its 5 fixed
      // built-in CLI entries so each shows up as its own labeled/colored row.
      providers: this.pollers.map((p) => ({ id: p.cli, label: p.meta.label, color: p.meta.color })),
    }
  }

  // ---- live watching -------------------------------------------------------

  async start() {
    await this.scanAll()
    await this.pollAll()
    // Always run the poll-check timer, even if there are zero pollers right
    // now — LiteLLM providers can be added later via the Settings UI (via
    // setPollers()), and this timer must already be running for a newly
    // added provider's configurable sync-minutes interval to actually fire
    // repeatedly rather than only once (from the save-provider handler's
    // immediate forcePoll()). Each poller throttles its own network calls to
    // its configured syncMinutes (see litellm.js); this timer just needs to
    // fire more often than the shortest configured interval so a fresh fetch
    // is picked up promptly once it's due.
    const timer = setInterval(async () => {
      if (await this.pollAll()) this.emit('update', this.snapshot())
    }, 60 * 1000)
    this._pollTimers.push(timer)
    // Separate, slower timer for network-backed file parsers (Cursor). Kept
    // apart from the poll timer above because each tick re-reads the whole
    // state.vscdb to pull the token, so 5 min (well under the parser's own
    // 15-min HTTP throttle) is a better cadence than the 60 s poll loop.
    const netTimer = setInterval(async () => {
      if (await this.refreshNetworkParsers()) this.emit('update', this.snapshot())
    }, 5 * 60 * 1000)
    this._pollTimers.push(netTimer)
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
    for (const t of this._pollTimers) clearInterval(t)
    this._pollTimers = []
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
  acc.count += r.turns || 1
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

// Like sessionSummary but merges all sessions of the same project (cli|project)
// so the All-time view shows one row per project with its total token count.
function projectSummary(records) {
  const map = new Map()
  for (const r of records) {
    const project = r.project || '(unknown)'
    const key = r.cli + '|' + project
    let p = map.get(key)
    if (!p) {
      p = { cli: r.cli, sessionId: key, project, total: 0, cost: 0, lastTs: 0 }
      map.set(key, p)
    }
    p.total += r.total
    p.cost += costFor(r)
    if (r.ts > p.lastTs) p.lastTs = r.ts
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
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
