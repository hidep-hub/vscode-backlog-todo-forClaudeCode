# バックログ管理ルール（backlog-dashboard 連携）

## データの真実
- タスクの真のデータは SQLite DB（`<backlogDir>/backlog.sqlite3`）。UIやAPIはその窓（BT-179でmdから移行済み）。
- `*.backlog.md` は移行前の旧データソースで、現在は直接読み書きしない。DBファイルへの直接SQL操作もしない（pin/running自動解除・GitHub連携同期などAPI側の自動処理を経由しなくなるため）。**すべての操作はAPI経由で行うこと**。

## 操作手段の使い分け
- まず `Invoke-RestMethod -Uri http://localhost:3333/api/health -Method Get` で起動確認（PowerShellの`curl`は`Invoke-WebRequest`のエイリアスで`-s`等のcurlオプションが通らないため使わない）
  - `status: ok` → API経由で操作（下記）。実行後は必ずレスポンス {"ok":true} を確認してから成功報告
  - 接続不可 → サーバーの復旧を待つ（mdへのフォールバックはDB化により廃止。DBファイルへの直接操作もしない）
- Content-Type は application/json のみ（; charset=utf-8 を付けない）
- **【重要】PowerShellでBodyに日本語を含むPOSTを送る際は、必ずUTF-8バイト配列に変換してから渡すこと（BT-016）**
  - `Invoke-RestMethod -Body <文字列>` は日本語をデフォルトエンコーディング（Shift-JIS系）で送信してしまい、サーバー側で文字化けした値になる（例: 状態値が `"??"` になり400 Bad Requestで弾かれる）
  - 正しい呼び方（毎回このパターンで組み立てる。400が出てから直す、という遠回りをしない）:
    ```powershell
    $json = '{"taskId":"XX-001","newStatus":"done"}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri http://localhost:3333/api/update-status -Method Post -ContentType "application/json" -Body $bytes
    ```
  - `curl.exe`（本物）はクォート処理でJSON自体が壊れやすく非推奨。上記の`Invoke-RestMethod` + `UTF8.GetBytes`に統一する
- **【重要】Bash（Git Bash）で`curl -d '{"title":"日本語..."}'`のように日本語をシングルクォート内に直書きしてPOSTすると、Windows環境でエンコーディングが壊れて文字化けする（BT-179で実際に発生。一度気づいて直したのに別の検証で再発させた反省あり）**
  - 文字化けしたタイトル・本文がそのままDBやGitHub Issueに書き込まれてしまう（見た目のミスだけでなく実データの汚染になり得る）
  - Bashで日本語を含むAPI呼び出し・`gh`コマンドを行う場合は、PowerShellの`Invoke-RestMethod`+`UTF8.GetBytes`方式に切り替えるか、日本語を含まないテスト文言（英数字のみ）を使う。どうしてもBashが必要なら、JSONを一旦UTF-8のファイルに書き出してから`--data-binary @file`で渡す
  - 実行後は文字化けしていないか目視確認する習慣をつける（「テストデータだから」で流さない。ユーザーに指摘されて気づいた実例あり）
- **主要API（BT-179でDB版に刷新。`isChild`パラメータは全API廃止、`taskId`（例`BT-181`）単独で親・子どちらも指定できる）**:
  - 状態変更: `POST /api/update-status {taskId, newStatus}` — `newStatus`はcode値 `todo`/`ready`/`do`/`done` のいずれか（**日本語ラベルではない**）
  - 今日やる: `POST /api/toggle-today {taskId, value?}` — レスポンスキーは `pinned`（旧`todayFlag`から改名）
  - 実行中: `POST /api/toggle-running {taskId, value?}`
  - 追加: `POST /api/add-task {title, project?, status?, origin?, parentId?, description?}`
    - `status`省略時は`todo`
    - **【重要】`project`にはprefix（例`"BT"`）ではなくconfig.jsonの`projects[].file`値（例`"backlog-todo"`）を渡すこと（BT-129）**。prefixを渡すと該当プロジェクトが解決できず、デフォルト（`inbox`等）に採番されてしまう。追加後は必ず期待したプレフィクスでID発行されたか確認する
  - 更新: `POST /api/update-task {taskId, title?, description?, category?, assignee?, startDate?, dueDate?}` — 渡したフィールドのみ更新
  - 並べ替え: `POST /api/reorder {orderedIds: [taskId, ...]}`（2件以上）— 同じ親を持つ子タスク同士、またはトップレベルで同じ実効ステータス同士でないと400
  - 親子付け替え: `POST /api/attach-to-parent {taskIds: [...], parentId}` / `POST /api/detach-from-parent {taskId}`（親子は2階層まで）
  - 削除: `POST /api/delete-task {taskId}` / `POST /api/delete-tasks {taskIds: [...]}` — **論理削除**（`deleted_at`を立てるのみで物理削除ではない）。子を持つタスクは拒否される（409）
  - ワークスペース移動: `POST /api/move-task {taskId, targetFile}`
  - GitHub連携: `POST /api/github-create-issue {taskId}` / `POST /api/github-link-issue {taskId, issueNumber}` / `GET /api/github-preview-issues?prefix=XX` / `POST /api/github-fetch-issues {prefix, issueNumbers?}`

