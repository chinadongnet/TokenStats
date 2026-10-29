import { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, dialog, clipboard } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Store } from './core/store.js'
import { UsageDb } from './core/db.js'
import { CLI_META, ensureConfigFile, CONFIG_FILE, loadLanguage, saveLanguage } from './core/paths.js'
import { createLitellmPoller, listModels } from './core/parsers/litellm.js'
import { codexResetWindows } from './core/parsers/codex.js'
import { cursor, cursorResetWindows, configureCursorArchive } from './core/parsers/cursor.js'
import { claudeResetWindows, primeClaudeLimits } from './core/claudeLimits.js'
import { primeAgyLimits } from './core/agyLimits.js'
import { computeCycleDashboard, computeAllSubscriptionStats, computePlanBreakdown, computePlanTimeline, computeResetWindows, mergeLiveLimits, planRecordIndex } from './core/subscriptions.js'
import { migrateLegacyLitellmConfig } from './core/migrateLitellm.js'
import { isAutoLaunch, setAutoLaunch, migrateLegacyRunKeys } from './autoLaunch.js'
import { agyResetWindows, getAgyQuotaState, enableAgyQuota, disableAgyQuota, ensureAgyHook, AGY_MIRROR_PATH } from './agyQuota.js'
import { makeTrayIcon } from './trayIcon.js'
import { performSync, pullCloudAccount, testCloudSync, normalizeEndpoint, DEFAULT_ENDPOINT } from './core/cloudSync.js'
import { checkForUpdate, downloadUpdate, launchInstaller, UPDATE_REPO, RELEASES_URL } from './updater.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fixed logical (DIP) size of the tray popup's content area. Re-applied on every
// show and on display changes so a resolution/DPI switch can't shrink it.
const POPUP_W = 380
const POPUP_H = 640

let tray = null
let win = null
let reportWin = null
let settingsWin = null
let cyclesWin = null
let store = null
let db = null
let lastSnapshot = null
let lastIngest = 0
let ingestTimer = null
// Label/color for active LiteLLM provider pseudo-CLI ids (litellm:<id>), kept
// in sync by refreshLitellmPollers() — used wherever a static CLI_META lookup
// alone wouldn't know about a dynamic provider (tray recolor, open-data-dir).
let dynamicCliMeta = {}
// Installer downloaded by the Settings updater, waiting for the user to confirm
// the (app-quitting) install. Cleared only by restarting — a stale path is
// re-validated by launchInstaller().
let pendingInstaller = null
// UI language for the native tray menu/tooltip. The renderer owns its own copy
// (localStorage); this mirror is updated by the 'set-language' IPC and read when
// the tray context menu is (re)built on each right-click.
let lang = loadLanguage()
// Tray-only strings — the renderer has its own full dictionary (src/renderer/
// src/i18n.js); this covers just the native menu/tooltip the main process draws.
const TRAY_STRINGS = {
  en: {
    open: 'Open TokenStats',
    report: 'Token report…',
    cycles: 'Subscription cycles…',
    settings: 'Settings…',
    refresh: 'Refresh now',
    editSources: 'Edit data sources… (other devices)',
    startAtLogin: 'Start at login',
    quit: 'Quit',
    todayTokens: 'today {n} tokens',
  },
  zh: {
    open: '打开 TokenStats',
    report: '用量报表…',
    cycles: '订阅周期…',
    settings: '设置…',
    refresh: '立即刷新',
    editSources: '编辑数据源…（其他设备）',
    startAtLogin: '开机启动',
    quit: '退出',
    todayTokens: '今日 {n} tokens',
  },
}
const tray_t = (key, params) => {
  let s = (TRAY_STRINGS[lang] || TRAY_STRINGS.en)[key] || TRAY_STRINGS.en[key] || key
  if (params) for (const k in params) s = s.split('{' + k + '}').join(String(params[k]))
  return s
}
// True while the popup's screenshot save dialog is open — the dialog steals
// focus, and without this the popup's hide-on-blur would close it mid-export.
let popupExporting = false

// Single instance — a tray app should never run twice.
if (!app.requestSingleInstanceLock()) {
  // Dev and the installed build share userData (%APPDATA%\tokenstats), so they
  // share this lock: if the autostarted app is running, `npm run dev` exits here
  // and the OLD window pops up instead. Quit TokenStats from the tray first.
  console.error(`[tokenstats] another instance holds the lock (${app.getPath('userData')}) — exiting.`)
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(init)
}

