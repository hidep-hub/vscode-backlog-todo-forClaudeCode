'use strict';

// BT-336: 期日変更履歴(task_events due_date_changed)と、board/detailへのdueDateHistory反映を検証する

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const { buildBoardFromDb, buildTaskDetail } = require('../db/board');

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

function dueEvents(db, taskId) {
  return db.prepare(`SELECT old_value, new_value FROM task_events WHERE task_id = ? AND event_type = 'due_date_changed' ORDER BY id`)
    .all(taskId).map(({ old_value, new_value }) => ({ old_value, new_value }));
}

test('records due_date_changed only when the due date actually changes', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'due', status: 'todo', dueDate: '2026-09-29' });

    tasksRepo.updateFields(fixture.db, task.display_id, { dueDate: '2026-09-29' });
    tasksRepo.updateFields(fixture.db, task.display_id, { title: 'renamed' });
    assert.deepEqual(dueEvents(fixture.db, task.id), []);

    tasksRepo.updateFields(fixture.db, task.display_id, { dueDate: '2026-10-03' });
    tasksRepo.updateFields(fixture.db, task.display_id, { dueDate: '2026-10-10' });
    assert.deepEqual(dueEvents(fixture.db, task.id), [
      { old_value: '2026-09-29', new_value: '2026-10-03' },
      { old_value: '2026-10-03', new_value: '2026-10-10' },
    ]);
  } finally {
    cleanup(fixture);
  }
});

test('treats null and empty string as the same and records the first setting', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'no due', status: 'todo' });

    tasksRepo.updateFields(fixture.db, task.display_id, { dueDate: '' });
    assert.deepEqual(dueEvents(fixture.db, task.id), []);

    tasksRepo.updateFields(fixture.db, task.display_id, { dueDate: '2026-10-01' });
    assert.deepEqual(dueEvents(fixture.db, task.id), [{ old_value: null, new_value: '2026-10-01' }]);
  } finally {
    cleanup(fixture);
  }
});

test('exposes dueDateHistory (oldest first) on board items and task detail', () => {
  const fixture = createTestDb();
  try {
    const config = { projects: [{ file: 'test', name: 'Test' }], columns: [{ id: 'todo', label: 'TODO', match: ['todo'] }] };
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'due', status: 'todo', dueDate: '2026-09-29' });
    tasksRepo.updateFields(fixture.db, task.display_id, { dueDate: '2026-10-03' });

    const detail = buildTaskDetail(fixture.db, config, task.display_id);
    assert.equal(detail.dueDateHistory.length, 1);
    assert.equal(detail.dueDateHistory[0].from, '2026-09-29');
    assert.equal(detail.dueDateHistory[0].to, '2026-10-03');

    const boardItem = buildBoardFromDb(fixture.db, config).columns[0].items.find(i => i.id === task.display_id);
    assert.deepEqual(boardItem.dueDateHistory, detail.dueDateHistory);
  } finally {
    cleanup(fixture);
  }
});
