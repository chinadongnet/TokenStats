import path from 'node:path'
import { CLI_ROOTS } from '../paths.js'

// Codex CLI writes append-only JSONL "rollout" files at:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Token usage arrives as `event_msg` records of type `token_count`. The
// payload carries BOTH a cumulative `total_token_usage` and a per-turn
// `last_token_usage`. We sum `last_token_usage` to avoid double-counting.
// Model / cwd are announced earlier in `session_meta` / `turn_context`.

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
    if (obj.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.last_token_usage) {
      const t = p.info.last_token_usage
      const input = t.input_tokens || 0
      const cacheRead = t.cached_input_tokens || 0
      const output = t.output_tokens || 0
      const reasoning = t.reasoning_output_tokens || 0
      // Codex `total_tokens` already includes cached input + reasoning output.
      const total = t.total_tokens || input + output
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
        total,
      }
    }
    return null
  },
}
