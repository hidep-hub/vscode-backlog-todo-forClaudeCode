# バックログ管理ルール（backlog-dashboard 連携・共通正本）

> 対応API version: 2.30.0（BT-459、BT-212、BT-336、BT-372、BT-377、BT-393、BT-408、BM-071、BM-072、BT-412、BM-074、BM-099、BT-291、BT-438、BM-105、BT-444、BT-442、BT-446、BM-121、BM-112、BT-450、BM-126、BT-458、BM-135、BM-136、BM-138、BM-155、BM-156、BM-158。このバージョンより古いAPIには一部の記述が適用されない場合がある）

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
2. **反映する**: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-agent-rules.ps1`（引数なしで3エージェント分を一括更新する。リポジトリ内の配布資材2か所へのコピーと、この端末の`~/.claude`・`~/.codex`・`~/.kiro`への配置まで、1回で終わる。Claude Code・Codexの配置先には`.bak`が作られるが、Kiroの配置先には作られない。`~/.kiro/skills/`配下に`.bak-日時`のフォルダがあるとKiroが同名スキルとして重複表示するため（BM-141））
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
  - **【BT-459, API 2.25.0】検索**: `GET /api/search?q=...&includeBody=true&workspace=<projects[].file>` — タイトル/ID/担当者はLIKE、`includeBody=true`で本文もFTS5(trigram、3文字以上)で検索し、`{results, bodySearchSkipped}`を返す。**`workspace`を付けるとそのワークスペースだけを対象にする**（省略時は従来どおり全ワークスペース横断。未登録の値は400 `unknown_workspace`）。UIの検索画面は選択中プロジェクトのみをデフォルト対象にし、「他のワークスペースも検索」で全体へ広げる。**【API 2.26.0】各resultに`category`（そのタスク自身の値）と`parentCategory`（親EPICの値）が付く**。カテゴリはEPIC/単発自身の値を使い、子タスクは親に従う（週報と同じ考え方）。UIはこれで「カテゴリ＞EPIC＞子タスク」にグループ化できる
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
  - GitHub連携: `POST /api/github-create-issue {taskId}` / `POST /api/github-link-issue {taskId, issueNumber, allowShared?}`（**【BM-158, API 2.30.0】** 同じIssueを複数タスクで共有できる。他タスクに紐づき済みのIssueは409 `already_linked`（`linkedTaskIds`付き）で止まり、`allowShared:true`を付けて再送した時だけ紐づく。成功時のレスポンスに`sharedWith`が付く。詳細は後述「1つの外部issueを複数タスクで共有する」）/ `GET /api/github-preview-issues?prefix=XX` / `POST /api/github-fetch-issues {prefix, issueNumbers?}`
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
  - **タスクコメント（BM-136、API 2.24.0）**: タスクに「ちょっとした状況」を日時つきで残す仕組み。`task_comments`テーブル（既存テーブルは拡張しない）に持ち、カードの1行表示・右クリックTIP・詳細モーダル・週報の「コメント」列に出る。編集はできず、追加と削除だけ
    - 追加: `POST /api/add-task-comment {taskId, body, actor?}` → `{ok, taskId, comment:{id,body,createdAt,createdBy}, commentCount}`。`body`は1〜1000文字（前後の空白は除き、改行はLFにそろえる）。空・長すぎは400 `invalid_body`、存在しない（論理削除済み含む）タスクは404 `not_found`。**AIが状況を残す場合は`actor`に自身の識別子（`"kiro"`/`"claude-code"`/`"codex"`）を渡す**（未指定は`"user"`）
    - 一覧: `GET /api/task-comments?taskId=XX-001` → `{taskId, comments:[{id,body,createdAt,createdBy}]}`（新しい順）。`taskId`が無ければ400、存在しなければ404
    - 削除: `POST /api/delete-task-comment {commentId}` → `{ok, taskId, commentCount}`（誤入力の取り消し用）。存在しないIDは404 `comment_not_found`、整数以外は400
    - **サイレント**: コメントの追加・削除は履歴（`task_events`、`/api/activity`）に記録せず、`tasks.updated_at`/`updated_by`も更新しない（モーダルの「更新者」がコメント投稿者に書き換わらないようにするため）。コメントの日時と投稿者はコメント自身が持つ
    - 取得: `GET /api/board`・`GET /api/task/:id`のitem（子にも）に`commentCount`と`latestComment:{id,body,createdAt,createdBy}`（無ければ`null`）が付く。**boardの`latestComment.body`は先頭120文字まで**（配信の肥大化を避けるため。全文・全件は`GET /api/task/:id`のitemが持つ`comments`（新しい順）か、`GET /api/task-comments`で取る）。EPICの`commentCount`/`latestComment`はEPIC自身のコメントのみで、子の分は含まない。タスクを`move-task`でワークスペース移管してもコメントは付いてくる
    - **週報のコメント列（`columns`にキー`comment`、ラベル「コメント」）**: 既定の列には入っておらず、選んだ時だけ出る。**集計期間内（JSTのfrom 0:00〜to翌日0:00）に投稿された最新の1件**を出し、期間外の古いコメントは出さない（無ければ空欄）。EPIC行は、EPIC自身とヒットした子の「期間内の最新コメント」のうち、いちばん新しい1件を出す。子のコメントには、どの子の話か分かるよう先頭に子のID（`XX-001: …`）が付く。ヒットしない子のコメントは出さない
    - **AIがコメントを残す場合の作法**: 作業の節目（方針に合意した、調査で原因が分かった、レビュー待ち、など報告に値する状況）で、1〜2文の短い状況を`add-task-comment`で残す。**説明欄（`description`）の代わりにはしない**（説明欄は対象範囲・合意した方針・作業結果を残す恒久的な記録で、コメントは時系列の状況メモ）
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
    - **上書き可**: 同じタスクに既に紐づきがあれば、別のチケットで置き換わる（間違えた時の修正用）。**【BM-158, API 2.30.0】** 同じチケットが**別のタスク**にも紐づいている場合は、409 `already_linked`で確認を求める（旧仕様は400で拒否。論理削除済みのタスクは対象外）。`allowShared:true`を付けて再送すると共有して紐づく（下記「1つの外部issueを複数タスクで共有する」）
    - 現時点で`source`は`redmine`のみ（`gitlab`は400）。チケットの新規作成はしない。結果は`GET /api/board`・`GET /api/task/:id`の`externalLinks`に反映される。画面からは、カード・詳細モーダル・子タスクカードにあるRedmineマークのボタンで操作できる
    - **AIが紐づける場合の作法**: ユーザーが指定したタスクとチケット番号の組だけを紐づけ、推測でチケット番号を選ばない。上書きになる場合は、先に`GET /api/task/:id`で現在の`externalLinks`を確認してユーザーに伝えてから実行する。409 `already_linked`が返った場合は、`linkedTaskIds`をユーザーに示して「他のタスクにも紐づいているが共有してよいか」を確認し、**承認を得てから**`allowShared:true`で再送する（AIが自己判断で`allowShared`を付けない）
  - **1つの外部issueを複数タスクで共有する（BM-158、API 2.30.0）**: 1issue:nタスクの関係を許可する。DBは元から許していた（`task_external_links`のUNIQUEは`(task_id, source)`のみ、`tasks.github_issue_number`もユニーク制約なし）ため、スキーマ変更はない。対象は**既存タスクへの紐づけ**（`github-link-issue`・`its-link-issue`）で、取り込み（`its-import`・`github-fetch-issues`）は従来どおり取込済みのissueを`skipped`にする（取込済みissueから別タスクを作る変更は含まない）
    - **確認フロー**: 他の（論理削除されていない）タスクが同じissueに紐づいている場合、紐づけAPIは何も保存せず409を返す。`{error:"already_linked", message, linkedTaskIds:[...]}`。`allowShared:true`（真偽値のtrueのみ有効。`"true"`や`1`は無効）を付けて再送すると紐づく。成功時のレスポンスに`sharedWith`（同じissueに紐づく他タスクのID配列、無ければ`[]`）が付く。自分自身は共有先に数えない。GitHubは同一ワークスペース内、Redmineは同一のhost・プロジェクト内で判定する。画面の紐づけダイアログは、409を受けると「他のタスク（XX-001）にも紐づいています。このタスクにも紐づけてよろしいですか？」と確認し、ボタンを「このまま紐づける」に変える（入力を変えると確認は解除される）
    - **取り込みプレビューの表示**: `its-preview`・`github-preview-issues`の各issueに`importedTaskIds`（紐づく全タスクのID配列、作成順。無ければ`[]`）が加わる。`importedTaskId`は互換のため先頭の1件（無ければ`null`）。画面の「取込済み」タグは複数のIDを併記する
    - **GitHub完了時の同期**: `update-status`で`done`にすると、紐づくIssueへ完了コメントを投稿する処理は従来どおり。ただし**Issueのcloseは、同じIssueに紐づく全タスク（論理削除を除く。子を持つタスクは実効ステータス）がdoneになった時だけ**行う。共有されている間は、コメントの1行目が「タスク XX-001 が完了しました。」になり、未完了のタスクがある時は末尾に「closeしていません: …」が付く。紐づくタスクが1つだけの場合は、コメント文面もcloseも従来と同じ。なお、未完了の共有相手を後から論理削除しても、Issueは自動ではcloseされない（次にいずれかのタスクをdoneにした時に判定される）
  - **カテゴリの並べ替え（BM-112、API 2.19.0）**: `POST /api/reorder-categories {orderedIds: [categoryId, ...], actor?}`（2件以上）— カテゴリはワークスペースの概念を持たないため、タグの並べ替えと異なりワークスペース検証は不要。渡した順に`sort_order`を1,2,3...へ振り直す
  - **週報（BT-291、API 2.11.0）**: 履歴（`task_events`）と期日（`tasks`）から、期間内にやったことをワークスペース別のMarkdown表にする。すべて読み取りで、書式の保存だけが書き込み（バックアップ中は409の対象）。画面は履歴ダイアログの「週報」ボタン
    - `GET /api/weekly-report?range=this|last（またはfrom=&to=YYYY-MM-DD）&workspaces=<projects[].file,...>&statuses=done,do&format=md|json` — 保存済みの書式で生成。`format=md`はダウンロード、省略はJSON（`markdown`/`warnings`/`data`）。期間は月曜〜日曜（JST）。不正な期間・ワークスペース・ステータスは400
    - `POST /api/weekly-report-preview {range|from,to, workspaces?, statuses?, template?, columns?}`（編集中の書式でプレビュー。書式は保存しない）/ `GET|POST /api/weekly-report-template`（書式と列の取得・保存。`{reset:true}`で既定に戻す。保存先は`<backlogDir>/weekly-report-template.json`）
    - 出力対象は、期間内に選択ステータスへ変わったタスク＋期日が期間内（または期間より前で未完了）のタスク（ステータス不問）＋【BM-156】開始日・期間をまたぐ進行中・完了日の条件（後述）。「期限超過 → 完了(DONE) → 対応中(DO/READY) → 未着手(TODO)」の見出しごとに1つの表にまとめる（該当が無い見出しは出さない）。**【BT-438】** 列に外部ITS（Redmine/GitLab）のIssue番号を選べる。ワークスペース見出しには、ステータス別件数バッジ（`{{statusCounts}}`）を出せる
    - **【BM-135, API 2.23.0】最終更新日は日付のみ**: 列キー`updatedAt`の値を、日時（`2026-10-13 10:00`）から日付（`2026-10-13`、JST）に変えた。表の列ラベルは「最終ステータス更新」から「最終更新日」に変わり、JSONの`data`内の`updatedAt`も日付のみ。列キー名は保存済みの書式との互換のため据え置き。ヘッダーの作成日時（`{{generatedAt}}`）は日時（`YYYY-MM-DD HH:mm`）のまま
    - **【BM-121, API 2.18.0】EPIC(子タスクを持つ親)は1行に集約する**（子タスクを個別行として並べるのはやめた）。対象条件（期間内のステータス変更／期日）を満たす子が1件以上あるEPICだけが、その子をまとめた1行として出る（満たす子が無いEPICは出ない）。件名セルはEPICタイトル＋ヒットした子タスクの件名を`<small>`+`<br/>`+「└」で列挙。**【BT-450, API 2.20.0】EPICの件名の先頭には線画系の記号「⧉」を付ける**（`⧉ EPIC名<br/><small>└ 子…</small>`。単発タスクには付かない。貼り先のフォントで表示できない場合は定数`EPIC_TITLE_MARK`を差し替える）。区分（期限超過/完了/対応中/未着手）は子の状態だけで判定（期限超過が1件でもあれば期限超過、なければ対応中が1件でもあれば対応中、全部todoなら未着手、全部doneなら完了。EPIC自身のstatus/due_dateは見ない）。期日はヒットした子の期日の最大値（最も遅い日付）。担当者・タグ・外部リンクはヒットした子の範囲から重複を除いて列挙。**カテゴリは常にEPIC/単発自身の値を使い、子タスク自身の`category`列は週報では参照しない**（子のカテゴリ欄はUIでグレイアウトされる想定。別タスクで対応）
    - **【BT-442, BM-121で表示方法を変更。API 2.18.0】カテゴリ**: `groupByCategory`（`1`/`true`）で「ワークスペース＞カテゴリ＞表」になる。カテゴリは見出し(`###`、カテゴリ名そのまま。「カテゴリ名：」等の修飾子は付かない)で、カテゴリとステータスは別軸のため章の中でさらにステータス区分の見出しには分けない（区分は表の「区分」列に出る。並び順は期限超過→完了→対応中→未着手の優先度を保つ）。`categories`（GETはカンマ区切り、POSTは文字列配列。カテゴリなしは`__none__`／空文字）で出力カテゴリを絞り込める（章分けオフでも有効、未指定は絞り込まない）。章は期間内に対象タスクがあるカテゴリだけで、並びはマスタ順→マスタ外→カテゴリなし。旧データの`-`はカテゴリなしとして扱う。`/api/weekly-report-counts`は`statuses`を受け取り、各ワークスペースに`categories`（カテゴリ別の件数、`""`はカテゴリなし。子タスクは親EPICのカテゴリとして数える）を返す
    - **【BM-138, API 2.27.0】1段目のグルーピング**: `groupBy=workspace|category`（GETのクエリ／プレビューPOSTのボディ。省略・空は`workspace`、他の値は400 `invalid_group_by`）。`workspace`は従来どおり「ワークスペース＞(カテゴリ章)＞表」。`category`は**「カテゴリ＞表（1枚）」**で、カテゴリはシステム全体で一意なので**ワークスペースをまたいで同じカテゴリを1つの章にまとめ、ワークスペースでは分けない**（IDの接頭辞で判別できる）。章の中は見出しを分けず、並びは期限超過→完了→対応中→未着手。カテゴリの並びはマスタ順→マスタ外→カテゴリなし（名前は「カテゴリなし」）。`categories`による絞り込みは両軸で有効。`groupByCategory`（2段目のカテゴリ章）は互換のため残し、**ワークスペース軸でのみ有効**でカテゴリ軸では無視される。ヘッダーの件数バッジ（`{{statusCounts}}`）とサマリーはカテゴリ軸ではカテゴリ単位（選択した全ワークスペース分）で数え、EPICの子は親のカテゴリとして数える。JSONの`data`には`groupBy`が付き、`workspaces`は従来どおり常に付く。カテゴリ軸の時だけ`categories`（`[{name('':カテゴリなし), items, count, counts, statusCounts}]`）が加わる
    - **【BM-138, API 2.27.0】書式の繰り返しの枠**: `{{#group}}…{{/group}}`（旧名の`{{#workspace}}…{{/workspace}}`も同じ意味で使え、保存済みの書式は壊れない）。`{{groupName}}`はワークスペース軸で「プレフィクス ワークスペース名」、カテゴリ軸でカテゴリ名。`workspaceId`/`workspaceName`/`workspaceFile`はワークスペース軸のみ有効で、カテゴリ軸では空になり警告が出る。`statusCounts`/`summary`/`doneCount`/`doingCount`/`overdueCount`/`count`/`table`は両軸で使える。既定の書式は`{{#group}}`と`{{groupName}}`を使う。画面（履歴の週報タブ）の左ペインは「期間→グルーピング→項目選択（ワークスペース選択・カテゴリ選択・出力ステータス・表の列）→出力フォーマット」の順で、グルーピングの選択はブラウザの`weeklySettings`（`groupBy`）に記憶される
    - **【BM-155, API 2.28.0】件数情報の出力の切り替え**: `showCounts=1|0`（GETのクエリ／プレビューPOSTのボディはboolean。省略・空は`1`＝従来どおり出す。`0`/`false`でオフ、他の値は400 `invalid_show_counts`）。オフの時は、書式の`{{statusCounts}}`（見出し横のステータス別バッジ）と`{{summary}}`（見出し下の「完了 N件 / 対応中 N件」）を、直前の空白ごと取り除いて出力しない（ワークスペース軸・カテゴリ軸の両方で有効）。`{{doneCount}}`などの個別の件数プレースホルダー、JSONの`data`内の件数、`totalCount`、サーバーに保存した書式は変わらない。画面（履歴の週報タブ）の「グルーピング」欄に「件数情報を出力する」のチェックがあり、選択はブラウザの`weeklySettings`（`showCounts`）に記憶される（既定はオン）
    - **【BM-156, API 2.29.0】出力対象の条件に開始日と完了日を追加**: 従来の「A) 期間内に選択ステータスへ変わった」「B) 期日が期間内、または期間より前で未完了（ステータス不問）」に次を足した。いずれも単発と子タスクの単位で判定し、EPIC自身の日付は見ない（ヒットした子が1件以上あるEPICだけが1行で出る）。**C) 開始日が期間内**（ステータス不問）。**C2) 期間をまたいで進行中**: 開始日が期間の初日より前、期日が期間の末日より後で、未完了（done以外）。複数週にわたるタスクは完了するまで毎週出続け、B・Cと合わせて、未完了タスクは「開始日〜期日の区間が期間と重なる」間は出る。期日が無いタスクは区間として扱わず、開始日が期間内（C）の時だけ出る。完了済みはC2の対象外（A・B・Dで拾う）。**D) 完了（done）で、完了日（`completed_at`、JST日付）が期間内**: 出力ステータスにDONEを選んでいる時だけ出す（Aと同じ扱い）。完了日だけを`update-task`で入れ直すと履歴は`completed_at_changed`になり`status_changed`が残らないため、履歴ではなく`tasks`の現在値で見る。逆に、現在doneで完了日が入っているタスクは、DONEになった日を完了日で判断し、履歴の「DONEへの変更」（A）では拾わない（完了日を後から先週へ直したタスクが、直す前のステータス変更日で今週の週報に載るのを防ぐため。完了日を期間内へ直した場合は、履歴が前の週にあっても期間内に出る）。完了日が無いdone（古いデータ）と、DONE以外のステータスへの変更は従来どおり履歴で判断する。B・C・C2は変わらない
    - **【BM-156, API 2.29.0】列と件数バッジ**: 選べる列に`startDate`（開始日）と`completedAt`（完了日。完了のタスクだけ値が入る）を追加した（既定の列には入れない。値は日付のみ）。EPIC行の開始日はヒットした子の最も早い日付、完了日は完了した子の最も遅い日付。件数バッジ（`{{statusCounts}}`）の太字は、完了日が期間内のdoneも「期間内にDONEへ変わった」扱いにする。`/api/weekly-report-counts`も同じ条件で数える。JSONの`data`内の各itemに`startDate`/`completedAt`が加わる（既存のキーは変わらない）
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
