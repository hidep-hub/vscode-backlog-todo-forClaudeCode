# バックログ管理ルール（backlog-dashboard 連携）

## データの真実
- タスクの真のデータは `<backlogDir>/*.backlog.md`（Markdown）。UIやAPIはその窓。
- 変更は「md書式規約」を厳守すること。1文字崩すとパーサーが壊れる。

## md書式規約（厳守）
- セクション見出しは絵文字必須: `## 🔥 次やる` / `## 💡 アイデア／保留` / `## ✅ 完了（アーカイブ）`
- 親タスク: `### [ID] 件名`（角括弧必須）
- 子タスク: `#### [ID] 件名（親:親ID）`
- フィールドは `- キー: 値`（**太字禁止**）。キーは 状態/分類/説明/担当/開始日/期日/起源/成果物/完了日/github_issue_number/github_issue_url/commit のいずれか
- 状態値は `保留` / `未着手` / `未着手（素材あり）` / `進行中` / `完了` のみ
- ID = 2英大文字プレフィクス + 3桁通番（例 KT-007）
- 完了テーブル行: `| YYYY-MM-DD | ts | 親 | ID | 件名 |`（ts=完了時刻HH:MM:SS、同日内の並び順に使う。BT-066以前のts無し4列行もパーサーは後方互換で読める）

## 操作手段の使い分け
- まず `Invoke-RestMethod -Uri http://localhost:3333/api/health -Method Get` で起動確認（PowerShellの`curl`は`Invoke-WebRequest`のエイリアスで`-s`等のcurlオプションが通らないため使わない）
  - `status: ok` → API経由で操作（下記）。実行後は必ずレスポンス {"ok":true} を確認してから成功報告
  - 接続不可 → 直接md編集にフォールバック（差分編集で）
- Content-Type は application/json のみ（; charset=utf-8 を付けない）
- **【重要】PowerShellでBodyに日本語を含むPOSTを送る際は、必ずUTF-8バイト配列に変換してから渡すこと（BT-016）**
  - `Invoke-RestMethod -Body <文字列>` は日本語をデフォルトエンコーディング（Shift-JIS系）で送信してしまい、サーバー側で文字化けした値になる（例: 状態値が `"??"` になり400 Bad Requestで弾かれる）
  - 正しい呼び方（毎回このパターンで組み立てる。400が出てから直す、という遠回りをしない）:
    ```powershell
    $json = '{"taskId":"XX-001","newStatus":"完了"}'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri http://localhost:3333/api/update-status -Method Post -ContentType "application/json" -Body $bytes
    ```
  - `curl.exe`（本物）はクォート処理でJSON自体が壊れやすく非推奨。上記の`Invoke-RestMethod` + `UTF8.GetBytes`に統一する
- 主要API:
  - 状態変更: POST /api/update-status {taskId, newStatus, isChild?}
  - 今日やる: POST /api/toggle-today {taskId, isChild?, value?}
  - 実行中:   POST /api/toggle-running {taskId, isChild?, value?}
  - 追加:     POST /api/add-task {title, project?, status?, origin?, parentId?}
    - **【重要】`project`にはprefix（例`"BT"`）ではなくconfig.jsonの`projects[].file`値（例`"backlog-todo"`）を渡すこと（BT-129）**。prefixを渡すと該当プロジェクトが解決できず、デフォルト（`inbox`等）に採番されてしまう。追加後は必ず期待したプレフィクスでID発行されたか確認する

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

## 新規要件を受けたときの初期フロー（タスク化ファースト・最優先ルール）
- ユーザーが新しい要件・依頼（まだチケット化されていないもの）を言った場合、既存タスクの続き作業でない限り、
  **いかなる実装・調査・ファイル編集も開始してはならない**。これは他のどのルールよりも優先する。
- 必須フロー（省略・順序入れ替え禁止）:
  1. 要件を要約し、粒度を判断する（単発でいいか / EPIC＋子タスクに分けるべきか）
  2. タスク構成案（タイトル・単発orEPIC+子タスク・状態）を具体的に提示する
  3. そのタスクをゴールとした実施計画を提示する
  4. ユーザーの明示的な承認（「いいよ」「それで」等）を得るまで、一切着手しない
  5. 承認後、add-task でタスクを起票 → 状態を「進行中」に変更 → 実行中フラグON → 着手する
- 自問チェック: 何かアクション（コード編集・調査開始・ファイル操作）を取ろうとする直前に
  「このタスクは起票済みか？」を自問する。Noなら即座に手を止め、タスク化フローに戻る。
