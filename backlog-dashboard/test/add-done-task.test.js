'use strict';

// BT-377: DONEで過去タスクを追加したとき、completed_atと履歴(created / status_changed)が
// 入力された完了日時を基準に記録されることを検証する

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const { buildBoardFromDb } = require('../db/board');

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

function events(db, taskId) {
  return db.prepare('SELECT event_type, old_value, new_value, occurred_at FROM task_events WHERE task_id = ? ORDER BY id')
    .all(taskId).map(e => ({ ...e }));
}

test('create with status done records completed_at and events at the given time', () => {
  const fixture = createTestDb();
  try {
    const at = '2026-09-01T06:30:00.000Z';
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'past', status: 'done', completedAt: at });
    assert.equal(task.completed_at, at);
    assert.deepEqual(events(fixture.db, task.id), [
      { event_type: 'created', old_value: null, new_value: null, occurred_at: at },
      { event_type: 'status_changed', old_value: null, new_value: 'done', occurred_at: at },
    ]);
  } finally {
    cleanup(fixture);
  }
});

test('create with status done and no completedAt falls back to now', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'now', status: 'done' });
    assert.ok(task.completed_at);
    assert.equal(events(fixture.db, task.id).at(-1).new_value, 'done');
  } finally {
    cleanup(fixture);
  }
});

test('create with non-done status ignores completedAt and keeps the single created event', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'todo', status: 'todo', completedAt: '2026-09-01T06:30:00.000Z' });
    assert.equal(task.completed_at, null);
    assert.deepEqual(events(fixture.db, task.id).map(e => e.event_type), ['created']);
  } finally {
    cleanup(fixture);
  }
});

test('board shows the JST completed date and time for a past DONE task', () => {
  const fixture = createTestDb();
  try {
    // 2026-09-01T20:30Z = JST 2026-09-02 05:30
    tasksRepo.create(fixture.db, { workspace: 'test', title: 'past', status: 'done', completedAt: '2026-09-01T20:30:00.000Z' });
    const config = { projects: [{ file: 'test', name: 'Test' }], columns: [{ id: 'done', label: 'DONE', match: ['done'] }] };
    const item = buildBoardFromDb(fixture.db, config).columns[0].items[0];
    assert.equal(item.completedDate, '2026-09-02');
    assert.equal(item.completedTs, '05:30:00');
  } finally {
    cleanup(fixture);
  }
});
