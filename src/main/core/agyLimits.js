import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REFRESH_MS = 60 * 60 * 1000 // between scheduled scrapes (1 hour)
const RETRY_BASE_MS = 5 * 60 * 1000 // backoff base on failure for non-forced checks
const AUTH_BACKOFF_MS = 15 * 60 * 1000 // minimum cooldown when agy enters login flow
const MAX_BACKOFF_MS = 60 * 60 * 1000 // cap backoff at 1 hour
const RUN_TIMEOUT_MS = 30 * 1000 // one scrape; high-latency networks can exceed 15s
const MAX_AGE_MS = 2 * 60 * 60 * 1000 // keep live windows valid across hourly refreshes

// When `agy --print /usage` encounters a proxy/network error while verifying
// stored credentials, agy's internal `waitForAuth` can mistake it for an
// unauthenticated state ("No valid authentication found (...). Starting login...")
// and invoke `rundll32 url.dll,FileProtocolHandler https://accounts.google.com/...`
// to open the system browser.
// Setting ANTIGRAVITY_VSCODE_HOST=1 (and ANTIGRAVITY_REMOTE_OOB_AUTH=1) instructs
// agy's auth package to emit `ANTIGRAVITY_OPEN_URL: <url>` to stdout instead of
// spawning `rundll32` / opening a browser window. We also watch stdout/stderr and
// immediately kill the process tree if login output is detected.
const LOGIN_PROMPT_RE = /ANTIGRAVITY_OPEN_URL:|No valid authentication found|Starting login\.\.\.|Enter the authorization code:/i

let latest = null
let inFlight = null
let nextAt = 0
let fails = 0
let versionChecked = null

function headlessAgyEnv() {
  return {
    ...process.env,
    ANTIGRAVITY_VSCODE_HOST: '1',
    ANTIGRAVITY_REMOTE_OOB_AUTH: '1',
  }
}

function killTree(child) {
  if (!child) return
  try {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // already exited
  }
}

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
  if (!force && Date.now() < nextAt) return Promise.resolve(agyLiveWindows())
  nextAt = Date.now() + REFRESH_MS
  const installed = path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe')
  const command = process.platform === 'win32' && fs.existsSync(installed) ? installed : 'agy'
  const env = headlessAgyEnv()
  // Older releases treated /usage in print mode as an agent prompt. Query
  // only versions verified to support the built-in JSON command.
  if (!versionChecked) versionChecked = new Promise((resolve) => {
    execFile(command, ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8', env }, (error, stdout) => {
      resolve(!error && supportsAgyQuotaJson(stdout))
    })
  })
  inFlight = versionChecked.then((supported) => new Promise((resolve) => {
    if (!supported) { resolve(agyLiveWindows()); return }
    let settled = false
    let abortedForAuth = false
    let streamBuf = ''
    let timer = null
    let child = null
    const recordFailure = (reason, isAuth = false) => {
      fails += 1
      const base = isAuth ? AUTH_BACKOFF_MS : RETRY_BASE_MS
      const delay = Math.min(MAX_BACKOFF_MS, base * Math.pow(2, Math.min(fails - 1, 4)))
      nextAt = Date.now() + delay
      console.warn(`[agyLimits] /usage failed (${reason}, ${fails}x); next retry in ${Math.round(delay / 1000)}s`)
    }
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(agyLiveWindows())
    }
    try {
      child = execFile(command, ['--print', '/usage', '--output-format', 'json'], {
        windowsHide: true,
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        cwd: os.tmpdir(),
        env,
      }, (error, stdout, stderr) => {
        if (abortedForAuth || settled) {
          finish()
          return
        }
        const combined = `${stdout || ''}\n${stderr || ''}`
        if (LOGIN_PROMPT_RE.test(combined)) {
          killTree(child)
          recordFailure('auth-login-suppressed', true)
          finish()
          return
        }
        if (!error) {
          try {
            const jsonLine = String(stdout || '')
              .split(/\r?\n/)
              .map((l) => l.trim())
              .find((l) => l.startsWith('{') && l.endsWith('}')) || String(stdout || '').trim()
            const result = JSON.parse(jsonLine)
            if (result.status !== 'SUCCESS' || !Array.isArray(result.command?.data?.groups)) {
              throw new Error('Invalid quota response')
            }
            fails = 0
            latest = { at: Date.now(), windows: parseAgyQuota(result) }
            nextAt = Date.now() + REFRESH_MS
          } catch {
            recordFailure('invalid-json')
          }
        } else {
          if (error.killed) killTree(child)
          recordFailure(error.killed ? 'timeout' : error.code || 'process-error')
        }
        finish()
      })
      const inspectChunk = (chunk) => {
        if (abortedForAuth || settled) return
        streamBuf = (streamBuf + String(chunk)).slice(-2048)
        if (LOGIN_PROMPT_RE.test(streamBuf)) {
          abortedForAuth = true
          killTree(child)
          recordFailure('auth-login-suppressed', true)
          finish()
        }
      }
      child.stdout?.on('data', inspectChunk)
      child.stderr?.on('data', inspectChunk)
    } catch {
      recordFailure('spawn-error')
      finish()
      return
    }
    timer = setTimeout(() => {
      if (settled) return
      killTree(child)
      recordFailure('timeout')
      finish()
    }, RUN_TIMEOUT_MS + 2000)
  })).finally(() => { inFlight = null })
  return inFlight
}
