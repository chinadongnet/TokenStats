import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { Store } from '../src/main/core/store.js'
import { UsageDb } from '../src/main/core/db.js'

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
const now = at(2026, 8, 1, 7)
const records = [
  record(at(2026, 8, 1, 2), 10, 'today'),
  record(at(2026, 7, 31, 20), 20, 'yesterday-evening'),
  record(at(2026, 7, 3, 12), 30, 'month-boundary'),
  record(at(2026, 7, 2, 12), 40, 'too-old'),
]
const store = new Store()
store.files.set('scope-fixture', {
  parser: { cli: 'claude' },
  records,
})

const snap = store.snapshot(now)
assert.equal(snap.todayPerCli.claude.total, 10)
assert.equal(snap.monthPerCli.claude.total, 60)
assert.equal(snap.totals.month.total, 60)
assert.equal(snap.monthPerModel.length, 3)
assert.equal(snap.ranges.monthStart, at(2026, 7, 3, 0))
assert.notEqual(snap.ranges.monthStart, snap.ranges.dayStart)

// Verify cloudOverview uses the exact same local calendar boundaries (dayStart,
// weekStart, monthStart) rather than rolling 24h/7d/30d windows that would leak
// yesterday evening's usage into Today.
const dbPath = path.join(os.tmpdir(), 'aimon-test-scopes.sqlite')
fs.rmSync(dbPath, { force: true })
try {
  const db = await new UsageDb({ dbPath }).open()
  db.ingest(records)
  db.saveCloudAccountSync({
    currentKeyId: 'dev-1',
    devices: [{ id: 'dev-1', name: 'PC-1', lastSyncAt: now, revoked: false, isCurrent: true }],
    snapshots: [],
    hours: records.map((r) => ({
      keyId: 'dev-1',
      hour: r.ts,
      cli: r.cli,
      model: r.model,
      input: r.input,
      output: r.output,
      total: r.total,
      cost: 0,
      turns: r.turns,
    })),
  })
  const ov = db.cloudOverview('account', now)
  assert.deepEqual(ov.ranges, snap.ranges)
  assert.equal(ov.totals.today.total, 10)
  assert.equal(ov.todayPerCli.claude.total, 10)
  assert.equal(ov.todayPerModel.length, 1)
  assert.equal(ov.todayPerModel[0].model, 'today')
  assert.equal(ov.totals.month.total, 60)
} finally {
  fs.rmSync(dbPath, { force: true })
}

console.log('OK: day/week/month scopes cover local calendar boundaries in both store and cloudOverview')
