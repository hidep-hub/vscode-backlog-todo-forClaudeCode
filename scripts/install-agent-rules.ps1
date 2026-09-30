[CmdletBinding()]
param(
    [switch]$Claude,
    [switch]$Codex,
    [switch]$Kiro,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

# If no agent is specified, update every supported agent on this computer.
if (-not ($Claude -or $Codex -or $Kiro)) {
    $Claude = $true
    $Codex = $true
    $Kiro = $true
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRules = Join-Path $repositoryRoot 'AGENTS.md.sample'

function Test-FileMatches {
    param([string]$Source, [string]$Target)
    return (Test-Path -LiteralPath $Target) -and
        ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash)
}

function Sync-RuleDistribution {
    if (-not (Test-Path -LiteralPath $sourceRules)) {
        throw "Canonical rules source was not found: $sourceRules"
    }

    $targets = @(
        (Join-Path $repositoryRoot '.claude\skills\install-backlog-hub\assets\backlog-hub-rules.md'),
        (Join-Path $repositoryRoot '.kiro\steering\backlog-hub-rules.md')
    )
    foreach ($target in $targets) {
        if (Test-FileMatches -Source $sourceRules -Target $target) {
            Write-Host "Rule distribution is current: $target"
            continue
        }
        if ($Check) {
            Write-Host "Rule distribution needs synchronization: $target"
            $script:needsSynchronization = $true
            continue
        }
        Copy-Item -LiteralPath $sourceRules -Destination $target -Force
        if ((Get-FileHash -LiteralPath $sourceRules -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) {
            throw "Rule distribution verification failed: $target"
        }
        Write-Host "Synchronized rule distribution: $target"
    }
}

Sync-RuleDistribution

function Install-AgentRules {
    param(
        [string]$Name,
        [string]$ScriptName
    )

    $scriptPath = Join-Path $repositoryRoot "scripts\\$ScriptName"
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "$Name installer was not found: $scriptPath"
    }
    Write-Host "Synchronizing $Name rules..."
    & $scriptPath
    if ($LASTEXITCODE -ne 0) {
        throw "$Name rule synchronization failed with exit code $LASTEXITCODE."
    }
}

function Test-AgentRulesCurrent {
    param([ValidateSet('Claude Code', 'Codex', 'Kiro')][string]$Name)

    if ($Name -eq 'Claude Code') {
        $agentHome = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $env:USERPROFILE '.claude' }
        $target = Join-Path $agentHome 'steering\backlog-hub-rules.md'
        return Test-FileMatches -Source $sourceRules -Target $target
    }
    if ($Name -eq 'Kiro') {
        $agentHome = if ($env:KIRO_HOME) { $env:KIRO_HOME } else { Join-Path $env:USERPROFILE '.kiro' }
        $target = Join-Path $agentHome 'steering\backlog-hub-rules.md'
        return Test-FileMatches -Source $sourceRules -Target $target
    }

    $agentHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $target = Join-Path $agentHome 'AGENTS.md'
    if (-not (Test-Path -LiteralPath $target)) { return $false }
    $content = [System.IO.File]::ReadAllText($target)
    $match = [regex]::Match($content, '(?s)<!-- backlog-hub-rules:start -->\s*(.*?)\s*<!-- backlog-hub-rules:end -->')
    return $match.Success -and ($match.Groups[1].Value.TrimEnd() -eq [System.IO.File]::ReadAllText($sourceRules).TrimEnd())
}

function Sync-AgentRules {
    param([string]$Name, [string]$ScriptName)
    if (Test-AgentRulesCurrent -Name $Name) {
        Write-Host "$Name rules are current."
    } elseif ($Check) {
        Write-Host "$Name rules need synchronization."
        $script:needsSynchronization = $true
    } else {
        Install-AgentRules -Name $Name -ScriptName $ScriptName
    }
}

if ($Claude) { Sync-AgentRules -Name 'Claude Code' -ScriptName 'install-claude-backlog.ps1' }
if ($Codex) { Sync-AgentRules -Name 'Codex' -ScriptName 'install-codex-backlog.ps1' }
if ($Kiro) { Sync-AgentRules -Name 'Kiro' -ScriptName 'install-kiro-backlog.ps1' }

if ($Check) {
    Write-Host 'Agent rule check completed.'
    if ($needsSynchronization) { exit 1 }
    exit 0
}

Write-Host 'Agent rule synchronization completed.'
