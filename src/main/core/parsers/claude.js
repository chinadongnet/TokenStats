import path from 'node:path'
import { CLI_ROOTS } from '../paths.js'

// Claude Code writes append-only JSONL transcripts at:
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Each assistant turn carries `message.usage` with the token breakdown.
//
// IMPORTANT — de-duplication: Claude Code writes ONE JSONL line per *content
// block* of an assistant message (thinking, text, each tool_use), and every one
// of those lines repeats the SAME `message.usage`. A 3-block turn therefore
// appears 3× on disk. The same (message.id, requestId) pair is also re-written
// across files when a session is resumed. Both would multiply the token counts
// (~1.8× in practice), so each record carries a `dedupKey` and the store counts
// each unique key only once. This mirrors how ccusage de-duplicates.

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

    // Stable per-message identity, used by the store to drop the repeated
    // content-block / resume-copy lines that share one usage object.
    const msgId = obj.message.id || ''
    const reqId = obj.requestId || ''
    const dedupKey = msgId || reqId ? `claude|${msgId}|${reqId}` : null

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
      dedupKey,
    }
  },
}

function projectName(cwd, file) {
  if (cwd) return path.basename(cwd)
  // Fall back to the encoded directory name (e.g. "D--aiAgent-claude-aimonitor").
  return path.basename(path.dirname(file))
}
