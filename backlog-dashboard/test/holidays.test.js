'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
require('../public/holidays.js');

const { getHolidayName } = globalThis.jpHolidays;

function holidaysOf(year) {
  const result = {};
  for (let m = 1; m <= 12; m++) {
    const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) {
      const key = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const name = getHolidayName(key);
      if (name) result[key] = name;
    }
  }
  return result;
}

test('2026年の祝日が内閣府の公表と一致する（国民の休日・振替休日を含む）', () => {
  assert.deepEqual(holidaysOf(2026), {
    '2026-01-01': '元日',
    '2026-01-12': '成人の日',
    '2026-02-11': '建国記念の日',
    '2026-02-23': '天皇誕生日',
    '2026-03-20': '春分の日',
    '2026-04-29': '昭和の日',
    '2026-05-03': '憲法記念日',
    '2026-05-04': 'みどりの日',
    '2026-05-05': 'こどもの日',
    '2026-05-06': '振替休日',
    '2026-07-20': '海の日',
    '2026-08-11': '山の日',
    '2026-09-21': '敬老の日',
    '2026-09-22': '国民の休日',
    '2026-09-23': '秋分の日',
    '2026-10-12': 'スポーツの日',
    '2026-11-03': '文化の日',
    '2026-11-23': '勤労感謝の日',
  });
});

test('日曜と重なった祝日は翌平日が振替休日になる', () => {
  assert.equal(getHolidayName('2025-02-24'), '振替休日');
  assert.equal(getHolidayName('2025-05-06'), '振替休日');
  assert.equal(getHolidayName('2025-11-24'), '振替休日');
  assert.equal(getHolidayName('2024-09-23'), '振替休日');
});

test('2019年は改元の特例（5連休の前後・即位礼正殿の儀）を持ち、2/23と12/23は祝日でない', () => {
  assert.equal(getHolidayName('2019-04-30'), '国民の休日');
  assert.equal(getHolidayName('2019-05-01'), '休日（天皇の即位の日）');
  assert.equal(getHolidayName('2019-05-02'), '国民の休日');
  assert.equal(getHolidayName('2019-05-06'), '振替休日');
  assert.equal(getHolidayName('2019-10-22'), '休日（即位礼正殿の儀）');
  assert.equal(getHolidayName('2019-02-23'), null);
  assert.equal(getHolidayName('2019-12-23'), null);
});

test('2020・2021年は東京五輪の特例日程になる', () => {
  assert.equal(getHolidayName('2020-07-23'), '海の日');
  assert.equal(getHolidayName('2020-07-24'), 'スポーツの日');
  assert.equal(getHolidayName('2020-08-10'), '山の日');
  assert.equal(getHolidayName('2020-07-20'), null);
  assert.equal(getHolidayName('2021-07-22'), '海の日');
  assert.equal(getHolidayName('2021-07-23'), 'スポーツの日');
  assert.equal(getHolidayName('2021-08-08'), '山の日');
  assert.equal(getHolidayName('2021-08-09'), '振替休日');
});

test('過去の制度（2000年・2018年）に追従する', () => {
  assert.equal(getHolidayName('2000-01-10'), '成人の日');
  assert.equal(getHolidayName('2000-10-09'), '体育の日');
  assert.equal(getHolidayName('2000-04-29'), 'みどりの日');
  assert.equal(getHolidayName('2018-12-23'), '天皇誕生日');
  assert.equal(getHolidayName('2018-12-24'), '振替休日');
});

test('春分・秋分の日は将来の年も計算できる', () => {
  assert.equal(getHolidayName('2027-03-21'), '春分の日');
  assert.equal(getHolidayName('2030-03-20'), '春分の日');
  assert.equal(getHolidayName('2050-09-23'), '秋分の日');
});

test('平日・対象外の年はnull', () => {
  assert.equal(getHolidayName('2026-10-04'), null);
  assert.equal(getHolidayName('2100-01-01'), null);
  assert.equal(getHolidayName('1979-01-01'), null);
});
