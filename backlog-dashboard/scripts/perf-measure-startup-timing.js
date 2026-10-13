'use strict';
// ============================================================
// 【パフォーマンス測定専用スクリプト・一般利用なし】
// BM-080(起動直後の画面真っ白対策)の実測で作成。server.jsの起動シーケンスを
// 模して、require/git同期コマンド/DB初期化/board構築 各ステップの所要時間を
// 計測する(本番のserver.js自体は書き換えずに測るための別スクリプト)。
//
// 使い方: node scripts/perf-measure-startup-timing.js
// (backlog-dashboardディレクトリ、またはこのファイルがあるディレクトリから実行)
//
// 性能問題の切り分けで再度使う可能性があるため削除せず残す。
// 実測結果の記録: docs/work/2026-10-13_bm-080-startup-blank-screen-investigation.md
// ============================================================

const t0 = process.hrtime.bigint();
function mark(label) {
  const now = process.hrtime.bigint();
  const ms = Number(now - t0) / 1e6;
  console.log(`[${ms.toFixed(1)}ms] ${label}`);
}

mark('start');

// このスクリプトはbacklog-dashboard/scripts/配下に置くため、
// server.jsと同じモジュール群を参照するにはbacklog-dashboardルート(1階層上)を基準にする。
const DASHBOARD_ROOT = require('path').join(__dirname, '..');

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
mark('require: http/fs/path/os');

const { WebSocketServer } = require('ws');
mark('require: ws');

const { execFileSync, execFile } = require('child_process');
mark('require: child_process');

const githubClient = require(path.join(DASHBOARD_ROOT, 'github-client'));
mark('require: github-client');

const { getDb } = require(path.join(DASHBOARD_ROOT, 'db', 'connection'));
mark('require: db/connection');

const { buildBoardFromDb } = require(path.join(DASHBOARD_ROOT, 'db', 'board'));
mark('require: db/board');

const { buildActivity } = require(path.join(DASHBOARD_ROOT, 'db', 'activity'));
mark('require: db/activity');

const tasksRepo = require(path.join(DASHBOARD_ROOT, 'db', 'tasks-repo'));
mark('require: db/tasks-repo');

const { createBackupManager } = require(path.join(DASHBOARD_ROOT, 'db', 'backup'));
mark('require: db/backup');

const { createTagsApi } = require(path.join(DASHBOARD_ROOT, 'tags-api'));
mark('require: tags-api');

// --- config読み込み ---
const CONFIG_PATH = path.join(DASHBOARD_ROOT, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const BACKLOG_DIR = config.backlogDir.replace(/^~/, os.homedir());
mark('config.json読み込み');

// --- git系(同期、server.js冒頭と同じ呼び方) ---
const REPO_ROOT = path.join(DASHBOARD_ROOT, '..');
try {
  execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' });
} catch (e) { console.log('  (git remote failed: ' + e.message + ')'); }
mark('git remote get-url origin');

try {
  execFileSync('git', ['log', '-1', '--format=%h%x1f%cI%x1f%s'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) { console.log('  (git log failed: ' + e.message + ')'); }
mark('git log -1');

try {
  execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) { console.log('  (git status failed: ' + e.message + ')'); }
mark('git status --porcelain');

// --- DB接続・スキーマ作成(getDb内でcreateSchemaが走る) ---
const db = getDb(BACKLOG_DIR);
mark('getDb (DB接続+createSchema)');

// --- buildBoardFromDb (WebSocket接続時に毎回走る処理) ---
const board = buildBoardFromDb(db, config, null);
mark('buildBoardFromDb (初回board構築)');

const board2 = buildBoardFromDb(db, config, null);
mark('buildBoardFromDb (2回目、ウォーム状態)');

mark('end');
console.log('projects件数:', (board.projects || []).length);
