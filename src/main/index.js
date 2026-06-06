import { app, BrowserWindow, Tray, Menu, ipcMain, shell, screen, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Store } from './core/store.js'
import { UsageDb } from './core/db.js'
import { CLI_META, ensureConfigFile, CONFIG_FILE } from './core/paths.js'
import { makeTrayIcon } from './trayIcon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let tray = null
let win = null
let reportWin = null
let store = null
let db = null
let lastSnapshot = null
let lastIngest = 0
let ingestTimer = null

// Single instance — a tray app should never run twice.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(init)
}

async function init() {
  app.setAppUserModelId('com.tokenstatus.app')
  ensureConfigFile() // create ~/.tokenstatus/config.json template on first run

  createWindow()
  createTray()

  // Open the hourly-usage SQLite database (best-effort; app still works without).
  try {
    db = await new UsageDb().open()
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
    const meta = CLI_META[cli]
    if (meta) shell.openPath(meta.root)
  })
  ipcMain.on('hide-window', () => win && win.hide())
  ipcMain.on('quit-app', () => { app.isQuitting = true; app.quit() })
  ipcMain.on('open-report', () => openReport())

  // Report data queries (served from the SQLite hourly table).
  ipcMain.handle('report:hourly', (_e, dayStartMs) => db?.hourly(dayStartMs) ?? [])
  ipcMain.handle('report:daily', (_e, fromMs, toMs) => db?.daily(fromMs, toMs) ?? [])
  ipcMain.handle('report:models', (_e, fromMs, toMs) => db?.models(fromMs, toMs) ?? [])
  ipcMain.handle('report:span', () => db?.span() ?? { min: null, max: null })
  ipcMain.handle('export-png', () => exportReportPng())

  await store.start()
  ingestNow() // first full ingest after the initial scan
  if (process.env.AIMON_AUTO_REPORT) openReport() // dev/test convenience
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
    db.ingest(store.allRecords())
    if (reportWin && !reportWin.isDestroyed()) reportWin.webContents.send('report-updated')
  } catch (e) {
    console.error('ingest failed:', e)
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 600,
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
    title: 'TokenStatus — Usage Report',
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

async function exportReportPng() {
  if (!reportWin || reportWin.isDestroyed()) return { ok: false }
  // Grow the window to fit its full content so the screenshot isn't clipped.
  let restore = null
  try {
    const h = await reportWin.webContents.executeJavaScript('document.body.scrollHeight')
    const bounds = reportWin.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const target = Math.min(Math.ceil(h) + 8, display.workArea.height)
    if (target > bounds.height) {
      restore = bounds
      reportWin.setBounds({ ...bounds, height: target })
      await new Promise((r) => setTimeout(r, 250))
    }
    const img = await reportWin.webContents.capturePage()
    const defaultPath = path.join(
      app.getPath('pictures'),
      `tokenstatus-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
    )
    const { canceled, filePath } = await dialog.showSaveDialog(reportWin, {
      title: 'Export report as PNG',
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
    if (restore) reportWin.setBounds(restore)
  }
}

function createTray() {
  tray = new Tray(makeTrayIcon({ color: [217, 119, 87] }))
  tray.setToolTip('TokenStatus')
  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open TokenStatus', click: () => showWindow() },
      { label: 'Usage report…', click: () => openReport() },
      { type: 'separator' },
      { label: 'Refresh now', click: async () => { await store.scanAll(); const s = store.snapshot(); lastSnapshot = s; win?.webContents.send('snapshot', s); updateTray(s); ingestNow() } },
      { label: 'Edit data sources… (other devices)', click: () => { ensureConfigFile(); shell.openPath(CONFIG_FILE) } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit() } },
    ])
    tray.popUpContextMenu(menu)
  })
}

function updateTray(snap) {
  if (!tray) return
  const today = snap?.totals?.today?.total || 0
  tray.setToolTip(`TokenStatus — today ${compact(today)} tokens`)
  // Recolour by the most recently active CLI.
  const cli = snap?.live?.cli
  const meta = cli && CLI_META[cli]
  if (meta) tray.setImage(makeTrayIcon({ color: hexToRgb(meta.color) }))
}

function toggleWindow() {
  if (win.isVisible()) win.hide()
  else showWindow()
}

function showWindow() {
  positionWindow()
  win.show()
  win.focus()
}

// Anchor the popup to the tray / bottom-right work area.
function positionWindow() {
  const tb = tray.getBounds()
  const display = screen.getDisplayMatching(tb)
  const area = display.workArea
  const [w, h] = win.getSize()
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
