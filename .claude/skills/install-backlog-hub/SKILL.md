---
name: install-backlog-hub
description: backlog-dashboard(Markdownバックログをかんばん表示するアプリ)と、その運用ルール(backlog-hub-rules.md)を、新しい環境に対話的にインストールする。「backlog-dashboardを他のPCに入れたい」「別のワークスペースをダッシュボードに追加登録したい」といった依頼で使う。
---

# install-backlog-hub

このSkillは、`assets/` に同梱した実物のコード一式(サーバー・UI・運用ルール)を、ユーザーとの対話でディレクトリやポートを決めながら展開するインストーラーです。

**大原則**: `assets/` 配下のファイルは一字一句そのまま書き出すこと。要約・整形・モダン化はしない(劣化するため)。書き換えてよいのは `config.json` のプレースホルダー(`__XXX__`)だけ。

## 0. 同梱物

```
assets/
  backlog-dashboard/
    server.js          ← パーサー・API・WebSocket実装(無改変でコピー)
    config.json         ← テンプレート(__PORT__ 等のプレースホルダーを実値に置換する)
    package.json        ← 依存定義(ws 1個)
    public/
      index.html
      style.css
      app.js
    scripts/             ← Windows自動起動用(任意・無改変でコピー)
      start-hidden.ps1              ← 二重起動防止つきの非表示起動ラッパー
      register-startup-task.ps1     ← タスクスケジューラへの登録(要管理者権限)
      unregister-startup-task.ps1   ← タスクスケジューラからの解除
  backlog-hub-rules.md  ← 運用ルール実体(無改変でコピー)
```

## 1. 最初に聞くこと

まず、これが**新規インストール**(このPCに初めてダッシュボードを立てる)か、**既存ダッシュボードへのワークスペース追加登録**(他プロジェクトで既に動いているダッシュボードに、今開いているワークスペースを追加するだけ)かを確認する。

判定のヒント: リポジトリ内や `~/.claude/` 配下に既存の `backlog-dashboard/config.json` があれば追加登録の可能性が高い。曖昧なら素直にユーザーに聞く。

続けて、以下を対話で決める(判断材料があれば既定値を提示してYes/Noで済ませてよい。無理に全部聞き直さない):

| 項目 | 既定値 | 備考 |
|------|--------|------|
| バックログmdの置き場(`backlogDir`) | `~/.backlog` | 複数ワークスペースで共有する場所 |
| ダッシュボードアプリの設置場所 | `<今のワークスペース>/backlog-dashboard` | 新規インストール時のみ |
| ポート(`port`) | `3333` | 既存プロセスと衝突する場合のみ変更 |
| ワークスペース作成時のデフォルト親ディレクトリ(`defaultWorkspaceParent`) | 既存ワークスペース群の共通の親フォルダ(例: `c:/dev/claud`) | UIの「ワークスペースを作る」でフォルダ名だけ入力させるための基点。既存プロジェクトの`workspace`パスから推測できることが多い |
| このワークスペースの `prefix` | 未使用の2英大文字(例: プロジェクト名の頭文字) | `_counter.md` や他の `*.backlog.md` と重複しないか確認 |
| `file` / `name` | ワークスペースのフォルダ名 | 表示名として使われる |
| `workspace`(絶対パス) | 今のワークスペースの絶対パス | スラッシュ区切り推奨(`C:/...`) |

## 2. 新規インストールの場合

1. `assets/backlog-dashboard/` の中身を、決めた設置場所へ**そのまま**コピーする(Write/Editで書き出す。要約しない)。
2. `config.json` のプレースホルダーを実値に置換する:
   - `__PORT__` → 決めたポート番号(数値。クォート除去すること)
   - `__BACKLOG_DIR__` → 決めたbacklogDir
   - `__WORKSPACE_PARENT__` → 決めたdefaultWorkspaceParent
   - `__PROJECT_FILE__` / `__PROJECT_PREFIX__` / `__PROJECT_NAME__` / `__WORKSPACE_PATH__` → 決めた値
   - `inbox` プロジェクトのエントリはそのまま残す
3. `backlogDir` のディレクトリが無ければ作成する。
4. バックログmdの雛形を1本作成する(下記テンプレート。`_counter.md` は初回起動時にアプリが自動生成するので手で作らない):

   ```markdown
   # <name> バックログ
   <div style="text-align: right;">最終更新：YYYY-MM-DD</div>
   - **目的**: <一言>
   - **ワークスペース**: <name>
   ---
   ## 🔥 次やる（おすすめ順）

   ## 💡 アイデア／保留
   （現在なし）

   ---
   ## ✅ 完了（アーカイブ）

   | 完了日 | 親 | ID | 件名 |
   |---|---|---|---|
   ```

