# バックログ管理ルール（backlog-dashboard 連携・共通正本）

> 対応API version: 2.23.0（BT-212、BT-336、BT-372、BT-377、BT-393、BT-408、BM-071、BM-072、BT-412、BM-074、BM-099、BT-291、BT-438、BM-105、BT-444、BT-442、BT-446、BM-121、BM-112、BT-450、BM-126、BT-458、BM-135。このバージョンより古いAPIには一部の記述が適用されない場合がある）

> ⚠️ **【最重要・読み飛ばし禁止】このファイル（`AGENTS.md.sample`）を編集したら、必ず `scripts/install-agent-rules.ps1` を実行して反映する。** 配布先（リポジトリ内の`.claude`・`.kiro`の`assets/backlog-hub-rules.md`、端末の`~/.claude`・`~/.codex`・`~/.kiro`）を手で編集・コピーしてはならない。手順は次々節「ルール正本と配布方式」にある。

## 最優先の約束事（作業前に必ず確認する索引）

詳細は各節にある。ここは読み飛ばしを防ぐための索引なので、内容を変える時は該当の節を正とし、この索引も合わせて直す。

1. 新しい要件は**タスク化が先**。起票とユーザーの承認の前に、調査・編集・実装を始めない（→「新規要件を受けたときの初期フロー」）
2. タスクIDを指定されたら、最初は**読み取り専用の調査と方針提示**だけを行い、承認を得てから状態変更・実行中ONへ進む（→「タスクID指定時の事前調査・方針合意フロー」）
3. **DONEは独断でしない**。成果物をアーティファクトとして登録し、ユーザーの確認を得てから`done`にする（→「完了前のユーザー確認とGit連携フロー」「完了時のアーティファクト記録ルール」）
4. タスクの操作は**API経由のみ**。DBファイルを直接SQL操作しない（→「安全作法」）
5. 日本語を含むPOSTは**UTF-8のバイト配列**で送る（→「操作手段の使い分け」）
6. API仕様に影響する変更は、**`package.json`のversion更新と、このファイルの更新・配布を同じ作業の中で完了させる**（→「安全作法」）
7. **このファイルを編集したら`install-agent-rules.ps1`を実行**し、`-Check`で全て最新であることを確認する。配布先を手で直さない（→「ルール正本と配布方式」）
8. 合意した方針・重要な判断・作業結果は、**説明欄に書き込む**（→「作業内容の記録ルール」）

## ルール正本と配布方式

`AGENTS.md.sample` は、Claude Code / Codex / Kiroで共有するバックログ運用ルール本文の**唯一の正本**である。エージェント固有のペルソナ・利用者固有の指示は正本に含めない。

```text
AGENTS.md.sample（Git管理の唯一の正本）
  ├─ .claude/skills/install-backlog-hub/assets/backlog-hub-rules.md
  ├─ .kiro/skills/install-backlog-hub/assets/backlog-hub-rules.md
  └─ 各PCで scripts/install-agent-rules.ps1 を実行
       ├─ ~/.claude/steering/backlog-hub-rules.md
       ├─ ~/.codex/AGENTS.md の managed block
       └─ ~/.kiro/steering/backlog-hub-rules.md
```

- 配布物は正本と完全一致させ、正本の直接編集以外でルール本文を変更しない。
- Codexインストーラは`AGENTS.md`のmanaged blockだけを更新する。ブロックがなければ既存の利用者固有指示を保持して末尾に追加し、空ならブロックだけを作成する。マーカー不整合・重複時は安全のため停止する。
### 正本を編集したときの反映手順（この順に全て実行する。省略も、手作業での代替も禁止）

