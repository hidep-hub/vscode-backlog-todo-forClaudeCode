'use strict';

// BM-071: 外部ITS(Redmine/GitLab)連携の設定API(HTTP)を実サーバーで検証する。
// tags-api.test.jsと同じフィクスチャ方式。

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('serves its-settings and its-host-status through the REST API', async () => {
  const sourceRoot = path.resolve(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.api-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const port = await unusedPort();
  const config = {
    port, backlogDir: dataDir, defaultWorkspaceParent: fixtureRoot,
    columns: [
      { id: 'todo', label: 'TODO', match: ['todo'] },
      { id: 'done', label: 'DONE', match: ['done'] },
    ],
    projects: [{ file: 'test', prefix: 'TS', name: 'Test', workspace: fixtureRoot }],
  };
  fs.mkdirSync(dataDir, { recursive: true });
  for (const entry of ['server.js', 'tags-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'rules-sync-api.js', 'redmine-client.js', 'gitlab-client.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify(config), 'utf8');
  const child = spawn(process.execPath, ['server.js'], { cwd: fixtureRoot, stdio: 'ignore' });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        if ((await get(baseUrl, '/api/health')).status === 200) break;
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (attempt === 59) throw new Error('test server did not start');
    }

    // 未設定時: github/redmine/gitlabいずれもconfigured:false
    const initial = await get(baseUrl, '/api/its-settings?prefix=TS');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.github.configured, false);
    assert.equal(initial.body.redmine.configured, false);
    assert.equal(initial.body.gitlab.configured, false);

    // prefix未指定は400、未知のprefixは404
    assert.equal((await get(baseUrl, '/api/its-settings')).status, 400);
    assert.equal((await get(baseUrl, '/api/its-settings?prefix=ZZ')).status, 404);

    // 不正なURLは400で保存されない
    const badUrl = await post(baseUrl, '/api/its-settings', { prefix: 'TS', source: 'redmine', projectUrl: 'not-a-url' });
    assert.equal(badUrl.status, 400);

    // 正常保存 -> configured:trueになり、トークン値はレスポンスに含まれない
    const saved = await post(baseUrl, '/api/its-settings', {
      prefix: 'TS', source: 'redmine', projectUrl: 'http://host.example.com/redmine/projects/sample', token: 'secret-key',
    });
    assert.equal(saved.body.ok, true);
    const afterSave = await get(baseUrl, '/api/its-settings?prefix=TS');
    assert.equal(afterSave.body.redmine.configured, true);
    assert.equal(afterSave.body.redmine.hasToken, true);
    assert.equal(JSON.stringify(afterSave.body).includes('secret-key'), false);

    // its-host-status: 保存済みホストのURL(別プロジェクト)でもhasToken:trueになる
    const hostStatus = await get(baseUrl, `/api/its-host-status?source=redmine&url=${encodeURIComponent('http://host.example.com/redmine/projects/other')}`);
    assert.equal(hostStatus.body.valid, true);
    assert.equal(hostStatus.body.hasToken, true);

    // sourceが不正なら400
    assert.equal((await post(baseUrl, '/api/its-settings', { prefix: 'TS', source: 'bogus', projectUrl: 'x' })).status, 400);
    assert.equal((await get(baseUrl, '/api/its-host-status?source=bogus&url=x')).status, 400);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
