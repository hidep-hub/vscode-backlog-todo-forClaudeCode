'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createSchema } = require('../db/schema');
const { createBackupManager, selectRotation, backupNameFromDate, isBackupName } = require('../db/backup');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  const backlogDir = path.join(root, 'data');
  fs.mkdirSync(backlogDir, { recursive: true });
  const db = new DatabaseSync(path.join(backlogDir, 'backlog.sqlite3'));
  createSchema(db);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, '{"port":3333}\n');
  const docsDir = path.join(root, 'docs');
  fs.mkdirSync(path.join(docsDir, 'design'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'design', 'a.md'), '設計書');
  const sources = [
    { rel: 'backlog-dashboard/config.json', abs: configPath },
    { rel: 'backlog-dashboard/github-credentials.json', abs: path.join(root, 'missing.json') },
    { rel: 'docs', abs: docsDir },
  ];
  return { root, backlogDir, db, sources };
}

test('selectRotation: 同日は最新1件、日次7＋週次4を残す', () => {
  const names = [];
  // 2026-09-01〜2026-10-08 のうち毎日1件、さらに10/08だけ2件
  for (let d = new Date(2026, 8, 1); d <= new Date(2026, 9, 8); d.setDate(d.getDate() + 1)) {
    names.push(backupNameFromDate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0)));
  }
  names.push('backlog-20261008-180000');
  const { keep, remove } = selectRotation(names);

  assert.ok(keep.includes('backlog-20261008-180000'), '同日の最新を残す');
  assert.ok(remove.includes('backlog-20261008-090000'), '同日の古い方は削除');
  // 日次: 10/08〜10/02の7日分
  for (const day of ['08', '07', '06', '05', '04', '03', '02']) {
    assert.ok(keep.some(n => n.startsWith(`backlog-202610${day}`)), `日次 ${day}`);
  }
  assert.equal(keep.length, 7 + 4, '日次7 + 週次4');
  assert.equal(keep.length + remove.length, names.length);
  assert.ok(!remove.includes('backlog-20261008-180000'));
});

test('selectRotation: 件数が少なければ何も消さない／名前以外は無視', () => {
  const names = ['backlog-20261001-100000', 'backlog-20261002-100000', 'other-folder'];
  const { keep, remove } = selectRotation(names);
  assert.deepEqual(keep.sort(), ['backlog-20261001-100000', 'backlog-20261002-100000']);
  assert.deepEqual(remove, []);
});

test('isBackupName: パストラバーサル等を拒否する', () => {
  assert.equal(isBackupName('backlog-20261008-153012'), true);
  assert.equal(isBackupName('../backlog-20261008-153012'), false);
  assert.equal(isBackupName('backlog-20261008-153012/../x'), false);
  assert.equal(isBackupName(undefined), false);
});

test('run: DB・環境ファイルを取得し、manifest・ログ・進捗が揃う', async () => {
  const { root, backlogDir, db, sources } = makeFixture();
  try {
    db.exec("INSERT INTO tasks (id, title, status_id, project) SELECT 'T-1', 'hello', id, 'p' FROM statuses LIMIT 1");
  } catch (e) { /* スキーマ差異でinsertできない場合は件数0のまま検証する */ }
  const mgr = createBackupManager({
    getDb: () => db, backlogDir, sources, apiVersion: () => 'test',
    clock: () => new Date(2026, 9, 8, 15, 30, 12),
  });

  const result = await mgr.run({ actor: 'tester' });
  assert.equal(result.ok, true);
  assert.equal(result.file, 'backlog-20261008-153012');
  assert.equal(result.integrity, 'ok');
  assert.deepEqual(result.skipped, ['backlog-dashboard/github-credentials.json']);

  const dir = path.join(mgr.backupsDir, result.file);
  assert.ok(fs.existsSync(path.join(dir, 'backlog.sqlite3')));
  assert.equal(fs.readFileSync(path.join(dir, 'files', 'backlog-dashboard', 'config.json'), 'utf8'), '{"port":3333}\n');
  assert.equal(fs.readFileSync(path.join(dir, 'files', 'docs', 'design', 'a.md'), 'utf8'), '設計書');

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 2);
  assert.ok(manifest.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.equal(manifest.apiVersion, 'test');

  const logLines = fs.readFileSync(path.join(mgr.backupsDir, 'backup.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logLines.length, 1);
  assert.equal(logLines[0].ok, true);
  assert.equal(logLines[0].actor, 'tester');
  assert.ok('tasks' in logLines[0].counts);

  const st = mgr.status();
  assert.equal(st.running, false);
  assert.equal(st.percent, 100);

  const listed = mgr.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].file, result.file);
  assert.deepEqual(listed[0].counts, result.counts);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('run: 実行中の二重起動は拒否され、状態が進捗として見える', async () => {
  const { root, backlogDir, db, sources } = makeFixture();
  const mgr = createBackupManager({ getDb: () => db, backlogDir, sources, clock: () => new Date(2026, 9, 8, 15, 30, 12) });
  const first = mgr.run();
  assert.equal(mgr.isRunning(), true);
  await assert.rejects(mgr.run(), { code: 'backup_in_progress' });
  await first;
  assert.equal(mgr.isRunning(), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('delete: 最新は保護、不正名は拒否、古いものは削除できる', async () => {
  const { root, backlogDir, db, sources } = makeFixture();
  let now = new Date(2026, 9, 7, 10, 0, 0);
  const mgr = createBackupManager({ getDb: () => db, backlogDir, sources, clock: () => now });
  await mgr.run();
  now = new Date(2026, 9, 8, 10, 0, 0);
  await mgr.run();

  assert.throws(() => mgr.remove('../x'), { code: 'invalid_name' });
  assert.throws(() => mgr.remove('backlog-20200101-000000'), { code: 'not_found' });
  assert.throws(() => mgr.remove('backlog-20261008-100000'), { code: 'latest_protected' });
  mgr.remove('backlog-20261007-100000');
  assert.deepEqual(mgr.list().map(b => b.file), ['backlog-20261008-100000']);

  const log = fs.readFileSync(path.join(mgr.backupsDir, 'backup.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.at(-1).event, 'delete');

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('run: 失敗時は不完全なフォルダを残さずログにok:falseを記録する', async () => {
  const { root, backlogDir, db, sources } = makeFixture();
  const broken = { prepare() { throw new Error('boom'); } };
  const mgr = createBackupManager({ getDb: () => broken, backlogDir, sources, clock: () => new Date(2026, 9, 8, 15, 30, 12) });
  await assert.rejects(mgr.run(), /boom/);
  assert.equal(fs.existsSync(path.join(mgr.backupsDir, 'backlog-20261008-153012')), false);
  const log = JSON.parse(fs.readFileSync(path.join(mgr.backupsDir, 'backup.log'), 'utf8').trim());
  assert.equal(log.ok, false);
  assert.equal(mgr.isRunning(), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
