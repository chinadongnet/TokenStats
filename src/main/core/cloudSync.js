import { CLI_META } from './paths.js'
import { computeResetWindows, mergeLiveLimits, planRecordIndex } from './subscriptions.js'

// Cloud sync: pushes the local hourly usage table plus a trimmed "popup state"
// snapshot to a tokenstat-web instance (token.chinadong.net by default). Pure
// Node — no electron imports — wired up by index.js, which supplies the db,
// store and the same liveByCli object the popup's subs:resets handler uses.
//
// What leaves the machine (privacy contract, keep it this way):
// - usage_hourly rows: (hour, cli, model, token component sums, cost, turns).
//   NO project paths, NO session ids, NO prompt/response content, NO key aliases.
// - a status snapshot: CLI display names/colors, live quota windows (period
//   label + remaining % + reset time), plan names/fees/renewal — i.e. exactly
//   what the tray popup renders, nothing more.
//
// Push strategy: a rolling RESYNC_WINDOW_MS window on every sync (recent hours
// keep changing as usage accrues), with replaceFrom telling the server to drop
// its copy of that window first so locally-vanished rows (model renames,
// extraRoots edits) don't linger in the cloud. A config change or the Settings
// "full resync" button sets fullResync, which pushes everything from hour 0.

export const DEFAULT_ENDPOINT = 'https://token.chinadong.net'
const RESYNC_WINDOW_MS = 7 * 24 * 3600 * 1000
const FETCH_TIMEOUT_MS = 20000
// The server caps a request at 50k rows; stay comfortably under it.
const ROWS_PER_BATCH = 20000

const PERIOD_LABEL = { '5h': '5小时', weekly: '每周', monthly: '每月' }

export function normalizeEndpoint(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  return s
}

async function request(endpoint, path, { method = 'GET', apiKey, body } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(normalizeEndpoint(endpoint) + path, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  } finally {
    clearTimeout(timer)
  }
}

// "Test connection" for the Settings UI — validates key + endpoint, returns
// what the key is bound to ({username, deviceName, rowCount}).
export async function testCloudSync({ endpoint, apiKey }) {
  try {
    const data = await request(endpoint, '/api/ping', { apiKey })
    return { ok: true, ...data }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) }
  }
}

// The trimmed popup-state snapshot. Mirrors what App.jsx actually draws:
// live-source quota windows only (estimates aren't drawn there either),
// plus each plan's billing renewal and the active plans' fees.
export function buildStatusSnapshot({ db, store, liveByCli, appVersion }) {
  const now = Date.now()
  const subs = db.listSubscriptions()
  const recs = store.dedupedRecords()
  const index = planRecordIndex(subs, recs, now)
  const labels = Object.fromEntries(Object.entries(CLI_META).map(([k, v]) => [k, v.label]))
  const entries = mergeLiveLimits(computeResetWindows(subs, recs, now, index), liveByCli || {}, now, labels, index)

  const resets = entries
    .map((e) => {
      const windows = (e.windows || [])
        .filter((w) => w.source === 'live' && w.open)
        .map((w) => ({
          label: PERIOD_LABEL[w.period] || String(w.period),
          // Structured window identity + span + usage, so the web can anchor a
          // plan's 周/月 usage row to the actual quota cycle instead of the
          // calendar week/month and land on the same numbers the popup shows.
          period: w.period || null,
          startMs: w.start ?? (w.end != null && w.periodMs > 0 ? w.end - w.periodMs : null),
          remainingPct: Math.round(
            w.remainingPercent != null ? w.remainingPercent : w.usedPercent != null ? 100 - w.usedPercent : 0
          ),
          endMs: w.end ?? null,
          tokens: w.tokens || 0,
          cost: round2(w.cost || 0),
          title: `窗口内已用 ${w.tokens || 0} tokens / $${(w.cost || 0).toFixed(2)}`,
        }))
      if (!windows.length && !(e.monthlyUsd > 0)) return null
      return {
        planName: e.name,
        monthlyUsd: Number(e.monthlyUsd) || 0,
        // Which CLI cards this plan covers — lets the web popup draw the same
        // per-card "usage worth vs fee share" line the app popup has.
        clis: [...new Set((e.bindings || []).map((b) => b.cli).filter(Boolean))],
        // Full bindings (cli + model allowlist) so the web can compute this
        // plan's own usage inside the selected 日/周/月 scope. keyAlias is
        // deliberately omitted — it never leaves the machine (privacy) and the
        // cloud rows carry no key dimension to filter on anyway.
        bindings: (e.bindings || [])
          .filter((b) => b.cli)
          .map((b) => ({ cli: b.cli, models: Array.isArray(b.models) && b.models.length ? b.models : null })),
        windows,
        renewal: e.renewal
          ? { endMs: e.renewal.end, cost: round2(e.renewal.cost), tokens: e.renewal.tokens || 0 }
          : null,
      }
    })
    .filter(Boolean)

  const cliMeta = Object.fromEntries(Object.entries(CLI_META).map(([k, v]) => [k, { label: v.label, color: v.color }]))
  for (const p of db.listLitellmProviders()) {
    if (p.enabled) cliMeta['litellm:' + p.id] = { label: p.name, color: p.color }
  }

  const plans = subs
    .filter((s) => s.active && Number(s.monthlyUsd) > 0)
    .map((s) => ({ name: s.name, monthlyUsd: Number(s.monthlyUsd) }))

  return { generatedAt: now, appVersion, cliMeta, resets, plans }
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// One sync pass. Serialized by the caller (index.js keeps a single in-flight
// promise); safe to call often — it no-ops unless enabled and configured.
export async function performSync({ db, store, liveByCli, appVersion, fullOverride = false }) {
  const cfg = db.getCloudSync()
  if (!cfg.enabled || !cfg.apiKey || !cfg.endpoint) return { ok: false, skipped: true }

  const now = Date.now()
  const full = fullOverride || cfg.fullResync
  // Consume the flag NOW rather than clearing it after the pushes complete: a
  // Settings change landing while this sync is in flight re-raises it, and a
  // clear-at-completion would silently swallow that new request (whose rows
  // were rewritten AFTER this pass captured its data). A failed full pass
  // re-raises the flag below so the retry stays full.
  if (cfg.fullResync) db.updateCloudSyncState({ fullResync: false })
  const fromMs = full ? 0 : now - RESYNC_WINDOW_MS
  const rows = db.hourlySince(fromMs)
  const device = {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    appVersion,
  }
  const status = buildStatusSnapshot({ db, store, liveByCli, appVersion })

  try {
    // Batched: the first batch carries replaceFrom (clearing the window server-
    // side), later ones are pure upserts. Status rides on the last batch so the
    // web's "synced at" only flips once everything landed.
    let sent = 0
    for (let i = 0; i < Math.max(1, Math.ceil(rows.length / ROWS_PER_BATCH)); i++) {
      const batch = rows.slice(i * ROWS_PER_BATCH, (i + 1) * ROWS_PER_BATCH)
      const last = (i + 1) * ROWS_PER_BATCH >= rows.length
      const data = await request(cfg.endpoint, '/api/sync', {
        method: 'POST',
        apiKey: cfg.apiKey,
        body: {
          device,
          replaceFrom: i === 0 ? fromMs : null,
          hours: batch,
          status: last ? status : null,
        },
      })
      sent += data.accepted || 0
    }
    db.updateCloudSyncState({ lastSyncAt: now, lastError: null })
    return { ok: true, sent, full }
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : String(e.message || e)
    db.updateCloudSyncState({ lastError: msg, ...(full ? { fullResync: true } : {}) })
    return { ok: false, error: msg }
  }
}
