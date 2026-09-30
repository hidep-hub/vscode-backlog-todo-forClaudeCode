# backlog-dashboard を、登録済みのスタートアップタスク経由で安全に再起動する。
# VS Code のPowerShellターミナル、Windows Terminal のどちらから実行してもよい。
# 起動する node はタスクスケジューラから独立して実行されるため、実行元の端末は閉じてよい。

$ErrorActionPreference = 'Stop'

$TaskName = 'BacklogDashboardAutoStart'
$ServerDir = Split-Path -Parent $PSScriptRoot

# ポート番号はconfig.jsonのport値を使う(BM-011)。config.json未作成(clone直後)の場合はserver.jsと同じ3333にフォールバックする。
$ConfigPath = Join-Path $ServerDir 'config.json'
$Port = 3333
if (Test-Path -LiteralPath $ConfigPath) {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($config.port) { $Port = $config.port }
}

$ExpectedVersion = (Get-Content -LiteralPath (Join-Path $ServerDir 'package.json') -Raw | ConvertFrom-Json).version
$HealthUri = "http://localhost:$Port/api/health"
$TimeoutSeconds = 15

function Get-Health {
    try {
        return Invoke-RestMethod -Uri $HealthUri -TimeoutSec 2 -ErrorAction Stop
    } catch {
        return $null
    }
}

function Wait-Until {
    param(
        [scriptblock]$Condition,
        [string]$FailureMessage
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw $FailureMessage
}

try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($listener) {
        $health = Get-Health
        if (-not $health -or $health.status -ne 'ok') {
            throw "Port $Port is in use, but it is not a healthy backlog-dashboard instance. It was not stopped."
        }

        $listenerProcessId = $listener.OwningProcess
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerProcessId"
        $isNodeServer = $processInfo -and $processInfo.Name -ieq 'node.exe' -and
            $processInfo.CommandLine -match '(^|\s)server\.js(\s|$)'
        if (-not $isNodeServer) {
            throw "Port $Port is owned by PID $listenerProcessId, which is not the expected node server.js process. It was not stopped."
        }

        Write-Host "Stopping backlog-dashboard (PID $listenerProcessId)..."
        Stop-Process -Id $listenerProcessId -ErrorAction Stop
        Wait-Until -Condition { -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } `
            -FailureMessage "Port $Port did not close within $TimeoutSeconds seconds."
    } else {
        Write-Host "No listener on port $Port. Starting backlog-dashboard..."
    }

    Write-Host "Starting scheduled task $TaskName..."
    Start-ScheduledTask -InputObject $task
    Wait-Until -Condition {
        $currentHealth = Get-Health
        $currentHealth -and $currentHealth.status -eq 'ok' -and $currentHealth.apiVersion -eq $ExpectedVersion
    } -FailureMessage "backlog-dashboard did not become healthy with API version $ExpectedVersion within $TimeoutSeconds seconds."

    $finalHealth = Get-Health
    Write-Host "Restarted backlog-dashboard successfully: API version $($finalHealth.apiVersion)"
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
