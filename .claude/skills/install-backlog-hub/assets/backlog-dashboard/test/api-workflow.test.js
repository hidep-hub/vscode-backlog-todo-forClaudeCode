'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
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

async function request(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('serves the core task workflow through the REST API', async () => {
  const sourceRoot = path.resolve(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.api-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const port = await unusedPort();
  const config = {
    port, backlogDir: dataDir, defaultWorkspaceParent: fixtureRoot,
    columns: [
      { id: 'do', label: 'DO', match: ['do'] },
      { id: 'ready', label: 'READY', match: ['ready'] },
      { id: 'todo', label: 'TODO', match: ['todo'] },
      { id: 'done', label: 'DONE', match: ['done'] },
    ],
    projects: [{ file: 'test', prefix: 'TS', name: 'Test', workspace: fixtureRoot }],
  };
  fs.mkdirSync(dataDir, { recursive: true });
  for (const entry of ['server.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify(config), 'utf8');
  const child = spawn(process.execPath, ['server.js'], { cwd: fixtureRoot, stdio: 'ignore' });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const health = await request(baseUrl, '/api/health');
        if (health.status === 200) break;
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 50));
      if (attempt === 29) throw new Error('test server did not start');
    }
    assert.equal((await request(baseUrl, '/api/create-workspace', { file: 'extra', prefix: 'EX', name: 'Extra' })).body.ok, true);
    const added = await request(baseUrl, '/api/add-task', { title: 'API workflow', project: 'extra', status: 'todo' });
    assert.equal(added.body.ok, true);
    const taskId = added.body.id;
    assert.equal((await request(baseUrl, '/api/update-task', { taskId, description: 'verified', artifacts: ['docs/result.txt'] })).body.ok, true);
    assert.equal((await request(baseUrl, '/api/toggle-today', { taskId, value: true, actor: 'codex' })).body.pinned, true);
    assert.equal((await request(baseUrl, '/api/toggle-running', { taskId, value: true, actor: 'codex' })).body.running, true);
    assert.equal((await request(baseUrl, '/api/update-status', { taskId, newStatus: 'done', actor: 'codex' })).body.ok, true);
    const detail = await request(baseUrl, `/api/task/${taskId}`);
    assert.equal(detail.body.statusCode, 'done');
    assert.deepEqual(detail.body.artifacts, ['docs/result.txt']);
    assert.ok((await request(baseUrl, '/api/board')).body.columns.length >= 4);
    assert.ok((await request(baseUrl, '/api/activity')).body.some(event => event.taskId === taskId));
    assert.equal((await request(baseUrl, '/api/delete-task', { taskId })).body.ok, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
