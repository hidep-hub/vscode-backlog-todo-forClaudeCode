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
- `tags`: ワークスペース単位のタグ（名前・色・表記ゆれを正規化した重複判定キー。同一ワークスペース内で一意）
- `task_tags`: タスクとタグの対応（1タスクに複数付与可。タグの削除・統合で対応も更新される）

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
| タグ一覧・類似名の確認 | `GET /api/tags`, `GET /api/tags/similar` |
| タグの作成・更新・削除・統合 | `POST /api/create-tag`, `POST /api/update-tag`, `POST /api/delete-tag`, `POST /api/merge-tags` |
| タスクへのタグ付け外し | `POST /api/update-task-tags` |

書き込みAPIは `application/json` のUTF-8で呼び出します。AIエージェントは状態、実行中、今日やるの各操作に自身の `actor` を渡します。

`POST /api/toggle-today` にEPICを指定した場合は、子タスクへ一括でピン留めまたは解除を適用します。親EPIC自身のピンは集約対象ではないため、旧形式で残っていた親ピンも同時に解除します。応答の `affectedTaskIds` で実際の操作対象を確認できます。

## タグ

タスクに分類ラベル（タグ）を付けて、検索・絞り込み・グルーピングに使います。

- タグは**ワークスペース単位**で管理します。`tasks` テーブルは拡張せず、`tags` と `task_tags` を別に持ちます。
- タスクへ付けられるのは**既存のタグだけ**です。新しいタグはタグ管理画面（または `POST /api/create-tag`）で作ります。
- 似たタグの乱立を防ぐため、名前は全角半角・大小文字・空白のゆれを正規化して比較します。同じ名前は作成できず（409 `duplicate_tag`）、似た名前（部分一致、または短い名前の1文字違い）は確認のうえ `confirmSimilar` を付けた場合だけ作成できます（409 `similar_tags`）。
- `GET /api/board` と `GET /api/task/:id` の各タスクに `tags` が付きます。親EPICには子由来のタグ `childTags` も付きます（EPICのタグは子から導出し、継承はしません）。
- タグの付け外しは `tag_added` / `tag_removed` として履歴に残ります。ワークスペースを移したタスクは、タグがワークスペース単位のため解除されます。

画面では、ボード・週次計画・ガントでタグによる絞り込みができます（複数タグは「どれかを含む」「すべてを含む」を切り替え）。絞り込みはタグ名で行うため、全プロジェクト表示でも同じ名前のタグをまとめて扱えます。EPICは子がタグを持っていれば絞り込みの対象になります。

## バックアップとエクスポート

SQLite DBの保全と、利用者向けCSVエクスポートは別途定義します。タスクを別の旧形式へ変換する機能は提供しません。
