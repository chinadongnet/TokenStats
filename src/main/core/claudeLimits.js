import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// Claude Code keeps its subscription plan-quota (5-hour + weekly rolling
// windows) server-side; the local jsonl logs only have per-request tokens, not
// the remaining-window state. Unlike Cursor there is no documented endpoint,
// BUT the CLI's own `/usage` view IS reachable non-interactively: piping
// `/usage` into `claude -p` runs the built-in and prints it as text, e.g.
//
//   Current session: 20% used · resets Jul 18, 2:20am (Asia/Singapore)
//   Current week (all models): 11% used · resets Jul 22, 4pm (Asia/Singapore)
//   Current week (Fable): 12% used · resets Jul 22, 4pm (Asia/Singapore)
//
// So this module shells out to `claude -p /usage`, parses that text into the
// same window shape codexResetWindows() returns ({label, windowMinutes,
// usedPercent, remainingPercent, resetsAt}), and hands it to the Quota-windows
// live overlay. "session" is the 5-hour window; "week (all models)" is the
// weekly one; per-model weekly lines (e.g. Fable) are skipped to avoid clutter.
//
// Because each call spawns the CLI and hits the network (unlike Codex, whose
// numbers sit in local logs), it is throttled to once every 15 minutes and the
// accessor returns the cached value while a stale refresh runs in the
// background — so the IPC handler stays synchronous and fast.

const REFRESH_MS = 15 * 60 * 1000
const RUN_TIMEOUT_MS = 30 * 1000

let cache = { windows: [], fetchedAt: 0 }
let inflight = null

function findClaudeBin() {
  const home = os.homedir()
  const win = process.platform === 'win32'
  const candidates = [
    process.env.AIMON_CLAUDE_BIN,
    path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude'),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore and fall through to the PATH lookup
    }
  }
  return win ? 'claude.exe' : 'claude' // last resort: resolve via PATH
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

// "Jul 18, 2:20am (Asia/Singapore)" / "Jul 22, 4pm" -> epoch ms in LOCAL time
// (the string is already rendered in the machine's own timezone). Minutes are
// optional ("4pm"). A parsed date that already sits well in the past is rolled
// to next year (a late-December window read in early January).
function parseReset(s, now = new Date()) {
  const m = s.match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return null
  const mon = MONTHS[m[1]]
  if (mon == null) return null
  const day = Number(m[2])
  const hh = (Number(m[3]) % 12) + (/pm/i.test(m[5]) ? 12 : 0)
  const mm = m[4] ? Number(m[4]) : 0
  const y = now.getFullYear()
  let d = new Date(y, mon, day, hh, mm)
  if (d.getTime() < now.getTime() - 2 * 86400000) d = new Date(y + 1, mon, day, hh, mm)
  return d.getTime()
}

export function parseClaudeUsage(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*Current (session|week[^:]*):\s*(\d+)%\s*used\b.*?resets\s+(.+?)\s*$/i)
    if (!m) continue
    const kind = m[1]
    let label
    if (/^session/i.test(kind)) label = '5h'
    else if (/all models/i.test(kind)) label = 'weekly'
    else continue // per-model weekly line — skip
    const used = Number(m[2])
    out.push({
      label,
      windowMinutes: label === '5h' ? 300 : 10080,
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      resetsAt: parseReset(m[3]),
    })
  }
  return out
}

function runUsage() {
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        findClaudeBin(),
        ['-p', '--output-format', 'text'],
        { timeout: RUN_TIMEOUT_MS, windowsHide: true, cwd: os.tmpdir(), maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err && !stdout ? null : parseClaudeUsage(stdout))
      )
      child.stdin.end('/usage\n')
    } catch {
      resolve(null) // claude not installed / spawn failed
    }
  })
}

function refresh() {
  if (inflight) return inflight
  inflight = (async () => {
    const w = await runUsage()
    // On success replace the cache; on failure just bump the timestamp so a
    // broken/uninstalled CLI isn't re-spawned every snapshot.
    if (w && w.length) cache = { windows: w, fetchedAt: Date.now() }
    else cache = { windows: cache.windows, fetchedAt: Date.now() }
    inflight = null
    return cache.windows
  })()
  return inflight
}

// Prime once at startup so the first popup already has data.
export function primeClaudeLimits() {
  return refresh()
}

// Newest Claude plan-quota windows, or [] if none yet. Returns the cached value
// immediately and kicks a background refresh when it's older than 15 minutes.
export function claudeResetWindows() {
  if (Date.now() - cache.fetchedAt >= REFRESH_MS) refresh()
  return cache.windows
}