5. `cd <設置場所> && npm install` を実行する(`ws` 1個のみ)。
6. `node server.js` をバックグラウンド起動する。
7. `curl -s http://localhost:<port>/api/health` を叩き、`{"status":"ok",...}` を確認する。
8. **Windows起動時の自動起動を設定するか確認する(任意)**。VSCodeを開かなくてもPC起動直後からWEB-UIだけで思いついたTODOを追加・整理できる、という利点を伝えた上でユーザーに聞く。希望する場合:
   - `scripts/register-startup-task.ps1` を実行し、タスクスケジューラにログオントリガーで起動するタスク(`BacklogDashboardAutoStart`)を登録する。
   - `Register-ScheduledTask` はタスクスケジューラのルートフォルダへの書き込みが必要なため**管理者権限必須**。通常権限で実行すると `Access is denied` になるので、`Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"<register-startup-task.ps1の絶対パス>`""  -Wait` でUAC昇格して実行する(ユーザーにUACダイアログの承認を促す)。
   - `Get-ScheduledTask -TaskName "BacklogDashboardAutoStart"` で登録を確認する。
   - 二重起動防止(ポート使用中ならスキップ)の仕組みは `scripts/start-hidden.ps1` が担う。実行ログは `<設置場所>/logs/startup.log` に残る。
   - 解除したい場合は `scripts/unregister-startup-task.ps1` を実行する。

## 3. 既存ダッシュボードへのワークスペース追加登録の場合

1. 対象の `config.json` を**上書き前に `.bak` を取る**。
2. `projects[]` に、決めた `file`/`prefix`/`name`/`workspace` のエントリを追記する(既存エントリは変更しない)。
3. `prefix` が他エントリや `_counter.md` と重複していないか確認する。
4. `<backlogDir>/<file>.backlog.md` を上記テンプレートで新規作成する。
5. `config.json` は設置ディレクトリを `fs.watch` で監視するホットリロード機構を持つため、**サーバー再起動は不要**。保存後300ms程度で自動反映される。
6. `GET /api/health` → `GET /api/board` の `workspaceMap` に新プロジェクトが載っているか確認する。`POST /api/add-task` でテスト投入し、プレフィクス通りに採番されることを確認したら、テストタスクは削除してmdをクリーンな状態に戻す。

補足: 手順1〜4は、ダッシュボードUIのタスク詳細にある「🛠 ワークスペースを作る」ボタン(内部で `POST /api/create-workspace` を呼ぶ)を使えば1操作で完結する。workspaceフォルダ作成・mdファイル雛形作成・config.json追記・VS Code起動までを自動で行う。

## 4. ルール層のセットアップ

1. ユーザーのグローバル設定 `~/.claude/steering/backlog-hub-rules.md` の有無を確認する。
   - 無ければ `assets/backlog-hub-rules.md` を**そのまま**そこにコピーする。
   - 既にあり内容が異なる場合、上書きするかどうかユーザーに確認する(**上書き前に `.bak`**)。
2. グローバル `~/.claude/CLAUDE.md`(Windows: `C:\Users\<name>\.claude\CLAUDE.md`)に、`@~/.claude/steering/backlog-hub-rules.md` の import 行が無ければ追記する(**追記前に `.bak`**)。直書きはしない。
3. リポジトリ内で完結させたい場合は、リポジトリの `CLAUDE.md` に相対パスで import してもよい(ユーザーの希望を確認する)。

## 5. 最終確認チェックリスト

- [ ] `GET /api/health` が200を返す
- [ ] ブラウザで `http://localhost:<port>` を開き、かんばんボードが表示される
- [ ] バックログmdを編集して保存 → カードが自動更新される(fs.watch)
- [ ] UIからタスクを追加 → mdに追記され、`prefix-連番`で採番される
- [ ] `curl` で `update-status` / `toggle-running` が通る
- [ ] ルール実体が配置され、`CLAUDE.md`(または相当ファイル)からimportされている
- [ ] (自動起動を希望した場合) `Get-ScheduledTask -TaskName "BacklogDashboardAutoStart"` でタスクが登録されている

すべて確認できたら、何をどこに設置したか(パス一覧)をユーザーに報告する。
