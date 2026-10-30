'use strict';

// BM-126: 既存タスクへRedmineチケットを後から紐づけるAPI(its-link-issue)を実サーバーで検証する。
// 実Redmineの代わりにローカルのモックHTTPサーバーを立て、its-credentials.jsonでそこを向かせる。
// テストの骨格はits-import-api.test.jsと同じ(フィクスチャ作成→子プロセスでserver.js起動→fetchで叩く)。

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

// 固定のRedmineチケット集合: 10(存在する), 20(別のチケット、上書き確認用)
const ISSUES = [
  { id: 10, subject: 'チケット10', description: '', tracker: { id: 1, name: 'タスク' }, status: { id: 1, name: '新規' } },
  { id: 20, subject: 'チケット20', description: '', tracker: { id: 1, name: 'タスク' }, status: { id: 1, name: '新規' } },
];

async function startMockRedmine() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/redmine/issues.json') {
      const issueIdParam = url.searchParams.get('issue_id');
      const ids = new Set((issueIdParam || '').split(',').filter(Boolean).map(Number));
      return sendJson(res, 200, { issues: ISSUES.filter((i) => ids.has(i.id)) });
    }
    sendJson(res, 404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, host: `http://127.0.0.1:${port}/redmine`, close: () => new Promise((r) => server.close(r)) };
}

test('its-link-issue links, overwrites, asks before sharing an issue across tasks, and validates (BM-126, BM-158)', async (t) => {
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
  for (const entry of ['server.js', 'tags-api.js', 'comments-api.js', 'categories-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'its-link-api.js', 'rules-sync-api.js', 'recent-commits-api.js', 'redmine-client.js', 'gitlab-client.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify(config), 'utf8');
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

    const taskA = await post(baseUrl, '/api/add-task', { title: 'タスクA', project: 'test', status: 'todo' });
    assert.equal(taskA.body.ok, true);
    const taskAId = taskA.body.id;
    const taskB = await post(baseUrl, '/api/add-task', { title: 'タスクB', project: 'test', status: 'todo' });
    const taskBId = taskB.body.id;

    // 存在しないtaskId -> 404
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: 'TS-999', source: 'redmine', issueKey: '10' })).status, 404);
    // 未対応source -> 400（BM-164でgitlabは対応済みになったため、対応していないsourceとしてgithubを使う）
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'github', issueKey: '10' })).status, 400);
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'unknown', issueKey: '10' })).status, 400);
    // 必須パラメータ無し -> 400
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'redmine' })).status, 400);

    // 正常系: taskAにチケット10を紐づける
    const linked = await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'redmine', issueKey: '#10', actor: 'kiro' });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.ok, true);
    assert.equal(linked.body.issueKey, '10');
    assert.equal(linked.body.issueUrl, `${mockRedmine.host}/issues/10`);
    assert.deepEqual(linked.body.sharedWith, [], 'first link has nobody to share with');

    let detail = await get(baseUrl, `/api/task/${taskAId}`);
    assert.deepEqual(detail.body.externalLinks, [{ source: 'redmine', key: '10', url: `${mockRedmine.host}/issues/10`, projectRef: 'sample' }]);

    // Redmine側に存在しないチケット番号 -> 404
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'redmine', issueKey: '999' })).status, 404);

    // BM-158: 別タスク(taskB)が同じチケット10を紐づけようとすると、まず409で確認を求められ、何も保存されない
    const dup = await post(baseUrl, '/api/its-link-issue', { taskId: taskBId, source: 'redmine', issueKey: '10' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'already_linked');
    assert.deepEqual(dup.body.linkedTaskIds, [taskAId]);
    assert.deepEqual((await get(baseUrl, `/api/task/${taskBId}`)).body.externalLinks, []);

    // allowSharedがtrue(真偽値)以外なら確認済みとは扱わない
    for (const allowShared of [false, 'true', 1]) {
      const notConfirmed = await post(baseUrl, '/api/its-link-issue', { taskId: taskBId, source: 'redmine', issueKey: '10', allowShared });
      assert.equal(notConfirmed.status, 409, `allowShared=${JSON.stringify(allowShared)}`);
    }

    // allowShared:true で再送すると、同じチケットを2タスクで共有できる(1チケット:nタスク)
    const shared = await post(baseUrl, '/api/its-link-issue', { taskId: taskBId, source: 'redmine', issueKey: '10', allowShared: true });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.sharedWith, [taskAId]);
    const expectedLink10 = [{ source: 'redmine', key: '10', url: `${mockRedmine.host}/issues/10`, projectRef: 'sample' }];
    assert.deepEqual((await get(baseUrl, `/api/task/${taskAId}`)).body.externalLinks, expectedLink10);
    assert.deepEqual((await get(baseUrl, `/api/task/${taskBId}`)).body.externalLinks, expectedLink10);

    // 共有済みのチケットに、自分自身(taskB)を再度紐づけ直しても確認は要らない(共有先は自分以外で数える)
    const sameAgain = await post(baseUrl, '/api/its-link-issue', { taskId: taskBId, source: 'redmine', issueKey: '10', allowShared: true });
    assert.equal(sameAgain.status, 200);
    assert.deepEqual(sameAgain.body.sharedWith, [taskAId]);

    // 上書き: taskAを別チケット(20)で紐づけ直す(ユーザー合意事項: 上書き許可)。taskBの10はそのまま残る
    const overwritten = await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'redmine', issueKey: '20' });
    assert.equal(overwritten.status, 200, JSON.stringify(overwritten.body));
    assert.equal(overwritten.body.issueKey, '20');
    detail = await get(baseUrl, `/api/task/${taskAId}`);
    assert.deepEqual(detail.body.externalLinks, [{ source: 'redmine', key: '20', url: `${mockRedmine.host}/issues/20`, projectRef: 'sample' }]);
    assert.deepEqual((await get(baseUrl, `/api/task/${taskBId}`)).body.externalLinks, expectedLink10);

    // 共有が解消されたあと(taskAが20へ移動)は、確認なしでtaskB自身を10に紐づけ直せる
    const reLinked = await post(baseUrl, '/api/its-link-issue', { taskId: taskBId, source: 'redmine', issueKey: '10' });
    assert.equal(reLinked.status, 200, JSON.stringify(reLinked.body));
    assert.deepEqual(reLinked.body.sharedWith, []);

    // 未設定ワークスペース(Redmine接続未設定)は400
    await post(baseUrl, '/api/create-workspace', { file: 'noconn', prefix: 'NC', name: 'NoConn' });
    const taskC = await post(baseUrl, '/api/add-task', { title: 'タスクC', project: 'noconn', status: 'todo' });
    const taskCId = taskC.body.id;
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskCId, source: 'redmine', issueKey: '10' })).status, 400);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// BM-164: GitLabの個別紐づけ。実GitLabの代わりにローカルのモックHTTPサーバーを立てる。
// 取り込み(its-import-api.test.js)のモックと同じ形(/api/v4/projects/<URLエンコードしたパス>/issues、iids[]、state=all)。
// issue 10(open)、11(closed)が存在する。別プロジェクトの同じiidを引いても返らないことも確かめる。
const GITLAB_LINK_ISSUES = [
  { iid: 10, title: 'GitLab issue A', state: 'opened', web_url: 'http://gitlab.example.com/group/project/-/issues/10' },
  { iid: 11, title: 'GitLab issue B', state: 'closed', web_url: 'http://gitlab.example.com/group/project/-/issues/11' },
];

