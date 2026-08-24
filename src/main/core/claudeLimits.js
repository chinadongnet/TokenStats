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
// numbers sit in local logs), it is throttled and the accessor returns the
// cached value while a stale refresh runs in the background — so the IPC
// handler stays synchronous and fast.
//
// **The scrape is slow and fails intermittently** (measured 2026-08): `/usage`
// now also renders a "What's contributing to your limits usage" analysis over
// the local session history, and a plain `-p` run boots every configured MCP
// server first — together 6-23s on a busy machine, against what used to be a
// 30s timeout. Two things follow, and both are load-bearing:
//   - `--strict-mcp-config` (with no --mcp-config alongside it) loads NO MCP
//     servers, which is the single biggest win: ~3-4s instead of ~8-23s. The
//     quota lines are account state, so none of them needs a server.
//   - `-p` buffers its whole output and flushes at the end, so a run killed on
//     timeout yields **empty stdout** — a failure is indistinguishable from
//     "no data". Failures must therefore never be allowed to look like success:
//     they retry sooner (with backoff), and claudeResetWindows() ages the cache
//     out instead of serving it forever. A frozen cache is worse than none —
//     mergeLiveLimits() drops a window whose reset time has passed (`open`),
//     so a stale 5h window silently vanishes from the popup while the weekly
//     one keeps showing a stuck percentage, with nothing anywhere saying why.

const REFRESH_MS = 15 * 60 * 1000 // between successful scrapes
const RETRY_MS = 2 * 60 * 1000 // after a failure, × consecutive failures, capped at REFRESH_MS
const RUN_TIMEOUT_MS = 120 * 1000 // one scrape; the CLI got slow, see above
const WATCHDOG_MS = RUN_TIMEOUT_MS + 15 * 1000 // hard settle guarantee for one run
const STALE_MS = 45 * 60 * 1000 // stop serving a cache no refresh has renewed

const RUN_ARGS = ['-p', '--output-format', 'text', '--strict-mcp-config']

let cache = { windows: [], okAt: 0 }
let nextAt = 0 // earliest next attempt
let fails = 0
let inflight = null
let inflightAt = 0
let gen = 0 // guards an abandoned run from clobbering a newer one's result

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

// execFile's own `timeout` only signals the direct child, and its callback waits
// for the stdio pipes to close — helper processes that outlive the CLI keep them
// open, so 'close' (and the callback) can never fire. Take the whole tree.
function killTree(child) {
  if (!child) return
  try {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // already gone — nothing to kill
  }
}

// Resolves the parsed windows, or null on any failure. ALWAYS settles.
function runUsage() {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let child = null
    const finish = (v) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(v)
    }
    try {
      child = execFile(
        findClaudeBin(),
        RUN_ARGS,
        { timeout: RUN_TIMEOUT_MS, windowsHide: true, cwd: os.tmpdir(), maxBuffer: 1 << 20 },
        (err, stdout) => finish(err && !stdout ? null : parseClaudeUsage(stdout))
      )
      // A child that exits early makes this write EPIPE, and an unhandled
      // 'error' on a child stream takes the whole main process down with it.
      child.stdin.on('error', () => {})
      child.stdin.end('/usage\n')
    } catch {
      finish(null) // claude not installed / spawn failed
      return
    }
    timer = setTimeout(() => {
      killTree(child)
      finish(null)
    }, WATCHDOG_MS)
  })
}

function refresh() {
  const now = Date.now()
  // A run that never settled must not wedge every later refresh: past the
  // watchdog it is abandoned (its result is ignored via `gen`) and a fresh one
  // starts.
  if (inflight && now - inflightAt < WATCHDOG_MS) return inflight
  const my = ++gen
  inflightAt = now
  inflight = (async () => {
    const startedAt = Date.now()
    const w = await runUsage()
    if (my !== gen) return cache.windows // abandoned run; a newer one owns the cache
    if (w && w.length) {
      fails = 0
      cache = { windows: w, okAt: Date.now() }
      nextAt = Date.now() + REFRESH_MS
    } else {
      // Keep the windows for now — claudeResetWindows() ages them out — but come
      // back sooner than a full cycle, backing off if it keeps failing so a
      // broken/uninstalled CLI isn't re-spawned every couple of minutes.
      fails += 1
      nextAt = Date.now() + Math.min(REFRESH_MS, RETRY_MS * fails)
      console.error(`[claudeLimits] /usage scrape failed after ${Date.now() - startedAt}ms (${fails}x)`)
    }
    inflight = null
    return cache.windows
  })()
  return inflight
}

// Prime once at startup so the first popup already has data.
export function primeClaudeLimits() {
  return refresh()
}

// Newest Claude plan-quota windows, or [] if none is current. Returns the
// cached value immediately and kicks a background refresh when one is due.
// Nothing frozen is ever served: a window whose reset time has passed, and a
// whole cache no refresh has renewed within STALE_MS, are dropped so the popup
// falls back to the plan's estimate instead of showing a stuck number.
export function claudeResetWindows() {
  const now = Date.now()
  if (now >= nextAt) refresh()
  if (!cache.okAt || now - cache.okAt > STALE_MS) return []
  return cache.windows.filter((w) => w.resetsAt == null || w.resetsAt > now)
}
