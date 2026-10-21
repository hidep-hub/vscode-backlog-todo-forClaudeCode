'use strict';

// BM-105: カテゴリAPI(HTTP)を実サーバーで検証する。tags-api.test.jsと同じフィクスチャ方式だが、
// カテゴリは「システムで一意」(ヒデさんの運用認識)のためワークスペースパラメータを持たない。
// 加えてadd-task/update-taskのcategory統合(マスタ存在チェック、ワークスペース横断)もここで検証する。

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

test('serves category management (system-wide, no workspace scoping) and task category resolution through the REST API', async () => {
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
  for (const entry of ['server.js', 'tags-api.js', 'categories-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'its-link-api.js', 'rules-sync-api.js', 'recent-commits-api.js', 'redmine-client.js', 'gitlab-client.js', 'github-client.js', 'package.json']) {
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
    assert.equal((await request(baseUrl, '/api/create-workspace', { file: 'another', prefix: 'AN', name: 'Another' })).body.ok, true);

    const created = await request(baseUrl, '/api/create-category', { name: 'インフラ', color: '#336699' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const categoryId = created.body.category.id;

    // 重複(表記ゆれ含む)は409 duplicate_category、似た名前は409 similar_categories、confirmSimilarで作成できる
    const dup = await request(baseUrl, '/api/create-category', { name: 'インフラ ' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'duplicate_category');
    assert.equal(dup.body.existing.id, categoryId);
    const similar = await request(baseUrl, '/api/create-category', { name: 'インフ' });
    assert.equal(similar.status, 409);
    assert.equal(similar.body.error, 'similar_categories');
    const preview = await (await fetch(`${baseUrl}/api/categories/similar?name=${encodeURIComponent('インフ')}`)).json();
    assert.deepEqual(preview.similar.map(c => c.id), [categoryId]);

    assert.equal((await request(baseUrl, '/api/create-category', { name: '  ' })).status, 400);
    assert.equal((await request(baseUrl, '/api/create-category', undefined, '{broken')).status, 400);

    // add-task: マスタに登録済みの名前は通る(表記ゆれもマスタの表記に正規化される)。ワークスペースを問わない
    const task = await request(baseUrl, '/api/add-task', { title: 'cat target', project: 'extra', status: 'todo', category: 'インフラ' });
    assert.equal(task.status, 200, JSON.stringify(task.body));
    const taskId = task.body.id;
    const detail = await (await fetch(`${baseUrl}/api/task/${taskId}`)).json();
    assert.equal(detail.category, 'インフラ');

    // 別ワークスペースでも同じカテゴリ名を使える(システム全体で一意なため)
    const taskOther = await request(baseUrl, '/api/add-task', { title: 'cat target 2', project: 'another', status: 'todo', category: 'インフラ' });
    assert.equal(taskOther.status, 200, JSON.stringify(taskOther.body));

    // add-task: マスタに無い名前はunknown_categoryで拒否される
    const rejected = await request(baseUrl, '/api/add-task', { title: 'bad cat', project: 'extra', status: 'todo', category: '存在しない' });
    assert.equal(rejected.status, 400);

    // update-task: 既存タスクのcategoryをマスタ内の別名へ変更できる。空文字で解除できる
    const another = await request(baseUrl, '/api/create-category', { name: 'バックエンド' });
    const updated = await request(baseUrl, '/api/update-task', { taskId, category: 'バックエンド' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((await (await fetch(`${baseUrl}/api/task/${taskId}`)).json()).category, 'バックエンド');
    const cleared = await request(baseUrl, '/api/update-task', { taskId, category: '' });
    assert.equal(cleared.status, 200);
    assert.equal((await (await fetch(`${baseUrl}/api/task/${taskId}`)).json()).category, '-');
    const updateRejected = await request(baseUrl, '/api/update-task', { taskId, category: '存在しない' });
    assert.equal(updateRejected.status, 400);

    // 一覧取得はワークスペースパラメータを持たず、常に全体の一覧を返す
    const list = await (await fetch(`${baseUrl}/api/categories`)).json();
    assert.deepEqual(list.categories.map(c => c.name).sort(), ['インフラ', 'バックエンド'].sort());

    const renamed = await request(baseUrl, '/api/update-category', { categoryId: another.body.category.id, name: 'Backend', color: '#000000' });
    assert.equal(renamed.body.category.name, 'Backend');
    assert.equal((await request(baseUrl, '/api/update-category', { categoryId, name: 'backend' })).status, 409);

    // 改名は別ワークスペース(another)のタスクにも反映される(システム全体で一意なため)
    assert.equal((await (await fetch(`${baseUrl}/api/task/${taskOther.body.id}`)).json()).category, 'インフラ');

    // 並べ替え(BM-112): システム全体で一意なためワークスペース指定は不要。既存の全件を対象に
    // 並べ替えないと、対象外の行のsort_orderが更新されず名前キーでタイブレークされてしまうため、
    // 現存する全カテゴリ(categoryId, another.body.category.id)を含めて検証する
    const third = await request(baseUrl, '/api/create-category', { name: 'セキュリティ' });
    const thirdId = third.body.category.id;
    const beforeOrder = (await (await fetch(`${baseUrl}/api/categories`)).json()).categories.map(c => c.id);
    const reordered = await request(baseUrl, '/api/reorder-categories', { orderedIds: [thirdId, categoryId, another.body.category.id], actor: 'claude-code' });
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    const afterOrder = (await (await fetch(`${baseUrl}/api/categories`)).json()).categories.map(c => c.id);
    assert.notDeepEqual(afterOrder, beforeOrder);
    assert.deepEqual(afterOrder, [thirdId, categoryId, another.body.category.id]);
    assert.equal((await request(baseUrl, '/api/reorder-categories', { orderedIds: [thirdId] })).status, 400);

    const removed = await request(baseUrl, '/api/delete-category', { categoryId });
    assert.equal(removed.status, 200);
    assert.equal((await request(baseUrl, '/api/delete-category', { categoryId })).status, 404);
    // 削除も別ワークスペースのタスクに反映される
    assert.equal((await (await fetch(`${baseUrl}/api/task/${taskOther.body.id}`)).json()).category, '-');

    const activity = await (await fetch(`${baseUrl}/api/activity`)).json();
    assert.ok(activity.some(e => e.taskId === taskId && e.eventType === 'category_changed'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
