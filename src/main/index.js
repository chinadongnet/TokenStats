import { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, dialog, clipboard } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Store } from './core/store.js'
import { UsageDb } from './core/db.js'
import { CLI_META, ensureConfigFile, CONFIG_FILE } from './core/paths.js'
import { createLitellmPoller, listModels } from './core/parsers/litellm.js'
import { computeAllSubscriptionStats, computePlanBreakdown, computePlanTimeline, computeResetWindows } from './core/subscriptions.js'
import { migrateLegacyLitellmConfig } from './core/migrateLitellm.js'
import { makeTrayIcon } from './trayIcon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fixed logical (DIP) size of the tray popup's content area. Re-applied on every
// show and on display changes so a resolution/DPI switch can't shrink it.
const POPUP_W = 380
const POPUP_H = 600

let tray = null
let win = null
let reportWin = null
let settingsWin = null
let store = null
let db = null
let lastSnapshot = null
let lastIngest = 0
let ingestTimer = null
// Label/color for active LiteLLM provider pseudo-CLI ids (litellm:<id>), kept
// in sync by refreshLitellmPollers() — used wherever a static CLI_META lookup
// alone wouldn't know about a dynamic provider (tray recolor, open-data-dir).
let dynamicCliMeta = {}
// True while the popup's screenshot save dialog is open — the dialog steals
// focus, and without this the popup's hide-on-blur would close it mid-export.
let popupExporting = false

// Single instance — a tray app should never run twice.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(init)
}

async function init() {
  app.setAppUserModelId('com.tokenstats.app')
  ensureConfigFile() // create ~/.tokenstats/config.json template on first run

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
    db = await new UsageDb().open()
    migrateLegacyLitellmConfig(db) // one-time config.json -> DB import, no-op after the first run
  } catch (e) {
    console.error('usage db failed to open:', e)
  }

  store = new Store()
  store.on('update', (snap) => {
    lastSnapshot = snap
    if (win && !win.isDestroyed()) win.webContents.send('snapshot', snap)
    updateTray(snap)
    scheduleIngest()
  })

  // Register IPC before the (slow) initial scan so the renderer never races a
  // missing handler. snapshot() safely returns whatever has been parsed so far.
  ipcMain.handle('get-snapshot', () => lastSnapshot || (store ? store.snapshot() : null))
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

  // Report data queries (served from the SQLite hourly table).
  ipcMain.handle('report:hourly', (_e, dayStartMs) => db?.hourly(dayStartMs) ?? [])
  ipcMain.handle('report:daily', (_e, fromMs, toMs) => db?.daily(fromMs, toMs) ?? [])
  ipcMain.handle('report:models', (_e, fromMs, toMs) => db?.models(fromMs, toMs) ?? [])
  ipcMain.handle('report:span', () => db?.span() ?? { min: null, max: null })
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
    const saved = db.upsertLitellmProvider(payload)
    refreshLitellmPollers()
    await store?.forcePoll('litellm:' + saved.id)
    broadcastSnapshot()
    return saved
  })
  ipcMain.handle('litellm:delete-provider', (_e, id) => {
    if (!db) return
    db.deleteLitellmProvider(id)
    refreshLitellmPollers()
    broadcastSnapshot()
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
    if (reportWin && !reportWin.isDestroyed()) reportWin.webContents.send('report-updated')
    broadcastSnapshot()
    return saved
  })
  ipcMain.handle('subs:delete', (_e, id) => {
    if (!db) return
    db.deleteSubscription(id)
    if (reportWin && !reportWin.isDestroyed()) reportWin.webContents.send('report-updated')
    broadcastSnapshot()
  })
  ipcMain.handle('subs:stats', () =>
    db && store ? computeAllSubscriptionStats(db.listSubscriptions(), store.dedupedRecords(), Date.now()) : []
  )
  // Quota-reset windows for the tray popup. Recomputed per call (cheap) so the
  // popup's countdown always reflects the newest records.
  ipcMain.handle('subs:resets', () =>
    db && store ? computeResetWindows(db.listSubscriptions(), store.dedupedRecords(), Date.now()) : []
  )
  ipcMain.handle('subs:timeline', (_e, fromMs, toMs) =>
    db && store
      ? computePlanTimeline(db.listSubscriptions(), store.dedupedRecords(), fromMs, toMs, Date.now())
      : null
  )
  ipcMain.handle('subs:breakdown', (_e, fromMs, toMs) =>
    db && store
      ? computePlanBreakdown(db.listSubscriptions(), store.dedupedRecords(), fromMs, toMs, Date.now())
      : { totalCost: 0, plans: [], unplanned: { fees: 0, cost: 0, tokens: 0, turns: 0, models: [] } }
  )

  ipcMain.handle('litellm:get-model-settings', (_e, providerId) => db?.listModelSettings(providerId) ?? [])
  ipcMain.handle('litellm:save-model-setting', (_e, payload) => {
    if (!db) return
    db.saveModelSetting(payload)
    if (store?.reapplyPoller('litellm:' + payload.providerId)) broadcastSnapshot()
  })

  refreshLitellmPollers() // populate store.pollers before the initial scan/poll
  await store.start()
  ingestNow() // first full ingest after the initial scan
  if (process.env.AIMON_AUTO_REPORT) openReport() // dev/test convenience
  if ('AIMON_SET_AUTOLAUNCH' in process.env) setAutoLaunch(process.env.AIMON_SET_AUTOLAUNCH === '1') // headless toggle
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
    if (reportWin && !reportWin.isDestroyed()) reportWin.webContents.send('report-updated')
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
      })
    )
  )
}

