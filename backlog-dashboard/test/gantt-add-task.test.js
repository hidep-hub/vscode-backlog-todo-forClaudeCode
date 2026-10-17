'use strict';

// BT-376: ガントのヘッダ+ボタンから既存のタスク追加フォームを開く配線(静的チェック)を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const gantt = fs.readFileSync(path.join(publicDir, 'gantt.js'), 'utf8');
const ganttCss = fs.readFileSync(path.join(publicDir, 'gantt.css'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

test('ガントのヘッダ(タスク欄)に+ボタンがあり、onAddTask未指定なら出さない', () => {
  assert.match(gantt, /ctx\.onAddTask \? '<button[^']*data-act="add-task"/);
  assert.match(gantt, /act === 'add-task'/);
  assert.match(ganttCss, /\.gantt-add-btn\s*\{/);
});

test('app.jsはonAddTaskで既存フォームを日付なしで開く', () => {
  assert.match(app, /onAddTask: \(project\) => openAddTaskForm\('todo', project \|\| currentFilter \|\| '', ''\)/);
});

// BT-430: EPIC行の「子タスクを追加」ボタンの配線(静的チェック)
test('ガントのEPIC行に子タスク追加ボタンがあり、onAddChild未指定なら出さない', () => {
  assert.match(gantt, /ctx\.onAddChild\s*\? `<button[^`]*data-act="add-child"/);
  assert.match(gantt, /ctx\.onAddChild\(addChildEl\.dataset\.epicId, addChildEl\.dataset\.project\)/);
  assert.match(ganttCss, /\.gantt-add-child\s*\{/);
  assert.match(ganttCss, /@container \(max-width: \d+px\)\s*\{[^}]*\.gantt-add-child-text \{ display: none; \}/);
});

test('app.jsはonAddChildで親EPIC固定の子タスク追加フォームを開く', () => {
  assert.match(app, /onAddChild: \(epicId, project\) => openAddTaskForm\('todo', project \|\| currentFilter \|\| '', epicId\)/);
});

test('ガントの単発タスク見出しに単発タスク追加ボタンがあり、onAddTaskにworkspaceを渡す', () => {
  assert.match(gantt, /ctx\.onAddTask\s*\? `<button[^`]*data-act="add-single"/);
  assert.match(gantt, /ctx\.onAddTask\(addSingleEl\.dataset\.project\)/);
  assert.match(ganttCss, /\.gantt-label-epic, \.gantt-label-head \{ container-type: inline-size; \}/);
});
