'use strict';

// BM-072: redmine-client.js(HTTPクライアント)をローカルのモックHTTPサーバーで検証する。
// 実Redmineへの疎通確認はこのテストの対象外(手動確認、引き継ぎファイル参照)。

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const redmineClient = require('../redmine-client');

async function startMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, host: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

test('fetchProjectInfo returns name and trackers, sending the API key header', async () => {
  let receivedKey = null;
  const mock = await startMockServer((req, res) => {
    receivedKey = req.headers['x-redmine-api-key'];
    if (req.url === '/projects/sample.json?include=trackers') {
      return sendJson(res, 200, { project: { name: '日本語プロジェクト名', trackers: [{ id: 1, name: 'タスク' }, { id: 2, name: '不具合' }] } });
    }
    sendJson(res, 404, {});
  });
  try {
    const info = await redmineClient.fetchProjectInfo(mock.host, 'secret-key', 'sample');
    assert.equal(info.name, '日本語プロジェクト名');
    assert.deepEqual(info.trackers, [{ id: 1, name: 'タスク' }, { id: 2, name: '不具合' }]);
    assert.equal(receivedKey, 'secret-key');
  } finally {
    await mock.close();
  }
});

test('fetchClosedStatusIds returns only is_closed:true ids', async () => {
  const mock = await startMockServer((req, res) => {
    sendJson(res, 200, { issue_statuses: [{ id: 1, name: '新規', is_closed: false }, { id: 5, name: '完了', is_closed: true }, { id: 6, name: '却下', is_closed: true }] });
  });
  try {
    const closed = await redmineClient.fetchClosedStatusIds(mock.host, 'k');
    assert.deepEqual([...closed].sort(), [5, 6]);
  } finally {
    await mock.close();
  }
});

test('fetchIssuesPage sends tracker_id/status_id/project_id and returns issues+totalCount', async () => {
  let receivedUrl = null;
  const mock = await startMockServer((req, res) => {
    receivedUrl = req.url;
    sendJson(res, 200, { issues: [{ id: 1, subject: 'A' }], total_count: 42 });
  });
  try {
    const page = await redmineClient.fetchIssuesPage(mock.host, 'k', 'sample', { trackerId: 3, statusFilter: 'open', limit: 50, offset: 10 });
    assert.equal(page.totalCount, 42);
    assert.equal(page.issues.length, 1);
    const url = new URL(receivedUrl, 'http://x');
    assert.equal(url.searchParams.get('project_id'), 'sample');
    assert.equal(url.searchParams.get('tracker_id'), '3');
    assert.equal(url.searchParams.get('status_id'), 'open');
    assert.equal(url.searchParams.get('limit'), '50');
    assert.equal(url.searchParams.get('offset'), '10');
  } finally {
    await mock.close();
  }
});

test('fetchIssuesPage uses status_id=* when statusFilter is "all"', async () => {
  let receivedUrl = null;
  const mock = await startMockServer((req, res) => {
    receivedUrl = req.url;
    sendJson(res, 200, { issues: [], total_count: 0 });
  });
  try {
    await redmineClient.fetchIssuesPage(mock.host, 'k', 'sample', { trackerId: 1, statusFilter: 'all' });
    assert.equal(new URL(receivedUrl, 'http://x').searchParams.get('status_id'), '*');
  } finally {
    await mock.close();
  }
});

test('fetchIssuesBatch pages until maxCount or the server returns a short page', async () => {
  let calls = 0;
  const mock = await startMockServer((req, res) => {
    calls += 1;
    const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset'));
    // 250件を模す(100,100,50の3ページ)
    const remaining = Math.max(0, 250 - offset);
    const pageSize = Math.min(100, remaining);
    const issues = Array.from({ length: pageSize }, (_, i) => ({ id: offset + i + 1, subject: `issue ${offset + i + 1}` }));
    sendJson(res, 200, { issues, total_count: 250 });
  });
  try {
    const batch = await redmineClient.fetchIssuesBatch(mock.host, 'k', 'sample', { trackerId: 1, statusFilter: 'open', maxCount: 500 });
    assert.equal(batch.issues.length, 250);
    assert.equal(batch.totalCount, 250);
    assert.equal(calls, 3); // 100 + 100 + 50(短いページでbreak)
  } finally {
    await mock.close();
  }
});

test('fetchIssuesBatch stops at maxCount even if more pages would be available', async () => {
  const mock = await startMockServer((req, res) => {
    const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset'));
    const issues = Array.from({ length: 100 }, (_, i) => ({ id: offset + i + 1, subject: `issue ${offset + i + 1}` }));
    sendJson(res, 200, { issues, total_count: 10000 });
  });
  try {
    const batch = await redmineClient.fetchIssuesBatch(mock.host, 'k', 'sample', { trackerId: 1, statusFilter: 'open', maxCount: 250 });
    assert.equal(batch.issues.length, 250);
    assert.equal(batch.totalCount, 10000);
  } finally {
    await mock.close();
  }
});

test('fetchIssuesByIds splits requests into chunks of 100 and concatenates results', async () => {
  const receivedIssueIdParams = [];
  const mock = await startMockServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const ids = url.searchParams.get('issue_id').split(',');
    receivedIssueIdParams.push(ids.length);
    sendJson(res, 200, { issues: ids.map((id) => ({ id: Number(id), subject: `issue ${id}` })) });
  });
  try {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const issues = await redmineClient.fetchIssuesByIds(mock.host, 'k', ids);
    assert.equal(issues.length, 150);
    assert.deepEqual(receivedIssueIdParams, [100, 50]);
  } finally {
    await mock.close();
  }
});

test('fetchIssuesByIds returns an empty array without a request when given no ids', async () => {
  const issues = await redmineClient.fetchIssuesByIds('http://unused.invalid', 'k', []);
  assert.deepEqual(issues, []);
});

test('callRest-based methods reject with a readable error on non-2xx responses', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid key' }));
  });
  try {
    await assert.rejects(
      () => redmineClient.fetchProjectInfo(mock.host, 'bad-key', 'sample'),
      /Redmine APIエラー \(401\)/
    );
  } finally {
    await mock.close();
  }
});
