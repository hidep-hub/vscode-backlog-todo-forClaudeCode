# Redmine / GitLab 連携 設計書（EPIC BT-347）

| 項目 | 内容 |
|---|---|
| 対象EPIC | BT-347（子: BT-348 設計 / BT-349 基盤 / BT-350 Redmine / BT-351 GitLab / BT-352 モックテスト＋検証手順書） |
| 対象APIバージョン | 2.1.12 時点で設計（実装時に 2.2.0 へ上げる想定。後述） |
| 参照した移植元 | `hidep-hub/kiro-backlog-todo`（`redmine-api.js` / `gitlab-api.js` / `*-links.js` / `server.js` のRedmine・GitLab節） |
| 状態 | 設計（レビュー済み。未決事項Q1〜Q6は §12 のとおり確定） |

この文書は、実装者と、**実機（Redmine / GitLab）で検証する別PCの担当**の両方が、これだけ読めば前提と判断理由を追えることを目的にする。実機のホスト名・トークン・社内固有名は一切書かない（例は `redmine.example.com` 等のダミー）。

---

## 1. 背景と目的

### 1.1 現状（現行 backlog-dashboard / SQLite版）
- GitHub連携のみ。タスク側は `tasks` テーブルに **列で直持ち**（`github_issue_number` / `github_issue_url`）。
- 認証・接続先は `backlog-dashboard/github-credentials.json`（`{ "<prefix>": { repoUrl, token } }`、gitignore対象）。1ワークスペースに1つだけ。リクエストごとに読み直すため、再起動なしで反映される。
- 取り込み系API: `GET /api/github-preview-issues` / `POST /api/github-fetch-issues` / `POST /api/github-link-issue` ほか。

### 1.2 移植元（kiro-backlog-todo、Markdownファイル版）
- タスクには `- GitLabIssue: 123` / `- RedmineIssue: 456` の番号行だけを持つ。
- 「issue番号 → taskId」の**使用済み台帳**を別ファイル（`gitlab-links.json` / `redmine-links.json`）で持つ。
- 接続設定は `config.json` の `projects[].gitlabProjectUrl` / `redmineProjectUrl` ＋ ホスト単位の `gitlabHosts` / `redmineHosts`（PAT/APIキー）。
- 機能: 接続テスト、一覧取得、取り込み（親子展開）、既存タスクへの紐付け、issue作成、完了反映、連携済み目印の書き戻し。

### 1.3 目的
GitHubに加えて **Redmine と GitLab** を、ワークスペース単位で必要な数だけ併用できるようにする。

### 1.4 スコープ
| 区分 | 内容 |
|---|---|
| 対象 | 連携設定の管理、接続テスト、issue一覧取得、**取り込み**（親子含む）、**既存タスクへの紐付け/解除**（外部システムへは**読み取りのみ**） |
| 対象外（後続） | 外部側へのissue作成、タスク完了時の外部issueクローズ、**取り込み/紐付け時の外部issueへの書き戻し（連携済みマーカー）**、GitHub連携の `task_links` への移行、双方向の継続同期 |

---

## 2. 設計の要点（決定事項）

| # | 決定 | 理由 |
|---|---|---|
| D1 | 連携情報は汎用テーブル `task_links` に持つ。列追加方式にしない | 連携が増えるたびにtasksの列が増えるのを防ぐ。使用済みチェックもUNIQUE制約で兼ねられる |
| D2 | 接続情報は **ワークスペース(prefix)ごとに連携の配列** を持つ（0〜n個、同種の複数も可） | 実運用で「GitHub/Redmine/GitLabを使う・使わない」はワークスペースごとに異なるため |
| D3 | 接続情報は新ファイル `integration-credentials.json`（gitignore）。**毎リクエスト読み直し**でホットリロード | 現行のgithub-credentials.jsonと同じ方式で、再起動不要。手編集も反映される |
| D4 | 既存 `github-credentials.json` は読み取り時に「`github` 連携」として統合して見せる。GitHubの既存API・既存列は今回触らない | 後方互換と段階移行 |
| D5 | providerごとの差は **アダプタ** に閉じ込め、サーバー側の取り込み・紐付けロジックは共通化する | Redmine/GitLab/将来のものを追加しやすくする |
| D6 | 外部システムへは**読み取りのみ**。取り込み後の書き戻し（連携済みマーカー）は今回実装しない | 外部への書き込みは副作用が大きく、実機未検証の段階では安全側にする。必要になったら別タスクで、連携設定に `writeBack`（既定OFF）を追加して導入する |
| D7 | 接続テストは **段階別診断** で返す（URL解釈→到達→認証→プロジェクト→追加機能） | 別PCでの切り分けを容易にする。どこで失敗したかが分かる |
| D8 | 実機がなくても確認できる範囲を最大化するため、モックサーバーによる自動テストを同梱する（BT-352） | GitLab実機が手元にないため |

