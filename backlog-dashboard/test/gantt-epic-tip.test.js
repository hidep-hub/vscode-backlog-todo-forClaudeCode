'use strict';

// BM-129: ガントのEPICラベル(タイトルを含む左の見出しセル)にマウスを乗せた時のTIP。
// collectRowsがEPICごとに「子の全件(完了済みも含む)・完了数」を返すことと、onMouseOver/CSSの配線を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const ganttSrc = fs.readFileSync(path.join(publicDir, 'gantt.js'), 'utf8');
const ganttCss = fs.readFileSync(path.join(publicDir, 'gantt.css'), 'utf8');

function loadGantt() {
  const sandbox = { console, localStorage: { getItem: () => null, setItem() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ganttSrc, sandbox);
  return sandbox.ganttView;
}

const task = (id, over = {}) => ({ id, title: id, project: 'p', statusCode: 'todo', startDate: null, dueDate: null, category: '-', ...over });
const collect = (groups) => loadGantt().collectRows({
  groups, today: '2026-10-20', groupByWorkspace: false, categoryOf: (i) => i.category,
});

test('epicsはEPICごとに子の全件をID順で持ち、完了済みの子も含む(完了を表示しない既定でも)', () => {
  const groups = [{
    epic: task('E1'),
    // 並びをわざと崩す。C10はC2より後ろ(番号は数値順)
    children: [task('C10'), task('C2', { statusCode: 'done' }), task('C1')],
  }];
  const { rows, epics } = collect(groups);
  const entry = epics.get('E1');
  // vmの別レルムの配列はdeepEqualに通らないため、ホスト側の配列へ詰め替えて比べる
  assert.deepEqual(Array.from(entry.children, (c) => c.id), ['C1', 'C2', 'C10']);
  assert.equal(entry.done, 1);
  assert.equal(entry.epic.id, 'E1');
  // 行としては完了の子(日付も完了日も無い)は出ないが、TIPの一覧には載る
  assert.deepEqual(Array.from(rows).filter((r) => r.type === 'task').map((r) => r.item.id), ['C1', 'C10']);
});

test('epicsにはEPICだけが入り、単発タスクは入らない。lookupにEPIC自身は増やさない', () => {
  const groups = [
    { epic: task('E1'), children: [task('C1')] },
    { epic: null, children: [task('S1')] },
  ];
  const { epics, lookup } = collect(groups);
  assert.deepEqual([...epics.keys()], ['E1']);
  assert.deepEqual([...lookup.keys()].sort(), ['C1', 'S1']);
});

test('epicsの子配列は元のgroupsを並べ替えない(複製して並べる)', () => {
  const children = [task('C2'), task('C1')];
  collect([{ epic: task('E1'), children }]);
  assert.deepEqual(children.map((c) => c.id), ['C2', 'C1']);
});

test('onMouseOverはEPICラベルを拾い、追加ボタンと幅変更のつかみでは出さない', () => {
  assert.match(ganttSrc, /e\.target\.closest\('\.gantt-label-epic\[data-task-id\]'\)/);
  assert.match(ganttSrc, /e\.target\.closest\('\.gantt-add-child, \.gantt-resizer'\)\) return;/);
  // EPIC帯は従来どおり標準のtitleだけ(二重に出さない)
  assert.match(ganttSrc, /if \(e\.target\.closest\('\.gantt-bar-epic'\)\) return;/);
});

test('EPICの説明文はitemに書き込まず、描画ごとのキャッシュ(epicDesc)に持つ', () => {
  // board用のitemへdescriptionを足すと、app.jsが「完全なitem」と見なして詳細・編集で本文を取り違える
  assert.match(ganttSrc, /applyDetail: \(full\) => \{ current\.epicDesc\.set\(epicId, full\.description \|\| ''\); \}/);
  assert.match(ganttSrc, /epicDesc: new Map\(\)/);
  assert.doesNotMatch(ganttSrc, /Object\.assign\(entry\.epic/);
});

test('EPICのTIPは開始日・期日・期限超過の警告を出さず、状態・進捗・説明・子タスクを出す', () => {
  const body = ganttSrc.slice(ganttSrc.indexOf('function epicTipHtml'), ganttSrc.indexOf('function showTipLater'));
  assert.match(body, /状態: /);
  assert.match(body, /進捗: /);
  assert.match(body, /gantt-tip-desc/);
  assert.match(body, /gantt-tip-children/);
  assert.doesNotMatch(body, /開始: |期日: |gantt-tip-warn/);
});

test('EPICラベルのクリック(開閉)で出ているTIPを消し、カーソルがそのラベルを離れるまで出し直さない', () => {
  assert.match(ganttSrc, /if \(act === 'toggle-epic'\) \{\s*hideTip\(\);[^\n]*\n\s*const id = actEl\.dataset\.epicId;\s*epicTipSuppressedId = id;/);
  assert.match(ganttSrc, /if \(epicId === epicTipSuppressedId\) return;/);
  // 抑制の解除は、帯のearly returnより前で行う(帯へ移っても解除される)
  assert.ok(ganttSrc.indexOf('epicTipSuppressedId = null; // 開閉したラベルを離れた') < ganttSrc.indexOf("if (e.target.closest('.gantt-bar-epic')) return;"));
});

test('TIPの子タスク一覧のスタイルがある', () => {
  for (const sel of ['.gantt-tip-children-head', '.gantt-tip-children', '.gantt-tip-child', '.gantt-tip-child-id', '.gantt-tip-child-title']) {
    assert.ok(ganttCss.includes(`${sel} {`), `${sel} が定義されている`);
  }
  assert.match(ganttCss, /\.gantt-tip-children \{[^}]*overflow-y: auto/);
});
