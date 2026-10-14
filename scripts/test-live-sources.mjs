import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenstats-live-'))
for (const cli of ['CLAUDE', 'CODEX', 'GEMINI', 'AGY', 'CURSOR']) process.env[`AIMON_${cli}_ROOT`] = path.join(root, cli)
process.env.AIMON_CONFIG = path.join(root, 'config.json')
await fsp.writeFile(process.env.AIMON_CONFIG, '{}')
const { Store, SWEEP_MS } = await import('../src/main/core/store.js')
const { applyWal } = await import('../src/main/core/sqliteSnapshot.js')
const { antigravity } = await import('../src/main/core/parsers/antigravity.js')
const { parseUsageCsv, cursor, configureCursorArchive } = await import('../src/main/core/parsers/cursor.js')
const { UsageDb } = await import('../src/main/core/db.js')
const { costFor } = await import('../src/main/core/pricing.js')
const { parseAgyQuota, supportsAgyQuotaJson } = await import('../src/main/core/agyLimits.js')
const store = new Store()
let sqlite
const originalFetch = globalThis.fetch
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const varint = (n) => {
  const out = []
  do { const b = n & 127; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)) } while (n)
  return Buffer.from(out)
}
const field = (n, value) => typeof value === 'number'
  ? Buffer.concat([varint(n * 8), varint(value)])
  : Buffer.concat([varint(n * 8 + 2), varint(value.length), value])
const usage = (tokens, legacyTimestamp = true) => field(1, Buffer.concat([
  field(4, Buffer.concat([field(2, tokens), field(3, 10), field(5, 20), field(9, 8), field(11, Buffer.from(`response-${tokens}`))])),
  ...(legacyTimestamp ? [field(9, field(4, field(1, 1791939600)))] : []), field(21, Buffer.from('Gemini live test')),
]))

