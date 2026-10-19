'use strict';

// DB化(BT-169)フェーズ0(BT-175)の設計記録に基づくスキーマ定義。
// 詳細: docs/design/backlog-db-schema-design-epic-bt169.md

const DDL = [
  // 依存関係のないマスターテーブルを先に作る（tasks.statusがstatuses(code)を参照するため）
  `CREATE TABLE IF NOT EXISTS statuses (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    icon TEXT NULL,
    color TEXT NULL,
    sort_order INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_types (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    icon TEXT NULL,
    color TEXT NULL,
    sort_order INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    seq_no INTEGER NOT NULL,
    display_id TEXT NOT NULL UNIQUE,
    parent_id INTEGER NULL REFERENCES tasks(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL REFERENCES statuses(code),
    category TEXT NULL,
    description TEXT NULL,
    assignee TEXT NULL,
    start_date TEXT NULL,
    due_date TEXT NULL,
    github_issue_number INTEGER NULL,
    github_issue_url TEXT NULL,
    commit_hash TEXT NULL,
    sort_order INTEGER NOT NULL,
    completed_at TEXT NULL,
    deleted_at TEXT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    UNIQUE(workspace, seq_no)
  )`,
  `CREATE TABLE IF NOT EXISTS counters (
    workspace TEXT PRIMARY KEY,
    prefix TEXT NOT NULL,
    next_seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deliverables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    description TEXT NULL,
    path TEXT NULL,
    sort_order INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pins (
    workspace TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    pinned_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS running_tasks (
    workspace TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    started_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_execution_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    agent_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    stopped_at TEXT NULL,
    stopped_by TEXT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_execution_sessions_active
    ON task_execution_sessions(task_id, stopped_at)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    task_display_id TEXT NOT NULL,
    event_type TEXT NOT NULL REFERENCES event_types(code),
    old_value TEXT NULL,
    new_value TEXT NULL,
    actor TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  )`,
  // BT-392: タグ機能(EPIC BT-391)。tasksは拡張せず、deliverables/pinsと同じ付随テーブル方式で持つ。
  // name_keyは表記ゆれ(大小文字・全半角・前後空白)を正規化した重複判定用キーで、生成はアプリ側(BT-393)。
  // UNIQUE(workspace, name_key)により、同一ワークスペース内の似たタグ乱立をDBレベルでも防ぐ。
  `CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    color TEXT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    UNIQUE(workspace, name_key)
  )`,
  // タグ削除・統合時に付与行が残らないよう、tag_id側はON DELETE CASCADE。
  // タスクは論理削除のためtask_id側のCASCADEは不要(付与は論理削除後も保持される)。
  `CREATE TABLE IF NOT EXISTS task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (task_id, tag_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id)`,
  // BM-105: カテゴリ機能(EPIC BM-101)。name_key正規化・重複/類似名チェック・sort_orderは
  // tagsと同じ骨格だが、カテゴリは「システムで一意」(ヒデさんの運用認識)のためワークスペース
  // 列を持たない(タグはワークスペース単位だが、カテゴリは全ワークスペース共通の名前空間)。
  // 1タスク1カテゴリのため中間テーブルも持たず、tasks.category列(既存の非正規化列)に
  // 名前文字列をそのまま保存する。UNIQUE(name_key)により、似た名前の乱立をDBレベルでも防ぐ。
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    color TEXT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  )`,
  // BM-071: 外部ITS(Redmine/GitLab)連携の基盤。GitHubは既存のtasks.github_issue_*列のまま触らず、
  // Redmine/GitLabはこの新テーブルをsource列で共用する(1タスクにつきsourceごとに1件まで)。
  // 重複判定(同じチケットを二重取り込みしないか)はコード側(source/host/project_ref/issue_keyの
  // 組で判定)で行うため、専用のインデックスを用意する。
  `CREATE TABLE IF NOT EXISTS task_external_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    source TEXT NOT NULL,
    host TEXT NOT NULL,
    project_ref TEXT NOT NULL,
    issue_key TEXT NOT NULL,
    issue_url TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    linked_by TEXT NOT NULL,
    UNIQUE(task_id, source)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_external_links_issue
    ON task_external_links(source, host, project_ref, issue_key)`,
];

// BM-081: タイトル・本文(description)のサーバー側全文検索用FTS5仮想テーブル。
// 外部コンテンツ方式(content='tasks', content_rowid='id')で本文を複製せず、
// tasks.title/descriptionへの参照インデックスのみを持つ(ディスク使用量の二重化を避ける)。
// tokenize='trigram'を採用した理由: デフォルトのunicode61トークナイザは空白区切りを
// 前提にしており、分かち書きしない日本語ではMATCHが一切ヒットしないことを実機検証で確認した
// (node:sqlite 3.51.2)。trigramは3文字単位の部分一致インデックスのため、日本語の
// 単語境界に依存せず検索できる(「ウザのパ」のような単語境界を無視した部分文字列もヒットする)。
const FTS_DDL = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
    title, description, content='tasks', content_rowid='id', tokenize='trigram'
  )`,
  // tasksへのINSERT/UPDATE/DELETEにtasks_ftsを追従させる(外部コンテンツ方式の定石: UPDATE/DELETEは
  // 'delete'コマンドで旧内容を明示的に消してから入れ直す必要がある。SQLite公式ドキュメントの
  // 外部コンテンツテーブルの推奨トリガーパターンに準拠)。
  `CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
    INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
  END`,
  `CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
    INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
  END`,
  `CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
    INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
    INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
  END`,
];

