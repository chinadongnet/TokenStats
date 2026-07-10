// LiteLLM is a self-hosted LLM gateway. Unlike every other CLI here it writes
// nothing to disk on this machine — usage is tracked entirely server-side —
// so this "parser" isn't file-based at all: it's a periodic poller (see
// store.js's dynamic `this.pollers`, separate from the file-watching PARSERS)
// that calls the proxy's admin API with the org's management key.
//
// Multiple LiteLLM providers (keys) can be configured via the Settings UI —
// each is stored as a row in ~/.tokenstats/usage.sqlite's `litellm_providers`
// table (see db.js) and becomes its own poller, tagged with a pseudo-CLI id
// `litellm:<providerId>` so it shows up as an independent row everywhere a
// built-in CLI (claude/codex/...) would, dynamically instead of hardcoded.
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
export const DEFAULT_SYNC_MINUTES = 15 // matches the old hardcoded MIN_FETCH_INTERVAL_MS

function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

async function fetchPage(baseUrl, apiKey, startDate, endDate, page) {
  const url = `${baseUrl}/user/daily/activity?start_date=${startDate}&end_date=${endDate}&page=${page}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new Error(`litellm daily activity HTTP ${res.status}`)
  return res.json()
}

// Fetches every page across the lookback window and returns the raw flattened
// per-day results (no provider/model-settings knowledge yet).
async function fetchRawRecords(baseUrl, apiKey) {
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
  return dayResults
}

// Flatten every per-model/per-key leaf across the whole date range into
// normalized records for one provider. Skips leaves with zero usage (failed-
// only requests against models that were never actually billed) so unused
// models never show up in the model breakdown. `model` stays the RAW LiteLLM
// model id here — display rename is applied later (applyModelSettings), after
// dedupKey has already been computed from the raw id, so renaming a model
// never perturbs dedup/grouping identity.
function flatten(dayResults, providerId) {
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
          cli: `litellm:${providerId}`,
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
          dedupKey: `litellm:${providerId}:${day.date}:${model}:${keyHash}`,
        })
      }
    }
  }
  return records
}

// Applies live visibility/rename settings to a raw flattened record set. This
// is the only step that needs to re-run when the user edits Settings — it
// never re-fetches, so toggling a model's visibility or renaming it takes
// effect immediately. Renaming `model` here is safe: costFor() (pricing.js)
// prefers a record's real `cost` over any estimate-by-model-name lookup, and
// litellm records always carry a real `cost`.
function applyModelSettings(records, modelSettings) {
  if (!modelSettings || modelSettings.size === 0) return records
  const out = []
  for (const r of records) {
    const s = modelSettings.get(r.model)
    if (s && s.visible === false) continue
    out.push(s?.displayName ? { ...r, model: s.displayName } : r)
  }
  return out
}

// Per-provider poller used by the live app (store.js). `poll()` only returns a
// NEW record array reference when the underlying data actually changed (a
// fresh fetch, or an explicit reapplySettings() call) — store.pollAll()'s
// change detection is a reference check, so keeping `cache.applied` stable
// between fetches avoids spuriously re-broadcasting a snapshot every timer
// tick just because a settings map lookup happened to run again.
export function createLitellmPoller({ id, name, baseUrl, apiKey, color, syncMinutes, getModelSettings }) {
  const intervalMs = Math.max(1, Number(syncMinutes) || DEFAULT_SYNC_MINUTES) * 60 * 1000
  const cache = { raw: [], applied: [], fetchedAt: 0 }

  function reapply() {
    cache.applied = applyModelSettings(cache.raw, getModelSettings ? getModelSettings() : null)
    return cache.applied
  }

  async function refreshRaw() {
    cache.fetchedAt = Date.now() // set before awaiting so overlapping triggers don't pile up calls
    try {
      const dayResults = await fetchRawRecords(baseUrl, apiKey)
      cache.raw = flatten(dayResults, id)
    } catch {
      // undocumented internal admin API: keep the previous cache on error
    }
    reapply()
  }

  async function poll() {
    if (Date.now() - cache.fetchedAt >= intervalMs) await refreshRaw()
    return cache.applied
  }

  async function forceRefresh() {
    cache.fetchedAt = 0
    return poll()
  }

  // Re-applies live visibility/rename settings against the already-cached raw
  // fetch, with no network call — lets a Settings edit take effect immediately
  // instead of waiting for the next fetch window. Synchronous.
  function reapplySettings() {
    return reapply()
  }

  return {
    cli: `litellm:${id}`,
    providerId: id,
    enabled: true,
    poll,
    forceRefresh,
    reapplySettings,
    meta: { label: name, color },
  }
}

// Throttle-free, no-cache fetch used by the Settings UI's "load models"
// action — works for unsaved drafts too (caller always passes baseUrl/apiKey
// explicitly). Returns per-model aggregated usage across the lookback window,
// ignoring any visibility/rename settings (the settings screen needs to see
// every model, including currently-hidden ones, to let the user re-show them).
export async function listModels({ baseUrl, apiKey }) {
  const dayResults = await fetchRawRecords(baseUrl, apiKey)
  const raw = flatten(dayResults, '_draft')
  const byModel = new Map()
  for (const r of raw) {
    let m = byModel.get(r.model)
    if (!m) {
      m = { model: r.model, total: 0, cost: 0, lastSeen: 0 }
      byModel.set(r.model, m)
    }
    m.total += r.total
    m.cost += r.cost
    m.lastSeen = Math.max(m.lastSeen, r.ts)
  }
  return [...byModel.values()].sort((a, b) => b.total - a.total)
}
