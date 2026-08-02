# backlog-dashboard を非表示ウィンドウで起動する(IN-018)
# タスクスケジューラのログオントリガーから呼ばれる想定。
# ポート3333が既にLISTEN中なら二重起動せず何もしない。

$Port = 3333
$ServerDir = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $PSScriptRoot "..\logs\startup.log"

function Write-Log($message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogFile -Value "[$timestamp] $message" -Encoding utf8
}

$portInUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Log "Port $Port is already in use. Skip starting (already running)."
    exit 0
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Log "ERROR: node command not found in PATH. Aborting."
    exit 1
}

try {
    Start-Process -FilePath $nodeCmd.Source -ArgumentList "server.js" -WorkingDirectory $ServerDir -WindowStyle Hidden
    Write-Log "Started backlog-dashboard (node server.js) in $ServerDir"
} catch {
    Write-Log "ERROR: Failed to start server. $($_.Exception.Message)"
    exit 1
}
