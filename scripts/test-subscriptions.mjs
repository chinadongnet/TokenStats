import assert from 'node:assert/strict'
import { computeSubscriptionStats, computeAllSubscriptionStats, computePlanBreakdown, computePlanTimeline } from '../src/main/core/subscriptions.js'
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
  { ...plan, id: 'march', groupId: 'same-plan', active: false, startDate: '2026-03-01', endDate: '2026-03-31', monthlyUsd: 30 },
]
const history = [record(at(2026, 1, 20), 100, 1), record(at(2026, 2, 20), 500, 5), record(at(2026, 3, 20), 200, 2), record(at(2026, 4, 20), 1000, 10)]
const now = at(2026, 5, 1)
const merged = computeAllSubscriptionStats(purchases, history, now)
assert.equal(merged.length, 1)
assert.equal(merged[0].periods.length, 2)
assert.equal(merged[0].totalPaid, 50)
assert.equal(merged[0].totalTokens, 300)
assert.equal(merged[0].totalCost, 3)
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
} finally {
  await fsp.rm(folder, { recursive: true, force: true })
}
console.log('OK: manual merging, separate purchases, gaps, overlap, prices, timeline and persistence')
