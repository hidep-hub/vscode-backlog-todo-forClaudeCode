'use strict';

// BT-291: 週報(db/weekly-report.js)の期間計算・対象タスクの選び方・Markdown生成を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const wr = require('../db/weekly-report');

const itemsOf = ws => ws.sections.flatMap(s => s.items);

const CONFIG = { projects: [{ file: 'alpha', prefix: 'AL', name: 'アルファ' }, { file: 'beta', prefix: 'BE', name: 'ベータ' }] };

function createTestDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-dashboard-test-'));
  const db = new DatabaseSync(path.join(directory, 'backlog.sqlite3'));
  createSchema(db);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('alpha', 'AL', 1);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('beta', 'BE', 1);
  return { db, directory };
}

let seq = 0;
function addTask(db, { workspace = 'alpha', title, status = 'todo', parentId = null, dueDate = null, deleted = false, tagless = true, category = null, assignee = null }) {
  seq += 1;
  const prefix = workspace === 'alpha' ? 'AL' : 'BE';
  const now = '2026-10-01T00:00:00.000Z';
  const r = db.prepare(`INSERT INTO tasks (workspace, seq_no, display_id, parent_id, title, status, due_date, sort_order,
    deleted_at, created_at, created_by, updated_at, updated_by, category, assignee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(workspace, seq, `${prefix}-${String(seq).padStart(3, '0')}`, parentId, title, status, dueDate, seq,
      deleted ? now : null, now, 'user', now, 'user', category, assignee);
  return { id: Number(r.lastInsertRowid), displayId: `${prefix}-${String(seq).padStart(3, '0')}` };
}

function addStatusEvent(db, task, newValue, occurredAt) {
  db.prepare(`INSERT INTO task_events (task_id, task_display_id, event_type, old_value, new_value, actor, occurred_at)
    VALUES (?, ?, 'status_changed', NULL, ?, 'user', ?)`).run(task.id, task.displayId, newValue, occurredAt);
}

function cleanup({ db, directory }) {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

const PERIOD = { from: '2026-10-12', to: '2026-10-18', workspaces: ['alpha'], statuses: ['done', 'do'] };
// JST 10/13 10:00 = UTC 01:00
const IN_PERIOD = '2026-10-13T01:00:00.000Z';

test('weekRange: 今週・先週は月曜〜日曜(JST)', () => {
  assert.deepEqual(wr.weekRange('this', '2026-10-18'), { from: '2026-10-12', to: '2026-10-18' }); // 日曜
  assert.deepEqual(wr.weekRange('this', '2026-10-12'), { from: '2026-10-12', to: '2026-10-18' }); // 月曜
  assert.deepEqual(wr.weekRange('last', '2026-10-18'), { from: '2026-10-05', to: '2026-10-11' });
});

test('期間内に選択ステータスへ変わったタスクだけが対象、期間外・未選択ステータスは除外', () => {
  const ctx = createTestDb();
  const a = addTask(ctx.db, { title: '期間内に完了', status: 'done' });
  addStatusEvent(ctx.db, a, 'done', IN_PERIOD);
  const b = addTask(ctx.db, { title: '期間外に完了', status: 'done' });
  addStatusEvent(ctx.db, b, 'done', '2026-10-01T01:00:00.000Z');
  const c = addTask(ctx.db, { title: '期間内にREADYへ', status: 'ready' });
  addStatusEvent(ctx.db, c, 'ready', IN_PERIOD);
  const d = addTask(ctx.db, { title: '削除済み', status: 'done', deleted: true });
  addStatusEvent(ctx.db, d, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  assert.deepEqual(itemsOf(data.workspaces[0]).map(i => i.title), ['期間内に完了']);
  cleanup(ctx);
});

test('日付はJST基準: UTCで前日でもJSTで期間内なら対象(境界)', () => {
  const ctx = createTestDb();
  const a = addTask(ctx.db, { title: '月曜0:30JST', status: 'done' });
  addStatusEvent(ctx.db, a, 'done', '2026-10-11T15:30:00.000Z'); // JST 10/12 00:30
  const b = addTask(ctx.db, { title: '先週日曜23:30JST', status: 'done' });
  addStatusEvent(ctx.db, b, 'done', '2026-10-11T14:30:00.000Z'); // JST 10/11 23:30
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  assert.deepEqual(itemsOf(data.workspaces[0]).map(i => i.title), ['月曜0:30JST']);
  cleanup(ctx);
});

test('期日: 期間内はステータス不問、期間より前は未完了のみ、期間より後は対象外', () => {
  const ctx = createTestDb();
  addTask(ctx.db, { title: '期間内期日(TODO)', status: 'todo', dueDate: '2026-10-15' });
  addTask(ctx.db, { title: '期間内期日(完了済)', status: 'done', dueDate: '2026-10-14' });
  addTask(ctx.db, { title: '過去期日(未完了)', status: 'todo', dueDate: '2026-10-01' });
  addTask(ctx.db, { title: '過去期日(完了済)', status: 'done', dueDate: '2026-10-01' });
  addTask(ctx.db, { title: '来週期日', status: 'todo', dueDate: '2026-10-20' });
  addTask(ctx.db, { title: '期日なし', status: 'todo' });
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  const titles = itemsOf(data.workspaces[0]).map(i => i.title).sort();
  assert.deepEqual(titles, ['期間内期日(TODO)', '期間内期日(完了済)', '過去期日(未完了)'].sort());
  cleanup(ctx);
});

// BM-121: EPIC(子タスクを持つ親)は、ヒットした子タスクを1行に集約する。単発タスクは従来どおり1件=1行。

function addTag(db, task, workspace, name) {
  const tag = db.prepare(`INSERT INTO tags (workspace, name, name_key, sort_order, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, 0, '2026-10-01T00:00:00.000Z', 'user', '2026-10-01T00:00:00.000Z', 'user')`).run(workspace, name, name);
  db.prepare('INSERT INTO task_tags (task_id, tag_id, created_at, created_by) VALUES (?, ?, ?, ?)')
    .run(task.id, Number(tag.lastInsertRowid), '2026-10-01T00:00:00.000Z', 'user');
}

test('EPICはヒットした子タスクを1行に集約する。単発は従来どおり1件=1行', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: '大きな話', status: 'do' });
  const k1 = addTask(ctx.db, { title: '子1', status: 'done', parentId: epic.id });
  addTask(ctx.db, { title: '子2(ヒットしない)', status: 'todo', parentId: epic.id }); // 期日なし・期間内の変化なし→対象外
  const solo = addTask(ctx.db, { title: '単発', status: 'done' });
  addStatusEvent(ctx.db, k1, 'done', IN_PERIOD);
  addStatusEvent(ctx.db, solo, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, today: '2026-10-14' });
  const ws = data.workspaces[0];
  assert.deepEqual(ws.sections.map(s => s.kind), ['完了']);
  const items = itemsOf(ws);
  assert.equal(items.length, 2); // EPIC1行 + 単発1行(子2はヒットしないので出てこない)
  const epicItem = items.find(i => i.isEpic);
  assert.equal(epicItem.id, epic.displayId);
  assert.equal(epicItem.title, '大きな話');
  assert.deepEqual(epicItem.childLeaves.map(c => c.title), ['子1']);
  const { markdown } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  assert.ok(markdown.includes('⧉ 大きな話<br/><small>└ 子1</small>'));
  assert.match(markdown, /\| 単発 \|/); // 親のいないタスクは件名だけ
  assert.doesNotMatch(markdown, /子2/); // ヒットしなかった子はタイトルにも出ない
  cleanup(ctx);
});

test('EPICが週報対象になるのは、ヒットした子が1件以上ある場合のみ(子が1件もヒットしないEPICは出ない)', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: '話したいテーマ', status: 'do' });
  addTask(ctx.db, { title: '動きのない子', status: 'todo', parentId: epic.id }); // 期日なし、ステータス変更なし
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  assert.equal(itemsOf(data.workspaces[0]).length, 0);
  cleanup(ctx);
});

test('EPIC行の区分: 子に1件でも期限超過があれば期限超過、なければ対応中が1件でもあれば対応中、全部todoなら未着手、全部doneなら完了', () => {
  const ctx = createTestDb();
  const today = '2026-10-14';

  const e1 = addTask(ctx.db, { title: 'EPIC期限超過', status: 'do' });
  const e1a = addTask(ctx.db, { title: 'a', status: 'done', parentId: e1.id, dueDate: '2026-10-13' });
  const e1b = addTask(ctx.db, { title: 'b', status: 'todo', parentId: e1.id, dueDate: '2026-10-01' }); // 過去期日・未完了=期限超過
  addStatusEvent(ctx.db, e1a, 'done', IN_PERIOD);
  void e1b;

  const e2 = addTask(ctx.db, { title: 'EPIC対応中', status: 'do' });
  const e2a = addTask(ctx.db, { title: 'c', status: 'do', parentId: e2.id });
  addStatusEvent(ctx.db, e2a, 'do', IN_PERIOD);

  const e3 = addTask(ctx.db, { title: 'EPIC未着手', status: 'do' });
  const e3a = addTask(ctx.db, { title: 'd', status: 'todo', parentId: e3.id, dueDate: '2026-10-16' });
  void e3a;

  const e4 = addTask(ctx.db, { title: 'EPIC完了', status: 'do' });
  const e4a = addTask(ctx.db, { title: 'e', status: 'done', parentId: e4.id });
  addStatusEvent(ctx.db, e4a, 'done', IN_PERIOD);

  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, statuses: ['todo', 'ready', 'do', 'done'], today });
  const byTitle = Object.fromEntries(itemsOf(data.workspaces[0]).map(i => [i.title, i]));
  assert.equal(byTitle['EPIC期限超過'].kind, '期限超過');
  assert.equal(byTitle['EPIC対応中'].kind, '対応中');
  assert.equal(byTitle['EPIC未着手'].kind, '未着手');
  assert.equal(byTitle['EPIC完了'].kind, '完了');
  cleanup(ctx);
});

test('EPIC行の期日はヒットした子の期日の最大値(最も遅い日付)。EPIC自身のdue_dateは使わない', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: 'EPIC', status: 'do', dueDate: '2026-09-01' }); // 比較対象に含めない
  const a = addTask(ctx.db, { title: 'a', status: 'done', parentId: epic.id, dueDate: '2026-10-14' });
  const b = addTask(ctx.db, { title: 'b', status: 'done', parentId: epic.id, dueDate: '2026-10-17' });
  addStatusEvent(ctx.db, a, 'done', IN_PERIOD);
  addStatusEvent(ctx.db, b, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  const epicItem = itemsOf(data.workspaces[0]).find(i => i.isEpic);
  assert.equal(epicItem.dueDate, '2026-10-17');
  cleanup(ctx);
});

test('EPIC行の担当者・タグ・外部リンクは、ヒットした子の範囲から重複を除いて列挙する', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: 'EPIC', status: 'do' });
  const a = addTask(ctx.db, { title: 'a', status: 'done', parentId: epic.id, assignee: '大下' });
  const b = addTask(ctx.db, { title: 'b', status: 'done', parentId: epic.id, assignee: '信濃' });
  const c = addTask(ctx.db, { title: 'c', status: 'done', parentId: epic.id, assignee: '大下' }); // 重複
  addStatusEvent(ctx.db, a, 'done', IN_PERIOD);
  addStatusEvent(ctx.db, b, 'done', IN_PERIOD);
  addStatusEvent(ctx.db, c, 'done', IN_PERIOD);
  addTag(ctx.db, a, 'alpha', 'タグ1');
  addTag(ctx.db, b, 'alpha', 'タグ2');
  ctx.db.prepare(`INSERT INTO task_external_links (task_id, source, host, project_ref, issue_key, issue_url, linked_at, linked_by)
    VALUES (?, 'redmine', 'rm.example', 'proj', '1234', 'https://rm.example/issues/1234', ?, 'user')`).run(a.id, IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  const epicItem = itemsOf(data.workspaces[0]).find(i => i.isEpic);
  assert.equal(epicItem.assignee, '大下, 信濃');
  assert.equal(epicItem.tags, 'タグ1, タグ2');
  assert.equal(epicItem.externalLinks.length, 1);
  assert.equal(epicItem.externalLinks[0].key, '1234');
  const { markdown } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: ['id', 'title', 'assignee', 'tags', 'external'] });
  assert.match(markdown, /大下, 信濃/);
  assert.match(markdown, /タグ1, タグ2/);
  cleanup(ctx);
});

test('カテゴリ(BM-121): 子タスク自身のcategoryは週報では参照せず、常に親(EPIC)のcategoryを使う', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: 'EPIC', status: 'do', category: 'カテゴリA' });
  const child = addTask(ctx.db, { title: '子', status: 'done', parentId: epic.id, category: 'カテゴリB(子の値。無視されるはず)' });
  addStatusEvent(ctx.db, child, 'done', IN_PERIOD);
  const solo = addTask(ctx.db, { title: '単発', status: 'done', category: 'カテゴリC' });
  addStatusEvent(ctx.db, solo, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupByCategory: true });
  const groups = data.workspaces[0].categoryGroups;
  assert.deepEqual(groups.map(g => g.name).sort(), ['カテゴリA', 'カテゴリC'].sort());
  const groupA = groups.find(g => g.name === 'カテゴリA');
  assert.deepEqual(groupA.items.map(i => i.title), ['EPIC']);
  cleanup(ctx);
});

test('buildWeeklyCounts(BM-121): カテゴリ別件数も、子タスクは親(EPIC)のカテゴリとして数える', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: 'EPIC', status: 'do', category: '開発' });
  const child = addTask(ctx.db, { title: '子', status: 'done', parentId: epic.id, category: '-' });
  addStatusEvent(ctx.db, child, 'done', IN_PERIOD);
  const r = wr.buildWeeklyCounts(ctx.db, CONFIG, { from: PERIOD.from, to: PERIOD.to, workspaces: ['alpha'], statuses: ['done'] });
  assert.deepEqual(r.workspaces[0].categories, { 開発: 1 });
  cleanup(ctx);
});

test('見出しは 期限超過 → 完了 → 対応中(DO/READY) → 未着手(TODO) の順で、該当が無い見出しは出さない', () => {
  const ctx = createTestDb();
  const done = addTask(ctx.db, { title: 'D', status: 'done' });
  addStatusEvent(ctx.db, done, 'done', IN_PERIOD);
  const doing = addTask(ctx.db, { title: 'O', status: 'do' });
  addStatusEvent(ctx.db, doing, 'do', IN_PERIOD);
  const ready = addTask(ctx.db, { title: 'R', status: 'ready' });
  addStatusEvent(ctx.db, ready, 'ready', IN_PERIOD);
  addTask(ctx.db, { title: 'T', status: 'todo', dueDate: '2026-10-16' });
  addTask(ctx.db, { title: 'L', status: 'todo', dueDate: '2026-10-01' });
  const withAll = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, statuses: ['todo', 'ready', 'do', 'done'], today: '2026-10-14' });
  assert.deepEqual(withAll.workspaces[0].sections.map(s => s.kind), ['期限超過', '完了', '対応中', '未着手']);
  const readyDo = withAll.workspaces[0].sections.find(s => s.kind === '対応中');
  assert.deepEqual(readyDo.items.map(i => i.title).sort(), ['O', 'R']);
  const { markdown } = wr.renderWeeklyReport(withAll, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  const order = ['### 期限超過', '### 完了（DONE）', '### 対応中（DO/READY）', '### 未着手（TODO）'].map(h => markdown.indexOf(h));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])));
  const onlyDone = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, statuses: ['done'], today: '2026-10-14' });
  assert.deepEqual(onlyDone.workspaces[0].sections.map(s => s.kind), ['期限超過', '完了', '未着手']); // 未着手は期日で拾われたものだけ
  assert.deepEqual(onlyDone.workspaces[0].sections.find(s => s.kind === '未着手').items.map(i => i.title), ['T']);
  cleanup(ctx);
});

test('件数バッジ: 4ステータス全選択前提で現在ステータス別に数え、期間内にそのステータスへ変わった数字だけactive', () => {
  const ctx = createTestDb();
  const d1 = addTask(ctx.db, { title: 'D1', status: 'done' });
  addStatusEvent(ctx.db, d1, 'done', IN_PERIOD);
  const d2 = addTask(ctx.db, { title: 'D2', status: 'done' });
  addStatusEvent(ctx.db, d2, 'done', IN_PERIOD);
  const r1 = addTask(ctx.db, { title: 'R1', status: 'ready', dueDate: '2026-10-15' });
  addStatusEvent(ctx.db, r1, 'ready', '2026-10-01T01:00:00.000Z'); // 期間外。期日で拾われるだけ
  addTask(ctx.db, { title: 'T1', status: 'todo', dueDate: '2026-10-16' });
  const { counts, active } = wr.buildWeeklyCounts(ctx.db, CONFIG, { from: PERIOD.from, to: PERIOD.to, workspaces: ['alpha'] }).workspaces[0];
  assert.deepEqual(counts, { todo: 1, ready: 1, do: 0, done: 2 });
  assert.deepEqual(active, { todo: false, ready: false, do: false, done: true });
  // 出力ステータスの選択に関わらず同じ(doneだけ選んでもTODO/READYを数える)
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, statuses: ['done'] });
  assert.deepEqual(data.workspaces[0].statusCounts.counts, counts);
  const { markdown } = wr.renderWeeklyReport(data, { template: '{{#workspace}}{{statusCounts}}{{/workspace}}', columns: [] });
  assert.equal(markdown.trim(), '`TODO 1` `READY 1` `DO 0` **`DONE 2`**');
  assert.equal(wr.buildWeeklyCounts(ctx.db, CONFIG, { from: 'x', to: 'y' }).error, 'invalid_period');
  cleanup(ctx);
});

test('TODOは期間内の新規作成もactive扱いにする', () => {
  const ctx = createTestDb();
  const t = addTask(ctx.db, { title: '今週作った', status: 'todo', dueDate: '2026-10-16' });
  ctx.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(IN_PERIOD, t.id);
  const { active } = wr.buildWeeklyCounts(ctx.db, CONFIG, { from: PERIOD.from, to: PERIOD.to, workspaces: ['alpha'] }).workspaces[0];
  assert.equal(active.todo, true);
  cleanup(ctx);
});

test('外部ITS列: Redmine/GitLabのチケットをリンク付きで出す', () => {
  const ctx = createTestDb();
  const a = addTask(ctx.db, { title: '外部あり', status: 'done' });
  addStatusEvent(ctx.db, a, 'done', IN_PERIOD);
  ctx.db.prepare(`INSERT INTO task_external_links (task_id, source, host, project_ref, issue_key, issue_url, linked_at, linked_by)
    VALUES (?, 'redmine', 'rm.example', 'proj', '1234', 'https://rm.example/issues/1234', ?, 'user')`).run(a.id, IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  const { markdown } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: ['id', 'title', 'external'] });
  assert.match(markdown, /\| 外部ITS Issue \|/);
  assert.ok(markdown.includes('[Redmine #1234](https://rm.example/issues/1234)'));
  cleanup(ctx);
});

test('区分: 完了/対応中/期限超過/未着手、最終更新日は全期間の最後の変更(日付のみ)', () => {
  const ctx = createTestDb();
  const a = addTask(ctx.db, { title: 'A', status: 'do', dueDate: '2026-10-15' });
  addStatusEvent(ctx.db, a, 'ready', '2026-10-02T01:00:00.000Z');
  addStatusEvent(ctx.db, a, 'do', IN_PERIOD);
  addTask(ctx.db, { title: 'B', status: 'todo', dueDate: '2026-10-01' });
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, today: '2026-10-14' });
  const items = itemsOf(data.workspaces[0]);
  const byTitle = Object.fromEntries(items.map(i => [i.title, i]));
  assert.equal(byTitle.A.kind, '対応中');
  assert.equal(byTitle.A.updatedAt, '2026-10-13');
  assert.equal(byTitle.B.kind, '期限超過');
  cleanup(ctx);
});

test('Markdown: ワークスペースごとの見出し・表・サマリー、パイプや改行は崩れない', () => {
  const ctx = createTestDb();
  const a = addTask(ctx.db, { title: 'a|b\n改行', status: 'done' });
  addStatusEvent(ctx.db, a, 'done', IN_PERIOD);
  const b = addTask(ctx.db, { workspace: 'beta', title: 'ベータ側', status: 'done' });
  addStatusEvent(ctx.db, b, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, workspaces: ['alpha', 'beta'] });
  const { markdown, warnings } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: ['id', 'title', 'status', 'updatedAt'] });
  assert.deepEqual(warnings, []);
  assert.match(markdown, /^# 週報 2026-10-12（月） 〜 2026-10-18（日）/);
  assert.match(markdown, /## AL アルファ `TODO 0` `READY 0` `DO 0` \*\*`DONE 1`\*\*\n\n完了 1件 \/ 対応中 0件/);
  assert.match(markdown, /## BE ベータ/);
  assert.match(markdown, /\| ID \| 件名 \| ステータス \| 最終更新日 \|\n\| --- \| --- \| --- \| --- \|/);
  assert.match(markdown, /a\\\|b 改行/);
  cleanup(ctx);
});

test('件名に {{...}} が入っていても再展開されず、未知のプレースホルダーは警告になる', () => {
  const ctx = createTestDb();
  const a = addTask(ctx.db, { title: '{{period}} を含む件名', status: 'done' });
  addStatusEvent(ctx.db, a, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  const { markdown } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  assert.match(markdown, /\{\{period\}\} を含む件名/);
  const { warnings } = wr.renderWeeklyReport(data, { template: '{{nothing}} {{#workspace}}{{table}}', columns: [] });
  assert.ok(warnings.some(w => w.includes('{{nothing}}')));
  assert.ok(warnings.some(w => w.includes('{{#workspace}}')));
  cleanup(ctx);
});

test('列指定: idとtitleは必須で補われ、未知の列は無視される', () => {
  assert.deepEqual(wr.normalizeColumns(['status', 'bogus']), ['id', 'title', 'status']);
  assert.deepEqual(wr.normalizeColumns([]), wr.DEFAULT_COLUMNS);
});

test('入力の検証: 期間・ワークスペース・ステータスの不正は error を返す', () => {
  const ctx = createTestDb();
  const check = input => wr.buildWeeklyReport(ctx.db, CONFIG, input, { template: wr.DEFAULT_TEMPLATE, columns: [] });
  assert.equal(check({ from: 'x', to: '2026-10-18' }).error, 'invalid_period');
  assert.equal(check({ from: '2026-10-19', to: '2026-10-18' }).error, 'invalid_period');
  assert.equal(check({ ...PERIOD, workspaces: ['nope'] }).error, 'unknown_workspace');
  assert.equal(check({ ...PERIOD, statuses: ['??'] }).error, 'invalid_status');
  assert.equal(check({ range: 'this' }).ok, true);
  cleanup(ctx);
});

test('書式の保存・読み込み・リセット', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-wr-'));
  assert.equal(wr.loadTemplate(dir).saved, false);
  assert.equal(wr.saveTemplate(dir, { template: '   ' }).error, 'invalid_template');
  assert.equal(wr.saveTemplate(dir, { template: 'x'.repeat(wr.TEMPLATE_MAX_LENGTH + 1) }).error, 'invalid_template');
  assert.equal(wr.saveTemplate(dir, { template: '# T {{period}}', columns: ['status'] }).ok, true);
  const loaded = wr.loadTemplate(dir);
  assert.deepEqual([loaded.saved, loaded.template, loaded.columns], [true, '# T {{period}}', ['id', 'title', 'status']]);
  wr.resetTemplate(dir);
  assert.equal(wr.loadTemplate(dir).saved, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

function addCategoryMaster(db, name, sortOrder) {
  db.prepare(`INSERT INTO categories (name, name_key, sort_order, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', 'user', '2026-10-01T00:00:00.000Z', 'user')`).run(name, name, sortOrder);
}

test('BT-442 カテゴリの章: マスタ順→マスタ外→カテゴリなし、期間内にタスクが無いカテゴリは出さない', () => {
  const ctx = createTestDb();
  addCategoryMaster(ctx.db, '調査', 1);
  addCategoryMaster(ctx.db, '開発', 2);
  addCategoryMaster(ctx.db, '未使用', 3);
  for (const [title, category] of [['開発1', '開発'], ['調査1', '調査'], ['旧値1', '旧自由入力'], ['なし1', null]]) {
    const t = addTask(ctx.db, { title, status: 'done', category });
    addStatusEvent(ctx.db, t, 'done', IN_PERIOD);
  }
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupByCategory: true });
  assert.deepEqual(data.workspaces[0].categoryGroups.map(g => g.name), ['調査', '開発', '旧自由入力', '']);
  const { markdown } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  // BM-121: カテゴリは見出し(###、カテゴリ名そのまま。「カテゴリ名：」の修飾なし)にする。
  // 章の中はステータス見出しを分けず1枚の表にする
  assert.ok(markdown.includes('### 調査\n\n| ID |'));
  assert.doesNotMatch(markdown, /完了（DONE）/); // ステータス見出しは出ない
  assert.ok(markdown.includes('### なし'));
  assert.doesNotMatch(markdown, /未使用/);
  cleanup(ctx);
});

