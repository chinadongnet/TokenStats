// Compare against CC switch: filter deduped records to a rolling N-day window
// and break tokens down into the same components CC switch reports.
import { Store } from '../src/main/core/store.js'

const DAYS = Number(process.argv[2] || 7)
const store = new Store()
await store.scanAll()

// Calendar-aligned: start at local midnight, (DAYS-1) days ago, so it covers
// the last DAYS calendar days including today (matches how CC switch likely windows).
const d = new Date()
d.setHours(0, 0, 0, 0)
const from = d.getTime() - (DAYS - 1) * 24 * 60 * 60 * 1000
const recs = store.dedupedRecords().filter((r) => r.ts >= from)

const fmt = (n) => Math.round(n).toLocaleString('en-US')

const agg = {}
const sessions = {} // cli -> Set of sessionId (proxy for "requests")
for (const r of recs) {
  const a = (agg[r.cli] ||= {
    input: 0, output: 0, cacheCreate: 0, cacheRead: 0, reasoning: 0, total: 0, recs: 0
  })
  a.input += r.input || 0
  a.output += r.output || 0
  a.cacheCreate += r.cacheCreate || 0
  a.cacheRead += r.cacheRead || 0
  a.reasoning += r.reasoning || 0
  a.total += r.total || 0
  a.recs += 1
  ;(sessions[r.cli] ||= new Set()).add(r.sessionId)
}

console.log(`\n=== Last ${DAYS} days (since ${new Date(from).toLocaleString()}) ===\n`)
for (const [cli, a] of Object.entries(agg)) {
  console.log(cli.toUpperCase())
  console.log(`  total        ${fmt(a.total).padStart(15)}`)
  console.log(`  input        ${fmt(a.input).padStart(15)}`)
  console.log(`  output       ${fmt(a.output).padStart(15)}`)
  console.log(`  cacheCreate  ${fmt(a.cacheCreate).padStart(15)}`)
  console.log(`  cacheRead    ${fmt(a.cacheRead).padStart(15)}`)
  console.log(`  reasoning    ${fmt(a.reasoning).padStart(15)}`)
  console.log(`  records      ${fmt(a.recs).padStart(15)}`)
  console.log(`  sessions     ${fmt(sessions[cli].size).padStart(15)}`)
  console.log('')
}
