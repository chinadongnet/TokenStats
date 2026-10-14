import fsp from 'node:fs/promises'

// sql.js cannot open a WAL beside a database. Overlay only checksum-valid,
// committed frames onto a private copy; never checkpoint or write to CLI data.
// Format: https://www.sqlite.org/fileformat2.html#walformat
export function applyWal(database, wal) {
  if (!wal || wal.length < 32) return database
  const magic = wal.readUInt32BE(0)
  if (![0x377f0682, 0x377f0683].includes(magic)) throw new Error('Invalid SQLite WAL header')
  const pageSize = wal.readUInt32BE(8)
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) throw new Error('Invalid WAL page size')
  const dbPageSize = database.readUInt16BE(16) === 1 ? 65536 : database.readUInt16BE(16)
  if (dbPageSize !== pageSize) throw new Error('WAL/database page size mismatch')
  const read = magic === 0x377f0682 ? 'readUInt32LE' : 'readUInt32BE'
  let s0 = 0, s1 = 0
  const checksum = (bytes) => {
    for (let i = 0; i < bytes.length; i += 8) {
      s0 = (s0 + bytes[read](i) + s1) >>> 0
      s1 = (s1 + bytes[read](i + 4) + s0) >>> 0
    }
  }
  checksum(wal.subarray(0, 24))
  if (s0 !== wal.readUInt32BE(24) || s1 !== wal.readUInt32BE(28)) throw new Error('Invalid WAL header checksum')
  const frames = []
  let committed = 0, pages = 0
  for (let offset = 32; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize) {
    if (!wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) break
    const page = wal.readUInt32BE(offset)
    if (!page) break
    checksum(wal.subarray(offset, offset + 8))
    checksum(wal.subarray(offset + 24, offset + 24 + pageSize))
    if (s0 !== wal.readUInt32BE(offset + 16) || s1 !== wal.readUInt32BE(offset + 20)) break
    frames.push({ page, offset })
    const size = wal.readUInt32BE(offset + 4)
    if (size) { committed = frames.length; pages = size }
  }
  if (!committed) return database
  const snapshot = Buffer.alloc(pages * pageSize)
  database.copy(snapshot)
  for (const { page, offset } of frames.slice(0, committed)) {
    if (page <= pages) wal.copy(snapshot, (page - 1) * pageSize, offset + 24, offset + 24 + pageSize)
  }
  // The materialized copy has no sidecar and must open in rollback mode.
  snapshot[18] = snapshot[19] = 1
  return snapshot
}

async function stamp(file) {
  try {
    const s = await fsp.stat(file)
    return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return null
  }
}

export async function sqliteSignature(file) {
  const headers = []
  for (const [target, length] of [[file, 100], [file + '-wal', 32]]) {
    let handle
    try {
      handle = await fsp.open(target, 'r')
      const bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, 0)
      headers.push(bytes.subarray(0, bytesRead).toString('hex'))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      headers.push('missing')
    } finally {
      await handle?.close()
    }
  }
  // SQLite's change counter and WAL salts move even when a Windows writer
  // keeps the file open and its last-write timestamp remains frozen.
  return headers.join(':')
}

export async function readSqliteSnapshot(file) {
  const paths = [file, file + '-wal', file + '-journal']
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await Promise.all(paths.map(stamp))
    // Rollback-mode writes can expose uncommitted pages in the main file.
    if (before[2] && Number(before[2].split(':')[0]) > 0) {
      const journal = await fsp.readFile(file + '-journal')
      if (journal.subarray(0, 8).some((b) => b !== 0)) throw new Error('SQLite transaction in progress')
    }
    const database = await fsp.readFile(file)
    let wal = null
    try { wal = await fsp.readFile(file + '-wal') } catch (err) { if (err.code !== 'ENOENT') throw err }
    const after = await Promise.all(paths.map(stamp))
    if (before.every((s, i) => s === after[i])) return applyWal(database, wal)
  }
  throw new Error('SQLite source changed during snapshot; retry on next sweep')
}