test('BM-121 カテゴリ章内の並び順: 見出しは分けないが、期限超過→完了→対応中→未着手の優先度で並ぶ', () => {
  const ctx = createTestDb();
  const done = addTask(ctx.db, { title: '完了', status: 'done', category: '開発' });
  addStatusEvent(ctx.db, done, 'done', IN_PERIOD);
  const doing = addTask(ctx.db, { title: '対応中', status: 'do', category: '開発' });
  addStatusEvent(ctx.db, doing, 'do', IN_PERIOD);
  addTask(ctx.db, { title: '未着手', status: 'todo', category: '開発', dueDate: '2026-10-16' });
  addTask(ctx.db, { title: '期限超過', status: 'todo', category: '開発', dueDate: '2026-10-01' });
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, statuses: ['todo', 'ready', 'do', 'done'], groupByCategory: true, today: '2026-10-14' });
  const group = data.workspaces[0].categoryGroups.find(g => g.name === '開発');
  assert.deepEqual(group.items.map(i => i.title), ['期限超過', '完了', '対応中', '未着手']);
  cleanup(ctx);
});

test('BT-442 categoriesで絞り込む(空文字はカテゴリなし)。章分けオフでも有効で、未指定なら従来どおり', () => {
  const ctx = createTestDb();
  addCategoryMaster(ctx.db, '調査', 1);
  addCategoryMaster(ctx.db, '開発', 2);
  for (const [title, category] of [['開発1', '開発'], ['調査1', '調査'], ['なし1', null]]) {
    const t = addTask(ctx.db, { title, status: 'done', category });
    addStatusEvent(ctx.db, t, 'done', IN_PERIOD);
  }
  const titles = opts => itemsOf(wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, ...opts }).workspaces[0]).map(i => i.title).sort();
  assert.deepEqual(titles({ categories: ['調査', ''] }), ['なし1', '調査1']);
  assert.deepEqual(titles({ categories: ['開発'] }), ['開発1']);
  assert.deepEqual(titles({}), ['なし1', '調査1', '開発1']);
  const off = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  assert.equal(off.workspaces[0].categoryGroups, null);
  const { markdown } = wr.renderWeeklyReport(off, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  assert.ok(markdown.includes('### 完了（DONE）\n\n| ID |')); // オフの出力は従来のまま
  cleanup(ctx);
});

