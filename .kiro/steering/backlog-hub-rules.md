---
inclusion: always
---

# バックログ管理ルール（backlog-dashboard 連携・共通正本）

> 対応API version: 2.1.8（BT-212。このバージョンより古いAPIには一部の記述が適用されない場合がある）

## データの真実
- タスクの真のデータは SQLite DB（`<backlogDir>/backlog.sqlite3`）。UIやAPIはその窓（BT-179でmdから移行済み）。
- `*.backlog.md` は移行前の旧データソースで、現在は直接読み書きしない。DBファイルへの直接SQL操作もしない（pin/running自動解除・GitHub連携同期などAPI側の自動処理を経由しなくなるため）。**すべての操作はAPI経由で行うこと**。

## 操作手段の使い分け
- **【BT-252】health確認はセッション内で最初にAPI操作する時に1回だけでよい**（同一セッション内で既に確認済みなら、以降の操作のたびに再確認しなくてよい）。このワークスペースを裏で変更するのは開発者本人のみという前提での簡略化なので、セッション中にconfig.jsonの変更やサーバー再起動を自分で行わないよう気をつけること。他者と共同運用する場合や、裏で設定変更・サーバー再起動が行われた可能性がある場合は都度確認に戻す
  - 確認コマンド: `GET http://localhost:3333/api/health`
  - `status: ok` → API経由で操作（下記）。実行後は必ずレスポンス `{"ok":true}` を確認してから成功報告
  - 接続不可 → サーバーの復旧を待つ（mdへのフォールバックはDB化により廃止。DBファイルへの直接操作もしない）
  - **【重要・BT-212】healthレスポンスの`apiVersion`と、このファイル冒頭の対応バージョンを照合する**。不一致の場合はこのルールファイルが古い（またはAPI側が先行更新されている）可能性があるため、記述通りに動くとは限らないと考え、作業前にユーザーへ一声かける
- Content-Type は application/json のみ（; charset=utf-8 を付けない）
- **【重要】日本語を含むボディでPOSTする際は、必ずUTF-8で送信すること（BT-016）**
  - シェル環境によっては日本語をデフォルトエンコーディング（Shift-JIS系）で送信してしまい、サーバー側で文字化けした値になる（例: 状態値が `"??"` になり400 Bad Requestで弾かれる）
  - PowerShellを使う場合は、必ずUTF-8バイト配列に変換してから渡す（毎回このパターンで組み立てる。400が出てから直す、という遠回りをしない）:
    ```powershell
    $json = '{"taskId":"XX-001","newStatus":"done"}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri http://localhost:3333/api/update-status -Method Post -ContentType "application/json" -Body $bytes
    ```
  - Bash（Git Bash含む）で`curl -d '{"title":"日本語..."}'`のように日本語をシングルクォート内に直書きしてPOSTすると、Windows環境でエンコーディングが壊れて文字化けする（BT-179で実際に発生）。日本語を含むAPI呼び出しは、JSONを一旦UTF-8のファイルに書き出してから`--data-binary @file`で渡すか、日本語を含まないテスト文言（英数字のみ）を使う
  - 実行後は文字化けしていないか目視確認する習慣をつける（「テストデータだから」で流さない）
