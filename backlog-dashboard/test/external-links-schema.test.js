'use strict';

// BM-071: task_external_linksテーブルの追加検証(既存DBへの非破壊性・UNIQUE制約)。

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

function insertLink(db, taskId, source) {
  return db.prepare(`INSERT INTO task_external_links
    (task_id, source, host, project_ref, issue_key, issue_url, linked_at, linked_by)
    VALUES (?, ?, 'http://host', 'proj', '1', 'http://host/issues/1', '2026-10-14T00:00:00.000Z', 'user')`)
    .run(taskId, source);
}

test('createSchema adds task_external_links to an existing DB without touching tasks and is re-runnable', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'keep me', status: 'todo' });
    fixture.db.exec('DROP TABLE task_external_links;');

    createSchema(fixture.db);
    createSchema(fixture.db);

    const names = fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(names.includes('task_external_links'));
    const columns = fixture.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    assert.ok(!columns.some((c) => c.includes('redmine') || c.includes('gitlab')), 'tasks table must not gain redmine/gitlab columns');
    assert.equal(fixture.db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id).title, 'keep me');
  } finally {
    cleanup(fixture);
  }
});

test('task_external_links allows one link per source per task, but different sources can coexist', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'linked', status: 'todo' });
    insertLink(fixture.db, task.id, 'redmine');
    assert.throws(() => insertLink(fixture.db, task.id, 'redmine'), /UNIQUE/);
    assert.doesNotThrow(() => insertLink(fixture.db, task.id, 'gitlab'));
    const rows = fixture.db.prepare('SELECT source FROM task_external_links WHERE task_id = ? ORDER BY source').all(task.id);
    assert.deepEqual(rows.map((r) => r.source), ['gitlab', 'redmine']);
  } finally {
    cleanup(fixture);
  }
});

test('task_external_links rejects unknown tasks (foreign key)', () => {
  const fixture = createTestDb();
  try {
    assert.throws(() => insertLink(fixture.db, 9999, 'redmine'), /FOREIGN KEY/);
  } finally {
    cleanup(fixture);
  }
});