// Pushes a fresh snapshot to the popup + tray + ingest, outside the normal
// store 'update' event (used after Settings changes that don't go through a
// file-watch/poll-timer trigger).
function broadcastSnapshot() {
  if (!store) return
  const s = store.snapshot()
  lastSnapshot = s
  if (win && !win.isDestroyed()) win.webContents.send('snapshot', s)
  updateTray(s)
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

// Screenshot a window as PNG, then either save it to disk or copy it to the
// clipboard. `fullHeight` grows the window to fit its whole page first (used
// by the report, whose content extends past the viewport); the tray popup is
// captured as-is since its overflow lives in an inner scroll region.
async function exportPng({ which = 'report', mode = 'save' } = {}) {
  const targetWin = which === 'popup' ? win : reportWin
  if (!targetWin || targetWin.isDestroyed()) return { ok: false }
  const isPopup = which === 'popup'
  let restore = null
  try {
    if (!isPopup) {
      // Grow the window to fit its full content so the screenshot isn't clipped.
      // The .report container scrolls internally (body is overflow:hidden), so
      // its scrollHeight — not body's — carries the true content height.
      const h = await targetWin.webContents.executeJavaScript(
        "Math.max(document.body.scrollHeight, document.querySelector('.report')?.scrollHeight ?? 0)"
      )
      const bounds = targetWin.getBounds()
      const display = screen.getDisplayMatching(bounds)
      const target = Math.min(Math.ceil(h) + 8, display.workArea.height)
      if (target > bounds.height) {
        restore = bounds
        targetWin.setBounds({ ...bounds, height: target })
        await new Promise((r) => setTimeout(r, 250))
      }
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
    if (isPopup) popupExporting = true
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(targetWin, {
        title: 'Export screenshot as PNG',
        defaultPath,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      })
      if (canceled || !filePath) return { ok: false }
      fs.writeFileSync(filePath, img.toPNG())
      shell.showItemInFolder(filePath)
      return { ok: true, filePath }
    } finally {
      if (isPopup) popupExporting = false
    }
  } catch (e) {
    console.error('export png failed:', e)
    return { ok: false, error: String(e) }
  } finally {
    if (restore) targetWin.setBounds(restore)
  }
}

function createTray() {
  tray = new Tray(makeTrayIcon({ color: [217, 119, 87] }))
  tray.setToolTip('TokenStats')
  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open TokenStats', click: () => showWindow() },
      { label: 'Token report…', click: () => openReport() },
      { label: 'Settings…', click: () => openSettings() },
      { type: 'separator' },
      { label: 'Refresh now', click: async () => { await store.scanAll(); await Promise.all(store.pollers.map((p) => store.forcePoll(p.cli))); broadcastSnapshot() } },
      { label: 'Edit data sources… (other devices)', click: () => { ensureConfigFile(); shell.openPath(CONFIG_FILE) } },
      { type: 'separator' },
      { label: 'Start at login', type: 'checkbox', checked: isAutoLaunch(), click: (item) => setAutoLaunch(item.checked) },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit() } },
    ])
    tray.popUpContextMenu(menu)
  })
}

function isAutoLaunch() {
  return app.getLoginItemSettings().openAtLogin
}

// Toggle "start with Windows" — writes/removes an HKCU\...\Run registry entry.
function setAutoLaunch(enabled) {
  const opts = { openAtLogin: enabled }
  if (!app.isPackaged) {
    // Dev: point the login item at electron + this project so it launches the app.
    opts.path = process.execPath
    opts.args = [path.resolve(process.argv[1] || '.')]
  }
  app.setLoginItemSettings(opts)
}

function updateTray(snap) {
  if (!tray) return
  const today = snap?.totals?.today?.total || 0
  tray.setToolTip(`TokenStats v${app.getVersion()} — today ${compact(today)} tokens`)
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