- **主要API（BT-179でDB版に刷新。`isChild`パラメータは全API廃止、`taskId`（例`BT-181`）単独で親・子どちらも指定できる）**:
  - 単体取得: `GET /api/task/:id`（BT-222）— `/api/board`の全件走査を経由せず1件だけ取得できる。返却形状は`/api/board`のitemと同じ（親を指定すると`children`/`childrenTotal`/`childrenDone`も含む）。存在しないtaskIdは404
  - 履歴取得: `GET /api/activity`（BT-243、履歴機能EPIC BT-199配下）— `task_events`を`tasks`/`event_types`と結合し、`taskId`/`taskTitle`/`eventType`/`eventLabel`/`oldValue`/`newValue`/`actor`/`occurredAt`/`parentId`/`parentTitle`を持つイベント配列を`occurred_at`降順で返す。検索・期間絞り込みクエリは未対応（BT-246で追加予定）で、常に全件を返す
  - **【BT-201, BT-240で親のstatus条件を撤廃】`GET /api/board`のDONE列には、完了した子タスクが親の完了/未完了に関わらず`parentId`/`parentTitle`付きの単独itemとしても混在する**（親側の`children`配列にも同じ子は残るため、両方から拾うとカウント二重になる点に注意。`parentId`があるitemは「親側で既にカウント済みの完了子タスクの個別表示」なので、集計時はスキップするか除外して扱うこと）
  - 状態変更: `POST /api/update-status {taskId, newStatus, actor?}` — `newStatus`はcode値 `todo`/`ready`/`do`/`done` のいずれか（**日本語ラベルではない**）
  - 今日やる: `POST /api/toggle-today {taskId, value?, actor?}` — レスポンスキーは `pinned`
  - 実行中: `POST /api/toggle-running {taskId, value?, actor?}`
  - **AI実行者の記録（BT-281）**: AIエージェントが上記3 APIを操作する際は、自身の識別子を`actor`へ必ず渡す（Codexは`"codex"`、Claude Codeは`"claude-code"`、Kiroは`"kiro"`）。未指定時は後方互換として`"user"`になる。`toggle-running`のONで実行セッションを開始し、OFFまたは`done`で終了する。開始AI・停止AIは履歴へ永続記録される。
  - 追加: `POST /api/add-task {title, project?, status?, origin?, parentId?, description?, assignee?, startDate?, dueDate?}`（BT-263で担当/開始日/期日にも対応。登録フォームで最初から入力できる）
    - `status`省略時は`todo`
    - **【重要】`project`にはprefix（例`"BT"`）ではなくconfig.jsonの`projects[].file`値（例`"backlog-todo"`）を渡すこと（BT-129）**。prefixを渡すと該当プロジェクトが解決できず、デフォルト（`inbox`等）に採番されてしまう。追加後は必ず期待したプレフィクスでID発行されたか確認する
  - 更新: `POST /api/update-task {taskId, title?, description?, category?, assignee?, startDate?, dueDate?}` — 渡したフィールドのみ更新
  - 並べ替え: `POST /api/reorder {orderedIds: [taskId, ...]}`（2件以上）— 同じ親を持つ子タスク同士、またはトップレベルで同じ実効ステータス同士でないと400
  - 親子付け替え: `POST /api/attach-to-parent {taskIds: [...], parentId}` / `POST /api/detach-from-parent {taskId}`（親子は2階層まで）
  - 削除: `POST /api/delete-task {taskId}` / `POST /api/delete-tasks {taskIds: [...]}` — **論理削除**（`deleted_at`を立てるのみで物理削除ではない）。子を持つタスクは拒否される（409）
  - ワークスペース移動: `POST /api/move-task {taskId, targetFile}`
  - GitHub連携: `POST /api/github-create-issue {taskId}` / `POST /api/github-link-issue {taskId, issueNumber}` / `GET /api/github-preview-issues?prefix=XX` / `POST /api/github-fetch-issues {prefix, issueNumbers?}`

## ステータス値の意味（`todo` / `ready` / `do` / `done`）
- 4値のみ（`未着手`→`todo`、`未着手（素材あり）`→`ready`、`進行中`→`do`、`完了`→`done`）
- **`ready`の意味（BT-178で再定義）**: 「素材が揃っている」ではなく「今週やる・着手する意思決定済みでいつでも始められる状態」という個人のタスク管理ワークフロー上の意味合い。表示ラベルもTODO/READY/DO/DONEの英語表記。

## 新規ワークスペース追加時の初期処理（BT-179で大幅簡略化）
- トリガー: 新しいワークスペースで「バックログ使いたい」と言われたとき
- 判定: `GET http://localhost:<port>/api/health` が200 →「既存ダッシュボードへの追加登録」。接続不可 → 新規インストール（`install-backlog-hub` skillを使う）
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
1. `GET /api/task/:id`（BT-222）でそのタスクの説明欄を読む — `/api/board`の全件取得から探す遠回りはしない
2. 即座に 状態を `todo`→`do` に変更（`update-status {taskId, newStatus:"do", actor:"<自分のAI識別子>"}`）
3. 即座に 実行中フラグON（`toggle-running {taskId, value:true, actor:"<自分のAI識別子>"}`）
4. 説明欄に引き継ぎファイルパスがあれば自動で読み込みコンテキスト復元（`docs/plan`, `docs/report` 配下が置き場所の慣例）
- 完了時: `newStatus`を`"done"`にする際も`actor:"<自分のAI識別子>"`を渡す。pin（今日やる）/running（実行中）解除・完了日時記録はAPIが自動処理する（下記「完了時の自動処理」参照）

