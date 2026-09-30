# backlog-dashboard を非表示ウィンドウで起動する(IN-018)
# タスクスケジューラのログオントリガーから呼ばれる想定。
# 対象ポートが既にLISTEN中なら二重起動せず何もしない。
# ポート番号はconfig.jsonのport値を使う(BM-011)。config.json未作成(clone直後)の場合はserver.jsと同じ3333にフォールバックする。

$ServerDir = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ServerDir "config.json"
$Port = 3333
if (Test-Path -LiteralPath $ConfigPath) {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($config.port) { $Port = $config.port }
}
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