---

## 3. 接続情報（integration-credentials.json）

### 3.1 配置とgitignore
- 実体: `backlog-dashboard/integration-credentials.json`（`.gitignore` に追加）
- 雛形: `backlog-dashboard/integration-credentials.json.example`（Git管理。ダミー値のみ）

### 3.2 構造
```json
{
  "BT": [
    {
      "id": "redmine-1",
      "provider": "redmine",
      "label": "社内Redmine",
      "url": "https://redmine.example.com/redmine/projects/sample-project",
      "token": "xxxxxxxxxxxxxxxxxxxxxxxx",
      "allowInsecureTls": false
    },
    {
      "id": "gitlab-1",
      "provider": "gitlab",
      "label": "社内GitLab",
      "url": "https://gitlab.example.com/group/subgroup/sample-project",
      "token": "glpat-xxxxxxxxxxxxxxxxxxxx",
      "allowInsecureTls": false
    }
  ]
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| キー（`BT`） | ○ | ワークスペースの **prefix**（現行のgithub-credentials.jsonと同じキー） |
| `id` | ○ | ワークスペース内で一意な連携ID。`task_links.link_id` に入る。**一度決めたら変更しない**（変えると既存リンクが孤立する） |
| `provider` | ○ | `redmine` / `gitlab`（`github` は互換統合で自動付与） |
| `label` | – | UI表示名。省略時は provider 名 |
| `url` | ○ | 後述の「URL分解」でホストとプロジェクトに分解できる、プロジェクトページのURL |
| `token` | ○ | Redmine: APIキー / GitLab: Personal Access Token（`read_api` で足りる。読み取りのみのため） |
| `allowInsecureTls` | – | 既定 `false`。社内CAや自己署名証明書でTLS検証に失敗する環境向けの逃げ道（§9参照） |

### 3.3 ホットリロード
- 読み取りは**毎リクエスト** `fs.readFileSync` + `JSON.parse`（ファイルは小さい）。mtimeキャッシュは最適化として可。
- パース失敗時は**直前の正常値を使い続けず、エラーを明示**して返す（認証情報の食い違いを黙って通さない）。ただしサーバーは落とさない。
- 書き込みは UI/APIから行い、書き込み前に `.bak` を作る（既存運用に合わせる）。
- `config.json` の `fs.watch` ホットリロードとは**別系統**。config.json自体は変更しない。

### 3.4 秘匿
- トークンは**API応答に出さない**。`hasToken: true/false` のみ返す（現行 `github-settings` と同じ）。
- 更新時、`token` 未指定＝既存保持、空文字＝削除。
- ログ・エラーメッセージにトークンやAuthorizationヘッダを含めない。

### 3.5 GitHubの互換統合
`github-credentials.json` の `{ "BT": { repoUrl, token } }` は、連携一覧を作る際に `{ id: "github", provider: "github", url: repoUrl, hasToken }` として**読み取り専用で**合成する。今回の範囲ではGitHubの取り込み・紐付けは既存API/UIのまま動かし、`task_links` にはまだ載せない。

### 3.6 URL分解
URL1本をユーザーに入力させ、サーバー側でホストとプロジェクトに分解する（移植元の方針を踏襲）。

| provider | 入力例 | 分解結果 | 分解ルール |
|---|---|---|---|
| Redmine | `https://redmine.example.com/redmine/projects/sample-project/issues` | host=`https://redmine.example.com/redmine` / projectIdentifier=`sample-project` | `/projects/<識別子>` をセパレータにする。それ以前をホスト（**サブパス含む**、Redmineは `/redmine/` 配下設置が普通のため） |
| GitLab | `https://gitlab.example.com/group/subgroup/sample-project/-/issues` | host=`https://gitlab.example.com` / projectPath=`group/subgroup/sample-project` | `/-/` 以降を除去。`.git` 末尾も除去。サブグループは可変長なので `/-/` が無い場合は「ホスト以降の全体」をパスとみなす |