// BT-182決定: 保留廃止、todo/ready/do/doneの4値
// BT-178(2026-09-05追記): labelを日本語から英語表記に変更(design doc参照)。
// READYの意味も「素材あり」から「着手する意思決定済み・いつでも始められる状態」に再定義
const STATUS_SEED = [
  { code: 'todo', label: 'TODO', sort_order: 1 },
  { code: 'ready', label: 'READY', sort_order: 2 },
  { code: 'do', label: 'DO', sort_order: 3 },
  { code: 'done', label: 'DONE', sort_order: 4 },
];

const EVENT_TYPE_SEED = [
  { code: 'created', label: '作成', sort_order: 1 },
  { code: 'status_changed', label: 'ステータス変更', sort_order: 2 },
  { code: 'pinned', label: '今日やるに追加', sort_order: 3 },
  { code: 'unpinned', label: '今日やるから解除', sort_order: 4 },
  { code: 'running_started', label: '実行中に設定', sort_order: 5 },
  { code: 'running_stopped', label: '実行中を解除', sort_order: 6 },
  { code: 'assigned', label: '担当変更', sort_order: 7 },
  { code: 'deleted', label: '削除', sort_order: 8 },
  { code: 'due_date_changed', label: '期日変更', sort_order: 9 },
  // BT-393: タグ付け外し。old_value/new_valueにはタグ名を記録する
  { code: 'tag_added', label: 'タグ追加', sort_order: 10 },
  { code: 'tag_removed', label: 'タグ解除', sort_order: 11 },
  // BM-105: カテゴリ変更。old_value/new_valueにはカテゴリ名(無しはnull)を記録する
  { code: 'category_changed', label: 'カテゴリ変更', sort_order: 12 },
];

