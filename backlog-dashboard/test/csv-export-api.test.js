'use strict';

// BT-412: GET /api/export-csv を実サーバーで検証する(ダウンロードヘッダ・絞り込み・不正workspace)。

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

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('serves the task CSV as a download and validates the workspace', async () => {
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
  for (const entry of ['server.js', 'tags-api.js', 'categories-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'rules-sync-api.js', 'redmine-client.js', 'gitlab-client.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify(config), 'utf8');
  const child = spawn(process.execPath, ['server.js'], { cwd: fixtureRoot, stdio: 'ignore' });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        if ((await fetch(`${baseUrl}/api/health`)).status === 200) break;
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (attempt === 59) throw new Error('test server did not start');
    }

    assert.equal((await postJson(baseUrl, '/api/create-workspace', { file: 'extra', prefix: 'EX', name: 'Extra' })).body.ok, true);
    assert.equal((await postJson(baseUrl, '/api/add-task', { title: 'csv target', project: 'extra', status: 'todo' })).body.ok, true);

    const response = await fetch(`${baseUrl}/api/export-csv?workspace=extra`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.match(response.headers.get('content-disposition'), /^attachment; filename="backlog-extra-\d{8}-\d{6}\.csv"$/);
    assert.equal(response.headers.get('x-export-row-count'), '1');
    const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
    assert.ok(text.startsWith('﻿workspace,id,parent_id,'));
    assert.ok(text.includes('extra,EX-001,,single,1,csv target,todo'));

    const all = await fetch(`${baseUrl}/api/export-csv`);
    assert.equal(all.status, 200);
    assert.match(all.headers.get('content-disposition'), /filename="backlog-all-/);

    const bad = await fetch(`${baseUrl}/api/export-csv?workspace=nope`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'unknown_workspace');
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
