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
