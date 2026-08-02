# backlog-dashboard 自動起動タスクをWindowsタスクスケジューラに登録する(IN-018)
# 初回セットアップ時に一度だけ手動実行する。
# ログオン時に start-hidden.ps1 を非表示ウィンドウで起動するトリガーを登録する。

$TaskName = "BacklogDashboardAutoStart"
$ScriptPath = Join-Path $PSScriptRoot "start-hidden.ps1"

$Action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""

$Trigger = New-ScheduledTaskTrigger -AtLogOn

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName `
    -Action $Action -Trigger $Trigger -Settings $Settings `
    -Description "backlog-dashboardのWEB-UIをログオン時に自動起動する(IN-018)" `
    -Force

Write-Host "Registered scheduled task: $TaskName"
Write-Host "Run 'Start-ScheduledTask -TaskName `"$TaskName`"' to test it immediately."
