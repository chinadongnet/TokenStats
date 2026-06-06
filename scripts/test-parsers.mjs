// Headless verification: parse the real local CLI data and print a snapshot.
// Run with: node scripts/test-parsers.mjs
import { Store } from '../src/main/core/store.js'

const store = new Store()
console.time('scan')
await store.scanAll()
console.timeEnd('scan')

const snap = store.snapshot()
const fmt = (n) => n.toLocaleString('en-US')
const usd = (n) => '$' + n.toFixed(2)

console.log('\n=== Files indexed ===')
const byCli = {}
for (const e of store.files.values()) {
  byCli[e.parser.cli] = (byCli[e.parser.cli] || 0) + 1
}
console.log(byCli)

console.log('\n=== Records ===', store.allRecords().length)

console.log('\n=== Totals (all time) ===')
for (const [cli, c] of Object.entries(snap.perCli)) {
  console.log(`${cli.padEnd(8)} ${fmt(c.total).padStart(14)} tok  ${usd(c.cost).padStart(10)}  (${c.count} turns)`)
}
console.log('ALL'.padEnd(8), fmt(snap.totals.all.total).padStart(14), 'tok ', usd(snap.totals.all.cost).padStart(10))

console.log('\n=== Today ===')
for (const [cli, c] of Object.entries(snap.todayPerCli)) {
  console.log(`${cli.padEnd(8)} ${fmt(c.total).padStart(14)} tok  ${usd(c.cost).padStart(10)}`)
}

console.log('\n=== Top models ===')
for (const m of snap.perModel.slice(0, 8)) {
  console.log(`${(m.model || '?').padEnd(28)} ${m.cli.padEnd(7)} ${fmt(m.total).padStart(14)} tok  ${usd(m.cost)}`)
}

console.log('\n=== Recent sessions ===')
for (const s of snap.recentSessions.slice(0, 6)) {
  const when = new Date(s.lastTs).toLocaleString()
  console.log(`${s.cli.padEnd(7)} ${s.project.padEnd(22)} ${fmt(s.total).padStart(12)} tok  ${when}`)
}

console.log('\n=== Live ===', snap.live)
console.log('Sessions total:', snap.sessionCount)