## 作業内容の記録ルール（説明欄への追記、BT-262で明文化）
- タスクについて「対象範囲・方針に合意した」「重要な判断を下した」「作業を実施・完了した」いずれかのタイミングで、その内容を`update-task`の`description`で説明欄に書き込むこと。会話ログにしか残らず、説明欄が空欄・着手前の内容のまま放置される状態を作らない。
- 記録すべきタイミングの例:
  1. ユーザーとの間で方針・対象範囲・実施計画に合意した時点（合意した計画そのものを記録する）
  2. 作業中に重要な判断（何を対象にした/しなかった、なぜそう判断したか）を下した時点
  3. 完了時、実施した作業内容とその結果の要約
- 更新方法: `POST /api/update-task {taskId, description}` は**全文置換**（差分追記APIはない）。追記する場合は事前に`GET /api/task/:id`で現在の説明を取得し、末尾に連結してから渡す
- 理由: 「新規要件を受けたときの初期フロー」でタスク化・計画提示・承認までは徹底されてきたが、承認後に実際にやったこと・下した決定が説明欄に反映されないまま完了する事象が発生した（BT-260で発覚）。DB化により旧md版の「archive手動退避」が不要になった分、説明欄がそのタスクの経緯を残す唯一の恒久的な記録になっているため、ここへの記録徹底が重要度を増している

## 完了前のユーザー確認とGit連携フロー（BT-289で明文化）
- **AIはタスクを独断でDONEにしてはならない**。作業の種別を問わず、完了条件を満たした後にユーザーへ成果・確認結果を示し、DONEにしてよいかを明示的に確認して返答を待つ。
- 改修資産がありGitリポジトリを使う開発作業では、次の順序を必ず守る。①改修・検証を終えたらユーザーにレビューを依頼して承認を待つ。②承認後に作業ブランチを作成（既存の作業ブランチがあればそれを使用）し、タスクIDを含むコミットを作成してpushする。③ユーザーによるマージを待つ。④マージ済みの返答後、対象ブランチをfetch/pullしてローカルを最新化し、当該コミットが取り込まれたことを確認する。⑤成果物を登録し、DONEへの遷移可否をユーザーに確認する。
- **コミットメッセージ、push時に添える説明、PRタイトル・本文・コメントは日本語で記載する。** タスクID表記など既存の機械判定用ルールは維持し、本文を英語だけで済ませない。
- マージ後のローカル最新化には、クリーンアップ確認まで含める。対象コミットの取込みを確認した後、`main`へ戻ってマージ済みの**ローカル作業ブランチ**を`git branch -d`で削除する。作業中に作成した一時`.bak`は、変更の検証・コミット・マージが済んだ後に、対象パスを確認してから削除する。ユーザーが元から持っていた未追跡ファイルやブランチは削除対象にしない。最後に`git status --short`で意図しない未追跡／変更がないことを確認し、削除結果をユーザーへ報告する。
- 調査のみ・資料作成のみ・設定変更など、開発やリポジトリ運用を伴わない作業では、Git連携フローは適用しない。ただし成果物を登録したうえで、DONEにしてよいかを必ずユーザーへ確認する。
- ユーザーの明示的な許可を得た後にのみ、`update-status {taskId, newStatus:"done", actor:"<自分のAI識別子>"}`を実行する。

## 完了時のアーティファクト記録ルール（BT-287で明文化）
- DONEにする**前**に、成果物をタスクの専用アーティファクトAPIで登録する。対象は変更ファイル、設計書・調査報告、テスト結果、PR・Issue・コミットなど、作業の結果を検証・再利用できるもの。説明欄でアーティファクトを代用しない。
- `GET /api/task/:id`で既存の`artifacts`を取得し、新しい成果物を加えた配列を`POST /api/update-task {taskId, artifacts}`で登録する。`artifacts`は**全件置換**なので、既存値を落とさないこと。成果物パスは対象プロジェクトのワークスペースルート基準の相対パスで登録し、絶対パスやURLは登録しない（画面がワークスペースルートを前置してコピー用パスを組み立てるため）。
- 登録APIのレスポンス`{"ok":true}`と、再取得したタスクの`artifacts`を確認してから`update-status`で`done`にする。成果物を登録できない場合は、DONEにせずユーザーへ確認する。
- このルールを含む全ワークスペース共通知識を更新する場合は、Claude Codeグローバル版、リポジトリ同梱のClaude Codeインストール資材、Codex向けマスター版、Codexグローバル版の4箇所を同時に同期する。いずれかだけの更新で終えない。

