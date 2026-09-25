[CmdletBinding()]
param(
    [string]$CodexHome
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRules = Join-Path $repositoryRoot 'AGENTS.md.sample'
if (-not (Test-Path -LiteralPath $sourceRules)) {
    throw "Rules source was not found: $sourceRules"
}

if (-not $CodexHome) {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
}

$target = Join-Path $CodexHome 'AGENTS.md'
$startMarker = '<!-- backlog-hub-rules:start -->'
$endMarker = '<!-- backlog-hub-rules:end -->'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$rules = [System.IO.File]::ReadAllText($sourceRules).TrimEnd()
$managedBlock = "$startMarker$([Environment]::NewLine)$rules$([Environment]::NewLine)$endMarker$([Environment]::NewLine)"

function Backup-Target {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        $backup = "$Path.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
        Copy-Item -LiteralPath $Path -Destination $backup -Force
        Write-Host "Backup created: $backup"
    }
}

New-Item -ItemType Directory -Path $CodexHome -Force | Out-Null
$existing = if (Test-Path -LiteralPath $target) { [System.IO.File]::ReadAllText($target) } else { '' }
$markerPattern = '(?s)<!-- backlog-hub-rules:start -->.*?<!-- backlog-hub-rules:end -->'

if ([regex]::Matches($existing, [regex]::Escape($startMarker)).Count -gt 0 -or [regex]::Matches($existing, [regex]::Escape($endMarker)).Count -gt 0) {
    if ([regex]::Matches($existing, [regex]::Escape($startMarker)).Count -ne 1 -or [regex]::Matches($existing, [regex]::Escape($endMarker)).Count -ne 1) {
        throw 'Codex managed-block markers are incomplete or duplicated. No files were changed.'
    }
    $updated = [regex]::Replace($existing, $markerPattern, $managedBlock.TrimEnd(), 1)
} elseif ([string]::IsNullOrWhiteSpace($existing)) {
    $updated = $managedBlock
} else {
    $legacyMatches = [regex]::Matches($existing, '(?m)^# .*backlog-dashboard .*Codex.*$')
    if ($legacyMatches.Count -ne 1) {
        throw 'A single legacy backlog-rules heading was not found. No files were changed.'
    }
    $prefix = $existing.Substring(0, $legacyMatches[0].Index).TrimEnd()
    $updated = if ($prefix) { "$prefix$([Environment]::NewLine)$([Environment]::NewLine)$managedBlock" } else { $managedBlock }
}

Backup-Target -Path $target
[System.IO.File]::WriteAllText($target, $updated, $utf8NoBom)
Write-Host "Installed: $target"
