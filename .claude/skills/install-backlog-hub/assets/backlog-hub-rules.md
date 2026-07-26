# バックログ管理ルール（backlog-dashboard 連携）

## データの真実
- タスクの真のデータは `<backlogDir>/*.backlog.md`（Markdown）。UIやAPIはその窓。
- 変更は「md書式規約」を厳守すること。1文字崩すとパーサーが壊れる。

## md書式規約（厳守）
- セクション見出しは絵文字必須: `## 🔥 次やる` / `## 💡 アイデア／保留` / `## ✅ 完了（アーカイブ）`
- 親タスク: `### [ID] 件名`（角括弧必須）
- 子タスク: `#### [ID] 件名（親:親ID）`
- フィールドは `- キー: 値`（**太字禁止**）。キーは 状態/分類/説明/担当/開始日/期日/起源/成果物/完了日 のいずれか
- 状態値は `保留` / `未着手` / `未着手（素材あり）` / `進行中` / `完了` のみ
- ID = 2英大文字プレフィクス + 3桁通番（例 KT-007）
- 完了テーブル行: `| YYYY-MM-DD | 親 | ID | 件名 |`

## 操作手段の使い分け
- まず `curl -s http://localhost:3333/api/health` で起動確認
  - 200 → API経由で操作（下記）。実行後は必ずレスポンス {"ok":true} を確認してから成功報告
  - 接続不可 → 直接md編集にフォールバック（差分編集で）
- Content-Type は application/json のみ（; charset=utf-8 を付けない）
- 主要API:
  - 状態変更: POST /api/update-status {taskId, newStatus, isChild?}
  - 今日やる: POST /api/toggle-today {taskId, isChild?, value?}
  - 実行中:   POST /api/toggle-running {taskId, isChild?, value?}
  - 追加:     POST /api/add-task {title, project?, status?, origin?, parentId?}

## 新規ワークスペース追加時の初期処理
- トリガー: 新しいワークスペースで「バックログ使いたい」と言われたとき
- 判定: `curl -s http://localhost:<port>/api/health` が200 →「既存ダッシュボードへの追加登録」。接続不可 → 新規インストール（`install-backlog-hub` skillを使う）
- 追加登録の手順（迷わず一気に進める）:
  1. `<dashboardDir>/config.json` を `.bak` でバックアップ
  2. prefix決定: ワークスペースのフォルダ名から未使用の2英大文字（`_counter.md`・既存`projects[]`と重複しないか確認）
  3. `projects[]` に `{file: <フォルダ名>, prefix, name: <フォルダ名>, workspace: <絶対パス（スラッシュ区切り）>}` を追記（既存エントリは変更しない）
  4. `<backlogDir>/<file>.backlog.md` を雛形（見出し構成は上記md書式規約どおり）で新規作成
  5. **重要**: config.jsonはサーバー起動時に1度だけ読み込まれる（`fs.watch`の対象は`<backlogDir>`配下のmdファイルのみで、config.json自体は監視対象外）。`projects[]`の追記を反映するには**サーバープロセスの再起動が必須**
  6. 再起動後 `/api/health` → `/api/board` の `workspaceMap` に新ワークスペースが載っているか確認
  7. `add-task` で1件テスト投入し採番（例: プレフィクス-001）を確認 → 確認後はテストタスクを削除してmdをクリーンな状態に戻す

## タスクID指定で始めるときの必須アクション（最初の応答で）
1. そのタスクの説明欄を読む
2. 即座に 状態を 未着手→進行中 に変更（update-status）
3. 即座に 実行中フラグON（toggle-running, value:true）
4. 説明欄に引き継ぎファイルパスがあれば自動で読み込みコンテキスト復元
- 完了時: 状態を「完了」に（今日やる/実行中/完了日はAPIが自動処理）

## 完了・アーカイブの作法
- h3単発タスク: 🔥/💡から削除し、完了テーブルに1行追加（完了日必須）
- h4子タスク: 状態:完了 のまま残す（削除しない・完了テーブルに足さない）
- h3 Epic（子あり）: ブロックは残す
- 完了チケットの全文は archive/<project>.archive.md に退避

## 安全作法
- 書き換え前に .bak を取り、切り戻し手順を用意する
- API/コマンド実行後は結果を確認してから成功/失敗を報告する（推測で言わない）
