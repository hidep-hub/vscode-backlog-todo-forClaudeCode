'use strict';

// BM-072: 外部ITS(Redmine)取り込みAPI(its-meta/its-preview/its-import)を実サーバーで検証する。
// 実Redmineの代わりにローカルのモックHTTPサーバーを立て、its-credentials.jsonでそこを向かせる。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function post(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// 固定のRedmineチケット集合: 1(トラッカー1の親, close), 2,3(1の子), 4(トラッカー1,親なし), 5(トラッカー2)
const ISSUES = [
  { id: 1, subject: '親チケット', description: '親の説明', tracker: { id: 1, name: 'タスク' }, status: { id: 5, name: '完了' }, start_date: '2026-10-01', due_date: '2026-10-10' },
  { id: 2, subject: '子チケットA', description: '子Aの説明', tracker: { id: 1, name: 'タスク' }, status: { id: 1, name: '新規' }, parent: { id: 1 }, start_date: null, due_date: null },
  { id: 3, subject: '子チケットB', description: '子Bの説明', tracker: { id: 1, name: 'タスク' }, status: { id: 1, name: '新規' }, parent: { id: 1 }, start_date: null, due_date: null },
  { id: 4, subject: '単独チケット', description: '単独の説明', tracker: { id: 1, name: 'タスク' }, status: { id: 1, name: '新規' }, start_date: null, due_date: '2026-11-01' },
  { id: 5, subject: '別トラッカー', description: '', tracker: { id: 2, name: '不具合' }, status: { id: 1, name: '新規' }, start_date: null, due_date: null },
];

async function startMockRedmine() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/redmine/projects/sample.json') {
      return sendJson(res, 200, { project: { name: 'サンプルプロジェクト', trackers: [{ id: 1, name: 'タスク' }, { id: 2, name: '不具合' }] } });
    }
    if (url.pathname === '/redmine/issue_statuses.json') {
      return sendJson(res, 200, { issue_statuses: [{ id: 1, name: '新規', is_closed: false }, { id: 5, name: '完了', is_closed: true }] });
    }
    if (url.pathname === '/redmine/issues.json') {
      const issueIdParam = url.searchParams.get('issue_id');
      if (issueIdParam) {
        const ids = new Set(issueIdParam.split(',').map(Number));
        return sendJson(res, 200, { issues: ISSUES.filter((i) => ids.has(i.id)) });
      }
      const trackerId = Number(url.searchParams.get('tracker_id'));
      const statusId = url.searchParams.get('status_id');
      let matched = ISSUES.filter((i) => i.tracker.id === trackerId);
      if (statusId !== '*') matched = matched.filter((i) => i.status.id !== 5); // open相当
      return sendJson(res, 200, { issues: matched, total_count: matched.length });
    }
    sendJson(res, 404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, host: `http://127.0.0.1:${port}/redmine`, close: () => new Promise((r) => server.close(r)) };
}

