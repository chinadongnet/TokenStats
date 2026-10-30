// Headless verification of the SQLite usage DB.
// Parses real data, ingests into a temp .sqlite, then runs the report queries.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Store } from '../src/main/core/store.js'
import { UsageDb, floorDayLocal, floorHourLocal } from '../src/main/core/db.js'

const dbPath = path.join(os.tmpdir(), 'aimon-test-usage.sqlite')
fs.rmSync(dbPath, { force: true })

const store = new Store()
await store.scanAll()
await store.pollAll() // no-op unless litellm is configured in ~/.tokenstats/config.json
const records = store.dedupedRecords()

const db = new UsageDb({ dbPath })
await db.open()
console.time('ingest')
const bucketCount = db.ingest(records)
console.timeEnd('ingest')

console.log('\nrecords:', records.length, ' hourly buckets:', bucketCount)
console.log('db file size:', (fs.statSync(dbPath).size / 1024).toFixed(0), 'KB ->', dbPath)

const span = db.span()
console.log('span:', new Date(span.min).toLocaleString(), '->', new Date(span.max).toLocaleString())

const fmt = (n) => Number(n).toLocaleString('en-US')
const today = floorDayLocal(Date.now())

console.log('\n=== Today, by hour (local) ===')
const h = db.hourly(today)
const perHour = new Map()
for (const r of h) perHour.set(new Date(r.hour).getHours(), (perHour.get(new Date(r.hour).getHours()) || 0) + r.total)
if (perHour.size === 0) console.log('(no usage yet today)')
for (const [hr, tot] of [...perHour.entries()].sort((a, b) => a[0] - b[0])) {
  const bar = '#'.repeat(Math.min(40, Math.round(tot / Math.max(...perHour.values()) * 40)))
  console.log(String(hr).padStart(2, '0') + ':00  ' + fmt(tot).padStart(12) + '  ' + bar)
}

console.log('\n=== Last 30 days (per day total) ===')
const d = db.daily(today - 30 * 864e5, today + 864e5)
const dayTot = new Map()
for (const r of d) dayTot.set(r.day, (dayTot.get(r.day) || 0) + r.total)
for (const [day, tot] of [...dayTot.entries()].sort((a, b) => a[0] - b[0]).slice(-10)) {
  console.log(new Date(day).toLocaleDateString() + '  ' + fmt(tot).padStart(14))
}

console.log('\n=== Top models (all time) ===')
for (const m of db.models(0, Date.now() + 864e5).slice(0, 6)) {
  console.log((m.model || '?').padEnd(28) + ' ' + (m.cli || '').padEnd(7) + ' ' + fmt(m.total).padStart(14))
}

// Verify multi-device cloud account sync & server-source deduplication
const { computeAllSubscriptionStats } = await import('../src/main/core/subscriptions.js')
const { performSync, pullCloudAccount } = await import('../src/main/core/cloudSync.js')

