'use strict';

// BT-444: 更新ダイアログの「現在 vX (hash) → 更新後 vY (hash)」表示を検証する。
// - 画面側: app.jsからformatVersionTransitionHtmlだけを取り出して単体実行する
// - サーバー側: GET /api/update-check の応答にcurrent(version/shortHash)とlatestVersionが含まれる

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const sourceRoot = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(sourceRoot, 'public', 'app.js'), 'utf8');

function loadFormatter() {
  const match = appSource.match(/function formatVersionTransitionHtml\(data\) \{[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(match, 'formatVersionTransitionHtmlがapp.jsに存在するはず');
  const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return new Function('escapeHtml', `${match[0]}\nreturn formatVersionTransitionHtml;`)(escapeHtml);
}

test('バージョンとハッシュが両方揃うと「現在 → 更新後」の1行になる', () => {
  const html = loadFormatter()({
    current: { version: '2.14.0', shortHash: 'b135c04' },
    latestVersion: '2.15.0',
    latestCommit: { shortHash: 'abc1234' },
  });
  assert.match(html, /現在 v2\.14\.0 <span class="product-menu-commit-hash">b135c04<\/span> → 更新後 v2\.15\.0 <span class="product-menu-commit-hash">abc1234<\/span>/);
});

test('更新後のバージョンが取れない時はハッシュだけで表示する', () => {
  const html = loadFormatter()({
    current: { version: '2.14.0', shortHash: 'b135c04' },
    latestVersion: null,
    latestCommit: { shortHash: 'abc1234' },
  });
  assert.match(html, /更新後 <span class="product-menu-commit-hash">abc1234<\/span>/);
  assert.doesNotMatch(html, /更新後 v/);
});

test('どちらかの側に表示できる情報が全く無ければ何も出さない', () => {
  const fmt = loadFormatter();
  assert.equal(fmt({ current: { version: null, shortHash: null }, latestVersion: '2.15.0', latestCommit: null }), '');
  assert.equal(fmt({}), '');
});

test('GET /api/update-check はcurrent(version/shortHash)とlatestVersionを返す', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(sourceRoot, '.api-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
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

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        if ((await fetch(`${baseUrl}/api/health`)).status === 200) break;
      } catch { /* wait for startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (attempt === 59) throw new Error('test server did not start');
    }
    const { version } = require('../package.json');
    const body = await (await fetch(`${baseUrl}/api/update-check`)).json();
    assert.equal(body.current.version, version);
    assert.ok('shortHash' in body.current);
    assert.ok('latestVersion' in body);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => {});
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