## 完了時の自動処理（BT-119相当、BT-205でDB版に移植・実装済み）
- `update-status`で`newStatus:"done"`にすると、APIが自動で以下を行う（**親・子・単発の区別なく全タスク共通**）:
  1. pin（今日やる）/running（実行中）フラグを自動解除する
  2. コミットメッセージに `(taskId)` を含むコミットをそのプロジェクトのworkspaceで `git log --grep` して機械的に検索し、見つかったハッシュを`commit_hash`列に記録する
  3. `github_issue_number`が設定されているタスクの場合、GitHub Issueに完了コメントを投稿してcloseする
- 上記2・3が機能する前提として、**コミットメッセージ末尾に対象タスクIDを`(BT-xxx)`の形で含める**運用を徹底すること。付けないとコミットハッシュが紐付かない（GitHub連携自体は動く）
- DB版では完了してもタスク行は削除されない（論理削除の対象にすらならず、そのまま残る）ため、説明・成果物・github_issue_number等が失われることはない。

## 知見の昇格ルール（BT-302でKiroを含む6箇所同期に拡張）
- 運用上の気づき（バグの回避策、API仕様の勘所など）を得て、他のワークスペース・他のAIエージェントでも使う知識だと判断した場合、単発の記憶に留めず、以下**4箇所**に同じ内容を反映すること。一部だけの更新で終わらせない：
  1. グローバル版 `~/.claude/steering/backlog-hub-rules.md`
  2. リポジトリ同梱版 `.claude/skills/install-backlog-hub/assets/backlog-hub-rules.md`
  3. この `AGENTS.md.sample`（共通正本。Codexには読まれない拡張子にしてある。Codexグローバル版とKiro版を作る元ネタ）
  4. Codexグローバル版 `~/.codex/AGENTS.md`（persona設定に続けてバックログルール全文を追記する）
  5. Kiro配布元 `.kiro/steering/backlog-hub-rules.md`
  6. Kiroグローバル版 `~/.kiro/steering/backlog-hub-rules.md`
- 理由: これら6ファイルが全ワークスペース・全AIエージェント共通で読み込まれる伝達手段であり、ここに書いていない運用知識は「存在しない知識」と同じになる（BT-120: archive.md退避先の混乱で実際に発生した事故）。

## 安全作法
- **【重要・BT-212】API仕様（server.js、db/配下、レスポンス形状等）に影響する変更をコミットする前に、`package.json`の`version`を上げる必要があるか自問する**。上げ忘れると、このファイル冒頭の対応バージョン表記との整合が崩れ、次回作業時のバージョン照合チェックが機能しなくなる
- DBファイル（`backlog.sqlite3`）を直接SQL操作しない。必ずAPI経由で操作する（pin/running解除・GitHub同期等の自動処理を経由させるため）
- **【重要】config.jsonの`columns[].match`（ステータス値の正当性チェックに直結）を変更する場合、対応するコード（server.js）変更と同時に行うこと**。config.jsonは`fs.watch`でホットリロードされる（保存後300msデバウンスで自動反映）ため、コード側が新しいステータス値の集合に対応していない状態で保存すると、保存した瞬間に書き込み系APIが軒並み400エラーになる
- 書き換え前に .bak を取り、切り戻し手順を用意する
- API/コマンド実行後は結果を確認してから成功/失敗を報告する（推測で言わない）


---

## Kiro固有の設定

- このファイルは共通正本 `AGENTS.md.sample` の本文をそのまま複製し、Kiro固有の追記だけを末尾に加えたものである。共通ルールを変更したら、必ず両方を同期する。
- Kiroのグローバル配置先は `~/.kiro/steering/backlog-hub-rules.md`。`scripts/install-kiro-backlog.ps1` は既存の配置先をバックアップしてから更新する。
- KiroカスタムエージェントはSteeringとSkillを自動読込しない。必要なら`resources`へ次を加える。

```json
[
  "file://.kiro/steering/**/*.md",
  "skill://.kiro/skills/**/SKILL.md"
]
```

