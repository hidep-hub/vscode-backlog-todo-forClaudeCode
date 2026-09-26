# backlog-dashboard 現行仕様

## データの正本

タスクの正本は `backlogDir/backlog.sqlite3` のSQLite DBです。Web UIとAIエージェントはREST APIを通じてのみ操作します。DBへの直接SQL、設定ファイルの直接編集、旧形式との互換処理はサポートしません。

## データモデル

- `tasks`: タスク、親子関係、状態、担当、日付、GitHub連携
- `counters`: ワークスペースごとのIDプレフィクスと次番号
- `pins`: 今日やるタスク
- `running_tasks`: 実行中セッション
- `deliverables`: タスクの成果物
- `task_events`: 操作履歴

ワークスペースを作成すると、APIが `counters` を初期化し、`config.json` の `projects[]` を更新します。ファイル形式のタスクデータや採番ファイルは作成しません。

## API

主要エンドポイントは以下です。

| 用途 | API |
|---|---|
| 稼働確認 | `GET /api/health` |
| ボード取得 | `GET /api/board` |
| タスク取得 | `GET /api/task/:id` |
| タスク追加・更新 | `POST /api/add-task`, `POST /api/update-task` |
| 状態・実行状態 | `POST /api/update-status`, `POST /api/toggle-running`, `POST /api/toggle-today` |
| ワークスペース登録 | `POST /api/create-workspace` |
| 履歴 | `GET /api/activity` |

書き込みAPIは `application/json` のUTF-8で呼び出します。AIエージェントは状態、実行中、今日やるの各操作に自身の `actor` を渡します。

## バックアップとエクスポート

SQLite DBの保全と、利用者向けCSVエクスポートは別途定義します。タスクを別の旧形式へ変換する機能は提供しません。
