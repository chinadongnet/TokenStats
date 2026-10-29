import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { readAccessToken, cursor, configureCursorArchive } from '../src/main/core/parsers/cursor.js'

const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: 'user|cursor-test', exp: 4102444800 })}.signature`
const hs256Sig = 'a'.repeat(43)
const hs256Token = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'user|cursor-hs256', exp: 4102444800, time: '1793000000' })}.${hs256Sig}`
const expiredToken = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'user|cursor-hs256', exp: 1700000000, time: '1699900000' })}.${hs256Sig}`
const key = Buffer.from('cursorAuth/accessToken')
const chunkSize = 256 * 1024
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenstats-cursor-'))
const originalFetch = globalThis.fetch

try {
  // Put the key across the parser's read boundary and its token in the next
  // chunk. This guards the overlap logic without creating a giant fixture.
  const prefix = Buffer.alloc(chunkSize - Math.floor(key.length / 2), 0)
  const file = path.join(dir, 'state.vscdb')
  await fsp.writeFile(file, Buffer.concat([prefix, key, Buffer.from(`\0\0${token}\0`)]))
  assert.equal(await readAccessToken(file), token)

  const missing = path.join(dir, 'missing-token.vscdb')
  await fsp.writeFile(missing, Buffer.from('SQLite format 3\0cursorAuth/accessToken\0not-a-jwt'))
  assert.equal(await readAccessToken(missing), null)

  // SQLite B-tree index entry (\x03\x39\x01cursorAuth/accessToken) followed by
  // a real ItemTable leaf cell whose HS256 JWT is immediately followed by the
  // next cell's varint header bytes (0x33 0x74 = "3t") with no delimiter.
  const sqliteFile = path.join(dir, 'sqlite-cell.vscdb')
  const indexEntry = Buffer.concat([Buffer.from([0x03, 0x39, 0x01]), key, Buffer.from([0x06])])
  const serial = hs256Token.length * 2 + 13
  const serialVarint = Buffer.from([0x80 | ((serial >> 7) & 0x7f), serial & 0x7f])
  const tableEntry = Buffer.concat([
    Buffer.from([0x04, 0x39]),
    serialVarint,
    key,
    Buffer.from(hs256Token, 'latin1'),
    Buffer.from('3t\x04!cursorAuth/refreshToken', 'latin1'),
  ])
  await fsp.writeFile(sqliteFile, Buffer.concat([indexEntry, Buffer.alloc(64, 0), tableEntry]))
  assert.equal(await readAccessToken(sqliteFile), hs256Token)

  // WAL file containing a fresh token must override an expired token in state.vscdb.
  const walDbFile = path.join(dir, 'wal-test.vscdb')
  await fsp.writeFile(walDbFile, Buffer.concat([key, Buffer.from(`\0${expiredToken}\0`)]))
  await fsp.writeFile(walDbFile + '-wal', Buffer.concat([key, Buffer.from(`\0${hs256Token}3t`)]))
  assert.equal(await readAccessToken(walDbFile), hs256Token)

  // Multi-day gap recovery: when the local archive's newest cloud record is 4 days
  // old, startDate must rewind to 2 hours before that record (not just 48h ago)
  // so the 2-to-4-day gap is never dropped.
  const now = Date.now()
  const sixDaysAgo = now - 6 * 86400000
  const fourDaysAgo = now - 4 * 86400000
  const threeDaysAgo = now - 3 * 86400000
  const oneDayAgo = now - 1 * 86400000
  const expectedFromMs = Math.floor((fourDaysAgo - 2 * 3600000) / 3600000) * 3600000
  const archived = [
    {
      cli: 'cursor',
      ts: sixDaysAgo,
      model: 'claude-4.6-opus-max-thinking',
      sessionId: 'cloud',
      project: 'cursor',
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheCreate: 0,
      reasoning: 0,
      total: 150,
      dedupKey: `cursor-cloud:${sixDaysAgo}:claude-4.6-opus-max-thinking:100:50:0:0:150:0`,
    },
    {
      cli: 'cursor',
      ts: fourDaysAgo,
      model: 'claude-4.6-opus-max-thinking',
      sessionId: 'cloud',
      project: 'cursor',
      input: 200,
      output: 100,
      cacheRead: 0,
      cacheCreate: 0,
      reasoning: 0,
      total: 300,
      dedupKey: `cursor-cloud:${fourDaysAgo}:claude-4.6-opus-max-thinking:200:100:0:0:300:0`,
    },
  ]
  const csv = [
    'Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens',
    `"${new Date(oneDayAgo).toISOString()}","Included","claude-4.6-opus-max-thinking","0","400","0","200","600"`,
    `"${new Date(threeDaysAgo).toISOString()}","Included","claude-4.6-opus-max-thinking","0","300","0","150","450"`,
    `"${new Date(fourDaysAgo).toISOString()}","Included","claude-4.6-opus-max-thinking","0","200","0","100","300"`,
  ].join('\n')

  let requestedStartDate = null
  let savedRecords = null
  configureCursorArchive({
    load: () => archived,
    save: (_user, rows) => { savedRecords = rows },
  })
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/api/usage-summary')) return new Response('{}', { status: 200 })
    requestedStartDate = Number(new URL(u).searchParams.get('startDate'))
    return new Response(csv, { status: 200 })
  }
  const records = await cursor.parseFile(sqliteFile)
  assert.equal(requestedStartDate, expectedFromMs, 'startDate must rewind to cover the 4-day archive gap')
  assert.equal(records.length, 4, 'archived 6d record + 4d/3d/1d records must all be retained')
  assert.equal(savedRecords?.length, 4)

  // Cold-start fallback backfill: if the initial full-history (startDate=0) export
  // fails and falls back to 30-day chunks, subsequent refreshes (including after
  // restarting from the saved archive) must continue backfilling older history.
  const fortyFiveDaysAgo = now - 45 * 86400000
  const fullCsv = [
    'Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens',
    `"${new Date(oneDayAgo).toISOString()}","Included","claude-4.6-opus-max-thinking","0","400","0","200","600"`,
    `"${new Date(fortyFiveDaysAgo).toISOString()}","Included","claude-4.6-opus-max-thinking","0","500","0","250","750"`,
  ].join('\n')
  let coldSaved = []
  let failZeroStartOnce = true
  configureCursorArchive({
    load: () => coldSaved,
    save: (_user, rows) => { coldSaved = JSON.parse(JSON.stringify(rows)) },
  })
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/api/usage-summary')) return new Response('{}', { status: 200 })
    const start = Number(new URL(u).searchParams.get('startDate'))
    const end = Number(new URL(u).searchParams.get('endDate'))
    if (start === 0 && failZeroStartOnce) {
      return new Response('gateway timeout', { status: 504 })
    }
    const lines = [
      'Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens',
    ]
    if (oneDayAgo >= start && oneDayAgo <= end) {
      lines.push(`"${new Date(oneDayAgo).toISOString()}","Included","claude-4.6-opus-max-thinking","0","400","0","200","600"`)
    }
    if (fortyFiveDaysAgo >= start && fortyFiveDaysAgo <= end) {
      lines.push(`"${new Date(fortyFiveDaysAgo).toISOString()}","Included","claude-4.6-opus-max-thinking","0","500","0","250","750"`)
    }
    return new Response(lines.join('\n'), { status: 200 })
  }
  const partialRecs = await cursor.parseFile(sqliteFile)
  assert.equal(partialRecs.length, 1, 'initial 30-day fallback returns the 1d record')
  // Simulate app restart with the persisted partial archive; next refresh must backfill the 45d record
  failZeroStartOnce = false
  configureCursorArchive({
    load: () => coldSaved,
    save: (_user, rows) => { coldSaved = JSON.parse(JSON.stringify(rows)) },
  })
  const backfilledRecs = await cursor.parseFile(sqliteFile)
  assert.equal(backfilledRecs.length, 2, 'subsequent refresh after cold-start fallback must backfill 45d history')

  console.log('cursor token reader & gap recovery: ok')
} finally {
  globalThis.fetch = originalFetch
  await fsp.rm(dir, { recursive: true, force: true })
}
