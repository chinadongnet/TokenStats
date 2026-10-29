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

CREATE TABLE IF NOT EXISTS usage_root_hourly (
  hour         INTEGER NOT NULL,
  cli          TEXT    NOT NULL,
  root         TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  input        INTEGER NOT NULL DEFAULT 0,
  output       INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  reasoning    INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  cost         REAL    NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  parts_json   TEXT,
  PRIMARY KEY (hour, cli, root, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_root_cli ON usage_root_hourly(cli, hour);

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

CREATE TABLE IF NOT EXISTS cursor_usage_archive (
  user_id TEXT PRIMARY KEY,
  records_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  backfill_before_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS applied_migrations (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS cloud_sync (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row config
  endpoint     TEXT    NOT NULL DEFAULT '',
  api_key      TEXT    NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 0,
  sync_minutes INTEGER NOT NULL DEFAULT 10,
  full_resync  INTEGER NOT NULL DEFAULT 1,  -- next sync pushes ALL hours (set on config change)
  last_sync_at INTEGER,
  last_error   TEXT,
  subs_base_hash TEXT,
  subs_conflict_json TEXT,
  selected_device TEXT NOT NULL DEFAULT 'account'
);

CREATE TABLE IF NOT EXISTS cloud_devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  tz           TEXT,
  app_version  TEXT,
  last_sync_at INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0,
  is_current   INTEGER NOT NULL DEFAULT 0,
  status_json  TEXT,
  updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS cloud_usage_hourly (
  key_id       TEXT    NOT NULL,
  hour         INTEGER NOT NULL,
  cli          TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  input        INTEGER NOT NULL DEFAULT 0,
  output       INTEGER NOT NULL DEFAULT 0,
  cache_read   INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  reasoning    INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  cost         REAL    NOT NULL DEFAULT 0,
  turns        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, hour, cli, model)
);
CREATE INDEX IF NOT EXISTS idx_cloud_usage_hour ON cloud_usage_hourly(hour);
CREATE INDEX IF NOT EXISTS idx_cloud_usage_key ON cloud_usage_hourly(key_id, hour);

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
  if (!subs.has('group_id')) db.run('ALTER TABLE subscriptions ADD COLUMN group_id TEXT')
  const cloudCols = columns('cloud_sync')
  if (!cloudCols.has('subs_base_hash')) db.run('ALTER TABLE cloud_sync ADD COLUMN subs_base_hash TEXT')
  if (!cloudCols.has('subs_conflict_json')) db.run('ALTER TABLE cloud_sync ADD COLUMN subs_conflict_json TEXT')
  if (!cloudCols.has('selected_device')) db.run("ALTER TABLE cloud_sync ADD COLUMN selected_device TEXT NOT NULL DEFAULT 'account'")
  const rootHourly = columns('usage_root_hourly')
  if (!rootHourly.has('parts_json')) db.run('ALTER TABLE usage_root_hourly ADD COLUMN parts_json TEXT')
  const cursorArchiveCols = columns('cursor_usage_archive')
  if (!cursorArchiveCols.has('updated_at')) db.run('ALTER TABLE cursor_usage_archive ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0')
  if (!cursorArchiveCols.has('backfill_before_ms')) db.run('ALTER TABLE cursor_usage_archive ADD COLUMN backfill_before_ms INTEGER NOT NULL DEFAULT 0')
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
    this._lastIngestedRecords = Array.isArray(records) ? records.map((r) => ({ ...r })) : []
    const cursorRecs = this._lastIngestedRecords.filter((r) => r && r.cli === 'cursor')
    if (cursorRecs.length) {
      const matchedUser = this._resolveCursorUserFromRecords(cursorRecs)
      this._activeCursorUserId = matchedUser
      if (matchedUser) {
        this.db.run('UPDATE cursor_usage_archive SET updated_at = ? WHERE user_id = ?', [this._nextCursorArchiveTs(), matchedUser])
      }
    } else {
      this._activeCursorUserId = null
    }
    const buckets = new Map() // key: hour|cli|model
    const rootBuckets = new Map() // key: hour|cli|root|model
    for (const r of records) {
      const hour = floorHourLocal(r.ts)
      const cost = r.cost != null ? r.cost : costFor(r)
      const turns = r.turns || 1
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
      b.cost += cost
      b.turns += turns

      const effRoot =
        r.root ||
        (typeof r.cli === 'string' && r.cli.startsWith('litellm:') && r.project && r.project !== r.cli
          ? 'alias:' + r.project
          : null)
      if (effRoot) {
        const rKey = hour + '|' + r.cli + '|' + effRoot + '|' + r.model
        let rb = rootBuckets.get(rKey)
        if (!rb) {
          rb = { hour, cli: r.cli, root: effRoot, model: r.model, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, total: 0, cost: 0, turns: 0, parts: [] }
          rootBuckets.set(rKey, rb)
        }
        rb.input += r.input
        rb.output += r.output
        rb.cacheRead += r.cacheRead
        rb.cacheCreate += r.cacheCreate
        rb.reasoning += r.reasoning
        rb.total += r.total
        rb.cost += cost
        rb.turns += turns
        if (Array.isArray(r.parts) && r.parts.length) {
          rb.parts.push(...r.parts)
        } else if (r.dedupKey) {
          rb.parts.push({
            dedupKey: r.dedupKey,
            input: r.input,
            output: r.output,
            cacheRead: r.cacheRead,
            cacheCreate: r.cacheCreate,
            reasoning: r.reasoning,
            total: r.total,
            turns,
          })
        }
      }
    }

    const prevHourlyRows = this.rows('SELECT hour, cli, model, total, cost, turns FROM usage_hourly')
    const prevLocalMap = new Map(prevHourlyRows.map((r) => [`${r.hour}|${r.cli}|${r.model}`, r]))
    const removedKeys = new Set()
    const historicalCutoff = Date.now() - 6 * 24 * 3600 * 1000
    let historicalChanged = false
    for (const [k, prev] of prevLocalMap.entries()) {
      if (!buckets.has(k)) {
        removedKeys.add(k)
        if (prev.hour < historicalCutoff) historicalChanged = true
      }
    }
    for (const [k, b] of buckets.entries()) {
      if (b.hour >= historicalCutoff) continue
      const prev = prevLocalMap.get(k)
      if (!prev || prev.total !== b.total || prev.turns !== b.turns || Math.abs((prev.cost || 0) - (b.cost || 0)) > 1e-6) {
        historicalChanged = true
      }
    }
    this._locallyRemovedKeys = removedKeys
    if (this._deletedLitellmClis) {
      for (const b of buckets.values()) this._deletedLitellmClis.delete(b.cli)
    }
    if (historicalChanged) {
      this.getCloudSync()
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
    this.db.run('DELETE FROM usage_root_hourly')
    const rootStmt = this.db.prepare(
      'INSERT INTO usage_root_hourly (hour,cli,root,model,input,output,cache_read,cache_create,reasoning,total,cost,turns,parts_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    for (const rb of rootBuckets.values()) {
      rootStmt.run([rb.hour, rb.cli, rb.root, rb.model, rb.input, rb.output, rb.cacheRead, rb.cacheCreate, rb.reasoning, rb.total, rb.cost, rb.turns, rb.parts.length ? JSON.stringify(rb.parts) : null])
    }
    rootStmt.free()
    // Keep the current device's rows in cloud_usage_hourly in sync with local
    // ingests so "all devices (account)" and "this device" views immediately
    // reflect new local usage even between cloud sync passes.
    const curDev = this.rows('SELECT id FROM cloud_devices WHERE is_current = 1 LIMIT 1')[0]
    if (curDev?.id) {
      this.db.run('DELETE FROM cloud_usage_hourly WHERE key_id = ?', [curDev.id])
      const cStmt = this.db.prepare(
        'INSERT INTO cloud_usage_hourly (key_id,hour,cli,model,input,output,cache_read,cache_create,reasoning,total,cost,turns) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      for (const b of buckets.values()) {
        cStmt.run([curDev.id, b.hour, b.cli, b.model, b.input, b.output, b.cacheRead, b.cacheCreate, b.reasoning, b.total, b.cost, b.turns])
      }
      cStmt.free()
    }
    if (historicalChanged) {
      this.fullResyncGen = (this.fullResyncGen || 0) + 1
      this.db.run('UPDATE cloud_sync SET full_resync = 1 WHERE id = 1')
    }
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

  // id absent -> insert a new provider (deterministic id from baseUrl so
  // configuring the same LiteLLM proxy on multiple devices shares the same
  // cross-device CLI identity); id present -> update in place.
  upsertLitellmProvider({ id, name, baseUrl, apiKey, color, syncMinutes, enabled }) {
    const now = Date.now()
    const existing = id ? this.getLitellmProvider(id) : null
    let resolvedId = existing ? id : id || null
    if (!resolvedId) {
      const candidate = deterministicLitellmId(baseUrl)
      resolvedId = !this.getLitellmProvider(candidate) ? candidate : crypto.randomUUID()
    }
    const row = {
      id: resolvedId,
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
    if (!this._deletedLitellmClis) this._deletedLitellmClis = new Set()
    this._deletedLitellmClis.add('litellm:' + id)
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
    let subsConflict = null
    if (r.subs_conflict_json) {
      try {
        subsConflict = JSON.parse(r.subs_conflict_json)
      } catch {
        subsConflict = null
      }
    }
    return {
      endpoint: r.endpoint || '',
      apiKey: r.api_key || '',
      enabled: !!r.enabled,
      syncMinutes: r.sync_minutes > 0 ? r.sync_minutes : 10,
      fullResync: !!r.full_resync,
      lastSyncAt: r.last_sync_at ?? null,
      lastError: r.last_error || null,
      subsBaseHash: r.subs_base_hash || null,
      subsConflict,
      selectedDevice: r.selected_device || 'account',
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
  updateCloudSyncState({ lastSyncAt, lastError, fullResync, subsBaseHash, subsConflict } = {}) {
    this.getCloudSync() // ensure row
    const sets = []
    const args = []
    if (lastSyncAt !== undefined) { sets.push('last_sync_at=?'); args.push(lastSyncAt) }
    if (lastError !== undefined) { sets.push('last_error=?'); args.push(lastError) }
    if (fullResync !== undefined) { sets.push('full_resync=?'); args.push(fullResync ? 1 : 0) }
    if (subsBaseHash !== undefined) { sets.push('subs_base_hash=?'); args.push(subsBaseHash || null) }
    if (subsConflict !== undefined) { sets.push('subs_conflict_json=?'); args.push(subsConflict ? JSON.stringify(subsConflict) : null) }
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

  // Per-root hourly history for multi-root sources that prune old conversations
  // independently (AGY CLI + AGY desktop). Falls back to unrooted usage_hourly
  // rows on first upgrade before usage_root_hourly has been populated.
  agyHistory() {
    const rooted = this.rows(
      `SELECT hour, cli, root, model, input, output, cache_read, cache_create, reasoning, total, cost, turns, parts_json
       FROM usage_root_hourly
       WHERE cli = 'agy'
       ORDER BY hour ASC`
    ).map((r) => {
      let parts = null
      if (r.parts_json) {
        try {
          parts = JSON.parse(r.parts_json)
        } catch {
          parts = null
        }
      }
      return {
        hour: r.hour,
        cli: r.cli,
        root: r.root,
        model: r.model,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheCreate: r.cache_create,
        reasoning: r.reasoning,
        total: r.total,
        cost: r.cost,
        turns: r.turns,
        ...(Array.isArray(parts) ? { parts } : {}),
      }
    })
    if (rooted.length) return rooted
    return this.hourlySince(0).filter((r) => r.cli === 'agy')
  }

  _nextCursorArchiveTs() {
    const maxRow = this.rows('SELECT COALESCE(MAX(updated_at), 0) AS m FROM cursor_usage_archive')[0]
    const next = Math.max(Date.now(), (this._cursorArchiveSeq || 0) + 1, (Number(maxRow?.m) || 0) + 1)
    this._cursorArchiveSeq = next
    return next
  }

  setActiveCursorUser(userId) {
    const uid = userId && userId !== 'unknown' ? String(userId) : null
    this._activeCursorUserId = uid
    if (uid) {
      const existing = this.rows('SELECT user_id FROM cursor_usage_archive WHERE user_id = ?', [uid])[0]
      if (existing) {
        this.db.run('UPDATE cursor_usage_archive SET updated_at = ? WHERE user_id = ?', [this._nextCursorArchiveTs(), uid])
        this.persist()
      }
    }
  }

  listCursorUsage(userId, legacyRows = null) {
    const uid = userId && userId !== 'unknown' ? String(userId) : null
    if (uid) this._activeCursorUserId = uid
    const row = this.rows('SELECT records_json, backfill_before_ms FROM cursor_usage_archive WHERE user_id = ?', [userId])[0]
    if (row) {
      if (uid) {
        this.db.run('UPDATE cursor_usage_archive SET updated_at = ? WHERE user_id = ?', [this._nextCursorArchiveTs(), uid])
      }
      const parsed = JSON.parse(row.records_json)
      const out = uid ? parsed.map((r) => (r && r.userId === uid ? r : { ...r, userId: uid })) : parsed
      const backfillBeforeMs = Number(row.backfill_before_ms) || 0
      if (backfillBeforeMs > 0) {
        Object.defineProperty(out, 'backfillBeforeMs', { value: backfillBeforeMs, enumerable: false, configurable: true })
      }
      return out
    }
    // Upgrade existing installs without losing older hourly totals. Historical
    // buckets remain aggregates; recent buckets become real request rows.
    if (this.rows('SELECT user_id FROM cursor_usage_archive LIMIT 1').length) return []
    return (legacyRows || this.hourlySince(0)).filter((r) => r.cli === 'cursor').map((r) => ({
      ...r,
      ...(uid ? { userId: uid } : {}),
      ts: r.hour,
      sessionId: 'cloud',
      project: 'cursor',
      dedupKey: `cursor-legacy:${r.hour}:${r.model}`,
    }))
  }

  saveCursorUsage(userId, records, backfillBeforeMs = null) {
    const uid = userId && userId !== 'unknown' ? String(userId) : null
    if (uid) this._activeCursorUserId = uid
    const tagged = uid
      ? (records || []).map((r) => (r && r.userId === uid ? r : { ...r, userId: uid }))
      : records || []
    const resolvedBackfill =
      backfillBeforeMs != null && Number.isFinite(Number(backfillBeforeMs))
        ? Math.max(0, Number(backfillBeforeMs))
        : (records || []).reduce(
            (min, r) => (Number(r?.backfillBeforeMs) > 0 && (min === 0 || r.backfillBeforeMs < min) ? Number(r.backfillBeforeMs) : min),
            Number(records?.backfillBeforeMs) > 0 ? Number(records.backfillBeforeMs) : 0
          )
    const historicalCutoff = Date.now() - 6 * 24 * 3600 * 1000
    const histSig = (rows) =>
      (rows || [])
        .filter((r) => r && Number(r.ts ?? r.hour) < historicalCutoff)
        .map((r) => `${r.dedupKey || ''}|${r.ts ?? r.hour}|${r.model || ''}|${r.total || 0}|${r.input || 0}|${r.output || 0}`)
        .sort()
        .join('\n')
    const existingRow = this.rows('SELECT records_json FROM cursor_usage_archive WHERE user_id = ?', [userId])[0]
    let prevRecords = []
    if (existingRow?.records_json) {
      try {
        prevRecords = JSON.parse(existingRow.records_json)
      } catch {
        prevRecords = []
      }
    }
    const nextHist = histSig(tagged)
    const prevHist = histSig(prevRecords)
    const updatedAt = this._nextCursorArchiveTs()
    this.db.run(
      `INSERT INTO cursor_usage_archive (user_id, records_json, updated_at, backfill_before_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET records_json=excluded.records_json, updated_at=excluded.updated_at, backfill_before_ms=excluded.backfill_before_ms`,
      [userId, JSON.stringify(tagged), updatedAt, resolvedBackfill]
    )
    if (nextHist !== prevHist) {
      this.getCloudSync()
      this.fullResyncGen = (this.fullResyncGen || 0) + 1
      this.db.run('UPDATE cloud_sync SET full_resync = 1 WHERE id = 1')
    }
    this.persist()
  }

  _resolveCursorUserFromRecords(cursorRecs) {
    if (!Array.isArray(cursorRecs) || !cursorRecs.length) return null
    for (let i = cursorRecs.length - 1; i >= 0; i--) {
      const r = cursorRecs[i]
      const uid = r?.userId || r?.cursorUserId || r?.accountId
      if (uid && uid !== 'unknown') return String(uid)
    }
    const archives = this.rows('SELECT user_id, records_json FROM cursor_usage_archive ORDER BY updated_at DESC')
    if (!archives.length) return null
    let bestUserId = null
    let bestScore = 0
    for (const a of archives) {
      let parsed = []
      try {
        parsed = JSON.parse(a.records_json || '[]')
      } catch {
        parsed = []
      }
      const aDedupKeys = new Set()
      const aExactKeys = new Set()
      const aHourKeys = new Set()
      for (const ar of parsed) {
        if (ar.dedupKey && !String(ar.dedupKey).startsWith('cursor-legacy:')) aDedupKeys.add(String(ar.dedupKey))
        const ts = ar.ts ?? ar.hour
        if (Number.isFinite(ts)) {
          aExactKeys.add(`${ts}|${ar.model || ''}|${ar.total || 0}`)
          aHourKeys.add(`${floorHourLocal(ts)}|${ar.model || ''}|${ar.total || 0}`)
        }
      }
      let score = 0
      let matched = 0
      for (const r of cursorRecs) {
        const dk = r.dedupKey && !String(r.dedupKey).startsWith('cursor-legacy:') ? String(r.dedupKey) : ''
        const ts = r.ts ?? r.hour
        if (dk && aDedupKeys.has(dk)) {
          score += 10
          matched++
        } else if (Number.isFinite(ts) && aExactKeys.has(`${ts}|${r.model || ''}|${r.total || 0}`)) {
          score += 2
          matched++
        } else if (Number.isFinite(ts) && aHourKeys.has(`${floorHourLocal(ts)}|${r.model || ''}|${r.total || 0}`)) {
          score += 1
          matched++
        }
      }
      if (matched === cursorRecs.length && parsed.length === cursorRecs.length) {
        score += 1
      }
      if (score > bestScore) {
        bestScore = score
        bestUserId = a.user_id
      }
    }
    return bestScore > 0 ? String(bestUserId) : null
  }

  cursorAccountHash(records = null) {
    if (Array.isArray(records)) {
      const passedCursor = records.filter((r) => r && r.cli === 'cursor')
      if (passedCursor.length) {
        const resolved = this._resolveCursorUserFromRecords(passedCursor)
        if (resolved) {
          this._activeCursorUserId = resolved
          return hashCursorAccount(resolved)
        }
      }
    }
    if (this._activeCursorUserId) {
      return hashCursorAccount(this._activeCursorUserId)
    }
    if (Array.isArray(this._lastIngestedRecords)) {
      const ingestedCursor = this._lastIngestedRecords.filter((r) => r && r.cli === 'cursor')
      if (!ingestedCursor.length) return ''
      const resolved = this._resolveCursorUserFromRecords(ingestedCursor)
      return resolved ? hashCursorAccount(resolved) : ''
    }
    const hourlyCursor = this.rows("SELECT hour, model, total FROM usage_hourly WHERE cli = 'cursor'")
    if (hourlyCursor.length) {
      const resolved = this._resolveCursorUserFromRecords(hourlyCursor)
      if (resolved) return hashCursorAccount(resolved)
    }
    const r = this.rows('SELECT user_id FROM cursor_usage_archive ORDER BY updated_at DESC LIMIT 1')[0]
    return hashCursorAccount(r?.user_id)
  }

  hasMigration(name) {
    return this.rows('SELECT name FROM applied_migrations WHERE name = ?', [name]).length > 0
  }

  markMigration(name) {
    if (this.hasMigration(name)) return false
    this.db.run('INSERT INTO applied_migrations (name) VALUES (?)', [name])
    this.persist()
    return true
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
  upsertSubscription({ id, groupId, name, monthlyUsd, startDate, active, endDate, bindings, resetPeriods, resetAnchors }) {
    const now = Date.now()
    const existing = id ? this.getSubscription(id) : null
    const group = groupId || existing?.groupId || null
    if (group && !this.listSubscriptions().some((s) => s.groupId === group)) throw new Error('Subscription group no longer exists')
    const validDate = (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      const date = new Date(value + 'T12:00:00Z')
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    }
    if (!validDate(startDate) || (active === false && (!validDate(endDate) || endDate < startDate))) throw new Error('Invalid purchase period dates')
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
    this.db.run('UPDATE subscriptions SET group_id=? WHERE id=?', [group || row.id, row.id])
    // A group is one subscription name with independently editable purchases.
    this.db.run('UPDATE subscriptions SET name=? WHERE group_id=?', [row.name, group || row.id])
    this.persist()
    return this.getSubscription(row.id)
  }

  deleteSubscription(id) {
    this.db.run('DELETE FROM subscriptions WHERE id = ?', [id])
    this.persist()
  }

  // Replace local subscriptions with a canonical list pulled from cloud sync
  // (e.g. on 'use_cloud' or 'merge' conflict resolution), preserving any
  // local-only keyAlias on matching CLI bindings so local LiteLLM key filters
  // aren't lost across round-trips.
  replaceAllSubscriptions(cloudSubs) {
    if (!Array.isArray(cloudSubs)) return this.listSubscriptions()
    const existing = this.listSubscriptions()
    const prevById = new Map(existing.map((s) => [s.id, s]))
    const prevByKey = new Map(existing.map((s) => [`${String(s.name || '').toLowerCase()}|${s.startDate}`, s]))
    const now = Date.now()

    this.db.run('BEGIN')
    try {
      this.db.run('DELETE FROM subscriptions')
      for (const cs of cloudSubs) {
        if (!cs || !cs.name || !cs.startDate) continue
        const prev = prevById.get(cs.id) || prevByKey.get(`${String(cs.name || '').toLowerCase()}|${cs.startDate}`) || null
        const prevAliasByCli = new Map(
          (prev?.bindings || [])
            .filter((b) => b && b.cli && b.keyAlias)
            .map((b) => [b.cli, b.keyAlias])
        )
        const rawBindings = Array.isArray(cs.bindings) && cs.bindings.length
          ? cs.bindings
          : Array.isArray(cs.clis)
            ? cs.clis.map((cli) => ({ cli }))
            : []
        const bindings = rawBindings
          .filter((b) => b && b.cli)
          .map((b) => ({
            cli: b.cli,
            keyAlias: b.keyAlias || prevAliasByCli.get(b.cli) || null,
            models: Array.isArray(b.models) && b.models.length ? b.models : null,
          }))
        const periods = RESET_PERIODS.filter((p) =>
          (Array.isArray(cs.resetPeriods) ? cs.resetPeriods : prev?.resetPeriods || []).includes(p)
        )
        const srcAnchors =
          cs.resetAnchors && typeof cs.resetAnchors === 'object' && !Array.isArray(cs.resetAnchors)
            ? cs.resetAnchors
            : prev?.resetAnchors || {}
        const anchors = {}
        for (const p of periods) {
          const v = srcAnchors && srcAnchors[p]
          if (ANCHORED_PERIODS.includes(p) && typeof v === 'string' && v) anchors[p] = v
        }
        const id = cs.id || prev?.id || crypto.randomUUID()
        const groupId = cs.groupId || prev?.groupId || id
        const active = cs.active !== false ? 1 : 0
        const endDate = active ? null : cs.endDate || prev?.endDate || new Date().toISOString().slice(0, 10)
        const createdAt = Number(cs.createdAt) || prev?.createdAt || now
        const updatedAt = Number(cs.updatedAt) || now
        this.db.run(
          'INSERT INTO subscriptions (id,group_id,name,monthly_usd,start_date,active,end_date,bindings,reset_periods,reset_anchors,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            id,
            groupId,
            String(cs.name).trim(),
            Number(cs.monthlyUsd) || 0,
            cs.startDate,
            active,
            endDate,
            JSON.stringify(bindings),
            periods.length ? JSON.stringify(periods) : null,
            Object.keys(anchors).length ? JSON.stringify(anchors) : null,
            createdAt,
            updatedAt,
          ]
        )
      }
      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
    this.persist()
    return this.listSubscriptions()
  }

  mergeSubscriptions(groupIds, targetId) {
    const ids = new Set(groupIds || [])
    if (ids.size < 2 || !ids.has(targetId)) throw new Error('Select at least two subscriptions and a target')
    const rows = this.listSubscriptions()
    const target = rows.find((s) => s.groupId === targetId)
    if (!target || [...ids].some((id) => !rows.some((s) => s.groupId === id))) throw new Error('Subscription no longer exists')
    this.db.run('BEGIN')
    try {
      for (const row of rows) if (ids.has(row.groupId)) {
        this.db.run('UPDATE subscriptions SET group_id=?, name=?, updated_at=? WHERE id=?', [targetId, target.name, Date.now(), row.id])
      }
      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
    this.persist()
    return this.listSubscriptions()
  }

  separateSubscription(id) {
    const row = this.getSubscription(id)
    if (!row) throw new Error('Purchase period no longer exists')
    // Independent identity even when this is the former group's first row.
    this.db.run('UPDATE subscriptions SET group_id=?, updated_at=? WHERE id=?', [crypto.randomUUID(), Date.now(), id])
    this.persist()
    return this.getSubscription(id)
  }

  // ---- multi-device cloud account state -----------------------------------

  saveCloudAccountSync(accountSync, opts = {}) {
    if (!accountSync || !Array.isArray(accountSync.devices)) return
    const snapMap = new Map()
    for (const s of accountSync.snapshots || []) {
      if (s && s.keyId) snapMap.set(s.keyId, s)
    }
    this.db.run('BEGIN')
    try {
      this.db.run('DELETE FROM cloud_devices')
      const devStmt = this.db.prepare(
        `INSERT INTO cloud_devices (id, name, tz, app_version, last_sync_at, revoked, is_current, status_json, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      for (const d of accountSync.devices) {
        if (!d || !d.id) continue
        const snap = snapMap.get(d.id)
        const isCur = d.isCurrent || (accountSync.currentKeyId && d.id === accountSync.currentKeyId) ? 1 : 0
        devStmt.run([
          d.id,
          String(d.name || d.id),
          d.tz || null,
          d.appVersion || null,
          d.lastSyncAt || null,
          d.revoked ? 1 : 0,
          isCur,
          snap?.status ? JSON.stringify(snap.status) : null,
          snap?.updatedAt || d.lastSyncAt || null,
        ])
      }
      devStmt.free()

      if (Array.isArray(accountSync.hours)) {
        this.db.run('DELETE FROM cloud_usage_hourly')
        const hStmt = this.db.prepare(
          `INSERT INTO cloud_usage_hourly
             (key_id, hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key_id, hour, cli, model) DO UPDATE SET
             input=excluded.input, output=excluded.output, cache_read=excluded.cache_read,
             cache_create=excluded.cache_create, reasoning=excluded.reasoning,
             total=excluded.total, cost=excluded.cost, turns=excluded.turns`
        )
        for (const h of accountSync.hours) {
          if (!h || !h.keyId || !Number.isFinite(Number(h.hour)) || !h.cli || !h.model) continue
          hStmt.run([
            h.keyId,
            Number(h.hour),
            String(h.cli),
            String(h.model),
            Number(h.input) || 0,
            Number(h.output) || 0,
            Number(h.cacheRead) || 0,
            Number(h.cacheCreate) || 0,
            Number(h.reasoning) || 0,
            Number(h.total) || 0,
            Number(h.cost) || 0,
            Number(h.turns) || 0,
          ])
        }
        hStmt.free()

        // If local usage was ingested, renamed, hidden, or deleted while
        // /api/sync was in flight, the returned accountSync snapshot still
        // carries the older submitted rows for this device. Reconcile the
        // current device's row set against authoritative local data so
        // renamed/hidden/deleted rows are removed and newer local totals win.
        const curDev = accountSync.devices.find(
          (d) => d && d.id && (d.isCurrent || (accountSync.currentKeyId && d.id === accountSync.currentKeyId))
        )
        if (curDev?.id) {
          const localRows = this.rows(
            'SELECT hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns FROM usage_hourly'
          )
          if (localRows.length) {
            this.db.run('DELETE FROM cloud_usage_hourly WHERE key_id = ?', [curDev.id])
            const lStmt = this.db.prepare(
              `INSERT INTO cloud_usage_hourly
                 (key_id, hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
            )
            for (const r of localRows) {
              lStmt.run([
                curDev.id,
                r.hour,
                r.cli,
                r.model,
                r.input,
                r.output,
                r.cache_read,
                r.cache_create,
                r.reasoning,
                r.total,
                r.cost,
                r.turns,
              ])
            }
            lStmt.free()
          } else if (opts?.authoritativeLocal) {
            this.db.run('DELETE FROM cloud_usage_hourly WHERE key_id = ?', [curDev.id])
          } else {
            const existingCurRows = this.rows(
              'SELECT hour, cli, model FROM cloud_usage_hourly WHERE key_id = ?',
              [curDev.id]
            )
            const invalidLitellmModels = new Set()
            for (const s of this.rows('SELECT provider_id, model, visible, display_name FROM litellm_model_settings')) {
              const cli = 'litellm:' + s.provider_id
              if (s.visible === 0) {
                invalidLitellmModels.add(`${cli}|${s.model}`)
                if (s.display_name) invalidLitellmModels.add(`${cli}|${s.display_name}`)
              } else if (s.display_name && s.display_name !== s.model) {
                invalidLitellmModels.add(`${cli}|${s.model}`)
              }
            }
            const delStmt = this.db.prepare(
              'DELETE FROM cloud_usage_hourly WHERE key_id = ? AND hour = ? AND cli = ? AND model = ?'
            )
            for (const er of existingCurRows) {
              const fullKey = `${er.hour}|${er.cli}|${er.model}`
              if (
                this._locallyRemovedKeys?.has(fullKey) ||
                this._deletedLitellmClis?.has(er.cli) ||
                invalidLitellmModels.has(`${er.cli}|${er.model}`)
              ) {
                delStmt.run([curDev.id, er.hour, er.cli, er.model])
              }
            }
            delStmt.free()
          }
        }
      }
      this.db.run('COMMIT')
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
    this.persist()
  }

  listCloudDevices() {
    return this.rows(
      'SELECT * FROM cloud_devices ORDER BY is_current DESC, COALESCE(last_sync_at, 0) DESC, name ASC'
    ).map((r) => {
      let status = null
      if (r.status_json) {
        try {
          status = JSON.parse(r.status_json)
        } catch {
          status = null
        }
      }
      return {
        id: r.id,
        name: r.name,
        tz: r.tz || null,
        appVersion: r.app_version || null,
        lastSyncAt: r.last_sync_at ?? null,
        revoked: !!r.revoked,
        isCurrent: !!r.is_current,
        updatedAt: r.updated_at ?? null,
        status,
      }
    })
  }

  resolveDeviceId(deviceId = null) {
    const devices = this.listCloudDevices()
    if (!devices.length) return 'local'
    const raw = deviceId || this.getCloudSync().selectedDevice || 'account'
    if (raw === 'account' || raw === 'local') return raw
    if (devices.some((d) => d.id === raw)) return raw
    return 'account'
  }

  getDeviceViewState() {
    const devices = this.listCloudDevices()
    const selectedDevice = this.resolveDeviceId()
    const cur = devices.find((d) => d.isCurrent) || null
    return {
      selectedDevice,
      hasCloudData: devices.length > 0,
      currentKeyId: cur?.id || null,
      devices: devices.map(({ status, ...rest }) => rest),
    }
  }

  setSelectedDevice(deviceId) {
    this.getCloudSync()
    const next = this.resolveDeviceId(deviceId)
    this.db.run('UPDATE cloud_sync SET selected_device = ? WHERE id = 1', [next])
    this.persist()
    return this.getDeviceViewState()
  }

  // Server-level sources (cursor.com account data and LiteLLM proxy polling)
  // report identical account-wide numbers on every device where they're enabled.
  // In the merged 'account' view, only the most recently synced non-revoked
  // device that has rows for that source is counted — identical to tokenstat-web.
  // Because two devices configuring the same LiteLLM proxy may have generated
  // distinct random UUIDs (`litellm:<uuid-A>` vs `litellm:<uuid-B>`), resolve
  // a shared cross-device source identity (by normalized baseUrl or provider
  // label when metadata establishes they are the same source) before selecting
  // the winning owner device. Unidentified LiteLLM sources retain their own
  // CLI identity so unrelated proxies are never collapsed.
  cloudServerSourceOwners() {
    const localProviders = this.listLitellmProviders()
    const devices = this.listCloudDevices()
    const metaByDevCli = new Map()
    const urlByLabel = new Map()
    const localCliByIdentity = new Map()

    const localCursorAcc = this.cursorAccountHash()
    if (localCursorAcc) {
      metaByDevCli.set('local|cursor', { accountId: localCursorAcc })
    }

    for (const p of localProviders) {
      const cli = 'litellm:' + p.id
      const baseUrl = normalizeLitellmBaseUrl(p.baseUrl)
      const label = String(p.name || '').trim().toLowerCase()
      if (baseUrl && label) urlByLabel.set(label, baseUrl)
      metaByDevCli.set(`local|${cli}`, { baseUrl, label })
    }
    for (const d of devices) {
      if (d.isCurrent) {
        if (localCursorAcc) {
          metaByDevCli.set(`${d.id}|cursor`, { accountId: localCursorAcc })
        }
        for (const p of localProviders) {
          const cli = 'litellm:' + p.id
          const baseUrl = normalizeLitellmBaseUrl(p.baseUrl)
          const label = String(p.name || '').trim().toLowerCase()
          metaByDevCli.set(`${d.id}|${cli}`, { baseUrl, label })
        }
      }
      for (const [cli, meta] of Object.entries(d.status?.cliMeta || {})) {
        if (cli === 'cursor') {
          const existing = metaByDevCli.get(`${d.id}|cursor`) || {}
          const rawAcc =
            d.isCurrent && existing.accountId
              ? existing.accountId
              : meta?.accountId || meta?.accountHash || meta?.userId || meta?.sub || existing.accountId
          const accountId = hashCursorAccount(rawAcc)
          if (accountId) {
            metaByDevCli.set(`${d.id}|cursor`, { accountId })
          }
          continue
        }
        if (!cli.startsWith('litellm:')) continue
        const existing = metaByDevCli.get(`${d.id}|${cli}`) || {}
        const baseUrl = normalizeLitellmBaseUrl(meta?.baseUrl || existing.baseUrl)
        const label = String(meta?.label || existing.label || '').trim().toLowerCase()
        if (baseUrl && label) urlByLabel.set(label, baseUrl)
        metaByDevCli.set(`${d.id}|${cli}`, { baseUrl, label })
        if (!metaByDevCli.has(`*|${cli}`)) metaByDevCli.set(`*|${cli}`, { baseUrl, label })
      }
    }

    const rows = this.rows(
      `SELECT h.cli, h.key_id, MIN(h.hour) AS min_hour, MAX(h.hour) AS max_hour, COALESCE(d.last_sync_at, 0) AS synced
       FROM cloud_usage_hourly h
       JOIN cloud_devices d ON d.id = h.key_id
       WHERE d.revoked = 0
       GROUP BY h.cli, h.key_id
       ORDER BY synced DESC, h.cli ASC`
    )

    const identityFor = (keyId, cli) => {
      if (!isServerSourceCli(cli)) return cli
      if (cli === 'cursor') {
        const m =
          (keyId && metaByDevCli.get(`${keyId}|cursor`)) ||
          (keyId === 'local' ? metaByDevCli.get('local|cursor') : null)
        if (m?.accountId) return `cursor:acct:${m.accountId}`
        return keyId ? `cursor:dev:${keyId}` : 'cursor'
      }
      const m = (keyId && metaByDevCli.get(`${keyId}|${cli}`)) || metaByDevCli.get(`local|${cli}`) || metaByDevCli.get(`*|${cli}`)
      const baseUrl = m?.baseUrl || (m?.label ? urlByLabel.get(m.label) : '')
      if (baseUrl) return `litellm:url:${baseUrl}`
      if (m?.label) return `litellm:label:${m.label}`
      return cli
    }

    const clisByIdentity = new Map()
    const recordIdentityCli = (idKey, cli) => {
      if (!idKey || !cli) return
      let set = clisByIdentity.get(idKey)
      if (!set) {
        set = new Set()
        clisByIdentity.set(idKey, set)
      }
      set.add(cli)
    }

    for (const p of localProviders) {
      const cli = 'litellm:' + p.id
      const idKey = identityFor('local', cli)
      if (!localCliByIdentity.has(idKey)) localCliByIdentity.set(idKey, cli)
      recordIdentityCli(idKey, cli)
    }
    for (const d of devices) {
      for (const cli of Object.keys(d.status?.cliMeta || {})) {
        if (!cli.startsWith('litellm:')) continue
        recordIdentityCli(identityFor(d.id, cli), cli)
      }
    }

    const owners = new Map()
    const canonicalCliByIdentity = new Map()
    const devSpanByIdentity = new Map()
    for (const r of rows) {
      if (!isServerSourceCli(r.cli)) continue
      const idKey = identityFor(r.key_id, r.cli)
      recordIdentityCli(idKey, r.cli)
      if (!owners.has(idKey)) {
        owners.set(idKey, r.key_id)
        canonicalCliByIdentity.set(idKey, localCliByIdentity.get(idKey) || r.cli)
      }
      if (!owners.has(r.cli)) {
        owners.set(r.cli, owners.get(idKey))
      }
      let devMap = devSpanByIdentity.get(idKey)
      if (!devMap) {
        devMap = new Map()
        devSpanByIdentity.set(idKey, devMap)
      }
      const prev = devMap.get(r.key_id)
      const minB = serverSourceBucketMs(r.min_hour)
      const maxB = serverSourceBucketMs(r.max_hour)
      if (!prev) {
        devMap.set(r.key_id, { keyId: r.key_id, minBucket: minB, maxBucket: maxB, synced: Number(r.synced) || 0 })
      } else {
        if (minB < prev.minBucket) prev.minBucket = minB
        if (maxB > prev.maxBucket) prev.maxBucket = maxB
      }
    }

    // Build per-identity historical coverage segments using normalized UTC-day
    // server-source buckets so fractional-hour timezone offsets (e.g. 11:30 UTC
    // in Asia/Kolkata vs 12:00 UTC for the same LiteLLM daily bucket) are
    // recognized as the same server bucket rather than older history.
    const segmentsByIdentity = new Map()
    for (const [idKey, devMap] of devSpanByIdentity.entries()) {
      const ordered = [...devMap.values()].sort((a, b) => b.synced - a.synced)
      const segs = []
      let earliest = Infinity
      for (const d of ordered) {
        if (!segs.length) {
          segs.push({ keyId: d.keyId, fromBucket: d.minBucket, toBucket: Infinity })
          earliest = d.minBucket
        } else if (d.minBucket < earliest) {
          segs.push({ keyId: d.keyId, fromBucket: d.minBucket, toBucket: earliest })
          earliest = d.minBucket
        }
      }
      segmentsByIdentity.set(idKey, segs)
    }

    owners.identityFor = identityFor
    owners.ownerForHour = (idKey, hour) => {
      const segs = segmentsByIdentity.get(idKey)
      if (!segs || !segs.length) return owners.get(idKey) || null
      const b = serverSourceBucketMs(hour)
      for (const s of segs) {
        if (b >= s.fromBucket && b < s.toBucket) return s.keyId
      }
      return segs[segs.length - 1].keyId
    }
    owners.canonicalCliFor = (keyId, cli) => {
      if (!String(cli || '').startsWith('litellm:')) return cli
      const idKey = identityFor(keyId, cli)
      return localCliByIdentity.get(idKey) || canonicalCliByIdentity.get(idKey) || cli
    }
    owners.equivalentClisFor = (keyId, cli) => {
      if (!String(cli || '').startsWith('litellm:')) return [cli]
      const idKey = identityFor(keyId, cli)
      const canon = owners.canonicalCliFor(keyId, cli)
      return [...new Set([canon, cli, ...(clisByIdentity.get(idKey) || [])])]
    }
    return owners
  }

  // Deduplicated hourly rows for the selected device ('account', '<keyId>', or 'local').
  cloudFilteredRows(deviceId = null, fromMs = null, toMs = null) {
    const eff = this.resolveDeviceId(deviceId)
    if (eff === 'local') {
      const conds = []
      const args = []
      if (fromMs != null) { conds.push('hour >= ?'); args.push(fromMs) }
      if (toMs != null) { conds.push('hour < ?'); args.push(toMs) }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      return this.rows(
        `SELECT hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns
         FROM usage_hourly ${where} ORDER BY hour`,
        args
      )
    }

    const conds = []
    const args = []
    if (eff !== 'account') { conds.push('key_id = ?'); args.push(eff) }
    if (fromMs != null) { conds.push('hour >= ?'); args.push(fromMs) }
    if (toMs != null) { conds.push('hour < ?'); args.push(toMs) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const raw = this.rows(
      `SELECT key_id, hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns
       FROM cloud_usage_hourly ${where} ORDER BY hour`,
      args
    )
    if (eff !== 'account') return raw

    const owners = this.cloudServerSourceOwners()
    const merged = new Map()
    for (const r of raw) {
      if (!keepCloudRow(r, 'account', owners)) continue
      const cli = owners.canonicalCliFor ? owners.canonicalCliFor(r.key_id, r.cli) : r.cli
      const k = `${r.hour}|${cli}|${r.model}`
      let b = merged.get(k)
      if (!b) {
        b = {
          hour: r.hour,
          cli,
          model: r.model,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_create: 0,
          reasoning: 0,
          total: 0,
          cost: 0,
          turns: 0,
        }
        merged.set(k, b)
      }
      b.input += r.input || 0
      b.output += r.output || 0
      b.cache_read += r.cache_read || 0
      b.cache_create += r.cache_create || 0
      b.reasoning += r.reasoning || 0
      b.total += r.total || 0
      b.cost += r.cost || 0
      b.turns += r.turns || 0
    }
    return [...merged.values()].sort((a, b) => a.hour - b.hour)
  }

  _resolveLocalRecords(localRecords = null) {
    if (Array.isArray(localRecords) && localRecords.length) return localRecords
    if (Array.isArray(this._lastIngestedRecords) && this._lastIngestedRecords.length) {
      return this._lastIngestedRecords
    }
    const aliasRows = this.rows(
      `SELECT hour, cli, root, model, input, output, cache_read, cache_create, reasoning, total, cost, turns
       FROM usage_root_hourly
       WHERE root LIKE 'alias:%'
       ORDER BY hour`
    )
    const aliasCovered = new Set()
    const out = []
    for (const r of aliasRows) {
      aliasCovered.add(`${r.hour}|${r.cli}|${r.model}`)
      out.push({
        ts: r.hour,
        hour: r.hour,
        cli: r.cli,
        model: r.model,
        input: r.input || 0,
        output: r.output || 0,
        cacheRead: r.cache_read || 0,
        cacheCreate: r.cache_create || 0,
        reasoning: r.reasoning || 0,
        total: r.total || 0,
        cost: r.cost || 0,
        turns: r.turns || 1,
        sessionId: 'local',
        project: r.root.slice('alias:'.length),
      })
    }
    const litellmRows = this.rows(
      `SELECT provider_id, ts, model, key_alias, input, output, cache_read, cache_create, total, cost, turns
       FROM litellm_usage
       ORDER BY ts`
    )
    for (const r of litellmRows) {
      const cli = 'litellm:' + r.provider_id
      const hour = floorHourLocal(r.ts)
      const hKey = `${hour}|${cli}|${r.model}`
      if (aliasCovered.has(hKey)) continue
      aliasCovered.add(hKey)
      out.push({
        ts: r.ts,
        hour,
        cli,
        model: r.model,
        input: r.input || 0,
        output: r.output || 0,
        cacheRead: r.cache_read || 0,
        cacheCreate: r.cache_create || 0,
        reasoning: 0,
        total: r.total || 0,
        cost: r.cost || 0,
        turns: r.turns || 1,
        sessionId: 'litellm',
        project: r.key_alias || cli,
      })
    }
    const hourlyRows = this.rows(
      `SELECT hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns
       FROM usage_hourly
       ORDER BY hour`
    )
    for (const r of hourlyRows) {
      if (aliasCovered.has(`${r.hour}|${r.cli}|${r.model}`)) continue
      out.push({
        ts: r.hour,
        hour: r.hour,
        cli: r.cli,
        model: r.model,
        input: r.input || 0,
        output: r.output || 0,
        cacheRead: r.cache_read || 0,
        cacheCreate: r.cache_create || 0,
        reasoning: r.reasoning || 0,
        total: r.total || 0,
        cost: r.cost || 0,
        turns: r.turns || 1,
        sessionId: 'local',
        project: r.cli,
      })
    }
    return out
  }

  // Record objects for subscription cycle / plan breakdown / timeline calculations
  // when viewing 'local', the current device, 'account', or a remote device.
  // Preserves original local records (and their LiteLLM keyAlias in `project`)
  // for the current device and in merged account statistics.
  recordsForDevice(deviceId = null, localRecords = null) {
    const eff = this.resolveDeviceId(deviceId)
    const local = this._resolveLocalRecords(localRecords)
    if (eff === 'local') return local

    const curDev = this.rows('SELECT id FROM cloud_devices WHERE is_current = 1 LIMIT 1')[0]
    const toCloudRec = (r, cliOverride = null) => {
      const cli = cliOverride || r.cli
      return {
        ts: r.hour,
        hour: r.hour,
        cli,
        ...(Array.isArray(r.cliAliases) && r.cliAliases.length > 1 ? { cliAliases: r.cliAliases } : {}),
        model: r.model,
        ...(r.rawModel && r.rawModel !== r.model ? { rawModel: r.rawModel } : {}),
        input: r.input || 0,
        output: r.output || 0,
        cacheRead: r.cache_read || 0,
        cacheCreate: r.cache_create || 0,
        reasoning: r.reasoning || 0,
        total: r.total || 0,
        cost: r.cost || 0,
        turns: r.turns || 1,
        sessionId: 'cloud',
        project: cli,
      }
    }

    if (curDev?.id && eff === curDev.id) {
      if (!local.length) return this.cloudFilteredRows(eff).map((r) => toCloudRec(r))
      const coveredHours = new Set(local.map((r) => `${floorHourLocal(r.ts)}|${r.cli}|${r.model}`))
      const extraCloud = this.cloudFilteredRows(eff)
        .filter((r) => !coveredHours.has(`${r.hour}|${r.cli}|${r.model}`))
        .map((r) => toCloudRec(r))
      return [...local, ...extraCloud]
    }

    if (eff === 'account') {
      const owners = this.cloudServerSourceOwners()
      const curKeyId = curDev?.id || null

      // Reconcile local LiteLLM display renames with raw model IDs so local
      // alias deductions match remote aggregates regardless of display settings.
      const rawByIdDisplay = new Map()
      const displayByIdRaw = new Map()
      for (const s of this.rows(
        'SELECT provider_id, model, display_name FROM litellm_model_settings WHERE display_name IS NOT NULL AND display_name != ""'
      )) {
        const cli = 'litellm:' + s.provider_id
        const idKey = owners.identityFor(curKeyId || 'local', cli)
        const disp = String(s.display_name).trim()
        if (disp && s.model) {
          rawByIdDisplay.set(`${idKey}|${disp}`, s.model)
          displayByIdRaw.set(`${idKey}|${s.model}`, disp)
        }
      }
      for (const r of local) {
        if (isServerSourceCli(r.cli) && r.rawModel && r.model && r.rawModel !== r.model) {
          const idKey = owners.identityFor(curKeyId || 'local', r.cli)
          rawByIdDisplay.set(`${idKey}|${r.model}`, r.rawModel)
          displayByIdRaw.set(`${idKey}|${r.rawModel}`, r.model)
        }
      }
      const rawModelFor = (idKey, model, rawModel = null) =>
        rawModel || rawByIdDisplay.get(`${idKey}|${model}`) || model

      const keptLocal = []
      const localCoveredServerDevIds = new Set()
      const localCoveredCurDevHours = new Set()
      const localAliasDeduct = new Map()
      for (const r of local) {
        const rHour = floorHourLocal(r.ts)
        if (!isServerSourceCli(r.cli)) {
          keptLocal.push(r)
          localCoveredCurDevHours.add(`${rHour}|${r.cli}|${r.model}`)
          continue
        }
        const idKey = owners.identityFor(curKeyId || 'local', r.cli)
        const ownerAtHour = owners.ownerForHour ? owners.ownerForHour(idKey, rHour) : owners.get(idKey)
        const curOwns = !curKeyId || ownerAtHour === curKeyId || !owners.has(idKey)
        const hasAlias = Boolean(r.project && r.project !== r.cli)
        if (curOwns || hasAlias) {
          const canonCli = owners.canonicalCliFor ? owners.canonicalCliFor(curKeyId || 'local', r.cli) : r.cli
          const cliAliases = owners.equivalentClisFor ? owners.equivalentClisFor(curKeyId || 'local', r.cli) : [canonCli]
          const rawM = rawModelFor(idKey, r.model, r.rawModel)
          const dispM = displayByIdRaw.get(`${idKey}|${rawM}`) || r.model
          keptLocal.push({
            ...r,
            cli: canonCli,
            model: dispM,
            ...(rawM !== dispM ? { rawModel: rawM } : {}),
            ...(cliAliases.length > 1 ? { cliAliases } : {}),
            project: r.project === r.cli ? canonCli : r.project,
          })
          if (curOwns) {
            if (curKeyId) localCoveredServerDevIds.add(`${idKey}|${curKeyId}`)
            localCoveredCurDevHours.add(`${rHour}|${r.cli}|${r.model}`)
          } else {
            const dk = `${serverSourceBucketMs(rHour)}|${canonCli}|${rawM}`
            const prev = localAliasDeduct.get(dk) || {
              input: 0,
              output: 0,
              cache_read: 0,
              cache_create: 0,
              reasoning: 0,
              total: 0,
              cost: 0,
              turns: 0,
            }
            prev.input += r.input || 0
            prev.output += r.output || 0
            prev.cache_read += r.cacheRead || 0
            prev.cache_create += r.cacheCreate || 0
            prev.reasoning += r.reasoning || 0
            prev.total += r.total || 0
            prev.cost += r.cost != null ? r.cost : costFor(r)
            prev.turns += r.turns || 1
            localAliasDeduct.set(dk, prev)
          }
        }
      }

      const rawCloud = this.rows(
        `SELECT key_id, hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns
         FROM cloud_usage_hourly ORDER BY hour`
      )
      const mergedCloud = new Map()
      for (const r of rawCloud) {
        if (!keepCloudRow(r, 'account', owners)) continue
        if (isServerSourceCli(r.cli)) {
          const idKey = owners.identityFor(r.key_id, r.cli)
          if (localCoveredServerDevIds.has(`${idKey}|${r.key_id}`)) continue
        } else if (curKeyId && r.key_id === curKeyId) {
          if (localCoveredCurDevHours.has(`${r.hour}|${r.cli}|${r.model}`)) continue
        }
        const idKey = isServerSourceCli(r.cli) ? owners.identityFor(r.key_id, r.cli) : r.cli
        const cli = owners.canonicalCliFor ? owners.canonicalCliFor(r.key_id, r.cli) : r.cli
        const eqClis = owners.equivalentClisFor ? owners.equivalentClisFor(r.key_id, r.cli) : [cli]
        const rawM = isServerSourceCli(r.cli) ? rawModelFor(idKey, r.model) : r.model
        const dispM = isServerSourceCli(r.cli) ? (displayByIdRaw.get(`${idKey}|${rawM}`) || r.model) : r.model
        const deductKey = isServerSourceCli(r.cli)
          ? `${serverSourceBucketMs(r.hour)}|${cli}|${rawM}`
          : `${r.hour}|${cli}|${rawM}`
        const k = `${r.hour}|${cli}|${rawM}`
        let b = mergedCloud.get(k)
        if (!b) {
          b = {
            hour: r.hour,
            cli,
            deductKey,
            cliAliases: new Set(eqClis),
            model: dispM,
            rawModel: rawM !== dispM ? rawM : null,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_create: 0,
            reasoning: 0,
            total: 0,
            cost: 0,
            turns: 0,
          }
          mergedCloud.set(k, b)
        } else {
          for (const c of eqClis) b.cliAliases.add(c)
        }
        b.input += r.input || 0
        b.output += r.output || 0
        b.cache_read += r.cache_read || 0
        b.cache_create += r.cache_create || 0
        b.reasoning += r.reasoning || 0
        b.total += r.total || 0
        b.cost += r.cost || 0
        b.turns += r.turns || 0
      }

      const cloudRecs = []
      for (const b of mergedCloud.values()) {
        const deduct = localAliasDeduct.get(b.deductKey)
        if (deduct) {
          const take = (field) => {
            const d = Math.min(b[field], deduct[field])
            b[field] -= d
            deduct[field] -= d
          }
          take('input')
          take('output')
          take('cache_read')
          take('cache_create')
          take('reasoning')
          take('total')
          take('cost')
          take('turns')
        }
        if (b.total > 0 || b.cost > 0) {
          cloudRecs.push(toCloudRec({ ...b, cliAliases: [...b.cliAliases] }))
        }
      }

      return [...keptLocal, ...cloudRecs]
    }

    return this.cloudFilteredRows(eff).map((r) => toCloudRec(r))
  }

  // Exact replica of tokenstat-web/src/lib/usage.js#totalsSince so the desktop
  // client's 日/周/月/全 numbers match the cloud web dashboard 100%.
  cloudTotalsSince(fromMs, deviceId = null, owners = null) {
    const eff = this.resolveDeviceId(deviceId)
    const HOUR_MS = 3600 * 1000
    const queryFromHour = fromMs > 0 ? fromMs - HOUR_MS : 0

    let rows
    if (eff === 'local') {
      rows = this.rows(
        `SELECT 'local' AS key_id, hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns
         FROM usage_hourly WHERE hour > ?`,
        [fromMs > 0 ? queryFromHour : -1]
      )
    } else if (eff === 'account') {
      rows = this.rows(
        `SELECT key_id, hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns
         FROM cloud_usage_hourly WHERE hour > ?`,
        [fromMs > 0 ? queryFromHour : -1]
      )
    } else {
      rows = this.rows(
        `SELECT key_id, hour, cli, model, input, output, cache_read, cache_create, reasoning, total, cost, turns
         FROM cloud_usage_hourly WHERE key_id = ? AND hour > ?`,
        [eff, fromMs > 0 ? queryFromHour : -1]
      )
    }

    const effOwners = eff === 'account' ? (owners || this.cloudServerSourceOwners()) : null
    const blankBucket = () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      reasoning: 0,
      total: 0,
      cost: 0,
      turns: 0,
      count: 0,
    })
    const perCli = {}
    const perModel = {}
    const total = blankBucket()

    for (const r of rows) {
      if (fromMs > 0 && r.hour + HOUR_MS <= fromMs) continue
      if (eff === 'account' && !keepCloudRow(r, 'account', effOwners)) continue
      const cli = eff === 'account' && effOwners?.canonicalCliFor ? effOwners.canonicalCliFor(r.key_id, r.cli) : r.cli
      const w = fromMs > 0 && r.hour < fromMs ? (r.hour + HOUR_MS - fromMs) / HOUR_MS : 1
      addWeightedBucket(total, r, w)
      addWeightedBucket((perCli[cli] ||= blankBucket()), r, w)
      const mk = `${cli}|${r.model}`
      const mb = (perModel[mk] ||= { cli, model: r.model, ...blankBucket() })
      addWeightedBucket(mb, r, w)
    }
    roundWeightedBucket(total)
    for (const b of Object.values(perCli)) roundWeightedBucket(b)
    for (const b of Object.values(perModel)) roundWeightedBucket(b)
    return {
      fromMs,
      perCli,
      perModel: Object.values(perModel).sort((a, b) => b.total - a.total),
      total,
    }
  }

  // Cloud-consistent overview for the tray popup when viewing 'account' (all
  // devices merged) or a specific synced device.
  cloudOverview(deviceId = null, now = Date.now()) {
    const viewState = this.getDeviceViewState()
    const eff = deviceId ? this.resolveDeviceId(deviceId) : viewState.selectedDevice
    if (!viewState.hasCloudData || eff === 'local') return null

    const owners = eff === 'account' ? this.cloudServerSourceOwners() : null
    const ranges = {
      dayStart: now - 24 * 3600 * 1000,
      weekStart: now - 7 * 24 * 3600 * 1000,
      monthStart: now - 30 * 24 * 3600 * 1000,
    }
    const dayScope = this.cloudTotalsSince(ranges.dayStart, eff, owners)
    const weekScope = this.cloudTotalsSince(ranges.weekStart, eff, owners)
    const monthScope = this.cloudTotalsSince(ranges.monthStart, eff, owners)
    const allScope = this.cloudTotalsSince(0, eff, owners)

    const devices = this.listCloudDevices()
    const status =
      eff === 'account'
        ? mergeCloudStatus(devices.filter((d) => !d.revoked && d.status))
        : devices.find((d) => d.id === eff)?.status || null

    const providerMap = new Map()
    for (const p of this.listLitellmProviders()) {
      if (p.enabled) providerMap.set('litellm:' + p.id, { id: 'litellm:' + p.id, label: p.name, color: p.color })
    }
    for (const [cliId, meta] of Object.entries(status?.cliMeta || {})) {
      if (cliId.startsWith('litellm:')) {
        const canonId = eff === 'account' && owners?.canonicalCliFor ? owners.canonicalCliFor(null, cliId) : cliId
        if (!providerMap.has(canonId)) {
          providerMap.set(canonId, { id: canonId, label: meta.label || canonId, color: meta.color || '#f59e0b' })
        }
      }
    }
    for (const cliId of Object.keys(allScope.perCli || {})) {
      if (cliId.startsWith('litellm:') && !providerMap.has(cliId)) {
        const meta = status?.cliMeta?.[cliId]
        providerMap.set(cliId, { id: cliId, label: meta?.label || cliId, color: meta?.color || '#f59e0b' })
      }
    }

    const normalizedResets = (status?.resets || []).map((r) => {
      const bindings =
        Array.isArray(r.bindings) && r.bindings.length
          ? r.bindings
          : (r.clis || []).map((cli) => ({ cli, models: null }))
      return {
        ...r,
        name: r.planName || r.name || 'Plan',
        planName: r.planName || r.name || 'Plan',
        monthlyUsd: Number(r.monthlyUsd) || 0,
        bindings,
        windows: (r.windows || []).map((w) => {
          const period = w.period || (w.label === '5小时' || w.label === '5h' ? '5h' : w.label === '每周' || w.label === 'wk' ? 'weekly' : w.label === '每月' || w.label === 'mo' ? 'monthly' : w.label)
          const periodMs =
            w.periodMs ||
            (period === '5h' ? 5 * 3600 * 1000 : period === 'weekly' ? 7 * 86400 * 1000 : period === 'monthly' ? 30 * 86400 * 1000 : 0)
          const rem = w.remainingPercent ?? w.remainingPct ?? 0
          return {
            ...w,
            source: 'live',
            open: true,
            period,
            periodMs,
            end: w.end ?? w.endMs ?? null,
            endMs: w.endMs ?? w.end ?? null,
            remainingPercent: rem,
            remainingPct: rem,
            usedPercent: w.usedPercent ?? Math.max(0, 100 - rem),
            tokens: w.tokens || 0,
            cost: w.cost || 0,
          }
        }),
        renewal: r.renewal
          ? {
              ...r.renewal,
              end: r.renewal.end ?? r.renewal.endMs ?? null,
              endMs: r.renewal.endMs ?? r.renewal.end ?? null,
              periodMs: r.renewal.periodMs || 30 * 86400 * 1000,
              cost: r.renewal.cost || 0,
              tokens: r.renewal.tokens || 0,
            }
          : null,
      }
    })

    return {
      generatedAt: now,
      isCloudOverview: true,
      selectedDevice: eff,
      deviceView: { ...viewState, selectedDevice: eff },
      ranges,
      totals: {
        all: allScope.total,
        today: dayScope.total,
        week: weekScope.total,
        month: monthScope.total,
      },
      perCli: allScope.perCli,
      todayPerCli: dayScope.perCli,
      weekPerCli: weekScope.perCli,
      monthPerCli: monthScope.perCli,
      perModel: allScope.perModel,
      todayPerModel: dayScope.perModel,
      weekPerModel: weekScope.perModel,
      monthPerModel: monthScope.perModel,
      providers: [...providerMap.values()],
      cloudStatus: status,
      cloudResets: normalizedResets,
    }
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
  hourly(dayStartMs, deviceId = null) {
    const end = dayStartMs + 24 * 3600 * 1000
    const eff = this.resolveDeviceId(deviceId)
    if (eff === 'local') {
      return this.rows(
        'SELECT hour, cli, model, total, cost, turns FROM usage_hourly WHERE hour >= ? AND hour < ? ORDER BY hour',
        [dayStartMs, end]
      )
    }
    return this.cloudFilteredRows(eff, dayStartMs, end).map((r) => ({
      hour: r.hour,
      cli: r.cli,
      model: r.model,
      total: r.total,
      cost: r.cost,
      turns: r.turns,
    }))
  }

  // Per-day-per-cli totals across a range (for the trend chart).
  daily(fromMs, toMs, deviceId = null) {
    const eff = this.resolveDeviceId(deviceId)
    const rows =
      eff === 'local'
        ? this.rows(
            'SELECT hour, cli, SUM(total) AS total, SUM(cost) AS cost, SUM(turns) AS turns FROM usage_hourly WHERE hour >= ? AND hour < ? GROUP BY hour, cli',
            [fromMs, toMs]
          )
        : this.cloudFilteredRows(eff, fromMs, toMs)
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
  models(fromMs, toMs, deviceId = null) {
    const eff = this.resolveDeviceId(deviceId)
    if (eff === 'local') {
      return this.rows(
        'SELECT cli, model, SUM(total) AS total, SUM(cost) AS cost, SUM(turns) AS turns FROM usage_hourly WHERE hour >= ? AND hour < ? GROUP BY cli, model ORDER BY total DESC',
        [fromMs, toMs]
      )
    }
    const rows = this.cloudFilteredRows(eff, fromMs, toMs)
    const byModel = new Map()
    for (const r of rows) {
      const k = `${r.cli}|${r.model}`
      const cur = byModel.get(k) || { cli: r.cli, model: r.model, total: 0, cost: 0, turns: 0 }
      cur.total += r.total || 0
      cur.cost += r.cost || 0
      cur.turns += r.turns || 0
      byModel.set(k, cur)
    }
    return [...byModel.values()].sort((a, b) => b.total - a.total)
  }

  // Earliest recorded hour (for default ranges / "since" label).
  span(deviceId = null) {
    const eff = this.resolveDeviceId(deviceId)
    if (eff === 'local') {
      const r = this.rows('SELECT MIN(hour) AS min, MAX(hour) AS max FROM usage_hourly')[0]
      return { min: r?.min ?? null, max: r?.max ?? null }
    }
    const rows = this.cloudFilteredRows(eff)
    if (!rows.length) return { min: null, max: null }
    return { min: rows[0].hour, max: rows[rows.length - 1].hour }
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
    groupId: r.group_id || r.id,
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

function normalizeLitellmBaseUrl(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '').toLowerCase()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  return s
}

function deterministicLitellmId(baseUrl) {
  const normUrl = normalizeLitellmBaseUrl(baseUrl)
  if (!normUrl) return crypto.randomUUID()
  const h = crypto.createHash('sha256').update('litellm-provider:' + normUrl).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function isServerSourceCli(cli) {
  return cli === 'cursor' || (typeof cli === 'string' && cli.startsWith('litellm:'))
}

function hashCursorAccount(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^[0-9a-f]{16,64}$/i.test(s)) return s.toLowerCase()
  return crypto.createHash('sha256').update('cursor-account:' + s).digest('hex').slice(0, 24)
}

function serverSourceBucketMs(hour) {
  return Math.floor(Number(hour) / 86400000) * 86400000
}

function keepCloudRow(r, deviceId, owners) {
  if (deviceId && deviceId !== 'account') return r.key_id === deviceId
  if (isServerSourceCli(r.cli)) {
    const idKey = owners?.identityFor ? owners.identityFor(r.key_id, r.cli) : r.cli
    if (owners?.ownerForHour) return owners.ownerForHour(idKey, r.hour) === r.key_id
    return owners.get(idKey) === r.key_id
  }
  return true
}

function addWeightedBucket(b, r, w = 1) {
  b.input += (r.input || 0) * w
  b.output += (r.output || 0) * w
  b.cacheRead += (r.cache_read || 0) * w
  b.cacheCreate += (r.cache_create || 0) * w
  b.reasoning += (r.reasoning || 0) * w
  b.total += (r.total || 0) * w
  b.cost += (r.cost || 0) * w
  b.turns += (r.turns || 0) * w
  b.count += (r.turns || 0) * w
}

function roundWeightedBucket(b) {
  b.input = Math.round(b.input)
  b.output = Math.round(b.output)
  b.cacheRead = Math.round(b.cacheRead)
  b.cacheCreate = Math.round(b.cacheCreate)
  b.reasoning = Math.round(b.reasoning)
  b.total = Math.round(b.total)
  b.cost = Math.round(b.cost * 100) / 100
  b.turns = Math.round(b.turns)
  b.count = Math.round(b.count)
}

const FALLBACK_MAX_AGE_MS = 30 * 24 * 3600 * 1000

function mergeCloudStatus(devicesWithStatus) {
  if (!devicesWithStatus.length) return null
  const sorted = [...devicesWithStatus].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
  const cliMeta = {}
  for (const d of sorted) Object.assign(cliMeta, d.status?.cliMeta || {})
  const newest = sorted[sorted.length - 1]
  const cutoff = (newest.updatedAt || 0) - FALLBACK_MAX_AGE_MS
  const newestWith = (field) =>
    [...sorted]
      .reverse()
      .find((d) => (d.updatedAt || 0) >= cutoff && Array.isArray(d.status?.[field]) && d.status[field].length) || null
  const resetsSrc = newestWith('resets')
  return {
    updatedAt: newest.updatedAt,
    appVersion: newest.status?.appVersion || newest.appVersion || null,
    cliMeta,
    resets: resetsSrc?.status?.resets || [],
    plans: newestWith('plans')?.status?.plans || [],
    resetsTz: resetsSrc?.tz || null,
  }
}