1. 編集するのは`AGENTS.md.sample`だけ。差分編集（`str_replace`等）で変更し、配布先のファイルは開かない。
2. **反映する**: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-agent-rules.ps1`（引数なしで3エージェント分を一括更新する。リポジトリ内の配布資材2か所へのコピーと、この端末の`~/.claude`・`~/.codex`・`~/.kiro`への配置まで、1回で終わる。配置先には`.bak`が作られる）
3. **確認する**: 同じスクリプトに`-Check`を付けて実行し、全項目が`current`で、終了コードが0であることを確認する。
4. ユーザーへ、更新された配置先と`-Check`の結果を報告する。

- **禁止**: 配布先を手で編集・コピーすること、`Copy-Item`などで個別に上書きすること。内容の不一致や、次回の同期で上書きされて消える原因になる。
- 他のPCへは、そのPCでリポジトリを更新（pull）してから、同じスクリプトを実行する。
- 一部のエージェントだけを更新したい場合は`-Claude`/`-Codex`/`-Kiro`を付けられるが、通常は付けない。

## データの真実
- タスクの真のデータは SQLite DB（`<backlogDir>/backlog.sqlite3`）。UIやAPIはその窓（BT-179でmdから移行済み）。
- タスクの正本はSQLite DBであり、DBファイルへの直接SQL操作はしない（pin/running自動解除・GitHub連携同期などAPI側の自動処理を経由しなくなるため）。**すべての操作はAPI経由で行うこと**。

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
  - WindowsではPowerShellの`curl`が`Invoke-WebRequest`の別名であるため、curlオプションを前提にしない。日本語を含むPOSTの標準手段は上記の`Invoke-RestMethod`と`UTF8.GetBytes`にする。`curl.exe`を使う場合も、クォートや文字コードを検証してから使う
  - 実行後は文字化けしていないか目視確認する習慣をつける（「テストデータだから」で流さない）
- **主要API（BT-179でDB版に刷新。`isChild`パラメータは全API廃止、`taskId`（例`BT-181`）単独で親・子どちらも指定できる）**:
  - 単体取得: `GET /api/task/:id`（BT-222）— `/api/board`の全件走査を経由せず1件だけ取得できる。返却形状は`/api/board`のitemと同じ（BT-336で期日の変更履歴`dueDateHistory`＝`[{from,to,at,actor}]`古い順を追加。親を指定すると`children`/`childrenTotal`/`childrenDone`も含む）。存在しないtaskIdは404
  - 履歴取得: `GET /api/activity`（BT-243、履歴機能EPIC BT-199配下）— `task_events`を`tasks`/`event_types`と結合し、`taskId`/`taskTitle`/`eventType`/`eventLabel`/`oldValue`/`newValue`/`actor`/`occurredAt`/`parentId`/`parentTitle`を持つイベント配列を`occurred_at`降順で返す。**【BT-408, API 2.5.0】DB側の絞り込みクエリ`q`・`tagId`に対応**（どちらも省略すれば従来どおり全件）。`q`はタスクのタイトル/表示ID/説明文、親EPICのタイトル/表示ID、イベントの値（旧→新。ステータス遷移やタグ名）への大文字小文字を区別しない部分一致で、EPICで探すと配下の子タスクのイベントも対象になる。`tagId`はそのタグが付いたタスクのイベントだけを返す（論理削除済みタスクの履歴も対象）。`q`を指定した時だけ、各イベントに`matchedIn`（`title`/`id`/`description`/`parent`/`value`のうちヒットした場所）と、説明文でヒットした場合の`descriptionSnippet`（ヒット箇所の前後約30文字の抜粋）が付く。`q`と`tagId`はAND条件で、`tagId`が整数でなければ400。期間の絞り込みは未対応でクライアント側で行う
  - **【BT-201, BT-240で親のstatus条件を撤廃】`GET /api/board`のDONE列には、完了した子タスクが親の完了/未完了に関わらず`parentId`/`parentTitle`付きの単独itemとしても混在する**（親側の`children`配列にも同じ子は残るため、両方から拾うとカウント二重になる点に注意。`parentId`があるitemは「親側で既にカウント済みの完了子タスクの個別表示」なので、集計時はスキップするか除外して扱うこと）
  - 状態変更: `POST /api/update-status {taskId, newStatus, actor?}` — `newStatus`はcode値 `todo`/`ready`/`do`/`done` のいずれか（**日本語ラベルではない**）
  - 今日やる: `POST /api/toggle-today {taskId, value?, actor?}` — レスポンスキーは `pinned`。EPICを指定すると子タスクへ一括適用し、旧形式で親自身に残ったpinも解除する。応答の`affectedTaskIds`は操作対象のタスクID配列
  - 実行中: `POST /api/toggle-running {taskId, value?, actor?}`
  - **AI実行者の記録（BT-281）**: AIエージェントが上記3 APIを操作する際は、自身の識別子を`actor`へ必ず渡す（Codexは`"codex"`、Claude Codeは`"claude-code"`、Kiroは`"kiro"`）。未指定時は後方互換として`"user"`になる。`toggle-running`のONで実行セッションを開始し、OFFまたは`done`で終了する。開始AI・停止AIは履歴へ永続記録される。
  - 追加: `POST /api/add-task {title, project?, status?, origin?, parentId?, description?, category?, assignee?, startDate?, dueDate?, completedAt?}`（BT-263で担当/開始日/期日にも対応。登録フォームで最初から入力できる）
    - `status`省略時は`todo`
    - **【BT-377, API 2.4.0】過去の完了済みタスクを追加する場合は`status:"done"`と`completedAt`（オフセット付きISO 8601、例`"2026-09-01T10:30:00+09:00"`）を渡す**。`completed_at`と履歴（`created`/`status_changed→done`）が入力日時を基準に記録される。`completedAt`は`status:"done"`の時のみ指定でき（それ以外は400）、未来日時・不正な形式は400。省略時は現在時刻
    - **【重要】`project`にはprefix（例`"BT"`）ではなくconfig.jsonの`projects[].file`値（例`"backlog-todo"`）を渡すこと（BT-129）**。prefixを渡すと該当プロジェクトが解決できず、デフォルト（`inbox`等）に採番されてしまう。追加後は必ず期待したプレフィクスでID発行されたか確認する
    - **【BM-105, API 2.14.0】`category`はカテゴリマスタ（`categories`テーブル、ワークスペースをまたいでシステム全体で一意）に登録済みの名前のみ受け付ける**。未登録の名前を渡すと400 `unknown_category`。AIが自己判断で新規カテゴリ名を作らず、`GET /api/categories`で既存のカテゴリを確認するか、ユーザーに確認してから値を渡すこと。空文字/省略は「カテゴリなし」として常に許可される
    - **【重要・既存データからの移行】`categories`マスタはBM-105時点では空で始まる一方、`tasks.category`列自体はBM-105より前から存在し自由入力の値（例「バグ修正」「調査」）が既に入っていることがある。この既存値はマスタに自動登録されない**ため、該当タスクの`category`を`update-task`で変更しようとした瞬間に`unknown_category`で弾かれる（他フィールドだけの更新や、値を変えない操作は影響しない）。このAPIバージョンに上げた後にcategoryの操作で原因不明の400が出た場合は、まずこれを疑う。対応手順: ①`SELECT DISTINCT category FROM tasks WHERE category IS NOT NULL`相当で使われている値を洗い出す（DBファイルへの直接SQLは行わず、読み取り目的でも可能な範囲はAPI経由で確認する）②ユーザーに見せて要否を確認する③残したいものだけ`POST /api/create-category`で登録する④残り（削除したいもの）はカテゴリ管理画面またはAPIから`delete-category`し、該当タスクの`category`を自動クリアさせる。この移行作業はユーザー運用データの取捨選択を伴うため、AIが自己判断で一括登録・一括削除をせず、対象一覧をユーザーに確認してから実行する
    - **【表記ゆれの罠】カテゴリ名はNFKC正規化（全角/半角、空白等）を経てマスタに保存される**（例: 全角括弧「（）」が半角「()」になる等）。移行で既存値をそのままマスタに登録すると、`tasks.category`列の元の表記とマスタの表記がずれることがあり、その場合`listCategories`の使用数カウントや`delete-category`のタスク一括更新は**完全一致**で該当タスクを探すため、ずれたタスクが取り残される（使用数が0件なのに値は残っている状態になる）。移行後は`GET /api/categories`の`usageCount`と、実際にその値を使っているはずのタスク件数を見比べて、食い違いがあれば個別に`update-task`で正しい表記へ揃える
  - 更新: `POST /api/update-task {taskId, title?, description?, category?, assignee?, startDate?, dueDate?, completedAt?}` — 渡したフィールドのみ更新。`category`の挙動は追加時と同じ（マスタ登録済みの名前のみ、BM-105）
    - **【BT-458, API 2.22.0】** `completedAt`は現在のステータスが`done`のタスクだけ変更できる。オフセット付きISO 8601日時を渡し、未来日時・不正形式・未完了タスクは400。保存時はUTCへ正規化し、変更は`completed_at_changed`イベントとして履歴に残る。
  - 並べ替え: `POST /api/reorder {orderedIds: [taskId, ...]}`（2件以上）— 同じ親を持つ子タスク同士、またはトップレベルで同じ実効ステータス同士でないと400
  - 親子付け替え: `POST /api/attach-to-parent {taskIds: [...], parentId}` / `POST /api/detach-from-parent {taskId}`（親子は2階層まで）
  - 削除: `POST /api/delete-task {taskId}` / `POST /api/delete-tasks {taskIds: [...]}` — **論理削除**（`deleted_at`を立てるのみで物理削除ではない）。子を持つタスクは拒否される（409）
  - ワークスペース移動: `POST /api/move-task {taskId, targetFile}`
  - GitHub連携: `POST /api/github-create-issue {taskId}` / `POST /api/github-link-issue {taskId, issueNumber}` / `GET /api/github-preview-issues?prefix=XX` / `POST /api/github-fetch-issues {prefix, issueNumbers?}`
  - **DB・環境ファイルのバックアップ（BT-372）**: 1回のバックアップ = `<backlogDir>/backups/backlog-YYYYMMDD-HHmmss/` の1フォルダ（DB・環境ファイル・manifest.jsonをまとめる）。日次7件＋週次4件のローテーションで古いものから自動削除される
    - 一覧: `GET /api/backups` — `{ backupsDir, backups: [{file, createdAt, sizeBytes, integrity, counts, files, skipped}] }`
    - 進捗取得: `GET /api/backup-status` — `{ running, percent, phase, startedAt }`（`phase`は`db`/`files`/`verify`/`rotate`/`done`の順。実行中はポーリング用）
    - 実行: `POST /api/backup {actor?}` — 実行中の二重起動、同秒内の名前衝突はいずれも409（`error: "backup_in_progress"` / `"backup_exists"`）
    - 削除: `POST /api/delete-backup {file, actor?}` — 不正な名前は400、存在しないものは404、**最新の1件は保護され409**（`latest_protected`）で削除できない
    - **バックアップ実行中（`running: true`）は、バックアップ系2 API（`/api/backup`、`/api/delete-backup`）以外の全POST系APIが409（`error: "backup_in_progress"`）で拒否される**（取得時点の内容を一貫させるための全体ロック。取得・状態確認系のGETは影響しない）
  - **タグ（BT-391、API 2.3.0）**: タスクに付ける分類ラベル。**ワークスペース単位**で管理し、`tags`/`task_tags`テーブルに持つ（`tasks`は拡張しない）。タスクへ付けられるのは**既存タグのみ**で、別ワークスペースのタグは付けられない（400 `workspace_mismatch`）
    - 一覧: `GET /api/tags?workspace=<projects[].file>` — `{tags: [{id, workspace, name, color, sortOrder, usageCount}]}`（`usageCount`は論理削除されていないタスクへの付与数）。`workspace`省略で全ワークスペース
    - 類似名の事前確認: `GET /api/tags/similar?workspace=XX&name=...` — `{similar: [...]}`（完全一致は含まない）
    - 作成: `POST /api/create-tag {workspace, name, color?, confirmSimilar?, actor?}` — **自由入力でタグが乱立しないよう、表記ゆれ（全角半角・大小文字・空白）を含む完全一致は409 `duplicate_tag`（`existing`付き）、似た名前（部分一致2文字以上／4文字以上で編集距離1）は409 `similar_tags`（`similar`付き）で拒否**される。内容を確認したうえで本当に必要な場合だけ`confirmSimilar:true`を付けて再送する。名前は40文字まで、`color`は`#rrggbb`
    - 更新・削除・統合: `POST /api/update-tag {tagId, name?, color?}`（`color:null`で色なし）/ `POST /api/delete-tag {tagId}`（付与も外れる）/ `POST /api/merge-tags {sourceId, targetId}`（同一ワークスペース内。sourceを削除し、付いていたタスクをtargetへ付け替える）
    - 付け外し: `POST /api/update-task-tags {taskId, add?: [tagId], remove?: [tagId], actor?}` — 変更後のタスクのタグ配列を返す。既に付いている／付いていないタグの指定は無視される（冪等）
    - 取得: `GET /api/board`・`GET /api/task/:id`のitemに`tags: [{id,name,color}]`が付く。親EPICには子由来のタグ`childTags`（子のタグのうち親自身に無いもの）も付く（EPICのタグは子から導出するだけで、継承はしない）
    - 履歴: 付け外しは`tag_added`/`tag_removed`として`/api/activity`に残る（`newValue`/`oldValue`はタグ名）。`move-task`でワークスペースを移すと、タグはワークスペース単位のため解除され`tag_removed`が記録される
    - **AIがタグを付ける・作る場合の作法**: 付与の前に`GET /api/tags`で既存タグを確認し、似た名前があれば新規作成せず既存タグを使う。新規作成が必要な場合も、自己判断で`confirmSimilar:true`を付けず、ユーザーに確認してから行う
    - **【BM-112, API 2.19.0】並べ替え**: `POST /api/reorder-tags {workspace, orderedIds: [tagId, ...], actor?}`（2件以上）— 同一ワークスペース内のタグ同士でのみ並べ替え可能。別ワークスペースのタグが混ざっていると400 `workspace_mismatch`。渡した順に`sort_order`を1,2,3...へ振り直す（タスクの`/api/reorder`と同じ骨格）
  - **外部ITS連携（BM-071、API 2.6.0）**: GitHub以外の外部チケット（Redmine/GitLab）とタスクの紐づけ。`GET /api/board`・`GET /api/task/:id`のitem（子にも）に`externalLinks: [{source, key, url, projectRef}]`が付く。**GitHub分は従来どおり`githubIssueNumber`/`githubIssueUrl`で、`externalLinks`には含まれない**。1タスクにつきsourceごとに1件まで
    - 設定API: `GET /api/its-settings?prefix=XX`（`prefix`は`projects[].prefix`）/ `POST /api/its-settings {prefix, source, projectUrl?, token?}` / `GET /api/its-host-status?source=&url=`。**トークンは秘密情報のため、AIは扱わない（設定の入力・参照・ログ出力をしない）。設定はユーザーがUIで行う**
  - **Redmine取り込み（BM-072、API 2.7.0）**: 外部への書き戻しはしない読み取り専用の取り込み
    - `GET /api/its-meta?prefix=&source=redmine`（プロジェクト名・トラッカー一覧。**Redmine専用**。GitLabにはトラッカーの概念が無いため`source=gitlab`は400）/ `GET /api/its-preview?prefix=&source=redmine&trackerId=&status=open|all&offset=0`（1回最大500件。各issueの`alreadyImported`で取込済みか分かる。`nextOffset`が`null`でなければ続きがある）/ `POST /api/its-import {prefix, source:"redmine", keys:[...]}` → `{ok, added, skipped, errors}`
    - 取り込む項目は件名・説明・開始日・期日で、ステータスは`todo`固定。取込済みのチケットは`skipped`になる。取得した一覧の中だけ`parent`で親子化し、親子は2階層まで（3階層目は平坦化される）。連携未設定は400、Redmine側の失敗は502
    - **【BM-099, API 2.10.0】`its-preview`の各issueに`assignee`（担当者名）/`version`（対象バージョン名）/`description`（説明文）が付く**。Redmineのみで、値が無ければ`assignee`/`version`は`null`、`description`は空文字。GitLabは形だけ揃えて常に`null`/`null`/空文字。追加のAPI呼び出しは発生しない。`its-import`で取り込む項目（件名・説明・開始日・期日）は変わらない
    - **AIが取り込む場合の作法**: 取り込みはタスクを大量に作る操作のため、先に`its-preview`で対象を確認してユーザーに示し、承認を得てから`its-import`を実行する
  - **GitLab取り込み（BM-074、API 2.9.0）**: Redmineと同じ`its-preview`/`its-import`に`source:"gitlab"`で合流。外部への書き戻しはしない読み取り専用の取り込み
    - `GET /api/its-preview?prefix=&source=gitlab&status=open|all&offset=0` — GitLabには「トラッカー」「親子構造」の概念が無いため、`trackerId`は不要でフラットな一覧のみ（`parentKey`/`childKeys`は常に空）。取得した各issueの`dueDate`は`due_date`のみ（開始日フィールドは無いため`startDate`は常に`null`）。全件数`total`はGitLabの`x-total`ヘッダーが取れない場合`null`になる（「全件数不明」。続きの有無はGitLab側の`x-next-page`ヘッダーで判定するため`nextOffset`は正しく機能する）
    - `POST /api/its-import {prefix, source:"gitlab", keys:[...]}` → `{ok, added, skipped, errors}`。階層化しないため、選択したissueはすべてトップレベルのタスクとして作成される
    - `its-meta`はRedmine専用のため、GitLabでは呼ばない（呼ぶと400）
    - **AIが取り込む場合の作法**: Redmineと同じく、先に`its-preview`で対象を確認してユーザーに示し、承認を得てから`its-import`を実行する
  - **既存タスクへの外部ITSチケットの紐づけ（BM-126、API 2.21.0）**: `POST /api/its-link-issue {taskId, source:"redmine", issueKey, actor?}` → `{ok, source, issueKey, issueUrl}`。取り込み（新規タスクの作成）とは別に、**既にあるタスクへ、既存のRedmineチケットを後から紐づける**（GitHubの`github-link-issue`に相当）。外部への書き戻しはしない
    - `issueKey`はチケット番号の数字（`#123`の`#`は除去される）。そのワークスペースのRedmine接続設定（`its-settings`）が必須で、未設定は400。Redmine APIで実在を確認してから保存する（存在しなければ404、Redmine側の失敗は502）
    - **上書き可**: 同じタスクに既に紐づきがあれば、別のチケットで置き換わる（間違えた時の修正用）。一方、同じチケットが**別のタスク**に紐づいていれば400（二重紐づけ防止。論理削除済みのタスクは対象外）
    - 現時点で`source`は`redmine`のみ（`gitlab`は400）。チケットの新規作成はしない。結果は`GET /api/board`・`GET /api/task/:id`の`externalLinks`に反映される。画面からは、カード・詳細モーダル・子タスクカードにあるRedmineマークのボタンで操作できる
    - **AIが紐づける場合の作法**: ユーザーが指定したタスクとチケット番号の組だけを紐づけ、推測でチケット番号を選ばない。上書きになる場合は、先に`GET /api/task/:id`で現在の`externalLinks`を確認してユーザーに伝えてから実行する
  - **カテゴリの並べ替え（BM-112、API 2.19.0）**: `POST /api/reorder-categories {orderedIds: [categoryId, ...], actor?}`（2件以上）— カテゴリはワークスペースの概念を持たないため、タグの並べ替えと異なりワークスペース検証は不要。渡した順に`sort_order`を1,2,3...へ振り直す
  - **週報（BT-291、API 2.11.0）**: 履歴（`task_events`）と期日（`tasks`）から、期間内にやったことをワークスペース別のMarkdown表にする。すべて読み取りで、書式の保存だけが書き込み（バックアップ中は409の対象）。画面は履歴ダイアログの「週報」ボタン
    - `GET /api/weekly-report?range=this|last（またはfrom=&to=YYYY-MM-DD）&workspaces=<projects[].file,...>&statuses=done,do&format=md|json` — 保存済みの書式で生成。`format=md`はダウンロード、省略はJSON（`markdown`/`warnings`/`data`）。期間は月曜〜日曜（JST）。不正な期間・ワークスペース・ステータスは400
    - `POST /api/weekly-report-preview {range|from,to, workspaces?, statuses?, template?, columns?}`（編集中の書式でプレビュー。書式は保存しない）/ `GET|POST /api/weekly-report-template`（書式と列の取得・保存。`{reset:true}`で既定に戻す。保存先は`<backlogDir>/weekly-report-template.json`）
    - 出力対象は、期間内に選択ステータスへ変わったタスク＋期日が期間内（または期間より前で未完了）のタスク（ステータス不問）。「期限超過 → 完了(DONE) → 対応中(DO/READY) → 未着手(TODO)」の見出しごとに1つの表にまとめる（該当が無い見出しは出さない）。**【BT-438】** 列に外部ITS（Redmine/GitLab）のIssue番号を選べる。ワークスペース見出しには、ステータス別件数バッジ（`{{statusCounts}}`）を出せる
    - **【BM-135, API 2.23.0】最終更新日は日付のみ**: 列キー`updatedAt`の値を、日時（`2026-10-13 10:00`）から日付（`2026-10-13`、JST）に変えた。表の列ラベルは「最終ステータス更新」から「最終更新日」に変わり、JSONの`data`内の`updatedAt`も日付のみ。列キー名は保存済みの書式との互換のため据え置き。ヘッダーの作成日時（`{{generatedAt}}`）は日時（`YYYY-MM-DD HH:mm`）のまま
    - **【BM-121, API 2.18.0】EPIC(子タスクを持つ親)は1行に集約する**（子タスクを個別行として並べるのはやめた）。対象条件（期間内のステータス変更／期日）を満たす子が1件以上あるEPICだけが、その子をまとめた1行として出る（満たす子が無いEPICは出ない）。件名セルはEPICタイトル＋ヒットした子タスクの件名を`<small>`+`<br/>`+「└」で列挙。**【BT-450, API 2.20.0】EPICの件名の先頭には線画系の記号「⧉」を付ける**（`⧉ EPIC名<br/><small>└ 子…</small>`。単発タスクには付かない。貼り先のフォントで表示できない場合は定数`EPIC_TITLE_MARK`を差し替える）。区分（期限超過/完了/対応中/未着手）は子の状態だけで判定（期限超過が1件でもあれば期限超過、なければ対応中が1件でもあれば対応中、全部todoなら未着手、全部doneなら完了。EPIC自身のstatus/due_dateは見ない）。期日はヒットした子の期日の最大値（最も遅い日付）。担当者・タグ・外部リンクはヒットした子の範囲から重複を除いて列挙。**カテゴリは常にEPIC/単発自身の値を使い、子タスク自身の`category`列は週報では参照しない**（子のカテゴリ欄はUIでグレイアウトされる想定。別タスクで対応）
    - **【BT-442, BM-121で表示方法を変更。API 2.18.0】カテゴリ**: `groupByCategory`（`1`/`true`）で「ワークスペース＞カテゴリ＞表」になる。カテゴリは見出し(`###`、カテゴリ名そのまま。「カテゴリ名：」等の修飾子は付かない)で、カテゴリとステータスは別軸のため章の中でさらにステータス区分の見出しには分けない（区分は表の「区分」列に出る。並び順は期限超過→完了→対応中→未着手の優先度を保つ）。`categories`（GETはカンマ区切り、POSTは文字列配列。カテゴリなしは`__none__`／空文字）で出力カテゴリを絞り込める（章分けオフでも有効、未指定は絞り込まない）。章は期間内に対象タスクがあるカテゴリだけで、並びはマスタ順→マスタ外→カテゴリなし。旧データの`-`はカテゴリなしとして扱う。`/api/weekly-report-counts`は`statuses`を受け取り、各ワークスペースに`categories`（カテゴリ別の件数、`""`はカテゴリなし。子タスクは親EPICのカテゴリとして数える）を返す
  - **タスク一覧のCSVエクスポート（BT-221、API 2.8.0）**: `GET /api/export-csv?workspace=<projects[].file>` — 外部のガントチャート等へ転送するためのCSVをダウンロード形式（`Content-Disposition: attachment`、BOM付きUTF-8）で返す。読み取り専用で、バックアップ中の全体ロック（409）の対象外。`workspace`省略で全ワークスペース、未登録の`workspace`は400（`unknown_workspace`）
    - 1行1タスクで、EPICの直後にその子が続く。列は`workspace, id, parent_id, type, board_order, title, status, assignee, start_date, due_date, completed_at, tags, category, description, description_truncated, deliverables, its_source, its_issue, its_url`。`workspace`は常に先頭、`board_order`はボード上の並び順（親ごと。トップレベルは同じ実効ステータス内）、`deliverables`はパスではなくファイル名のみ
    - 論理削除済みは含まない。履歴（`task_events`）は含めない（完全な保全は`/api/backup`で行う）。説明欄は3万文字超で切り詰め`description_truncated=1`になる。応答ヘッダ`X-Export-Row-Count`/`X-Export-Truncated-Count`で件数を確認できる。画面からはバックアップのモーダル内「CSVエクスポート」欄で取得できる

