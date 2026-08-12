import path from 'node:path'
import { CLI_ROOTS } from '../paths.js'

// Codex CLI writes append-only JSONL "rollout" files at:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Token usage arrives as `event_msg` records of type `token_count`. The
// payload carries a cumulative `total_token_usage` and a per-turn
// `last_token_usage`.
//
// We derive each turn from the DELTA of the cumulative `total_token_usage`
// rather than summing `last_token_usage`. Measured against real data, summing
// `last_token_usage` over-counts (e.g. one 31-turn session summed to 347k vs a
// true cumulative of 183k) because `last_token_usage` is re-emitted/overlaps,
// whereas `total_token_usage` is monotonic and authoritative. Delta-of-
// cumulative reproduces the session's final total exactly while still giving
// per-turn granularity for the day/model breakdown.
// Model / cwd are announced earlier in `session_meta` / `turn_context`.
//
// Besides token counts, each `token_count` payload also carries a `rate_limits`
// snapshot — the same plan-quota numbers Codex's `/status` shows (per-window
// `used_percent`, `window_minutes`, and a `resets_at` epoch-seconds). That is
// live account state, not per-request usage, so it is NOT turned into a record;
// instead the newest snapshot seen across all rollouts is kept module-side and
// exposed via codexResetWindows() for the popup's Quota-windows section.

let latestLimits = null // { ts, rate_limits }

function windowLabel(min) {
  if (!min || min <= 0) return '?'
  if (min === 300) return '5h'
  if (min === 10080) return 'weekly'
  if (min % 1440 === 0) return `${min / 1440}d`
  if (min % 60 === 0) return `${min / 60}h`
  return `${min}m`
}

function normalizeWindow(w) {
  if (!w || typeof w.used_percent !== 'number') return null
  const used = Math.max(0, Math.min(100, w.used_percent))
  return {
    label: windowLabel(w.window_minutes),
    windowMinutes: w.window_minutes || 0,
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null, // s -> ms
  }
}

// Newest known plan-quota windows, shortest first, or [] if Codex never
// reported any. Read by the `codex:limits` IPC handler.
//
// The slots this arrives in are NOT stable across Codex versions: it used to
// report primary = 5h and secondary = weekly; since ~2026-07 it reports the
// weekly window in `primary` and leaves `secondary` null, and the payload has
// grown unrelated keys (`credits`, `plan_type`, `limit_id`, …). Reading fixed
// key names silently dropped the surviving window's siblings, so instead take
// every value that *looks* like a window — normalizeWindow() requires a
// numeric used_percent, which the metadata keys don't have. A renamed or
// added slot then shows up with no code change.
export function codexResetWindows() {
  const rl = latestLimits?.rate_limits
  if (!rl || typeof rl !== 'object') return []
  const byWindow = new Map()
  for (const w of Object.values(rl)) {
    const win = normalizeWindow(w)
    // Same window reported under two keys: keep the first (they agree).
    if (win && !byWindow.has(win.windowMinutes)) byWindow.set(win.windowMinutes, win)
  }
  return [...byWindow.values()].sort((a, b) => a.windowMinutes - b.windowMinutes)
}

export const codex = {
  cli: 'codex',
  roots: CLI_ROOTS.codex,
  kind: 'jsonl',
  match: (file) => path.basename(file).startsWith('rollout-') && file.endsWith('.jsonl'),

  parseLine(line, state, file) {
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      return null
    }
    const p = obj.payload || {}

    if (obj.type === 'session_meta') {
      state.sessionId = p.id || state.sessionId
      state.model = p.model || state.model
      state.cwd = p.cwd || state.cwd
      return null
    }
    if (obj.type === 'turn_context') {
      if (p.model) state.model = p.model
      if (p.cwd) state.cwd = p.cwd
      return null
    }
    if (obj.type === 'event_msg' && p.type === 'token_count') {
      // Keep the newest rate-limit snapshot regardless of whether this event
      // also carries token deltas (an errored/empty turn can still refresh it).
      if (p.rate_limits) {
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : Date.now()
        if (!latestLimits || ts >= latestLimits.ts) latestLimits = { ts, rate_limits: p.rate_limits }
      }
    }
    if (obj.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
      const cum = p.info.total_token_usage
      const prev = state.cum || { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 }
      const curr = {
        input: cum.input_tokens || 0,
        cached: cum.cached_input_tokens || 0,
        output: cum.output_tokens || 0,
        reasoning: cum.reasoning_output_tokens || 0,
        total: cum.total_tokens || 0,
      }
      // If the cumulative counter shrank (session reset/compaction), treat the
      // current values as the delta from a fresh zero baseline.
      const reset = curr.total < prev.total
      const d = (k) => Math.max(0, reset ? curr[k] : curr[k] - prev[k])
      const input = d('input')
      const cacheRead = d('cached')
      const output = d('output')
      const reasoning = d('reasoning')
      const total = d('total')
      state.cum = curr
      if (total === 0 && input === 0 && output === 0) return null
      return {
        cli: 'codex',
        ts: obj.timestamp ? Date.parse(obj.timestamp) : Date.now(),
        model: state.model || 'gpt-5-codex',
        sessionId: state.sessionId || path.basename(file),
        project: state.cwd ? path.basename(state.cwd) : path.basename(file),
        input: input - cacheRead, // non-cached portion, to mirror other CLIs
        output,
        cacheRead,
        cacheCreate: 0,
        reasoning,
        total, // already includes cached input + reasoning output
      }
    }
    return null
  },
}
