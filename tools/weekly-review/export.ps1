# export.ps1 — Phase 7 (weekly review).
#
# Calls the Task Planner backend's `review_export` action — the same data
# an outside reviewer (Gemini, automatically, or Claude via this kit) needs
# to write this week's review: the open/recently-done tasks and the last
# 20 captures. Prints the raw JSON response to stdout and does nothing
# else — no file is written here, so this script is safe to run just to
# look at what would be sent.
#
# Needs:
#   - a device key saved at %USERPROFILE%\.task-planner\device_key.txt
#     (see README.md in this folder for how to create that file — it is
#     deliberately OUTSIDE the repo, so it can never end up in git)
#   - config.js in the repo root, read here only for its prodUrl
#
# PowerShell 5.1-compatible on purpose: no ??, no &&, no ternary — this
# runs from a plain scheduled task, not a dev machine's newer pwsh.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$keyPath = Join-Path $env:USERPROFILE ".task-planner\device_key.txt"
$configPath = Join-Path $repoRoot "config.js"

if (-not (Test-Path $keyPath)) {
  Write-Error "No device key found at $keyPath. See tools/weekly-review/README.md for how to create it."
  exit 1
}
if (-not (Test-Path $configPath)) {
  Write-Error "Can't find config.js at $configPath."
  exit 1
}

$deviceKey = (Get-Content -Raw $keyPath).Trim()
$configText = Get-Content -Raw $configPath
$urlMatch = [regex]::Match($configText, 'prodUrl:\s*"([^"]*)"')
if (-not $urlMatch.Success -or [string]::IsNullOrWhiteSpace($urlMatch.Groups[1].Value)) {
  Write-Error "Couldn't find a prodUrl in config.js."
  exit 1
}
$prodUrl = $urlMatch.Groups[1].Value

$bodyObj = @{ token = $deviceKey; action = "review_export" }
$body = $bodyObj | ConvertTo-Json -Compress

$tempFile = [System.IO.Path]::GetTempFileName()
try {
  # Write WITHOUT a BOM — Set-Content -Encoding utf8 adds one on Windows
  # PowerShell 5.1, and a leading BOM byte would break Code.gs's
  # JSON.parse(e.postData.contents) on the other end.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempFile, $body, $utf8NoBom)

  # -L follows the redirect an Apps Script /exec URL always issues.
  # Deliberately NOT -X POST: forcing POST onto that redirect returns 405
  # (the redirected URL doesn't accept a forced POST the way curl's own
  # default redirect handling does). --data-binary already implies POST,
  # so nothing here needs -X at all.
  $response = & curl.exe -sL -H "Content-Type: text/plain" --data-binary "@$tempFile" $prodUrl
  Write-Output $response
} finally {
  Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
}
