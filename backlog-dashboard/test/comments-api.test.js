
// BM-136: タスクコメントAPI(HTTP)を実サーバーで検証する。tags-api.test.jsと同じフィクスチャ方式。

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
  const response = await fetch(`${baseUrl}${pathname}`, body === undefined && rawBody === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody !== undefined ? rawBody : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('adds, lists and deletes task comments through the REST API without touching history or updatedBy', async () => {
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
  for (const entry of ['server.js', 'tags-api.js', 'comments-api.js', 'categories-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'its-link-api.js', 'rules-sync-api.js', 'recent-commits-api.js', 'redmine-client.js', 'gitlab-client.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify(config), 'utf8');
  const child = spawn(process.execPath, ['server.js'], { cwd: fixtureRoot, stdio: 'ignore' });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        if ((await request(baseUrl, '/api/health')).status === 200) break;
      } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (attempt === 59) throw new Error('test server did not start');
    }

    assert.equal((await request(baseUrl, '/api/create-workspace', { file: 'extra', prefix: 'EX', name: 'Extra' })).body.ok, true);
    const task = await request(baseUrl, '/api/add-task', { title: 'comment target', project: 'extra', status: 'todo' });
    const taskId = task.body.id;
    assert.match(taskId, /^EX-\d+$/, JSON.stringify(task.body));
    const before = await (await fetch(`${baseUrl}/api/task/${taskId}`)).json();
    assert.equal(before.commentCount, 0);
    assert.deepEqual(before.comments, []);

    // 日本語本文とactorが保存され、件数が返る
    const first = await request(baseUrl, '/api/add-task-comment', { taskId, body: '検証機で再現できた', actor: 'claude-code' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.comment.body, '検証機で再現できた');
    assert.equal(first.body.comment.createdBy, 'claude-code');
    assert.equal(first.body.commentCount, 1);
    const second = await request(baseUrl, '/api/add-task-comment', { taskId, body: '方針に合意した' });
    assert.equal(second.body.comment.createdBy, 'user');
    assert.equal(second.body.commentCount, 2);

    // 入力検証: 空本文・欠落・非文字列は400、存在しないタスクは404、壊れたJSONは400
    assert.equal((await request(baseUrl, '/api/add-task-comment', { taskId, body: '   ' })).body.error, 'invalid_body');
    assert.equal((await request(baseUrl, '/api/add-task-comment', { taskId, body: 'x'.repeat(1001) })).status, 400);
    assert.equal((await request(baseUrl, '/api/add-task-comment', { body: 'x' })).status, 400);
    assert.equal((await request(baseUrl, '/api/add-task-comment', { taskId: 'EX-999', body: 'x' })).status, 404);
    assert.equal((await request(baseUrl, '/api/add-task-comment', undefined, '{broken')).status, 400);

    // GET: 新しい順の全件
    const listed = await (await fetch(`${baseUrl}/api/task-comments?taskId=${taskId}`)).json();
    assert.deepEqual(listed.comments.map(c => c.body), ['方針に合意した', '検証機で再現できた']);
    assert.equal((await fetch(`${baseUrl}/api/task-comments`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/task-comments?taskId=EX-999`)).status, 404);

    // board・詳細への反映: boardは件数と最新1件、詳細は全件
    const board = await (await fetch(`${baseUrl}/api/board`)).json();
    const onBoard = board.columns.flatMap(c => c.items).find(i => i.id === taskId);
    assert.equal(onBoard.commentCount, 2);
    assert.equal(onBoard.latestComment.body, '方針に合意した');
    assert.equal(onBoard.comments, undefined);
    const detail = await (await fetch(`${baseUrl}/api/task/${taskId}`)).json();
    assert.deepEqual(detail.comments.map(c => c.body), ['方針に合意した', '検証機で再現できた']);

    // サイレント: 履歴に出ず、更新者もコメント投稿者に書き換わらない
    const activity = await (await fetch(`${baseUrl}/api/activity`)).json();
    assert.ok(!activity.some(e => e.taskId === taskId && /comment/i.test(e.eventType)));
    assert.equal(detail.updatedBy, before.updatedBy);
    assert.equal(detail.updatedAt, before.updatedAt);

    // 削除: 誤入力の取り消し。存在しないID・整数以外は拒否
    const removed = await request(baseUrl, '/api/delete-task-comment', { commentId: first.body.comment.id });
    assert.deepEqual([removed.status, removed.body.taskId, removed.body.commentCount], [200, taskId, 1]);
    assert.equal((await request(baseUrl, '/api/delete-task-comment', { commentId: first.body.comment.id })).status, 404);
    assert.equal((await request(baseUrl, '/api/delete-task-comment', { commentId: 'x' })).status, 400);
    const afterDelete = await (await fetch(`${baseUrl}/api/task/${taskId}`)).json();
    assert.deepEqual(afterDelete.comments.map(c => c.body), ['方針に合意した']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