test('BT-442 parseReportOptions: groupByCategory/categoriesの正規化と不正値', () => {
  const ctx = createTestDb();
  const ok = wr.parseReportOptions({ range: 'this', groupByCategory: '1', categories: ['__none__', 'x'] }, CONFIG, ctx.db);
  assert.equal(ok.groupByCategory, true);
  assert.deepEqual(ok.categories, ['', 'x']);
  assert.equal(wr.parseReportOptions({ range: 'this' }, CONFIG, ctx.db).categories, undefined);
  assert.equal(wr.parseReportOptions({ range: 'this', categories: [1] }, CONFIG, ctx.db).error, 'invalid_category');
  cleanup(ctx);
});

test('BT-442 buildWeeklyCounts: ワークスペースごとにカテゴリ別の件数(選択ステータスで出力対象になる数)を返す', () => {
  const ctx = createTestDb();
  addCategoryMaster(ctx.db, '開発', 1);
  for (const [title, category] of [['a', '開発'], ['b', '開発'], ['c', null]]) {
    const t = addTask(ctx.db, { title, status: 'done', category });
    addStatusEvent(ctx.db, t, 'done', IN_PERIOD);
  }
  const r = wr.buildWeeklyCounts(ctx.db, CONFIG, { from: '2026-10-12', to: '2026-10-18', workspaces: ['alpha'], statuses: ['done'] });
  assert.deepEqual(r.workspaces[0].categories, { 開発: 2, '': 1 });
  cleanup(ctx);
});

