import assert from 'node:assert/strict'
import { computeSubscriptionStats } from '../src/main/core/subscriptions.js'

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
  record(at(2026, 7, 20), 100, 5),
  record(at(2026, 8, 16), 200, 7),
]

const active = computeSubscriptionStats(plan, records, at(2026, 8, 20))
assert.equal(active.currentCycle.start, at(2026, 8, 15, 0))
assert.equal(active.currentCycle.end, at(2026, 9, 15, 0))
assert.equal(active.currentCycle.fee, 20)
assert.equal(active.currentCycle.cost, 7)
assert.equal(active.currentCycle.tokens, 200)
assert.equal(active.totalCost, 12)

const ended = computeSubscriptionStats({ ...plan, active: false, endDate: '2026-08-20' }, records, at(2026, 8, 20))
assert.equal(ended.currentCycle, null)

console.log('OK: active subscription exposes its current billing-cycle comparison')