async function startMockGitlabForLink() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, token: req.headers['private-token'] });
    if (url.pathname === '/api/v4/projects/group%2Fproject/issues') {
      const iids = url.searchParams.getAll('iids[]').map(Number);
      return sendJson(res, 200, GITLAB_LINK_ISSUES.filter((i) => iids.includes(i.iid)));
    }
    if (url.pathname === '/api/v4/projects/other%2Frepo/issues') {
      return sendJson(res, 200, []); // 別プロジェクトには該当issueが無い
    }
    sendJson(res, 404, { message: '404 Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, requests, host: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('its-link-issue links a GitLab issue, shares it only after confirmation, and never writes back (BM-164)', async (t) => {
  const sourceRoot = path.resolve(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.api-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const port = await unusedPort();
  const mockGitlab = await startMockGitlabForLink();
  t.after(() => mockGitlab.close());

  const config = {
    port, backlogDir: dataDir, defaultWorkspaceParent: fixtureRoot,
    columns: [
      { id: 'todo', label: 'TODO', match: ['todo'] },
      { id: 'done', label: 'DONE', match: ['done'] },
    ],
    projects: [],
  };
  fs.mkdirSync(dataDir, { recursive: true });
  for (const entry of ['server.js', 'tags-api.js', 'comments-api.js', 'categories-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'its-link-api.js', 'rules-sync-api.js', 'recent-commits-api.js', 'redmine-client.js', 'gitlab-client.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify(config), 'utf8');
  fs.writeFileSync(path.join(fixtureRoot, 'its-credentials.json'), JSON.stringify({
    workspaces: {
      test: { gitlab: { projectUrl: `${mockGitlab.host}/group/project` } },
      otherproj: { gitlab: { projectUrl: `${mockGitlab.host}/other/repo` } },
    },
    hosts: { gitlab: { [mockGitlab.host]: { token: 'mock-token' } } },
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

    assert.equal((await post(baseUrl, '/api/create-workspace', { file: 'test', prefix: 'TS', name: 'Test' })).body.ok, true);
    const taskA = await post(baseUrl, '/api/add-task', { title: 'タスクA', project: 'test', status: 'todo' });
    const taskAId = taskA.body.id;
    const taskB = await post(baseUrl, '/api/add-task', { title: 'タスクB', project: 'test', status: 'todo' });
    const taskBId = taskB.body.id;

    // 正常系: taskAにiid 10を紐づける。URLはGitLabが返すweb_url、キーはiid
    const linked = await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'gitlab', issueKey: '#10', actor: 'kiro' });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.ok, true);
    assert.equal(linked.body.source, 'gitlab');
    assert.equal(linked.body.issueKey, '10');
    assert.equal(linked.body.issueUrl, 'http://gitlab.example.com/group/project/-/issues/10');
    assert.deepEqual(linked.body.sharedWith, []);
    const expectedLink10 = [{ source: 'gitlab', key: '10', url: 'http://gitlab.example.com/group/project/-/issues/10', projectRef: 'group/project' }];
    assert.deepEqual((await get(baseUrl, `/api/task/${taskAId}`)).body.externalLinks, expectedLink10);

    // closedのissueも紐づけられる(state=allで引く)
    const closedLinked = await post(baseUrl, '/api/its-link-issue', { taskId: taskBId, source: 'gitlab', issueKey: '11' });
    assert.equal(closedLinked.status, 200, JSON.stringify(closedLinked.body));
    assert.equal(closedLinked.body.issueUrl, 'http://gitlab.example.com/group/project/-/issues/11');

    // 存在しないiid -> 404（保存もされない）
    const missing = await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'gitlab', issueKey: '999' });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /GitLab issue #999 not found/);
    assert.deepEqual((await get(baseUrl, `/api/task/${taskAId}`)).body.externalLinks, expectedLink10, '失敗しても既存の紐づけは変わらない');

    // 数字以外のキー -> 400
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'gitlab', issueKey: 'abc' })).status, 400);

    // 別タスクが同じissueを紐づけようとすると409で確認を求められ、何も保存されない（BM-158と同じ作法）
    const taskC = await post(baseUrl, '/api/add-task', { title: 'タスクC', project: 'test', status: 'todo' });
    const taskCId = taskC.body.id;
    const dup = await post(baseUrl, '/api/its-link-issue', { taskId: taskCId, source: 'gitlab', issueKey: '10' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'already_linked');
    assert.deepEqual(dup.body.linkedTaskIds, [taskAId]);
    assert.deepEqual((await get(baseUrl, `/api/task/${taskCId}`)).body.externalLinks, []);
    // allowSharedがtrue(真偽値)以外なら確認済みとは扱わない
    for (const allowShared of [false, 'true', 1]) {
      assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskCId, source: 'gitlab', issueKey: '10', allowShared })).status, 409);
    }
    const shared = await post(baseUrl, '/api/its-link-issue', { taskId: taskCId, source: 'gitlab', issueKey: '10', allowShared: true });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.sharedWith, [taskAId]);
    assert.deepEqual((await get(baseUrl, `/api/task/${taskCId}`)).body.externalLinks, expectedLink10);

    // 上書き: taskAを別のissue(11)で紐づけ直す。taskCの10はそのまま残る
    const overwritten = await post(baseUrl, '/api/its-link-issue', { taskId: taskAId, source: 'gitlab', issueKey: '11', allowShared: true });
    assert.equal(overwritten.status, 200, JSON.stringify(overwritten.body));
    assert.equal((await get(baseUrl, `/api/task/${taskAId}`)).body.externalLinks[0].key, '11');
    assert.deepEqual((await get(baseUrl, `/api/task/${taskCId}`)).body.externalLinks, expectedLink10);

    // 同じiidでも、別プロジェクト(other/repo)には存在しないので、そのワークスペースでは見つからない（404）
    assert.equal((await post(baseUrl, '/api/create-workspace', { file: 'otherproj', prefix: 'OP', name: 'Other' })).body.ok, true);
    const taskD = await post(baseUrl, '/api/add-task', { title: 'タスクD', project: 'otherproj', status: 'todo' });
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskD.body.id, source: 'gitlab', issueKey: '10' })).status, 404);

    // 未設定ワークスペース（GitLab接続なし）-> 400
    await post(baseUrl, '/api/create-workspace', { file: 'noconn', prefix: 'NC', name: 'NoConn' });
    const taskE = await post(baseUrl, '/api/add-task', { title: 'タスクE', project: 'noconn', status: 'todo' });
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId: taskE.body.id, source: 'gitlab', issueKey: '10' })).status, 400);

    // 外部への書き戻しはしない: モックGitLabに届いたのは読み取り(GET)だけで、トークンはヘッダーで送っている
    assert.ok(mockGitlab.requests.length > 0);
    assert.ok(mockGitlab.requests.every((r) => r.method === 'GET'), `GET以外が送られた: ${JSON.stringify(mockGitlab.requests)}`);
    assert.ok(mockGitlab.requests.every((r) => r.token === 'mock-token'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
