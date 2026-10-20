'use strict';

// BT-393: タグのリポジトリ層(作成/重複防止/改名/統合/削除/付け外し)とboard・詳細への反映を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const tagsRepo = require('../db/tags-repo');
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

function code(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected an error');
}

function events(db, displayId) {
  return db.prepare("SELECT event_type, old_value, new_value, actor FROM task_events WHERE task_display_id = ? AND event_type LIKE 'tag_%' ORDER BY id")
    .all(displayId).map(e => ({ ...e }));
}

test('cleanName normalizes width/whitespace and rejects empty or too long names', () => {
  assert.equal(tagsRepo.cleanName('  ＡＢＣ　 テスト  '), 'ABC テスト');
  assert.equal(code(() => tagsRepo.cleanName('   ')).code, 'invalid_name');
  assert.equal(code(() => tagsRepo.cleanName('あ'.repeat(41))).code, 'invalid_name');
  assert.equal(code(() => tagsRepo.cleanName(null)).code, 'invalid_name');
});

test('createTag rejects duplicates across spelling variants, scoped per workspace', () => {
  const f = createTestDb();
  try {
    const tag = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Backend', color: '#AABBCC' });
    assert.equal(tag.color, '#aabbcc');
    for (const variant of ['backend', 'ＢＡＣＫＥＮＤ', ' Backend ']) {
      const err = code(() => tagsRepo.createTag(f.db, { workspace: 'test', name: variant }));
      assert.equal(err.code, 'duplicate_tag');
      assert.equal(err.existing.id, tag.id);
    }
    assert.doesNotThrow(() => tagsRepo.createTag(f.db, { workspace: 'other', name: 'Backend' }));
    assert.equal(code(() => tagsRepo.createTag(f.db, { workspace: 'nope', name: 'X' })).code, 'unknown_workspace');
    assert.equal(code(() => tagsRepo.createTag(f.db, { workspace: 'test', name: 'X', color: 'red' })).code, 'invalid_color');
  } finally {
    cleanup(f);
  }
});

test('createTag asks for confirmation when a similar tag exists', () => {
  const f = createTestDb();
  try {
    tagsRepo.createTag(f.db, { workspace: 'test', name: 'ガントチャート' });
    tagsRepo.createTag(f.db, { workspace: 'test', name: 'documentation' });

    const contained = code(() => tagsRepo.createTag(f.db, { workspace: 'test', name: 'ガント' }));
    assert.equal(contained.code, 'similar_tags');
    assert.deepEqual(contained.similar.map(t => t.name), ['ガントチャート']);
    // 1文字違い(編集距離1)も似ているとみなす
    assert.equal(code(() => tagsRepo.createTag(f.db, { workspace: 'test', name: 'documentaton' })).code, 'similar_tags');

    const forced = tagsRepo.createTag(f.db, { workspace: 'test', name: 'ガント', confirmSimilar: true });
    assert.equal(forced.name, 'ガント');
    // 全く別の名前は確認なしで作れる
    assert.doesNotThrow(() => tagsRepo.createTag(f.db, { workspace: 'test', name: 'バックアップ' }));
    // findSimilarTagsは完全一致を含めない
    assert.deepEqual(tagsRepo.findSimilarTags(f.db, 'test', 'ガント').map(t => t.name), ['ガントチャート']);
  } finally {
    cleanup(f);
  }
});

test('updateTag renames/recolors and rejects renaming onto another tag', () => {
  const f = createTestDb();
  try {
    const a = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Alpha' });
    const b = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Beta' });
    assert.equal(tagsRepo.updateTag(f.db, a.id, { name: 'ALPHA', color: '#112233' }).name, 'ALPHA');
    assert.equal(tagsRepo.updateTag(f.db, a.id, { color: null }).color, null);
    const err = code(() => tagsRepo.updateTag(f.db, b.id, { name: 'alpha' }));
    assert.equal(err.code, 'duplicate_tag');
    assert.equal(code(() => tagsRepo.updateTag(f.db, 999, { name: 'x' })).code, 'tag_not_found');
  } finally {
    cleanup(f);
  }
});

