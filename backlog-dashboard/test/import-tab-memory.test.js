'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// BT-449: 外部チケット取り込みモーダルのタブ選択をワークスペース単位でlocalStorageに覚える。
// 実ブラウザでの確認はPlaywrightで別途実施(タスク説明欄に記録)。

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// app.jsから対象関数だけ切り出して、localStorage差し替えで実行する
function loadHelpers(storage) {
  const start = app.indexOf("const IMPORT_SOURCE_TABS");
  const end = app.indexOf('// 現在表示中のタブが対象にしているワークスペースのprefix');
  assert.ok(start > 0 && end > start, 'ヘルパー群が見つかるはず');
  const body = app.slice(start, end);
  return new Function('localStorage', `${body}; return { saveImportSourceTab, getSavedImportSourceTab };`)(storage);
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

test('保存したタブをprefix単位で復元できる', () => {
  const h = loadHelpers(memoryStorage());
  h.saveImportSourceTab('BT', 'redmine');
  h.saveImportSourceTab('IN', 'gitlab');
  assert.equal(h.getSavedImportSourceTab('BT'), 'redmine');
  assert.equal(h.getSavedImportSourceTab('IN'), 'gitlab');
});

test('保存が無い・不正値・prefix空はGitHubにフォールバックする', () => {
  const h = loadHelpers(memoryStorage({ importSourceTabByPrefix: JSON.stringify({ BT: 'bogus' }) }));
  assert.equal(h.getSavedImportSourceTab('BT'), 'github');
  assert.equal(h.getSavedImportSourceTab('XX'), 'github');
  assert.equal(h.getSavedImportSourceTab(''), 'github');
  h.saveImportSourceTab('', 'redmine');
  h.saveImportSourceTab('BT', 'bogus');
  assert.equal(h.getSavedImportSourceTab('BT'), 'github');
});

test('localStorageが使えない/壊れていても例外を出さない', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const h = loadHelpers(broken);
  assert.doesNotThrow(() => h.saveImportSourceTab('BT', 'redmine'));
  assert.equal(h.getSavedImportSourceTab('BT'), 'github');
  const h2 = loadHelpers(memoryStorage({ importSourceTabByPrefix: '{broken' }));
  assert.equal(h2.getSavedImportSourceTab('BT'), 'github');
});

test('モーダルを開くときは保存済みタブで開き、タブクリック時に保存する', () => {
  assert.match(app, /switchImportSourceTab\(getSavedImportSourceTab\(el\.querySelector\('#github-import-project'\)\.value\)\);/);
  assert.match(app, /saveImportSourceTab\(getActiveImportTabPrefix\(\), btn\.dataset\.source\);/);
});
