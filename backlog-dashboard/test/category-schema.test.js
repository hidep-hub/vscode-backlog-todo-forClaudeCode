'use strict';

// BM-105: categoriesテーブルのスキーマ(既存tasksへの非破壊・システム全体で一意なUNIQUE制約)を検証する。
// タグはワークスペース単位だが、カテゴリは「システムで一意」(ヒデさんの運用認識)のため
// ワークスペース列を持たない。tag-schema.test.jsと同じ観点だが、そこが最大の違い。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');

function createTestDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-dashboard-test-'));
  const db = new DatabaseSync(path.join(directory, 'backlog.sqlite3'));
  createSchema(db);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('test', 'TS', 1);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('other', 'OT', 1);
  return { db, directory };
}

function cleanup({ db, directory }) {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

const NOW = '2026-10-19T00:00:00.000Z';

function insertCategory(db, name, nameKey) {
  return db.prepare(
    'INSERT INTO categories (name, name_key, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, nameKey, NOW, 'user', NOW, 'user').lastInsertRowid;
}

test('createSchema adds the categories table to an existing DB without touching tasks.category, and is re-runnable', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'keep me', status: 'todo', category: 'Infra' });
    fixture.db.exec('DROP TABLE categories;');

    createSchema(fixture.db);
    createSchema(fixture.db);

    const names = fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(names.includes('categories'));
    const columns = fixture.db.prepare('PRAGMA table_info(categories)').all().map((c) => c.name);
    assert.ok(!columns.includes('workspace'), 'categoriesテーブルはワークスペース列を持たない(システム全体で一意)');
    assert.equal(fixture.db.prepare('SELECT category FROM tasks WHERE id = ?').get(task.id).category, 'Infra');
  } finally {
    cleanup(fixture);
  }
});

test('categories are unique by name_key across the whole system, not scoped per workspace', () => {
  const fixture = createTestDb();
  try {
    insertCategory(fixture.db, 'Infra', 'infra');
    // ワークスペース列が無いため、別ワークスペースのタスクに使う想定でも同じ名前の2件目は拒否される
    assert.throws(() => insertCategory(fixture.db, 'INFRA', 'infra'), /UNIQUE/);
  } finally {
    cleanup(fixture);
  }
});

test('category_changed event type is seeded so existing DBs gain it on upgrade', () => {
  const fixture = createTestDb();
  try {
    fixture.db.prepare("DELETE FROM event_types WHERE code = 'category_changed'").run();
    createSchema(fixture.db);
    const codes = fixture.db.prepare('SELECT code FROM event_types').all().map((r) => r.code);
    assert.ok(codes.includes('category_changed'));
  } finally {
    cleanup(fixture);
  }
});

test('migrates a pre-existing workspace-scoped categories table to the system-wide schema, preserving data', () => {
  const fixture = createTestDb();
  try {
    // 旧スキーマ(workspace単位、BM-105初回実装)を模してテーブルを作り直す
    fixture.db.exec('DROP TABLE categories;');
    fixture.db.exec(`CREATE TABLE categories (
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
    )`);
    const insert = fixture.db.prepare(`INSERT INTO categories
      (workspace, name, name_key, color, sort_order, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('test', 'Infra', 'infra', '#336699', 1, NOW, 'user', NOW, 'user');
    insert.run('test', 'Dev', 'dev', null, 2, NOW, 'user', NOW, 'user');
    // 別ワークスペースに表記ゆれ違いの重複(Infra vs infra)を仕込み、統合されることを確認する
    insert.run('other', 'infra', 'infra', '#e53935', 1, NOW, 'user', NOW, 'user');

    const t1 = tasksRepo.create(fixture.db, { workspace: 'test', title: 't1', status: 'todo', category: 'Infra' });
    const t2 = tasksRepo.create(fixture.db, { workspace: 'other', title: 't2', status: 'todo', category: 'infra' });

    createSchema(fixture.db); // 再起動を模す。ここで移行処理が走る

    const columns = fixture.db.prepare('PRAGMA table_info(categories)').all().map((c) => c.name);
    assert.ok(!columns.includes('workspace'), '移行後はworkspace列を持たない');

    const rows = fixture.db.prepare('SELECT name, name_key, color FROM categories ORDER BY name_key').all();
    assert.deepEqual(rows.map((r) => r.name_key), ['dev', 'infra']);
    // 先に登録された行(id昇順)の表記・色が正本として残る
    const infraRow = rows.find((r) => r.name_key === 'infra');
    assert.equal(infraRow.name, 'Infra');
    assert.equal(infraRow.color, '#336699');

    // 統合により表記が変わった分(other workspaceのタスクは'infra'表記だった)は、
    // tasks.categoryが正本の表記('Infra')に書き換えられる
    assert.equal(tasksRepo.getByDisplayId(fixture.db, t1.display_id).category, 'Infra');
    assert.equal(tasksRepo.getByDisplayId(fixture.db, t2.display_id).category, 'Infra');

    const names = fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(!names.includes('categories_bm105_migration_old'), '退避用テーブルは移行後に削除される');

    // 再度createSchemaを呼んでも(新スキーマに対しては)何も起きず、データはそのまま保たれる
    createSchema(fixture.db);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, 2);
  } finally {
    cleanup(fixture);
  }
});
