import { CLI_META } from './paths.js'
import { computeResetWindows, mergeLiveLimits, planRecordIndex } from './subscriptions.js'

// Cloud sync: pushes the local hourly usage table plus a trimmed "popup state"
// snapshot and full subscription history to a tokenstat-web instance
// (token.chinadong.net by default). Pure Node — no electron imports — wired up
// by index.js, which supplies the db, store and the same liveByCli object the
// popup's subs:resets handler uses.
//
// What leaves the machine (privacy contract, keep it this way):
// - usage_hourly rows: (hour, cli, model, token component sums, cost, turns).
//   NO project paths, NO session ids, NO prompt/response content, NO key aliases.
// - subscriptions: all active & historical subscription plans (id, groupId, name,
//   monthlyUsd, startDate, active, endDate, cli/model bindings without keyAlias).
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
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      const err = new Error('timeout')
      err.name = 'AbortError'
      reject(err)
    }, FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(normalizeEndpoint(endpoint) + path, {
          method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        })
        const data = await res.json().catch((err) => {
          if (ctrl.signal.aborted || err?.name === 'AbortError') throw err
          return {}
        })
        if (ctrl.signal.aborted) {
          const err = new Error('timeout')
          err.name = 'AbortError'
          throw err
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        return data
      })(),
      timeoutPromise,
    ])
  } finally {
    if (timer) clearTimeout(timer)
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

// Sanitize all subscriptions (active & historical) for cloud sync — keyAlias is
// stripped so local LiteLLM token key aliases never leave the machine.
export function serializeSubscriptionsForCloud(subs) {
  return (subs || []).map((s) => ({
    id: s.id,
    groupId: s.groupId || s.id,
    name: s.name,
    monthlyUsd: Number(s.monthlyUsd) || 0,
    startDate: s.startDate,
    active: s.active !== false,
    endDate: s.active === false ? s.endDate || null : null,
    bindings: (s.bindings || [])
      .filter((b) => b && b.cli)
      .map((b) => ({
        cli: b.cli,
        models: Array.isArray(b.models) && b.models.length ? b.models : null,
      })),
    clis: [...new Set((s.bindings || []).map((b) => b?.cli).filter(Boolean))],
    resetPeriods: Array.isArray(s.resetPeriods) ? s.resetPeriods : [],
    resetAnchors: s.resetAnchors && typeof s.resetAnchors === 'object' ? s.resetAnchors : {},
    createdAt: s.createdAt || null,
    updatedAt: s.updatedAt || null,
  }))
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
  const cursorAccountId = typeof db.cursorAccountHash === 'function' ? db.cursorAccountHash() : ''
  if (cursorAccountId && cliMeta.cursor) {
    cliMeta.cursor = { ...cliMeta.cursor, accountId: cursorAccountId }
  }
  for (const p of db.listLitellmProviders()) {
    if (p.enabled) {
      cliMeta['litellm:' + p.id] = {
        label: p.name,
        color: p.color,
        baseUrl: normalizeEndpoint(p.baseUrl).toLowerCase(),
      }
    }
  }

  const plans = subs
    .filter((s) => s.active && Number(s.monthlyUsd) > 0)
    .map((s) => ({ name: s.name, monthlyUsd: Number(s.monthlyUsd) }))

  const subscriptions = serializeSubscriptionsForCloud(subs)

  return { generatedAt: now, appVersion, cliMeta, resets, plans, subscriptions }
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// One sync pass. Serialized by the caller (index.js keeps a single in-flight
// promise); safe to call often — it no-ops unless enabled and configured.
export async function performSync({
  db,
  store,
  liveByCli,
  appVersion,
  fullOverride = false,
  resolveSubscriptionsStrategy = null,
  _retryingSubs = false,
}) {
  const cfg = db.getCloudSync()
  if (!cfg.enabled || !cfg.apiKey || !cfg.endpoint) return { ok: false, skipped: true }
  const connEndpoint = normalizeEndpoint(cfg.endpoint)
  const connApiKey = String(cfg.apiKey).trim()
  const isSameConnection = () => {
    const cur = db.getCloudSync()
    return (
      cur.enabled &&
      normalizeEndpoint(cur.endpoint) === connEndpoint &&
      String(cur.apiKey).trim() === connApiKey
    )
  }

  const now = Date.now()
  const full = fullOverride || cfg.fullResync
  // The full_resync flag stays SET on disk until every batch lands — the first
  // full batch wipes the server with replaceFrom: 0, so a crash mid-loop must
  // resume as a full push on restart, not shrink back to the rolling window.
  // The generation counter tells a mid-flight re-raise (Settings change whose
  // rewritten rows this pass captured too early) apart from the raise being
  // consumed here; see db.updateCloudSyncState.
  const genAtStart = db.fullResyncGen || 0
  const fromMs = full ? 0 : now - RESYNC_WINDOW_MS
  const rows = db.hourlySince(fromMs)
  const device = {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    appVersion,
  }
  const status = buildStatusSnapshot({ db, store, liveByCli, appVersion })
  const subscriptions = status.subscriptions
  const submittedSubsFingerprint = JSON.stringify(subscriptions)

  try {
    // Batched: the first batch carries replaceFrom (clearing the window server-
    // side), later ones are pure upserts. Status & subscriptions ride on the
    // last batch so the web's "synced at" only flips once everything landed.
    let sent = 0
    let subscriptionSync = null
    let accountSync = null
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
          ...(last
            ? {
                includeAccount: true,
                subscriptions,
                baseSubscriptionsHash: cfg.subsBaseHash || null,
                resolveSubscriptionsStrategy: resolveSubscriptionsStrategy || null,
              }
            : {}),
        },
      })
      sent += data.accepted || 0
      if (last && data.subscriptionSync) subscriptionSync = data.subscriptionSync
      if (last && data.accountSync) accountSync = data.accountSync
      if (!isSameConnection()) {
        return { ok: false, skipped: true, connectionChanged: true }
      }
    }

    if (!isSameConnection()) {
      return { ok: false, skipped: true, connectionChanged: true }
    }

    if (accountSync) {
      db.saveCloudAccountSync(accountSync)
    }

    let pulledSubscriptions = false
    const syncPatch = {
      lastSyncAt: now,
      lastError: null,
    }
    const clearFull = cfg.fullResync && (db.fullResyncGen || 0) === genAtStart
    if (clearFull) syncPatch.fullResync = false

    const currentSubs = serializeSubscriptionsForCloud(db.listSubscriptions())
    const subsChangedMidFlight = JSON.stringify(currentSubs) !== submittedSubsFingerprint

    if (subscriptionSync) {
      if (subscriptionSync.status === 'synced') {
        syncPatch.subsBaseHash = subscriptionSync.cloudHash || null
        syncPatch.subsConflict = null
      } else if (subscriptionSync.status === 'pull' && Array.isArray(subscriptionSync.cloudSubs)) {
        if (subsChangedMidFlight) {
          // User saved/deleted/merged a subscription locally while the sync
          // request was in flight. Never overwrite those persisted edits with a
          // pull computed against the older snapshot; surface a conflict instead.
          subscriptionSync = {
            status: 'conflict',
            cloudHash: subscriptionSync.cloudHash || null,
            cloudSubs: subscriptionSync.cloudSubs,
            localSubs: currentSubs,
          }
          syncPatch.subsConflict = subscriptionSync
        } else {
          db.replaceAllSubscriptions(subscriptionSync.cloudSubs)
          syncPatch.subsBaseHash = subscriptionSync.cloudHash || null
          syncPatch.subsConflict = null
          pulledSubscriptions = true
        }
      } else if (subscriptionSync.status === 'conflict') {
        if (subsChangedMidFlight) {
          subscriptionSync = { ...subscriptionSync, localSubs: currentSubs }
        }
        syncPatch.subsConflict = subscriptionSync
      }
    }

    db.updateCloudSyncState(syncPatch)
    if (subsChangedMidFlight && subscriptionSync?.status === 'synced' && !_retryingSubs) {
      return await performSync({
        db,
        store,
        liveByCli,
        appVersion,
        fullOverride: false,
        resolveSubscriptionsStrategy: null,
        _retryingSubs: true,
      })
    }
    return { ok: true, sent, full, subscriptionSync, pulledSubscriptions, pulledAccount: !!accountSync }
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout' : String(e.message || e)
    if (isSameConnection()) {
      db.updateCloudSyncState({ lastError: msg }) // flag untouched — a failed full pass retries full
    }
    return { ok: false, error: msg }
  }
}

export async function pullCloudAccount({ db }) {
  const cfg = db.getCloudSync()
  if (!cfg.enabled || !cfg.apiKey || !cfg.endpoint) return { ok: false, skipped: true }
  const connEndpoint = normalizeEndpoint(cfg.endpoint)
  const connApiKey = String(cfg.apiKey).trim()
  const isSameConnection = () => {
    const cur = db.getCloudSync()
    return (
      cur.enabled &&
      normalizeEndpoint(cur.endpoint) === connEndpoint &&
      String(cur.apiKey).trim() === connApiKey
    )
  }
  try {
    const data = await request(cfg.endpoint, '/api/account', { apiKey: cfg.apiKey })
    if (data?.accountSync) {
      db.saveCloudAccountSync(data.accountSync)
      return { ok: true, accountSync: data.accountSync }
    }
    return { ok: false, error: 'no accountSync returned' }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) }
  }
}
