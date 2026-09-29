const test = require('node:test');
const assert = require('node:assert/strict');
const { orderAgentsByActivity } = require('../public/running-agent-order.js');

test('places active agents before inactive agents while preserving each group order', () => {
  assert.deepEqual(
    orderAgentsByActivity(['codex', 'claude-code', 'kiro'], ['kiro']),
    ['kiro', 'codex', 'claude-code'],
  );
});

test('keeps an unknown active agent in the active group', () => {
  assert.deepEqual(
    orderAgentsByActivity(['codex', 'claude-code', 'kiro', 'user'], ['kiro', 'user']),
    ['kiro', 'user', 'codex', 'claude-code'],
  );
});
