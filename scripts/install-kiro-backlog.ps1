[CmdletBinding()]
param(
    [switch]$SkipSkill
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceSteering = Join-Path $repositoryRoot '.kiro\steering\backlog-hub-rules.md'
$sourceSkill = Join-Path $repositoryRoot '.kiro\skills\install-backlog-hub'
$kiroHome = if ($env:KIRO_HOME) { $env:KIRO_HOME } else { Join-Path $env:USERPROFILE '.kiro' }
$targetSteering = Join-Path $kiroHome 'steering\backlog-hub-rules.md'
$targetSkill = Join-Path $kiroHome 'skills\install-backlog-hub'
$legacyTargetSkill = Join-Path $kiroHome 'skills\backlog-dashboard'

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

if (-not (Test-Path -LiteralPath $sourceSteering)) {
    throw "Steering source was not found: $sourceSteering"
}

Backup-ThenCopyFile -Source $sourceSteering -Destination $targetSteering

if (-not $SkipSkill) {
    if (-not (Test-Path -LiteralPath $sourceSkill)) {
        throw "Skill source was not found: $sourceSkill"
    }
    if (Test-Path -LiteralPath $targetSkill) {
        $backup = "$targetSkill.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
        Copy-Item -LiteralPath $targetSkill -Destination $backup -Recurse -Force
        Write-Host "Backup created: $backup"
    }
    if (Test-Path -LiteralPath $legacyTargetSkill) {
        $legacyBackup = "$legacyTargetSkill.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
        Move-Item -LiteralPath $legacyTargetSkill -Destination $legacyBackup
        Write-Host "Legacy skill backed up: $legacyBackup"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetSkill) -Force | Out-Null
    Copy-Item -LiteralPath $sourceSkill -Destination (Split-Path -Parent $targetSkill) -Recurse -Force
    Write-Host "Installed: $targetSkill"
}
