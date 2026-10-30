'use strict';

// BM-158: 1つのGitHub Issueを複数タスクで共有できること(紐づけ時の確認、完了時のclose判定)を実サーバーで検証する。
// GitHub APIのホストは固定(api.github.com)なので、子プロセスのサーバーに --require でスタブを差し込み、
// https.request を横取りして「呼ばれたAPI」をログファイルへ記録する(実ネットワークには出ない)。
// テストの骨格はits-link-api.test.jsと同じ(フィクスチャ作成→子プロセスでserver.js起動→fetchで叩く)。

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

// 子プロセスのサーバーに読み込ませるスタブ。api.github.com宛のhttps.requestだけを横取りし、
// 呼び出し(method/path/body)を1行1JSONでログへ追記して、決め打ちの成功応答を返す。
const GITHUB_STUB_SOURCE = `
const https = require('https');
const fs = require('fs');
const { EventEmitter } = require('events');
const realRequest = https.request;
https.request = function (options, callback) {
  if (!options || options.hostname !== 'api.github.com') return realRequest.apply(this, arguments);
  const req = new EventEmitter();
  let payload = '';
  req.write = (chunk) => { payload += chunk; };
  req.end = () => {
    fs.appendFileSync(process.env.GITHUB_STUB_LOG, JSON.stringify({
      method: options.method, path: options.path, body: payload ? JSON.parse(payload) : null,
    }) + '\\n');
    const m = /\\/issues\\/(\\d+)$/.exec(options.path);
    let body = {};
    if (options.method === 'GET' && m) body = { number: Number(m[1]), html_url: 'https://github.com/owner/repo/issues/' + m[1] };
    const res = new EventEmitter();
    res.statusCode = options.method === 'POST' ? 201 : 200;
    res.setEncoding = () => {};
    setImmediate(() => { callback(res); res.emit('data', JSON.stringify(body)); res.emit('end'); });
  };
  return req;
};
`;

