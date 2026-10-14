'use strict';

// BM-071: its-credentials.json(ワークスペース単位のプロジェクトURL・ホスト単位のトークン)の
// 読み書き・URL分解・hasToken判定を検証する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const itsCredentials = require('../its-credentials');

// 各テストが作る一時ディレクトリをまとめて片付ける(mkdtempSyncの個別cleanupを都度書かないため)。
const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-dashboard-its-'));
  tmpDirs.push(directory);
  return path.join(directory, 'its-credentials.json');
}

test('parseRedmineProjectUrl handles sub-path installs and sub-resource URLs', () => {
  assert.deepEqual(
    itsCredentials.parseRedmineProjectUrl('http://host.example.com/redmine/projects/sample'),
    { host: 'http://host.example.com/redmine', projectRef: 'sample' }
  );
  assert.deepEqual(
    itsCredentials.parseRedmineProjectUrl('http://host.example.com/redmine/projects/sample/issues?x=1'),
    { host: 'http://host.example.com/redmine', projectRef: 'sample' }
  );
  assert.equal(itsCredentials.parseRedmineProjectUrl('not a url'), null);
  assert.equal(itsCredentials.parseRedmineProjectUrl(''), null);
});

test('parseGitlabProjectUrl extracts host and path_with_namespace, dropping -/ sub-paths and .git', () => {
  assert.deepEqual(
    itsCredentials.parseGitlabProjectUrl('http://gitlab.example.com/group/project'),
    { host: 'http://gitlab.example.com', projectRef: 'group/project' }
  );
  assert.deepEqual(
    itsCredentials.parseGitlabProjectUrl('http://gitlab.example.com/group/project/-/issues/5'),
    { host: 'http://gitlab.example.com', projectRef: 'group/project' }
  );
  assert.deepEqual(
    itsCredentials.parseGitlabProjectUrl('http://gitlab.example.com/group/sub/project.git'),
    { host: 'http://gitlab.example.com', projectRef: 'group/sub/project' }
  );
  assert.equal(itsCredentials.parseGitlabProjectUrl('http://gitlab.example.com/onlyone'), null);
  assert.equal(itsCredentials.parseGitlabProjectUrl('not a url'), null);
});

test('saveSettings + getSettings: projectUrl and token round-trip, token value never leaks', () => {
  const file = tmpFile();
  const saved = itsCredentials.saveSettings(file, 'BM', 'redmine', {
    projectUrl: 'http://host.example.com/redmine/projects/sample', token: 'secret-key',
  });
  assert.equal(saved.success, true);
  assert.equal(saved.host, 'http://host.example.com/redmine');

  const settings = itsCredentials.getSettings(file, 'BM', 'redmine');
  assert.equal(settings.configured, true);
  assert.equal(settings.projectUrl, 'http://host.example.com/redmine/projects/sample');
  assert.equal(settings.hasToken, true);
  assert.equal('token' in settings, false);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.hosts.redmine['http://host.example.com/redmine'].token, 'secret-key');
});

test('saveSettings rejects an unparsable projectUrl and does not write partial state', () => {
  const file = tmpFile();
  const result = itsCredentials.saveSettings(file, 'BM', 'redmine', { projectUrl: 'not-a-redmine-url' });
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(file), false);
});

test('saveSettings keeps existing token when token is omitted, clears it on empty string', () => {
  const file = tmpFile();
  itsCredentials.saveSettings(file, 'BM', 'redmine', {
    projectUrl: 'http://host.example.com/redmine/projects/sample', token: 'secret-key',
  });
  // URLだけ再保存(token未指定) -> 既存トークンを保持
  itsCredentials.saveSettings(file, 'BM', 'redmine', { projectUrl: 'http://host.example.com/redmine/projects/sample' });
  assert.equal(itsCredentials.getSettings(file, 'BM', 'redmine').hasToken, true);

  // token:'' で明示的に削除
  itsCredentials.saveSettings(file, 'BM', 'redmine', { token: '' });
  assert.equal(itsCredentials.getSettings(file, 'BM', 'redmine').hasToken, false);
});

test('token is shared across workspaces on the same host', () => {
  const file = tmpFile();
  itsCredentials.saveSettings(file, 'BM', 'redmine', {
    projectUrl: 'http://host.example.com/redmine/projects/sample', token: 'shared-key',
  });
  itsCredentials.saveSettings(file, 'KT', 'redmine', {
    projectUrl: 'http://host.example.com/redmine/projects/other',
  });
  assert.equal(itsCredentials.getSettings(file, 'KT', 'redmine').hasToken, true);
});

test('getAllSettingsForWorkspace returns both redmine and gitlab entries', () => {
  const file = tmpFile();
  itsCredentials.saveSettings(file, 'BM', 'redmine', {
    projectUrl: 'http://host.example.com/redmine/projects/sample', token: 'k1',
  });
  const all = itsCredentials.getAllSettingsForWorkspace(file, 'BM');
  assert.equal(all.redmine.configured, true);
  assert.equal(all.gitlab.configured, false);
});

test('getHostStatus reflects token presence for a given URL without requiring prior save', () => {
  const file = tmpFile();
  itsCredentials.saveSettings(file, 'BM', 'gitlab', {
    projectUrl: 'http://gitlab.example.com/group/project', token: 'gl-token',
  });
  const status = itsCredentials.getHostStatus(file, 'gitlab', 'http://gitlab.example.com/group/other-project');
  assert.equal(status.valid, true);
  assert.equal(status.host, 'http://gitlab.example.com');
  assert.equal(status.hasToken, true);

  const unknownHost = itsCredentials.getHostStatus(file, 'gitlab', 'http://other-host.example.com/group/project');
  assert.equal(unknownHost.hasToken, false);

  const invalid = itsCredentials.getHostStatus(file, 'redmine', 'not a url');
  assert.equal(invalid.valid, false);
});

test('resolveConnection returns host/projectRef/token for server-side API calls, or null when unconfigured', () => {
  const file = tmpFile();
  itsCredentials.saveSettings(file, 'BM', 'redmine', {
    projectUrl: 'http://host.example.com/redmine/projects/sample', token: 'secret-key',
  });
  const conn = itsCredentials.resolveConnection(file, 'BM', 'redmine');
  assert.deepEqual(conn, { host: 'http://host.example.com/redmine', projectRef: 'sample', token: 'secret-key' });
  assert.equal(itsCredentials.resolveConnection(file, 'BM', 'gitlab'), null);
});