GitLabを **サブパス配下（相対URLルート）に設置している環境は今回非対応**（ホスト=スキーム+ドメイン+ポートのみ）。必要になったら別タスクにする。

---

## 4. データモデル（task_links）

### 4.1 DDL（`db/schema.js` の `DDL` に追加。`IF NOT EXISTS` なので既存DBに安全）
```sql
CREATE TABLE IF NOT EXISTS task_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  workspace   TEXT    NOT NULL,
  link_id     TEXT    NOT NULL,   -- integration-credentials.json の連携id
  provider    TEXT    NOT NULL,   -- 'redmine' | 'gitlab' | ...
  external_id TEXT    NOT NULL,   -- Redmine: チケットid / GitLab: issue iid（文字列で保持）
  url         TEXT    NULL,       -- 外部issueのWeb URL（表示・遷移用）
  created_at  TEXT    NOT NULL,
  created_by  TEXT    NOT NULL,
  UNIQUE(workspace, link_id, external_id),   -- 同じ外部issueを複数タスクに紐付けない（使用済みチェック）
  UNIQUE(task_id, link_id)                   -- 1タスクは、同じ連携先の1issueにだけ紐付く
);
CREATE INDEX IF NOT EXISTS idx_task_links_task ON task_links(task_id);
```
- `external_id` は provider によって型が違っても扱えるよう TEXT。
- Redmineのチケットidはサイト全体で一意、GitLabのiidはプロジェクト内で一意。どちらも `(workspace, link_id)` と組み合わせるので衝突しない。

### 4.2 タスク削除との関係
- 現行GitHub版は「論理削除したタスクの番号は取り込み済み扱いから外れる」挙動（`deleted_at IS NULL` で集計）。
- `task_links` ではUNIQUE制約があるため、論理削除タスクの行が残ると**再取り込み時にINSERTが失敗**する。
- **決定**: `delete-task` / `delete-tasks` 実行時に、そのタスクの `task_links` 行を**物理削除**する（リンクは派生情報で、外部側が正本。タスク本体は論理削除のまま残る）。`task_events` に履歴が残るので追跡性は保たれる。
- 完了（`done`）ではリンクを消さない。

### 4.3 既存列との関係
`tasks.github_issue_number` / `github_issue_url` は残す（D4）。GitHubの `task_links` への移行は後続タスク。

### 4.4 公開フォーマット（board / `GET /api/task/:id`）
タスクのレスポンスに `links` を追加する（**追加のみ、既存キーは変えない**）。
```json
"links": [
  { "linkId": "redmine-1", "provider": "redmine", "externalId": "123", "url": "https://redmine.example.com/redmine/issues/123" }
]
```
リンクなしは空配列。これはAPI形状の変更なので `package.json` の version を **2.1.12 → 2.2.0**（後方互換の追加＝minor）に上げ、ルール4箇所の対応バージョン表記を同期する（BT-212のルール。BT-349の作業に含める）。

---

## 5. 連携アダプタ（共通インターフェース）

### 5.1 ファイル構成（新規）
```
backlog-dashboard/
  integrations/
    credentials.js     # integration-credentials.json の読み書き・github互換統合・hasToken化
    http.js            # 共通HTTPクライアント（タイムアウト・TLS設定・エラー分類）
    redmine.js         # Redmineアダプタ（parseUrl / testConnection / listIssues / getIssue）
    gitlab.js          # GitLabアダプタ（REST + GraphQL）
    index.js           # provider名 → アダプタの解決
  db/
    task-links-repo.js # task_linksのCRUD
  public/
    integrations.js    # 設定UI・取り込みダイアログ（providerを意識しない共通UI）
```
`server.js` は**ルーティングと入出力だけ**にして、ロジックは上記へ（server.jsの肥大化回避。移植元でも同じ方針を取っていた）。依存パッケージは増やさない（Node標準の `http`/`https`、現行 `ws` のみ）。

