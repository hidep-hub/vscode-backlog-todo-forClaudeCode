'use strict';

// BM-071: 外部リンクリポジトリ層(重複判定・board/詳細への反映・create()との統合)を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const externalLinksRepo = require('../db/external-links-repo');
const { buildBoardFromDb, buildTaskDetail } = require('../db/board');

const CONFIG = {
  columns: [{ id: 'todo', label: 'TODO', match: ['todo'] }, { id: 'done', label: 'DONE', match: ['done'] }],
  projects: [{ file: 'test', prefix: 'TS', name: 'Test' }],
};

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

test('insertLink + findLinkedTask: only live tasks count as already imported', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 't', status: 'todo' });
    externalLinksRepo.insertLink(f.db, {
      taskId: task.id, source: 'redmine', host: 'http://host/redmine', projectRef: 'proj',
      issueKey: 42, issueUrl: 'http://host/redmine/issues/42', linkedBy: 'kiro',
    });
    const found = externalLinksRepo.findLinkedTask(f.db, { source: 'redmine', host: 'http://host/redmine', projectRef: 'proj', issueKey: 42 });
    assert.equal(found.taskId, task.display_id);
    const notFound = externalLinksRepo.findLinkedTask(f.db, { source: 'redmine', host: 'http://host/redmine', projectRef: 'proj', issueKey: 999 });
    assert.equal(notFound, null);

    tasksRepo.softDelete(f.db, task.display_id);
    // BM-069方針C: 削除済みタスクのチケットは再度取り込める(取込済み判定から外れる)
    const afterDelete = externalLinksRepo.findLinkedTask(f.db, { source: 'redmine', host: 'http://host/redmine', projectRef: 'proj', issueKey: 42 });
    assert.equal(afterDelete, null);
  } finally {
    cleanup(f);
  }
});

test('findLinkedTasksByKeys resolves multiple keys in one call', () => {
  const f = createTestDb();
  try {
    const t1 = tasksRepo.create(f.db, { workspace: 'test', title: '1', status: 'todo' });
    const t2 = tasksRepo.create(f.db, { workspace: 'test', title: '2', status: 'todo' });
    externalLinksRepo.insertLink(f.db, { taskId: t1.id, source: 'redmine', host: 'h', projectRef: 'p', issueKey: 1, issueUrl: 'u1' });
    externalLinksRepo.insertLink(f.db, { taskId: t2.id, source: 'redmine', host: 'h', projectRef: 'p', issueKey: 2, issueUrl: 'u2' });
    const map = externalLinksRepo.findLinkedTasksByKeys(f.db, { source: 'redmine', host: 'h', projectRef: 'p', issueKeys: [1, 2, 3] });
    assert.equal(map.get('1'), t1.display_id);
    assert.equal(map.get('2'), t2.display_id);
    assert.equal(map.has('3'), false);
    assert.deepEqual(externalLinksRepo.findLinkedTasksByKeys(f.db, { source: 'redmine', host: 'h', projectRef: 'p', issueKeys: [] }), new Map());
  } finally {
    cleanup(f);
  }
});

test('tasksRepo.create() with externalLink registers the link in the same transaction', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, {
      workspace: 'test', title: 'imported', status: 'todo', createdBy: 'kiro',
      externalLink: { source: 'redmine', host: 'http://host/redmine', projectRef: 'proj', issueKey: 7, issueUrl: 'http://host/redmine/issues/7' },
    });
    const links = externalLinksRepo.listLinksForTasks(f.db, [task.id]);
    assert.deepEqual(links[task.id], [{ source: 'redmine', key: '7', url: 'http://host/redmine/issues/7', projectRef: 'proj' }]);
  } finally {
    cleanup(f);
  }
});

test('setLink inserts when no link exists yet, and overwrites an existing link to the same task+source (BM-126)', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 't', status: 'todo' });

    // 新規設定(insertLink相当)
    externalLinksRepo.setLink(f.db, {
      taskId: task.id, source: 'redmine', host: 'http://host/redmine', projectRef: 'proj',
      issueKey: 42, issueUrl: 'http://host/redmine/issues/42', linkedBy: 'kiro',
    });
    let links = externalLinksRepo.listLinksForTasks(f.db, [task.id]);
    assert.deepEqual(links[task.id], [{ source: 'redmine', key: '42', url: 'http://host/redmine/issues/42', projectRef: 'proj' }]);

    // 同一タスク+sourceへの再設定は上書きになる(間違えた場合の修正を想定、ユーザー合意事項)
    externalLinksRepo.setLink(f.db, {
      taskId: task.id, source: 'redmine', host: 'http://host/redmine', projectRef: 'proj',
      issueKey: 99, issueUrl: 'http://host/redmine/issues/99', linkedBy: 'kiro',
    });
    links = externalLinksRepo.listLinksForTasks(f.db, [task.id]);
    assert.deepEqual(links[task.id], [{ source: 'redmine', key: '99', url: 'http://host/redmine/issues/99', projectRef: 'proj' }]);

    // 古いキー(42)への紐づけは消えている
    assert.equal(externalLinksRepo.findLinkedTask(f.db, { source: 'redmine', host: 'http://host/redmine', projectRef: 'proj', issueKey: 42 }), null);
  } finally {
    cleanup(f);
  }
});

test('board and task detail expose externalLinks (GitHub fields untouched)', () => {
  const f = createTestDb();
  try {
    const withLink = tasksRepo.create(f.db, {
      workspace: 'test', title: 'with link', status: 'todo',
      githubIssueNumber: 10, githubIssueUrl: 'http://gh/10',
      externalLink: { source: 'gitlab', host: 'http://gl', projectRef: 'g/p', issueKey: 5, issueUrl: 'http://gl/g/p/-/issues/5' },
    });
    const plain = tasksRepo.create(f.db, { workspace: 'test', title: 'plain', status: 'todo' });

    for (const workspace of [null, 'test']) {
      const board = buildBoardFromDb(f.db, CONFIG, workspace);
      const items = board.columns.find(c => c.id === 'todo').items;
      const withLinkItem = items.find(i => i.id === withLink.display_id);
      assert.deepEqual(withLinkItem.externalLinks, [{ source: 'gitlab', key: '5', url: 'http://gl/g/p/-/issues/5', projectRef: 'g/p' }]);
      assert.equal(withLinkItem.githubIssueNumber, 10);
      assert.equal(withLinkItem.githubIssueUrl, 'http://gh/10');
      const plainItem = items.find(i => i.id === plain.display_id);
      assert.deepEqual(plainItem.externalLinks, []);
    }

    const detail = buildTaskDetail(f.db, CONFIG, withLink.display_id);
    assert.deepEqual(detail.externalLinks, [{ source: 'gitlab', key: '5', url: 'http://gl/g/p/-/issues/5', projectRef: 'g/p' }]);
  } finally {
    cleanup(f);
  }
});
