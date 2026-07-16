import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { CONFIG_DIR } from './paths.js'
import { costFor } from './pricing.js'
import { RESET_PERIODS, ANCHORED_PERIODS } from './subscriptions.js'

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

CREATE TABLE IF NOT EXISTS subscriptions (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  monthly_usd REAL    NOT NULL DEFAULT 0,
  start_date  TEXT    NOT NULL,   -- 'YYYY-MM-DD' (local), billing anchor
  active      INTEGER NOT NULL DEFAULT 1,
  end_date    TEXT,               -- 'YYYY-MM-DD' set on deactivation; billing stops after
  bindings    TEXT    NOT NULL DEFAULT '[]',  -- JSON [{cli, keyAlias?, models?}]
  reset_periods TEXT,             -- JSON subset of RESET_PERIODS, e.g. ["5h","weekly"] — quota windows
  reset_anchors TEXT,             -- JSON per-period anchor, {"weekly":"YYYY-MM-DDTHH:mm","monthly":"YYYY-MM-DD"}
  reset_anchor  TEXT,             -- DEAD: pre-multi-anchor single monthly anchor, migrated into reset_anchors
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`

// sql.js gives us no migration framework, and SCHEMA above only CREATEs tables
// that don't exist yet — so a column added to a table an existing install
// already has needs an explicit ALTER. Additive-only and idempotent: safe to
// run on every open, and an older build reading the newer file just ignores it.
function migrateSchema(db) {
  const columns = (table) => {
    const res = db.exec(`PRAGMA table_info(${table})`)
    return new Set(res[0] ? res[0].values.map((v) => v[1]) : [])
  }
  const subs = columns('subscriptions')
  if (!subs.has('reset_periods')) {
    db.run('ALTER TABLE subscriptions ADD COLUMN reset_periods TEXT')
    // Quota windows were briefly a single-select `reset_period` column before
    // becoming a multi-select set (a plan can have both a 5h and a weekly cap).
    // Carry any value over so the choice isn't silently lost. SQLite can't drop
    // a column on older versions, so the dead one is just left in place.
    if (subs.has('reset_period')) {
      db.run(
        `UPDATE subscriptions SET reset_periods = '["' || reset_period || '"]'
         WHERE reset_period IS NOT NULL AND reset_period <> 'none'`
      )
    }
  }
  if (!subs.has('reset_anchor')) db.run('ALTER TABLE subscriptions ADD COLUMN reset_anchor TEXT')
  if (!subs.has('reset_anchors')) {
    db.run('ALTER TABLE subscriptions ADD COLUMN reset_anchors TEXT')
    // The single `reset_anchor` only ever drove the monthly window; weekly needs
    // its own now, so anchors became a per-period map. Carry the old value into
    // the monthly slot. (String-concat rather than json_object() — the JSON1
    // extension isn't guaranteed in this sql.js build.)
    if (subs.has('reset_anchor')) {
      db.run(
        `UPDATE subscriptions SET reset_anchors = '{"monthly":"' || reset_anchor || '"}'
         WHERE reset_anchor IS NOT NULL AND reset_anchors IS NULL`
      )
    }
  }
}

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
    migrateSchema(this.db)
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

  // ---- subscription plans (monthly flat-fee tracking) ---------------------

  listSubscriptions() {
    return this.rows('SELECT * FROM subscriptions ORDER BY created_at ASC').map(mapSubscriptionRow)
  }

  getSubscription(id) {
    const r = this.rows('SELECT * FROM subscriptions WHERE id = ?', [id])[0]
    return r ? mapSubscriptionRow(r) : null
  }

  // id absent -> insert (uuid generated here); id present -> update in place.
  upsertSubscription({ id, name, monthlyUsd, startDate, active, endDate, bindings, resetPeriods, resetAnchors }) {
    const now = Date.now()
    const existing = id ? this.getSubscription(id) : null
    // Filtered through RESET_PERIODS and de-duped, in canonical order, so the
    // stored set can't carry junk a hand-edited row (or an older build) put there.
    const periods = RESET_PERIODS.filter((p) => (Array.isArray(resetPeriods) ? resetPeriods : []).includes(p))
    // Anchors are kept only for the periods that actually use one ('5h' is
    // rolling and has none), so a stale anchor can't linger after a period is
    // unticked and silently come back if it's re-ticked later.
    const anchors = {}
    for (const p of periods) {
      const v = resetAnchors && resetAnchors[p]
      if (ANCHORED_PERIODS.includes(p) && typeof v === 'string' && v) anchors[p] = v
    }
    const row = {
      id: existing ? id : id || crypto.randomUUID(),
      name,
      monthlyUsd: Number(monthlyUsd) || 0,
      startDate,
      active: active !== false ? 1 : 0,
      endDate: endDate || null,
      bindings: JSON.stringify(Array.isArray(bindings) ? bindings : []),
      // no windows is stored as NULL so "not tracked" has one representation
      resetPeriods: periods.length ? JSON.stringify(periods) : null,
      resetAnchors: Object.keys(anchors).length ? JSON.stringify(anchors) : null,
    }
    if (existing) {
      this.db.run(
        'UPDATE subscriptions SET name=?, monthly_usd=?, start_date=?, active=?, end_date=?, bindings=?, reset_periods=?, reset_anchors=?, updated_at=? WHERE id=?',
        [row.name, row.monthlyUsd, row.startDate, row.active, row.endDate, row.bindings, row.resetPeriods, row.resetAnchors, now, row.id]
      )
    } else {
      this.db.run(
        'INSERT INTO subscriptions (id,name,monthly_usd,start_date,active,end_date,bindings,reset_periods,reset_anchors,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [row.id, row.name, row.monthlyUsd, row.startDate, row.active, row.endDate, row.bindings, row.resetPeriods, row.resetAnchors, now, now]
      )
    }
    this.persist()
    return this.getSubscription(row.id)
  }

  deleteSubscription(id) {
    this.db.run('DELETE FROM subscriptions WHERE id = ?', [id])
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

// Always a canonically-ordered, valid subset — a malformed or hand-edited value
// degrades to "no quota windows" rather than throwing on the popup's hot path.
function parseResetPeriods(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return RESET_PERIODS.filter((p) => parsed.includes(p))
  } catch {
    return []
  }
}

// Always an object keyed by anchored periods only; malformed JSON degrades to
// "no anchors" rather than throwing on the popup's hot path.
function parseResetAnchors(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const p of ANCHORED_PERIODS) if (typeof parsed[p] === 'string' && parsed[p]) out[p] = parsed[p]
    return out
  } catch {
    return {}
  }
}

function mapSubscriptionRow(r) {
  let bindings = []
  try {
    const parsed = JSON.parse(r.bindings)
    if (Array.isArray(parsed)) bindings = parsed
  } catch {
    // malformed JSON in a hand-edited DB: treat as no bindings
  }
  return {
    id: r.id,
    name: r.name,
    monthlyUsd: r.monthly_usd,
    startDate: r.start_date,
    active: !!r.active,
    endDate: r.end_date || null,
    bindings,
    resetPeriods: parseResetPeriods(r.reset_periods),
    resetAnchors: parseResetAnchors(r.reset_anchors),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
