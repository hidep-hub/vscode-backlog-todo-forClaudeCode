# backlog-todo-multi リポジトリを最新化し、エージェント運用ルールの同期と
# backlog-dashboard の再起動までを1コマンドで行う(BM-051)。
# 対象は常にリポジトリ本流(main)。他ブランチで実行した場合は即中止する。
# VS Code のPowerShellターミナルまたはWindows Terminalから実行する想定。

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Invoke-GitInRepo {
    param([string[]]$GitArgs, [switch]$PassThru)
    # gitはpull等の進捗情報(「From https://...」等)を正常時でもstderrへ書く。
    # $ErrorActionPreference='Stop'の下ではネイティブコマンドのstderr出力が
    # 成功時でも終端エラーに変換されてしまうため、呼び出し中だけContinueに戻し、
    # かつ2>&1でstderrをオブジェクトとして取り込んで赤字のエラー表示を防ぐ。
    # 成否判定は$LASTEXITCODEのみで行う。
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $repositoryRoot @GitArgs 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { $_ }
        }
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE."
    }
    if ($PassThru) { return $output }
    $output | ForEach-Object { Write-Host $_ }
}

try {
    Write-Host '=== [1/5] ブランチ確認 ==='
    $currentBranch = (Invoke-GitInRepo -GitArgs @('branch', '--show-current') -PassThru).Trim()
    if ($currentBranch -ne 'main') {
        throw "現在のブランチは '$currentBranch' です。本スクリプトは main ブランチでのみ実行できます。'git checkout main' の後に再実行してください。"
    }
    Write-Host "ブランチ: $currentBranch (OK)"

    Write-Host ''
    Write-Host '=== [2/5] ローカル変更確認 ==='
    $statusLines = Invoke-GitInRepo -GitArgs @('status', '--short') -PassThru
    if ($statusLines) {
        Write-Host 'ローカルに未コミットの変更があります:'
        $statusLines | ForEach-Object { Write-Host "  $_" }
        Write-Host ''
        Write-Host 'エージェント運用ルール(backlog-hub-rules.md等)はホームディレクトリのグローバル設定で、'
        Write-Host 'git管理対象外のためpullの影響はありません。それ以外の変更に心当たりがある場合は、'
        Write-Host 'このまま進める前に自分で退避(stash/commit)してください。'
        Write-Host ''
        $answer = Read-Host '続行しますか？ [進む: y / やめる: n]'
        if ($answer -notin @('y', 'Y')) {
            Write-Host '中止しました。'
            exit 1
        }
    } else {
        Write-Host 'ローカル変更はありません。'
    }

    Write-Host ''
    Write-Host '=== [3/5] git pull (fast-forwardのみ) ==='
    Invoke-GitInRepo -GitArgs @('pull', '--ff-only', 'origin', 'main') | Out-Null

    Write-Host ''
    Write-Host '=== [4/5] エージェント運用ルール同期 ==='
    $installRulesScript = Join-Path $repositoryRoot 'scripts\install-agent-rules.ps1'
    & $installRulesScript
    if ($LASTEXITCODE -ne 0) {
        throw "install-agent-rules.ps1 failed with exit code $LASTEXITCODE."
    }

    Write-Host ''
    Write-Host '=== [5/5] backlog-dashboard 再起動 ==='
    Write-Host 'バージョンが変わらない内部変更でも再起動が必要な場合があるため、無条件で再起動します。'
    $restartScript = Join-Path $repositoryRoot 'backlog-dashboard\scripts\restart-startup-task.ps1'
    & $restartScript
    if ($LASTEXITCODE -ne 0) {
        throw "restart-startup-task.ps1 failed with exit code $LASTEXITCODE."
    }

    Write-Host ''
    Write-Host '=== 完了 ==='
    $configPath = Join-Path $repositoryRoot 'backlog-dashboard\config.json'
    $port = 3333
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($config.port) { $port = $config.port }
    }
    $health = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 5
    Write-Host "health: status=$($health.status) apiVersion=$($health.apiVersion)"
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