test('updateTaskTags attaches existing tags only, is idempotent and records events', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 't', status: 'todo' });
    const a = tagsRepo.createTag(f.db, { workspace: 'test', name: 'A' });
    const b = tagsRepo.createTag(f.db, { workspace: 'test', name: 'B' });
    const foreign = tagsRepo.createTag(f.db, { workspace: 'other', name: 'F' });

    let tags = tagsRepo.updateTaskTags(f.db, task.display_id, { add: [a.id, b.id, a.id] }, 'claude-code');
    assert.deepEqual(tags.map(t => t.name), ['A', 'B']);
    tagsRepo.updateTaskTags(f.db, task.display_id, { add: [a.id] }, 'claude-code');
    tags = tagsRepo.updateTaskTags(f.db, task.display_id, { remove: [b.id, 999] }, 'user');
    assert.deepEqual(tags.map(t => t.name), ['A']);

    assert.deepEqual(events(f.db, task.display_id), [
      { event_type: 'tag_added', old_value: null, new_value: 'A', actor: 'claude-code' },
      { event_type: 'tag_added', old_value: null, new_value: 'B', actor: 'claude-code' },
      { event_type: 'tag_removed', old_value: 'B', new_value: null, actor: 'user' },
    ]);

    assert.equal(code(() => tagsRepo.updateTaskTags(f.db, task.display_id, { add: [foreign.id] })).code, 'workspace_mismatch');
    assert.equal(code(() => tagsRepo.updateTaskTags(f.db, task.display_id, { add: [999] })).code, 'tag_not_found');
    assert.equal(code(() => tagsRepo.updateTaskTags(f.db, 'TS-999', { add: [a.id] })).code, 'not_found');
    // 失敗した操作は何も残さない
    assert.equal(events(f.db, task.display_id).length, 3);
  } finally {
    cleanup(f);
  }
});

test('listTags counts only live tasks as usage', () => {
  const f = createTestDb();
  try {
    const t1 = tasksRepo.create(f.db, { workspace: 'test', title: '1', status: 'todo' });
    const t2 = tasksRepo.create(f.db, { workspace: 'test', title: '2', status: 'todo' });
    const tag = tagsRepo.createTag(f.db, { workspace: 'test', name: 'A' });
    tagsRepo.updateTaskTags(f.db, t1.display_id, { add: [tag.id] });
    tagsRepo.updateTaskTags(f.db, t2.display_id, { add: [tag.id] });
    assert.equal(tagsRepo.listTags(f.db, 'test')[0].usageCount, 2);
    tasksRepo.softDelete(f.db, t2.display_id);
    assert.equal(tagsRepo.listTags(f.db, 'test')[0].usageCount, 1);
    assert.deepEqual(tagsRepo.listTags(f.db, 'other'), []);
  } finally {
    cleanup(f);
  }
});

test('mergeTags moves tasks to the target without duplicates and removes the source', () => {
  const f = createTestDb();
  try {
    const t1 = tasksRepo.create(f.db, { workspace: 'test', title: '1', status: 'todo' });
    const t2 = tasksRepo.create(f.db, { workspace: 'test', title: '2', status: 'todo' });
    const src = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Src' });
    const dst = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Dst' });
    const foreign = tagsRepo.createTag(f.db, { workspace: 'other', name: 'Foreign' });
    tagsRepo.updateTaskTags(f.db, t1.display_id, { add: [src.id] });
    tagsRepo.updateTaskTags(f.db, t2.display_id, { add: [src.id, dst.id] });

    assert.equal(code(() => tagsRepo.mergeTags(f.db, src.id, src.id)).code, 'same_tag');
    assert.equal(code(() => tagsRepo.mergeTags(f.db, src.id, foreign.id)).code, 'workspace_mismatch');

    const result = tagsRepo.mergeTags(f.db, src.id, dst.id, 'claude-code');
    assert.deepEqual(result, { mergedTasks: 2, newlyTaggedTasks: 1 });
    assert.equal(tagsRepo.getTag(f.db, src.id), null);
    const byTask = tagsRepo.listTagsForTasks(f.db, [t1.id, t2.id]);
    assert.deepEqual(byTask[t1.id].map(t => t.name), ['Dst']);
    assert.deepEqual(byTask[t2.id].map(t => t.name), ['Dst']);
    assert.deepEqual(events(f.db, t1.display_id).slice(-2).map(e => e.event_type), ['tag_added', 'tag_removed']);
  } finally {
    cleanup(f);
  }
});

