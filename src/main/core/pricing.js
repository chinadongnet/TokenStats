// Rough USD cost estimates, in dollars per 1,000,000 tokens.
// These are approximate list prices and are EDITABLE — adjust to your plan.
// Matching is by longest substring of the model id (case-insensitive).
// Cached/cache-read input is billed cheaper than fresh input for most vendors.

const TABLE = [
  // [modelSubstring, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM]
  ['claude-opus', 15, 75, 1.5, 18.75],
  ['claude-sonnet', 3, 15, 0.3, 3.75],
  ['claude-haiku', 0.8, 4, 0.08, 1],
  ['gpt-5', 1.25, 10, 0.125, 1.25],
  ['o3', 2, 8, 0.5, 2],
  ['codex', 1.25, 10, 0.125, 1.25],
  // Antigravity records carry display names ("Gemini 3.1 Pro (High)",
  // "Claude Opus 4.6 (Thinking)"), hence the space-separated keys.
  ['gemini 3.1 pro', 2.5, 15, 0.25, 2.5],
  ['gemini 3', 0.3, 2.5, 0.03, 0.3],
  ['claude opus', 15, 75, 1.5, 18.75],
  ['claude sonnet', 3, 15, 0.3, 3.75],
  ['gemini-3-pro', 2.5, 15, 0.25, 2.5],
  ['gemini-3-flash', 0.3, 2.5, 0.03, 0.3],
  ['gemini-2.5-pro', 1.25, 10, 0.125, 1.25],
  ['gemini-2.5-flash', 0.3, 2.5, 0.03, 0.3],
  ['gemini', 0.3, 2.5, 0.03, 0.3],
]

const DEFAULT = [1, 5, 0.1, 1]

function ratesFor(model) {
  const m = (model || '').toLowerCase()
  for (const [key, ...rates] of TABLE) {
    if (m.includes(key)) return rates
  }
  return DEFAULT
}

// Estimate USD cost for one normalized usage record.
export function costFor(rec) {
  const [inP, outP, cacheReadP, cacheWriteP] = ratesFor(rec.model)
  return (
    (rec.input * inP +
      rec.output * outP +
      rec.cacheRead * cacheReadP +
      rec.cacheCreate * cacheWriteP +
      rec.reasoning * outP) /
    1_000_000
  )
}
