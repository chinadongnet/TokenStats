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

fs.rmSync(dbPath, { force: true })
console.log('\nOK (temp db removed)')
