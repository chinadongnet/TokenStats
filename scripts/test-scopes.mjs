import assert from 'node:assert/strict'
import { Store } from '../src/main/core/store.js'

const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime()
const record = (ts, total, model) => ({
  cli: 'claude',
  ts,
  model,
  sessionId: model,
  project: 'scope-test',
  input: total,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  reasoning: 0,
  total,
  turns: 1,
})

// August 1 is the important boundary: a calendar-month bucket used to start at
// the same instant as the day bucket, making the Month tab duplicate Day.
const now = at(2026, 8, 1, 18)
const store = new Store()
store.files.set('scope-fixture', {
  parser: { cli: 'claude' },
  records: [
    record(at(2026, 8, 1), 10, 'today'),
    record(at(2026, 7, 31), 20, 'yesterday'),
    record(at(2026, 7, 3), 30, 'month-boundary'),
    record(at(2026, 7, 2), 40, 'too-old'),
  ],
})

const snap = store.snapshot(now)
assert.equal(snap.todayPerCli.claude.total, 10)
assert.equal(snap.monthPerCli.claude.total, 60)
assert.equal(snap.totals.month.total, 60)
assert.equal(snap.monthPerModel.length, 3)
assert.equal(snap.ranges.monthStart, at(2026, 7, 3, 0))
assert.notEqual(snap.ranges.monthStart, snap.ranges.dayStart)

console.log('OK: monthly scope covers the latest 30 local calendar days')

// Cursor bootstrap records arrive before AGY records at startup. A model ID
// shared by both sources must remain visible in BOTH cards, not be attributed
// entirely to whichever source was indexed first. Providers can share IDs too.
const sharedModel = 'claude-opus-5-5-medium'
for (const order of [
  ['cursor', 'agy', 'claude', 'litellm:first', 'litellm:second'],
  ['litellm:second', 'litellm:first', 'claude', 'agy', 'cursor'],
]) {
  const shared = new Store()
  shared.setPollers(['litellm:first', 'litellm:second'].map((cli) => ({ cli, meta: { label: cli, color: '#777777' } })))
  for (const cli of order) {
    const factor = ['cursor', 'agy', 'claude', 'litellm:first', 'litellm:second'].indexOf(cli) + 1
    shared.files.set(cli, { parser: { cli }, records: [
      { ...record(at(2026, 8, 1), 10 * factor, sharedModel), cli },
      { ...record(at(2026, 7, 31), 20 * factor, sharedModel), cli },
      { ...record(at(2026, 7, 3), 30 * factor, sharedModel), cli },
      { ...record(at(2026, 7, 2), 40 * factor, sharedModel), cli },
    ] })
  }
  const snapshot = shared.snapshot(now)
  for (const [models, totals, multiplier] of [
    [snapshot.perModel, snapshot.perCli, 100],
    [snapshot.todayPerModel, snapshot.todayPerCli, 10],
    [snapshot.weekPerModel, snapshot.weekPerCli, 30],
    [snapshot.monthPerModel, snapshot.monthPerCli, 60],
  ]) {
    assert.equal(models.length, order.length, 'same model ID remains separate per source')
    for (const cli of order) {
      const model = models.find((m) => m.cli === cli && m.model === sharedModel)
      const factor = ['cursor', 'agy', 'claude', 'litellm:first', 'litellm:second'].indexOf(cli) + 1
      assert.ok(model, `${cli} must expose its own Opus usage`)
      assert.equal(model.total, multiplier * factor)
      for (const field of ['total', 'input', 'output', 'cacheRead', 'cacheCreate', 'reasoning', 'count']) assert.equal(model[field], totals[cli][field])
      assert.ok(Math.abs(model.cost - totals[cli].cost) < 1e-9)
    }
  }
}
console.log('OK: shared model IDs keep per-source tokens, cost and requests in every scope regardless of ingest order')
