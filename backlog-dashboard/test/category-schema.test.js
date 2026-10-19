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
