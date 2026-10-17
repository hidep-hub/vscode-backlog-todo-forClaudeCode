'use strict';

// BT-425: かんばん各列(完了以外)の末尾に「＋」を置く配線(静的チェック)を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');

test('メインボード: 完了以外の列の末尾にだけ追加ボタンを作る', () => {
  assert.match(app, /if \(!isCompact\) \{\s*const addFooter = document\.createElement\('div'\);\s*addFooter\.className = 'card card-compact card-summary card-add-footer';/);
});

test('メインボード: ヘッダーの+とフッターは同じ判定で、レーン表示中はlaneKeyに追加する', () => {
  assert.match(app, /data-lane="\$\{escapeHtml\(laneKey \|\| ''\)\}"/);
  assert.match(app, /addFooter\.dataset\.lane = laneKey \|\| '';/);
  assert.match(app, /querySelectorAll\('\.add-task-btn, \.card-add-footer'\)/);
  assert.match(app, /openAddTaskForm\(btn\.dataset\.colStatus, btn\.dataset\.lane \|\| currentFilter \|\| '', ''\)/);
});

test('ミニボード: 完了以外の列の末尾に親Epic固定の追加ボタンを作る', () => {
  assert.match(app, /if \(!isDoneCol\) \{\s*const addFooter = document\.createElement\('div'\);\s*addFooter\.className = '[^']*card-add-footer-mini';/);
  assert.match(app, /addFooter\.dataset\.parentId = epic\.id;/);
  assert.match(app, /querySelectorAll\('\.add-task-btn-mini, \.card-add-footer-mini'\)/);
});

test('追加ボタンのスタイルが定義されている', () => {
  assert.match(css, /\.card-add-footer \.summary-label\s*\{/);
});

test('ミニボードの追加ボタンは、子カードの左線色(.mini-col-body .card-child)を打ち消す', () => {
  assert.match(css, /\.mini-col-body \.card-child\.card-add-footer-mini\s*\{[^}]*border-left:\s*1px dashed/);
});