test('BT-442 旧データのカテゴリ「-」はカテゴリなしとして扱う', () => {
  const ctx = createTestDb();
  const t = addTask(ctx.db, { title: 'x', status: 'done', category: '-' });
  addStatusEvent(ctx.db, t, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupByCategory: true });
  assert.deepEqual(data.workspaces[0].categoryGroups.map(g => g.name), ['']);
  cleanup(ctx);
});

// --- BM-136: コメント列(集計期間内の最新1件) ---

function addComment(db, task, body, createdAt, createdBy = 'user') {
  const r = db.prepare('INSERT INTO task_comments (task_id, body, created_at, created_by) VALUES (?, ?, ?, ?)')
    .run(task.id, body, createdAt, createdBy);
  return Number(r.lastInsertRowid);
}

const COMMENT_COLUMNS = [...wr.DEFAULT_COLUMNS, 'comment'];

test('BM-136 コメント列は選べる列に出るが、既定の列には入っていない', () => {
  assert.ok(wr.COLUMN_DEFS.some(c => c.key === 'comment' && c.label === 'コメント'));
  assert.ok(!wr.DEFAULT_COLUMNS.includes('comment'));
  // 保存済みの書式に無くても壊れず、選んだ時だけ列として残る
  assert.ok(!wr.normalizeColumns(['id', 'title']).includes('comment'));
  assert.ok(wr.normalizeColumns(['id', 'title', 'comment']).includes('comment'));
});

