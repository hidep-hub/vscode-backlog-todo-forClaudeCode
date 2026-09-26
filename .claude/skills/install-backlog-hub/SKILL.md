---
name: install-backlog-hub
description: SQLite版backlog-dashboardとAIエージェント向け運用ルールを新しい環境へ導入する。
---

# install-backlog-hub

`assets/` は配布用の現行SQLite版アプリです。タスクのデータはSQLite DBにあり、すべての操作はREST APIを通します。

## 新規インストール

1. `assets/backlog-dashboard/` を利用者が指定したインストール先へコピーする。
2. `config.json` のプレースホルダーを置換する。
   - `__PORT__`: 利用ポート
   - `__BACKLOG_DIR__`: SQLite DBを格納するディレクトリ
   - `__WORKSPACE_PARENT__`: ワークスペース親ディレクトリ
   - `__PROJECT_FILE__`、`__PROJECT_PREFIX__`、`__PROJECT_NAME__`、`__WORKSPACE_PATH__`: 初期プロジェクト
3. `npm install` の後に `node server.js` を起動する。
4. `GET /api/health` の200応答を確認する。
5. 必要に応じて `scripts/register-startup-task.ps1` で自動起動を登録する。

## 既存ダッシュボードへのワークスペース追加

1. `GET /api/health` で接続を確認する。
2. `file`、未使用の2文字大文字 `prefix`、表示名、ワークスペースパスを確認する。
3. UTF-8 JSONで `POST /api/create-workspace {file, prefix, name?, workspace?}` を1回実行する。
4. `GET /api/board` の `workspaceMap` と、`POST /api/add-task` による採番を確認する。確認用タスクはAPIで削除する。

`config.json`、SQLite DB、または旧形式のファイルを直接編集しません。

## 確認項目

- `GET /api/health` が200
- UIでボードを表示できる
- APIでタスクを追加・状態変更・実行中切替できる
- 新規ワークスペースをAPIで登録できる
- ルールファイルを各AIエージェントの設定へ配置できる