/**
 * BM-105方針転換(workspace単位→システム全体で一意)の移行処理。
 * 旧スキーマ(workspace列あり、UNIQUE(workspace, name_key))のcategoriesテーブルが
 * 存在する場合、新スキーマ(workspace列なし、UNIQUE(name_key))へ安全に移行する。
 * 新スキーマに対して呼んでも何もしない(CREATE TABLE IF NOT EXISTSより前に判定するため)。
 *
 * 移行手順:
 * 1. 旧テーブルをリネームして退避する
 * 2. 新スキーマで categories テーブルを作り直す
 * 3. 旧データをname_keyでグルーピングし、各グループの先頭行(id昇順)を正本として1件だけ挿入する
 *    (同名カテゴリが複数ワークスペースに存在した場合、tagsのmergeTagsと同じ考え方で1件に統合する)
 * 4. 統合によって名前表記が変わった分(表記ゆれ違いの重複があった場合)は、該当する
 *    tasks.category列を正本の名前に書き換える(name_keyが同じでも大文字小文字等が
 *    異なれば別の文字列として保存されているため、統合後の表記に揃える必要がある)
 * 5. 退避した旧テーブルを削除する
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrateCategoriesWorkspaceScopeIfNeeded(db) {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'categories'"
  ).get();
  if (!existing || !/\bworkspace\b/.test(existing.sql)) return; // 未作成、または既に新スキーマなら何もしない

  db.exec('ALTER TABLE categories RENAME TO categories_bm105_migration_old;');
  db.exec(`CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    color TEXT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  )`);

  const oldRows = db.prepare('SELECT * FROM categories_bm105_migration_old ORDER BY id').all();
  const primaryByKey = new Map(); // name_key -> 正本として採用した旧行
  const renamePairs = []; // 統合により表記が変わるタスク用 {from, to}
  for (const row of oldRows) {
    const primary = primaryByKey.get(row.name_key);
    if (!primary) {
      primaryByKey.set(row.name_key, row);
    } else if (row.name !== primary.name) {
      renamePairs.push({ from: row.name, to: primary.name });
    }
  }

  const insertCategory = db.prepare(`INSERT INTO categories
    (name, name_key, color, sort_order, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let sortOrder = 0;
  for (const row of primaryByKey.values()) {
    sortOrder += 1;
    insertCategory.run(row.name, row.name_key, row.color, sortOrder, row.created_at, row.created_by, row.updated_at, row.updated_by);
  }

  const updateTaskCategory = db.prepare('UPDATE tasks SET category = ? WHERE category = ?');
  for (const { from, to } of renamePairs) {
    updateTaskCategory.run(to, from);
  }

  db.exec('DROP TABLE categories_bm105_migration_old;');
}

/**
 * DB接続に対しPRAGMAの設定とテーブル作成、マスターデータの初期投入を行う。
 * 既存DBに対して呼んでも安全（IF NOT EXISTS / INSERT OR IGNORE）。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createSchema(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  // BM-081: tasks_ftsが今回初めて作られる(=トリガー導入前の既存データがバックフィル未済)かどうかを
  // DDL実行前に判定しておく。既に存在する場合は毎起動時のrebuildを避ける(812件で約300ms、
  // 起動のたびに走らせる価値が無い)。
  const ftsTableExistedBefore = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks_fts'"
  ).get();

  db.exec('BEGIN');
  try {
    // BM-105方針転換: DDL(CREATE TABLE IF NOT EXISTS)より前に、旧workspace単位スキーマからの
    // 移行を行う(IF NOT EXISTSは「存在すれば何もしない」ため、ここで先に新スキーマへ揃えておく必要がある)。
    migrateCategoriesWorkspaceScopeIfNeeded(db);

    for (const stmt of DDL) db.exec(stmt);
    for (const stmt of FTS_DDL) db.exec(stmt);

    // BM-081: 既存データ(トリガー導入前にINSERTされた行)をtasks_ftsへ反映する。
    // 【実機検証で判明した罠】トリガーは「トリガー作成後に行われたINSERT/UPDATE/DELETE」にしか
    // 発火しないため、トリガー作成前からtasksに存在していた行は、素朴なバックフィルINSERT
    // (INSERT INTO tasks_fts(...) SELECT ... FROM tasks)を後から流しても、FTS5の転置インデックスには
    // 反映されない(rowid経由のcontent参照は成功するため「入っているように見える」が、
    // MATCHクエリは常に0件になる、という罠。SQLite公式ドキュメント4.4.4節で明記されている既知の挙動)。
    // 正しい対処は公式ドキュメント推奨の'rebuild'コマンド(INSERT INTO tasks_fts(tasks_fts)
    // VALUES('rebuild'))で、既存のcontentテーブル全体からインデックスを再構築する。
    // tasks_ftsが初めて作られた時(=既存データが眠っている可能性がある時)だけ実行し、
    // 2回目以降のサーバー起動では実行しない(トリガーが継続して整合性を保つため不要)。
    if (!ftsTableExistedBefore) {
      db.exec(`INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')`);
    }

    // BT-281: existing running tasks become open user sessions on first upgrade.
    db.exec(`INSERT INTO task_execution_sessions (task_id, agent_id, started_at)
      SELECT rt.task_id, 'user', rt.started_at
      FROM running_tasks rt
      WHERE NOT EXISTS (
        SELECT 1 FROM task_execution_sessions tes
        WHERE tes.task_id = rt.task_id AND tes.stopped_at IS NULL
      )`);

    const insertStatus = db.prepare(
      'INSERT OR IGNORE INTO statuses (code, label, icon, color, sort_order) VALUES (?, ?, NULL, NULL, ?)'
    );
    for (const s of STATUS_SEED) insertStatus.run(s.code, s.label, s.sort_order);

    const insertEventType = db.prepare(
      'INSERT OR IGNORE INTO event_types (code, label, icon, color, sort_order) VALUES (?, ?, NULL, NULL, ?)'
    );
    for (const e of EVENT_TYPE_SEED) insertEventType.run(e.code, e.label, e.sort_order);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { createSchema, STATUS_SEED, EVENT_TYPE_SEED };
