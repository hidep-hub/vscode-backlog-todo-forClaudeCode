'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { formatTime, formatSummary, toTickerLines } = require('../public/header-ticker.js');

test('formatTime converts an occurredAt ISO string to local HH:MM:SS', () => {
  const d = new Date('2026-10-01T09:21:40.286Z');
  const pad = n => String(n).padStart(2, '0');
  const expected = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  assert.equal(formatTime('2026-10-01T09:21:40.286Z'), expected);
});

test('formatTime returns a placeholder for an invalid date', () => {
  assert.equal(formatTime('not-a-date'), '--:--:--');
});

test('formatSummary renders status_changed with old/new status labels', () => {
  assert.equal(
    formatSummary({ eventType: 'status_changed', oldValue: 'do', newValue: 'done' }),
    'Update (DO→DONE)',
  );
});

test('formatSummary renders assigned with the new assignee', () => {
  assert.equal(formatSummary({ eventType: 'assigned', newValue: 'ug40462' }), 'Assign → ug40462');
});

test('formatSummary falls back to the event label for unknown action codes', () => {
  assert.equal(formatSummary({ eventType: 'created' }), 'Create');
  assert.equal(formatSummary({ eventType: 'running_started' }), 'Run');
});

test('toTickerLines maps raw events into display rows while preserving order', () => {
  const events = [
    { id: 2, taskId: 'BM-020', taskTitle: '件名', occurredAt: '2026-10-01T09:21:40.286Z', eventType: 'running_started' },
    { id: 1, taskId: 'BM-019', taskTitle: null, occurredAt: '2026-10-01T07:11:05.978Z', eventType: 'status_changed', oldValue: 'do', newValue: 'done' },
  ];
  const lines = toTickerLines(events);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 2);
  assert.equal(lines[0].taskId, 'BM-020');
  assert.equal(lines[0].summary, 'Run');
  assert.equal(lines[1].summary, 'Update (DO→DONE)');
  assert.equal(lines[1].title, '');
});

// BM-020フィードバック: RUN/Stop等のアクション語を太字強調するため、
// action/detailを分けて描画できる必要がある(app.js側でticker-action/ticker-detailに割り当てる)。
test('toTickerLines splits the action word from its detail for bold emphasis', () => {
  const events = [
    { id: 1, taskId: 'BM-020', occurredAt: '2026-10-01T09:21:40.286Z', eventType: 'running_started' },
    { id: 2, taskId: 'BM-019', occurredAt: '2026-10-01T07:11:05.978Z', eventType: 'status_changed', oldValue: 'do', newValue: 'done' },
  ];
  const lines = toTickerLines(events);
  assert.equal(lines[0].action, 'Run');
  assert.equal(lines[0].detail, '');
  assert.equal(lines[1].action, 'Update');
  assert.equal(lines[1].detail, '(DO→DONE)');
});

test('toTickerLines returns an empty array for non-array input', () => {
  assert.deepEqual(toTickerLines(null), []);
  assert.deepEqual(toTickerLines(undefined), []);
});
