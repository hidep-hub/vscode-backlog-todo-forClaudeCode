'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDailyCounts, buildDailyCountsByProject, selectCounts, buildMonthBoundaries, buildMonthSegments, buildHeatmapGrid, levelFor } = require('../public/header-heatmap.js');

test('buildDailyCounts aggregates events by local date and ignores invalid input', () => {
  const a = new Date(2026, 9, 12, 9, 0, 0).toISOString();
  const b = new Date(2026, 9, 12, 23, 59, 0).toISOString();
  const c = new Date(2026, 9, 11, 0, 0, 1).toISOString();
  const counts = buildDailyCounts([{ occurredAt: a }, { occurredAt: b }, { occurredAt: c }, { occurredAt: 'bad' }, null]);
  assert.deepEqual(counts, { '2026-10-12': 2, '2026-10-11': 1 });
  assert.deepEqual(buildDailyCounts(null), {});
});

test('levelFor maps count to 0..4 relative to the max', () => {
  assert.equal(levelFor(0, 10), 0);
  assert.equal(levelFor(1, 10), 1);
  assert.equal(levelFor(10, 10), 4);
  assert.equal(levelFor(5, 10), 2);
});

test('buildHeatmapGrid puts today in the last column and omits future cells', () => {
  const today = new Date(2026, 9, 14); // 水曜(2026-10-14)
  const grid = buildHeatmapGrid({ '2026-10-14': 4, '2026-10-13': 1 }, 3, today);
  assert.equal(grid.cols, 3);
  const last = grid.cells.filter(c => c.col === 2);
  assert.deepEqual(last.map(c => c.date), ['2026-10-12', '2026-10-13', '2026-10-14']); // 月火水のみ
  assert.equal(last.find(c => c.date === '2026-10-14').level, 4);
  assert.equal(last.find(c => c.date === '2026-10-13').level, 1);
  assert.equal(grid.cells.length, 7 * 2 + 3);
  assert.equal(grid.cells[0].date, '2026-09-28');
});

test('buildDailyCountsByProject splits by project and selectCounts sums all when project is empty', () => {
  const d1 = new Date(2026, 9, 12, 9, 0, 0).toISOString();
  const d2 = new Date(2026, 9, 11, 9, 0, 0).toISOString();
  const byProject = buildDailyCountsByProject([
    { occurredAt: d1, project: 'A' }, { occurredAt: d1, project: 'B' }, { occurredAt: d2, project: 'A' }, { occurredAt: 'bad', project: 'A' },
  ]);
  assert.deepEqual(byProject, { A: { '2026-10-12': 1, '2026-10-11': 1 }, B: { '2026-10-12': 1 } });
  assert.deepEqual(selectCounts(byProject, 'A'), { '2026-10-12': 1, '2026-10-11': 1 });
  assert.deepEqual(selectCounts(byProject, ''), { '2026-10-12': 2, '2026-10-11': 1 });
  assert.deepEqual(selectCounts(byProject, 'none'), {});
  assert.deepEqual(selectCounts(null, ''), {});
});

test('buildMonthBoundaries returns the columns where the Monday month changes', () => {
  const grid = buildHeatmapGrid({}, 12, new Date(2026, 9, 14)); // 12週: 7/27週〜10/12週
  // 月曜: 7/27, 8/3,10,17,24,31, 9/7,14,21,28, 10/5,12 → 8/3(col1), 9/7(col6), 10/5(col10)
  assert.deepEqual(buildMonthBoundaries(grid.cells), [1, 6, 10]);
  assert.deepEqual(buildMonthBoundaries([]), []);
});

test('buildMonthSegments groups consecutive weeks by the Monday month', () => {
  const grid = buildHeatmapGrid({}, 12, new Date(2026, 9, 14));
  assert.deepEqual(buildMonthSegments(grid.cells), [
    { month: 7, startCol: 0, endCol: 0 },
    { month: 8, startCol: 1, endCol: 5 },
    { month: 9, startCol: 6, endCol: 9 },
    { month: 10, startCol: 10, endCol: 11 },
  ]);
});
