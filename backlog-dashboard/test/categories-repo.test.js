'use strict';

// BM-105: カテゴリのリポジトリ層(作成/重複防止/改名/統合/削除/add-task・update-task連動用resolve)を検証する。
// tags-repo.test.jsと同じ観点だが、カテゴリは「システムで一意」(ヒデさんの運用認識)のため
// ワークスペースの概念を持たない。タグと異なり中間テーブルも無く、tasks.categoryへ直接
// 名前を書き込む非正規化構成であることを中心に確認する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const categoriesRepo = require('../db/categories-repo');

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

function code(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected an error');
}

function events(db, displayId) {
  return db.prepare("SELECT event_type, old_value, new_value, actor FROM task_events WHERE task_display_id = ? AND event_type = 'category_changed' ORDER BY id")
    .all(displayId).map(e => ({ ...e }));
}

test('createCategory rejects duplicates across spelling variants, system-wide (no workspace scoping)', () => {
  const f = createTestDb();
  try {
    const cat = categoriesRepo.createCategory(f.db, { name: 'Infra', color: '#AABBCC' });
    assert.equal(cat.color, '#aabbcc');
    for (const variant of ['infra', 'ＩＮＦＲＡ', ' Infra ']) {
      const err = code(() => categoriesRepo.createCategory(f.db, { name: variant }));
      assert.equal(err.code, 'duplicate_category');
      assert.equal(err.existing.id, cat.id);
    }
  } finally {
    cleanup(f);
  }
});

test('createCategory asks for confirmation when a similar category exists', () => {
  const f = createTestDb();
  try {
    categoriesRepo.createCategory(f.db, { name: 'フロントエンド' });
    const similar = code(() => categoriesRepo.createCategory(f.db, { name: 'フロント' }));
    assert.equal(similar.code, 'similar_categories');
    assert.deepEqual(similar.similar.map(c => c.name), ['フロントエンド']);
    const forced = categoriesRepo.createCategory(f.db, { name: 'フロント', confirmSimilar: true });
    assert.equal(forced.name, 'フロント');
  } finally {
    cleanup(f);
  }
});

test('updateCategory renames and bulk-updates tasks.category across workspaces, recording category_changed', () => {
  const f = createTestDb();
  try {
    const infra = categoriesRepo.createCategory(f.db, { name: 'Infra' });
    const t1 = tasksRepo.create(f.db, { workspace: 'test', title: '1', status: 'todo', category: 'Infra' });
    const t2 = tasksRepo.create(f.db, { workspace: 'other', title: '2', status: 'todo', category: 'Infra' });
    const other = tasksRepo.create(f.db, { workspace: 'test', title: 'other', status: 'todo', category: 'Dev' });

    const renamed = categoriesRepo.updateCategory(f.db, infra.id, { name: 'Infrastructure' }, 'claude-code');
    assert.equal(renamed.name, 'Infrastructure');
    // 別ワークスペース(other)のタスクにも同じカテゴリ名を一括反映する(システム全体で一意なため)
    assert.equal(tasksRepo.getByDisplayId(f.db, t1.display_id).category, 'Infrastructure');
    assert.equal(tasksRepo.getByDisplayId(f.db, t2.display_id).category, 'Infrastructure');
    assert.equal(tasksRepo.getByDisplayId(f.db, other.display_id).category, 'Dev');
    assert.deepEqual(events(f.db, t1.display_id), [{ event_type: 'category_changed', old_value: 'Infra', new_value: 'Infrastructure', actor: 'claude-code' }]);
    assert.deepEqual(events(f.db, t2.display_id), [{ event_type: 'category_changed', old_value: 'Infra', new_value: 'Infrastructure', actor: 'claude-code' }]);
    assert.deepEqual(events(f.db, other.display_id), []);
  } finally {
    cleanup(f);
  }
});

test('updateCategory rejects renaming onto another category and unknown ids', () => {
  const f = createTestDb();
  try {
    const a = categoriesRepo.createCategory(f.db, { name: 'Alpha' });
    const b = categoriesRepo.createCategory(f.db, { name: 'Beta' });
    const err = code(() => categoriesRepo.updateCategory(f.db, b.id, { name: 'alpha' }));
    assert.equal(err.code, 'duplicate_category');
    assert.equal(categoriesRepo.updateCategory(f.db, a.id, { color: null }).color, null);
    assert.equal(code(() => categoriesRepo.updateCategory(f.db, 999, { name: 'x' })).code, 'category_not_found');
  } finally {
    cleanup(f);
  }
});

