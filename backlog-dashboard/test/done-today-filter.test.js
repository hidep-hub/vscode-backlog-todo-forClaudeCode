'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function loadGetTodayJST() {
  const match = appSource.match(/function getTodayJST\(now = new Date\(\)\) \{[\s\S]*?\r?\n\}/);
  assert.ok(match, 'getTodayJSTがapp.jsに存在するはず');
  return new Function(`${match[0]}\nreturn getTodayJST;`)();
}

test('DONE列の今日判定はJSTの日付境界を使う', () => {
  const getTodayJST = loadGetTodayJST();

  // UTCでは前日の15:30だが、JSTでは翌日の00:30。
  assert.equal(getTodayJST(new Date('2026-11-08T15:30:00.000Z')), '2026-11-09');
  assert.equal(getTodayJST(new Date('2026-11-09T14:59:59.999Z')), '2026-11-09');
  assert.equal(getTodayJST(new Date('2026-11-09T15:00:00.000Z')), '2026-11-10');
});
