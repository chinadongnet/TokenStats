import path from 'node:path'
import { CLI_ROOTS } from '../paths.js'

// Gemini CLI stores chat logs under:
//   ~/.gemini/tmp/<project>/chats/session-<ts>.jsonl   (current: append-only JSONL)
//   ~/.gemini/tmp/<project>/chats/session-<ts>.json    (older: whole-file JSON)
// Both carry the same per-message shape: a `gemini`-type message has a `tokens`
// object {input,output,cached,thoughts,tool,total}, a `model`, and an `id`.
//
// IMPORTANT — de-duplication: the .jsonl log is NOT a clean append of new
// messages. Gemini CLI re-writes the running conversation on each save, so the
// same message (identical `id` and `tokens`) is appended many times — observed
// to inflate totals ~1.8×. Each record carries a `dedupKey` (the message `id`)
// so the store counts each unique message once.

function isChat(file) {
  return file.replace(/\\/g, '/').includes('/chats/') && path.basename(file).startsWith('session-')
}

// project name = the dir that owns the chats/ folder (e.g. "labops-1").
function projectOf(file) {
  return path.basename(path.dirname(path.dirname(file)))
}

function recordFromMessage(m, sessionId, project) {
  if (!m || m.type !== 'gemini' || !m.tokens) return null
  const t = m.tokens
  const input = t.input || 0
  const output = t.output || 0
  const cacheRead = t.cached || 0
  const reasoning = t.thoughts || 0
  return {
    cli: 'gemini',
    ts: m.timestamp ? Date.parse(m.timestamp) : Date.now(),
    model: m.model || 'gemini',
    sessionId,
    project,
    input: input - cacheRead,
    output,
    cacheRead,
    cacheCreate: 0,
    reasoning,
    total: t.total || input + output,
    // Stable message id (UUID) so re-appended duplicate lines collapse to one.
    dedupKey: m.id ? `gemini|${m.id}` : null,
  }
}

// Current format: append-only JSONL, one message per line.
export const geminiJsonl = {
  cli: 'gemini',
  roots: CLI_ROOTS.gemini,
  kind: 'jsonl',
  match: (file) => isChat(file) && file.endsWith('.jsonl'),
  parseLine(line, _state, file) {
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      return null
    }
    return recordFromMessage(obj, path.basename(file, '.jsonl'), projectOf(file))
  },
}

// Older format: whole-file JSON with a `messages[]` array, rewritten on change.
export const geminiJson = {
  cli: 'gemini',
  roots: CLI_ROOTS.gemini,
  kind: 'json',
  match: (file) => isChat(file) && file.endsWith('.json'),
  parseFile(text, file) {
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      return []
    }
    const messages = Array.isArray(doc.messages) ? doc.messages : []
    const sessionId = doc.sessionId || path.basename(file, '.json')
    const project = projectOf(file)
    const out = []
    for (const m of messages) {
      const rec = recordFromMessage(m, sessionId, project)
      if (rec) out.push(rec)
    }
    return out
  },
}
