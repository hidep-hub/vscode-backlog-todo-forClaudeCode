'use strict';

// BT-432: 追加ダイアログ・編集画面の親タスク欄と、期日クイックボタンの1段化(静的チェック)を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');

test('追加ダイアログと編集画面の両方に親タスク欄(共通部品)がある', () => {
  assert.match(app, /renderParentFieldHtml\('add-task'\)/);
  assert.match(app, /renderParentFieldHtml\('edit-task'\)/);
  assert.match(app, /setupParentField\(addFormEl\.querySelector\('#add-task-parent-field'\)/);
  assert.match(app, /setupParentField\(body\.querySelector\('#edit-task-parent-field'\)/);
});

test('親候補は同一ワークスペースのトップレベル未完了タスクだけ(子・完了・自分自身は除外)', () => {
  const m = app.match(/function collectParentCandidates\(project, excludeId\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'collectParentCandidates が見つからない');
  assert.match(m[0], /col\.compact \|\| col\.id === 'done'/);
  assert.match(m[0], /item\.parentId\) continue/);
  assert.match(m[0], /item\.project !== project \|\| item\.id === excludeId/);
});

test('追加ダイアログの送信は親タスク欄の値をparentIdに使い、親があればワークスペースを固定する', () => {
  assert.match(app, /const parentId = form\._parentField\.getValue\(\);/);
  assert.match(app, /projectSelect\.disabled = !!parentId;/);
  assert.match(app, /openAddTaskForm[\s\S]*form\._parentField\.setValue\(parentId \|\| ''\);\s*syncAddFormParent\(\);/);
});

test('編集画面は親の変更をdetach/attachで反映し、子を持つタスクは無効にする', () => {
  assert.match(app, /fetch\('\/api\/detach-from-parent'/);
  assert.match(app, /taskIds: \[item\.id\], parentId: newParentId/);
  assert.match(app, /parentField\.setDisabled\(true, '子タスクを持つタスクは親を設定できないよ'\)/);
});

test('選んだ親のタイトルは欄の下には出さず、フォーム先頭のパンくずに統一する (BM-110)', () => {
  assert.match(css, /\.parent-field-title\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.parent-crumb-slot\s*\{[^}]*max-height:\s*0/);
  assert.match(css, /\.parent-crumb-slot\.is-visible\s*\{[^}]*opacity:\s*1/);
});

test('期日クイックボタンのクリアは「C」1文字で、余白を詰めている', () => {
  assert.match(app, /due-quick-clear" data-date="" title="クリア" aria-label="クリア">C<\/button>/);
  assert.match(css, /\.due-quick-btn \{\s*padding: 3px 5px;/);
});

test('親候補のEPICにはEPICアイコンが付き、単発は同幅の空きで揃える', () => {
  assert.match(app, /it\.childrenTotal > 0\s*\? '<span class="parent-field-item-icon material-icon icon-stacks" title="EPIC"><\/span>'/);
  assert.match(css, /\.parent-field-item-icon\s*\{[^}]*width: 1em/);
});
