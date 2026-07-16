import { app } from 'electron'
import path from 'node:path'

// Lives outside core/ because it imports electron (see CLAUDE.md Architecture).

const APP_ID = 'com.tokenstats.app'
// Run value names written by pre-rename builds (4986930 TokenStatus -> TokenStats).
const LEGACY_RUN_NAMES = ['com.tokenstatus.app']

// The login item's identity. Packaged: the installed exe, no args. Dev: electron
// plus this project path, so the entry actually launches the app.
//
// get and set MUST agree on this. On Windows getLoginItemSettings matches an
// existing entry by path+args, while setLoginItemSettings writes/deletes by
// registry value name — so passing different path/args to the two makes the
// tray checkbox report a state the app never wrote.
function loginItemOpts() {
  return app.isPackaged
    ? { path: process.execPath, args: [] }
    : { path: process.execPath, args: [path.resolve(process.argv[1] || '.')] }
}

export function isAutoLaunch() {
  return app.getLoginItemSettings(loginItemOpts()).openAtLogin
}

// Toggle "start with Windows" — writes/removes an HKCU\...\Run registry entry.
export function setAutoLaunch(enabled) {
  app.setLoginItemSettings({ ...loginItemOpts(), openAtLogin: enabled, name: APP_ID })
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
