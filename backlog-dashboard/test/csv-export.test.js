'use strict';

// BT-412: タスク一覧CSVエクスポート(db/csv-export.js)の並び・列・変換ルールを検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const tagsRepo = require('../db/tags-repo');
const externalLinksRepo = require('../db/external-links-repo');
const { buildTaskCsv, COLUMNS, DESCRIPTION_LIMIT, TRUNCATION_MARKER } = require('../db/csv-export');

function createTestDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-dashboard-test-'));
  const db = new DatabaseSync(path.join(directory, 'backlog.sqlite3'));
  createSchema(db);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('alpha', 'AL', 1);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('beta', 'BE', 1);
  return { db, directory };
}

function cleanup({ db, directory }) {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

// RFC 4180の最小パーサ(クォート内のカンマ・改行・""に対応)
function parseCsv(text) {
  const body = text.replace(/^﻿/, '');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\r' && body[i + 1] === '\n') { record.push(field); records.push(record); record = []; field = ''; i += 1; }
    else field += ch;
  }
  const [header, ...rows] = records;
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

test('starts with BOM, uses CRLF and the agreed column order', () => {
  const f = createTestDb();
  try {
    tasksRepo.create(f.db, { workspace: 'alpha', title: 'a', status: 'todo' });
    const { csv, rowCount } = buildTaskCsv(f.db);
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    assert.equal(csv.split('\r\n')[0].replace('﻿', ''), COLUMNS.join(','));
    assert.equal(COLUMNS[0], 'workspace');
    assert.equal(rowCount, 1);
    assert.ok(csv.endsWith('\r\n'));
  } finally { cleanup(f); }
});

test('orders EPIC then its children, top level by effective status, with board_order', () => {
  const f = createTestDb();
  try {
    const done = tasksRepo.create(f.db, { workspace: 'alpha', title: 'finished single', status: 'done' });
    const epic = tasksRepo.create(f.db, { workspace: 'alpha', title: 'epic', status: 'todo' });
    const c1 = tasksRepo.create(f.db, { workspace: 'alpha', title: 'child1', status: 'todo', parentDisplayId: epic.display_id });
    const c2 = tasksRepo.create(f.db, { workspace: 'alpha', title: 'child2', status: 'do', parentDisplayId: epic.display_id });
    const single = tasksRepo.create(f.db, { workspace: 'alpha', title: 'plain todo', status: 'todo' });

    const rows = parseCsv(buildTaskCsv(f.db, { workspace: 'alpha' }).csv);
    // epicは子にdoがあるため実効ステータスdo。todoの単発 → do(epic+子) → done の順
    assert.deepEqual(rows.map(r => r.id), [single.display_id, epic.display_id, c1.display_id, c2.display_id, done.display_id]);
    assert.deepEqual(rows.map(r => r.type), ['single', 'epic', 'child', 'child', 'single']);
    assert.deepEqual(rows.map(r => r.status), ['todo', 'do', 'todo', 'do', 'done']);
    assert.deepEqual(rows.map(r => r.board_order), ['1', '1', '1', '2', '1']);
    assert.equal(rows[2].parent_id, epic.display_id);
    assert.equal(rows[1].parent_id, '');
  } finally { cleanup(f); }
});

test('excludes soft-deleted tasks and filters by workspace; workspace is always the first column', () => {
  const f = createTestDb();
  try {
    tasksRepo.create(f.db, { workspace: 'alpha', title: 'keep', status: 'todo' });
    const gone = tasksRepo.create(f.db, { workspace: 'alpha', title: 'gone', status: 'todo' });
    tasksRepo.create(f.db, { workspace: 'beta', title: 'other', status: 'todo' });
    tasksRepo.softDelete(f.db, gone.display_id);

    const alpha = parseCsv(buildTaskCsv(f.db, { workspace: 'alpha' }).csv);
    assert.deepEqual(alpha.map(r => r.title), ['keep']);
    const all = parseCsv(buildTaskCsv(f.db).csv);
    assert.deepEqual(all.map(r => [r.workspace, r.title]), [['alpha', 'keep'], ['beta', 'other']]);
    assert.equal(buildTaskCsv(f.db, { workspace: 'none' }).rowCount, 0);
  } finally { cleanup(f); }
});

test('exports tags, deliverable file names, GitHub and Redmine links', () => {
  const f = createTestDb();
  try {
    const task = tasksRepo.create(f.db, {
      workspace: 'alpha', title: 'linked', status: 'todo', category: 'cat', assignee: 'me',
      startDate: '2026-10-01', dueDate: '2026-10-02',
      githubIssueNumber: 12, githubIssueUrl: 'https://github.com/o/r/issues/12',
    });
    externalLinksRepo.insertLink(f.db, {
      taskId: task.id, source: 'redmine', host: 'http://h/redmine', projectRef: 'p', issueKey: 42, issueUrl: 'http://h/redmine/issues/42',
    });
    const t1 = tagsRepo.createTag(f.db, { workspace: 'alpha', name: 'タグA' });
    const t2 = tagsRepo.createTag(f.db, { workspace: 'alpha', name: 'tagB' });
    tagsRepo.updateTaskTags(f.db, task.display_id, { add: [t1.id, t2.id], remove: [] }, 'user');
    const ins = f.db.prepare('INSERT INTO deliverables (task_id, description, path, sort_order) VALUES (?, ?, ?, ?)');
    ins.run(task.id, null, 'docs/design/spec.md', 1);
    ins.run(task.id, null, 'backlog-dashboard\\db\\csv-export.js', 2);
    ins.run(task.id, '口頭説明のみ', null, 3);

    const [row] = parseCsv(buildTaskCsv(f.db).csv);
    assert.equal(row.tags, 'タグA;tagB');
    assert.equal(row.deliverables, 'spec.md;csv-export.js;口頭説明のみ');
    assert.equal(row.its_source, 'github;redmine');
    assert.equal(row.its_issue, '12;42');
    assert.equal(row.its_url, 'https://github.com/o/r/issues/12;http://h/redmine/issues/42');
    assert.equal(row.start_date, '2026-10-01');
    assert.equal(row.due_date, '2026-10-02');
    assert.equal(row.category, 'cat');
    assert.equal(row.assignee, 'me');
  } finally { cleanup(f); }
});

test('keeps newlines/commas/quotes in a cell and neutralizes formula-like cells', () => {
  const f = createTestDb();
  try {
    tasksRepo.create(f.db, { workspace: 'alpha', title: '=SUM(A1)', status: 'todo', description: 'line1\nline2, "quoted"' });
    tasksRepo.create(f.db, { workspace: 'alpha', title: '@cmd', status: 'todo', assignee: '+81' });
    const rows = parseCsv(buildTaskCsv(f.db).csv);
    assert.equal(rows[0].title, "'=SUM(A1)");
    assert.equal(rows[0].description, 'line1\nline2, "quoted"');
    assert.equal(rows[1].title, "'@cmd");
    assert.equal(rows[1].assignee, "'+81");
  } finally { cleanup(f); }
});

test('truncates descriptions over the limit and flags them', () => {
  const f = createTestDb();
  try {
    tasksRepo.create(f.db, { workspace: 'alpha', title: 'long', status: 'todo', description: 'あ'.repeat(DESCRIPTION_LIMIT + 500) });
    tasksRepo.create(f.db, { workspace: 'alpha', title: 'short', status: 'todo', description: 'ok' });
    const result = buildTaskCsv(f.db);
    const rows = parseCsv(result.csv);
    assert.equal(result.truncatedCount, 1);
    assert.equal(rows[0].description_truncated, '1');
    assert.ok(rows[0].description.length <= DESCRIPTION_LIMIT);
    assert.ok(rows[0].description.endsWith(TRUNCATION_MARKER));
    assert.equal(rows[1].description_truncated, '');
    assert.equal(rows[1].description, 'ok');
  } finally { cleanup(f); }
});

test('converts completed_at to a JST offset timestamp', () => {
  const f = createTestDb();
  try {
    tasksRepo.create(f.db, { workspace: 'alpha', title: 'old', status: 'done', completedAt: '2026-09-01T10:30:00+09:00' });
    const [row] = parseCsv(buildTaskCsv(f.db).csv);
    assert.equal(row.completed_at, '2026-09-01T10:30:00+09:00');
  } finally { cleanup(f); }
});
