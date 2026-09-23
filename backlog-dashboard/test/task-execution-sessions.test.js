'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const { buildBoardFromDb, buildTaskDetail } = require('../db/board');
const { buildActivity } = require('../db/activity');

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

test('records the starting and stopping agents for an execution session', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'session test', status: 'todo' });

    tasksRepo.setRunning(fixture.db, 'test', task.display_id, true, 'codex');
    let session = fixture.db.prepare('SELECT * FROM task_execution_sessions WHERE task_id = ?').get(task.id);
    assert.equal(session.agent_id, 'codex');
    assert.equal(session.stopped_at, null);

    tasksRepo.setRunning(fixture.db, 'test', task.display_id, false, 'claude-code');
    session = fixture.db.prepare('SELECT * FROM task_execution_sessions WHERE task_id = ?').get(task.id);
    assert.notEqual(session.stopped_at, null);
    assert.equal(session.stopped_by, 'claude-code');

    const events = fixture.db.prepare('SELECT event_type, actor FROM task_events WHERE task_id = ? ORDER BY id').all(task.id)
      .map(({ event_type, actor }) => ({ event_type, actor }));
    assert.deepEqual(events.slice(-2), [
      { event_type: 'running_started', actor: 'codex' },
      { event_type: 'running_stopped', actor: 'claude-code' },
    ]);
  } finally {
    cleanup(fixture);
  }
});

test('marks activity events for a parent task as an EPIC', () => {
  const fixture = createTestDb();
  try {
    const parent = tasksRepo.create(fixture.db, { workspace: 'test', title: 'parent', status: 'do' });
    tasksRepo.create(fixture.db, { workspace: 'test', title: 'child', status: 'todo', parentDisplayId: parent.display_id });
    const config = { projects: [{ file: 'test', name: 'Test' }] };

    const parentEvent = buildActivity(fixture.db, config).find(event => event.taskId === parent.display_id);
    assert.equal(parentEvent.isEpic, true);
  } finally {
    cleanup(fixture);
  }
});

test('keeps actor optional and backfills an existing running task as user', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'compatibility test', status: 'todo' });
    fixture.db.prepare('INSERT INTO running_tasks (workspace, task_id, started_at) VALUES (?, ?, ?)')
      .run('test', task.id, '2026-01-01T00:00:00.000Z');
    createSchema(fixture.db);

    const backfilled = fixture.db.prepare('SELECT * FROM task_execution_sessions WHERE task_id = ?').get(task.id);
    assert.equal(backfilled.agent_id, 'user');
    assert.equal(backfilled.stopped_at, null);

    tasksRepo.updateStatus(fixture.db, task.display_id, 'do', 'codex');
    const updated = tasksRepo.getByDisplayId(fixture.db, task.display_id);
    assert.equal(updated.updated_by, 'codex');

    tasksRepo.updateStatus(fixture.db, task.display_id, 'ready');
    const latestEvent = fixture.db.prepare('SELECT actor FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(task.id);
    assert.equal(latestEvent.actor, 'user');
  } finally {
    cleanup(fixture);
  }
});

test('exposes the active execution agent on board and task-detail items', () => {
  const fixture = createTestDb();
  try {
    const task = tasksRepo.create(fixture.db, { workspace: 'test', title: 'agent on board', status: 'do' });
    tasksRepo.setRunning(fixture.db, 'test', task.display_id, true, 'codex');
    const config = {
      projects: [{ file: 'test', name: 'Test' }],
      columns: [{ id: 'do', label: 'DO', match: ['do'] }],
    };

    const boardItem = buildBoardFromDb(fixture.db, config).columns[0].items[0];
    assert.equal(boardItem.agentId, 'codex');

    const detail = buildTaskDetail(fixture.db, config, task.display_id);
    assert.equal(detail.agentId, 'codex');
  } finally {
    cleanup(fixture);
  }
});