test('BM-136 単発タスクは、集計期間内に投稿された最新のコメント1件だけを出す。期間外のコメントは出さない', () => {
  const ctx = createTestDb();
  const solo = addTask(ctx.db, { title: '単発', status: 'done' });
  addStatusEvent(ctx.db, solo, 'done', IN_PERIOD);
  addComment(ctx.db, solo, '期間より前のコメント', '2026-10-10T01:00:00.000Z');
  addComment(ctx.db, solo, '期間内の古いコメント', '2026-10-13T01:00:00.000Z');
  addComment(ctx.db, solo, '期間内の最新コメント', '2026-10-15T01:00:00.000Z');
  addComment(ctx.db, solo, '期間より後のコメント', '2026-10-20T01:00:00.000Z');

  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  assert.equal(itemsOf(data.workspaces[0])[0].comment, '期間内の最新コメント');
  const { markdown } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: COMMENT_COLUMNS });
  assert.match(markdown, /\| ID \| 件名 \| 区分 \| ステータス \| 最終更新日 \| 期日 \| コメント \|/);
  assert.match(markdown, /\| 単発 \|.*\| 期間内の最新コメント \|/);
  assert.doesNotMatch(markdown, /期間より前|期間より後|期間内の古い/);
  cleanup(ctx);
});

