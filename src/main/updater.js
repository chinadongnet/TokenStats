// GitHub-release updater — the ONE channel TokenStats ships through.
//
// `npm run release` builds the NSIS installer, tags the commit and publishes both
// to https://github.com/<REPO>/releases (see scripts/release.ps1). This module is
// the other half: Settings → App asks GitHub what the newest release is, compares
// it to the running version, downloads that release's installer and runs it
// silently over the current install.
//
// Deliberately hand-rolled instead of electron-updater: the NSIS build is
// unsigned and per-user, there is no latest.yml/staging feed to maintain, and the
// whole flow is three HTTPS calls. Nothing here imports `electron` (except the
// caller's app.quit(), which stays in index.js) so it can be exercised headlessly.
//
// The installer is one-click + `runAfterFinish`, so `/S` reinstalls over the old
// copy and relaunches the app by itself — the caller just has to quit first, or
// NSIS will fail to replace a locked TokenStats.exe.

import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

// Override for forks/testing; format is 'owner/repo'.
export const UPDATE_REPO = process.env.AIMON_UPDATE_REPO || 'chinadongnet/TokenStats'
export const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`
const API_LATEST = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
// GitHub rejects API requests without one.
const UA = 'TokenStats-Updater'

// ---- version compare --------------------------------------------------------

// Numeric, part-by-part; a trailing pre-release tag ('-beta.1') makes a version
// LOWER than the same numbers without one, so 0.3.0-rc1 never supersedes 0.3.0.
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = String(v || '0').replace(/^v/, '').split('-')
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1 // a release outranks its own pre-releases
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

// ---- http -------------------------------------------------------------------

// GitHub's API and its asset downloads both redirect (api → objects.github…), so
// every request here follows them.
function get(url, { headers = {}, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, ...headers } }, (res) => {
      const { statusCode, headers: h } = res
      if (statusCode >= 300 && statusCode < 400 && h.location) {
        res.resume()
        if (redirects <= 0) return reject(new Error('too many redirects'))
        return resolve(get(new URL(h.location, url).toString(), { headers, redirects: redirects - 1 }))
      }
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')))
  })
}

function getJson(url) {
  return get(url, { headers: { Accept: 'application/vnd.github+json' } }).then(
    (res) =>
      new Promise((resolve, reject) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          if (res.statusCode === 404) return reject(new Error('no published release yet'))
          if (res.statusCode !== 200) {
            // 403 here is almost always the unauthenticated 60/hour rate limit.
            return reject(new Error(`GitHub returned ${res.statusCode}`))
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('malformed response from GitHub'))
          }
        })
        res.on('error', reject)
      }),
  )
}

// ---- check ------------------------------------------------------------------

// The installer asset to download. release.ps1 uploads a dated
// `TokenStats-Setup-<ver>-<stamp>.exe`; prefer one carrying this release's
// version, then any Setup .exe, then any .exe at all.
function pickAsset(assets, version) {
  const exes = (assets || []).filter((a) => /\.exe$/i.test(a.name || ''))
  const v = String(version || '').replace(/^v/, '')
  return (
    exes.find((a) => v && a.name.includes(v) && /setup/i.test(a.name)) ||
    exes.find((a) => /setup/i.test(a.name)) ||
    exes[0] ||
    null
  )
}

// { hasUpdate, current, latest, name, notes, publishedAt, htmlUrl, asset } — or
// { error } when GitHub couldn't be reached. Never throws: the Settings UI shows
// the message inline rather than the window blowing up on a flaky network.
export async function checkForUpdate(currentVersion) {
  try {
    const rel = await getJson(API_LATEST)
    const latest = String(rel.tag_name || rel.name || '').replace(/^v/, '')
    if (!latest) return { error: 'release has no version tag', current: currentVersion }
    const asset = pickAsset(rel.assets, latest)
    return {
      current: currentVersion,
      latest,
      hasUpdate: compareVersions(latest, currentVersion) > 0,
      name: rel.name || `v${latest}`,
      notes: rel.body || '',
      publishedAt: rel.published_at || null,
      htmlUrl: rel.html_url || RELEASES_URL,
      // No .exe attached (source-only release): the UI falls back to "open the
      // release page" instead of offering a one-click install.
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    }
  } catch (e) {
    return { error: e.message || String(e), current: currentVersion, htmlUrl: RELEASES_URL }
  }
}

// ---- download ---------------------------------------------------------------

const downloadDir = () => path.join(os.tmpdir(), 'tokenstats-update')

// Downloads `asset` to a temp dir, calling onProgress({received, total, pct}).
// Returns the local path. A partial file is removed so a retry can't run a
// truncated installer.
export async function downloadUpdate(asset, onProgress) {
  if (!asset || !asset.url) throw new Error('this release has no installer attached')
  const dir = downloadDir()
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, path.basename(asset.name))
  const tmp = `${dest}.part`

  const res = await get(asset.url)
  if (res.statusCode !== 200) {
    res.resume()
    throw new Error(`download failed (HTTP ${res.statusCode})`)
  }
  const total = Number(res.headers['content-length']) || asset.size || 0

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp)
    let received = 0
    let lastPct = -1
    res.on('data', (chunk) => {
      received += chunk.length
      const pct = total ? Math.floor((received / total) * 100) : 0
      // Throttled to whole percents — an 85 MB installer is ~1400 chunks.
      if (onProgress && pct !== lastPct) {
        lastPct = pct
        onProgress({ received, total, pct })
      }
    })
    res.on('error', reject)
    out.on('error', reject)
    out.on('finish', resolve)
    res.pipe(out)
  }).catch((e) => {
    try { fs.rmSync(tmp, { force: true }) } catch {}
    throw e
  })

  fs.rmSync(dest, { force: true })
  fs.renameSync(tmp, dest)
  return dest
}

// ---- install ----------------------------------------------------------------

// Runs the downloaded installer silently and detached, so it outlives the app it
// is about to overwrite. The CALLER must quit right after (NSIS can't replace a
// running TokenStats.exe); `runAfterFinish` brings the new version back up.
export function launchInstaller(file) {
  if (!file || !fs.existsSync(file)) throw new Error('installer file is missing')
  const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' })
  child.unref()
  return true
}