## ステータス値の意味（`todo` / `ready` / `do` / `done`）
- 4値のみ（`未着手`→`todo`、`未着手（素材あり）`→`ready`、`進行中`→`do`、`完了`→`done`）
- **`ready`の意味（BT-178で再定義）**: 「素材が揃っている」ではなく「今週やる・着手する意思決定済みでいつでも始められる状態」という個人のタスク管理ワークフロー上の意味合い。表示ラベルもTODO/READY/DO/DONEの英語表記。

## 新規ワークスペース追加時の初期処理（BT-179で大幅簡略化）
- トリガー: 新しいワークスペースで「バックログ使いたい」と言われたとき
- 判定: `GET http://localhost:<port>/api/health` が200 →「既存ダッシュボードへの追加登録」。接続不可 → 正本リポジトリをcloneし、`backlog-dashboard/` を使って新規インストール（AIスキルassetsからアプリをコピーしない）
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

## タスクID指定時の事前調査・方針合意フロー（最初の応答で）
1. `GET /api/task/:id`（BT-222）でタスクの説明欄を読む — `/api/board`の全件走査はしない。この時点では状態変更・実行中フラグON・ファイル変更をしない
2. 説明欄に引き継ぎファイルパスがあれば読み込み、内容を「バグ」「新規要望」「調査・資料・その他」に分類する
3. 分類に応じて、再現確認・既存実装の確認・影響範囲の把握など、方針を決めるために必要最小限の**読み取り専用の調査**だけを行う。コード編集、設定変更、書き込みAPI、状態変更は行わない
4. ユーザーへ、調査結果（根拠・影響範囲）、対応方針（選択肢があれば推奨案と理由）、対象外、検証方法を提示し、明示的な承認を待つ
5. ユーザーが「進めよう」等で承認した後に、合意した方針を説明欄へ記録し、状態を`do`へ変更（`update-status {taskId, newStatus:"do", actor:"<自分のAI識別子>"}`）し、実行中フラグON（`toggle-running {taskId, value:true, actor:"<自分のAI識別子>"}`）にしてから実装・変更を始める
- 例外: ユーザーが「調査・方針提示は不要、直接進めて」と明示した場合だけ、手順3〜4を省略できる。個人名は記録せず、常に「ユーザー」と表記する
- 完了時: `newStatus`を`"done"`にする際も`actor:"<自分のAI識別子>"`を渡す。pin（今日やる）/running（実行中）解除・完了日時記録はAPIが自動処理する（下記「完了時の自動処理」参照）

