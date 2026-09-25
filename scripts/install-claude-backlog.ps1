[CmdletBinding()]
param(
    [string]$ClaudeHome
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRules = Join-Path $repositoryRoot 'AGENTS.md.sample'
if (-not (Test-Path -LiteralPath $sourceRules)) {
    throw "Rules source was not found: $sourceRules"
}

if (-not $ClaudeHome) {
    $ClaudeHome = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $env:USERPROFILE '.claude' }
}

$targetRules = Join-Path $ClaudeHome 'steering\backlog-hub-rules.md'
$claudeConfig = Join-Path $ClaudeHome 'CLAUDE.md'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Backup-ThenCopyFile {
    param([string]$Source, [string]$Destination)

    $targetDirectory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $Destination) {
        $backup = "$Destination.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
        Copy-Item -LiteralPath $Destination -Destination $backup -Force
        Write-Host "Backup created: $backup"
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    Write-Host "Installed: $Destination"
}

Backup-ThenCopyFile -Source $sourceRules -Destination $targetRules

$importLine = '@steering/backlog-hub-rules.md'
$configDirectory = Split-Path -Parent $claudeConfig
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
$existing = if (Test-Path -LiteralPath $claudeConfig) {
    [System.IO.File]::ReadAllText($claudeConfig)
} else {
    ''
}

if ($existing -match '(?m)^\s*@steering/backlog-hub-rules\.md\s*$') {
    Write-Host "Already configured: $claudeConfig"
    exit 0
}

if (Test-Path -LiteralPath $claudeConfig) {
    $backup = "$claudeConfig.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item -LiteralPath $claudeConfig -Destination $backup -Force
    Write-Host "Backup created: $backup"
}

$separator = if ([string]::IsNullOrWhiteSpace($existing)) { '' } else { [Environment]::NewLine }
[System.IO.File]::WriteAllText($claudeConfig, "$existing$separator$importLine$([Environment]::NewLine)", $utf8NoBom)
Write-Host "Configured: $claudeConfig"
