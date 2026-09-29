'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
require('../public/column-sort.js');

const { sortItems } = globalThis.columnSort;

test('sorts EPICs by the newest update across themselves and children', () => {
  const items = [
    { id: 'A', updatedAt: '2026-09-01T00:00:00.000Z', children: [{ updatedAt: '2026-09-10T00:00:00.000Z' }] },
    { id: 'B', updatedAt: '2026-09-09T00:00:00.000Z' },
  ];
  assert.deepEqual(sortItems(items, 'updated-desc').map(item => item.id), ['A', 'B']);
});

test('sorts EPICs by the earliest due date across themselves and children, with no due date last', () => {
  const items = [
    { id: 'A', children: [{ dueDate: '2026-10-20' }] },
    { id: 'B', dueDate: '2026-10-10' },
    { id: 'C', children: [] },
  ];
  assert.deepEqual(sortItems(items, 'due-asc').map(item => item.id), ['B', 'A', 'C']);
});

test('preserves manual order for equal sort values', () => {
  const items = [{ id: 'A', dueDate: '2026-10-10' }, { id: 'B', dueDate: '2026-10-10' }];
  assert.deepEqual(sortItems(items, 'due-asc').map(item => item.id), ['A', 'B']);
});