test('its-meta/its-preview/its-import work end to end against a mocked Redmine', async (t) => {
  const sourceRoot = path.resolve(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.api-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const port = await unusedPort();
  const mockRedmine = await startMockRedmine();
  t.after(() => mockRedmine.close());

  const config = {
    port, backlogDir: dataDir, defaultWorkspaceParent: fixtureRoot,
    columns: [
      { id: 'todo', label: 'TODO', match: ['todo'] },
      { id: 'done', label: 'DONE', match: ['done'] },
    ],
    projects: [],
  };
  fs.mkdirSync(dataDir, { recursive: true });
  for (const entry of ['server.js', 'tags-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'redmine-client.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify(config), 'utf8');
  // its-credentials.jsonを直接配置して、モックRedmineのhost/tokenを設定済みにする
  fs.writeFileSync(path.join(fixtureRoot, 'its-credentials.json'), JSON.stringify({
    workspaces: { test: { redmine: { projectUrl: `${mockRedmine.host}/projects/sample` } } },
    hosts: { redmine: { [mockRedmine.host]: { token: 'mock-token' } } },
  }), 'utf8');

  const child = spawn(process.execPath, ['server.js'], { cwd: fixtureRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '';
  child.stdout.on('data', (d) => { serverOutput += d.toString(); });
  child.stderr.on('data', (d) => { serverOutput += d.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await get(baseUrl, '/api/health')).status === 200) break;
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (attempt === 99) throw new Error('test server did not start. exitCode=' + child.exitCode + ' signalCode=' + child.signalCode + '\n' + serverOutput);
    }

    const createdWs = await post(baseUrl, '/api/create-workspace', { file: 'test', prefix: 'TS', name: 'Test' });
    assert.equal(createdWs.body.ok, true, JSON.stringify(createdWs.body));

    // its-meta: プロジェクト名・トラッカー一覧
    const meta = await get(baseUrl, '/api/its-meta?prefix=TS&source=redmine');
    assert.equal(meta.status, 200);
    assert.equal(meta.body.name, 'サンプルプロジェクト');
    assert.deepEqual(meta.body.trackers, [{ id: 1, name: 'タスク' }, { id: 2, name: '不具合' }]);

    // its-preview: トラッカー1、open既定 -> 完了(id:1)は隠れ、2,3,4が残る。1は親なので2,3の親として階層化
    const previewOpen = await get(baseUrl, '/api/its-preview?prefix=TS&source=redmine&trackerId=1');
    assert.equal(previewOpen.status, 200);
    assert.equal(previewOpen.body.total, 3); // id:2,3,4(id:1はclosedなのでopenフィルタで除外)
    assert.equal(previewOpen.body.nextOffset, null);
    const keys = previewOpen.body.issues.map((i) => i.key);
    assert.deepEqual(keys.sort(), ['2', '3', '4']);
    const issue4 = previewOpen.body.issues.find((i) => i.key === '4');
    assert.equal(issue4.dueDate, '2026-11-01');
    assert.equal(issue4.alreadyImported, false);

    // its-preview: status=all -> 完了(id:1)も含めて4件、親子関係が見える
    const previewAll = await get(baseUrl, '/api/its-preview?prefix=TS&source=redmine&trackerId=1&status=all');
    assert.equal(previewAll.body.total, 4);
    const parentItem = previewAll.body.issues.find((i) => i.key === '1');
    assert.equal(parentItem.state, 'closed');
    assert.deepEqual(parentItem.childKeys.sort(), ['2', '3']);
    const childItem = previewAll.body.issues.find((i) => i.key === '2');
    assert.equal(childItem.parentKey, '1');

    // 必須パラメータ無しや未対応sourceは400
    assert.equal((await get(baseUrl, '/api/its-preview?prefix=TS&source=redmine')).status, 400); // trackerId無し
    assert.equal((await get(baseUrl, '/api/its-preview?prefix=TS&source=gitlab&trackerId=1')).status, 400);
    assert.equal((await get(baseUrl, '/api/its-meta?prefix=ZZ&source=redmine')).status, 404);

    // its-import: 親(id:1)を選ぶと、取得し直した結果のparent.idで子(2,3)も一緒に取り込まれる。
    // 単独(id:4)も一緒に選ぶ。
    const imported = await post(baseUrl, '/api/its-import', { prefix: 'TS', source: 'redmine', keys: ['1', '2', '3', '4'] });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.ok, true, JSON.stringify(imported.body));
    assert.equal(imported.body.added, 4, JSON.stringify(imported.body));
    assert.equal(imported.body.skipped, 0);
    assert.deepEqual(imported.body.errors, [], JSON.stringify(imported.body));

    const board = await get(baseUrl, '/api/board?workspace=test');
    const allItems = board.body.columns.flatMap((c) => c.items);
    const parentTask = allItems.find((i) => i.title === '親チケット');
    assert.ok(parentTask, 'parent task should be imported');
    // BM-069方針B: 取り込む項目はtodo固定。Redmine側がclose済みでも取り込み後はtodoになる
    assert.equal(parentTask.statusCode, 'todo');
    assert.deepEqual(parentTask.externalLinks, [{ source: 'redmine', key: '1', url: `${mockRedmine.host}/issues/1`, projectRef: 'sample' }]);
    assert.equal(parentTask.children.length, 2);
    assert.deepEqual(parentTask.children.map((c) => c.title).sort(), ['子チケットA', '子チケットB']);
    const standaloneTask = allItems.find((i) => i.title === '単独チケット');
    assert.ok(standaloneTask);
    assert.equal(standaloneTask.dueDate, '2026-11-01');
    assert.equal(standaloneTask.parentId, undefined); // トップレベル

    // 同じキーを再度取り込むと全件skipped
    const reimported = await post(baseUrl, '/api/its-import', { prefix: 'TS', source: 'redmine', keys: ['1', '4'] });
    assert.equal(reimported.body.added, 0);
    assert.equal(reimported.body.skipped, 2);

    // 未設定ワークスペースでの呼び出しは400、未対応sourceも400
    const added = await post(baseUrl, '/api/add-task', { title: 'extra ws probe', project: 'test', status: 'todo' });
    assert.equal(added.body.ok, true);
    assert.equal((await post(baseUrl, '/api/its-import', { prefix: 'TS', source: 'gitlab', keys: ['1'] })).status, 400);
    assert.equal((await post(baseUrl, '/api/its-import', { prefix: 'TS', source: 'redmine', keys: [] })).status, 400);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
