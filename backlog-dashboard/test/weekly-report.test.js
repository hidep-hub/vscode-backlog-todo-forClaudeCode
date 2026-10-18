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
function addTask(db, { workspace = 'alpha', title, status = 'todo', parentId = null, dueDate = null, deleted = false, tagless = true }) {
  seq += 1;
  const prefix = workspace === 'alpha' ? 'AL' : 'BE';
  const now = '2026-10-01T00:00:00.000Z';
  const r = db.prepare(`INSERT INTO tasks (workspace, seq_no, display_id, parent_id, title, status, due_date, sort_order,
    deleted_at, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(workspace, seq, `${prefix}-${String(seq).padStart(3, '0')}`, parentId, title, status, dueDate, seq,
      deleted ? now : null, now, 'user', now, 'user');
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

test('子タスクは区分ごとの表で、件名の頭に親のIDと件名を小さく付けてぶら下げる(単発/EPICの区分けはしない)', () => {
  const ctx = createTestDb();
  const epic = addTask(ctx.db, { title: '大きな話', status: 'do' });
  const k1 = addTask(ctx.db, { title: '子1', status: 'done', parentId: epic.id });
  addTask(ctx.db, { title: '子2', status: 'todo', parentId: epic.id, dueDate: '2026-10-15' });
  const solo = addTask(ctx.db, { title: '単発', status: 'done' });
  addStatusEvent(ctx.db, k1, 'done', IN_PERIOD);
  addStatusEvent(ctx.db, solo, 'done', IN_PERIOD);
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, today: '2026-10-14' });
  const ws = data.workspaces[0];
  assert.deepEqual(ws.sections.map(s => s.kind), ['完了', '未着手']);
  assert.deepEqual(ws.sections[0].items.map(i => i.title).sort(), ['単発', '子1']);
  assert.equal(itemsOf(ws).find(i => i.title === '子1').parentId, epic.displayId);
  const { markdown } = wr.renderWeeklyReport(data, { template: wr.DEFAULT_TEMPLATE, columns: wr.DEFAULT_COLUMNS });
  assert.ok(markdown.includes(`<small>${epic.displayId} 大きな話</small><br/>└ 子1`));
  assert.match(markdown, /\| 単発 \|/); // 親のいないタスクは件名だけ
  assert.doesNotMatch(markdown, /単発タスク|完了 \d+\/全/);
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

test('区分: 完了/対応中/期限超過/未着手、最終ステータス更新は全期間の最後の変更', () => {
  const ctx = createTestDb();
  const a = addTask(ctx.db, { title: 'A', status: 'do', dueDate: '2026-10-15' });
  addStatusEvent(ctx.db, a, 'ready', '2026-10-02T01:00:00.000Z');
  addStatusEvent(ctx.db, a, 'do', IN_PERIOD);
  addTask(ctx.db, { title: 'B', status: 'todo', dueDate: '2026-10-01' });
  const data = wr.collectWeeklyReport(ctx.db, CONFIG, { ...PERIOD, today: '2026-10-14' });
  const items = itemsOf(data.workspaces[0]);
  const byTitle = Object.fromEntries(items.map(i => [i.title, i]));
  assert.equal(byTitle.A.kind, '対応中');
  assert.equal(byTitle.A.updatedAt, '2026-10-13 10:00');
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
  assert.match(markdown, /^# 週報 2026-10-12 〜 2026-10-18/);
  assert.match(markdown, /## AL アルファ `TODO 0` `READY 0` `DO 0` \*\*`DONE 1`\*\*\n\n完了 1件 \/ 対応中 0件/);
  assert.match(markdown, /## BE ベータ/);
  assert.match(markdown, /\| ID \| 件名 \| ステータス \| 最終ステータス更新 \|\n\| --- \| --- \| --- \| --- \|/);
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