## 作業内容の記録ルール（説明欄への追記、BT-262で明文化）
- タスクについて「対象範囲・方針に合意した」「重要な判断を下した」「作業を実施・完了した」いずれかのタイミングで、その内容を`update-task`の`description`で説明欄に書き込むこと。会話ログにしか残らず、説明欄が空欄・着手前の内容のまま放置される状態を作らない。
- 記録すべきタイミングの例:
  1. ユーザーとの間で方針・対象範囲・実施計画に合意した時点（合意した計画そのものを記録する）
  2. 作業中に重要な判断（何を対象にした/しなかった、なぜそう判断したか）を下した時点
  3. 完了時、実施した作業内容とその結果の要約
- 更新方法: `POST /api/update-task {taskId, description}` は**全文置換**（差分追記APIはない）。追記する場合は事前に`GET /api/task/:id`で現在の説明を取得し、末尾に連結してから渡す
- 理由: タスクの説明欄は、対象範囲・判断・実施結果を残す恒久的な記録であるため、会話ログだけに依存してはならない。

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
- このルールを含む全ワークスペース共通知識を更新する場合は、「ルール正本と配布方式」の反映手順（`AGENTS.md.sample`を編集→`install-agent-rules.ps1`を実行→`-Check`で確認）に従う。配布先を個別に手で更新して終えない。

