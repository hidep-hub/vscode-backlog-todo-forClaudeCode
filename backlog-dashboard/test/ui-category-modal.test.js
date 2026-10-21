'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const categories = fs.readFileSync(path.join(publicDir, 'categories.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');

test('BT-452 カテゴリ管理の閉じるボタンはヘッダー右端に配置する', () => {
  assert.match(categories, /class="tag-modal-close" id="category-modal-close"/);
  assert.match(css, /\.category-modal-overlay \.tag-modal-header h3\s*\{\s*flex:\s*1;\s*\}/);
  assert.match(css, /\.category-modal-overlay \.tag-modal-close\s*\{\s*margin-left:\s*auto;\s*\}/);
});
