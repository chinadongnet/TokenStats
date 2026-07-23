# TokenStats release pipeline. This is the ONLY way to build an installer.
#   npm run release                -> bump, build, package, publish to GitHub, reinstall, relaunch
#   npm run release -- -NoInstall  -> everything except the local reinstall
#   npm run release -- -NoBump     -> rebuild the current version (no bump/commit/tag/publish)
#   npm run release -- -NoPublish  -> keep it local (no push, no GitHub release)
#
# `npm run dev`/`npm run build` only refresh out/. The app Windows autostarts is
# the INSTALLED copy in %LOCALAPPDATA%\Programs\tokenstats, which only the NSIS
# installer replaces — this script is what closes that loop.
#
# The GitHub release is also the app's UPDATE CHANNEL: Settings → App reads
# /releases/latest and installs its .exe asset (src/main/updater.js). So a version
# that never gets published here is invisible to every other install — publish is
# on by default for exactly that reason.
#
# Each run stamps the build with a date-time so you can confirm in the app
# (tray tooltip / popup footer / report footer) that the latest is running.

param([switch]$NoInstall, [switch]$NoBump, [switch]$NoPublish)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# A dirty tree is how 0.2.0-0.2.6 shipped from uncommitted source: the installer
# and the git history disagreed, and nothing noticed. Refuse instead.
if (git status --porcelain) {
  throw 'Working tree is dirty — commit before releasing (git status).'
}

# Bump first: __APP_VERSION__ is baked from package.json at build time.
if (-not $NoBump) { npm version patch --no-git-tag-version | Out-Null }
$ver = (Get-Content package.json -Raw | ConvertFrom-Json).version

$ts = Get-Date -Format 'yyyyMMdd-HHmm'
$builtAt = (Get-Date).ToString('yyyy-MM-dd HH:mm')
Write-Host "=== TokenStats release v$ver  build $ts ===" -ForegroundColor Cyan

# Make the build time visible inside the app (renderer/main read __BUILD_TIME__).
$env:BUILD_TIME = $builtAt

# 1) bundle + 2) package the NSIS installer
npm run build
npx electron-builder --win

# 3) give the installer a dated, easy-to-identify name (+ a stable "latest")
$setup = Join-Path 'dist' "TokenStats Setup $ver.exe"
if (-not (Test-Path $setup)) { throw "electron-builder did not produce $setup" }
$dated = "TokenStats-Setup-$ver-$ts.exe"
Copy-Item $setup (Join-Path 'dist' $dated) -Force
Copy-Item $setup (Join-Path 'dist' 'TokenStats-Setup-latest.exe') -Force
Write-Host "Installer: dist\$dated" -ForegroundColor Green

# Keep dist/ from regrowing to a gigabyte of 85 MB installers.
Get-ChildItem dist -Filter 'TokenStats-Setup-*-*.exe' |
  Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force

# One tagged commit per installer, so a build always maps back to source.
if (-not $NoBump) {
  git commit -am "Release v$ver" | Out-Null
  git tag "v$ver"
  Write-Host "Tagged v$ver" -ForegroundColor Green
}

# 7) publish to GitHub — the channel the in-app updater checks. Requires the gh
# CLI (already authenticated); a failure here must not silently pass, or installs
# in the wild would keep reporting "up to date" against a stale release.
if (-not $NoBump -and -not $NoPublish) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'gh CLI not found — install it (winget install GitHub.cli) or rerun with -NoPublish.'
  }
  Write-Host 'Publishing GitHub release…' -ForegroundColor Cyan
  git push origin HEAD
  git push origin "v$ver"
  # Notes = the commits since the previous tag; the updater shows them verbatim.
  $prev = git describe --tags --abbrev=0 "v$ver^" 2>$null
  $log = if ($prev) { git log --pretty=format:'- %s' "$prev..v$ver" } else { git log --pretty=format:'- %s' -20 }
  $notes = "Built $builtAt`n`n$($log -join "`n")"
  gh release create "v$ver" (Join-Path 'dist' $dated) --title "TokenStats v$ver" --notes $notes
  if ($LASTEXITCODE -ne 0) { throw "gh release create failed for v$ver" }
  Write-Host "Published: https://github.com/chinadongnet/TokenStats/releases/tag/v$ver" -ForegroundColor Green
}

if ($NoInstall) { Write-Host 'Skipped install (-NoInstall).' -ForegroundColor Yellow; return }

# 4) stop the running app, 5) silent-install over the old one, 6) relaunch
Get-Process TokenStats -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Write-Host 'Installing (silent)…' -ForegroundColor Cyan
Start-Process -FilePath (Join-Path $root "dist\$dated") -ArgumentList '/S' -Wait

$installed = Join-Path $env:LOCALAPPDATA 'Programs\tokenstats\TokenStats.exe'
if (Test-Path $installed) {
  Start-Process $installed
  Write-Host "Launched: $installed" -ForegroundColor Green
} else {
  Write-Host "Installed exe not found at $installed — open it from the Start menu." -ForegroundColor Yellow
}
Write-Host "Done. App now running v$ver (build $builtAt)." -ForegroundColor Green
