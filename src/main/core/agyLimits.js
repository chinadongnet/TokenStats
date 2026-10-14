import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REFRESH_MS = 20000
const MAX_AGE_MS = 60000
let latest = null
let inFlight = null
let attemptedAt = 0
let versionChecked = null

export function supportsAgyQuotaJson(version) {
  const parts = String(version).match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  if (!parts) return false
  const [major, minor, patch] = parts.slice(1).map(Number)
  return major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 5)))
}

// `agy --print /usage --output-format json` runs a built-in command, not a
// model generation. It exposes real Gemini 5h and weekly buckets even when
// no interactive statusLine hook has run (headless sessions don't render it).
export function parseAgyQuota(json, observedAt = Date.now()) {
  const groups = json?.command?.data?.groups
  const buckets = Array.isArray(groups)
    ? groups.flatMap((g) => g.buckets || [])
    : Object.entries(json?.quota || {}).map(([id, bucket]) => ({ ...bucket, id }))
  const windows = new Map()
  for (const bucket of buckets) {
    if (!/^gemini-/i.test(bucket.id || '') || !Number.isFinite(bucket.remaining_fraction)) continue
    const label = bucket.window || (/5h/.test(bucket.id) ? '5h' : /weekly/.test(bucket.id) ? 'weekly' : null)
    if (!['5h', 'weekly'].includes(label)) continue
    const remainingPercent = Math.max(0, Math.min(100, bucket.remaining_fraction * 100))
    const resetsAt = bucket.reset_time ? Date.parse(bucket.reset_time)
      : Number.isFinite(bucket.reset_in_seconds) ? observedAt + bucket.reset_in_seconds * 1000 : null
    if (!Number.isFinite(resetsAt) || resetsAt <= observedAt) continue
    const previous = windows.get(label)
    if (!previous || remainingPercent < previous.remainingPercent) windows.set(label, {
      label, windowMinutes: label === '5h' ? 300 : 10080,
      usedPercent: 100 - remainingPercent, remainingPercent, resetsAt,
    })
  }
  return [...windows.values()].sort((a, b) => a.windowMinutes - b.windowMinutes)
}

export function agyQuotaAgeMs() {
  return latest ? Date.now() - latest.at : null
}

export function agyLiveWindows() {
  if (!latest || Date.now() - latest.at > MAX_AGE_MS) return []
  return latest.windows.filter((w) => w.resetsAt > Date.now())
}

export function primeAgyLimits({ force = false } = {}) {
  if (inFlight) return inFlight
  if (!force && Date.now() - attemptedAt < REFRESH_MS) return Promise.resolve(agyLiveWindows())
  attemptedAt = Date.now()
  const installed = path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe')
  const command = process.platform === 'win32' && fs.existsSync(installed) ? installed : 'agy'
  // Older releases treated /usage in print mode as an agent prompt. Query
  // only versions verified to support the built-in JSON command.
  if (!versionChecked) versionChecked = new Promise((resolve) => {
    execFile(command, ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
      resolve(!error && supportsAgyQuotaJson(stdout))
    })
  })
  inFlight = versionChecked.then((supported) => new Promise((resolve) => {
    if (!supported) { resolve(agyLiveWindows()); return }
    execFile(command, ['--print', '/usage', '--output-format', 'json'], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => {
      if (!error) {
        try {
          const result = JSON.parse(stdout.trim())
          if (result.status !== 'SUCCESS' || !Array.isArray(result.command?.data?.groups)) throw new Error('Invalid quota response')
          latest = { at: Date.now(), windows: parseAgyQuota(result) }
        } catch {
          console.warn('[agyLimits] invalid /usage JSON; keeping recent quota only')
        }
      } else {
        console.warn('[agyLimits] /usage failed:', error.killed ? 'timeout' : error.code || 'process error')
      }
      resolve(agyLiveWindows())
    })
  })).finally(() => { inFlight = null })
  return inFlight
}
