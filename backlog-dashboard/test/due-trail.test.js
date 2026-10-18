'use strict';

// BT-435: 期日変更履歴の経緯組み立て(延期=later/前倒し=earlier)を検証する

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { dueDirection, buildDueTrail, directionClass } = require('../public/due-trail');

test('dueDirection: later / earlier / null', () => {
  assert.equal(dueDirection('2026-10-01', '2026-10-05'), 'later');
  assert.equal(dueDirection('2026-10-05', '2026-10-01'), 'earlier');
  assert.equal(dueDirection('2026-10-01', '2026-10-01'), null);
  assert.equal(dueDirection(null, '2026-10-01'), null);
  assert.equal(dueDirection('2026-10-01', null), null);
});

test('buildDueTrail: empty history gives empty trail', () => {
  assert.deepEqual(buildDueTrail([]), []);
  assert.deepEqual(buildDueTrail(undefined), []);
});

test('buildDueTrail: oldest first with direction and changed-at per change', () => {
  const trail = buildDueTrail([
    { from: '2026-10-01', to: '2026-10-05', at: '2026-10-02T01:00:00Z' },
    { from: '2026-10-05', to: '2026-10-03', at: '2026-10-03T01:00:00Z' },
  ]);
  assert.deepEqual(trail, [
    { value: '2026-10-01', at: null, direction: null },
    { value: '2026-10-05', at: '2026-10-02T01:00:00Z', direction: 'later' },
    { value: '2026-10-03', at: '2026-10-03T01:00:00Z', direction: 'earlier' },
  ]);
});

test('buildDueTrail: leading unset is dropped and first set has no direction', () => {
  const trail = buildDueTrail([
    { from: null, to: '2026-10-01', at: 'a' },
    { from: '2026-10-01', to: '2026-10-09', at: 'b' },
  ]);
  assert.deepEqual(trail, [
    { value: '2026-10-01', at: 'a', direction: null },
    { value: '2026-10-09', at: 'b', direction: 'later' },
  ]);
});

test('directionClass maps direction to css class', () => {
  assert.equal(directionClass('later'), 'due-postponed');
  assert.equal(directionClass('earlier'), 'due-advanced');
  assert.equal(directionClass(null), '');
});