### 5.2 アダプタIF
```js
// 各アダプタ（redmine.js / gitlab.js）が export する
parseUrl(url)                      // -> { host, ref } | null   ref: Redmine=projectIdentifier / GitLab=projectPath
testConnection(conn)               // -> { stages: [{ name, ok, detail, hint? }], ok }
listIssues(conn, opts)             // -> { issues: NormalizedIssue[], warnings: string[] }
getIssue(conn, externalId)         // -> NormalizedIssue | null
```
読み取り専用のIFのみ。書き戻し（`markLinked` 等）は将来の拡張点で、今回は定義しない（D6）。
`conn` は `{ provider, host, ref, token, allowInsecureTls }`（トークンはサーバー内部のみ）。

### 5.3 正規化issue（NormalizedIssue）
```js
{
  externalId: "123",          // 文字列
  title: "...",
  description: "...",         // 本文をそのまま（変換しない。後述）
  state: "open" | "closed",
  statusName: "進行中",        // 表示用（Redmineのステータス名 / GitLabは state 文字列）
  url: "https://.../issues/123",
  parentExternalId: "100" | null,   // 親
  children: [ { externalId, title, state } ]   // 子（最大2階層）
}
```

### 5.4 provider別の取得方法
| 観点 | Redmine | GitLab |
|---|---|---|
| 認証ヘッダ | `X-Redmine-API-Key: <token>`（URLにキーを出さない） | `PRIVATE-TOKEN: <token>` |
| 疎通/認証確認 | `GET {host}/users/current.json` | `GET {host}/api/v4/user` |
| プロジェクト確認 | `GET {host}/projects/{identifier}.json`（名称・トラッカー一覧を取得） | `GET {host}/api/v4/projects/{url-encoded path}` |
| 一覧 | `GET {host}/issues.json?project_id={id}&status_id=*&limit=100&offset=N`（`total_count` まで繰り返し） | `GET {host}/api/v4/projects/{path}/issues?state=all&per_page=100&page=N`（`X-Next-Page` が空になるまで） |
| 完了判定 | `GET {host}/issue_statuses.json` の `is_closed` で判定（issuesのstatusに `is_closed` は含まれない） | `state === 'closed'` |
| 親子 | issueに `parent.id` が含まれるため**一覧から親子を組み立て可能**（追加リクエスト不要）。トラッカー絞り込み時も、取得自体は絞らず表示側で絞る | RESTでは親子が取れない。**GraphQL** `POST {host}/api/graphql` の `project(fullPath).workItems(iids)` → `widgets` の `WorkItemWidgetHierarchy.children.nodes{iid title state}` |
| 件数上限（安全弁） | 5,000件で打ち切り＋warning | 同左 |

注意点（移植元で判明した知見）:
- GitLab sub-issue のGraphQLは `iids` に**文字列配列**を要求する。
- GitLab CE(Free) でも HIERARCHY widget は利用可能（移植元は v18.1.4 CE で確認）。**他バージョンは実機で要確認**（検証手順書に項目あり）。
- Redmineは `/redmine/` のようなサブパス設置が普通。ホスト＝サブパス込みのベースURL。

### 5.5 本文（description）の扱い
- 取り込み時は**変換せずそのまま** `tasks.description` に入れる（RedmineはTextile/Markdown設定により書式が異なる、GitLabはMarkdown。完全な相互変換はしない）。
- 書き戻し（マーカー付与・書式変換。移植元の `toRedmineText` / `toGitlabMarkdown` を含む）は**今回は入れない**。必要になったら別タスク。

---

## 6. API仕様

### 6.1 共通ルール
- 既存規約に従う: Content-Type は `application/json`（`charset` を付けない）、レスポンスは `{ ok: true, ... }`、エラーは `{ error: "..." }`。
- 書き込み系は成功時に `broadcast(buildBoard())` する。
- AI実行者の `actor` は取り込み・紐付けの `created_by` に使う（未指定は `"user"`）。
- 全APIで、`prefix` はconfig.jsonの `projects[].prefix`、連携は `linkId` で指定する。未知のprefix/linkIdは404。