## 完了時の自動処理（BT-119相当、BT-205でDB版に移植・実装済み）
- `update-status`で`newStatus:"done"`にすると、APIが自動で以下を行う（**親・子・単発の区別なく全タスク共通**）:
  1. pin（今日やる）/running（実行中）フラグを自動解除する
  2. コミットメッセージに `(taskId)` を含むコミットをそのプロジェクトのworkspaceで `git log --grep` して機械的に検索し、見つかったハッシュを`commit_hash`列に記録する
  3. `github_issue_number`が設定されているタスクの場合、GitHub Issueに完了コメントを投稿してcloseする
- 上記2・3が機能する前提として、**コミットメッセージ末尾に対象タスクIDを`(BT-xxx)`の形で含める**運用を徹底すること。付けないとコミットハッシュが紐付かない（GitHub連携自体は動く）
- DB版では完了してもタスク行は削除されない（論理削除の対象にすらならず、そのまま残る）ため、説明・成果物・github_issue_number等が失われることはない。

## 知見の昇格ルール（BT-302でKiroを含む6箇所に拡張、BM-126で正本＋スクリプト配布に一本化）
- 運用上の気づき（バグの回避策、API仕様の勘所など）を得て、他のワークスペース・他のAIエージェントでも使う知識だと判断した場合、単発の記憶に留めず、**`AGENTS.md.sample`（唯一の正本）にだけ書く**。
- 書いたら、「ルール正本と配布方式」の反映手順（`install-agent-rules.ps1`を実行→`-Check`で確認）で全配布先へ反映する。**配布先を1か所ずつ手で更新しない**。以前は6か所を手作業で更新していたが、スクリプト配布に移行済みで、手作業は更新漏れと不一致の原因になる。
- スクリプトが更新する配布先: リポジトリ同梱の`.claude`・`.kiro`の`assets/backlog-hub-rules.md`、端末の`~/.claude/steering/backlog-hub-rules.md`、`~/.codex/AGENTS.md`（managed block）、`~/.kiro/steering/backlog-hub-rules.md`。
- 理由: ここに書いていない運用知識は「存在しない知識」と同じになる（BT-120: archive.md退避先の混乱で実際に発生した事故）。配布先が正本とずれると、エージェントごとに違うルールで動いてしまう。

