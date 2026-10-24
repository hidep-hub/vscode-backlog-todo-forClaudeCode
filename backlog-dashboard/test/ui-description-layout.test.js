'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');

test('BT-466: 説明の開閉はEPICだけに表示し、子件数から毎回EPICを判定する', () => {
  assert.match(app, /const isEpic = \(item\.childrenTotal \|\| 0\) > 0 \|\| \(item\.children && item\.children\.length > 0\);/);
  assert.match(app, /detail-description-full[\s\S]*?description-text description-md[\s\S]*?renderDescriptionMarkdown\(description\)[\s\S]*?detail-description-epic/);
  assert.match(app, /detail-description-epic[\s\S]*?description-toggle-btn[\s\S]*?description-collapsible/);
});

test('BT-466: EPIC説明のプレビュー枠は固定高で、文字倍率に依存して高さを変えない', () => {
  assert.match(css, /\.detail-description-epic \.description-collapsible \.description-text\s*\{[\s\S]*?max-height: 66px;[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.detail-description-epic \.description-collapsible\.expanded \.description-text\s*\{[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/);
  assert.doesNotMatch(css, /\.detail-description-epic \.description-collapsible \.description-text\s*\{[^}]*--desc-zoom/);
});
