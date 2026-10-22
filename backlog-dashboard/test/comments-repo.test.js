
// BM-136: タスクコメントのリポジトリ層(追加/削除/新しい順/要約)とboard・詳細への反映を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const commentsRepo = require('../db/comments-repo');
const { buildBoardFromDb, buildTaskDetail } = require('../db/board');

const CONFIG = {
  columns: [{ id: 'todo', label: 'TODO', match: ['todo'] }, { id: 'done', label: 'DONE', match: ['done'] }],
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

function errorOf(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected an error');
}

// 同一ミリ秒でも新しい順が崩れないことを見たいので、created_atを明示的にずらして入れる
function insertAt(db, taskId, body, createdAt, createdBy = 'user') {
  return db.prepare('INSERT INTO task_comments (task_id, body, created_at, created_by) VALUES (?, ?, ?, ?)')
    .run(taskId, body, createdAt, createdBy).lastInsertRowid;
}

test('createSchema adds task_comments to an existing DB without touching tasks and is re-runnable', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 'keep me', status: 'todo' });
    f.db.exec('DROP TABLE task_comments;');

    createSchema(f.db);
    createSchema(f.db);

    const names = f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    assert.ok(names.includes('task_comments'));
    const columns = f.db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
    assert.ok(!columns.some(c => c.includes('comment')), 'tasks table must not gain comment columns');
    assert.equal(f.db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.id).title, 'keep me');
  } finally {
    cleanup(f);
  }
});

test('addComment stores body with actor and time, and stays silent (no event, no updated_at bump)', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 't', status: 'todo' });
    const before = f.db.prepare('SELECT updated_at, updated_by FROM tasks WHERE id = ?').get(task.id);
    const eventsBefore = f.db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n;

    const { comment, commentCount } = commentsRepo.addComment(f.db, task.display_id, '  検証機で再現できた  ', 'claude-code');
    assert.equal(commentCount, 1);
    assert.equal(comment.body, '検証機で再現できた');
    assert.equal(comment.createdBy, 'claude-code');
    assert.ok(!Number.isNaN(Date.parse(comment.createdAt)));

    const after = f.db.prepare('SELECT updated_at, updated_by FROM tasks WHERE id = ?').get(task.id);
    assert.deepEqual({ ...after }, { ...before }, 'comment must not change updated_at/updated_by');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, eventsBefore, 'comment must not create task_events');
  } finally {
    cleanup(f);
  }
});

test('addComment normalizes line breaks and rejects empty, too long and non-string bodies', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 't', status: 'todo' });
    const multi = commentsRepo.addComment(f.db, task.display_id, '1行目\r\n2行目\r3行目');
    assert.equal(multi.comment.body, '1行目\n2行目\n3行目');

    for (const bad of ['', '   \n ', null, 123, undefined]) {
      assert.equal(errorOf(() => commentsRepo.addComment(f.db, task.display_id, bad)).code, 'invalid_body');
    }
    const max = 'あ'.repeat(commentsRepo.MAX_BODY_LENGTH);
    assert.equal(commentsRepo.addComment(f.db, task.display_id, max).comment.body.length, commentsRepo.MAX_BODY_LENGTH);
    assert.equal(errorOf(() => commentsRepo.addComment(f.db, task.display_id, max + 'あ')).code, 'invalid_body');
    assert.equal(commentsRepo.listComments(f.db, task.display_id).comments.length, 2, 'rejected bodies must not be stored');
  } finally {
    cleanup(f);
  }
});

test('addComment/listComments reject unknown and soft-deleted tasks', () => {
  const f = createTestDb();
  try {
    assert.equal(errorOf(() => commentsRepo.addComment(f.db, 'TS-999', 'x')).code, 'not_found');
    assert.equal(errorOf(() => commentsRepo.listComments(f.db, 'TS-999')).code, 'not_found');
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 't', status: 'todo' });
    commentsRepo.addComment(f.db, task.display_id, 'x');
    tasksRepo.softDelete(f.db, task.display_id);
    assert.equal(errorOf(() => commentsRepo.addComment(f.db, task.display_id, 'y')).code, 'not_found');
  } finally {
    cleanup(f);
  }
});

test('listComments returns newest first, and deleteComment removes one and reports the count', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 't', status: 'todo' });
    const first = insertAt(f.db, task.id, 'first', '2026-10-20T01:00:00.000Z');
    insertAt(f.db, task.id, 'second', '2026-10-21T01:00:00.000Z');
    insertAt(f.db, task.id, 'third', '2026-10-22T01:00:00.000Z');
    assert.deepEqual(commentsRepo.listComments(f.db, task.display_id).comments.map(c => c.body), ['third', 'second', 'first']);

    assert.deepEqual(commentsRepo.deleteComment(f.db, first), { taskId: task.display_id, commentCount: 2 });
    assert.deepEqual(commentsRepo.listComments(f.db, task.display_id).comments.map(c => c.body), ['third', 'second']);
    assert.equal(errorOf(() => commentsRepo.deleteComment(f.db, first)).code, 'comment_not_found');
  } finally {
    cleanup(f);
  }
});