## ステータス値の意味（`todo` / `ready` / `do` / `done`）
- 4値のみ（旧mdの`保留`は廃止、`未着手`→`todo`、`未着手（素材あり）`→`ready`、`進行中`→`do`、`完了`→`done`）
- **`ready`の意味（BT-178で再定義）**: 「素材が揃っている」ではなく「今週やる・着手する意思決定済みでいつでも始められる状態」という個人のタスク管理ワークフロー上の意味合い。表示ラベルもTODO/READY/DO/DONEの英語表記。

## 新規ワークスペース追加時の初期処理（BT-179で大幅簡略化）
- トリガー: 新しいワークスペースで「バックログ使いたい」と言われたとき
- 判定: `Invoke-RestMethod http://localhost:<port>/api/health` が200 →「既存ダッシュボードへの追加登録」。接続不可 → 新規インストール（`install-backlog-hub` skillを使う）
- 追加登録の手順（`POST /api/create-workspace {file, prefix, name?, workspace?}` を1回叩くだけで完結する）:
  1. `create-workspace` API呼び出し1本で、①countersテーブルへの行追加 ②config.json `projects[]`への追記 ③workspaceフォルダの新規作成（未存在時）まで全て行われる
     - **mdファイルの雛形作成は不要（DB版のため、そもそも存在しない）**
     - **サーバー再起動も不要**（config.jsonへの書き込みと同時にサーバーのin-memory configも更新される実装になっている）
  2. `/api/health` → `/api/board` の `workspaceMap` に新ワークスペースが載っているか確認
  3. `add-task` で1件テスト投入し採番（例: プレフィクス-001）を確認 → 確認後はテストタスクを`delete-task`で削除してクリーンな状態に戻す

## 新規要件を受けたときの初期フロー（タスク化ファースト・最優先ルール）
- ユーザーが新しい要件・依頼（まだチケット化されていないもの）を言った場合、既存タスクの続き作業でない限り、
  **いかなる実装・調査・ファイル編集も開始してはならない**。これは他のどのルールよりも優先する。
- 必須フロー（省略・順序入れ替え禁止）:
  1. 要件を要約し、粒度を判断する（単発でいいか / EPIC＋子タスクに分けるべきか）
  2. タスク構成案（タイトル・単発orEPIC+子タスク・状態）を具体的に提示する
  3. そのタスクをゴールとした実施計画を提示する
  4. ユーザーの明示的な承認（「いいよ」「それで」等）を得るまで、一切着手しない
  5. 承認後、add-task でタスクを起票 → 状態を`do`に変更 → 実行中フラグON → 着手する
- 自問チェック: 何かアクション（コード編集・調査開始・ファイル操作）を取ろうとする直前に
  「このタスクは起票済みか？」を自問する。Noなら即座に手を止め、タスク化フローに戻る。
- 唯一の例外: ユーザーが明示的に「タスク化は不要、直接やって」と発言した場合のみ省略可。
  自己判断（「これは軽微だから」等）でのスキップは一切禁止。