test('BM-136 コメントが期間内に無ければ空欄。列を選ばなければ表に出ない', () => {
  const ctx = createTestDb();
  const solo = addTask(ctx.db, { title: '単発', status: 'done' });
  addStatusEvent(ctx.db, solo, 'done', IN_PERIOD);
  addComment(ctx.db, solo, '先週のコメント', '2026-10-08T01:00:00.000Z');
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  assert.equal(itemsOf(data.workspaces[0])[0].comment, '');
  const withCol = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: COMMENT_COLUMNS }).markdown;
  assert.match(withCol, /\| 単発 \|.*\| {2}\|$/m, '空欄のセルになる');
  const withoutCol = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS }).markdown;
  assert.doesNotMatch(withoutCol, /コメント|先週/);
  cleanup(ctx);
});

test('BM-136 期間の境目はJSTで判定する(UTCでは前日でもJSTでは期間初日の0:30なら入る)', () => {
  const ctx = createTestDb();
  const solo = addTask(ctx.db, { title: '単発', status: 'done' });
  addStatusEvent(ctx.db, solo, 'done', IN_PERIOD);
  addComment(ctx.db, solo, '期間初日の0:30(JST)', '2026-10-11T15:30:00.000Z'); // JST 10/12 00:30
  addComment(ctx.db, solo, '前日の23:59(JST)', '2026-10-11T14:59:00.000Z'); // JST 10/11 23:59
  let item = itemsOf(wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD).workspaces[0])[0];
  assert.equal(item.comment, '期間初日の0:30(JST)');

  addComment(ctx.db, solo, '期間最終日の23:59(JST)', '2026-10-18T14:59:00.000Z'); // JST 10/18 23:59
  addComment(ctx.db, solo, '翌日の0:00(JST)', '2026-10-18T15:00:00.000Z'); // JST 10/19 00:00
  item = itemsOf(wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD).workspaces[0])[0];
  assert.equal(item.comment, '期間最終日の23:59(JST)');
  cleanup(ctx);
});

test('BM-136 EPIC行は、EPIC自身とヒットした子の期間内コメントのうち最新の1件を出し、子のコメントには子IDを前置する', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: '大きな話', status: 'do' });
  const k1 = addTask(ctx.db, { title: '子1', status: 'done', parentId: epic.id });
  const k2 = addTask(ctx.db, { title: '子2', status: 'done', parentId: epic.id });
  const quiet = addTask(ctx.db, { title: '子3(ヒットしない)', status: 'todo', parentId: epic.id });
  addStatusEvent(ctx.db, k1, 'done', IN_PERIOD);
  addStatusEvent(ctx.db, k2, 'done', IN_PERIOD);
  addComment(ctx.db, k1, '子1の古いコメント', '2026-10-13T01:00:00.000Z');
  addComment(ctx.db, k2, '子2のコメント', '2026-10-14T01:00:00.000Z');
  addComment(ctx.db, quiet, 'ヒットしない子のコメントは出さない', '2026-10-16T01:00:00.000Z');
  addComment(ctx.db, epic, 'EPIC自身の古いコメント', '2026-10-12T05:00:00.000Z');

  let item = itemsOf(wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD).workspaces[0]).find(i => i.isEpic);
  assert.equal(item.comment, `${k2.displayId}: 子2のコメント`, '子のコメントが最新なら子IDを前置');

  addComment(ctx.db, epic, 'EPIC自身の最新コメント', '2026-10-17T01:00:00.000Z');
  item = itemsOf(wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD).workspaces[0]).find(i => i.isEpic);
  assert.equal(item.comment, 'EPIC自身の最新コメント', 'EPIC自身が最新ならそのまま出す');

  const { markdown } = wr.renderWeeklyReport(wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD), { template: wr.DEFAULT_TEMPLATE, columns: COMMENT_COLUMNS });
  assert.doesNotMatch(markdown, /ヒットしない子のコメント/);
  cleanup(ctx);
});

test('BM-136 コメントの改行とパイプは表を壊さないように整える', () => {
  const ctx = createTestDb();
  const solo = addTask(ctx.db, { title: '単発', status: 'done' });
  addStatusEvent(ctx.db, solo, 'done', IN_PERIOD);
  addComment(ctx.db, solo, '1行目\n2行目 a|b', '2026-10-15T01:00:00.000Z');
  const { markdown } = wr.renderWeeklyReport(wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD), { template: wr.DEFAULT_TEMPLATE, columns: COMMENT_COLUMNS });
  assert.match(markdown, /1行目 2行目 a\\\|b \|/);
  cleanup(ctx);
});