async function init() {
  app.setAppUserModelId('com.tokenstats.app')
  migrateLegacyRunKeys() // one-time: drop the pre-rename com.tokenstatus.app Run value
  ensureConfigFile() // create ~/.tokenstats/config.json template on first run

  // UI language: renderer owns the instant switch (localStorage); this persists
  // it for the tray menu and rebroadcasts to every window so all surfaces stay in
  // sync even if a cross-window storage event is missed. Registered BEFORE the
  // window loads: a renderer with no stored choice invokes 'get-language'
  // immediately, and anything registered after createWindow() can lose that race.
  ipcMain.handle('get-language', () => lang)
  ipcMain.handle('set-language', (_e, l) => {
    lang = saveLanguage(l)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('language', lang)
    // The right-click menu is rebuilt on demand, but the tooltip string is not —
    // without this it keeps the old language until the next store snapshot.
    if (lastSnapshot) updateTray(lastSnapshot)
    return lang
  })

  createWindow()
  createTray()

  // A resolution/DPI change can rescale the popup's physical size and clip its
  // content. Re-assert the fixed content size (and reposition if it's showing).
  screen.on('display-metrics-changed', () => {
    if (!win || win.isDestroyed()) return
    sizeWindow()
    if (win.isVisible()) positionWindow()
  })

  // Open the hourly-usage SQLite database (best-effort; app still works without).
  try {
    db = await new UsageDb({ dbPath: process.env.AIMON_DB_PATH }).open()
    migrateLegacyLitellmConfig(db) // one-time config.json -> DB import, no-op after the first run
  } catch (e) {
    console.error('usage db failed to open:', e)
  }

  store = new Store()
  if (db) {
    store.seedHistory('agy', db.agyHistory())
    const legacyRows = db.hourlySince(0).filter((r) => r.cli === 'cursor')
    const records = legacyRows.map((r) => ({ ...r, ts: r.hour, sessionId: 'cloud', project: 'cursor', dedupKey: `cursor-legacy:${r.hour}:${r.model}` }))
    store.files.set('bootstrap:cursor', { parser: cursor, records })
    configureCursorArchive({
      load: (userId) => db.listCursorUsage(userId, legacyRows),
      save: (userId, rows) => db.saveCursorUsage(userId, rows),
    })
  }
  store.on('update', (snap) => {
    lastSnapshot = snap
    const eff = buildEffectiveSnapshot(snap)
    if (win && !win.isDestroyed()) win.webContents.send('snapshot', eff)
    updateTray(eff)
    scheduleIngest()
  })

  // Register IPC before the (slow) initial scan so the renderer never races a
  // missing handler. snapshot() safely returns whatever has been parsed so far.
  ipcMain.handle('get-snapshot', () => buildEffectiveSnapshot(lastSnapshot || (store ? store.snapshot() : null)))
  ipcMain.handle('devices:get', () =>
    db ? db.getDeviceViewState() : { selectedDevice: 'local', hasCloudData: false, currentKeyId: null, devices: [] }
  )
  ipcMain.handle('devices:select', (_e, deviceId) => {
    if (!db) return null
    const state = db.setSelectedDevice(deviceId)
    broadcastDeviceView()
    return state
  })
  ipcMain.handle('devices:refresh', async () => {
    if (!db) return null
    if (store) {
      await store.scanAllLocal()
      await store.refreshNetworkParsers({ force: true })
      await Promise.all(store.pollers.map((p) => store.forcePoll(p.cli)))
    }
    ingestNow()
    await runCloudSync().catch(() => {})
    broadcastSnapshot()
    broadcastDeviceView()
    return db.getDeviceViewState()
  })
  ipcMain.handle('open-data-dir', (_e, cli) => {
    if (typeof cli === 'string' && cli.startsWith('litellm:')) {
      const p = db?.getLitellmProvider(cli.slice('litellm:'.length))
      if (p?.baseUrl) shell.openExternal(p.baseUrl)
      return
    }
    const meta = CLI_META[cli]
    if (meta) shell.openPath(meta.root)
  })
  ipcMain.on('hide-window', () => win && win.hide())
  ipcMain.on('quit-app', () => { app.isQuitting = true; app.quit() })
  ipcMain.on('open-report', () => openReport())
  ipcMain.on('open-settings', () => openSettings())

  // Antigravity (agy) live-quota integration — installs/removes a statusLine
  // hook in agy's own settings (see agyQuota.js). Broadcasting after a change
  // lets the popup pick up (or drop) the live Antigravity card right away.
  ipcMain.handle('agy:get-state', () => getAgyQuotaState())
  ipcMain.handle('agy:set-enabled', (_e, on) => {
    const res = on ? enableAgyQuota() : disableAgyQuota()
    broadcastSnapshot()
    if (on) refreshAgyLimits(true)
    return res
  })

  // Updates — GitHub releases are the one distribution channel (see updater.js
  // and scripts/release.ps1). Check is manual: no background polling, no auto
  // install, so the app never restarts itself behind the user's back.
  ipcMain.handle('update:app-info', () => ({
    version: __APP_VERSION__,
    buildTime: __BUILD_TIME__,
    repo: UPDATE_REPO,
    releasesUrl: RELEASES_URL,
    // Dev runs from out/ and can't be replaced by the installer.
    packaged: app.isPackaged,
  }))
  ipcMain.handle('update:check', () => checkForUpdate(__APP_VERSION__))
  ipcMain.handle('update:download', async (e, asset) => {
    try {
      const send = (p) => {
        if (!e.sender.isDestroyed()) e.sender.send('update:progress', p)
      }
      pendingInstaller = await downloadUpdate(asset, send)
      return { ok: true, file: pendingInstaller }
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
  })
  // Hands off to NSIS and quits: the installer can't overwrite a running exe.
  // It brings the new version back up only because launchInstaller passes
  // --force-run (runAfterFinish is suppressed by /S) — see updater.js.
  ipcMain.handle('update:install', () => {
    try {
      launchInstaller(pendingInstaller)
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
    app.isQuitting = true
    setTimeout(() => app.quit(), 300)
    return { ok: true }
  })
  ipcMain.handle('update:open-releases', (_e, url) => shell.openExternal(url || RELEASES_URL))

  // Report data queries (served from the SQLite hourly table, respecting the
  // active device view: 'account', '<keyId>', or 'local').
  ipcMain.handle('report:hourly', (_e, dayStartMs, deviceId) => db?.hourly(dayStartMs, deviceId) ?? [])
  ipcMain.handle('report:daily', (_e, fromMs, toMs, deviceId) => db?.daily(fromMs, toMs, deviceId) ?? [])
  ipcMain.handle('report:models', (_e, fromMs, toMs, deviceId) => db?.models(fromMs, toMs, deviceId) ?? [])
  ipcMain.handle('report:span', (_e, deviceId) => db?.span(deviceId) ?? { min: null, max: null })
  // Per-request log is served live from the store (not the hourly DB) so it
  // reflects the exact deduplicated records that drive the totals.
  ipcMain.handle('report:requests', (_e, opts) => store?.requestLog(opts) ?? { rows: [], count: 0 })
  // Per-project totals are also served live from the store (the hourly DB has
  // no project dimension).
  ipcMain.handle('report:projects', (_e, fromMs, toMs) => store?.projectStats({ fromMs, toMs }) ?? [])
  ipcMain.handle('export-png', (_e, opts) => exportPng(opts))

  // LiteLLM multi-provider Settings CRUD (see core/db.js's litellm_providers /
  // litellm_model_settings tables and core/migrateLitellm.js for background).
  ipcMain.handle('litellm:list-providers', () => db?.listLitellmProviders() ?? [])
  ipcMain.handle('litellm:save-provider', async (_e, payload) => {
    if (!db) return null
    const prev = payload?.id ? db.getLitellmProvider(payload.id) : null
    const saved = db.upsertLitellmProvider(payload)
    refreshLitellmPollers()
    await store?.forcePoll('litellm:' + saved.id)
    broadcastSnapshot()
    // Toggling a provider's enabled state changes history far beyond the
    // rolling sync window: disabling drops all its rows from the next ingest,
    // enabling (re-)surfaces archive rows older than the window. Either way
    // the cloud needs a full push. Ingest synchronously first so the full
    // pass can't capture pre-change rows through the 4s ingest throttle.
    if (!!prev?.enabled !== !!saved.enabled) {
      ingestNow()
      db.updateCloudSyncState({ fullResync: true })
      runCloudSync()
    }
    return saved
  })
  ipcMain.handle('litellm:delete-provider', (_e, id) => {
    if (!db) return
    db.deleteLitellmProvider(id)
    refreshLitellmPollers()
    broadcastSnapshot()
    // The deleted provider's rows vanish locally on the next ingest, but the
    // cloud only replaces a rolling recent window per sync — do that ingest
    // NOW (past the 4s throttle) and schedule a full push so its older rows
    // don't linger on tokenstat-web forever.
    ingestNow()
    db.updateCloudSyncState({ fullResync: true })
    runCloudSync()
  })
  // Throttle-free live fetch for the Settings UI's "load models" action —
  // works for a not-yet-saved draft provider too.
  ipcMain.handle('litellm:list-models', async (_e, conn) => {
    try {
      return { ok: true, models: await listModels(conn) }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  // Subscription plans (monthly flat fees vs actual usage cost). Stats are
  // computed live from the store's deduped records — the hourly DB has no
  // project (key-alias) dimension, which the LiteLLM key filter needs.
  ipcMain.handle('subs:list', () => db?.listSubscriptions() ?? [])
  // A save/delete pings the report window AND re-broadcasts the snapshot: the
  // popup's Quota windows section refetches `subs:resets` on each snapshot, so
  // without this an edit here wouldn't reach it until some CLI happened to write
  // a log file (the only other thing that fires an update).
  ipcMain.handle('subs:save', (_e, payload) => {
    if (!db) return null
    const saved = db.upsertSubscription(payload)
    notifyReportUpdated()
    broadcastSnapshot()
    scheduleCloudSync()
    return saved
  })
  ipcMain.handle('subs:delete', (_e, id) => {
    if (!db) return
    db.deleteSubscription(id)
    notifyReportUpdated()
    broadcastSnapshot()
    scheduleCloudSync()
  })
  ipcMain.handle('subs:merge', (_e, { groupIds, targetId }) => {
    if (!db) return []
    const result = db.mergeSubscriptions(groupIds, targetId)
    notifyReportUpdated()
    broadcastSnapshot()
    scheduleCloudSync()
    return result
  })
  ipcMain.handle('subs:separate', (_e, id) => {
    if (!db) return null
    const result = db.separateSubscription(id)
    notifyReportUpdated()
    broadcastSnapshot()
    scheduleCloudSync()
    return result
  })
  ipcMain.handle('subs:stats', (_e, deviceId) =>
    db && store ? computeAllSubscriptionStats(db.listSubscriptions(), recordsForView(deviceId), Date.now()) : []
  )
  ipcMain.handle('subs:cycles', (_e, deviceId) => ({
    ...computeCycleDashboard(db?.listSubscriptions() || [], recordsForView(deviceId)),
    cliLabels: Object.fromEntries(Object.entries({ ...CLI_META, ...dynamicCliMeta }).map(([id, meta]) => [id, meta.label])),
  }))
  // Quota-reset windows for the tray popup. Recomputed per call (cheap) so the
  // popup's countdown always reflects the newest records and selected device.
  ipcMain.handle('subs:resets', (_e, deviceId) => computeResetsForView(deviceId))

  // Cloud sync (token.chinadong.net / any self-hosted tokenstat-web).
  // Config lives in the cloud_sync DB table; the engine is core/cloudSync.js.
  ipcMain.handle('cloudsync:get', () => (db ? { ...db.getCloudSync(), defaultEndpoint: DEFAULT_ENDPOINT } : null))
  ipcMain.handle('cloudsync:save', async (_e, payload) => {
    if (!db) return null
    const saved = db.saveCloudSync({ ...payload, endpoint: normalizeEndpoint(payload.endpoint || DEFAULT_ENDPOINT) })
    if (saved.enabled) runCloudSync() // fire-and-forget; state lands in cloud_sync
    return saved
  })
  ipcMain.handle('cloudsync:test', (_e, conn) =>
    testCloudSync({ endpoint: normalizeEndpoint(conn?.endpoint || DEFAULT_ENDPOINT), apiKey: conn?.apiKey || '' })
  )
  ipcMain.handle('cloudsync:sync-now', async (_e, opts) => {
    const res = await runCloudSync({ fullOverride: !!opts?.full })
    return { ...res, state: db ? db.getCloudSync() : null }
  })
  ipcMain.handle('cloudsync:resolve-conflict', async (_e, strategy) => {
    const res = await runCloudSync({ resolveSubscriptionsStrategy: strategy })
    return { ...res, state: db ? db.getCloudSync() : null }
  })
  ipcMain.handle('subs:timeline', (_e, fromMs, toMs, deviceId) =>
    db && store
      ? computePlanTimeline(db.listSubscriptions(), recordsForView(deviceId), fromMs, toMs, Date.now())
      : null
  )
  ipcMain.handle('subs:breakdown', (_e, fromMs, toMs, deviceId) =>
    db && store
      ? computePlanBreakdown(db.listSubscriptions(), recordsForView(deviceId), fromMs, toMs, Date.now())
      : { totalCost: 0, plans: [], unplanned: { fees: 0, cost: 0, tokens: 0, turns: 0, models: [] } }
  )

  ipcMain.handle('litellm:get-model-settings', (_e, providerId) => db?.listModelSettings(providerId) ?? [])
  // Historical models (from the hourly table) for the Settings model list — so
  // a model deleted from the proxy can still be hidden/renamed.
  ipcMain.handle('litellm:known-models', (_e, providerId) => db?.modelsForCli('litellm:' + providerId) ?? [])
  ipcMain.handle('litellm:save-model-setting', (_e, payload) => {
    if (!db) return
    // The Settings UI fires this on every rename-input blur, edited or not —
    // bail on no-ops, or focusing and leaving a field would schedule a full
    // history resync each time. Compare against the same normalization
    // saveModelSetting applies (visible defaults true, name trimmed-or-null).
    const prev = db.getModelSettingsMap(payload.providerId).get(payload.model)
    const nextVisible = payload.visible !== false
    const nextName =
      typeof payload.displayName === 'string' && payload.displayName.trim() ? payload.displayName.trim() : null
    if ((prev ? prev.visible : true) === nextVisible && (prev?.displayName || null) === nextName) return
    db.saveModelSetting(payload)
    if (store?.reapplyPoller('litellm:' + payload.providerId)) broadcastSnapshot()
    // Hiding/renaming a model rewrites the WHOLE local history (the archive
    // keeps raw ids and settings re-apply on load), but a normal sync only
    // replaces the recent window server-side — without a full push the cloud
    // would keep showing the old name (or a hidden model's rows) beyond it.
    // Ingest synchronously first so the full pass can't capture pre-change
    // rows through the 4s ingest throttle.
    ingestNow()
    db.updateCloudSyncState({ fullResync: true })
    runCloudSync()
  })

  ensureAgyHook() // re-assert the agy statusLine hook file if the user enabled it
  watchAgyMirror() // pick up quota-only refreshes (agy rewrites the mirror without any new usage)
  refreshLitellmPollers() // populate store.pollers before the initial scan/poll
  await store.start()
  ingestNow() // first full ingest after the initial scan
  const migratedAgy = [
    db?.markMigration('agy-output-cost-and-response-id-v1'),
    db?.markMigration('agy-desktop-conversations-v1'),
  ].some(Boolean)
  if (migratedAgy) {
    // Corrected historical AGY costs or newly indexed desktop AGY conversations
    // can lie outside the normal 7-day sync window.
    db.updateCloudSyncState({ fullResync: true })
  }
  startCloudSyncTimer() // pushes to tokenstat-web when enabled (Settings → 云同步)
  // Pull multi-device account data immediately on startup if not cached yet,
  // and run the first full sync pass shortly after startup.
  if (db && db.getCloudSync().enabled && db.listCloudDevices().length === 0) {
    pullCloudAccount({ db })
      .then((r) => {
        if (r?.ok) {
          ingestNow()
          broadcastDeviceView()
        }
      })
      .catch(() => {})
  }
  setTimeout(() => runCloudSync(), 5000)
  // Prime Claude's live plan-quota (spawns `claude -p /usage` once) so the
  // popup's Quota-windows section can show it without waiting for the first
  // 15-min refresh. Fire-and-forget; a snapshot after it lands shows the data.
  primeClaudeLimits().then(() => broadcastSnapshot()).catch(() => {})
  refreshAgyLimits()
  setInterval(() => refreshAgyLimits(), 20000)
  if (process.env.AIMON_AUTO_REPORT) openReport() // dev/test convenience
  if (process.env.AIMON_AUTO_CYCLES) openCycles()
  if ('AIMON_SET_AUTOLAUNCH' in process.env) setAutoLaunch(process.env.AIMON_SET_AUTOLAUNCH === '1') // headless toggle
}

function refreshAgyLimits(force = false) {
  if (!getAgyQuotaState().enabled) return
  primeAgyLimits({ force }).then(() => broadcastSnapshot()).catch(() => {})
}

// Live per-CLI quota windows, shared by the popup's subs:resets handler and
// the cloud-sync status snapshot so both always show identical numbers.
function buildLiveByCli() {
  return { codex: codexResetWindows(), claude: claudeResetWindows(), cursor: cursorResetWindows(), agy: agyResetWindows() }
}

// One in-flight cloud sync at a time. A call while one runs does NOT just
// coalesce onto it: the caller's reason (typically a Settings change that
// rewrote rows and flagged full_resync) refers to state the running pass
// already captured, so exactly one follow-up pass is queued behind it.
let cloudSyncInFlight = null
let cloudSyncQueued = null
let cloudSyncQueuedFull = false
let cloudSyncQueuedResolve = null
let cloudSyncLastAttempt = 0
let cloudSyncRetryAt = 0
let cloudSyncTimer = null

function scheduleCloudSync() {
  const cfg = db?.getCloudSync()
  if (!cfg?.enabled || !cfg.apiKey || !cfg.endpoint || cloudSyncTimer) return
  // Run after the DB ingest, coalescing bursts while keeping new CLI usage
  // within the 30s target under normal network conditions.
  const delay = Math.max(1000, cloudSyncLastAttempt + 5000 - Date.now(), cloudSyncRetryAt - Date.now())
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null
    runCloudSync()
  }, delay)
}
function runCloudSync(opts = {}) {
  if (!db || !store) return Promise.resolve({ ok: false, skipped: true })
  if (cloudSyncInFlight) {
    // Merge every joiner's intent into the one queued pass — a later
    // { fullOverride: true } must upgrade it, not silently ride an
    // incremental one.
    cloudSyncQueuedFull = cloudSyncQueuedFull || !!opts.fullOverride
    if (opts.resolveSubscriptionsStrategy) cloudSyncQueuedResolve = opts.resolveSubscriptionsStrategy
    if (!cloudSyncQueued) {
      cloudSyncQueued = cloudSyncInFlight
        .catch(() => {})
        .then(() => {
          const full = cloudSyncQueuedFull
          const resolveStrategy = cloudSyncQueuedResolve
          cloudSyncQueued = null
          cloudSyncQueuedFull = false
          cloudSyncQueuedResolve = null
          return runCloudSync({ fullOverride: full, resolveSubscriptionsStrategy: resolveStrategy })
        })
    }
    return cloudSyncQueued
  }
  cloudSyncLastAttempt = Date.now()
  cloudSyncInFlight = performSync({
    db,
    store,
    liveByCli: buildLiveByCli(),
    appVersion: __APP_VERSION__,
    fullOverride: !!opts.fullOverride,
    resolveSubscriptionsStrategy: opts.resolveSubscriptionsStrategy || null,
  })
    .catch((e) => ({ ok: false, error: String(e) }))
    .then((result) => {
      cloudSyncRetryAt = result.error ? Date.now() + 30000 : 0
      notifyReportUpdated()
      if (result.pulledSubscriptions || result.subscriptionSync || result.pulledAccount) {
        broadcastDeviceView()
      }
      return result
    })
    .finally(() => { cloudSyncInFlight = null })
  return cloudSyncInFlight
}

// Check once a minute whether the configured interval elapsed — same pattern
// as the store's poll-check timer: the timer is cheap, the network is gated.
function startCloudSyncTimer() {
  setInterval(() => {
    if (!db) return
    const cfg = db.getCloudSync()
    if (!cfg.enabled || !cfg.apiKey || !cfg.endpoint) return
    const due = cloudSyncLastAttempt + Math.max(1, cfg.syncMinutes) * 60000
    if (Date.now() >= due) runCloudSync()
  }, 60000)
}

// Throttle DB ingests: at most once every 4s, with a trailing run.
function scheduleIngest() {
  const since = Date.now() - lastIngest
  if (since >= 4000) return ingestNow()
  if (ingestTimer) return
  ingestTimer = setTimeout(() => { ingestTimer = null; ingestNow() }, 4000 - since)
}

function ingestNow() {
  if (!db || !store) return
  lastIngest = Date.now()
  try {
    db.ingest(store.dedupedRecords())
    if (lastSnapshot && win && !win.isDestroyed()) {
      win.webContents.send('snapshot', buildEffectiveSnapshot(lastSnapshot))
    }
    notifyReportUpdated()
    scheduleCloudSync()
  } catch (e) {
    console.error('ingest failed:', e)
  }
}

// Rebuilds store.pollers from the current DB provider rows — called on
// startup and after any LiteLLM provider add/edit/delete/toggle so the live
// app reflects Settings changes without a restart.
function refreshLitellmPollers() {
  if (!db || !store) return
  const providers = db.listLitellmProviders().filter((p) => p.enabled)
  dynamicCliMeta = Object.fromEntries(providers.map((p) => ['litellm:' + p.id, { label: p.name, color: p.color }]))
  store.setPollers(
    providers.map((p) =>
      createLitellmPoller({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        color: p.color,
        syncMinutes: p.syncMinutes,
        getModelSettings: () => db.getModelSettingsMap(p.id),
        // Local archive of the raw daily buckets — the proxy's admin API only
        // serves 35 days, so without this a provider's older usage would drop
        // out of usage_hourly on the next ingest (which rebuilds the table from
        // whatever the parsers currently hold).
        loadArchive: () => db.listLitellmUsage(p.id),
        saveArchive: (buckets, fromDay) => db.saveLitellmUsage(p.id, buckets, fromDay),
      })
    )
  )
}

// agy rewrites its quota mirror on every statusLine render — which happens on
// startup and while the user browses `/usage`, i.e. without producing any new
// token usage for the store to watch. Nothing else would ever fire, so the
// popup's Antigravity card would sit stale until unrelated usage landed. Poll
// the mirror's mtime and re-send the current snapshot, which is what makes the
// popup refetch subs:resets (see App.jsx). Cheap: one stat every 20s, and no
// snapshot recompute.
function watchAgyMirror() {
  fs.watchFile(AGY_MIRROR_PATH, { interval: 20000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return
    if (win && !win.isDestroyed() && lastSnapshot) win.webContents.send('snapshot', buildEffectiveSnapshot(lastSnapshot))
  })
}

function buildEffectiveSnapshot(baseSnap) {
  if (!db || !baseSnap) return baseSnap
  const viewState = db.getDeviceViewState()
  if (!viewState.hasCloudData || viewState.selectedDevice === 'local') {
    return {
      ...baseSnap,
      isCloudOverview: false,
      selectedDevice: 'local',
      deviceView: viewState,
    }
  }
  const cloudSnap = db.cloudOverview(viewState.selectedDevice, Date.now())
  if (!cloudSnap) {
    return {
      ...baseSnap,
      isCloudOverview: false,
      selectedDevice: 'local',
      deviceView: viewState,
    }
  }
  const provMap = new Map()
  for (const p of baseSnap.providers || []) provMap.set(p.id, p)
  for (const p of cloudSnap.providers || []) if (!provMap.has(p.id)) provMap.set(p.id, p)
  return {
    ...baseSnap,
    ...cloudSnap,
    providers: [...provMap.values()],
    live: baseSnap.live,
  }
}

function recordsForView(deviceId = null) {
  if (!db || !store) return []
  const eff = db.resolveDeviceId(deviceId)
  if (eff === 'local') return store.dedupedRecords()
  return db.recordsForDevice(eff)
}

function computeResetsForView(deviceId = null) {
  if (!db || !store) return []
  const now = Date.now()
  const subs = db.listSubscriptions()
  const eff = db.resolveDeviceId(deviceId)
  const recs = recordsForView(eff)
  const index = planRecordIndex(subs, recs, now)
  const entries = computeResetWindows(subs, recs, now, index)
  const labels = Object.fromEntries(Object.entries({ ...CLI_META, ...dynamicCliMeta }).map(([k, v]) => [k, v.label]))
  const viewState = db.getDeviceViewState()
  const isCurrentOrLocal = eff === 'local' || (viewState.currentKeyId && eff === viewState.currentKeyId)

  if (isCurrentOrLocal) {
    return mergeLiveLimits(entries, buildLiveByCli(), now, labels, index)
  }

  const cloudSnap = db.cloudOverview(eff, now)
  const cloudResets = cloudSnap?.cloudResets || []
  const byName = new Map(cloudResets.map((r) => [String(r.name || r.planName || '').toLowerCase(), r]))

  if (eff === 'account') {
    const mergedLocal = mergeLiveLimits(entries, buildLiveByCli(), now, labels, index)
    return mergedLocal.map((e) => {
      if ((e.windows || []).some((w) => w.source === 'live')) return e
      const cr = byName.get(String(e.name || '').toLowerCase())
      if (cr && Array.isArray(cr.windows) && cr.windows.length) {
        return { ...e, windows: cr.windows, renewal: cr.renewal || e.renewal }
      }
      return e
    })
  }

  // Specific remote device: overlay that device's synced live quota windows
  return entries.map((e) => {
    const cr = byName.get(String(e.name || '').toLowerCase())
    if (cr && Array.isArray(cr.windows) && cr.windows.length) {
      return { ...e, windows: cr.windows, renewal: cr.renewal || e.renewal }
    }
    return e
  })
}

function broadcastDeviceView() {
  const state = db ? db.getDeviceViewState() : null
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('device-view', state)
  }
  if (lastSnapshot) {
    const eff = buildEffectiveSnapshot(lastSnapshot)
    if (win && !win.isDestroyed()) win.webContents.send('snapshot', eff)
    updateTray(eff)
  }
  notifyReportUpdated()
}

// Pushes a fresh snapshot to the popup + tray + ingest, outside the normal
// store 'update' event (used after Settings changes that don't go through a
// file-watch/poll-timer trigger).
function broadcastSnapshot() {
  if (!store) return
  const s = store.snapshot()
  lastSnapshot = s
  const eff = buildEffectiveSnapshot(s)
  if (win && !win.isDestroyed()) win.webContents.send('snapshot', eff)
  updateTray(eff)
  scheduleIngest()
}

function createWindow() {
  win = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    useContentSize: true, // size the web content area, not the outer frame
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: '#0e0f13',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: false,
    },
  })

  // Hide instead of close; hide when focus is lost (popup behaviour).
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('blur', () => {
    if (popupExporting) return
    if (process.env.AIMON_NO_HIDE) return // dev/test convenience: keep the popup up
    if (!win.webContents.isDevToolsOpened()) win.hide()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function openReport() {
  if (reportWin && !reportWin.isDestroyed()) {
    reportWin.show()
    reportWin.focus()
    return
  }
  reportWin = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#0e0f13',
    title: 'TokenStats — Token Report',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: false,
    },
  })
  reportWin.removeMenu()
  // Surface renderer warnings/errors from the report window to the main log.
  reportWin.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[report]', message)
  })
  reportWin.webContents.on('render-process-gone', (_e, d) => console.error('[report] render gone:', d.reason))
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) reportWin.loadURL(devUrl + '#report')
  else reportWin.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'report' })
  reportWin.once('ready-to-show', () => {
    ingestNow() // make sure the DB reflects the latest before first paint
    reportWin.show()
  })
  reportWin.on('closed', () => { reportWin = null })
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 720,
    minWidth: 560,
    minHeight: 480,
    show: false,
    backgroundColor: '#0e0f13',
    title: 'TokenStats — Settings',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: false,
    },
  })
  settingsWin.removeMenu()
  settingsWin.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[settings]', message)
  })
  settingsWin.webContents.on('render-process-gone', (_e, d) => console.error('[settings] render gone:', d.reason))
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) settingsWin.loadURL(devUrl + '#settings')
  else settingsWin.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'settings' })
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => { settingsWin = null })
}

