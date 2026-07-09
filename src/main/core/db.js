import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { CONFIG_DIR } from './paths.js'
import { costFor } from './pricing.js'

const require = createRequire(import.meta.url)

// SQLite (via sql.js / WASM) persistence of HOURLY usage buckets, plus (since the
// multi-provider LiteLLM settings feature) the LiteLLM provider configs and
// per-model visibility/rename settings that used to live in config.json.
// One row per (local-hour, cli, model); the file is a standard .sqlite that any
// SQLite tool can open. We re-aggregate from the in-memory records and replace
// the table, so it always matches what the parsers see — no drift.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_hourly (
  hour        INTEGER NOT NULL,   -- epoch ms at start of the LOCAL hour
  cli         TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  cost        REAL    NOT NULL DEFAULT 0,
  turns       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, cli, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage_hourly(hour);

CREATE TABLE IF NOT EXISTS litellm_providers (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  base_url     TEXT    NOT NULL,
  api_key      TEXT    NOT NULL,
  color        TEXT    NOT NULL DEFAULT '#f59e0b',
  sync_minutes INTEGER NOT NULL DEFAULT 15,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS litellm_model_settings (
  provider_id  TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  visible      INTEGER NOT NULL DEFAULT 1,
  display_name TEXT,
  PRIMARY KEY (provider_id, model)
);
CREATE INDEX IF NOT EXISTS idx_lms_provider ON litellm_model_settings(provider_id);
`

export class UsageDb {
  constructor({ dbPath, wasmPath } = {}) {
    this.dbPath = dbPath || path.join(CONFIG_DIR, 'usage.sqlite')
    this.wasmPath = wasmPath || path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
    this.db = null
    this.SQL = null
  }

  async open() {
    const initSqlJs = require('sql.js')
    this.SQL = await initSqlJs({ wasmBinary: fs.readFileSync(this.wasmPath) })
    let bytes = null
    try {
      bytes = fs.readFileSync(this.dbPath)
    } catch {
      // no existing db yet
    }
    this.db = bytes ? new this.SQL.Database(bytes) : new this.SQL.Database()
    this.db.run(SCHEMA)
    return this
  }

  // Rebuild the hourly table from the full record set, then persist to disk.
  ingest(records) {
    const buckets = new Map() // key: hour|cli|model
    for (const r of records) {
      const hour = floorHourLocal(r.ts)
      const key = hour + '|' + r.cli + '|' + r.model
      let b = buckets.get(key)
      if (!b) {
        b = { hour, cli: r.cli, model: r.model, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, total: 0, cost: 0, turns: 0 }
        buckets.set(key, b)
      }
      b.input += r.input
      b.output += r.output
      b.cacheRead += r.cacheRead
      b.cacheCreate += r.cacheCreate
      b.reasoning += r.reasoning
      b.total += r.total
      b.cost += r.cost != null ? r.cost : costFor(r)
      b.turns += 1
    }

    this.db.run('BEGIN')
    this.db.run('DELETE FROM usage_hourly')
    const stmt = this.db.prepare(
      'INSERT INTO usage_hourly (hour,cli,model,input,output,cache_read,cache_create,reasoning,total,cost,turns) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    )
    for (const b of buckets.values()) {
      stmt.run([b.hour, b.cli, b.model, b.input, b.output, b.cacheRead, b.cacheCreate, b.reasoning, b.total, b.cost, b.turns])
    }
    stmt.free()
    this.db.run('COMMIT')
    this.persist()
    return buckets.size
  }

  persist() {
    const data = Buffer.from(this.db.export())
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    fs.writeFileSync(this.dbPath, data)
  }

  // ---- LiteLLM provider settings (multi-provider Settings UI) -------------

  listLitellmProviders() {
    return this.rows('SELECT * FROM litellm_providers ORDER BY created_at ASC').map(mapProviderRow)
  }

  getLitellmProvider(id) {
    const r = this.rows('SELECT * FROM litellm_providers WHERE id = ?', [id])[0]
    return r ? mapProviderRow(r) : null
  }

  // id absent -> insert a new provider (uuid generated here); id present -> update in place.
  upsertLitellmProvider({ id, name, baseUrl, apiKey, color, syncMinutes, enabled }) {
    const now = Date.now()
    const existing = id ? this.getLitellmProvider(id) : null
    const row = {
      id: existing ? id : id || crypto.randomUUID(),
      name,
      baseUrl,
      apiKey,
      color: color || '#f59e0b',
      syncMinutes: Number(syncMinutes) > 0 ? Number(syncMinutes) : 15,
      enabled: enabled !== false ? 1 : 0,
    }
    if (existing) {
      this.db.run(
        'UPDATE litellm_providers SET name=?, base_url=?, api_key=?, color=?, sync_minutes=?, enabled=?, updated_at=? WHERE id=?',
        [row.name, row.baseUrl, row.apiKey, row.color, row.syncMinutes, row.enabled, now, row.id]
      )
    } else {
      this.db.run(
        'INSERT INTO litellm_providers (id,name,base_url,api_key,color,sync_minutes,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [row.id, row.name, row.baseUrl, row.apiKey, row.color, row.syncMinutes, row.enabled, now, now]
      )
    }
    this.persist()
    return this.getLitellmProvider(row.id)
  }

  deleteLitellmProvider(id) {
    this.db.run('DELETE FROM litellm_providers WHERE id = ?', [id])
    this.db.run('DELETE FROM litellm_model_settings WHERE provider_id = ?', [id])
    this.persist()
  }

  listModelSettings(providerId) {
    return this.rows('SELECT * FROM litellm_model_settings WHERE provider_id = ?', [providerId]).map(mapSettingRow)
  }

  // Hot path for the poller: called on every poll() to re-apply live visibility/rename.
  getModelSettingsMap(providerId) {
    const map = new Map()
    for (const s of this.listModelSettings(providerId)) map.set(s.model, s)
    return map
  }

  saveModelSetting({ providerId, model, visible, displayName }) {
    const v = visible !== false ? 1 : 0
    const name = typeof displayName === 'string' && displayName.trim() ? displayName.trim() : null
    this.db.run(
      `INSERT INTO litellm_model_settings (provider_id, model, visible, display_name) VALUES (?,?,?,?)
       ON CONFLICT(provider_id, model) DO UPDATE SET visible=excluded.visible, display_name=excluded.display_name`,
      [providerId, model, v, name]
    )
    this.persist()
  }

  // ---- queries for the report ---------------------------------------------

  rows(sql, params = []) {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const out = []
    while (stmt.step()) out.push(stmt.getAsObject())
    stmt.free()
    return out
  }

  // Per-hour-per-model rows for one local day (dayStart = local midnight ms).
  hourly(dayStartMs) {
    const end = dayStartMs + 24 * 3600 * 1000
    return this.rows(
      'SELECT hour, cli, model, total, cost, turns FROM usage_hourly WHERE hour >= ? AND hour < ? ORDER BY hour',
      [dayStartMs, end]
    )
  }

  // Per-day-per-cli totals across a range (for the trend chart).
  daily(fromMs, toMs) {
    const rows = this.rows(
      'SELECT hour, cli, SUM(total) AS total, SUM(cost) AS cost, SUM(turns) AS turns FROM usage_hourly WHERE hour >= ? AND hour < ? GROUP BY hour, cli',
      [fromMs, toMs]
    )
    // collapse hours into local days
    const byDay = new Map()
    for (const r of rows) {
      const day = floorDayLocal(r.hour)
      const k = day + '|' + r.cli
      const cur = byDay.get(k) || { day, cli: r.cli, total: 0, cost: 0, turns: 0 }
      cur.total += r.total
      cur.cost += r.cost
      cur.turns += r.turns
      byDay.set(k, cur)
    }
    return [...byDay.values()].sort((a, b) => a.day - b.day)
  }

  // Per-model totals across a range (for the breakdown table / pie).
  models(fromMs, toMs) {
    return this.rows(
      'SELECT cli, model, SUM(total) AS total, SUM(cost) AS cost, SUM(turns) AS turns FROM usage_hourly WHERE hour >= ? AND hour < ? GROUP BY cli, model ORDER BY total DESC',
      [fromMs, toMs]
    )
  }

  // Earliest recorded hour (for default ranges / "since" label).
  span() {
    const r = this.rows('SELECT MIN(hour) AS min, MAX(hour) AS max FROM usage_hourly')[0]
    return { min: r?.min ?? null, max: r?.max ?? null }
  }
}

export function floorHourLocal(ts) {
  const d = new Date(ts)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

export function floorDayLocal(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function mapProviderRow(r) {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    color: r.color,
    syncMinutes: r.sync_minutes,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapSettingRow(r) {
  return { model: r.model, visible: !!r.visible, displayName: r.display_name || null }
}
