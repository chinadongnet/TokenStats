import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { readAccessToken } from '../src/main/core/parsers/cursor.js'

const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: 'user|cursor-test', exp: 4102444800 })}.signature`
const key = Buffer.from('cursorAuth/accessToken')
const chunkSize = 256 * 1024
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokenstats-cursor-'))

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

  console.log('cursor token reader: ok')
} finally {
  await fsp.rm(dir, { recursive: true, force: true })
}