### 6.2 連携設定
| メソッド/パス | 内容 |
|---|---|
| `GET /api/integrations?prefix=BT` | 連携一覧。各要素 `{ id, provider, label, url, host, ref, hasToken, allowInsecureTls }`。tokenは返さない。`github` は互換統合で付与（読み取り専用フラグ `readonly: true`） |
| `POST /api/integrations` | `{ prefix, id?, provider, label?, url, token?, allowInsecureTls? }` で追加/更新（upsert）。`id` 省略で追加（`<provider>-<連番>` を採番）。`token` 未指定は既存保持、`""` は削除。URLがparseUrlで分解できなければ400。provider不明は400 |
| `POST /api/integrations/delete` | `{ prefix, id }` 設定を削除。**紐付け済み `task_links` があれば409**（孤立防止。先に解除が必要） |

### 6.3 接続テスト（段階別診断）
`POST /api/integration-test` `{ prefix, linkId }` → 常にHTTP 200で診断結果を返す（接続失敗は「診断結果」であってAPIエラーではない）。
```json
{
  "ok": true,
  "connected": false,
  "stages": [
    { "name": "url",      "ok": true,  "detail": "host=https://redmine.example.com/redmine, project=sample-project" },
    { "name": "reach",    "ok": true,  "detail": "HTTP 200 (320ms)" },
    { "name": "auth",     "ok": false, "detail": "HTTP 401", "hint": "APIキーが無効です。Redmineの「個人設定」→「APIアクセスキー」を確認してください" },
    { "name": "project",  "ok": null,  "detail": "認証に失敗したためスキップ" },
    { "name": "features", "ok": null,  "detail": "スキップ" }
  ]
}
```
| stage | 内容 | 主な失敗と `hint` |
|---|---|---|
| `url` | URL分解 | 形式不正。期待するURLの例を示す |
| `reach` | ホストへHTTP到達（疎通・TLS・タイムアウト） | `ENOTFOUND`=名前解決失敗 / `ECONNREFUSED`=ポート閉 / `ETIMEDOUT`=ネットワーク・プロキシ / `CERT_*`=TLS検証失敗（`allowInsecureTls` を案内） |
| `auth` | トークン検証（users/current, /user） | 401=キー無効 / 403=権限不足 / REST API無効（Redmine: 管理→設定→API→「RESTによるWebサービスを有効にする」） |
| `project` | プロジェクト存在・参照権限 | 404=識別子/パス違い、またはメンバーでない（GitLabは権限がないと404になる点を明記） |
| `features` | 追加機能の確認。GitLab: GraphQL HIERARCHY（sub-issue）が使えるか／Redmine: `issue_statuses.json` が読めるか | 使えない場合は「親子取り込みは単独issueのみになる」旨のwarningにし、**失敗扱いにはしない**（`ok:false` でも全体の接続可否 `connected` には影響させない仕様。`detail` で明示） |

各stageは**前段が失敗したら後段は `ok:null`（スキップ）**。`connected` は `url〜project` がすべて成功で `true`。トークンはdetail/hintに含めない。

### 6.4 一覧・取り込み
| メソッド/パス | 内容 |
|---|---|
| `GET /api/integration-issues?prefix=BT&linkId=redmine-1[&trackerId=N]` | 正規化issue一覧（closed含む全件）。各要素に `imported`（bool）・`importedTaskId`（取り込み済みなら `BT-xxx`）・`children[]`（各子にも `imported`）を付与。`warnings[]`（件数上限・GraphQL不可など）も返す。Redmineは `trackers[]` も返す（絞り込みUI用） |
| `POST /api/integration-import` | `{ prefix, linkId, ids: ["123", ...], actor? }`。選択issueをタスクとして取り込む（§7） |

### 6.5 紐付け（既存タスク ↔ 外部issue）
| メソッド/パス | 内容 |
|---|---|
| `POST /api/integration-link` | `{ taskId, linkId, externalId, actor? }`。外部issueの存在を `getIssue` で確認してから `task_links` に登録。**同じ `(workspace, linkId, externalId)` が使用済みなら400**、そのタスクが同じ linkId に既に紐付いていれば400 |
| `POST /api/integration-unlink` | `{ taskId, linkId }`。`task_links` 行を削除（外部issue側の目印は消さない） |

### 6.6 エラー/ステータス規約
| 状況 | HTTP |
|---|---|
| 入力不足・形式不正・重複紐付け・未設定連携 | 400 |
| 未知のprefix / linkId / taskId | 404 |
| 連携先（Redmine/GitLab）からのエラー・到達不可 | 502（`error` に分類済みの理由。トークンは含めない） |
| 削除不可（紐付け残存） | 409 |

