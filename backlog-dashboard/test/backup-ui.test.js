'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const backupJs = fs.readFileSync(path.join(publicDir, 'backup.js'), 'utf8');

test('バックアップボタンは履歴ボタンの右にあり、backup.jsが読み込まれる (BT-373)', () => {
  const history = html.indexOf('id="activity-btn"');
  const backup = html.indexOf('id="backup-btn"');
  assert.ok(history > 0 && backup > history, '履歴ボタンより後ろに配置する');
  assert.ok(html.indexOf('id="backup-btn"') < html.indexOf('header-workspace-row'), '1段目に置く');
  assert.match(html, /<script src="backup\.js"><\/script>/);
  assert.ok(fs.existsSync(path.join(publicDir, 'icons', 'backup.svg')));
  assert.match(css, /\.material-icon\.icon-backup\s*\{[^}]*icons\/backup\.svg/);
});

test('進捗オーバーレイは他のモーダルより前面で、実行中のEscapeを無効にする', () => {
  const match = css.match(/\.backup-progress-overlay\s*\{[^}]*z-index:\s*(\d+)/);
  assert.ok(match, 'z-indexが定義されている');
  const others = [...css.matchAll(/z-index:\s*(\d+)/g)].map(m => Number(m[1])).filter(z => z !== Number(match[1]));
  assert.ok(Number(match[1]) > Math.max(...others), '全モーダルより大きい');
  assert.match(backupJs, /backup-progress-visible[\s\S]{0,200}preventDefault\(\)[\s\S]{0,80}stopPropagation\(\)/);
  assert.match(backupJs, /\/api\/backup-status/);
  assert.match(backupJs, /resumeBackupIfRunning\(\);\s*$/, 'ロード時に実行中バックアップへ復帰する');
});

test('バックアップモーダルは最前面判定(Escape制御)の対象に含まれる', () => {
  assert.match(app, /\.backup-modal-overlay\.modal-visible/);
});

test('ヘッダー1段目は2段目の幅に揃え、検索ボックスが伸縮する', () => {
  assert.match(css, /\.header-action-row:not\(\.header-workspace-row\)\s*\{\s*contain:\s*inline-size;/);
  assert.match(css, /\.header-action-row:not\(\.header-workspace-row\) \.header-search-input\s*\{[^}]*flex:\s*1 1 0/);
});
