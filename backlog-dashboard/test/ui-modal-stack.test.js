'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');

test('前面モーダルは子タスク詳細より上のレイヤーを使う', () => {
  assert.match(css, /\.modal-overlay\.modal-front\s*\{\s*z-index:\s*1200;/);
  for (const id of [
    'githubImportEl', 'parentPickerEl', 'movePickerEl', 'workspaceFormEl', 'addFormEl',
  ]) {
    assert.match(app, new RegExp(`${id}\\.className = 'modal-overlay modal-front'`));
  }
  assert.equal((app.match(/el\.className = 'modal-overlay modal-front'/g) || []).length >= 4, true);
});

test('Escape は最前面のモーダルで消費して一段だけ戻る', () => {
  assert.match(app, /function isTopmostDialog\(el\)[\s\S]*?getComputedStyle\(candidate\)\.zIndex[\s\S]*?return top === el;/);
  assert.match(app, /function closeOnEscape\(el, visibleClass, close\)[\s\S]*?stopImmediatePropagation\(\)[\s\S]*?\}, true\);/);
  for (const closer of [
    'closeSettings', 'closeGithubImportModal', 'closeSearchModal', 'closePlanBoard',
    'closeModal', 'closeChildModal', 'closeDeleteConfirm', 'closeGithubLinkModal',
    'closeGithubCreateConfirm', 'closeParentPicker', 'closeMovePicker',
    'closeWorkspaceCreateForm', 'closeAddForm',
  ]) {
    assert.match(app, new RegExp(`closeOnEscape\\([^\\n]+, [^\\n]+, ${closer}\\)`));
  }
});
