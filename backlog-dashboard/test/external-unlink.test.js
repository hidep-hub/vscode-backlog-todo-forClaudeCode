'use strict';

// BT-470: 外部連携の紐づけ解除と、紐づけ/解除の履歴(external_link_added / external_link_removed)を検証する。
//   - Redmine/GitLab: POST /api/its-unlink-issue を実サーバー(モックRedmine)で叩く
//   - GitHub: tasks-repoの setGithubLink / clearGithubLink をDBに対して直接検証する
//     (github-unlink-issueのHTTP層は、clearGithubLinkを呼ぶだけの薄い層)

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');

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

const ISSUES = [
  { id: 10, subject: 'チケット10', description: '', tracker: { id: 1, name: 'タスク' }, status: { id: 1, name: '新規' } },
  { id: 20, subject: 'チケット20', description: '', tracker: { id: 1, name: 'タスク' }, status: { id: 1, name: '新規' } },
];

async function startMockRedmine() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/redmine/issues.json') {
      const ids = new Set((url.searchParams.get('issue_id') || '').split(',').filter(Boolean).map(Number));
      return sendJson(res, 200, { issues: ISSUES.filter((i) => ids.has(i.id)) });
    }
    sendJson(res, 404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { host: `http://127.0.0.1:${port}/redmine`, close: () => new Promise((r) => server.close(r)) };
}

// 指定タスクの外部連携イベント(古い順)を「種別 値」の文字列にして返す
async function linkEvents(baseUrl, taskId) {
  const { body } = await get(baseUrl, '/api/activity');
  return body
    .filter((e) => e.taskId === taskId && e.eventType.startsWith('external_link_'))
    .reverse()
    .map((e) => `${e.eventType} ${e.newValue || e.oldValue} (${e.actor})`);
}

test('its-unlink-issue removes the link and records history; link/overwrite are recorded too (BT-470)', async (t) => {
  const sourceRoot = path.resolve(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.api-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const port = await unusedPort();
  const mockRedmine = await startMockRedmine();
  t.after(() => mockRedmine.close());

  fs.mkdirSync(dataDir, { recursive: true });
  for (const entry of ['server.js', 'tags-api.js', 'comments-api.js', 'categories-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'its-link-api.js', 'rules-sync-api.js', 'recent-commits-api.js', 'redmine-client.js', 'gitlab-client.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify({
    port, backlogDir: dataDir, defaultWorkspaceParent: fixtureRoot,
    columns: [
      { id: 'todo', label: 'TODO', match: ['todo'] },
      { id: 'done', label: 'DONE', match: ['done'] },
    ],
    projects: [],
  }), 'utf8');
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
      if (attempt === 99) throw new Error('test server did not start\n' + serverOutput);
    }

    assert.equal((await post(baseUrl, '/api/create-workspace', { file: 'test', prefix: 'TS', name: 'Test' })).body.ok, true);
    const taskId = (await post(baseUrl, '/api/add-task', { title: 'タスクA', project: 'test', status: 'todo' })).body.id;

    // 紐づいていない -> 404、入力不備 -> 400
    assert.equal((await post(baseUrl, '/api/its-unlink-issue', { taskId, source: 'redmine' })).status, 404);
    assert.equal((await post(baseUrl, '/api/its-unlink-issue', { taskId: 'TS-999', source: 'redmine' })).status, 404);
    assert.equal((await post(baseUrl, '/api/its-unlink-issue', { taskId, source: 'github' })).status, 400);
    assert.equal((await post(baseUrl, '/api/its-unlink-issue', { source: 'redmine' })).status, 400);

    // 紐づけ -> 上書き -> 解除。付与・解除とも履歴に残り、上書きは解除+付与の2件になる
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId, source: 'redmine', issueKey: '10', actor: 'kiro' })).status, 200);
    assert.deepEqual(await linkEvents(baseUrl, taskId), ['external_link_added Redmine #10 (kiro)']);

    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId, source: 'redmine', issueKey: '20' })).status, 200);
    assert.deepEqual(await linkEvents(baseUrl, taskId), [
      'external_link_added Redmine #10 (kiro)',
      'external_link_removed Redmine #10 (user)',
      'external_link_added Redmine #20 (user)',
    ]);

    const unlinked = await post(baseUrl, '/api/its-unlink-issue', { taskId, source: 'redmine', actor: 'claude-code' });
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
    assert.deepEqual(unlinked.body, { ok: true, source: 'redmine', issueKey: '20' });
    assert.deepEqual((await get(baseUrl, `/api/task/${taskId}`)).body.externalLinks, []);
    assert.deepEqual((await linkEvents(baseUrl, taskId)).slice(-1), ['external_link_removed Redmine #20 (claude-code)']);

    // 解除済みへの再解除は404で、履歴も増えない
    assert.equal((await post(baseUrl, '/api/its-unlink-issue', { taskId, source: 'redmine' })).status, 404);
    assert.equal((await linkEvents(baseUrl, taskId)).length, 4);

    // 解除後は同じチケットを再び紐づけられる
    assert.equal((await post(baseUrl, '/api/its-link-issue', { taskId, source: 'redmine', issueKey: '20' })).status, 200);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('setGithubLink / clearGithubLink record external link history and clear the columns (BT-470)', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-dashboard-test-'));
  const db = new DatabaseSync(path.join(directory, 'backlog.sqlite3'));
  try {
    createSchema(db);
    db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('test', 'TS', 1);
    const task = tasksRepo.create(db, { workspace: 'test', title: 't', status: 'todo' });
    const id = task.displayId || task.display_id || 'TS-001';
    const events = () => db.prepare(`SELECT event_type, old_value, new_value, actor FROM task_events
      WHERE task_display_id = ? AND event_type LIKE 'external_link_%' ORDER BY id`).all(id)
      .map((e) => `${e.event_type} ${e.new_value || e.old_value} (${e.actor})`);

    // 未紐づけの解除は何もしない
    assert.equal(tasksRepo.clearGithubLink(db, id), null);
    assert.deepEqual(events(), []);

    tasksRepo.setGithubLink(db, id, 12, 'https://github.com/o/r/issues/12', 'codex');
    assert.deepEqual(events(), ['external_link_added GitHub #12 (codex)']);
    const linked = tasksRepo.getByDisplayId(db, id);
    assert.equal(linked.github_issue_number, 12);
    assert.equal(linked.updated_by, 'codex');

    assert.equal(tasksRepo.clearGithubLink(db, id, 'claude-code'), 12);
    const cleared = tasksRepo.getByDisplayId(db, id);
    assert.equal(cleared.github_issue_number, null);
    assert.equal(cleared.github_issue_url, null);
    assert.deepEqual(events(), ['external_link_added GitHub #12 (codex)', 'external_link_removed GitHub #12 (claude-code)']);

    // 解除済みへの再解除は何もしない
    assert.equal(tasksRepo.clearGithubLink(db, id), null);
    assert.equal(events().length, 2);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
