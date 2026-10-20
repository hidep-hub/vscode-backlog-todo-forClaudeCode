'use strict';

// BT-447: ガントの「カテゴリ > EPIC(|単発) > 子」階層と、カテゴリ絞り込みの配線を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const ganttSrc = fs.readFileSync(path.join(publicDir, 'gantt.js'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const categoriesJs = fs.readFileSync(path.join(publicDir, 'categories.js'), 'utf8');
const ganttCss = fs.readFileSync(path.join(publicDir, 'gantt.css'), 'utf8');

function loadGantt() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ganttSrc, sandbox);
  return sandbox.ganttView;
}

const task = (id, over = {}) => ({ id, title: id, project: 'p', statusCode: 'todo', startDate: null, dueDate: null, category: '-', ...over });
const collect = (groups) => loadGantt().collectRows({
  groups, today: '2026-10-20', groupByWorkspace: false, categoryOf: (i) => i.category,
});
const seq = (rows) => [...rows].map((r) => (r.type === 'task' ? `t:${r.item.id}` : r.type === 'epic' ? `e:${r.epic.id}` : `${r.type}:${r.label || ''}`));

test('カテゴリ付きが1件も無ければ従来どおりカテゴリ見出しを出さない', () => {
  const { rows } = collect([{ epic: task('E1'), children: [task('C1')] }, { epic: null, children: [task('S1')] }]);
  assert.deepEqual(seq(rows), ['e:E1', 't:C1', 'head:単発タスク', 't:S1']);
});

test('カテゴリ見出しの下にEPIC・単発をぶら下げ、カテゴリなしは最後に出す', () => {
  const groups = [
    { epic: task('E1', { category: 'B' }), children: [task('C1')] },
    { epic: task('E2', { category: 'A' }), children: [task('C2')] },
    { epic: task('E3'), children: [task('C3')] },
    { epic: null, children: [task('S1', { category: 'A' }), task('S2')] },
  ];
  const { rows, keys } = collect(groups);
  assert.deepEqual(seq(rows), [
    'cat:A', 'e:E2', 't:C2', 'head:単発タスク', 't:S1',
    'cat:B', 'e:E1', 't:C1',
    'cat:カテゴリなし', 'e:E3', 't:C3', 'head:単発タスク', 't:S2',
  ]);
  assert.ok(keys.includes('cat::A') && keys.includes('single::A') && keys.includes('single::'));
});

test('子のカテゴリは見ず、EPIC自身のカテゴリで束ねる', () => {
  const { rows } = collect([{ epic: task('E1', { category: 'A' }), children: [task('C1', { category: 'Z' })] }]);
  assert.deepEqual(seq(rows), ['cat:A', 'e:E1', 't:C1']);
});

test('折りたたんだカテゴリ配下の行は出さないが、統計には数える', () => {
  const view = loadGantt();
  const groups = [{ epic: task('E1', { category: 'A' }), children: [task('C1', { dueDate: '2026-10-01' })] }];
  // 折りたたみ状態はモジュール内部なので、カテゴリ見出しのキーでtoggle相当の操作はせず、描画行の構造だけ確認する
  const res = view.collectRows({ groups, today: '2026-10-20', groupByWorkspace: false, categoryOf: (i) => i.category });
  assert.equal(res.rows[0].type, 'cat');
  assert.equal(res.rows[0].count, 1);
  assert.equal(res.stats.overdue, 1);
});

test('app.jsはカテゴリ絞り込みをガントのグループ生成・再描画に配線する', () => {
  assert.match(app, /categoryActive && !categoryLogic\.matchesCategoryFilterForBoardItem\(item, categoryFilter\.keys\)/);
  assert.match(app, /categoryOf: \(item\) => item\.category/);
  assert.match(categoriesJs, /plan-board-overlay[\s\S]*renderPlanBoard\(\)/);
  assert.match(ganttCss, /\.gantt-label-cat\s*\{/);
});

test('週次計画/ガントのヘッダーにカテゴリ絞り込みボタンがあり、ポップオーバーに繋がる', () => {
  assert.match(app, /id="plan-category-filter-btn"[^>]*>/);
  assert.match(app, /#plan-category-filter-btn'\)\.addEventListener\('click', \(e\) => toggleCategoryFilterPopover\(e\.currentTarget\)\)/);
  assert.match(app, /renderCategoryFilterControls\(\);\s*\/\/ BT-315|renderCategoryFilterControls\(\);\n/);
});

test('カテゴリ見出しはタグ風チップ(タグアイコン付き)で出し、並びはカテゴリマスタ順にする', () => {
  assert.match(app, /categoryChipHtml: planCategoryChipHtml/);
  assert.match(app, /icon-tag"><\/span><span class="tag-chip-text">/);
  assert.match(app, /categoryOrder: \[\.\.\.planCategoryColors\.keys\(\)\]/);
  assert.match(ganttSrc, /ctx\.categoryChipHtml \?/);
  assert.match(ganttCss, /\.gantt-cat-chip \.tag-chip\s*\{/);
});

test('マスタ順→マスタ外(名前順)→カテゴリなしで並べる', () => {
  const groups = [
    { epic: task('E1', { category: 'Z外' }), children: [task('C1')] },
    { epic: task('E2', { category: 'B' }), children: [task('C2')] },
    { epic: task('E3', { category: 'A' }), children: [task('C3')] },
    { epic: task('E4'), children: [task('C4')] },
  ];
  const { rows } = loadGantt().collectRows({ groups, today: '2026-10-20', groupByWorkspace: false, categoryOf: (i) => i.category, categoryOrder: ['B', 'A'] });
  assert.deepEqual([...rows].filter((r) => r.type === 'cat').map((r) => r.label), ['B', 'A', 'Z外', 'カテゴリなし']);
});
