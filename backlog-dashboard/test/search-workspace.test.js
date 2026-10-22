'use strict';

// BT-459: buildSearchResults の workspace 絞り込み（タイトル検索・本文検索とも）を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const { buildSearchResults } = require('../db/board');

const CONFIG = {
  projects: [
    { file: 'ws-a', prefix: 'AA', name: 'Alpha' },
    { file: 'ws-b', prefix: 'BB', name: 'Beta' },
  ],
};

function createTestDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-search-ws-'));
  const db = new DatabaseSync(path.join(directory, 'backlog.sqlite3'));
  createSchema(db);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('ws-a', 'AA', 1);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('ws-b', 'BB', 1);
  return { db, directory };
}

test('workspace narrows both title and body search; omitted means all workspaces', () => {
  const { db, directory } = createTestDb();
  try {
    const a = tasksRepo.create(db, { workspace: 'ws-a', title: 'shared keyword in A', status: 'todo' });
    const b = tasksRepo.create(db, { workspace: 'ws-b', title: 'shared keyword in B', status: 'todo' });
    const aBody = tasksRepo.create(db, { workspace: 'ws-a', title: 'plain A', status: 'todo', description: 'needle text here' });
    const bBody = tasksRepo.create(db, { workspace: 'ws-b', title: 'plain B', status: 'todo', description: 'needle text there' });

    const ids = r => r.results.map(x => x.id).sort();

    assert.deepEqual(ids(buildSearchResults(db, CONFIG, 'shared keyword')), [a.display_id, b.display_id].sort());
    assert.deepEqual(ids(buildSearchResults(db, CONFIG, 'shared keyword', { workspace: 'ws-a' })), [a.display_id]);
    assert.deepEqual(ids(buildSearchResults(db, CONFIG, 'shared keyword', { workspace: 'ws-b' })), [b.display_id]);

    assert.deepEqual(ids(buildSearchResults(db, CONFIG, 'needle', { includeBody: true })), [aBody.display_id, bBody.display_id].sort());
    assert.deepEqual(ids(buildSearchResults(db, CONFIG, 'needle', { includeBody: true, workspace: 'ws-b' })), [bBody.display_id]);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('results carry category and parentCategory (child follows the parent EPIC)', () => {
  const { db, directory } = createTestDb();
  try {
    const epic = tasksRepo.create(db, { workspace: 'ws-a', title: 'EPIC alpha', status: 'todo', category: '調査' });
    const child = tasksRepo.create(db, { workspace: 'ws-a', title: 'child alpha', status: 'todo', parentDisplayId: epic.display_id });
    const single = tasksRepo.create(db, { workspace: 'ws-a', title: 'single alpha', status: 'todo' });

    const byId = Object.fromEntries(buildSearchResults(db, CONFIG, 'alpha').results.map(r => [r.id, r]));
    assert.equal(byId[epic.display_id].category, '調査');
    assert.equal(byId[child.display_id].parentCategory, '調査');
    assert.equal(byId[single.display_id].category, null);
    assert.equal(byId[single.display_id].parentCategory, null);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