test('summarizeForTasks gives count and latest (preview cut to 120 chars), scoped or for all tasks', () => {
  const f = createTestDb();
  try {
    const a = tasksRepo.create(f.db, { workspace: 'test', title: 'a', status: 'todo' });
    const b = tasksRepo.create(f.db, { workspace: 'test', title: 'b', status: 'todo' });
    const none = tasksRepo.create(f.db, { workspace: 'test', title: 'none', status: 'todo' });
    insertAt(f.db, a.id, 'old', '2026-10-20T01:00:00.000Z');
    const long = 'あ'.repeat(commentsRepo.PREVIEW_LENGTH + 30);
    insertAt(f.db, a.id, long, '2026-10-22T01:00:00.000Z', 'kiro');
    insertAt(f.db, b.id, 'only', '2026-10-21T01:00:00.000Z');

    const all = commentsRepo.summarizeForTasks(f.db);
    assert.equal(all[a.id].count, 2);
    assert.equal(all[a.id].latest.body, 'あ'.repeat(commentsRepo.PREVIEW_LENGTH));
    assert.equal(all[a.id].latest.createdBy, 'kiro');
    assert.equal(all[b.id].count, 1);
    assert.equal(all[none.id], undefined);

    assert.deepEqual(Object.keys(commentsRepo.summarizeForTasks(f.db, [b.id])).map(Number), [b.id]);
    assert.deepEqual(commentsRepo.summarizeForTasks(f.db, []), {});
  } finally {
    cleanup(f);
  }
});

test('board items carry commentCount/latestComment and detail carries the full list, for all and per-workspace boards', () => {
  const f = createTestDb();
  try {
    const epic = tasksRepo.create(f.db, { workspace: 'test', title: 'epic', status: 'todo' });
    const child = tasksRepo.create(f.db, { workspace: 'test', title: 'child', status: 'todo', parentDisplayId: epic.display_id });
    const plain = tasksRepo.create(f.db, { workspace: 'test', title: 'plain', status: 'todo' });
    insertAt(f.db, epic.id, 'epic note', '2026-10-21T01:00:00.000Z');
    insertAt(f.db, child.id, 'child old', '2026-10-20T01:00:00.000Z');
    insertAt(f.db, child.id, 'child new', '2026-10-22T01:00:00.000Z');

    for (const workspace of [null, 'test']) {
      const items = buildBoardFromDb(f.db, CONFIG, workspace).columns.find(c => c.id === 'todo').items;
      const epicItem = items.find(i => i.id === epic.display_id);
      assert.equal(epicItem.commentCount, 1);
      assert.equal(epicItem.latestComment.body, 'epic note');
      assert.equal(epicItem.comments, undefined, 'board items must not carry the full comment list');
      const childItem = epicItem.children.find(c => c.id === child.display_id);
      assert.equal(childItem.commentCount, 2);
      assert.equal(childItem.latestComment.body, 'child new');
      const plainItem = items.find(i => i.id === plain.display_id);
      assert.equal(plainItem.commentCount, 0);
      assert.equal(plainItem.latestComment, null);
    }

    const detail = buildTaskDetail(f.db, CONFIG, child.display_id);
    assert.deepEqual(detail.comments.map(c => c.body), ['child new', 'child old']);
    assert.equal(detail.commentCount, 2);
    const epicDetail = buildTaskDetail(f.db, CONFIG, epic.display_id);
    assert.deepEqual(epicDetail.comments.map(c => c.body), ['epic note']);
    assert.equal(epicDetail.children[0].commentCount, 2);
    assert.equal(epicDetail.children[0].comments, undefined);
    assert.deepEqual(buildTaskDetail(f.db, CONFIG, plain.display_id).comments, []);
  } finally {
    cleanup(f);
  }
});

test('comments follow the task when it moves to another workspace', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 'mover', status: 'todo' });
    commentsRepo.addComment(f.db, task.display_id, 'keep me');
    const moved = tasksRepo.moveWorkspace(f.db, task.display_id, 'other', CONFIG.projects);
    assert.deepEqual(commentsRepo.listComments(f.db, moved.newId).comments.map(c => c.body), ['keep me']);
  } finally {
    cleanup(f);
  }
});
