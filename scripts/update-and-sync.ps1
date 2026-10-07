# backlog-todo-multi リポジトリを最新化し、エージェント運用ルールの同期と
# backlog-dashboard の再起動までを1コマンドで行う(BM-051)。
# 対象は常にリポジトリ本流(main)。他ブランチで実行した場合は即中止する。
# VS Code のPowerShellターミナルまたはWindows Terminalから実行する想定。
#
# -NonInteractive: ダッシュボード画面の「今すぐ更新する」ボタン(BM-064)からサーバー経由で
# 呼ばれる場合に指定する。Read-Hostでの確認プロンプトを出さず、ローカル未コミット変更が
# あった場合は安全側に倒して即中止する(対話で止まったまま進まなくなることを防ぐため)。
param(
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot

# BM-064: 進行状況を backlog-dashboard/logs/update-status.json に書き出す。
# 画面側(app.js)がこれをポーリングし、"running"(実作業中=pull以降)の間だけボードを
# ロックする。ブランチ不一致・ローカル変更での即中止は"failed"(実作業に入っていないため
# ロック不要)、"checking"段階ではまだ何も変更していないのでロック対象外とする。
$statusPath = Join-Path $repositoryRoot 'backlog-dashboard\logs\update-status.json'

function Write-UpdateStatus {
    param(
        [ValidateSet('checking', 'running', 'done', 'failed')]
        [string]$State,
        [string]$Message = ''
    )
    $payload = @{
        state     = $State
        message   = $Message
        updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    } | ConvertTo-Json -Compress
    New-Item -ItemType Directory -Path (Split-Path -Parent $statusPath) -Force | Out-Null
    # BOMなしUTF-8で書く(サーバー側(Node.js)がfs.readFileSync(path,'utf8')で読むため)。
    [System.IO.File]::WriteAllText($statusPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
}

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
    Write-UpdateStatus -State 'checking' -Message 'ブランチ確認中'
    Write-Output '=== [1/5] ブランチ確認 ==='
    $currentBranch = (Invoke-GitInRepo -GitArgs @('branch', '--show-current') -PassThru).Trim()
    if ($currentBranch -ne 'main') {
        throw "現在のブランチは '$currentBranch' です。本スクリプトは main ブランチでのみ実行できます。'git checkout main' の後に再実行してください。"
    }
    Write-Output "ブランチ: $currentBranch (OK)"

    Write-Output ''
    Write-Output '=== [2/5] ローカル変更確認 ==='
    Write-UpdateStatus -State 'checking' -Message 'ローカル変更確認中'
    $statusLines = Invoke-GitInRepo -GitArgs @('status', '--short') -PassThru
    if ($statusLines) {
        Write-Output 'ローカルに未コミットの変更があります:'
        $statusLines | ForEach-Object { Write-Output "  $_" }
        Write-Output ''
        Write-Output 'エージェント運用ルール(backlog-hub-rules.md等)はホームディレクトリのグローバル設定で、'
        Write-Output 'git管理対象外のためpullの影響はありません。それ以外の変更に心当たりがある場合は、'
        Write-Output 'このまま進める前に自分で退避(stash/commit)してください。'
        Write-Output ''
        if ($NonInteractive) {
            Write-Output '-NonInteractive指定のため、確認せず中止します。'
            Write-UpdateStatus -State 'failed' -Message 'ローカルに未コミットの変更があるため中止しました(-NonInteractive)'
            exit 1
        }
        $answer = Read-Host '続行しますか？ [進む: y / やめる: n]'
        if ($answer -notin @('y', 'Y')) {
            Write-Output '中止しました。'
            Write-UpdateStatus -State 'failed' -Message 'ユーザーが中止しました'
            exit 1
        }
    } else {
        Write-Output 'ローカル変更はありません。'
    }

    # ここから実際にリポジトリ・ルール・サーバーを変更する実作業に入る。画面側はこの区間だけボードをロックする。
    Write-UpdateStatus -State 'running' -Message 'git pull実行中'
    Write-Output ''
    Write-Output '=== [3/5] git pull (fast-forwardのみ) ==='
    Invoke-GitInRepo -GitArgs @('pull', '--ff-only', 'origin', 'main') | Out-Null

    Write-UpdateStatus -State 'running' -Message 'エージェント運用ルール同期中'
    Write-Output ''
    Write-Output '=== [4/5] エージェント運用ルール同期 ==='
    $installRulesScript = Join-Path $repositoryRoot 'scripts\install-agent-rules.ps1'
    & $installRulesScript
    if ($LASTEXITCODE -ne 0) {
        throw "install-agent-rules.ps1 failed with exit code $LASTEXITCODE."
    }

    Write-UpdateStatus -State 'running' -Message 'backlog-dashboard再起動中'
    Write-Output ''
    Write-Output '=== [5/5] backlog-dashboard 再起動 ==='
    Write-Output 'バージョンが変わらない内部変更でも再起動が必要な場合があるため、無条件で再起動します。'
    $restartScript = Join-Path $repositoryRoot 'backlog-dashboard\scripts\restart-startup-task.ps1'
    & $restartScript
    if ($LASTEXITCODE -ne 0) {
        throw "restart-startup-task.ps1 failed with exit code $LASTEXITCODE."
    }

    Write-Output ''
    Write-Output '=== 完了 ==='
    $configPath = Join-Path $repositoryRoot 'backlog-dashboard\config.json'
    $port = 3333
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($config.port) { $port = $config.port }
    }
    $health = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 5
    Write-Output "health: status=$($health.status) apiVersion=$($health.apiVersion)"
    # 再起動後のサーバーは直前のステータスファイルをそのまま引き継ぐ(ファイルなので消えない)。
    # ここでdoneを書くのは、再起動完了後に改めて正常終了を記録するため。
    Write-UpdateStatus -State 'done' -Message "更新が完了しました(apiVersion=$($health.apiVersion))"
} catch {
    Write-Error $_.Exception.Message
    Write-UpdateStatus -State 'failed' -Message $_.Exception.Message
    exit 1
}
