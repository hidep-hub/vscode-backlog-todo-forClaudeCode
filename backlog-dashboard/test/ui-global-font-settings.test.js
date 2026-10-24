'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

test('BT-464: 全体設定に文字サイズと詳細画面表示倍率の選択欄がある', () => {
  assert.match(html, /<select id="settings-card-size">[\s\S]*?<option value="s">小 \(S\)<\/option>[\s\S]*?<option value="l">大 \(L\)<\/option>/);
  assert.match(html, /<select id="settings-description-zoom">[\s\S]*?<option value="0\.6">60%<\/option>[\s\S]*?<option value="1">100%<\/option>[\s\S]*?<option value="1\.6">160%<\/option>/);
});

test('BT-464: 明示保存が必要な列順だけを枠で区切り、ボタンの対象を明記する', () => {
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(html, /<div class="settings-group settings-column-order-group">[\s\S]*?<button id="settings-column-order-save" disabled>列順を保存<\/button>/);
  assert.match(css, /\.settings-column-order-group\s*\{[\s\S]*?border:\s*1px solid var\(--border\);/);
  assert.match(app, /column-order-preview-header[\s\S]*?column-order-actions/);
  assert.match(app, /data-move="top"[\s\S]*?>\|&lt;<\/button>/);
  assert.match(app, /data-move="end"[\s\S]*?>&gt;\|<\/button>/);
  assert.match(app, /btn\.dataset\.move === 'end'[\s\S]*?columnOrderDraft\.push\(columnOrderDraft\.splice\(idx, 1\)\[0\]\);/);
  assert.match(css, /\.column-order-list\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.column-order-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.column-order-btn\s*\{[\s\S]*?width:\s*100%;[\s\S]*?font-size:\s*0\.5rem;/);
  assert.match(css, /\.column-order-btn\s*\{[\s\S]*?white-space:\s*nowrap;/);
});

test('BT-464: ヘッダと全体設定の文字サイズ、詳細操作と全体設定の倍率を同期する', () => {
  assert.match(app, /if \(globalCardSize\) globalCardSize\.value = value;/);
  assert.match(app, /settingsCardSizeEl\.addEventListener\('change', \(\) => \{[\s\S]*?applyCardSize\(settings\.cardSize\);/);
  assert.match(app, /if \(globalDescriptionZoom\) globalDescriptionZoom\.value = String\(descPreviewZoom\);/);
  assert.match(app, /settingsDescriptionZoomEl\.addEventListener\('change', \(\) => \{[\s\S]*?setDescriptionZoom\(Number\(settingsDescriptionZoomEl\.value\)\);/);
});
