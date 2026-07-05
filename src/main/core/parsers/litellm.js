import { LITELLM_CONFIG } from '../paths.js'

// LiteLLM is a self-hosted LLM gateway. Unlike every other CLI here it writes
// nothing to disk on this machine — usage is tracked entirely server-side —
// so this "parser" isn't file-based at all: it's a periodic poller (see
// store.js's POLLERS, separate from the file-watching PARSERS) that calls the
// proxy's admin API with the org's management key.
//
// Endpoint: GET {baseUrl}/user/daily/activity?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&page=N
// Auth: Authorization: Bearer <admin/management key>
// Response shape (LiteLLM v1 admin API, observed 2026-07):
//   { results: [ { date, metrics, breakdown: { models: {
//       "<model>": { metrics: {spend, prompt_tokens, completion_tokens,
//         cache_read_input_tokens, cache_creation_input_tokens, total_tokens,
//         successful_requests, failed_requests}, api_key_breakdown: {
//           "<keyHash>": { metrics: {...same...}, metadata: {key_alias, team_id} }
//         } }
//   } } } ], metadata: { page, total_pages, has_more, ... } }
// `page`/`total_pages` pagination is NOT day-aligned — a single date's models
// can be split across adjacent pages (confirmed by probing: page N's row for
// a date had one model, page N+1's row for the SAME date had four different
// ones). So this fetches every page for the range and flattens every
// per-model/per-key leaf across all of them; leaves never repeat across pages
// in practice, and the store's dedupKey makes it harmless even if they did.
// Re-validate this shape after LiteLLM upgrades — it's an internal admin API,
// not the documented public one.

const LOOKBACK_DAYS = 35
const MAX_PAGES = 40
const MIN_FETCH_INTERVAL_MS = 15 * 60 * 1000

function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

async function fetchPage(baseUrl, apiKey, startDate, endDate, page) {
  const url = `${baseUrl}/user/daily/activity?start_date=${startDate}&end_date=${endDate}&page=${page}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`litellm daily activity HTTP ${res.status}`)
  return res.json()
}

// Flatten every per-model/per-key leaf across the whole date range into
// normalized records. Skips leaves with zero usage (failed-only requests
// against models that were never actually billed) so unused models never
// show up in the model breakdown.
function toRecords(dayResults) {
  const records = []
  for (const day of dayResults) {
    // Center-of-day UTC timestamp: the API gives no per-request time, only a
    // date. Noon UTC keeps this within the same local calendar day for every
    // real-world timezone offset, so "today" bucketing stays correct.
    const ts = Date.parse(day.date + 'T12:00:00Z')
    const models = day.breakdown?.models || {}
    for (const [model, modelEntry] of Object.entries(models)) {
      const keys = modelEntry.api_key_breakdown || {}
      for (const [keyHash, keyEntry] of Object.entries(keys)) {
        const m = keyEntry.metrics || {}
        const total = Number(m.total_tokens) || 0
        if (total === 0) continue
        const alias = keyEntry.metadata?.key_alias || null
        const cacheRead = Number(m.cache_read_input_tokens) || 0
        const cacheCreate = Number(m.cache_creation_input_tokens) || 0
        const promptTokens = Number(m.prompt_tokens) || 0
        records.push({
          cli: 'litellm',
          ts,
          model,
          sessionId: keyHash,
          project: alias || 'litellm',
          input: Math.max(0, promptTokens - cacheRead - cacheCreate),
          output: Number(m.completion_tokens) || 0,
          cacheRead,
          cacheCreate,
          reasoning: 0,
          total,
          cost: Number(m.spend) || 0,
          dedupKey: `litellm:${day.date}:${model}:${keyHash}`,
        })
      }
    }
  }
  return records
}

async function fetchRecords(baseUrl, apiKey) {
  const end = new Date()
  const start = new Date(end.getTime() - (LOOKBACK_DAYS - 1) * 86400000)
  const startDate = isoDate(start)
  const endDate = isoDate(end)

  const dayResults = []
  let page = 1
  while (page <= MAX_PAGES) {
    const body = await fetchPage(baseUrl, apiKey, startDate, endDate, page)
    dayResults.push(...(body.results || []))
    if (!body.metadata?.has_more) break
    page++
  }
  return toRecords(dayResults)
}

const cache = { records: [], fetchedAt: 0 }

async function poll() {
  if (!LITELLM_CONFIG) return []
  if (Date.now() - cache.fetchedAt < MIN_FETCH_INTERVAL_MS) return cache.records
  cache.fetchedAt = Date.now() // set before awaiting so overlapping triggers don't pile up calls
  try {
    cache.records = await fetchRecords(LITELLM_CONFIG.baseUrl, LITELLM_CONFIG.apiKey)
  } catch {
    // undocumented internal admin API: keep the previous cache on error
  }
  return cache.records
}

export const litellm = {
  cli: 'litellm',
  enabled: !!LITELLM_CONFIG,
  poll,
}