- 唯一の例外: ユーザーが明示的に「タスク化は不要、直接やって」と発言した場合のみ省略可。
  自己判断（「これは軽微だから」等）でのスキップは一切禁止。

## タスクID指定で始めるときの必須アクション（最初の応答で）
1. そのタスクの説明欄を読む
2. 即座に 状態を 未着手→進行中 に変更（update-status）
3. 即座に 実行中フラグON（toggle-running, value:true）
4. 説明欄に引き継ぎファイルパスがあれば自動で読み込みコンテキスト復元
- 完了時: 状態を「完了」に（今日やる/実行中/完了日はAPIが自動処理）

## 完了・アーカイブの作法
- h3単発タスク: update-statusで完了にするとAPIが自動で🔥/💡から削除し、完了テーブルに1行追加する（完了日込み。BT-017で実装・検証済み）。手動でmd編集する必要はない
- h4子タスク: 状態:完了 のまま残る（APIは削除しない・完了テーブルにも足さない）
- h3 Epic（子あり）: ブロックは残る（子を持つ場合はAPIも自動移動しない）
- **【重要・完了操作とセットで必須】** h3単発タスクを完了にする際は、完了テーブルには件名しか残らない（説明・成果物が失われる）ため、必ず `<backlogDir>/archive/<project>.archive.md`（サーバーの`mergeArchiveDetails`が実際に読み込み、完了タスク詳細モーダルに成果物を表示するために参照する場所。**リポジトリ内の`archive/`ではない**。プロジェクト名はconfig.jsonの`projects[].file`と一致させる）に以下を追記すること（この手動退避はAPIの対象外で、書き忘れると完了タスクの詳細が二度と辿れなくなる。BT-054〜056で発覚した抜け。さらにBT-120で判明: リポジトリ内archive/に書いてしまうと本物に反映されず完了モーダルに成果物が出ない事故が過去発生した）:
  ```markdown
  ## [ID] 件名
  - 説明: 改修の概要のみ（手順や経緯の詳細は書かない。1〜2文で何をやったか）
  - 成果物: 変更/追加したファイルパス（カンマ区切り）
  - github_issue_number: 連携元Issue番号（GitHub連携済み(githubIssueNumberを持つ)タスクの場合のみ追記）
  - github_issue_url: 連携元IssueのURL（同上）
  ```
  - タスク完了のたびに毎回チェックするのは面倒なので、「完了にする」＝「archiveにも書く」をワンセットの作法として扱う
  - **【重要】GitHub連携済み(githubIssueNumberを持つ)h3単発タスクの場合、github_issue_number/urlも必ず書くこと（BT-132）**。完了時に本文ブロックごと消えるため書き忘れると、`mergeArchiveDetails`が復元できず、GitHub Issue取り込み画面の「取込済み」判定（BT-127）からそのIssueが漏れて再度一覧に出てきてしまう

## GitHub連携タスクの完了時自動反映（BT-119）
- `github_issue_number`が設定されているタスクをupdate-statusで「完了」にすると、APIが自動で
  以下を行う（AIが都度判断する処理ではなく、決定的なルールとして実装済み）:
  1. コミットメッセージに `(taskId)` を含むコミットをそのプロジェクトのworkspaceで
     `git log --grep` して機械的に検索し、見つかったハッシュをmdの`commit`フィールドに追記する
     （**h4子タスク・h3 Epic（子あり）のみ**。ブロックが残るケースが対象）
  2. GitHub Issueに完了コメントを投稿し、Issueをcloseする
- 上記が機能する前提として、**コミットメッセージ末尾に対象タスクIDを`(BT-xxx)`の形で
  含める**運用を徹底すること（既存のコミット規約と同じ）。付けないとコミットハッシュが
  紐付かない（GitHub反映自体は動く）
- **h3単発タスクは対象外**: 完了時にタスクブロック自体が削除される（完了テーブル行に
  圧縮される）ため、`commit`フィールドの自動追記は行われない。従来通り「完了・アーカイブの
  作法」節の手動archive.md退避で成果物・コミット情報を残すこと。この手動運用のAPI統合は
  BT-123として保留中（未着手）
  - **BT-132で判明**: archive.mdにgithub_issue_number/urlを書き忘れると、`mergeArchiveDetails`
    が復元できずGitHub Issue取り込み画面の「取込済み」判定（BT-127）から漏れる実害が確認された
    （実例: BT-118）。`mergeArchiveDetails`側は復元に対応済みなので、手動退避時に上記2項目を
    書き忘れないことが唯一の防止策

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
- 書き換え前に .bak を取り、切り戻し手順を用意する
- API/コマンド実行後は結果を確認してから成功/失敗を報告する（推測で言わない）