test('deleteCategory clears tasks.category to null across workspaces and records category_changed', () => {
  const f = createTestDb();
  try {
    const cat = categoriesRepo.createCategory(f.db, { name: 'Gone' });
    const t1 = tasksRepo.create(f.db, { workspace: 'test', title: '1', status: 'todo', category: 'Gone' });
    const t2 = tasksRepo.create(f.db, { workspace: 'other', title: '2', status: 'todo', category: 'Gone' });
    assert.deepEqual(categoriesRepo.deleteCategory(f.db, cat.id, 'claude-code'), { removedFromTasks: 2 });
    assert.equal(categoriesRepo.getCategory(f.db, cat.id), null);
    assert.equal(tasksRepo.getByDisplayId(f.db, t1.display_id).category, null);
    assert.equal(tasksRepo.getByDisplayId(f.db, t2.display_id).category, null);
    assert.deepEqual(events(f.db, t1.display_id), [{ event_type: 'category_changed', old_value: 'Gone', new_value: null, actor: 'claude-code' }]);
    assert.equal(code(() => categoriesRepo.deleteCategory(f.db, cat.id)).code, 'category_not_found');
  } finally {
    cleanup(f);
  }
});

test('mergeCategories moves tasks (across workspaces) to the target category name and removes the source', () => {
  const f = createTestDb();
  try {
    const src = categoriesRepo.createCategory(f.db, { name: 'Src' });
    const dst = categoriesRepo.createCategory(f.db, { name: 'Dst' });
    const t1 = tasksRepo.create(f.db, { workspace: 'test', title: '1', status: 'todo', category: 'Src' });
    const t2 = tasksRepo.create(f.db, { workspace: 'other', title: '2', status: 'todo', category: 'Src' });

    assert.equal(code(() => categoriesRepo.mergeCategories(f.db, src.id, src.id)).code, 'same_category');

    const result = categoriesRepo.mergeCategories(f.db, src.id, dst.id, 'claude-code');
    assert.deepEqual(result, { mergedTasks: 2 });
    assert.equal(categoriesRepo.getCategory(f.db, src.id), null);
    assert.equal(tasksRepo.getByDisplayId(f.db, t1.display_id).category, 'Dst');
    assert.equal(tasksRepo.getByDisplayId(f.db, t2.display_id).category, 'Dst');
  } finally {
    cleanup(f);
  }
});

test('listCategories counts live tasks matching the category name as usage, across all workspaces', () => {
  const f = createTestDb();
  try {
    categoriesRepo.createCategory(f.db, { name: 'A' });
    const t1 = tasksRepo.create(f.db, { workspace: 'test', title: '1', status: 'todo', category: 'A' });
    tasksRepo.create(f.db, { workspace: 'other', title: '2', status: 'todo', category: 'A' });
    assert.equal(categoriesRepo.listCategories(f.db)[0].usageCount, 2);
    tasksRepo.softDelete(f.db, t1.display_id);
    assert.equal(categoriesRepo.listCategories(f.db)[0].usageCount, 1);
  } finally {
    cleanup(f);
  }
});

test('resolveCategoryName allows empty/null as "no category" and rejects names not in the master, regardless of workspace', () => {
  const f = createTestDb();
  try {
    categoriesRepo.createCategory(f.db, { name: 'Infra' });
    assert.equal(categoriesRepo.resolveCategoryName(f.db, 'infra'), 'Infra'); // 表記ゆれでもマスタの表記に正規化される
    assert.equal(categoriesRepo.resolveCategoryName(f.db, ''), null);
    assert.equal(categoriesRepo.resolveCategoryName(f.db, null), null);
    assert.equal(categoriesRepo.resolveCategoryName(f.db, undefined), null);
    assert.equal(code(() => categoriesRepo.resolveCategoryName(f.db, 'Unknown')).code, 'unknown_category');
  } finally {
    cleanup(f);
  }
});
