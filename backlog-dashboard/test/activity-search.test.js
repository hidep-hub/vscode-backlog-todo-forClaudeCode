'use strict';

// BT-408: GET /api/activity のDB側絞り込み(buildActivity の q / tagId)を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createSchema } = require('../db/schema');
const tasksRepo = require('../db/tasks-repo');
const tagsRepo = require('../db/tags-repo');
const { buildActivity } = require('../db/activity');

const CONFIG = { projects: [{ file: 'test', prefix: 'TS', name: 'Test' }] };

function createTestDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-activity-search-'));
  const db = new DatabaseSync(path.join(directory, 'backlog.sqlite3'));
  createSchema(db);
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)').run('test', 'TS', 1);
  return { db, directory };
}

function ids(events) {
  return [...new Set(events.map(e => e.taskId))].sort();
}

test('q and tagId narrow the activity events in the DB, including description, parent EPIC and deleted tasks', () => {
  const { db, directory } = createTestDb();
  try {
    const epic = tasksRepo.create(db, { workspace: 'test', title: 'ガント改善EPIC', status: 'todo' });
    const child = tasksRepo.create(db, { workspace: 'test', title: '描画の修正', status: 'todo', parentDisplayId: epic.display_id });
    const described = tasksRepo.create(db, {
      workspace: 'test', title: '無関係なタイトル', status: 'todo', description: '調査メモ: 100%再現する_バグ',
    });
    const other = tasksRepo.create(db, { workspace: 'test', title: 'Another Task', status: 'todo' });
    tasksRepo.updateStatus(db, other.display_id, 'do', 'user');

    const tag = tagsRepo.createTag(db, { workspace: 'test', name: 'バグ' });
    tagsRepo.updateTaskTags(db, described.display_id, { add: [tag.id] }, 'user');
    tagsRepo.updateTaskTags(db, other.display_id, { add: [tag.id] }, 'user');

    // フィルタなしは全件(後方互換)
    assert.deepEqual(ids(buildActivity(db, CONFIG)), [child.display_id, described.display_id, epic.display_id, other.display_id].sort());
    assert.deepEqual(ids(buildActivity(db, CONFIG, {})), ids(buildActivity(db, CONFIG)));
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: '   ' })), ids(buildActivity(db, CONFIG)));

    // タイトル(大文字小文字を区別しない)・表示ID
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: 'another' })), [other.display_id]);
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: child.display_id })), [child.display_id]);

    // 説明文(クライアントが持たない情報)。1〜2文字でも部分一致する
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: '調査メモ' })), [described.display_id]);
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: '再現' })), [described.display_id]);

    // ヒット箇所(matchedIn)と説明文の抜粋は、qを指定した時だけ付く
    assert.equal('matchedIn' in buildActivity(db, CONFIG)[0], false);
    const byDescription = buildActivity(db, CONFIG, { q: '再現' });
    assert.ok(byDescription.every(e => e.matchedIn.includes('description') && !e.matchedIn.includes('title')));
    assert.ok(byDescription.every(e => e.descriptionSnippet === '調査メモ: 100%再現する_バグ'));
    assert.ok(buildActivity(db, CONFIG, { q: 'another' }).every(e => e.matchedIn.includes('title')));
    assert.ok(buildActivity(db, CONFIG, { q: 'another' }).every(e => e.descriptionSnippet === null));
    assert.ok(buildActivity(db, CONFIG, { q: 'ガント改善' }).filter(e => e.taskId === child.display_id).every(e => e.matchedIn.includes('parent')));
    assert.ok(buildActivity(db, CONFIG, { q: 'do' }).some(e => e.matchedIn.includes('value')));

    // LIKEのワイルドカード文字はリテラルとして扱う
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: '100%' })), [described.display_id]);
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: '現する_' })), [described.display_id]);
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: '%' })), [described.display_id]);

    // 親EPICで探すと、EPIC自身と配下の子タスクのイベントが出る
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: 'ガント改善' })), [child.display_id, epic.display_id].sort());

    // イベントの値(ステータス遷移・タグ名)
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: 'do' })), [other.display_id]);
    assert.ok(buildActivity(db, CONFIG, { q: 'バグ' }).some(e => e.eventType === 'tag_added'));

    // タグ: そのタグが付いたタスクのイベントだけ
    assert.deepEqual(ids(buildActivity(db, CONFIG, { tagId: tag.id })), [described.display_id, other.display_id].sort());
    assert.deepEqual(buildActivity(db, CONFIG, { tagId: 999999 }), []);

    // q と tagId はAND条件
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: 'another', tagId: tag.id })), [other.display_id]);
    assert.deepEqual(buildActivity(db, CONFIG, { q: 'ガント', tagId: tag.id }), []);

    // 論理削除したタスクの履歴も、キーワード・タグの両方で探せる
    tasksRepo.softDelete(db, other.display_id);
    assert.deepEqual(ids(buildActivity(db, CONFIG, { q: 'another' })), [other.display_id]);
    assert.deepEqual(ids(buildActivity(db, CONFIG, { tagId: tag.id })), [described.display_id, other.display_id].sort());
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('GET /api/activity accepts q and tagId query parameters and rejects an invalid tagId', async () => {
  const sourceRoot = path.resolve(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.api-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const port = await unusedPort();
  const config = {
    port, backlogDir: dataDir, defaultWorkspaceParent: fixtureRoot,
    columns: [{ id: 'todo', label: 'TODO', match: ['todo'] }, { id: 'done', label: 'DONE', match: ['done'] }],
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
  const post = async (pathname, body) => (await fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const get = async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`);
    return { status: response.status, body: await response.json() };
  };

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { if ((await get('/api/health')).status === 200) break; } catch { /* wait for startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (attempt === 59) throw new Error('test server did not start');
    }
    assert.equal((await post('/api/create-workspace', { file: 'extra', prefix: 'EX', name: 'Extra' })).ok, true);
    const a = await post('/api/add-task', { title: 'alpha search target', project: 'extra', status: 'todo', description: 'needle in body' });
    const b = await post('/api/add-task', { title: 'beta', project: 'extra', status: 'todo' });
    const created = await post('/api/create-tag', { workspace: 'extra', name: 'Marker' });
    assert.ok(created.tag, JSON.stringify(created));
    const tagId = created.tag.id;
    assert.equal((await post('/api/update-task-tags', { taskId: a.id, add: [tagId] })).ok !== false, true);

    const all = (await get('/api/activity')).body;
    assert.deepEqual([...new Set(all.map(e => e.taskId))].sort(), [a.id, b.id].sort());
    assert.deepEqual([...new Set((await get('/api/activity?q=needle')).body.map(e => e.taskId))], [a.id]);
    assert.deepEqual([...new Set((await get('/api/activity?q=' + encodeURIComponent('BETA'))).body.map(e => e.taskId))], [b.id]);
    assert.deepEqual([...new Set((await get(`/api/activity?tagId=${tagId}`)).body.map(e => e.taskId))], [a.id]);
    assert.deepEqual((await get(`/api/activity?q=beta&tagId=${tagId}`)).body, []);
    assert.equal((await get('/api/activity?tagId=abc')).status, 400);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('description snippet keeps about 30 characters around the hit and marks truncation', () => {
  const { db, directory } = createTestDb();
  try {
    const long = `${'あ'.repeat(50)}検索語${'い'.repeat(50)}`;
    const task = tasksRepo.create(db, { workspace: 'test', title: 'long', status: 'todo', description: long });
    const [event] = buildActivity(db, CONFIG, { q: '検索語' }).filter(e => e.taskId === task.display_id);
    assert.equal(event.descriptionSnippet, `…${'あ'.repeat(30)}検索語${'い'.repeat(30)}…`);
    const short = tasksRepo.create(db, { workspace: 'test', title: 'short', status: 'todo', description: '前置き\n検索語\n後書き' });
    const [shortEvent] = buildActivity(db, CONFIG, { q: '検索語' }).filter(e => e.taskId === short.display_id);
    assert.equal(shortEvent.descriptionSnippet, '前置き 検索語 後書き');
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
