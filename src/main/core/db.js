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

-- The local ARCHIVE of LiteLLM's raw daily buckets, one row per
-- (day, model, api key) exactly as the admin API reported it, keyed by the
-- poller's dedupKey. This exists because LiteLLM is the only source whose
-- history isn't on this machine: the admin API serves a 35-day window, and
-- ingest() rebuilds usage_hourly from whatever the parsers currently see, so
-- without a copy every LiteLLM bucket silently vanished from the database (and
-- from the report, and from the retired-model list) the day it aged out.
-- The model column is the RAW api model id — visibility/rename stay display-
-- time concerns applied by the poller, so a rename can't fork a bucket's id.
CREATE TABLE IF NOT EXISTS litellm_usage (
  dedup_key    TEXT    PRIMARY KEY,
  provider_id  TEXT    NOT NULL,
  day          TEXT    NOT NULL,   -- 'YYYY-MM-DD' (UTC), the API's own bucket key
  ts           INTEGER NOT NULL,   -- epoch ms, noon UTC of that day (see litellm.js)
  model        TEXT    NOT NULL,
  key_hash     TEXT,
  key_alias    TEXT,
  input        INTEGER NOT NULL DEFAULT 0,
  output       INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  cost         REAL    NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_litellm_usage_provider ON litellm_usage(provider_id, day);

CREATE TABLE IF NOT EXISTS cloud_sync (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row config
  endpoint     TEXT    NOT NULL DEFAULT '',
  api_key      TEXT    NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 0,
  sync_minutes INTEGER NOT NULL DEFAULT 10,
  full_resync  INTEGER NOT NULL DEFAULT 1,  -- next sync pushes ALL hours (set on config change)
  last_sync_at INTEGER,
  last_error   TEXT
);

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
      b.turns += r.turns || 1
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
    this.db.run('DELETE FROM litellm_usage WHERE provider_id = ?', [id])
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

  // ---- LiteLLM usage archive (see the litellm_usage table comment) --------

  // Every bucket ever seen for this provider, oldest first. The poller seeds
  // itself from this on startup so history the proxy no longer serves still
  // reaches snapshot()/ingest(). Shape matches what saveLitellmUsage takes.
  listLitellmUsage(providerId) {
    return this.rows(
      `SELECT dedup_key, day, ts, model, key_hash, key_alias,
              input, output, cache_read, cache_create, total, cost, turns
         FROM litellm_usage WHERE provider_id = ? ORDER BY ts`,
      [providerId]
    ).map((r) => ({
      dedupKey: r.dedup_key,
      day: r.day,
      ts: r.ts,
      model: r.model,
      keyHash: r.key_hash || null,
      keyAlias: r.key_alias || null,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheCreate: r.cache_create,
      total: r.total,
      cost: r.cost,
      turns: r.turns,
    }))
  }
  // Stores one fetch. `fromDay` (the first day of the fetched window) is what
  // keeps this an archive rather than an append-only pile: inside the window the
  // API is authoritative, so those days are dropped and rewritten — a bucket
  // deleted server-side disappears here too, and a day whose totals grew is
  // corrected rather than duplicated. Days BEFORE the window are never touched;
  // they only exist here. Omitting `fromDay` upserts without clearing.
  saveLitellmUsage(providerId, buckets, fromDay) {
    this.db.run('BEGIN')
    if (fromDay) {
      this.db.run('DELETE FROM litellm_usage WHERE provider_id = ? AND day >= ?', [providerId, fromDay])
    }
    const stmt = this.db.prepare(
      `INSERT INTO litellm_usage
         (dedup_key, provider_id, day, ts, model, key_hash, key_alias,
          input, output, cache_read, cache_create, total, cost, turns)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(dedup_key) DO UPDATE SET
         day=excluded.day, ts=excluded.ts, model=excluded.model,
         key_hash=excluded.key_hash, key_alias=excluded.key_alias,
         input=excluded.input, output=excluded.output,
         cache_read=excluded.cache_read, cache_create=excluded.cache_create,
         total=excluded.total, cost=excluded.cost, turns=excluded.turns`
    )
    for (const b of buckets || []) {
      stmt.run([
        b.dedupKey, providerId, b.day, b.ts, b.model, b.keyHash ?? null, b.keyAlias ?? null,
        b.input || 0, b.output || 0, b.cacheRead || 0, b.cacheCreate || 0,
        b.total || 0, b.cost || 0, b.turns || 0,
      ])
    }
    stmt.free()
    this.db.run('COMMIT')
    this.persist()
  }

  // ---- cloud sync (token.chinadong.net / self-hosted tokenstat-web) -------

  // Single-row config; the row is created lazily with defaults on first read.
  getCloudSync() {
    let r = this.rows('SELECT * FROM cloud_sync WHERE id = 1')[0]
    if (!r) {
      this.db.run('INSERT INTO cloud_sync (id) VALUES (1)')
      r = this.rows('SELECT * FROM cloud_sync WHERE id = 1')[0]
    }
    return {
      endpoint: r.endpoint || '',
      apiKey: r.api_key || '',
      enabled: !!r.enabled,
      syncMinutes: r.sync_minutes > 0 ? r.sync_minutes : 10,
      fullResync: !!r.full_resync,
      lastSyncAt: r.last_sync_at ?? null,
      lastError: r.last_error || null,
    }
  }

  // Any config change flags full_resync so the next push re-sends everything —
  // a new key/endpoint means the cloud side has none (or someone else's window)
  // of this device's history.
  saveCloudSync({ endpoint, apiKey, enabled, syncMinutes }) {
    this.getCloudSync() // ensure row
    this.fullResyncGen = (this.fullResyncGen || 0) + 1
    this.db.run(
      'UPDATE cloud_sync SET endpoint=?, api_key=?, enabled=?, sync_minutes=?, full_resync=1, last_error=NULL WHERE id=1',
      [String(endpoint || '').trim(), String(apiKey || '').trim(), enabled ? 1 : 0, Number(syncMinutes) > 0 ? Number(syncMinutes) : 10]
    )
    this.persist()
    return this.getCloudSync()
  }

  // Post-sync bookkeeping (lastSyncAt/lastError/fullResync), not user config.
  // `fullResyncGen` (process-local, NOT persisted) counts every raise of the
  // flag: performSync captures it before pushing and clears the flag afterward
  // only if it hasn't moved, so a Settings change landing mid-sync — whose
  // rewritten rows that pass captured too early — is never silently cleared.
  // The flag itself stays SET on disk for the whole pass, so a crash between
  // batches (the first of which already wiped the server with replaceFrom: 0)
  // resumes as a full push on restart.
  updateCloudSyncState({ lastSyncAt, lastError, fullResync } = {}) {
    this.getCloudSync() // ensure row
    const sets = []
    const args = []
    if (lastSyncAt !== undefined) { sets.push('last_sync_at=?'); args.push(lastSyncAt) }
    if (lastError !== undefined) { sets.push('last_error=?'); args.push(lastError) }
    if (fullResync !== undefined) { sets.push('full_resync=?'); args.push(fullResync ? 1 : 0) }
    if (fullResync) this.fullResyncGen = (this.fullResyncGen || 0) + 1
    if (!sets.length) return
    this.db.run(`UPDATE cloud_sync SET ${sets.join(', ')} WHERE id=1`, args)
    this.persist()
  }

  // Distinct models ever recorded for one CLI (the Settings model list unions
  // this with the provider's live /model/info so models that were removed from
  // the proxy but still have historical usage stay hide-able/renameable).
  modelsForCli(cli) {
    return this.rows(
      'SELECT model, SUM(total) AS total, SUM(cost) AS cost FROM usage_hourly WHERE cli = ? GROUP BY model ORDER BY total DESC',
      [cli]
    )
  }

  // All hourly rows since fromMs, in the sync API's camelCase shape.
  hourlySince(fromMs) {
    return this.rows(
      'SELECT hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns FROM usage_hourly WHERE hour >= ? ORDER BY hour',
      [fromMs]
    ).map((r) => ({
      hour: r.hour, cli: r.cli, model: r.model,
      input: r.input, output: r.output, cacheRead: r.cache_read, cacheCreate: r.cache_create,
      reasoning: r.reasoning, total: r.total, cost: r.cost, turns: r.turns,
    }))
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