test('deleteTag removes assignments and records tag_removed for live tasks', () => {
  const f = createTestDb();
  try {
    const t1 = tasksRepo.create(f.db, { workspace: 'test', title: '1', status: 'todo' });
    const tag = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Gone' });
    tagsRepo.updateTaskTags(f.db, t1.display_id, { add: [tag.id] });
    assert.deepEqual(tagsRepo.deleteTag(f.db, tag.id, 'claude-code'), { removedFromTasks: 1 });
    assert.equal(tagsRepo.getTag(f.db, tag.id), null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task_tags').get().n, 0);
    assert.deepEqual(events(f.db, t1.display_id).pop(), { event_type: 'tag_removed', old_value: 'Gone', new_value: null, actor: 'claude-code' });
    assert.equal(code(() => tagsRepo.deleteTag(f.db, tag.id)).code, 'tag_not_found');
  } finally {
    cleanup(f);
  }
});

test('board and task detail expose tags, and EPICs derive childTags from children', () => {
  const f = createTestDb();
  try {
    const epic = tasksRepo.create(f.db, { workspace: 'test', title: 'epic', status: 'todo' });
    const c1 = tasksRepo.create(f.db, { workspace: 'test', title: 'c1', status: 'todo' });
    const c2 = tasksRepo.create(f.db, { workspace: 'test', title: 'c2', status: 'todo' });
    tasksRepo.attachToParent(f.db, c1.display_id, epic.display_id);
    tasksRepo.attachToParent(f.db, c2.display_id, epic.display_id);
    const own = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Own' });
    const x = tagsRepo.createTag(f.db, { workspace: 'test', name: 'X' });
    const y = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Y' });
    tagsRepo.updateTaskTags(f.db, epic.display_id, { add: [own.id] });
    tagsRepo.updateTaskTags(f.db, c1.display_id, { add: [x.id, own.id] });
    tagsRepo.updateTaskTags(f.db, c2.display_id, { add: [x.id, y.id] });
    const plain = tasksRepo.create(f.db, { workspace: 'test', title: 'plain', status: 'todo' });

    for (const workspace of [null, 'test']) {
      const board = buildBoardFromDb(f.db, CONFIG, workspace);
      const items = board.columns.find(c => c.id === 'todo').items;
      const epicItem = items.find(i => i.id === epic.display_id);
      assert.deepEqual(epicItem.tags.map(t => t.name), ['Own']);
      assert.deepEqual(epicItem.childTags.map(t => t.name), ['X', 'Y']);
      assert.deepEqual(epicItem.children.map(c => c.tags.map(t => t.name)), [['Own', 'X'], ['X', 'Y']]);
      const plainItem = items.find(i => i.id === plain.display_id);
      assert.deepEqual(plainItem.tags, []);
      assert.equal(plainItem.childTags, undefined);
    }

    const detail = buildTaskDetail(f.db, CONFIG, epic.display_id);
    assert.deepEqual(detail.tags.map(t => t.name), ['Own']);
    assert.deepEqual(detail.childTags.map(t => t.name), ['X', 'Y']);
    assert.deepEqual(buildTaskDetail(f.db, CONFIG, c2.display_id).tags.map(t => t.name), ['X', 'Y']);
  } finally {
    cleanup(f);
  }
});

test('moving a task to another workspace drops its tags and records the removal', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, { workspace: 'test', title: 'mover', status: 'todo' });
    const tag = tagsRepo.createTag(f.db, { workspace: 'test', name: 'Local' });
    tagsRepo.updateTaskTags(f.db, task.display_id, { add: [tag.id] });
    const moved = tasksRepo.moveWorkspace(f.db, task.display_id, 'other', CONFIG.projects);
    assert.deepEqual(tagsRepo.listTagsForTasks(f.db, [task.id]), {});
    assert.deepEqual(events(f.db, moved.oldId).pop(), { event_type: 'tag_removed', old_value: 'Local', new_value: null, actor: 'user' });
  } finally {
    cleanup(f);
  }
});

test('reorderTags rewrites sort_order within the same workspace and rejects cross-workspace input', () => {
  const f = createTestDb();
  try {
    const a = tagsRepo.createTag(f.db, { workspace: 'test', name: 'A' });
    const b = tagsRepo.createTag(f.db, { workspace: 'test', name: 'B' });
    const c = tagsRepo.createTag(f.db, { workspace: 'test', name: 'C' });
    const foreign = tagsRepo.createTag(f.db, { workspace: 'other', name: 'Foreign' });
    assert.deepEqual(tagsRepo.listTags(f.db, 'test').map(t => t.name), ['A', 'B', 'C']);

    tagsRepo.reorderTags(f.db, 'test', [c.id, a.id, b.id], 'claude-code');
    assert.deepEqual(tagsRepo.listTags(f.db, 'test').map(t => t.name), ['C', 'A', 'B']);

    assert.equal(code(() => tagsRepo.reorderTags(f.db, 'test', [a.id])).code, 'invalid_request');
    assert.equal(code(() => tagsRepo.reorderTags(f.db, 'test', [a.id, 999])).code, 'tag_not_found');
    assert.equal(code(() => tagsRepo.reorderTags(f.db, 'test', [a.id, foreign.id])).code, 'workspace_mismatch');
    assert.equal(code(() => tagsRepo.reorderTags(f.db, '', [a.id, b.id])).code, 'invalid_workspace');
    // 失敗時は変更が残らない(ロールバック確認)
    assert.deepEqual(tagsRepo.listTags(f.db, 'test').map(t => t.name), ['C', 'A', 'B']);
  } finally {
    cleanup(f);
  }
});

test('tag event types are seeded so existing DBs gain them on upgrade', () => {
  const f = createTestDb();
  try {
    f.db.prepare("DELETE FROM event_types WHERE code IN ('tag_added', 'tag_removed')").run();
    createSchema(f.db);
    const codes = f.db.prepare('SELECT code FROM event_types').all().map(r => r.code);
    assert.ok(codes.includes('tag_added') && codes.includes('tag_removed'));
  } finally {
    cleanup(f);
  }
});
