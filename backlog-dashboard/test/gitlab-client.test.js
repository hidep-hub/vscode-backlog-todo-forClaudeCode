'use strict';

// BM-074: gitlab-client.js(HTTPクライアント)をローカルのモックHTTPサーバーで検証する。
// 実GitLabへの疎通確認はこのテストの対象外(手動確認、引き継ぎファイル参照)。

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const gitlabClient = require('../gitlab-client');

async function startMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, host: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

test('fetchIssuesPage sends state/per_page/page and the PRIVATE-TOKEN header', async () => {
  let receivedUrl = null;
  let receivedToken = null;
  const mock = await startMockServer((req, res) => {
    receivedUrl = req.url;
    receivedToken = req.headers['private-token'];
    sendJson(res, 200, [{ iid: 1, title: 'A' }], { 'x-total': '42', 'x-next-page': '2' });
  });
  try {
    const page = await gitlabClient.fetchIssuesPage(mock.host, 'secret-token', 'group/project', { statusFilter: 'open', page: 1, perPage: 50 });
    assert.equal(page.totalCount, 42);
    assert.equal(page.hasNext, true);
    assert.equal(page.issues.length, 1);
    assert.equal(receivedToken, 'secret-token');
    const url = new URL(receivedUrl, 'http://x');
    assert.ok(url.pathname.endsWith('/api/v4/projects/group%2Fproject/issues'));
    assert.equal(url.searchParams.get('state'), 'opened');
    assert.equal(url.searchParams.get('per_page'), '50');
    assert.equal(url.searchParams.get('page'), '1');
  } finally {
    await mock.close();
  }
});

test('fetchIssuesPage uses state=all when statusFilter is "all"', async () => {
  let receivedUrl = null;
  const mock = await startMockServer((req, res) => {
    receivedUrl = req.url;
    sendJson(res, 200, []);
  });
  try {
    await gitlabClient.fetchIssuesPage(mock.host, 'k', 'group/project', { statusFilter: 'all' });
    assert.equal(new URL(receivedUrl, 'http://x').searchParams.get('state'), 'all');
  } finally {
    await mock.close();
  }
});

test('fetchIssuesPage returns totalCount:null when x-total header is absent', async () => {
  const mock = await startMockServer((req, res) => {
    sendJson(res, 200, [{ iid: 1, title: 'A' }]); // x-totalヘッダー無し
  });
  try {
    const page = await gitlabClient.fetchIssuesPage(mock.host, 'k', 'group/project', { statusFilter: 'open' });
    assert.equal(page.totalCount, null);
    assert.equal(page.hasNext, false);
  } finally {
    await mock.close();
  }
});

test('fetchIssuesBatch pages until maxCount or x-next-page is absent', async () => {
  let calls = 0;
  const mock = await startMockServer((req, res) => {
    calls += 1;
    const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
    // 250件を模す(100,100,50の3ページ)
    const offset = (page - 1) * 100;
    const remaining = Math.max(0, 250 - offset);
    const pageSize = Math.min(100, remaining);
    const issues = Array.from({ length: pageSize }, (_, i) => ({ iid: offset + i + 1, title: `issue ${offset + i + 1}` }));
    const headers = { 'x-total': '250' };
    if (offset + pageSize < 250) headers['x-next-page'] = String(page + 1);
    sendJson(res, 200, issues, headers);
  });
  try {
    const batch = await gitlabClient.fetchIssuesBatch(mock.host, 'k', 'group/project', { statusFilter: 'open', maxCount: 500 });
    assert.equal(batch.issues.length, 250);
    assert.equal(batch.totalCount, 250);
    assert.equal(batch.hasMore, false);
    assert.equal(calls, 3); // 100 + 100 + 50(x-next-page無しでbreak)
  } finally {
    await mock.close();
  }
});

test('fetchIssuesBatch stops at maxCount even if more pages would be available', async () => {
  const mock = await startMockServer((req, res) => {
    const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
    const offset = (page - 1) * 100;
    const issues = Array.from({ length: 100 }, (_, i) => ({ iid: offset + i + 1, title: `issue ${offset + i + 1}` }));
    sendJson(res, 200, issues, { 'x-total': '10000', 'x-next-page': String(page + 1) });
  });
  try {
    const batch = await gitlabClient.fetchIssuesBatch(mock.host, 'k', 'group/project', { statusFilter: 'open', maxCount: 250 });
    assert.equal(batch.issues.length, 250);
    assert.equal(batch.totalCount, 10000);
    assert.equal(batch.hasMore, true); // まだ続きがある(maxCountで打ち切っただけ)
  } finally {
    await mock.close();
  }
});

test('fetchIssuesBatch honors offset by converting it to a page number', async () => {
  const receivedPages = [];
  const mock = await startMockServer((req, res) => {
    const page = Number(new URL(req.url, 'http://x').searchParams.get('page'));
    receivedPages.push(page);
    sendJson(res, 200, [{ iid: 1, title: 'x' }], { 'x-total': '500' }); // x-next-page無しで即break
  });
  try {
    await gitlabClient.fetchIssuesBatch(mock.host, 'k', 'group/project', { statusFilter: 'open', offset: 300 });
    assert.deepEqual(receivedPages, [4]); // offset300 / pageSize100 + 1 = 4
  } finally {
    await mock.close();
  }
});

test('fetchIssuesByIids splits requests into chunks of 100 and concatenates results', async () => {
  const receivedIidCounts = [];
  const mock = await startMockServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const iids = url.searchParams.getAll('iids[]');
    receivedIidCounts.push(iids.length);
    sendJson(res, 200, iids.map((iid) => ({ iid: Number(iid), title: `issue ${iid}` })));
  });
  try {
    const iids = Array.from({ length: 150 }, (_, i) => i + 1);
    const issues = await gitlabClient.fetchIssuesByIids(mock.host, 'k', 'group/project', iids);
    assert.equal(issues.length, 150);
    assert.deepEqual(receivedIidCounts, [100, 50]);
  } finally {
    await mock.close();
  }
});

test('fetchIssuesByIids returns an empty array without a request when given no iids', async () => {
  const issues = await gitlabClient.fetchIssuesByIids('http://unused.invalid', 'k', 'group/project', []);
  assert.deepEqual(issues, []);
});

test('callRest-based methods reject with a readable error on non-2xx responses', async () => {
  const mock = await startMockServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '401 Unauthorized' }));
  });
  try {
    await assert.rejects(
      () => gitlabClient.fetchIssuesPage(mock.host, 'bad-token', 'group/project', { statusFilter: 'open' }),
      /GitLab APIエラー \(401\)/
    );
  } finally {
    await mock.close();
  }
});