// --- BM-138: 1段目のグルーピング(ワークスペース／カテゴリ) ---

const BOTH = { ...PERIOD, workspaces: ['alpha', 'beta'] };

// 期間内に完了したタスクを作る
function addDoneTask(db, { workspace = 'alpha', title, category = null }) {
  const t = addTask(db, { workspace, title, status: 'done', category });
  addStatusEvent(db, t, 'done', IN_PERIOD);
  return t;
}

test('BM-138 カテゴリ軸: ワークスペースをまたいで同じカテゴリを1つの章にまとめ、マスタ順→マスタ外→カテゴリなしで並ぶ', () => {
  const ctx = createTestDb();
  addCategoryMaster(ctx.db, '調査', 1);
  addCategoryMaster(ctx.db, '開発', 2);
  addCategoryMaster(ctx.db, '未使用', 3);
  addDoneTask(ctx.db, { workspace: 'alpha', title: 'A開発', category: '開発' });
  addDoneTask(ctx.db, { workspace: 'beta', title: 'B開発', category: '開発' });
  addDoneTask(ctx.db, { workspace: 'beta', title: 'B調査', category: '調査' });
  addDoneTask(ctx.db, { workspace: 'alpha', title: 'A旧値', category: '旧自由入力' });
  addDoneTask(ctx.db, { workspace: 'beta', title: 'Bなし', category: null });

  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...BOTH, groupBy: 'category' });
  assert.equal(data.groupBy, 'category');
  assert.deepEqual(data.categories.map(g => g.name), ['調査', '開発', '旧自由入力', '']);
  assert.deepEqual(data.categories.find(g => g.name === '開発').items.map(i => i.title).sort(), ['A開発', 'B開発']);
  assert.equal(data.workspaces.length, 2); // JSONの互換のため、ワークスペース別のデータも従来どおり付く

  const { markdown, warnings } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  assert.deepEqual(warnings, []);
  assert.ok(markdown.includes('## 調査 `TODO 0`'));
  assert.ok(markdown.includes('## カテゴリなし'));
  assert.doesNotMatch(markdown, /未使用/); // 期間内にタスクが無いカテゴリは出ない
  assert.doesNotMatch(markdown, /## AL |## BE /); // ワークスペースの見出しは出ない
  assert.doesNotMatch(markdown, /^###/m); // 章の中は見出しを分けず1枚の表
  const order = ['## 調査', '## 開発', '## 旧自由入力', '## カテゴリなし'].map(h => markdown.indexOf(h));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), order.join(','));
  // 開発の章には、両ワークスペースのタスクがIDの接頭辞付きで並ぶ
  const section = markdown.slice(markdown.indexOf('## 開発'), markdown.indexOf('## 旧自由入力'));
  assert.match(section, /\| AL-\d{3} \|/);
  assert.match(section, /\| BE-\d{3} \|/);
  cleanup(ctx);
});

test('BM-138 カテゴリ軸: サマリーと件数バッジはカテゴリ単位で、章内は期限超過→完了→対応中→未着手の順', () => {
  const ctx = createTestDb();
  addDoneTask(ctx.db, { workspace: 'alpha', title: 'A完了', category: '開発' });
  const doing = addTask(ctx.db, { workspace: 'beta', title: 'B対応中', status: 'do', category: '開発' });
  addStatusEvent(ctx.db, doing, 'do', IN_PERIOD);
  addTask(ctx.db, { workspace: 'beta', title: 'B期限超過', status: 'todo', category: '開発', dueDate: '2026-10-01' });
  addDoneTask(ctx.db, { workspace: 'alpha', title: '別カテゴリ', category: '調査' });

  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...BOTH, statuses: ['todo', 'ready', 'do', 'done'], groupBy: 'category', today: '2026-10-14' });
  const g = data.categories.find(c => c.name === '開発');
  assert.deepEqual(g.items.map(i => i.title), ['B期限超過', 'A完了', 'B対応中']);
  assert.equal(g.count, 3);
  assert.deepEqual(g.counts, { done: 1, doing: 1, overdue: 1, planned: 0 });
  assert.deepEqual(g.statusCounts.counts, { todo: 1, ready: 0, do: 1, done: 1 }); // 別カテゴリの完了は数えない
  assert.deepEqual(g.statusCounts.active, { todo: false, ready: false, do: true, done: true }); // 期間内に動いたステータスだけactive
  const { markdown } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  assert.ok(markdown.includes('## 開発 `TODO 1` `READY 0` **`DO 1`** **`DONE 1`**\n\n完了 1件 / 対応中 1件 / 期限超過 1件'));
  cleanup(ctx);
});

test('BM-138 カテゴリ軸: EPICは親のカテゴリの章に1行で入る(子自身のcategoryは見ない)', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: '大きな話', status: 'do', category: '開発' });
  const child = addTask(ctx.db, { title: '子', status: 'done', parentId: epic.id, category: '調査' });
  addStatusEvent(ctx.db, child, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupBy: 'category' });
  assert.deepEqual(data.categories.map(g => g.name), ['開発']);
  assert.equal(data.categories[0].items.length, 1);
  assert.equal(data.categories[0].items[0].isEpic, true);
  // 件数バッジも親のカテゴリとして数える
  assert.equal(data.categories[0].statusCounts.counts.done, 1);
  cleanup(ctx);
});

test('BM-138 groupByの既定はworkspace(従来どおり)。groupByCategoryはカテゴリ軸では2段目を作らず無視される', () => {
  const ctx = createTestDb();
  addDoneTask(ctx.db, { title: 'x', category: '開発' });
  const base = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  assert.equal(base.groupBy, 'workspace');
  assert.equal(base.categories, undefined);
  const cat = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupBy: 'category', groupByCategory: true });
  assert.equal(cat.workspaces[0].categoryGroups, null);
  const ws = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupBy: 'workspace', groupByCategory: true });
  assert.deepEqual(ws.workspaces[0].categoryGroups.map(g => g.name), ['開発']);
  cleanup(ctx);
});

