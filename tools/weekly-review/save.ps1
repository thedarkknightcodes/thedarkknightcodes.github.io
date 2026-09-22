# save.ps1 — Phase 7 (weekly review).
#
# Takes a review JSON file (just the review object: summary, wins,
# suggested, someday, drop, generated_by — see PROMPT.md for the exact
# shape) and posts it to the backend's `review_save` action, wrapped with
# week_start (this week's Monday) and source "claude". Prints whatever the
# server sends back — check it for {"ok":true,...}.
#
# Usage:
#   .\save.ps1 -ReviewFile "C:\path\to\some.review.json"
#
# Needs the same device key + config.js as export.ps1 — see that file's
# comment and README.md in this folder.
#
# PowerShell 5.1-compatible on purpose: no ??, no &&, no ternary.

param(
  [Parameter(Mandatory = $true)]
  [string]$ReviewFile
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ReviewFile)) {
  Write-Error "Review file not found: $ReviewFile"
  exit 1
}

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

$reviewObj = Get-Content -Raw $ReviewFile | ConvertFrom-Json

# Monday of THIS week — the same rule Code.gs's mondayOf_ uses (a local
# calendar date, ISO week starting Monday), just written in PowerShell.
$today = Get-Date
$dayOfWeek = [int]$today.DayOfWeek # 0 = Sunday ... 6 = Saturday
if ($dayOfWeek -eq 0) {
  $diffDays = -6
} else {
  $diffDays = 1 - $dayOfWeek
}
$weekStart = $today.Date.AddDays($diffDays).ToString("yyyy-MM-dd")

$bodyObj = @{
  token      = $deviceKey
  action     = "review_save"
  week_start = $weekStart
  source     = "claude"
  review     = $reviewObj
}
$body = $bodyObj | ConvertTo-Json -Depth 10 -Compress

$tempFile = [System.IO.Path]::GetTempFileName()
try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempFile, $body, $utf8NoBom)

  # Same -L, no -X POST rule as export.ps1 — see that file's comment.
  $response = & curl.exe -sL -H "Content-Type: text/plain" --data-binary "@$tempFile" $prodUrl
  Write-Output $response
} finally {
  Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
}
