'use strict';

// BT-439: エージェント運用ルールの同期状況の確認・同期API(rules-sync-api.js)を、
// スクリプト実行を差し替えて検証する(実際のホーム配下やPowerShellには触れない)。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRulesApi, parseCheckOutput, readRulesVersion } = require('../rules-sync-api');

const CURRENT = [
  'Rule distribution is current: C:\\repo\\.claude\\skills\\install-backlog-hub\\assets\\backlog-hub-rules.md',
  'Rule distribution is current: C:\\repo\\.kiro\\skills\\install-backlog-hub\\assets\\backlog-hub-rules.md',
  'Claude Code rules are current.',
  'Codex rules are current.',
  'Kiro rules are current.',
  'Agent rule check completed.',
].join('\r\n');
const KIRO_STALE = CURRENT.replace('Kiro rules are current.', 'Kiro rules need synchronization.');

function makeRepo(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-rules-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md.sample'), `# ルール\n\n> 対応API version: ${version}（BT-1。説明）\n`);
  return dir;
}

// ハンドラへ擬似のreq/resを渡し、応答を待って {status, body} を返す
function call(handle, method, url) {
  return new Promise((resolve, reject) => {
    const res = {
      writeHead(status) { this.status = status; },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    if (!handle({ method, url }, res)) reject(new Error('not handled'));
  });
}

test('parseCheckOutput: エージェント別・配布物別の判定を読む', () => {
  const { agents, distribution } = parseCheckOutput(KIRO_STALE);
  assert.deepEqual(agents.map(a => [a.key, a.current]), [['claude', true], ['codex', true], ['kiro', false]]);
  assert.equal(distribution.length, 2);
  assert.ok(distribution.every(d => d.current));
  assert.deepEqual(parseCheckOutput('なにもない'), { agents: [], distribution: [] });
});

test('readRulesVersion: 正本の見出しから対応バージョンを読む', () => {
  assert.equal(readRulesVersion(makeRepo('2.12.0')), '2.12.0');
  assert.equal(readRulesVersion(path.join(os.tmpdir(), 'no-such-repo-dir')), null);
});

test('GET /api/rules-status: 全て最新ならneedsSync=false、バージョン一致', async () => {
  const handle = createRulesApi({ repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0', run: async () => ({ code: 0, stdout: CURRENT, stderr: '' }) });
  const { status, body } = await call(handle, 'GET', '/api/rules-status');
  assert.equal(status, 200);
  assert.equal(body.needsSync, false);
  assert.equal(body.versionMismatch, false);
  assert.equal(body.agents.length, 3);
});

test('GET /api/rules-status: 要同期(終了コード1)と、ルール/サーバーのバージョン不一致を返す', async () => {
  const handle = createRulesApi({ repoRoot: makeRepo('2.12.0'), apiVersion: '2.11.0', run: async () => ({ code: 1, stdout: KIRO_STALE, stderr: '' }) });
  const { body } = await call(handle, 'GET', '/api/rules-status');
  assert.equal(body.needsSync, true);
  assert.equal(body.agents.find(a => a.key === 'kiro').current, false);
  assert.equal(body.versionMismatch, true);
  assert.equal(body.rulesVersion, '2.12.0');
  assert.equal(body.apiVersion, '2.11.0');
});

test('GET /api/rules-status: スクリプトが動かなかった(判定行なし)時は500', async () => {
  const failing = createRulesApi({ repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0', run: async () => ({ code: 1, stdout: '', stderr: 'boom', error: undefined }) });
  const r1 = await call(failing, 'GET', '/api/rules-status');
  assert.equal(r1.status, 500);
  assert.equal(r1.body.error, 'check_failed');
  const noPowershell = createRulesApi({ repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0', run: async () => ({ code: null, stdout: '', stderr: '', error: 'spawn powershell.exe ENOENT' }) });
  const r2 = await call(noPowershell, 'GET', '/api/rules-status');
  assert.equal(r2.status, 500);
  assert.match(r2.body.message, /ENOENT/);
});

test('POST /api/rules-sync: 既に最新なら同期スクリプトを実行しない(.bakを増やさない)', async () => {
  const calls = [];
  const handle = createRulesApi({ repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0', run: async args => { calls.push(args); return { code: 0, stdout: CURRENT, stderr: '' }; } });
  const { status, body } = await call(handle, 'POST', '/api/rules-sync');
  assert.equal(status, 200);
  assert.equal(body.changed, false);
  assert.deepEqual(calls, [['-Check']]);
});

test('POST /api/rules-sync: 要同期なら -Check → 同期 → -Check の順に実行し、最新になった状態を返す', async () => {
  const calls = [];
  let synced = false;
  const handle = createRulesApi({
    repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0',
    run: async args => {
      calls.push(args);
      if (args.length === 0) { synced = true; return { code: 0, stdout: 'Agent rule synchronization completed.', stderr: '' }; }
      return synced ? { code: 0, stdout: CURRENT, stderr: '' } : { code: 1, stdout: KIRO_STALE, stderr: '' };
    },
  });
  const { status, body } = await call(handle, 'POST', '/api/rules-sync');
  assert.equal(status, 200);
  assert.equal(body.changed, true);
  assert.equal(body.needsSync, false);
  assert.deepEqual(calls, [['-Check'], [], ['-Check']]);
});

test('POST /api/rules-sync: スクリプトが失敗したら500でメッセージを返し、次の同期は受け付ける', async () => {
  const handle = createRulesApi({
    repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0',
    run: async args => (args.length === 0 ? { code: 1, stdout: '', stderr: 'Kiro rule synchronization failed' } : { code: 1, stdout: KIRO_STALE, stderr: '' }),
  });
  const r1 = await call(handle, 'POST', '/api/rules-sync');
  assert.equal(r1.status, 500);
  assert.equal(r1.body.error, 'sync_failed');
  assert.match(r1.body.message, /Kiro/);
  const r2 = await call(handle, 'POST', '/api/rules-sync');
  assert.equal(r2.status, 500); // 409(実行中)ではなく、再度実行されて失敗する
});

test('POST /api/rules-sync: PowerShellのエラーは装飾行ではなく最初の意味のある行をメッセージにする', async () => {
  const stderr = [
    'powershell.exe : Codex rule synchronization failed with exit code .',
    'At line:4 char:8',
    '+ $out = & powershell.exe -File x.ps1',
    '+        ~~~~~~~~~~~~~~~~~~~~~~~~',
    '    + CategoryInfo          : NotSpecified: (:String) [], RemoteException',
  ].join('\r\n');
  const handle = createRulesApi({
    repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0',
    run: async args => (args.length === 0 ? { code: 1, stdout: '', stderr } : { code: 1, stdout: KIRO_STALE, stderr: '' }),
  });
  const { status, body } = await call(handle, 'POST', '/api/rules-sync');
  assert.equal(status, 500);
  assert.equal(body.message, 'Codex rule synchronization failed with exit code .');
});

test('POST /api/rules-sync: 実行中の2回目は409', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handle = createRulesApi({
    repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0',
    run: async () => { await gate; return { code: 0, stdout: CURRENT, stderr: '' }; },
  });
  const first = call(handle, 'POST', '/api/rules-sync');
  const second = await call(handle, 'POST', '/api/rules-sync');
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'rules_sync_in_progress');
  release();
  assert.equal((await first).status, 200);
});

test('無関係なURL・メソッドは処理しない', () => {
  const handle = createRulesApi({ repoRoot: makeRepo('2.12.0'), apiVersion: '2.12.0', run: async () => ({ code: 0, stdout: CURRENT, stderr: '' }) });
  assert.equal(handle({ method: 'GET', url: '/api/health' }, {}), false);
  assert.equal(handle({ method: 'POST', url: '/api/rules-status' }, {}), false);
  assert.equal(handle({ method: 'GET', url: '/api/rules-sync' }, {}), false);
});