---

## 7. 取り込みの挙動（`POST /api/integration-import`）

1. 連携設定を解決 → 選択idの**最新状態を取り直す**（一覧表示後に外部側が変わっている可能性があるため）。
2. 親子構造は `parentExternalId` / `children` から決める。**タスクの親子は2階層まで**（既存仕様）。3階層目以降のissueは取り込まず `warnings` に出す。
3. 各issueについて:
   - `(workspace, linkId, externalId)` が既に使用済み → `skipped`（`already imported`）
   - 子を持つissue → 親タスクとして作成し、**子は親の直下**に一括作成
   - 子を持たないissue → 単発タスク
   - 既に取り込み済みの親に、未取り込みの子が増えていた場合は、**その子だけ既存の親の下に追加**する
   - 子issueを**単独では取り込めない**（親経由のみ。現行GitHub取り込みと同じ）。親がこの連携のプロジェクトに存在しない場合は単独扱い
4. タスク作成は既存の `tasksRepo.create` を使う（採番・イベント記録は既存の経路）。
   - `title` ← issueのタイトル
   - `description` ← 本文（変換しない）
   - `status` ← open→`todo` / closed→`done`
   - `closed` の場合、`completed_at` は**取り込み日時**になる（既存の完了処理を流用するため。外部側の実際のclosed日時とは一致しない。既知の制限として記録）
5. `task_links` に登録（url はissueのWeb URL）。
6. 外部issue側へは何も書き込まない（読み取りのみ。D6）。
7. レスポンス: `{ ok:true, imported:[{externalId,taskId,parentTaskId?}], skipped:[...], errors:[...], warnings:[...] }`。1件の失敗が他の件を止めない。

トランザクション: 1issueごと（親+その子）を1単位としてDBトランザクションにする。途中失敗で親だけ残るのを避ける。

---

## 8. UI（public/integrations.js）

- 既存の設定ダイアログに「外部連携」節を追加。**現行のGitHub設定UIは触らず**、その下に「連携を追加」を置く。
  - ワークスペース選択 → 連携一覧（provider アイコン・label・URL・トークン設定済みバッジ）
  - 追加/編集フォーム: provider選択、label、URL、トークン、`allowInsecureTls`
  - 「接続テスト」ボタン → 段階別診断を**チェックリスト形式**で表示（✓/✗/－ と hint）
- 取り込みダイアログ（連携ごとに開く）: 一覧、取り込み済み/closedの表示フィルタ、親子の展開、Redmineはトラッカー絞り込み、複数選択して「取り込む」。現行GitHub取り込みダイアログ（`app.js` のBT-106系）と見た目・操作を揃える。
- タスクカード/詳細に、`links` のバッジ（providerアイコン＋外部ID、クリックで外部issueを開く）。紐付け/解除の操作。
- アイコンは `public/icons/` に provider別SVGを追加（移植元の `gitlab-icon.svg` / `redmine-icon.svg` を参考にするが、**ライセンス/商標に配慮して自作の簡易アイコンで可**）。

---

## 9. 非機能・運用上の論点

| 論点 | 方針 |
|---|---|
| TLS | 社内CA/自己署名で検証失敗する環境がありうる。既定は検証ON。`allowInsecureTls:true`（連携単位）でのみ緩和し、UIに警告を出す。まずは `NODE_EXTRA_CA_CERTS` での対処を hint で案内（推奨） |
| プロキシ | Node標準の `https` はシステムプロキシを自動では使わない。会社PCで必要になる可能性が高い。**今回は対応しないが**、接続テストの `reach` で ETIMEDOUT になった際の hint に「プロキシ環境の可能性」を明記し、別タスク化の判断材料にする（検証で顕在化したら対応） |
| タイムアウト | 1リクエスト15秒（移植元と同じ）。一覧取得は全体で上限あり |
| レート/件数 | 100件ずつページング、安全弁5,000件。超過は warnings |
| 文字コード | JSONは常にUTF-8。外部API応答もUTF-8前提 |
| ログ | リクエストURLは出してよいが、`Authorization`/`X-Redmine-API-Key`/`PRIVATE-TOKEN` とクエリの `key=` はログに出さない |
| 並行 | 取り込みはサーバー内で直列化（同一連携の同時取り込みで二重登録しないよう、UNIQUE制約を最終防衛線にする） |
| 互換 | 既存API・既存列の形状は変更しない（`links` の追加のみ）。`apiVersion` は 2.2.0 |

