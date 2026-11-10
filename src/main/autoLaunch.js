import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { loadAutoLaunch, saveAutoLaunch } from './core/paths.js'

// Lives outside core/ because it imports electron (see CLAUDE.md Architecture).

const APP_ID = 'com.tokenstats.app'
// Run value names written by pre-rename builds (4986930 TokenStatus -> TokenStats).
const LEGACY_RUN_NAMES = ['com.tokenstatus.app']

function installedWindowsExe() {
  if (process.platform !== 'win32') return null
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return null
  const candidate = path.join(localAppData, 'Programs', 'tokenstats', 'TokenStats.exe')
  return fs.existsSync(candidate) ? candidate : null
}

// The login item's identity. Packaged: the installed exe, no args. Dev: if the
// installed Windows exe exists on disk, target it so toggling in dev doesn't
// repoint autostart at electron.exe; otherwise fall back to electron + project path.
//
// get and set MUST agree on this. On Windows getLoginItemSettings matches an
// existing entry by path+args, while setLoginItemSettings writes/deletes by
// registry value name — so passing different path/args to the two makes the
// tray checkbox report a state the app never wrote.
function loginItemOpts() {
  const installed = installedWindowsExe()
  if (installed) {
    return { path: installed, args: [] }
  }
  if (app.isPackaged) {
    return { path: process.execPath, args: [] }
  }
  return { path: process.execPath, args: [path.resolve(process.argv[1] || '.')] }
}

export function isAutoLaunch() {
  return Boolean(app.getLoginItemSettings(loginItemOpts()).openAtLogin)
}

// Toggle "start with Windows" — writes/removes an HKCU\...\Run registry entry
// and persists the user's choice in ~/.tokenstats/config.json.
export function setAutoLaunch(enabled) {
  const on = Boolean(enabled)
  app.setLoginItemSettings({ ...loginItemOpts(), openAtLogin: on, name: APP_ID })
  const actual = isAutoLaunch()
  saveAutoLaunch(actual)
  return actual
}

// Reconcile the OS login item with ~/.tokenstats/config.json on startup.
// If the user has never configured autoLaunch (null in config.json), default to
// enabled when running the packaged app (or when the installed exe is present)
// so a tray monitor doesn't silently fail to start after a reboot.
export function ensureAutoLaunch() {
  if (!app.isPackaged && !installedWindowsExe()) return
  try {
    const saved = loadAutoLaunch()
    if (typeof saved === 'boolean') {
      app.setLoginItemSettings({ ...loginItemOpts(), openAtLogin: saved, name: APP_ID })
      return
    }
    if (isAutoLaunch()) {
      saveAutoLaunch(true)
      return
    }
    setAutoLaunch(true)
  } catch (e) {
    console.error('auto-launch init failed:', e)
  }
}

// One-time cleanup of the Run value left behind by the TokenStatus -> TokenStats
// rename. Pre-rename builds registered under the old AppUserModelId, and
// setLoginItemSettings deletes strictly by value name — so the stale value
// survived every toggle: "off" deleted a name that no longer existed (the app
// kept autostarting), "on" added a second value beside it.
export function migrateLegacyRunKeys() {
  if (process.platform !== 'win32') return
  // Dev's login item points at electron.exe + the project dir, so re-registering
  // from a dev run would repoint the user's autostart away from the installed app.
  if (!app.isPackaged) return
  try {
    const { launchItems = [] } = app.getLoginItemSettings(loginItemOpts())
    const stale = launchItems.filter((i) => i.scope === 'user' && LEGACY_RUN_NAMES.includes(i.name))
    if (!stale.length) return // presence-based: once cleaned, a no-op forever after
    const wasEnabled = stale.some((i) => i.enabled)
    for (const item of stale) app.setLoginItemSettings({ openAtLogin: false, name: item.name })
    // Value names are unique keys, so this upserts rather than duplicating.
    if (wasEnabled) setAutoLaunch(true)
  } catch (e) {
    console.error('run-key migration failed:', e) // never block startup over a migration
  }
}
