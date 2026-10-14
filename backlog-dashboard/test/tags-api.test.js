'use strict';

// BT-393: タグAPI(HTTP)を実サーバーで検証する。api-workflow.test.jsと同じフィクスチャ方式。

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

test('serves tag management and tagging through the REST API', async () => {
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
  for (const entry of ['server.js', 'tags-api.js', 'its-settings-api.js', 'its-credentials.js', 'github-client.js', 'package.json']) {
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

    const created = await request(baseUrl, '/api/create-tag', { workspace: 'extra', name: 'ガントチャート', color: '#336699' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const tagId = created.body.tag.id;

    // 重複(表記ゆれ含む)は409 duplicate_tag、似た名前は409 similar_tags、confirmSimilarで作成できる
    const dup = await request(baseUrl, '/api/create-tag', { workspace: 'extra', name: 'ガントチャート ' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'duplicate_tag');
    assert.equal(dup.body.existing.id, tagId);
    const similar = await request(baseUrl, '/api/create-tag', { workspace: 'extra', name: 'ガント' });
    assert.equal(similar.status, 409);
    assert.equal(similar.body.error, 'similar_tags');
    assert.deepEqual(similar.body.similar.map(t => t.id), [tagId]);
    const preview = await (await fetch(`${baseUrl}/api/tags/similar?workspace=extra&name=${encodeURIComponent('ガント')}`)).json();
    assert.deepEqual(preview.similar.map(t => t.id), [tagId]);
    const second = await request(baseUrl, '/api/create-tag', { workspace: 'extra', name: 'ガント', confirmSimilar: true });
    assert.equal(second.status, 200);

    assert.equal((await request(baseUrl, '/api/create-tag', { workspace: 'extra', name: '  ' })).status, 400);
    assert.equal((await request(baseUrl, '/api/create-tag', { workspace: 'nope', name: 'x' })).status, 400);
    assert.equal((await request(baseUrl, '/api/create-tag', undefined, '{broken')).status, 400);

    const task = await request(baseUrl, '/api/add-task', { title: 'tag target', project: 'extra', status: 'todo' });
    const taskId = task.body.id;
    const attached = await request(baseUrl, '/api/update-task-tags', { taskId, add: [tagId], actor: 'claude-code' });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    assert.deepEqual(attached.body.tags.map(t => t.name), ['ガントチャート']);
    assert.equal((await request(baseUrl, '/api/update-task-tags', { taskId, add: [9999] })).status, 404);
    assert.equal((await request(baseUrl, '/api/update-task-tags', { taskId, add: 'x' })).status, 400);
    assert.equal((await request(baseUrl, '/api/update-task-tags', { taskId: 'TS-999', add: [tagId] })).status, 404);

    const detail = await (await fetch(`${baseUrl}/api/task/${taskId}`)).json();
    assert.deepEqual(detail.tags.map(t => t.id), [tagId]);
    const board = await (await fetch(`${baseUrl}/api/board`)).json();
    const onBoard = board.columns.flatMap(c => c.items).find(i => i.id === taskId);
    assert.deepEqual(onBoard.tags.map(t => t.id), [tagId]);

    const list = await (await fetch(`${baseUrl}/api/tags?workspace=extra`)).json();
    assert.deepEqual(list.tags.map(t => [t.name, t.usageCount]), [['ガントチャート', 1], ['ガント', 0]]);

    const renamed = await request(baseUrl, '/api/update-tag', { tagId, name: 'Gantt', color: '#000000' });
    assert.equal(renamed.body.tag.name, 'Gantt');
    assert.equal((await request(baseUrl, '/api/update-tag', { tagId: second.body.tag.id, name: 'gantt' })).status, 409);

    const merged = await request(baseUrl, '/api/merge-tags', { sourceId: second.body.tag.id, targetId: tagId });
    assert.deepEqual([merged.status, merged.body.mergedTasks], [200, 0]);
    assert.equal((await request(baseUrl, '/api/merge-tags', { sourceId: tagId, targetId: tagId })).status, 400);

    const activity = await (await fetch(`${baseUrl}/api/activity`)).json();
    assert.ok(activity.some(e => e.taskId === taskId && e.eventType === 'tag_added' && e.newValue === 'ガントチャート' && e.actor === 'claude-code'));

    const removed = await request(baseUrl, '/api/delete-tag', { tagId });
    assert.deepEqual([removed.status, removed.body.removedFromTasks], [200, 1]);
    assert.equal((await request(baseUrl, '/api/delete-tag', { tagId })).status, 404);
    assert.deepEqual((await (await fetch(`${baseUrl}/api/task/${taskId}`)).json()).tags, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