---

## 10. 検証戦略（実機がない前提）

実機の状況: Redmine は WSL のDockerコンテナ（Redmine 6.0.5、REST API有効、検証用の親子issueを投入済み）で実機検証できる。GitLab は手元になし。実機検証は別PC（社内のRedmine/GitLabがある環境）で行う。

| 層 | 何を確認するか | どこで | タスク |
|---|---|---|---|
| ① モックサーバー自動テスト | URL分解、ページング、親子組み立て（Redmine）、GraphQL親子（GitLab）、取り込み/スキップ/重複、1件失敗時に他の件を止めないこと、接続テストの各stageの失敗パターン（401/403/404/接続拒否/タイムアウト） | ここ（`node --test`） | BT-352 |
| ② Redmine実機 | モックでは拾えない実レスポンス差（バージョン差、ステータスのis_closed、サブパス設置） | WSLコンテナ（可能なら）/ 別PC | BT-352 |
| ③ GitLab実機 | REST一覧、GraphQL HIERARCHY、権限不足時の挙動、PAT scope | 別PC | BT-352（手順書） |
| ④ 検証手順書 | 別PCで上から順に実施できるチェックリスト。期待結果・失敗時の見方（接続テストのstageと対応） | `design-docs/integration-verification-checklist.md` | BT-352 |

モックの方針:
- Node標準 `http` で偽Redmine/偽GitLabサーバーをテスト内で起動（ポートは0指定で自動割当）。外部依存なし。
- fixtureは、移植元で判明した**実際のレスポンス形**（Redmineの `issues.json` の `parent`/`status`、`issue_statuses.json` の `is_closed`、GitLab RESTのissue、GraphQLの `widgets[type=HIERARCHY].children.nodes`）に合わせる。
- モックは**仕様の取り違えを防ぐ**ものであって、実機の代替ではない。実機でしか分からないもの（バージョン差・権限・証明書・プロキシ）は手順書に項目として残す。

---

## 11. 実装タスクへの割り当て

| タスク | 内容 | 主な成果物 |
|---|---|---|
| BT-349 基盤 | `task_links` DDL＋repo、`integrations/credentials.js`・`http.js`・`index.js`、連携設定API、`links` のboard/task出力、delete時のリンク削除、version 2.2.0、ルール4箇所同期、example/gitignore | `db/task-links-repo.js`, `integrations/*`, server.js |
| BT-350 Redmine | `integrations/redmine.js`、一覧/取り込み/紐付けAPIのprovider実装、接続テスト、UI | `integrations/redmine.js`, `public/integrations.js` |
| BT-351 GitLab | `integrations/gitlab.js`（REST＋GraphQL）、同上 | `integrations/gitlab.js` |
| BT-352 テスト＋手順書 | モックサーバー、自動テスト、検証チェックリスト | `test/integrations/*`, `design-docs/integration-verification-checklist.md` |

依存順: BT-349 → (BT-350, BT-351 は並行可) → BT-352（モックはBT-350/351と並行して育ててよい）。

---

## 12. レビュー結果（旧・未決事項。2026-10-04 確定）

| # | 論点 | 決定 |
|---|---|---|
| Q1 | 書き戻し（D6）を今回のスコープに含めるか | **含めない**（読み取りのみ）。合意済みスコープ「取り込み＋紐付けまで」に合わせる。必要になったら別タスクで `writeBack`（既定OFF）を導入 |
| Q2 | 論理削除時に `task_links` を物理削除（§4.2） | 物理削除（再取り込みを可能にするため）。`task_events` に履歴は残る |
| Q3 | GitHubを今回 `task_links` に載せない（D4） | 載せない（今は）。後続タスクで移行（既存列→`task_links` のbackfillを伴う） |
| Q4 | プロキシ対応を今回見送る（§9） | 見送り。会社PC検証で必要と分かった時点で別タスク化 |
| Q5 | GitLabのサブパス設置を非対応にする（§3.6） | 非対応で開始 |
| Q6 | 取り込んだclosedの完了日時を外部のclosed日時にするか | 取り込み日時のまま（既存処理の流用）。差が問題になれば別タスク |
