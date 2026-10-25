import assert from 'node:assert/strict'
import { computeCycleDashboard, computeSubscriptionStats, computeAllSubscriptionStats, computePlanBreakdown, computePlanTimeline } from '../src/main/core/subscriptions.js'
import { UsageDb } from '../src/main/core/db.js'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime()
const plan = {
  id: 'active-plan',
  name: 'Active plan',
  monthlyUsd: 20,
  startDate: '2026-07-15',
  active: true,
  bindings: [{ cli: 'claude' }],
}
const record = (ts, total, cost) => ({
  cli: 'claude',
  ts,
  model: 'test-model',
  project: 'subscription-test',
  input: total,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  reasoning: 0,
  total,
  turns: 1,
  cost,
})
const records = [
  record(at(2026, 7, 20), 300, 5),
  record(at(2026, 8, 16), 200, 7),
]

const active = computeSubscriptionStats(plan, records, at(2026, 8, 20))
assert.equal(active.currentCycle.start, at(2026, 8, 15, 0))
assert.equal(active.currentCycle.end, at(2026, 9, 15, 0))
assert.equal(active.currentCycle.fee, 20)
assert.equal(active.currentCycle.cost, 7)
assert.equal(active.currentCycle.tokens, 200)
assert.equal(active.totalCost, 12)
assert.equal(active.peakCycle.tokens, 300)
assert.equal(active.peakCycle.cost, 5)

const ended = computeSubscriptionStats({ ...plan, active: false, endDate: '2026-08-20' }, records, at(2026, 8, 20))
assert.equal(ended.currentCycle, null)
assert.equal(ended.peakCycle.tokens, 300)

console.log('OK: active subscription exposes its current billing-cycle comparison')

const purchases = [
  { ...plan, id: 'january', groupId: 'same-plan', active: false, startDate: '2026-01-01', endDate: '2026-01-31', monthlyUsd: 20 },
  { ...plan, id: 'march', groupId: 'same-plan', active: false, startDate: '2026-03-01', endDate: '2026-03-31', monthlyUsd: 30, bindings: [{ cli: 'claude', keyAlias: null, models: [] }] },
]
const history = [record(at(2026, 1, 20), 100, 1), record(at(2026, 2, 20), 500, 5), record(at(2026, 3, 20), 200, 2), record(at(2026, 4, 20), 1000, 10)]
const now = at(2026, 5, 1)
const merged = computeAllSubscriptionStats(purchases, history, now)
assert.equal(merged.length, 1)
assert.equal(merged[0].periods.length, 2)
assert.equal(merged[0].totalPaid, 50)
assert.equal(merged[0].totalTokens, 300)
assert.equal(merged[0].totalCost, 3)
assert.equal(merged[0].bindings.length, 1, 'equivalent old/new source bindings share one label')
assert.equal(merged[0].monthsBilled, 2)
const breakdown = computePlanBreakdown(purchases, history, at(2026, 1, 1, 0), now, now)
assert.equal(breakdown.plans.length, 1)
assert.equal(breakdown.plans[0].fees, 50)
assert.equal(breakdown.plans[0].tokens, 300)
assert.equal(breakdown.unplanned.tokens, 1500, 'gap and post-subscription usage stay unplanned')
const timeline = computePlanTimeline(purchases, history, at(2026, 1, 1, 0), now, now)
assert.equal(timeline.plans.length, 1)
assert.equal(timeline.plans[0].cycles.length, 2)
assert.ok(timeline.plans[0].cycles[0].end < timeline.plans[0].cycles[1].start, 'timeline must retain the unsubscribed gap')
assert.equal(timeline.days.find((d) => d.day === at(2026, 3, 20, 0)).perPlan['same-plan'].tokens, 200)
const overlapping = [...purchases, { ...purchases[0], id: 'overlap', startDate: '2026-01-15', endDate: '2026-02-14', monthlyUsd: 15 }]
const overlap = computeAllSubscriptionStats(overlapping, history, now)[0]
assert.equal(overlap.totalTokens, 300, 'merged overlapping purchases cannot duplicate tokens')
assert.equal(overlap.totalPaid, 65, 'each actual purchase still contributes its fee')