function openCycles() {
  if (cyclesWin && !cyclesWin.isDestroyed()) {
    cyclesWin.show()
    cyclesWin.focus()
    return
  }
  cyclesWin = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#0e0f13',
    title: 'TokenStats — Subscription Cycles',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: false,
    },
  })
  cyclesWin.removeMenu()
  cyclesWin.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[cycles]', message)
  })
  cyclesWin.webContents.on('render-process-gone', (_e, d) => console.error('[cycles] render gone:', d.reason))
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) cyclesWin.loadURL(devUrl + '#cycles')
  else cyclesWin.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'cycles' })
  cyclesWin.once('ready-to-show', () => cyclesWin.show())
  cyclesWin.on('closed', () => { cyclesWin = null })
}

function notifyReportUpdated() {
  for (const target of [reportWin, settingsWin, cyclesWin]) {
    if (target && !target.isDestroyed()) target.webContents.send('report-updated')
  }
}

// Screenshot a window as PNG, then either save it to disk or copy it to the
// clipboard. Both windows scroll their content in an inner region (body is
// overflow:hidden), so a plain capture would clip everything below the fold —
// the popup's off-screen model cards, the report's lower charts. So we grow the
// window to fit its full content first, capped to the display, then restore.
async function exportPng({ which = 'report', mode = 'save' } = {}) {
  const targetWin = which === 'popup' ? win : reportWin
  if (!targetWin || targetWin.isDestroyed()) return { ok: false }
  const isPopup = which === 'popup'
  let restore = null
  // Hold off the blur-hide for the WHOLE popup export: growing the window and
  // capturing must not let the always-on-top popup vanish out from under us.
  if (isPopup) popupExporting = true
  try {
    // Extra height needed to reveal everything currently scrolled out of view.
    // The popup's overflow lives in `.scroll` (header/footer pinned), so its
    // hidden overflow is what to add; the report scrolls `.report` as a whole.
    const extra = await targetWin.webContents.executeJavaScript(
      isPopup
        ? "(() => { const e = document.querySelector('.scroll'); return e ? e.scrollHeight - e.clientHeight : 0 })()"
        : "Math.max(0, (document.querySelector('.report')?.scrollHeight ?? document.body.scrollHeight) - document.documentElement.clientHeight)"
    )
    const bounds = targetWin.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const target = Math.min(bounds.height + Math.ceil(extra) + (isPopup ? 0 : 8), display.workArea.height)
    if (target > bounds.height + 1) {
      restore = bounds
      // The popup is created non-resizable, which makes setBounds a no-op on
      // Windows — flip it on for the duration of the capture, then back.
      if (isPopup) targetWin.setResizable(true)
      targetWin.setBounds({ ...bounds, height: target })
      await new Promise((r) => setTimeout(r, isPopup ? 120 : 250))
    }
    const img = await targetWin.webContents.capturePage()
    if (mode === 'copy') {
      clipboard.writeImage(img)
      return { ok: true, copied: true }
    }
    const defaultPath = path.join(
      app.getPath('pictures'),
      `tokenstats-${which}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
    )
    const { canceled, filePath } = await dialog.showSaveDialog(targetWin, {
      title: 'Export screenshot as PNG',
      defaultPath,
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    })
    if (canceled || !filePath) return { ok: false }
    fs.writeFileSync(filePath, img.toPNG())
    shell.showItemInFolder(filePath)
    return { ok: true, filePath }
  } catch (e) {
    console.error('export png failed:', e)
    return { ok: false, error: String(e) }
  } finally {
    if (restore) targetWin.setBounds(restore)
    if (isPopup && restore) targetWin.setResizable(false)
    if (isPopup) popupExporting = false
  }
}

function createTray() {
  tray = new Tray(makeTrayIcon({ color: [217, 119, 87] }))
  tray.setToolTip(`TokenStats v${__APP_VERSION__} (${__BUILD_TIME__})`)
  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: tray_t('open'), click: () => showWindow() },
      { label: tray_t('report'), click: () => openReport() },
      { label: tray_t('cycles'), click: () => openCycles() },
      { label: tray_t('settings'), click: () => openSettings() },
      { type: 'separator' },
      { label: tray_t('refresh'), click: async () => { await store.scanAllLocal(); await store.refreshNetworkParsers({ force: true }); await Promise.all(store.pollers.map((p) => store.forcePoll(p.cli))); ingestNow(); broadcastSnapshot() } },
      { label: tray_t('editSources'), click: () => { ensureConfigFile(); shell.openPath(CONFIG_FILE) } },
      { type: 'separator' },
      { label: tray_t('startAtLogin'), type: 'checkbox', checked: isAutoLaunch(), click: (item) => setAutoLaunch(item.checked) },
      { type: 'separator' },
      { label: tray_t('quit'), click: () => { app.isQuitting = true; app.quit() } },
    ])
    tray.popUpContextMenu(menu)
  })
}

function updateTray(snap) {
  if (!tray) return
  const today = snap?.totals?.today?.total || 0
  // Build time, not just version: dev iterates without bumping, so the version
  // alone can't tell a fresh install from a stale one.
  tray.setToolTip(`TokenStats v${__APP_VERSION__} (${__BUILD_TIME__}) — ${tray_t('todayTokens', { n: compact(today) })}`)
  // Recolour by the most recently active CLI (built-in or a dynamic LiteLLM provider).
  const cli = snap?.live?.cli
  const meta = cli && (CLI_META[cli] || dynamicCliMeta[cli])
  if (meta) tray.setImage(makeTrayIcon({ color: hexToRgb(meta.color) }))
}

function toggleWindow() {
  if (win.isVisible()) win.hide()
  else showWindow()
}

function showWindow() {
  sizeWindow()
  positionWindow()
  win.show()
  win.focus()
}

// Re-assert the fixed content size, but cap the height to the current display's
// work area so a low-resolution / high-DPI screen can't push the window off-screen
// (the renderer scrolls internally when the content is taller than this).
function sizeWindow() {
  const display = screen.getDisplayMatching(tray ? tray.getBounds() : win.getBounds())
  const maxH = Math.max(240, display.workArea.height - 8)
  win.setContentSize(POPUP_W, Math.min(POPUP_H, maxH))
}

// Anchor the popup to the tray / bottom-right work area.
function positionWindow() {
  const tb = tray.getBounds()
  const display = screen.getDisplayMatching(tb)
  const area = display.workArea
  const [w, h] = win.getContentSize()
  let x = Math.round(tb.x + tb.width / 2 - w / 2)
  let y = Math.round(tb.y - h - 8)
  // Keep on-screen; if taskbar is at the bottom, place above it.
  x = Math.min(Math.max(x, area.x + 4), area.x + area.width - w - 4)
  if (y < area.y) y = area.y + 4
  if (y + h > area.y + area.height) y = area.y + area.height - h - 4
  win.setPosition(x, y, false)
}

app.on('window-all-closed', () => {
  // Tray app: keep running even with no windows.
})

app.on('before-quit', async () => {
  app.isQuitting = true
  if (store) await store.stop()
})

function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function hexToRgb(hex) {
  const m = hex.replace('#', '')
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]
}
