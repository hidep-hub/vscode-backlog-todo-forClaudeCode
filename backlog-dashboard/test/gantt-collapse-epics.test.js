'use strict';

// BT-453: ガントの「EPICだけ折りたたむ」。epicKeysがEPICのidだけを持ち、単発・カテゴリのキーを含まないことと、ボタンの配線を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ganttSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'gantt.js'), 'utf8');

function loadGantt(group) {
  const sandbox = { console, localStorage: { getItem: (k) => (k === 'ganttGroupByCategory' && group ? '1' : null), setItem() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ganttSrc, sandbox);
  return sandbox.ganttView;
}

const task = (id, over = {}) => ({ id, title: id, project: 'p', statusCode: 'todo', startDate: null, dueDate: null, category: '-', ...over });
const groups = () => [
  { epic: task('E1', { category: 'A' }), children: [task('C1')] },
  { epic: task('E2'), children: [task('C2')] },
  { epic: null, children: [task('S1', { category: 'A' }), task('S2')] },
];

for (const group of [false, true]) {
  test(`epicKeysはEPICのidだけで、単発・カテゴリのキーを含まない (カテゴリ階層${group ? 'あり' : 'なし'})`, () => {
    const { keys, epicKeys } = loadGantt(group).collectRows({
      groups: groups(), today: '2026-10-20', groupByWorkspace: false, categoryOf: (i) => i.category,
    });
    assert.deepEqual([...epicKeys].sort(), ['E1', 'E2']);
    assert.ok(keys.some((k) => k.startsWith('single:')), 'keys側には単発のキーがある');
  });
}

test('ツールバーに「EPICだけ折りたたむ」ボタンがあり、epicKeysだけを折りたたむ', () => {
  assert.match(ganttSrc, /data-act="collapse-epics"/);
  assert.match(ganttSrc, /act === 'collapse-epics'\) \{ current\.epicKeys\.forEach/);
});