const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenstats-purchases-'))
try {
  const file = path.join(folder, 'usage.sqlite')
  const db = await new UsageDb({ dbPath: file }).open()
  const a = db.upsertSubscription({ ...purchases[0], id: undefined, groupId: undefined, name: 'Same name' })
  const b = db.upsertSubscription({ ...purchases[1], id: undefined, groupId: undefined, name: 'Same name' })
  assert.notEqual(a.groupId, b.groupId, 'same names are never automatically merged')
  db.mergeSubscriptions([a.groupId, b.groupId], a.groupId)
  assert.equal(computeAllSubscriptionStats(db.listSubscriptions(), history, now).length, 1)
  const c = db.upsertSubscription({ ...plan, id: undefined, groupId: a.groupId, name: 'Same name', startDate: '2026-05-01' })
  assert.equal(c.groupId, a.groupId)
  assert.equal(computeAllSubscriptionStats(db.listSubscriptions(), history, now)[0].purchaseCount, 3)
  assert.throws(() => db.upsertSubscription({ ...c, startDate: '2026-02-30' }), /dates/)
  assert.throws(() => db.mergeSubscriptions([a.groupId, 'missing'], a.groupId), /exists/)
  assert.equal(db.listSubscriptions().length, 3)
  db.separateSubscription(a.id)
  assert.equal(computeAllSubscriptionStats(db.listSubscriptions(), history, now).length, 2)
  // The original group identity remains usable after its first purchase moves.
  db.upsertSubscription({ ...b, name: 'Renamed', groupId: a.groupId })
  assert.equal(db.getSubscription(c.id).name, 'Renamed')
  db.deleteSubscription(b.id)
  const reopened = await new UsageDb({ dbPath: file }).open()
  assert.equal(reopened.getSubscription(c.id).groupId, a.groupId)
  assert.equal(reopened.getSubscription(a.id).groupId, db.getSubscription(a.id).groupId)

  const { serializeSubscriptionsForCloud } = await import('../src/main/core/cloudSync.js')
  const withAlias = reopened.upsertSubscription({
    name: 'Mimo Plan',
    monthlyUsd: 30,
    startDate: '2026-03-01',
    active: true,
    bindings: [{ cli: 'litellm:p1', keyAlias: 'secret-key-alias', models: ['gpt-4o'] }],
    resetPeriods: ['monthly'],
    resetAnchors: { monthly: '2026-03-01' },
  })
  const cloudPayload = serializeSubscriptionsForCloud(reopened.listSubscriptions())
  const mimoCloud = cloudPayload.find((s) => s.id === withAlias.id)
  assert.equal(mimoCloud.bindings[0].keyAlias, undefined, 'keyAlias must never leave the device')
  reopened.replaceAllSubscriptions(cloudPayload.map((s) => (s.id === withAlias.id ? { ...s, monthlyUsd: 45 } : s)))
  const afterPull = reopened.getSubscription(withAlias.id)
  assert.equal(afterPull.monthlyUsd, 45)
  assert.equal(afterPull.bindings[0].keyAlias, 'secret-key-alias', 'replaceAllSubscriptions preserves local keyAlias')
  reopened.updateCloudSyncState({ subsBaseHash: 'abc12345', subsConflict: { status: 'conflict', cloudHash: 'abc' } })
  assert.equal(reopened.getCloudSync().subsBaseHash, 'abc12345')
  assert.equal(reopened.getCloudSync().subsConflict.status, 'conflict')
  reopened.updateCloudSyncState({ subsConflict: null })
  assert.equal(reopened.getCloudSync().subsConflict, null)
} finally {
  await fsp.rm(folder, { recursive: true, force: true })
}
console.log('OK: manual merging, separate purchases, gaps, overlap, prices, timeline and persistence')

const dashboard = computeCycleDashboard(overlapping, history, now)
assert.equal(dashboard.plans[0].totalTokens, 300)
assert.equal(dashboard.summary.totalPaid, 65)
assert.equal(dashboard.summary.currentCount, 0)
assert.equal(dashboard.summary.peakCount, 1, 'overlapping purchases of one group count as one concurrent subscription')
assert.equal(dashboard.plans[0].cycles.find((c) => c.periodId === 'overlap').tokens, 100)
assert.equal(dashboard.plans[0].models[0].total, 300)
assert.equal(dashboard.summary.bestValueId, 'same-plan')
const boundaryPlan = { ...plan, startDate: '2026-01-15', active: false, endDate: '2026-02-10' }
const boundary = computeCycleDashboard([boundaryPlan], [
  record(at(2026, 1, 15, 0) - 1, 1000, 10), record(at(2026, 1, 15, 0), 10, 1),
  record(at(2026, 2, 11, 0) - 1, 20, 2), record(at(2026, 2, 11, 0), 2000, 20),
], now)
assert.equal(boundary.summary.totalTokens, 30, 'start midnight and entire end day count; outside timestamps do not')
assert.equal(boundary.plans[0].cycles[0].end, at(2026, 2, 11, 0))
const longHistory = computeCycleDashboard([{ ...plan, startDate: '2024-01-31' }], [
  record(at(2024, 2, 29, 0), 17, 3), record(now + 1, 9999, 100),
], now)
assert.equal(longHistory.plans[0].cycles.length, 28, 'complete history must exceed the old 24-cycle cap')
assert.equal(longHistory.summary.totalTokens, 17, 'future usage is excluded even inside an open cycle')
assert.equal(longHistory.plans[0].cycles.find((c) => c.start === at(2024, 2, 29, 0)).tokens, 17)
const concurrent = computeCycleDashboard([
  ...purchases,
  { ...plan, id: 'second', groupId: 'second', startDate: '2026-01-10', active: false, endDate: '2026-03-10', bindings: [{ cli: 'codex' }] },
  { ...plan, id: 'future', startDate: '2027-01-01' },
  { ...plan, id: 'free', monthlyUsd: 0, startDate: '2026-04-01', bindings: [{ cli: 'gemini' }] },
], history, now)
assert.equal(concurrent.summary.currentCount, 1, 'scheduled future purchases do not count as current')
assert.equal(concurrent.summary.peakCount, 2)
assert.equal(concurrent.summary.peakAt, at(2026, 1, 10, 0))
assert.ok(!concurrent.ranking.includes('free'), 'free plans have an undefined ratio, not infinite value')
assert.equal(concurrent.summary.totalTokens, concurrent.models.reduce((n, m) => n + m.total, 0))
assert.equal(concurrent.summary.totalTokens, concurrent.plans.reduce((n, p) => n + p.cycles.reduce((sum, c) => sum + c.tokens, 0), 0))
assert.equal(computeCycleDashboard([], [], now).summary.peakCount, 0)
console.log('OK: full cycle dashboard, exact boundaries, model totals, historical concurrency, future exclusion and zero-fee ranking')