async function waitFor(predicate, description, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('GitHub issue shared by several tasks: link asks first, and the issue closes only when every linked task is done (BM-158)', async () => {
  const sourceRoot = path.resolve(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.api-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const port = await unusedPort();
  const stubLog = path.join(fixtureRoot, 'github-calls.log');
  const stubPath = path.join(fixtureRoot, 'github-https-stub.js');

  const config = {
    port, backlogDir: dataDir, defaultWorkspaceParent: fixtureRoot,
    columns: [
      { id: 'todo', label: 'TODO', match: ['todo'] },
      { id: 'done', label: 'DONE', match: ['done'] },
    ],
    projects: [],
  };
  fs.mkdirSync(dataDir, { recursive: true });
  for (const entry of ['server.js', 'tags-api.js', 'comments-api.js', 'categories-api.js', 'its-settings-api.js', 'its-credentials.js', 'its-import-api.js', 'its-link-api.js', 'rules-sync-api.js', 'recent-commits-api.js', 'redmine-client.js', 'gitlab-client.js', 'github-client.js', 'package.json']) {
    fs.copyFileSync(path.join(sourceRoot, entry), path.join(fixtureRoot, entry));
  }
  fs.cpSync(path.join(sourceRoot, 'db'), path.join(fixtureRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'config.json'), JSON.stringify(config), 'utf8');
  fs.writeFileSync(path.join(fixtureRoot, 'github-credentials.json'), JSON.stringify({
    TS: { repoUrl: 'https://github.com/owner/repo', token: 'mock-token' },
  }), 'utf8');
  fs.writeFileSync(stubPath, GITHUB_STUB_SOURCE, 'utf8');
  fs.writeFileSync(stubLog, '', 'utf8');

  const calls = () => fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const callsFor = (method, issueNumber, suffix = '') => calls().filter(c => c.method === method
    && c.path === `/repos/owner/repo/issues/${issueNumber}${suffix}`);

  const child = spawn(process.execPath, ['--require', stubPath, 'server.js'], {
    cwd: fixtureRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GITHUB_STUB_LOG: stubLog },
  });
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
      if (attempt === 99) throw new Error('test server did not start. exitCode=' + child.exitCode + ' signalCode=' + child.signalCode + '\n' + serverOutput);
    }

    const createdWs = await post(baseUrl, '/api/create-workspace', { file: 'test', prefix: 'TS', name: 'Test' });
    assert.equal(createdWs.body.ok, true, JSON.stringify(createdWs.body));
    const addTask = async (title) => {
      const r = await post(baseUrl, '/api/add-task', { title, project: 'test', status: 'todo' });
      assert.equal(r.body.ok, true, JSON.stringify(r.body));
      return r.body.id;
    };
    const taskA = await addTask('タスクA');
    const taskB = await addTask('タスクB');
    const taskC = await addTask('タスクC(単独)');
    const taskD = await addTask('タスクD');
    const taskE = await addTask('タスクE(削除する)');
    const githubNumberOf = async (id) => (await get(baseUrl, `/api/task/${id}`)).body.githubIssueNumber;

    // --- 紐づけ: 最初の1件は確認なし ---
    const first = await post(baseUrl, '/api/github-link-issue', { taskId: taskA, issueNumber: '#7' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.issueNumber, 7);
    assert.deepEqual(first.body.sharedWith, []);
    assert.equal(await githubNumberOf(taskA), 7);

    // --- 紐づけ: すでに他タスクに紐づくIssueは409で確認を求め、何も保存せずGitHubも呼ばない ---
    const callsBefore = calls().length;
    const ask = await post(baseUrl, '/api/github-link-issue', { taskId: taskB, issueNumber: '7' });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.error, 'already_linked');
    assert.deepEqual(ask.body.linkedTaskIds, [taskA]);
    assert.equal(await githubNumberOf(taskB), null);
    for (const allowShared of [false, 'true', 1]) {
      const notConfirmed = await post(baseUrl, '/api/github-link-issue', { taskId: taskB, issueNumber: '7', allowShared });
      assert.equal(notConfirmed.status, 409, `allowShared=${JSON.stringify(allowShared)}`);
    }
    assert.equal(calls().length, callsBefore, 'a refused link must not call GitHub');

    // --- 紐づけ: allowShared:true で再送すると共有できる ---
    const shared = await post(baseUrl, '/api/github-link-issue', { taskId: taskB, issueNumber: '7', allowShared: true });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.sharedWith, [taskA]);
    assert.equal(await githubNumberOf(taskB), 7);

    // --- プレビュー相当: 同じ番号に2タスクが紐づく(listByGithubIssueNumberの結果はboardでも確認できる) ---
    const board = await get(baseUrl, '/api/board?workspace=test');
    const withSeven = board.body.columns.flatMap(c => c.items).filter(i => i.githubIssueNumber === 7).map(i => i.id).sort();
    assert.deepEqual(withSeven, [taskA, taskB].sort());

    // --- 完了: 先に終わった側(A)はコメントだけ。他に未完了のBがいるのでcloseしない ---
    assert.equal((await post(baseUrl, '/api/update-status', { taskId: taskA, newStatus: 'done' })).body.ok, true);
    const commentA = await waitFor(() => callsFor('POST', 7, '/comments')[0], 'comment for the first completed task');
    assert.match(commentA.body.body, new RegExp(`タスク ${taskA} が完了しました。`));
    assert.match(commentA.body.body, new RegExp(`Issueはcloseしていません: ${taskB}`));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(callsFor('PATCH', 7).length, 0, 'issue must stay open while another linked task is not done');

    // --- 完了: 最後の1件(B)でコメントを書き、closeする ---
    assert.equal((await post(baseUrl, '/api/update-status', { taskId: taskB, newStatus: 'done' })).body.ok, true);
    const patchB = await waitFor(() => callsFor('PATCH', 7)[0], 'close after the last linked task is done');
    assert.deepEqual(patchB.body, { state: 'closed' });
    const commentsFor7 = callsFor('POST', 7, '/comments');
    assert.equal(commentsFor7.length, 2, 'every completed task posts its own comment');
    assert.match(commentsFor7[1].body.body, new RegExp(`タスク ${taskB} が完了しました。`));
    assert.doesNotMatch(commentsFor7[1].body.body, /closeしていません/);

    // --- 1タスクだけの場合は従来どおり(文面もcloseも変えない) ---
    assert.equal((await post(baseUrl, '/api/github-link-issue', { taskId: taskC, issueNumber: '9' })).status, 200);
    assert.equal((await post(baseUrl, '/api/update-status', { taskId: taskC, newStatus: 'done' })).body.ok, true);
    const patchC = await waitFor(() => callsFor('PATCH', 9)[0], 'close for a single linked task');
    assert.deepEqual(patchC.body, { state: 'closed' });
    const commentC = callsFor('POST', 9, '/comments')[0];
    assert.match(commentC.body.body, /^タスクが完了しました。/);
    assert.doesNotMatch(commentC.body.body, new RegExp(taskC));

    // --- 論理削除したタスクは「未完了の共有相手」に数えない ---
    assert.equal((await post(baseUrl, '/api/github-link-issue', { taskId: taskD, issueNumber: '11' })).status, 200);
    assert.equal((await post(baseUrl, '/api/github-link-issue', { taskId: taskE, issueNumber: '11', allowShared: true })).status, 200);
    assert.equal((await post(baseUrl, '/api/delete-task', { taskId: taskE })).body.ok, true);
    assert.equal((await post(baseUrl, '/api/update-status', { taskId: taskD, newStatus: 'done' })).body.ok, true);
    const patchD = await waitFor(() => callsFor('PATCH', 11)[0], 'close when the only other linked task was deleted');
    assert.deepEqual(patchD.body, { state: 'closed' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
