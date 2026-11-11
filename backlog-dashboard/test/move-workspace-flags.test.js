'use strict';

// BM-167: ワークスペースを移動したタスクの「実行中」「今日やる」が、移動後も解除できることを検証する。
// pins / running_tasks は (workspace, task_id) の組で持つため、移動時に workspace を揃えないと、
// 移動後のワークスペースで探す解除処理(setRunning/setPin)が行を見つけられず、スピナーが止まらない。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const { buildTaskDetail } = require('../db/board');

const CONFIG = {
  columns: [
    { id: 'todo', label: 'TODO', match: ['todo'] },
    { id: 'do', label: 'DO', match: ['do'] },
    { id: 'done', label: 'DONE', match: ['done'] },
  ],
  projects: [
    { file: 'test', prefix: 'TS', name: 'Test' },
    { file: 'other', prefix: 'OT', name: 'Other' },
  ],
};

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

function flagWorkspaces(db, taskId) {
  return {
    running: db.prepare('SELECT workspace FROM running_tasks WHERE task_id = ?').all(taskId).map(r => r.workspace),
    pins: db.prepare('SELECT workspace FROM pins WHERE task_id = ?').all(taskId).map(r => r.workspace),
  };
}

test('moving a running, pinned task carries both flags to the target workspace', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 'mover', status: 'do' });
    tasksRepo.setPin(f.db, 'test', task.display_id, true, 'user');
    tasksRepo.setRunning(f.db, 'test', task.display_id, true, 'kiro');

    const moved = tasksRepo.moveWorkspace(f.db, task.display_id, 'other', CONFIG.projects);

    assert.deepEqual(flagWorkspaces(f.db, task.id), { running: ['other'], pins: ['other'] });
    assert.equal(tasksRepo.isRunning(f.db, moved.newId), true);
    assert.equal(tasksRepo.isPinned(f.db, moved.newId), true);
  } finally {
    cleanup(f);
  }
});

test('a moved task can be stopped and unpinned in its new workspace (the done flow)', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 'mover', status: 'do' });
    tasksRepo.setPin(f.db, 'test', task.display_id, true, 'user');
    tasksRepo.setRunning(f.db, 'test', task.display_id, true, 'kiro');
    const moved = tasksRepo.moveWorkspace(f.db, task.display_id, 'other', CONFIG.projects);

    // server.js の update-status(done) と同じ呼び出し: 移動後の tasks.workspace を渡す
    const existing = tasksRepo.getByDisplayId(f.db, moved.newId);
    tasksRepo.updateStatus(f.db, moved.newId, 'done', 'user');
    tasksRepo.setPin(f.db, existing.workspace, moved.newId, false, 'user');
    tasksRepo.setRunning(f.db, existing.workspace, moved.newId, false, 'user');

    assert.deepEqual(flagWorkspaces(f.db, task.id), { running: [], pins: [] });
    const openSessions = f.db.prepare('SELECT COUNT(*) AS n FROM task_execution_sessions WHERE task_id = ? AND stopped_at IS NULL').get(task.id).n;
    assert.equal(openSessions, 0);
    const types = f.db.prepare('SELECT event_type FROM task_events WHERE task_id = ? ORDER BY id').all(task.id).map(e => e.event_type);
    assert.ok(types.includes('running_stopped'), 'running_stopped が履歴に残る');
    assert.ok(types.includes('unpinned'), 'unpinned が履歴に残る');
    assert.equal(buildTaskDetail(f.db, CONFIG, moved.newId).running, false);
  } finally {
    cleanup(f);
  }
});

test('moving a task without flags does not create any', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 'plain', status: 'todo' });
    tasksRepo.moveWorkspace(f.db, task.display_id, 'other', CONFIG.projects);
    assert.deepEqual(flagWorkspaces(f.db, task.id), { running: [], pins: [] });
  } finally {
    cleanup(f);
  }
});

test('moving one task leaves the flags of other tasks untouched', () => {
  const f = createTestDb();
  try {
    const mover = tasksRepo.create(f.db, { workspace: 'test', title: 'mover', status: 'do' });
    const stayer = tasksRepo.create(f.db, { workspace: 'test', title: 'stayer', status: 'do' });
    tasksRepo.setRunning(f.db, 'test', mover.display_id, true, 'kiro');
    tasksRepo.setRunning(f.db, 'test', stayer.display_id, true, 'kiro');

    tasksRepo.moveWorkspace(f.db, mover.display_id, 'other', CONFIG.projects);

    assert.deepEqual(flagWorkspaces(f.db, mover.id).running, ['other']);
    assert.deepEqual(flagWorkspaces(f.db, stayer.id).running, ['test']);
  } finally {
    cleanup(f);
  }
});

test('createSchema repairs flag rows left behind in the old workspace, and is idempotent', () => {
  const f = createTestDb();
  try {
    const stale = tasksRepo.create(f.db, { workspace: 'other', title: 'moved before the fix', status: 'do' });
    const healthy = tasksRepo.create(f.db, { workspace: 'test', title: 'healthy', status: 'do' });
    // 修正前のmoveWorkspaceが作った状態: tasks.workspace は other だが、フラグ行は旧ワークスペース test のまま
    f.db.prepare('INSERT INTO running_tasks (workspace, task_id, started_at) VALUES (?, ?, ?)').run('test', stale.id, '2026-11-10T10:25:35.000Z');
    f.db.prepare('INSERT INTO pins (workspace, task_id, pinned_at) VALUES (?, ?, ?)').run('test', stale.id, '2026-11-10T08:52:44.000Z');
    tasksRepo.setRunning(f.db, 'test', healthy.display_id, true, 'kiro');

    createSchema(f.db);
    assert.deepEqual(flagWorkspaces(f.db, stale.id), { running: ['other'], pins: ['other'] });
    assert.deepEqual(flagWorkspaces(f.db, healthy.id).running, ['test']);

    // 2回目以降の起動で何も変わらない
    createSchema(f.db);
    assert.deepEqual(flagWorkspaces(f.db, stale.id), { running: ['other'], pins: ['other'] });
    assert.deepEqual(flagWorkspaces(f.db, healthy.id).running, ['test']);

    // 移行で揃った後は、新ワークスペースで通常どおり解除できる
    tasksRepo.setRunning(f.db, 'other', stale.display_id, false, 'user');
    tasksRepo.setPin(f.db, 'other', stale.display_id, false, 'user');
    assert.deepEqual(flagWorkspaces(f.db, stale.id), { running: [], pins: [] });
  } finally {
    cleanup(f);
  }
});
