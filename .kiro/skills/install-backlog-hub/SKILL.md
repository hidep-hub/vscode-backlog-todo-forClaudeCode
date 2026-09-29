---
name: install-backlog-hub
description: Use when a user asks to use backlog-dashboard in a new workspace, add a workspace to the shared dashboard, or set up the Kiro rules. Operate the SQLite-backed shared backlog through its localhost REST API only.
---

# install-backlog-hub（Kiro）

常時の運用ルールは `.kiro/steering/backlog-hub-rules.md` を読むこと。共通のAPI仕様・安全作法・タスクライフサイクルは `AGENTS.md.sample` と同じである。

## 新規インストール

1. 正本リポジトリを利用者が指定した親ディレクトリへcloneする。
   ```powershell
   git clone https://github.com/hidep-hub/vscode-backlog-todo-forClaudeCode.git
   ```
2. clone先の `backlog-dashboard/` で `config.json.example` を `config.json` へコピーし、`port`、`backlogDir`、`defaultWorkspaceParent`、`projects[]` を利用環境向けに設定する。
3. `backlog-dashboard/` で `npm install` の後に `node server.js` を起動し、`GET /api/health` の200応答を確認する。
4. 必要に応じて `backlog-dashboard/scripts/register-startup-task.ps1` で自動起動を登録する。

## 既存ダッシュボードへのワークスペース追加

1. `GET http://localhost:<port>/api/health` で稼働中のダッシュボードを確認する。
2. 利用者と `file`、未使用の`prefix`、`name`、`workspace`を確認する。
3. `POST /api/create-workspace {file, prefix, name?, workspace?}` をUTF-8 JSONで呼ぶ。`config.json`、SQLite、旧Markdownを直接編集しない。
4. `GET /api/board` の`workspaceMap`と、テストタスクの採番を確認する。テストタスクはAPIで論理削除する。

## Kiroルールの配置・更新

リポジトリの `scripts/install-kiro-backlog.ps1` を実行する。このスクリプトは、既存の `~/.kiro/steering/backlog-hub-rules.md` と `~/.kiro/skills/install-backlog-hub` をタイムスタンプ付き`.bak`へ退避してから更新する。