const p1 = db.upsertLitellmProvider({ name: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1/', apiKey: 'k1' })
const db2Path = path.join(os.tmpdir(), 'aimon-test-usage-2.sqlite')
fs.rmSync(db2Path, { force: true })
const db2 = await new UsageDb({ dbPath: db2Path }).open()
const p2 = db2.upsertLitellmProvider({ name: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1', apiKey: 'k2' })
if (p1.id !== p2.id) {
  throw new Error(`Expected deterministic LiteLLM provider id across devices, got ${p1.id} vs ${p2.id}`)
}
fs.rmSync(db2Path, { force: true })

const nowHour = Math.floor(Date.now() / 3600000) * 3600000
db.ingest([
  {
    ts: nowHour,
    cli: 'codex',
    model: 'gpt-5',
    project: 'codex',
    sessionId: 'c0',
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 150,
    cost: 1.5,
    turns: 1,
  },
  {
    ts: nowHour,
    cli: 'cursor',
    model: 'claude-4',
    project: 'cursor',
    sessionId: 'cur0',
    input: 500,
    output: 500,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 1000,
    cost: 5.0,
    turns: 5,
  },
  {
    ts: nowHour,
    cli: 'litellm:uuid-a',
    model: 'gpt-4o',
    project: 'team-key',
    sessionId: 'litellm',
    input: 60,
    output: 40,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 100,
    cost: 1.0,
    turns: 1,
  },
])
db.saveCloudAccountSync({
  currentKeyId: 'dev-1',
  devices: [
    { id: 'dev-1', name: 'PC-1', lastSyncAt: 2000, revoked: false, isCurrent: true },
    { id: 'dev-2', name: 'PC-2', lastSyncAt: 1000, revoked: false, isCurrent: false },
  ],
  snapshots: [
    { keyId: 'dev-1', status: { cliMeta: { cursor: { accountId: 'shared-cursor-sub' }, 'litellm:uuid-a': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
    { keyId: 'dev-2', status: { cliMeta: { cursor: { accountId: 'shared-cursor-sub' }, 'litellm:uuid-b': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
  ],
  hours: [
    { keyId: 'dev-1', hour: nowHour, cli: 'codex', model: 'gpt-5', input: 100, output: 50, total: 150, cost: 1.5, turns: 1 },
    { keyId: 'dev-2', hour: nowHour, cli: 'codex', model: 'gpt-5', input: 200, output: 100, total: 300, cost: 3.0, turns: 2 },
    // cursor is a server-level source -> only dev-1 (newest lastSyncAt) should be counted in 'account'
    { keyId: 'dev-1', hour: nowHour, cli: 'cursor', model: 'claude-4', input: 500, output: 500, total: 1000, cost: 5.0, turns: 5 },
    { keyId: 'dev-2', hour: nowHour, cli: 'cursor', model: 'claude-4', input: 500, output: 500, total: 1000, cost: 5.0, turns: 5 },
    // litellm with distinct UUIDs across devices for the same proxy -> deduplicated to 100
    { keyId: 'dev-1', hour: nowHour, cli: 'litellm:uuid-a', model: 'gpt-4o', input: 60, output: 40, total: 100, cost: 1.0, turns: 1 },
    { keyId: 'dev-2', hour: nowHour, cli: 'litellm:uuid-b', model: 'gpt-4o', input: 60, output: 40, total: 100, cost: 1.0, turns: 1 },
  ],
})
const accOv = db.cloudOverview('account')
if (accOv.totals.all.total !== 1550) {
  throw new Error(`Expected merged account total 1550, got ${accOv.totals.all.total}`)
}
const dev2Ov = db.cloudOverview('dev-2')
if (dev2Ov.totals.all.total !== 1400) {
  throw new Error(`Expected dev-2 total 1400, got ${dev2Ov.totals.all.total}`)
}

// Verify keyAlias-bound LiteLLM subscription attribution on current device and account view
const todayIso = new Date(nowHour).toISOString().slice(0, 10)
const aliasSub = db.upsertSubscription({
  name: 'LiteLLM Key Plan',
  monthlyUsd: 20,
  startDate: todayIso,
  active: true,
  bindings: [{ cli: 'litellm:uuid-a', keyAlias: 'team-key', models: null }],
  resetPeriods: ['monthly'],
  resetAnchors: { monthly: todayIso },
})
const dev1SubStats = computeAllSubscriptionStats([aliasSub], db.recordsForDevice('dev-1'), nowHour + 1000)
const accSubStats = computeAllSubscriptionStats([aliasSub], db.recordsForDevice('account'), nowHour + 1000)
if (dev1SubStats[0]?.currentCycle?.tokens !== 100 || accSubStats[0]?.currentCycle?.tokens !== 100) {
  throw new Error(`Expected 100 attributed tokens for keyAlias subscription, got dev1=${dev1SubStats[0]?.currentCycle?.tokens}, acc=${accSubStats[0]?.currentCycle?.tokens}`)
}

// Verify replaceAllSubscriptions honors explicitly empty resetAnchors
db.replaceAllSubscriptions([
  {
    id: aliasSub.id,
    groupId: aliasSub.groupId,
    name: aliasSub.name,
    monthlyUsd: 20,
    startDate: todayIso,
    active: true,
    bindings: [{ cli: 'litellm:uuid-a', models: null }],
    resetPeriods: ['monthly'],
    resetAnchors: {},
  },
])
if (Object.keys(db.getSubscription(aliasSub.id).resetAnchors || {}).length !== 0) {
  throw new Error('Expected explicitly empty resetAnchors {} to clear previous anchors')
}

// Verify performSync guards against concurrent local subscription edits during pull
db.saveCloudSync({ endpoint: 'https://token.chinadong.net', apiKey: 'ts_test', enabled: true, syncMinutes: 10 })
const origFetch = globalThis.fetch
let midFlightSavedId = null
try {
  globalThis.fetch = async () => {
    const added = db.upsertSubscription({
      name: 'Concurrent Local Plan',
      monthlyUsd: 50,
      startDate: todayIso,
      active: true,
      bindings: [{ cli: 'codex', models: null }],
    })
    midFlightSavedId = added.id
    return new Response(
      JSON.stringify({
        accepted: 1,
        subscriptionSync: {
          status: 'pull',
          cloudHash: 'cloud-h2',
          cloudSubs: [{ id: aliasSub.id, name: aliasSub.name, monthlyUsd: 20, startDate: todayIso, active: true, bindings: [{ cli: 'litellm:uuid-a' }] }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  const syncRes = await performSync({ db, store: { dedupedRecords: () => [] }, liveByCli: {}, appVersion: '0.2.52' })
  if (!db.getSubscription(midFlightSavedId)) {
    throw new Error('Concurrent local subscription edit was overwritten by in-flight cloud pull')
  }
  if (syncRes.subscriptionSync?.status !== 'conflict' || !db.getCloudSync().subsConflict) {
    throw new Error('Expected mid-flight subscription edit during pull to surface a conflict')
  }
} finally {
  globalThis.fetch = origFetch
}

// Verify unidentified LiteLLM sources on different devices remain distinct
db.ingest([])
db.saveCloudAccountSync({
  currentKeyId: 'dev-1',
  devices: [
    { id: 'dev-1', name: 'PC-1', lastSyncAt: 2000, revoked: false, isCurrent: true },
    { id: 'dev-2', name: 'PC-2', lastSyncAt: 1000, revoked: false, isCurrent: false },
  ],
  snapshots: [],
  hours: [
    { keyId: 'dev-1', hour: nowHour, cli: 'litellm:proxy-a', model: 'gpt-4o', input: 60, output: 40, total: 100, cost: 1.0, turns: 1 },
    { keyId: 'dev-2', hour: nowHour, cli: 'litellm:proxy-b', model: 'gpt-4o', input: 120, output: 80, total: 200, cost: 2.0, turns: 1 },
  ],
})
const distinctProxiesAcc = db.cloudOverview('account')
if (distinctProxiesAcc.totals.all.total !== 300) {
  throw new Error(`Expected unidentified LiteLLM sources to stay distinct (300), got ${distinctProxiesAcc.totals.all.total}`)
}

// Verify saveCloudAccountSync preserves newer local usage ingested while /api/sync was in flight
db.ingest([
  {
    ts: nowHour,
    cli: 'claude',
    model: 'claude-sonnet-4-5',
    project: 'local-proj',
    sessionId: 's1',
    input: 120,
    output: 80,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 200,
    cost: 2.0,
    turns: 2,
  },
])
db.saveCloudAccountSync({
  currentKeyId: 'dev-1',
  devices: [{ id: 'dev-1', name: 'PC-1', lastSyncAt: 2000, revoked: false, isCurrent: true }],
  snapshots: [],
  hours: [
    // Older submitted snapshot before the 200-token ingest landed
    { keyId: 'dev-1', hour: nowHour, cli: 'claude', model: 'claude-sonnet-4-5', input: 60, output: 40, total: 100, cost: 1.0, turns: 1 },
  ],
})
const postSyncAcc = db.cloudOverview('account')
if (postSyncAcc.totals.all.total !== 200) {
  throw new Error(`Expected mid-flight local ingest (200) to be preserved over stale sync response (100), got ${postSyncAcc.totals.all.total}`)
}

// Verify authoritative local reduction (e.g. rewritten/shrunk bucket from 200 to 100) replaces higher stale sync response
db.ingest([
  {
    ts: nowHour,
    cli: 'claude',
    model: 'claude-sonnet-4-5',
    project: 'local-proj',
    sessionId: 's1',
    input: 60,
    output: 40,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 100,
    cost: 1.0,
    turns: 1,
  },
])
db.saveCloudAccountSync(
  {
    currentKeyId: 'dev-1',
    devices: [{ id: 'dev-1', name: 'PC-1', lastSyncAt: 2000, revoked: false, isCurrent: true }],
    snapshots: [],
    hours: [
      { keyId: 'dev-1', hour: nowHour, cli: 'claude', model: 'claude-sonnet-4-5', input: 120, output: 80, total: 200, cost: 2.0, turns: 2 },
    ],
  },
  { authoritativeLocal: true }
)
const postShrinkAcc = db.cloudOverview('account')
if (postShrinkAcc.totals.all.total !== 100) {
  throw new Error(`Expected authoritative local reduction (100) to replace stale sync response (200), got ${postShrinkAcc.totals.all.total}`)
}

// Verify mid-flight model rename and source removal remove obsolete current-device rows from sync response
db.ingest([
  {
    ts: nowHour,
    cli: 'litellm:p1',
    model: 'Friendly GPT-4o',
    project: 'litellm:p1',
    sessionId: 'l1',
    input: 50,
    output: 50,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 100,
    cost: 1.0,
    turns: 1,
  },
])
db.saveCloudAccountSync({
  currentKeyId: 'dev-1',
  devices: [{ id: 'dev-1', name: 'PC-1', lastSyncAt: 2000, revoked: false, isCurrent: true }],
  snapshots: [],
  hours: [
    // Stale server row still under the pre-rename model id
    { keyId: 'dev-1', hour: nowHour, cli: 'litellm:p1', model: 'gpt-4o', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
  ],
})
const postRenameAcc = db.cloudOverview('account')
if (postRenameAcc.totals.all.total !== 100) {
  throw new Error(`Expected mid-flight renamed model not to duplicate old server row (100), got ${postRenameAcc.totals.all.total}`)
}
db.ingest([])
db.saveCloudAccountSync({
  currentKeyId: 'dev-1',
  devices: [{ id: 'dev-1', name: 'PC-1', lastSyncAt: 2000, revoked: false, isCurrent: true }],
  snapshots: [],
  hours: [
    // Stale server row for a model/source that was just hidden or deleted locally
    { keyId: 'dev-1', hour: nowHour, cli: 'litellm:p1', model: 'Friendly GPT-4o', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
  ],
})
const postHideAcc = db.cloudOverview('account')
if (postHideAcc.totals.all.total !== 0) {
  throw new Error(`Expected hidden/deleted local source not to be restored by stale sync response (0), got ${postHideAcc.totals.all.total}`)
}

// Verify local ingest does not advance last_sync_at or steal server-source ownership from a fresher remote device
db.saveCloudAccountSync({
  currentKeyId: 'dev-1',
  devices: [
    { id: 'dev-1', name: 'PC-1', lastSyncAt: 1000, revoked: false, isCurrent: true },
    { id: 'dev-2', name: 'PC-2', lastSyncAt: 2000, revoked: false, isCurrent: false },
  ],
  snapshots: [
    { keyId: 'dev-1', status: { cliMeta: { cursor: { accountId: 'shared-cursor-sub' }, 'litellm:local-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
    { keyId: 'dev-2', status: { cliMeta: { cursor: { accountId: 'shared-cursor-sub' }, 'litellm:remote-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
  ],
  hours: [
    { keyId: 'dev-1', hour: nowHour, cli: 'cursor', model: 'claude-4', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
    { keyId: 'dev-2', hour: nowHour, cli: 'cursor', model: 'claude-4', input: 100, output: 100, total: 200, cost: 2.0, turns: 2 },
    { keyId: 'dev-1', hour: nowHour, cli: 'litellm:local-id', model: 'gpt-4o', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
    { keyId: 'dev-2', hour: nowHour, cli: 'litellm:remote-id', model: 'gpt-4o', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
  ],
})
db.ingest([
  {
    ts: nowHour,
    cli: 'cursor',
    model: 'claude-4',
    project: 'cursor',
    sessionId: 'c1',
    input: 50,
    output: 50,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 100,
    cost: 1.0,
    turns: 1,
  },
  {
    ts: nowHour,
    cli: 'claude',
    model: 'claude-sonnet-4-5',
    project: 'local-proj',
    sessionId: 's1',
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 1,
    cost: 0.01,
    turns: 1,
  },
  {
    ts: nowHour,
    cli: 'litellm:local-id',
    model: 'gpt-4o',
    project: 'litellm:local-id',
    sessionId: 'l1',
    input: 50,
    output: 50,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 100,
    cost: 1.0,
    turns: 1,
  },
])
const fresherRemoteAcc = db.cloudOverview('account')
if (fresherRemoteAcc.totals.all.total !== 301) {
  throw new Error(`Expected fresher remote Cursor (200) + LiteLLM (100) + local Claude (1) = 301, got ${fresherRemoteAcc.totals.all.total}`)
}
const remoteBoundSub = {
  id: 'sub-remote-litellm',
  groupId: 'sub-remote-litellm',
  name: 'Remote Synced LiteLLM Plan',
  monthlyUsd: 20,
  startDate: todayIso,
  active: true,
  bindings: [{ cli: 'litellm:remote-id', models: null }],
  resetPeriods: ['monthly'],
  resetAnchors: { monthly: todayIso },
}
const remoteSubAccStats = computeAllSubscriptionStats([remoteBoundSub], db.recordsForDevice('account'), nowHour + 1000)
if (remoteSubAccStats[0]?.currentCycle?.tokens !== 100) {
  throw new Error(`Expected 100 attributed tokens for remote-bound LiteLLM subscription in account view, got ${remoteSubAccStats[0]?.currentCycle?.tokens}`)
}

// Verify model rename reconciliation when deducting local alias records against fresher remote owner
db.saveModelSetting({ providerId: 'local-id', model: 'gpt-4o', visible: true, displayName: 'Friendly model' })
const renamedLocalRecs = [
  {
    ts: nowHour,
    cli: 'litellm:local-id',
    model: 'Friendly model',
    rawModel: 'gpt-4o',
    project: 'team-key',
    sessionId: 'l1',
    input: 50,
    output: 50,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 100,
    cost: 1.0,
    turns: 1,
  },
]
const renamedAccRecs = db.recordsForDevice('account', renamedLocalRecs).filter((r) => String(r.cli).startsWith('litellm:'))
const renamedAccTotal = renamedAccRecs.reduce((a, r) => a + r.total, 0)
if (renamedAccTotal !== 100) {
  throw new Error(`Expected 100 deduplicated LiteLLM tokens after model rename reconciliation, got ${renamedAccTotal}`)
}

// Verify archived history outside the winning device's covered range is preserved
const oldHour = nowHour - 40 * 86400000
db.ingest([])
db.saveCloudAccountSync({
  currentKeyId: 'dev-2',
  devices: [
    { id: 'dev-1', name: 'Desktop', lastSyncAt: 1000, revoked: false, isCurrent: false },
    { id: 'dev-2', name: 'Laptop', lastSyncAt: 2000, revoked: false, isCurrent: true },
  ],
  snapshots: [
    { keyId: 'dev-1', status: { cliMeta: { cursor: { accountId: 'shared-cursor-sub' }, 'litellm:local-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
    { keyId: 'dev-2', status: { cliMeta: { cursor: { accountId: 'shared-cursor-sub' }, 'litellm:remote-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
  ],
  hours: [
    { keyId: 'dev-1', hour: oldHour, cli: 'litellm:local-id', model: 'gpt-4o', input: 100, output: 100, total: 200, cost: 2.0, turns: 2 },
    { keyId: 'dev-1', hour: nowHour, cli: 'litellm:local-id', model: 'gpt-4o', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
    { keyId: 'dev-2', hour: nowHour, cli: 'litellm:remote-id', model: 'gpt-4o', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
  ],
})
const histAccOv = db.cloudOverview('account')
if (histAccOv.totals.all.total !== 300) {
  throw new Error(`Expected archived history (200) + recent deduplicated (100) = 300, got ${histAccOv.totals.all.total}`)
}

// Verify same LiteLLM daily bucket across fractional-hour UTC offsets (12:00 UTC vs 11:30 UTC in Asia/Kolkata) is not double-counted
const noonUtc = Date.UTC(2026, 9, 29, 12, 0, 0)
const kolkataFlooredUtc = Date.UTC(2026, 9, 29, 11, 30, 0)
db.saveCloudAccountSync({
  currentKeyId: 'dev-utc',
  devices: [
    { id: 'dev-utc', name: 'UTC-PC', lastSyncAt: 2000, revoked: false, isCurrent: true },
    { id: 'dev-ist', name: 'Kolkata-PC', lastSyncAt: 1000, revoked: false, isCurrent: false },
  ],
  snapshots: [
    { keyId: 'dev-utc', status: { cliMeta: { 'litellm:local-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
    { keyId: 'dev-ist', status: { cliMeta: { 'litellm:remote-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
  ],
  hours: [
    { keyId: 'dev-utc', hour: noonUtc, cli: 'litellm:local-id', model: 'gpt-4o', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
    { keyId: 'dev-ist', hour: kolkataFlooredUtc, cli: 'litellm:remote-id', model: 'gpt-4o', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
  ],
})
const crossTzFiltered = db.cloudFilteredRows('account').reduce((a, r) => a + r.total, 0)
if (crossTzFiltered !== 100) {
  throw new Error(`Expected 100 tokens across 12:00 UTC vs 11:30 UTC fractional-offset devices, got ${crossTzFiltered}`)
}

// Verify Cursor usage from different or unidentified Cursor accounts stays distinct across devices
db.ingest([])
db.saveCloudAccountSync({
  currentKeyId: 'dev-1',
  devices: [
    { id: 'dev-1', name: 'PC-1', lastSyncAt: 2000, revoked: false, isCurrent: true },
    { id: 'dev-2', name: 'PC-2', lastSyncAt: 1000, revoked: false, isCurrent: false },
  ],
  snapshots: [
    { keyId: 'dev-1', status: { cliMeta: { cursor: { accountId: 'user-a' } } } },
    { keyId: 'dev-2', status: { cliMeta: { cursor: { accountId: 'user-b' } } } },
  ],
  hours: [
    { keyId: 'dev-1', hour: nowHour, cli: 'cursor', model: 'claude-4', input: 50, output: 50, total: 100, cost: 1.0, turns: 1 },
    { keyId: 'dev-2', hour: nowHour, cli: 'cursor', model: 'claude-4', input: 100, output: 100, total: 200, cost: 2.0, turns: 2 },
  ],
})
const distinctCursorAcc = db.cloudOverview('account')
if (distinctCursorAcc.totals.all.total !== 300) {
  throw new Error(`Expected distinct Cursor accounts (100 + 200) to sum to 300, got ${distinctCursorAcc.totals.all.total}`)
}

// Verify switching Cursor accounts updates cursorAccountHash, buildStatusSnapshot, and cloudServerSourceOwners
const { buildStatusSnapshot } = await import('../src/main/core/cloudSync.js')
const cursorRecsA = [{ cli: 'cursor', ts: nowHour, model: 'claude-4', input: 50, output: 50, cacheRead: 0, cacheCreate: 0, reasoning: 0, total: 100, turns: 1, dedupKey: 'cursor-cloud:acct-a:1' }]
const cursorRecsB = [{ cli: 'cursor', ts: nowHour, model: 'claude-4', input: 100, output: 100, cacheRead: 0, cacheCreate: 0, reasoning: 0, total: 200, turns: 2, dedupKey: 'cursor-cloud:acct-b:1' }]
db.saveCursorUsage('user|acct-a', cursorRecsA)
const hashA = db.cursorAccountHash()
db.saveCursorUsage('user|acct-b', cursorRecsB)
const hashB = db.cursorAccountHash()
if (!hashA || !hashB || hashA === hashB) {
  throw new Error(`Expected distinct Cursor account hashes after account switch, got ${hashA} vs ${hashB}`)
}
const snapB = buildStatusSnapshot({ db, store: { dedupedRecords: () => cursorRecsB }, liveByCli: {}, appVersion: '0.2.52' })
if (snapB.cliMeta?.cursor?.accountId !== hashB) {
  throw new Error(`Expected buildStatusSnapshot to advertise active account hash ${hashB}, got ${snapB.cliMeta?.cursor?.accountId}`)
}
const snapBackToA = buildStatusSnapshot({ db, store: { dedupedRecords: () => cursorRecsA }, liveByCli: {}, appVersion: '0.2.52' })
if (snapBackToA.cliMeta?.cursor?.accountId !== hashA) {
  throw new Error(`Expected buildStatusSnapshot to follow active parser records back to ${hashA}, got ${snapBackToA.cliMeta?.cursor?.accountId}`)
}
db.ingest([])

// Verify non-whole-hour timezone bucket weighting (e.g., 10:30 UTC bucket with 10:45 UTC cutoff -> 75%)
const halfHourStart = Date.UTC(2026, 9, 29, 10, 30, 0)
const quarterPastCutoff = Date.UTC(2026, 9, 29, 10, 45, 0)
db.saveCloudAccountSync({
  currentKeyId: 'dev-tz',
  devices: [{ id: 'dev-tz', name: 'Kolkata-PC', lastSyncAt: 3000, revoked: false, isCurrent: true }],
  snapshots: [],
  hours: [
    { keyId: 'dev-tz', hour: halfHourStart, cli: 'claude', model: 'claude-4', input: 60, output: 40, total: 100, cost: 1.0, turns: 4 },
  ],
})
const tzWeighted = db.cloudTotalsSince(quarterPastCutoff, 'account')
if (tzWeighted.total.total !== 75) {
  throw new Error(`Expected 75 weighted tokens for 10:30 UTC bucket at 10:45 UTC cutoff, got ${tzWeighted.total.total}`)
}

// Verify performSync discards in-flight responses if connection credentials change mid-request
db.saveCloudSync({ endpoint: 'https://old.example.com', apiKey: 'ts_old', enabled: true, syncMinutes: 10 })
try {
  globalThis.fetch = async () => {
    db.saveCloudSync({ endpoint: 'https://new.example.com', apiKey: 'ts_new', enabled: true, syncMinutes: 10 })
    return new Response(
      JSON.stringify({
        accepted: 1,
        subscriptionSync: {
          status: 'pull',
          cloudHash: 'old-hash',
          cloudSubs: [{ id: 'leaked-old-sub', name: 'Leaked Plan', monthlyUsd: 99, startDate: todayIso, active: true, bindings: [{ cli: 'claude' }] }],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  const staleConnRes = await performSync({ db, store: { dedupedRecords: () => [] }, liveByCli: {}, appVersion: '0.2.52' })
  if (!staleConnRes.skipped || db.getSubscription('leaked-old-sub')) {
    throw new Error('Expected sync response from old credentials to be discarded after connection change')
  }
} finally {
  globalThis.fetch = origFetch
}

// Verify recovering a 10-day-old Cursor bucket on an already-synced device raises fullResync and uploads the historical bucket
{
  const nowMs = Date.now()
  const oneDayHour = Math.floor((nowMs - 1 * 86400000) / 3600000) * 3600000
  const tenDayHour = Math.floor((nowMs - 10 * 86400000) / 3600000) * 3600000
  const recRecent = {
    cli: 'cursor',
    ts: oneDayHour,
    model: 'claude-4.6-opus-max-thinking',
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 150,
    cost: 0.1,
    turns: 1,
    dedupKey: `cursor-cloud:${oneDayHour}:claude-4.6-opus-max-thinking:100:50:0:0:150:0`,
  }
  const recTenDaysAgo = {
    cli: 'cursor',
    ts: tenDayHour,
    model: 'claude-4.6-opus-max-thinking',
    input: 400,
    output: 200,
    cacheRead: 0,
    cacheCreate: 0,
    reasoning: 0,
    total: 600,
    cost: 0.4,
    turns: 2,
    dedupKey: `cursor-cloud:${tenDayHour}:claude-4.6-opus-max-thinking:400:200:0:0:600:0`,
  }
  db.saveCursorUsage('user|sync-gap', [recRecent])
  db.ingest([recRecent])
  db.saveCloudSync({ endpoint: 'https://token.chinadong.net', apiKey: 'ts_gap', enabled: true, syncMinutes: 10 })
  db.updateCloudSyncState({ fullResync: false, lastSyncAt: nowMs - 60000 })
  if (db.getCloudSync().fullResync !== false) {
    throw new Error('Expected fullResync to start false before historical gap recovery')
  }
  db.saveCursorUsage('user|sync-gap', [recTenDaysAgo, recRecent])
  if (!db.getCloudSync().fullResync) {
    throw new Error('Expected saveCursorUsage with recovered 10-day-old record to raise fullResync')
  }
  db.updateCloudSyncState({ fullResync: false })
  db.ingest([recTenDaysAgo, recRecent])
  if (!db.getCloudSync().fullResync) {
    throw new Error('Expected ingest with recovered 10-day-old bucket to raise fullResync')
  }
  let uploadedHours = []
  try {
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body)
      uploadedHours = body.hours || []
      return new Response(JSON.stringify({ accepted: uploadedHours.length }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const gapSyncRes = await performSync({
      db,
      store: { dedupedRecords: () => [recTenDaysAgo, recRecent] },
      liveByCli: {},
      appVersion: '0.2.52',
    })
    if (!gapSyncRes.ok || !uploadedHours.some((h) => h.hour === tenDayHour && h.total === 600)) {
      throw new Error(`Expected incremental performSync to upload recovered 10-day-old bucket, got ${JSON.stringify(uploadedHours)}`)
    }
  } finally {
    globalThis.fetch = origFetch
  }

  // Verify account-level mergeCloudStatus combines live quota entries across eligible devices
  // instead of keeping only the newest device's resets list.
  db.saveCloudAccountSync({
    currentKeyId: 'dev_a',
    devices: [
      { id: 'dev_a', name: 'Laptop A', lastSyncAt: nowMs - 120000 },
      { id: 'dev_b', name: 'Desktop B', lastSyncAt: nowMs - 30000 },
    ],
    snapshots: [
      {
        keyId: 'dev_a',
        updatedAt: nowMs - 120000,
        status: {
          resets: [
            { id: 'live:codex', planName: 'Codex', clis: ['codex'], windows: [{ period: '5h', remainingPct: 80 }] },
            { id: 'live:cursor', planName: 'Cursor', clis: ['cursor'], windows: [{ period: 'monthly', remainingPct: 90 }] },
          ],
        },
      },
      {
        keyId: 'dev_b',
        updatedAt: nowMs - 30000,
        status: {
          resets: [
            { id: 'live:cursor', planName: 'Cursor', clis: ['cursor'], windows: [{ period: 'monthly', remainingPct: 65 }] },
          ],
        },
      },
    ],
    hours: [
      { keyId: 'dev_a', hour: oneDayHour, cli: 'codex', model: 'gpt-5', input: 10, output: 10, total: 20, cost: 0.01, turns: 1 },
    ],
  })
  const mergedOverview = db.cloudOverview('account', nowMs)
  const mergedResets = mergedOverview?.cloudResets || []
  const codexReset = mergedResets.find((r) => (r.clis || []).includes('codex'))
  const cursorReset = mergedResets.find((r) => (r.clis || []).includes('cursor'))
  if (!codexReset || !cursorReset) {
    throw new Error(`Expected account cloudResets to merge both Codex and Cursor across devices, got ${JSON.stringify(mergedResets)}`)
  }
  if (cursorReset.windows?.[0]?.remainingPercent !== 65) {
    throw new Error(`Expected newer device's Cursor quota (65%) to win over older device (90%), got ${JSON.stringify(cursorReset)}`)
  }

  // Verify an explicitly empty local record set (e.g. when all LiteLLM models are hidden)
  // is treated as authoritative rather than resurrected from litellm_usage.
  const provHide = db.upsertLitellmProvider({ name: 'HideTest', baseUrl: 'https://hide.example.com', apiKey: 'sk-h', color: '#10b981', enabled: true })
  db.saveLitellmUsage(provHide.id, [{ dedupKey: 'hide-1', day: '2026-10-28', ts: oneDayHour, model: 'hidden-m', keyAlias: 'k1', input: 100, output: 0, cacheRead: 0, cacheCreate: 0, total: 100, cost: 0.1, turns: 1 }], '2026-10-01')
  db.saveModelSetting({ providerId: provHide.id, model: 'hidden-m', visible: false, displayName: null })
  db.ingest([])
  const curDevRecs = db.recordsForDevice('dev_a', [])
  if (curDevRecs.some((r) => r.cli === 'litellm:' + provHide.id)) {
    throw new Error(`Expected hidden LiteLLM model not to be resurrected when localRecords is [], got ${JSON.stringify(curDevRecs)}`)
  }

  // Verify retained local keyAlias usage is bounded by the winning remote bucket's totals
  // when a server-side correction reduces the remote bucket below stale local alias totals.
  db.saveCloudAccountSync({
    currentKeyId: 'dev_a',
    devices: [
      { id: 'dev_a', name: 'Office PC', lastSyncAt: nowMs - 60000, isCurrent: true },
      { id: 'dev_b', name: 'Home Mac', lastSyncAt: nowMs, isCurrent: false },
    ],
    snapshots: [
      { keyId: 'dev_a', status: { cliMeta: { 'litellm:proxy1': { label: 'SharedProxy', baseUrl: 'https://litellm.example.com' } } } },
      { keyId: 'dev_b', status: { cliMeta: { 'litellm:proxy1': { label: 'SharedProxy', baseUrl: 'https://litellm.example.com' } } } },
    ],
    hours: [
      { keyId: 'dev_b', hour: oneDayHour, cli: 'litellm:proxy1', model: 'mimo-v2-pro', input: 50, output: 50, cacheRead: 0, cacheCreate: 0, reasoning: 0, total: 100, cost: 1.0, turns: 1 },
    ],
  })
  const clampedRecs = db.recordsForDevice('account', [
    {
      ts: oneDayHour,
      hour: oneDayHour,
      cli: 'litellm:proxy1',
      model: 'mimo-v2-pro',
      input: 100,
      output: 100,
      cacheRead: 0,
      cacheCreate: 0,
      reasoning: 0,
      total: 200,
      cost: 2.0,
      turns: 2,
      sessionId: 'litellm',
      project: 'team-key-a',
    },
  ])
  const clampedTotal = clampedRecs.filter((r) => r.cli === 'litellm:proxy1').reduce((s, r) => s + r.total, 0)
  if (clampedTotal !== 100) {
    throw new Error(`Expected retained local alias usage to be bounded by winning remote bucket (100), got ${clampedTotal}`)
  }

  // Verify changing cloud connection identity clears cached remote devices/usage,
  // and pullCloudAccount rejects stale responses if credentials change mid-flight.
  if (db.listCloudDevices().length === 0) {
    throw new Error('Expected cloud_devices to be populated before credential switch')
  }
  db.saveCloudSync({ endpoint: 'https://old.example.com', apiKey: 'ts_old', enabled: true, syncMinutes: 10 })
  if (db.listCloudDevices().length !== 0 || db.getDeviceViewState().hasCloudData) {
    throw new Error(`Expected saveCloudSync to clear cached cloud_devices on credential change, got ${JSON.stringify(db.listCloudDevices())}`)
  }
  try {
    globalThis.fetch = async () => {
      db.saveCloudSync({ endpoint: 'https://new.example.com', apiKey: 'ts_new', enabled: true, syncMinutes: 10 })
      return new Response(
        JSON.stringify({
          accountSync: {
            currentKeyId: 'stale_dev',
            devices: [{ id: 'stale_dev', name: 'Stale Old Device', lastSyncAt: nowMs }],
            hours: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    const pullRes = await pullCloudAccount({ db })
    if (!pullRes.skipped || db.listCloudDevices().some((d) => d.id === 'stale_dev')) {
      throw new Error(`Expected pullCloudAccount to skip stale response after credential switch, got ${JSON.stringify(pullRes)}`)
    }
  } finally {
    globalThis.fetch = origFetch
  }

  // Verify local-time caches in db.js, store.js, and subscriptions.js invalidate when timezone changes.
  const prevTz = process.env.TZ
  try {
    const recTs = Date.UTC(2026, 9, 29, 23, 45, 0) // 2026-10-29 23:45:00 UTC -> 2026-10-30 05:15:00 Asia/Kolkata
    const nowNoonUtc = Date.UTC(2026, 9, 30, 12, 0, 0)
    const tzRec = [{
      ts: recTs,
      cli: 'claude',
      model: 'claude-sonnet-4-6',
      input: 100,
      output: 100,
      cacheRead: 0,
      cacheCreate: 0,
      reasoning: 0,
      total: 200,
      cost: 1.0,
      turns: 1,
      sessionId: 'tz-sess',
      project: 'tz-proj',
    }]
    const tzSub = [{
      id: 'sub-tz',
      groupId: 'sub-tz',
      name: 'Claude TZ',
      monthlyUsd: 20,
      startDate: '2026-10-30',
      active: true,
      bindings: [{ cli: 'claude' }],
    }]
    const tzStore = new Store()
    tzStore.files.set('tz-file', { parser: { cli: 'claude', roots: [] }, size: 1, mtimeMs: 1, state: {}, records: tzRec })

    process.env.TZ = 'UTC'
    const dayUtc = floorDayLocal(recTs)
    const hourUtc = floorHourLocal(recTs)
    const snapUtc = tzStore.snapshot(nowNoonUtc)
    const subUtc = computeAllSubscriptionStats(tzSub, tzRec, nowNoonUtc)
    db.saveCloudAccountSync({
      currentKeyId: 'dev-tz',
      devices: [{ id: 'dev-tz', name: 'TZ-PC', lastSyncAt: nowNoonUtc, revoked: false, isCurrent: true }],
      snapshots: [],
      hours: [{ keyId: 'dev-tz', hour: Math.floor(recTs / 3600000) * 3600000, cli: 'claude', model: 'claude-sonnet-4-6', input: 100, output: 100, total: 200, cost: 1.0, turns: 1 }],
    })
    const cloudOvUtc = db.cloudOverview('account', nowNoonUtc)

    process.env.TZ = 'Asia/Kolkata'
    const dayIst = floorDayLocal(recTs)
    const hourIst = floorHourLocal(recTs)
    const snapIst = tzStore.snapshot(nowNoonUtc)
    const subIst = computeAllSubscriptionStats(tzSub, tzRec, nowNoonUtc)
    const cloudOvIst = db.cloudOverview('account', nowNoonUtc)

    if (dayUtc === dayIst || hourUtc === hourIst) {
      throw new Error(`Expected floorDayLocal/floorHourLocal to update on TZ change, got day ${dayUtc} vs ${dayIst}, hour ${hourUtc} vs ${hourIst}`)
    }
    if (snapUtc.totals.today.total !== 0 || snapIst.totals.today.total !== 200) {
      throw new Error(`Expected store.snapshot today total to flip from 0 (UTC) to 200 (Asia/Kolkata), got ${snapUtc.totals.today.total} vs ${snapIst.totals.today.total}`)
    }
    if (cloudOvUtc.totals.today.total !== 0 || cloudOvIst.totals.today.total !== 200) {
      throw new Error(`Expected cloudOverview today total to align to local midnight and flip from 0 (UTC) to 200 (Asia/Kolkata), got ${cloudOvUtc.totals.today.total} vs ${cloudOvIst.totals.today.total}`)
    }
    if (
      cloudOvIst.ranges.dayStart !== snapIst.ranges.dayStart ||
      cloudOvIst.ranges.weekStart !== snapIst.ranges.weekStart ||
      cloudOvIst.ranges.monthStart !== snapIst.ranges.monthStart
    ) {
      throw new Error(`Expected cloudOverview ranges ${JSON.stringify(cloudOvIst.ranges)} to match store.snapshot ranges ${JSON.stringify(snapIst.ranges)}`)
    }
    if ((subUtc[0]?.totalTokens || 0) !== 0 || (subIst[0]?.totalTokens || 0) !== 200) {
      throw new Error(`Expected subscription stats to flip from 0 (UTC) to 200 (Asia/Kolkata), got ${subUtc[0]?.totalTokens} vs ${subIst[0]?.totalTokens}`)
    }
  } finally {
    if (prevTz === undefined) delete process.env.TZ
    else process.env.TZ = prevTz
  }
}

console.log('multi-device account overview, cross-device LiteLLM dedupe, keyAlias attribution & concurrent sync guard verified')

fs.rmSync(dbPath, { force: true })
console.log('\nOK (temp db removed)')
