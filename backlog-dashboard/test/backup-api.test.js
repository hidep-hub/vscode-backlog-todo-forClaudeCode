'use strict';

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

async function request(baseUrl, pathname, body, rawBody) {
  const options = rawBody !== undefined
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody }
    : body === undefined ? undefined
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { status: response.status, body: await response.json() };
}

test('backup APIs: 作成・一覧・状態・削除保護(BT-370)', async () => {
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
        if ((await request(baseUrl, '/api/health')).status === 200) break;
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 50));
      if (attempt === 29) throw new Error('test server did not start');
    }
    assert.equal((await request(baseUrl, '/api/create-workspace', { file: 'extra', prefix: 'EX', name: 'Extra' })).body.ok, true);
    const added = await request(baseUrl, '/api/add-task', { title: 'before backup', project: 'extra', status: 'todo' });
    assert.equal(added.body.ok, true, JSON.stringify(added.body));

    // 初期状態: 一覧は空、実行中ではない
    const empty = await request(baseUrl, '/api/backups');
    assert.deepEqual(empty.body.backups, []);
    assert.equal((await request(baseUrl, '/api/backup-status')).body.running, false);

    // 空ボディのPOSTでも実行できる。config.json はコピーされ、未作成のgithub-credentials.jsonはskipped
    const first = await request(baseUrl, '/api/backup', undefined, '');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.ok, true);
    assert.equal(first.body.integrity, 'ok');
    assert.equal(first.body.counts.tasks, 1);
    assert.ok(first.body.skipped.includes('backlog-dashboard/github-credentials.json'));
    const backupDir = path.join(dataDir, 'backups', first.body.file);
    assert.ok(fs.existsSync(path.join(backupDir, 'backlog.sqlite3')));
    assert.ok(fs.existsSync(path.join(backupDir, 'files', 'backlog-dashboard', 'config.json')));

    const listed = await request(baseUrl, '/api/backups');
    assert.equal(listed.body.backups.length, 1);
    assert.equal(listed.body.backups[0].file, first.body.file);
    assert.equal(listed.body.backups[0].counts.tasks, 1);
    const status = (await request(baseUrl, '/api/backup-status')).body;
    assert.equal(status.running, false);
    assert.equal(status.percent, 100);

    // 唯一(=最新)のバックアップは削除できない。不正名は400、存在しない名前は404
    assert.equal((await request(baseUrl, '/api/delete-backup', { file: first.body.file })).status, 409);
    assert.equal((await request(baseUrl, '/api/delete-backup', { file: '../data' })).status, 400);
    assert.equal((await request(baseUrl, '/api/delete-backup', { file: 'backlog-20200101-000000' })).status, 404);

    // 古い世代を人工的に作って削除できることを確認する
    const oldName = 'backlog-20200101-000000';
    fs.mkdirSync(path.join(dataDir, 'backups', oldName), { recursive: true });
    assert.equal((await request(baseUrl, '/api/delete-backup', { file: oldName, actor: 'tester' })).body.ok, true);
    assert.equal(fs.existsSync(path.join(dataDir, 'backups', oldName)), false);
    const logText = fs.readFileSync(path.join(dataDir, 'backups', 'backup.log'), 'utf8');
    assert.ok(logText.includes('"event":"delete"'));
  } finally {
    if (!child.killed) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
