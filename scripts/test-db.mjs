// Headless verification of the SQLite usage DB.
// Parses real data, ingests into a temp .sqlite, then runs the report queries.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Store } from '../src/main/core/store.js'
import { UsageDb, floorDayLocal } from '../src/main/core/db.js'

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
const { performSync } = await import('../src/main/core/cloudSync.js')

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
    { keyId: 'dev-1', status: { cliMeta: { 'litellm:uuid-a': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
    { keyId: 'dev-2', status: { cliMeta: { 'litellm:uuid-b': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
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

// Verify local ingest does not advance last_sync_at or steal server-source ownership from a fresher remote device
db.saveCloudAccountSync({
  currentKeyId: 'dev-1',
  devices: [
    { id: 'dev-1', name: 'PC-1', lastSyncAt: 1000, revoked: false, isCurrent: true },
    { id: 'dev-2', name: 'PC-2', lastSyncAt: 2000, revoked: false, isCurrent: false },
  ],
  snapshots: [
    { keyId: 'dev-1', status: { cliMeta: { 'litellm:local-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
    { keyId: 'dev-2', status: { cliMeta: { 'litellm:remote-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
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
    { keyId: 'dev-1', status: { cliMeta: { 'litellm:local-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
    { keyId: 'dev-2', status: { cliMeta: { 'litellm:remote-id': { label: 'Team Proxy', baseUrl: 'https://proxy.example.com/v1' } } } },
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

console.log('multi-device account overview, cross-device LiteLLM dedupe, keyAlias attribution & concurrent sync guard verified')

fs.rmSync(dbPath, { force: true })
console.log('\nOK (temp db removed)')