## 安全作法
- **【最重要・BT-212】API仕様に影響する変更（エンドポイントの追加・変更、リクエスト/レスポンスの形や意味の変更、出力内容の変更）を含む作業は、コミットの前に次の4つを全て行う。「必要か自問する」だけで済ませない**:
  1. `backlog-dashboard/package.json`の`version`を上げる（機能追加・出力変更はマイナーを1つ上げる`x.y.0`。これまでパッチ番号は使っていない）
  2. このファイル冒頭の「対応API version」の値とタスクID一覧を更新し、変更したAPIの説明を該当の節へ`【BM-xxx, API x.y.0】`の形で追記する
  3. 「ルール正本と配布方式」の反映手順で配布し、`-Check`で最新であることを確認する
  4. サーバー再起動後に`GET /api/health`の`apiVersion`が上げた値になっていることを確認する（`apiVersion`は起動時に読み込まれるため、再起動するまで変わらない）
  - 上げ忘れると、このファイル冒頭の対応バージョン表記との整合が崩れ、次回作業時のバージョン照合チェックが機能しなくなる。ダッシュボードの`/api/rules-status`も、`package.json`とこのファイルの値がずれていると不一致（`versionMismatch`）を出す
- DBファイル（`backlog.sqlite3`）を直接SQL操作しない。必ずAPI経由で操作する（pin/running解除・GitHub同期等の自動処理を経由させるため）
- **【重要】config.jsonの`columns[].match`（ステータス値の正当性チェックに直結）を変更する場合、対応するコード（server.js）変更と同時に行うこと**。config.jsonは`fs.watch`でホットリロードされる（保存後300msデバウンスで自動反映）ため、コード側が新しいステータス値の集合に対応していない状態で保存すると、保存した瞬間に書き込み系APIが軒並み400エラーになる
- 書き換え前に .bak を取り、切り戻し手順を用意する
- API/コマンド実行後は結果を確認してから成功/失敗を報告する（推測で言わない）
