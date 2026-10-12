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
  assert.match(app, /onAddTask: \(\) => openAddTaskForm\('todo', currentFilter \|\| '', ''\)/);
});
