'use strict';

// BT-446: 直近の更新コミットAPI(recent-commits-api.js)を、git実行を差し替えて検証する。

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRecentCommitsApi, parseLimit, parseLog, withHead, DEFAULT_LIMIT, MAX_LIMIT } = require('../recent-commits-api');

const LOG = [
  'abc1234\u001f2026-10-19T12:00:00+09:00\u001f機能を追加 (BT-1)\u001f- 1行目\n- 2行目\n\u001e',
  '\ndef5678\u001f2026-10-18T09:00:00+09:00\u001f件名に|を含む\u001f\u001e',
].join('');

function call(handle, method, url) {
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status) { this.status = status; },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    if (!handle({ method, url }, res)) reject(new Error('not handled'));
  });
}

test('parseLimit: 省略は既定、上限で丸め、不正はnull', () => {
  assert.equal(parseLimit(null), DEFAULT_LIMIT);
  assert.equal(parseLimit('10'), 10);
  assert.equal(parseLimit('99999'), MAX_LIMIT);
  assert.equal(parseLimit('0'), null);
  assert.equal(parseLimit('abc'), null);
  assert.equal(parseLimit('-3'), null);
});

test('parseLog: ハッシュ・日時・件名に分解する', () => {
  assert.deepEqual(parseLog(LOG), [
    { shortHash: 'abc1234', date: '2026-10-19T12:00:00+09:00', subject: '機能を追加 (BT-1)', body: '- 1行目\n- 2行目' },
    { shortHash: 'def5678', date: '2026-10-18T09:00:00+09:00', subject: '件名に|を含む', body: '' },
  ]);
  assert.deepEqual(parseLog(''), []);
});

test('GET /api/recent-commits: 既定件数で取得し、limitを渡せる', async () => {
  const seen = [];
  const handle = createRecentCommitsApi({ repoRoot: '.', runHead: async () => '', run: async (n) => { seen.push(n); return LOG; } });
  const a = await call(handle, 'GET', '/api/recent-commits');
  assert.equal(a.status, 200);
  assert.equal(a.body.commits.length, 2);
  await call(handle, 'GET', '/api/recent-commits?limit=5');
  assert.deepEqual(seen, [DEFAULT_LIMIT, 5]);
});

test('GET /api/recent-commits: 不正なlimitは400', async () => {
  const handle = createRecentCommitsApi({ repoRoot: '.', runHead: async () => '', run: async () => LOG });
  const { status, body } = await call(handle, 'GET', '/api/recent-commits?limit=x');
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_limit');
});

test('GET /api/recent-commits: git失敗時は空配列+unavailable', async () => {
  const handle = createRecentCommitsApi({ repoRoot: '.', runHead: async () => '', run: async () => { throw new Error('not a git repo'); } });
  const { status, body } = await call(handle, 'GET', '/api/recent-commits');
  assert.equal(status, 200);
  assert.deepEqual(body.commits, []);
  assert.equal(body.unavailable, true);
});

test('対象外のパス・メソッドは処理しない', () => {
  const handle = createRecentCommitsApi({ repoRoot: '.', runHead: async () => '', run: async () => LOG });
  assert.equal(handle({ method: 'POST', url: '/api/recent-commits' }, {}), false);
  assert.equal(handle({ method: 'GET', url: '/api/health' }, {}), false);
});

const MERGE_HEAD = 'fff00002026-10-20T01:00:00+09:00Merge pull request #1機能を追加';

test('withHead: HEADがマージコミットなら先頭に1件足してisHeadを付ける', () => {
  const out = withHead(parseLog(LOG), MERGE_HEAD);
  assert.equal(out.length, 3);
  assert.equal(out[0].shortHash, 'fff0000');
  assert.equal(out[0].isHead, true);
  assert.equal(out[1].isHead, undefined);
});

test('withHead: HEADが一覧にあれば重複させずisHeadだけ付ける', () => {
  const headStdout = 'abc12342026-10-19T12:00:00+09:00機能を追加 (BT-1)';
  const out = withHead(parseLog(LOG), headStdout);
  assert.equal(out.length, 2);
  assert.equal(out[0].isHead, true);
});

test('withHead: HEAD取得に失敗(空)なら一覧をそのまま返す', () => {
  assert.deepEqual(withHead(parseLog(LOG), ''), parseLog(LOG));
});

test('GET /api/recent-commits: マージHEADが先頭に入る', async () => {
  const handle = createRecentCommitsApi({ repoRoot: '.', run: async () => LOG, runHead: async () => MERGE_HEAD });
  const { body } = await call(handle, 'GET', '/api/recent-commits');
  assert.equal(body.commits[0].shortHash, 'fff0000');
  assert.equal(body.commits[0].isHead, true);
});