## タスクID指定で始めるときの必須アクション（最初の応答で）
1. そのタスクの説明欄を読む
2. 即座に 状態を `todo`→`do` に変更（`update-status {taskId, newStatus:"do"}`）
3. 即座に 実行中フラグON（`toggle-running {taskId, value:true}`）
4. 説明欄に引き継ぎファイルパスがあれば自動で読み込みコンテキスト復元
- 完了時: `newStatus`を`"done"`に。pin（今日やる）/running（実行中）解除・完了日時記録はAPIが自動処理する（下記「完了時の自動処理」参照）

## 完了時の自動処理（BT-119相当、BT-205でDB版に移植・実装済み）
- `update-status`で`newStatus:"done"`にすると、APIが自動で以下を行う（**親・子・単発の区別なく全タスク共通**。旧md版にあった「h3単発のみ完了テーブル移動」「h4/Epicはブロック維持」等の種別分岐は撤廃された）:
  1. pin（今日やる）/running（実行中）フラグを自動解除する
  2. コミットメッセージに `(taskId)` を含むコミットをそのプロジェクトのworkspaceで `git log --grep` して機械的に検索し、見つかったハッシュを`commit_hash`列に記録する
  3. `github_issue_number`が設定されているタスクの場合、GitHub Issueに完了コメントを投稿してcloseする
- 上記2・3が機能する前提として、**コミットメッセージ末尾に対象タスクIDを`(BT-xxx)`の形で含める**運用を徹底すること（既存のコミット規約と同じ）。付けないとコミットハッシュが紐付かない（GitHub連携自体は動く）
- **完了・アーカイブ手順の旧作法は不要になった**: DB版では完了してもタスク行は削除されない（論理削除の対象にすらならず、そのまま残る）ため、説明・成果物・github_issue_number等が失われることはない。旧md版で必須だった`archive/<project>.archive.md`への手動退避（BT-054〜056, BT-120, BT-132で繰り返し事故が起きていた作法）はDB化により構造的に不要になった。

## 知見の昇格ルール（MEMORY→backlog-hub-rules.md）
- 開発ワークスペース(backlog-todo)のMEMORYに何かを書き込む/更新する直前、必ず自問する:
  「これは他のワークスペースでbacklog-dashboardを操作するAIにも必要な運用知識か？」
- Yesなら、MEMORYに残すだけで終わらせず、必ずこのbacklog-hub-rules.md本体
  （グローバル版 `~/.claude/steering/backlog-hub-rules.md` と
  リポジトリ同梱版 `.claude/skills/install-backlog-hub/assets/backlog-hub-rules.md` の両方）にも
  同じ内容を反映すること。片方だけの更新で終わらせない（BT-057の全面同期方針を維持）
- 理由: MEMORYはワークスペース単位（作業ディレクトリのパスごと）にスコープが切られており、
  他のワークスペースからは一切参照できない。backlog-hub-rules.mdだけが全ワークスペース共通で
  読み込まれる唯一の伝達手段であり、ここに書いていない運用知識は「他のワークスペースでは
  存在しない知識」と同じになる（BT-120: archive.md退避先の混乱で実際に発生した事故）
- No（このリポジトリ自身の開発事情・git設定・命名決定・進行中タスクの引き継ぎ等）なら、
  MEMORYのみで良い。backlog-hub-rules.mdを無用に肥大化させない

## 安全作法
- DBファイル（`backlog.sqlite3`）を直接SQL操作しない。必ずAPI経由で操作する（pin/running解除・GitHub同期等の自動処理を経由させるため）
- **【重要】config.jsonの`columns[].match`（ステータス値の正当性チェックに直結）を変更する場合、対応するコード（server.js）変更と同時に行うこと**。config.jsonは`fs.watch`でホットリロードされる（保存後300msデバウンスで自動反映、`PORT`/`BACKLOG_DIR`だけがリロード対象外）ため、**コード側が新しいステータス値の集合に対応していない状態で保存すると、保存した瞬間に書き込み系APIが軒並み400エラーになる**（実例: BT-179でDB版4列構成をmd版コードのまま反映し、本番の`update-status`等が即座に壊れた）。手順は「プロセス停止→コードとconfig.json両方反映→起動」の順で
- 書き換え前に .bak を取り、切り戻し手順を用意する
- API/コマンド実行後は結果を確認してから成功/失敗を報告する（推測で言わない）
