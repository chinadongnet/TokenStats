# TokenStatus release pipeline.
#   npm run release            -> build, package, reinstall, relaunch
#   npm run release -NoInstall -> just build the dated installer into dist/
#
# Each run stamps the build with a date-time so you can confirm in the app
# (tray tooltip / popup footer / report footer) that the latest is running.

param([switch]$NoInstall)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$ts = Get-Date -Format 'yyyyMMdd-HHmm'
$builtAt = (Get-Date).ToString('yyyy-MM-dd HH:mm')
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$baseVer = ($pkg.version -replace '[-+].*$', '')   # strip any prior build suffix
Write-Host "=== TokenStatus release v$baseVer  build $ts ===" -ForegroundColor Cyan

# Make the build time visible inside the app (renderer/main read __BUILD_TIME__).
$env:BUILD_TIME = $builtAt

# 1) bundle + 2) package the NSIS installer
npm run build
npx electron-builder --win

# 3) give the installer a dated, easy-to-identify name (+ a stable "latest")
$setup = Get-ChildItem dist -Filter '*Setup*.exe' -ErrorAction Stop |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$dated = "TokenStatus-Setup-$baseVer-$ts.exe"
Copy-Item $setup.FullName (Join-Path 'dist' $dated) -Force
Copy-Item $setup.FullName (Join-Path 'dist' 'TokenStatus-Setup-latest.exe') -Force
Write-Host "Installer: dist\$dated" -ForegroundColor Green

if ($NoInstall) { Write-Host 'Skipped install (-NoInstall).' -ForegroundColor Yellow; return }

# 4) stop the running app, 5) silent-install over the old one, 6) relaunch
Get-Process TokenStatus -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Write-Host 'Installing (silent)…' -ForegroundColor Cyan
Start-Process -FilePath (Join-Path $root "dist\$dated") -ArgumentList '/S' -Wait

$installed = Join-Path $env:LOCALAPPDATA 'Programs\TokenStatus\TokenStatus.exe'
if (Test-Path $installed) {
  Start-Process $installed
  Write-Host "Launched: $installed" -ForegroundColor Green
} else {
  Write-Host "Installed exe not found at $installed — open it from the Start menu." -ForegroundColor Yellow
}
Write-Host "Done. App now running v$baseVer (build $builtAt)." -ForegroundColor Green
