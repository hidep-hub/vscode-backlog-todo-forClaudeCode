'use strict';

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
  return { db, directory };
}

function cleanup({ db, directory }) {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

const NOW = '2026-10-12T00:00:00.000Z';

function insertTag(db, workspace, name, nameKey) {
  return db.prepare(
    'INSERT INTO tags (workspace, name, name_key, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(workspace, name, nameKey, NOW, 'user', NOW, 'user').lastInsertRowid;
}

function attach(db, taskId, tagId) {
  db.prepare('INSERT INTO task_tags (task_id, tag_id, created_at, created_by) VALUES (?, ?, ?, ?)')
    .run(taskId, tagId, NOW, 'user');
}

test('createSchema adds tag tables to an existing DB without touching tasks and is re-runnable', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'keep me', status: 'todo' });
    fixture.db.exec('DROP TABLE task_tags; DROP TABLE tags;');

    createSchema(fixture.db);
    createSchema(fixture.db);

    const names = fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(names.includes('tags'));
    assert.ok(names.includes('task_tags'));
    const columns = fixture.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    assert.ok(!columns.some((c) => c.includes('tag')), 'tasks table must not gain tag columns');
    assert.equal(fixture.db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id).title, 'keep me');
  } finally {
    cleanup(fixture);
  }
});

test('tags are unique per workspace by name_key, not across workspaces', () => {
  const fixture = createTestDb();
  try {
    insertTag(fixture.db, 'test', 'Backend', 'backend');
    assert.throws(() => insertTag(fixture.db, 'test', 'BACKEND', 'backend'), /UNIQUE/);
    assert.doesNotThrow(() => insertTag(fixture.db, 'other', 'Backend', 'backend'));
  } finally {
    cleanup(fixture);
  }
});

test('task_tags allows multiple tags per task, rejects duplicates and cascades on tag delete', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'tagged', status: 'todo' });
    const a = insertTag(fixture.db, 'test', 'A', 'a');
    const b = insertTag(fixture.db, 'test', 'B', 'b');
    attach(fixture.db, task.id, a);
    attach(fixture.db, task.id, b);
    assert.throws(() => attach(fixture.db, task.id, a), /UNIQUE|PRIMARY/);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM task_tags WHERE task_id = ?').get(task.id).n, 2);

    fixture.db.prepare('DELETE FROM tags WHERE id = ?').run(a);
    const rest = fixture.db.prepare('SELECT tag_id FROM task_tags WHERE task_id = ?').all(task.id);
    assert.deepEqual(rest.map((r) => Number(r.tag_id)), [Number(b)]);
  } finally {
    cleanup(fixture);
  }
});

test('task_tags rejects unknown tasks and tags (foreign keys)', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'fk', status: 'todo' });
    const tag = insertTag(fixture.db, 'test', 'A', 'a');
    assert.throws(() => attach(fixture.db, task.id, 9999), /FOREIGN KEY/);
    assert.throws(() => attach(fixture.db, 9999, tag), /FOREIGN KEY/);
  } finally {
    cleanup(fixture);
  }
});
