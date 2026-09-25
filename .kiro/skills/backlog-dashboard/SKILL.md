---
name: backlog-dashboard
description: Use when a user asks to operate the backlog dashboard: viewing, adding, updating, or completing tasks. Operate the SQLite-backed shared backlog through its localhost REST API only.
---

# backlog-dashboard（Kiro）

常時の運用ルールは `.kiro/steering/backlog-hub-rules.md` を読むこと。共通のAPI仕様・安全作法・タスクライフサイクルは `AGENTS.md.sample` と同じである。

## 基本操作フロー

1. `GET http://localhost:3333/api/health` でAPIの稼働を確認する（セッション内で最初の1回のみ）。
2. すべての操作は `http://localhost:3333/api/` 経由で行う。DBファイルへの直接SQL操作禁止。
3. 日本語を含むPOSTは必ずUTF-8バイト配列に変換して送信する（PowerShellの場合）。

## actor の必須指定

**すべてのAPI操作（update-status / toggle-today / toggle-running）に `actor: "kiro"` を必ず渡すこと。**

```powershell
# 例: ステータス変更
$json = '{"taskId":"BT-001","newStatus":"do","actor":"kiro"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Uri http://localhost:3333/api/update-status -Method Post -ContentType "application/json" -Body $bytes

# 例: 実行中フラグON
$json = '{"taskId":"BT-001","value":true,"actor":"kiro"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Uri http://localhost:3333/api/toggle-running -Method Post -ContentType "application/json" -Body $bytes
```

## タスク開始時の必須アクション

タスクIDを指定して作業を始めるときは、最初の応答で以下を行う。

1. `GET /api/task/:id` でタスク詳細を取得する。
2. `POST /api/update-status {taskId, newStatus:"do", actor:"kiro"}` でステータスを `do` に変更する。
3. `POST /api/toggle-running {taskId, value:true, actor:"kiro"}` で実行中フラグをONにする。
4. 説明欄に引き継ぎファイルパスがあれば読み込んでコンテキストを復元する。

## タスク完了時の必須アクション

1. 成果物を `POST /api/update-task {taskId, artifacts:[...]}` で登録する（全件置換なので既存値を落とさない）。
2. ユーザーに成果を示し、DONEにしてよいか確認する。
3. 承認後に `POST /api/update-status {taskId, newStatus:"done", actor:"kiro"}` を実行する。

## 主要API早見表

| 操作 | API |
|------|-----|
| タスク取得 | `GET /api/task/:id` |
| ボード取得 | `GET /api/board` |
| 状態変更 | `POST /api/update-status {taskId, newStatus, actor:"kiro"}` |
| 今日やる | `POST /api/toggle-today {taskId, value?, actor:"kiro"}` |
| 実行中 | `POST /api/toggle-running {taskId, value?, actor:"kiro"}` |
| タスク追加 | `POST /api/add-task {title, project?, status?, ...}` |
| タスク更新 | `POST /api/update-task {taskId, ...}` |
| タスク削除 | `POST /api/delete-task {taskId}` |
| 履歴取得 | `GET /api/activity` |

## Kiroルールの配置・更新

リポジトリの `scripts/install-kiro-backlog.ps1` を実行する。このスクリプトは、既存の `~/.kiro/steering/backlog-hub-rules.md` と `~/.kiro/skills/install-backlog-hub` をタイムスタンプ付き`.bak`へ退避してから更新する。
