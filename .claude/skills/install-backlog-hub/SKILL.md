---
name: install-backlog-hub
description: SQLite版backlog-dashboardとAIエージェント向け運用ルールを新しい環境へ導入する。
---

# install-backlog-hub

アプリケーションの正本はGitリポジトリ直下の `backlog-dashboard/` です。アプリをスキル配下のassetsからコピーしません。タスクのデータはSQLite DBにあり、すべての操作はREST APIを通します。

## 新規インストール

1. 正本リポジトリを利用者が指定した親ディレクトリへcloneする。
   ```powershell
   git clone https://github.com/hidep-hub/vscode-backlog-todo-forClaudeCode.git
   ```
2. clone先の `backlog-dashboard/` で `config.json.example` を `config.json` へコピーし、`port`、`backlogDir`、`defaultWorkspaceParent`、`projects[]` を利用環境向けに設定する。
3. `backlog-dashboard/` で `npm install` の後に `node server.js` を起動する。
4. `GET /api/health` の200応答を確認する。
5. 必要に応じて `backlog-dashboard/scripts/register-startup-task.ps1` で自動起動を登録する。

## Claude Code / Codex / Kiroルールの配置・更新

clone直後、およびリポジトリをpullした後は、リポジトリ直下で `scripts/install-agent-rules.ps1` を実行する。この同期はversion文字列だけでなく、API仕様を含むルール正本の全文をグローバル設定へバックアップ付きで配備する。個別に更新するときは `install-claude-backlog.ps1`、`install-codex-backlog.ps1`、`install-kiro-backlog.ps1` を使う。

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