test('BM-138 categoriesで絞り込むとカテゴリ軸でも該当カテゴリの章だけになる(空文字はカテゴリなし)', () => {
  const ctx = createTestDb();
  addCategoryMaster(ctx.db, '調査', 1);
  addCategoryMaster(ctx.db, '開発', 2);
  addDoneTask(ctx.db, { workspace: 'alpha', title: 'a', category: '開発' });
  addDoneTask(ctx.db, { workspace: 'beta', title: 'b', category: '調査' });
  addDoneTask(ctx.db, { workspace: 'beta', title: 'c', category: null });
  const names = categories => wr.collectWeeklyReport(ctx.db, CONFIG, { ...BOTH, groupBy: 'category', categories }).categories.map(g => g.name);
  assert.deepEqual(names(['調査']), ['調査']);
  assert.deepEqual(names(['', '開発']), ['開発', '']);
  assert.deepEqual(names(undefined), ['調査', '開発', '']);
  cleanup(ctx);
});

test('BM-138 parseReportOptions: groupByの既定・正規化・不正値', () => {
  const ctx = createTestDb();
  const parse = input => wr.parseReportOptions({ range: 'this', ...input }, CONFIG, ctx.db);
  assert.equal(parse({}).groupBy, 'workspace');
  assert.equal(parse({ groupBy: '' }).groupBy, 'workspace');
  assert.equal(parse({ groupBy: null }).groupBy, 'workspace');
  assert.equal(parse({ groupBy: 'category' }).groupBy, 'category');
  assert.equal(parse({ groupBy: 'tag' }).error, 'invalid_group_by');
  const built = wr.buildWeeklyReport(ctx.db, CONFIG, { range: 'this', groupBy: 'category' }, { template: wr.DEFAULT_TEMPLATE, columns: [] });
  assert.equal(built.ok, true);
  assert.equal(built.data.groupBy, 'category');
  assert.equal(wr.buildWeeklyReport(ctx.db, CONFIG, { range: 'this', groupBy: 'x' }, { template: wr.DEFAULT_TEMPLATE, columns: [] }).error, 'invalid_group_by');
  cleanup(ctx);
});

test('BM-138 書式: {{#group}}はどちらの軸でも動き、旧{{#workspace}}も同じ意味で使える', () => {
  const ctx = createTestDb();
  addDoneTask(ctx.db, { title: 'x', category: '開発' });
  const wsData = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  const catData = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupBy: 'category' });
  const render = (data, template) => wr.renderWeeklyReport(data, { template, columns: wr.DEFAULT_COLUMNS });

  const group = '{{#group}}[{{groupName}}|{{count}}]{{/group}}';
  assert.equal(render(wsData, group).markdown, '[AL アルファ|1]\n');
  assert.equal(render(catData, group).markdown, '[開発|1]\n');
  assert.deepEqual([render(wsData, group).warnings, render(catData, group).warnings], [[], []]);

  // 旧名: ワークスペース軸ではこれまでどおり。workspaceId/Nameもそのまま使える
  const old = '{{#workspace}}[{{workspaceId}}|{{workspaceName}}|{{groupName}}]{{/workspace}}';
  const oldWs = render(wsData, old);
  assert.equal(oldWs.markdown, '[AL|アルファ|AL アルファ]\n');
  assert.deepEqual(oldWs.warnings, []);
  cleanup(ctx);
});

test('BM-138 書式: カテゴリ軸でworkspaceName等を使うと空になり警告する。囲みの名前が対でない場合も警告する', () => {
  const ctx = createTestDb();
  addDoneTask(ctx.db, { title: 'x', category: '開発' });
  const catData = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupBy: 'category' });
  const wsData = wr.collectWeeklyReport(ctx.db, CONFIG, PERIOD);
  const render = (data, template) => wr.renderWeeklyReport(data, { template, columns: wr.DEFAULT_COLUMNS });

  const old = render(catData, '{{#workspace}}[{{workspaceName}}|{{groupName}}]{{/workspace}}');
  assert.equal(old.markdown, '[|開発]\n');
  assert.ok(old.warnings.some(w => w.includes('{{groupName}}')));
  // ワークスペース軸では同じ書式で警告は出ない
  assert.deepEqual(render(wsData, '{{#workspace}}[{{workspaceName}}]{{/workspace}}').warnings, []);

  assert.ok(render(wsData, '{{#group}}x{{/workspace}}').warnings.some(w => w.includes('1組だけ')));
  assert.ok(render(wsData, '{{#group}}x{{#group}}y{{/group}}{{/group}}').warnings.some(w => w.includes('1組だけ')));
  cleanup(ctx);
});

test('BM-138 カテゴリ軸で該当タスクが無い時は「該当なし」を出す。カテゴリなしの名前は「カテゴリなし」', () => {
  const ctx = createTestDb();
  const empty = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupBy: 'category' });
  assert.deepEqual(empty.categories, []);
  const { markdown } = wr.renderWeeklyReport(empty, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  assert.ok(markdown.includes('(該当するタスクはありません)'));
  // 旧データの「-」もカテゴリなしの章になる
  addDoneTask(ctx.db, { title: 'y', category: '-' });
  const none = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, groupBy: 'category' });
  assert.deepEqual(none.categories.map(g => g.name), ['']);
  assert.ok(wr.renderWeeklyReport(none, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS }).markdown.includes('## カテゴリなし'));
  cleanup(ctx);
});

test('BM-138 既定の書式はグループの枠({{#group}})で、プレースホルダー説明にgroupNameとgroupが載っている', () => {
  assert.match(wr.DEFAULT_TEMPLATE, /\{\{#group\}\}[\s\S]*\{\{groupName\}\}[\s\S]*\{\{\/group\}\}/);
  const names = wr.PLACEHOLDERS.map(p => p.name);
  assert.ok(names.includes('groupName'));
  assert.ok(names.includes('#group … /group'));
});
