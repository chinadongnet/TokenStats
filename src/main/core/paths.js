import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const home = os.homedir()

export const CONFIG_DIR = path.join(home, '.tokenstatus')
const LEGACY_CONFIG_DIR = path.join(home, '.aimonitor') // pre-rename location
// AIMON_CONFIG lets tests / portable installs point at a different config file.
export const CONFIG_FILE = process.env.AIMON_CONFIG || path.join(CONFIG_DIR, 'config.json')

// One-time migration from the old ~/.aimonitor folder so existing config
// (extra device roots) and the usage DB carry over after the rename.
function migrateLegacyDir() {
  try {
    if (fs.existsSync(CONFIG_DIR) || !fs.existsSync(LEGACY_CONFIG_DIR)) return
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    for (const name of ['config.json', 'usage.sqlite']) {
      const from = path.join(LEGACY_CONFIG_DIR, name)
      const to = path.join(CONFIG_DIR, name)
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to)
    }
  } catch {
    // best-effort; a fresh config will be created if this fails
  }
}
migrateLegacyDir()

// Cursor's globalStorage dir (holds state.vscdb) lives at a different path per
// OS, unlike the other CLIs' dotfile-style homedir folders.
const CURSOR_STORAGE_DIR =
  process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
    : process.platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage')
      : path.join(home, '.config', 'Cursor', 'User', 'globalStorage')

// Primary (local) data dirs for each CLI; overridable via env for testing.
const PRIMARY = {
  claude: process.env.AIMON_CLAUDE_ROOT || path.join(home, '.claude', 'projects'),
  codex: process.env.AIMON_CODEX_ROOT || path.join(home, '.codex', 'sessions'),
  gemini: process.env.AIMON_GEMINI_ROOT || path.join(home, '.gemini', 'tmp'),
  agy: process.env.AIMON_AGY_ROOT || path.join(home, '.gemini', 'antigravity-cli', 'conversations'),
  cursor: process.env.AIMON_CURSOR_ROOT || CURSOR_STORAGE_DIR,
}

// Extra roots come from config.extraRoots — typically the same CLI folders
// copied here from OTHER devices, so their usage gets merged into the totals.
function loadExtraRoots() {
  const empty = { claude: [], codex: [], gemini: [], agy: [], cursor: [] }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const e = cfg.extraRoots || {}
    const norm = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [])
    return {
      claude: norm(e.claude),
      codex: norm(e.codex),
      gemini: norm(e.gemini),
      agy: norm(e.agy),
      cursor: norm(e.cursor),
    }
  } catch {
    return empty
  }
}

const extra = loadExtraRoots()

// LiteLLM is a self-hosted proxy with no local footprint at all — usage lives
// only in its admin API — so unlike every other CLI it has no roots/files,
// just a base URL + admin key. As of the multi-provider Settings feature,
// LiteLLM providers are stored in the usage.sqlite DB instead (see db.js's
// litellm_providers table), not config.json. This single-provider config.json
// reader is kept ONLY so migrateLitellm.js can do a one-time import of a
// pre-existing config into the DB on first run after upgrading.
function loadLitellmConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const l = cfg.litellm || {}
    const baseUrl = typeof l.baseUrl === 'string' ? l.baseUrl.trim().replace(/\/+$/, '') : ''
    const apiKey = typeof l.apiKey === 'string' ? l.apiKey.trim() : ''
    return baseUrl && apiKey ? { baseUrl, apiKey } : null
  } catch {
    return null
  }
}

export const LITELLM_CONFIG = loadLitellmConfig()

// Default color for the LiteLLM Settings UI's "add provider" form and for the
// one-time config.json migration — the single canonical source other than the
// (necessarily duplicated) literal copies in App.jsx/Report.jsx/Settings.jsx.
export const LITELLM_DEFAULT_COLOR = '#f59e0b'

// All roots to scan per CLI: local first, then extra dirs from other devices.
export const CLI_ROOTS = {
  claude: [PRIMARY.claude, ...extra.claude],
  codex: [PRIMARY.codex, ...extra.codex],
  gemini: [PRIMARY.gemini, ...extra.gemini],
  agy: [PRIMARY.agy, ...extra.agy],
  cursor: [PRIMARY.cursor, ...extra.cursor],
}

// The 5 fixed, hardcoded CLIs. LiteLLM providers are NOT listed here — they're
// dynamic, DB-backed pseudo-CLIs (`litellm:<providerId>`) built at runtime by
// store.js from the Settings UI's provider rows, so N of them can exist
// alongside these 5 without any code change per provider.
export const CLI_META = {
  claude: { label: 'Claude Code', color: '#d97757', root: PRIMARY.claude },
  codex: { label: 'Codex', color: '#10a37f', root: PRIMARY.codex },
  gemini: { label: 'Gemini', color: '#4285f4', root: PRIMARY.gemini },
  agy: { label: 'Antigravity', color: '#a142f4', root: PRIMARY.agy },
  cursor: { label: 'Cursor', color: '#6366f1', root: PRIMARY.cursor },
}

export const CLIS = Object.keys(CLI_META)

// Number of extra (other-device) roots configured, for display.
export const EXTRA_ROOT_COUNT =
  extra.claude.length + extra.codex.length + extra.gemini.length + extra.agy.length + extra.cursor.length

// Create a commented template on first run so users know what to edit.
export function ensureConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return CONFIG_FILE
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    const template = {
      _comment:
        'Merge usage from OTHER devices: copy that device\'s CLI data folder here, ' +
        'then list the path under the matching CLI below. Restart TokenStatus after editing.',
      _examples: {
        codex: 'D:/from-laptop/.codex/sessions',
        gemini: 'D:/from-laptop/.gemini/tmp',
        claude: 'D:/from-laptop/.claude/projects',
        agy: 'D:/from-laptop/.gemini/antigravity-cli/conversations',
        cursor: 'D:/from-laptop/AppData/Roaming/Cursor/User/globalStorage',
      },
      extraRoots: { claude: [], codex: [], gemini: [], agy: [], cursor: [] },
      _litellmComment:
        'Optional: track usage from a self-hosted LiteLLM proxy via its admin API. ' +
        'Leave apiKey empty to disable. apiKey is an admin/management key, not a per-user key.',
      litellm: { baseUrl: '', apiKey: '' },
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(template, null, 2))
  } catch {
    // best-effort; ignore if the dir isn't writable
  }
  return CONFIG_FILE
}