try {
  await fsp.mkdir(process.env.AIMON_CODEX_ROOT)
  await fsp.mkdir(process.env.AIMON_AGY_ROOT)
  const file = path.join(process.env.AIMON_CODEX_ROOT, 'rollout-test.jsonl')
  const event = (total) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } },
  } }) + '\n'
  const context = Buffer.from(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-live', cwd: 'D:/中文' } }) + '\n')
  const split = context.indexOf(Buffer.from('中')) + 1
  await fsp.writeFile(file, context.subarray(0, split))
  await store.ingestFile(file)
  assert.equal(store.files.get(file).records.length, 0)
  await fsp.appendFile(file, context.subarray(split))
  await store.ingestFile(file)
  assert.equal(store.files.get(file).state.cwd, 'D:/中文')
  const row = event(100)
  await fsp.appendFile(file, row.slice(0, -12))
  await store.ingestFile(file)
  assert.equal(store.files.get(file).records.length, 0)
  await fsp.appendFile(file, row.slice(-12))
  await Promise.all(Array.from({ length: 20 }, () => store.ingestFile(file)))
  assert.equal(store.files.get(file).records.length, 1)
  assert.equal(store.files.get(file).records[0].total, 100)
  await fsp.writeFile(file, event(50))
  await store.ingestFile(file)
  assert.equal(store.files.get(file).records[0].total, 50)

  const agyFile = path.join(process.env.AIMON_AGY_ROOT, 'live.db')
  sqlite = new DatabaseSync(agyFile)
  sqlite.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
  sqlite.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, usage(100))
  const before = await fsp.stat(agyFile)
  assert.equal((await antigravity.parseFile(agyFile))[0].total, 130)
  await store.ingestFile(agyFile)
  const dbBytes = await fsp.readFile(agyFile)
  const walBytes = await fsp.readFile(agyFile + '-wal')
  const corrupt = Buffer.from(walBytes)
  corrupt[corrupt.length - 1] ^= 1
  assert.deepEqual(applyWal(dbBytes, corrupt), dbBytes, 'corrupt transaction must not be applied')
  assert.deepEqual(applyWal(dbBytes, walBytes.subarray(0, walBytes.length - 7)), dbBytes, 'partial frame must not be applied')
  sqlite.prepare('INSERT INTO steps VALUES (?, 15, ?)').run(0, field(8, field(1, 1791939600)))
  sqlite.prepare('INSERT INTO steps VALUES (?, 15, ?)').run(1, Buffer.concat([field(8, field(1, 1791853200)), field(9, field(11, Buffer.from('response-200')))]))
  sqlite.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, usage(200, false))
  assert.equal((await fsp.stat(agyFile)).mtimeMs, before.mtimeMs)
  assert.equal(await store.ingestFile(agyFile), true, 'WAL-only commit must refresh AGY')
  assert.equal(store.files.get(agyFile).records.length, 2)
  assert.equal(store.files.get(agyFile).records[1].ts, 1791853200000, 'new AGY timestamps come from model steps, not refresh time')
  const r = store.files.get(agyFile).records[0]
  assert.equal(r.reasoning, 8)
  assert.equal(costFor(r), (100 * 0.3 + 10 * 2.5 + 20 * 0.03) / 1e6, 'thinking is already included in output and must not be billed twice')
  store.seedHistory('agy', [
    { hour: 1700000000000, cli: 'agy', model: 'archived', total: 500, input: 500, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 },
    { hour: 1791856800000, cli: 'agy', model: 'overlap', total: 999 },
  ])
  assert.equal(store.dedupedRecords().filter((r) => r.model === 'archived').length, 1)
  assert.equal(store.dedupedRecords().filter((r) => r.model === 'overlap').length, 0)

  // A real timer, with filesystem notifications disabled, tests the fallback
  // that Windows open-file writers need rather than directly invoking scan.
  await store.start()
  for (const watcher of store.watchers) await watcher.close()
  store.watchers = []
  const oldStat = await fsp.stat(file)
  const started = Date.now()
  await fsp.appendFile(file, event(250))
  await fsp.utimes(file, oldStat.atime, oldStat.mtime)
  sqlite.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(2, usage(300))
  while (Date.now() - started < 12000) {
    if (store.files.get(file).records.length === 2 && store.files.get(agyFile).records.length === 3) break
    await wait(100)
  }
  assert.equal(store.files.get(file).records.reduce((n, r) => n + r.total, 0), 250)
  assert.equal(store.files.get(agyFile).records.length, 3)
  assert.ok(Date.now() - started < 12000)
  assert.ok(SWEEP_MS < 30000)
  const { readSqliteSnapshot } = await import('../src/main/core/sqliteSnapshot.js')
  const duplicate = path.join(process.env.AIMON_AGY_ROOT, 'copied-session.db')
  await fsp.writeFile(duplicate, await readSqliteSnapshot(agyFile))
  await store.ingestFile(duplicate)
  assert.equal(store.dedupedRecords().filter((r) => r.cli === 'agy' && r.sessionId !== 'archived').length, 3, 'copied/resumed generations must be deduplicated by response ID')
  console.log(`Codex + AGY live fallback: ${Date.now() - started}ms (notifications disabled)`)
  await store.stop()

  const observedAt = Date.now()
  assert.equal(supportsAgyQuotaJson('1.3.5'), true)
  assert.equal(supportsAgyQuotaJson('1.1.4'), false, 'old versions must not interpret /usage as an AI prompt')
  const reset = new Date(observedAt + 3600000).toISOString()
  const quota = parseAgyQuota({ command: { data: { groups: [{ buckets: [
    { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.5, reset_time: reset },
    { id: 'gemini-5h', window: '5h', remaining_fraction: 0.93, reset_time: reset },
    { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.1, reset_time: reset },
  ] }] } } }, observedAt)
  assert.deepEqual(quota.map((w) => [w.label, Math.round(w.usedPercent)]), [['5h', 7], ['weekly', 50]])
  assert.deepEqual(parseAgyQuota({ quota: { 'gemini-weekly': { remaining_fraction: 0.1, reset_time: '2026-09-14T00:00:00Z' } } }, observedAt), [], 'expired quota must never appear live')

  const csv = '\uFEFFDate,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens\r\n'
    + '2026-10-14T01:00:00Z,API Key,claude-opus-5-5-medium,5,10,20,30,\r\n'
    + '2026-10-14T01:00:00Z,Included,claude-opus-5-5-medium,5,10,20,30,65\r\n'
  const parsed = parseUsageCsv(csv)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].model, 'claude-opus-5-5-medium')
  assert.equal(parsed[0].total, 65)
  assert.notEqual(parsed[0].dedupKey, parsed[1].dedupKey)
  assert.throws(() => parseUsageCsv('wrong,columns\nx,y'), /columns/)

  const tempDb = await new UsageDb({ dbPath: path.join(root, 'usage.sqlite') }).open()
  assert.equal(tempDb.markMigration('agy-output-cost-and-response-id-v1'), true)
  assert.equal(tempDb.markMigration('agy-output-cost-and-response-id-v1'), false)
  const historical = { ...parsed[0], ts: Date.now() - 10 * 86400000, turns: 8 }
  tempDb.ingest([historical])
  const seed = tempDb.listCursorUsage('test-user')
  assert.equal(seed[0].total, 65)
  assert.equal(seed[0].turns, 8)
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = `${enc({ alg: 'none' })}.${enc({ sub: 'test-user', exp: 4102444800 })}.sig`
  const cursorFile = path.join(root, 'state.vscdb')
  await fsp.writeFile(cursorFile, 'cursorAuth/accessToken\0' + token)
  let calls = 0
  globalThis.fetch = async (url) => {
    calls++
    if (url.includes('usage-summary')) return new Response('{}')
    assert.ok(Number(new URL(url).searchParams.get('startDate')) > 0, 'archive enables incremental export')
    return new Response(csv)
  }
  configureCursorArchive({ load: (user) => tempDb.listCursorUsage(user), save: (user, rows) => tempDb.saveCursorUsage(user, rows) })
  const [a, b] = await Promise.all([cursor.parseFile(cursorFile), cursor.parseFile(cursorFile)])
  assert.equal(calls, 2, 'overlapping calls share usage + summary requests')
  assert.equal(a, b)
  assert.equal(a.length, 3)
  assert.equal(tempDb.listCursorUsage('test-user').length, 3)
  assert.equal(tempDb.listCursorUsage('another-user').length, 0)
  tempDb.ingest(a)
  assert.equal(tempDb.hourlySince(0).reduce((n, r) => n + r.total, 0), 195)
  configureCursorArchive({ load: (user) => tempDb.listCursorUsage(user) })
  globalThis.fetch = async () => new Response('', { status: 429 })
  assert.equal((await cursor.parseFile(cursorFile)).length, 3, 'rate limits must retain archived history')
  console.log('JSONL boundaries, concurrent ingestion, WAL validation, Opus/API CSV, archive and backoff: ok')
} finally {
  globalThis.fetch = originalFetch
  await store.stop()
  sqlite?.close()
  await fsp.rm(root, { recursive: true, force: true })
}
