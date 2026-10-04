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
    // BT-360: 作成エントリはsummaryを持ち、書込前にconfig.json.bakを残す
    const savedConfig = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'config.json'), 'utf8'));
    assert.equal(savedConfig.projects.find(p => p.file === 'extra').summary, '');
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'config.json.bak')), true);
    // 同じfile/prefixでの再作成は400で拒否される
    assert.equal((await request(baseUrl, '/api/create-workspace', { file: 'extra2', prefix: 'EX' })).status, 400);
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
    const board = (await request(baseUrl, '/api/board')).body;
    assert.ok(board.columns.length >= 4);
    // BM-020: ヘッダーティッカー用の直近イベントがboard broadcastに相乗りしていることを確認する
    assert.ok(Array.isArray(board.recentEvents));
    assert.ok(board.recentEvents.some(event => event.taskId === taskId));
    assert.ok((await request(baseUrl, '/api/activity')).body.some(event => event.taskId === taskId));
    assert.equal((await request(baseUrl, '/api/delete-task', { taskId })).body.ok, true);

    const epicCreated = await request(baseUrl, '/api/add-task', { title: 'Epic pin workflow', project: 'extra', status: 'todo' });
    assert.equal(epicCreated.body.ok, true, JSON.stringify(epicCreated.body));
    const epic = epicCreated.body.id;
    const childCreated = await request(baseUrl, '/api/add-task', { title: 'Epic child', project: 'extra', status: 'todo', parentId: epic });
    assert.equal(childCreated.body.ok, true, JSON.stringify(childCreated.body));
    const childTask = childCreated.body.id;
    const pinEpic = await request(baseUrl, '/api/toggle-today', { taskId: epic, value: true, actor: 'codex' });
    assert.equal(pinEpic.body.pinned, true, JSON.stringify(pinEpic.body));
    assert.deepEqual(pinEpic.body.affectedTaskIds, [childTask]);
    const epicDetail = await request(baseUrl, `/api/task/${epic}`);
    assert.equal(epicDetail.body.todayFlag, false);
    assert.equal(epicDetail.body.children[0].todayFlag, true);
    const unpinEpic = await request(baseUrl, '/api/toggle-today', { taskId: epic, value: false, actor: 'codex' });
    assert.equal(unpinEpic.body.pinned, false);
    assert.equal((await request(baseUrl, `/api/task/${childTask}`)).body.todayFlag, false);

    const parentCreated = await request(baseUrl, '/api/add-task', { title: 'Drop target', project: 'extra', status: 'ready' });
    const draggedCreated = await request(baseUrl, '/api/add-task', { title: 'Dragged task', project: 'extra', status: 'do' });
    assert.equal(parentCreated.body.ok, true);
    assert.equal(draggedCreated.body.ok, true);
    const attached = await request(baseUrl, '/api/attach-to-parent', {
      taskIds: [draggedCreated.body.id], parentId: parentCreated.body.id,
    });
    assert.equal(attached.body.ok, true, JSON.stringify(attached.body));
    const draggedDetail = await request(baseUrl, `/api/task/${draggedCreated.body.id}`);
    assert.equal(draggedDetail.body.statusCode, 'do');
    const parentDetail = await request(baseUrl, `/api/task/${parentCreated.body.id}`);
    assert.deepEqual(parentDetail.body.children.map(child => child.id), [draggedCreated.body.id]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
