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
];

// BT-182決定: 保留廃止、todo/ready/do/doneの4値
const STATUS_SEED = [
  { code: 'todo', label: '未着手', sort_order: 1 },
  { code: 'ready', label: '未着手（素材あり）', sort_order: 2 },
  { code: 'do', label: '進行中', sort_order: 3 },
  { code: 'done', label: '完了', sort_order: 4 },
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
];

/**
 * DB接続に対しPRAGMAの設定とテーブル作成、マスターデータの初期投入を行う。
 * 既存DBに対して呼んでも安全（IF NOT EXISTS / INSERT OR IGNORE）。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createSchema(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  db.exec('BEGIN');
  try {
    for (const stmt of DDL) db.exec(stmt);

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
