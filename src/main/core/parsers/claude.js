import path from 'node:path'
import { CLI_ROOTS } from '../paths.js'

// Claude Code writes append-only JSONL transcripts at:
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Each assistant turn carries `message.usage` with the token breakdown.

export const claude = {
  cli: 'claude',
  roots: CLI_ROOTS.claude,
  kind: 'jsonl', // append-only -> incremental tail parsing
  match: (file) => file.endsWith('.jsonl'),

  // Parse a single JSONL line. `state` persists per-file (unused for Claude).
  parseLine(line, _state, file) {
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      return null
    }
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) return null

    const u = obj.message.usage
    const input = u.input_tokens || 0
    const output = u.output_tokens || 0
    const cacheCreate = u.cache_creation_input_tokens || 0
    const cacheRead = u.cache_read_input_tokens || 0

    return {
      cli: 'claude',
      ts: obj.timestamp ? Date.parse(obj.timestamp) : Date.now(),
      model: obj.message.model || 'unknown',
      sessionId: obj.sessionId || path.basename(file, '.jsonl'),
      project: projectName(obj.cwd, file),
      input,
      output,
      cacheRead,
      cacheCreate,
      reasoning: 0,
      total: input + output + cacheCreate + cacheRead,
    }
  },
}

function projectName(cwd, file) {
  if (cwd) return path.basename(cwd)
  // Fall back to the encoded directory name (e.g. "D--aiAgent-claude-aimonitor").
  return path.basename(path.dirname(file))
}
