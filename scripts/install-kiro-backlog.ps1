[CmdletBinding()]
param(
    [switch]$SkipSkill
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceSteering = Join-Path $repositoryRoot '.kiro\skills\install-backlog-hub\assets\backlog-hub-rules.md'
$sourceSkill = Join-Path $repositoryRoot '.kiro\skills\install-backlog-hub'
$kiroHome = if ($env:KIRO_HOME) { $env:KIRO_HOME } else { Join-Path $env:USERPROFILE '.kiro' }
$targetSteering = Join-Path $kiroHome 'steering\backlog-hub-rules.md'
$targetSkill = Join-Path $kiroHome 'skills\install-backlog-hub'
$legacyTargetSkill = Join-Path $kiroHome 'skills\backlog-dashboard'

# BM-141: No timestamped .bak is made here. The deployed files are copies of files tracked in git,
# and a .bak folder under ~/.kiro/skills holds a SKILL.md whose name does not match its folder,
# which Kiro lists as one more "install-backlog-hub" skill on every sync.
function Copy-FileToTarget {
    param([string]$Source, [string]$Destination)

    $targetDirectory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    Write-Host "Installed: $Destination"
}

if (-not (Test-Path -LiteralPath $sourceSteering)) {
    throw "Steering source was not found: $sourceSteering"
}

Copy-FileToTarget -Source $sourceSteering -Destination $targetSteering

if (-not $SkipSkill) {
    if (-not (Test-Path -LiteralPath $sourceSkill)) {
        throw "Skill source was not found: $sourceSkill"
    }
    if (Test-Path -LiteralPath $legacyTargetSkill) {
        # The old skill folder must not stay under skills\ : Kiro scans every folder there and would list it twice.
        # Move it (one time only) to a folder that Kiro does not scan.
        $legacyArchiveRoot = Join-Path $kiroHome 'backups\backlog-hub'
        New-Item -ItemType Directory -Path $legacyArchiveRoot -Force | Out-Null
        $legacyArchive = Join-Path $legacyArchiveRoot "legacy-backlog-dashboard-$(Get-Date -Format 'yyyyMMddHHmmss')"
        Move-Item -LiteralPath $legacyTargetSkill -Destination $legacyArchive
        Write-Host "Legacy skill moved out of the skills folder: $legacyArchive"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetSkill) -Force | Out-Null
    Copy-Item -LiteralPath $sourceSkill -Destination (Split-Path -Parent $targetSkill) -Recurse -Force
    Write-Host "Installed: $targetSkill"
}
