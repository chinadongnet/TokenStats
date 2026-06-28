# Refresh the GitHub profile token-usage card and push it.
#
#   pwsh scripts/publish-card.ps1
#
# Regenerates the SVG from the current local snapshot into the profile repo
# clone, then commits & pushes if anything changed. TOKENS ONLY — no costs.
#
# Profile repo clone location (override with $env:TOKENSTATS_PROFILE_DIR):
$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSScriptRoot
$ProfileDir = if ($env:TOKENSTATS_PROFILE_DIR) { $env:TOKENSTATS_PROFILE_DIR } else { 'D:\aiAgent\claude\tokenstats-profile' }

if (-not (Test-Path (Join-Path $ProfileDir '.git'))) {
  Write-Error "Profile repo clone not found at '$ProfileDir'. Clone it first: git clone https://github.com/chinadongnet/chinadongnet.git '$ProfileDir'  (or set `$env:TOKENSTATS_PROFILE_DIR)"
}

$svgOut = Join-Path $ProfileDir 'assets\tokenstats-card.svg'
Write-Host "Generating card -> $svgOut"
& node (Join-Path $ProjectDir 'scripts\profile-card.mjs') $svgOut
if ($LASTEXITCODE -ne 0) { Write-Error 'card generation failed' }

Push-Location $ProfileDir
try {
  git add assets/tokenstats-card.svg | Out-Null
  $changed = git status --porcelain
  if (-not $changed) {
    Write-Host 'No change since last publish — nothing to push.'
    return
  }
  $stamp = Get-Date -Format 'yyyy-MM-dd'
  git commit -m "Refresh token usage card ($stamp)" | Out-Null
  git push origin main
  Write-Host "Pushed. Live at https://github.com/chinadongnet"
} finally {
  Pop-Location
}
