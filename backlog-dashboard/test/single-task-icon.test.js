'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const publicDir = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const style = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');

test('単発タスクは1枚のMaterial note、子タスクはレイヤーアイコンを使う', () => {
  assert.ok(app.includes('<span class="material-icon icon-note"></span>'));
  assert.ok(app.includes('const CHILD_TITLE_CHIP_HTML'));
  assert.ok(app.includes('class="child-title-chip"'));
  assert.match(style, /\.material-icon\.icon-note\s*\{[^}]*icons\/note\.svg/);
  assert.match(style, /\.child-title-chip \.child-chip-lines\s*\{\s*opacity: 0\.5/);
  assert.ok(fs.existsSync(path.join(publicDir, 'icons', 'note.svg')));
});
