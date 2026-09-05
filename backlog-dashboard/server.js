'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { spawn, execFileSync } = require('child_process');
const githubClient = require('./github-client');
const { getDb } = require('./db/connection');
const { buildBoardFromDb } = require('./db/board');
const tasksRepo = require('./db/tasks-repo');
const { version: API_VERSION } = require('./package.json');

// --- Config ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = config.port || 3333;
const BACKLOG_DIR = config.backlogDir.replace(/^~/, os.homedir());
const GITHUB_CREDENTIALS_PATH = path.join(__dirname, 'github-credentials.json');

/**
 * このプロダクト(backlog-dashboard)自体のソースリポジトリURLを、
 * cloneしてきた .git/config の remote origin から取得する（BT-162）。
 * ユーザーごとに異なるgithub-credentials.json（Issue連携先の設定）とは無関係に、
 * 誰の環境でも「最新版を見に行けるリンク」として同じ値になるようにするための実装。
 * gitが使えない/originが無い環境では空文字を返し、呼び出し元でリンクを無効化する。
 */
function resolveRepoOriginUrl() {
  try {
    const output = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    }).trim();
    if (!output) return '';
    let url = output.replace(/\.git$/, '');
    const sshMatch = url.match(/^git@([^:]+):(.+)$/);
    if (sshMatch) {
      url = `https://${sshMatch[1]}/${sshMatch[2]}`;
    }
    return url;
  } catch (e) {
    console.error('[repo-origin-url] Failed to resolve:', e.message);
    return '';
  }
}
const REPO_ORIGIN_URL = resolveRepoOriginUrl();

// --- Projects / Prefix helper ---
function getPrefixMap() {
  // { file: prefix } マッピングを返す
  const map = {};
  for (const p of config.projects || []) {
    map[p.file] = p.prefix;
  }
  return map;
}

function getAllPrefixes() {
  return (config.projects || []).map(p => p.prefix);
}

// ============================================================
// Config Hot Reload (BT-050)
// ============================================================
// projects[] への追記（新規ワークスペース登録）をサーバー再起動なしで反映するため、
// config.json をファイル監視し、変更検知時に既存の config オブジェクトへ in-place で
// 上書きする（config は複数モジュールスコープの関数から同じ参照を見ているため、
// プロパティを差し替えるだけで全箇所に伝播する）。
// PORT / BACKLOG_DIR はリッスンポートやデータ格納場所という起動時にしか
// 意味を成さない値なので、意図的にリロード対象から外している。
let configReloadTimer = null;

function reloadConfig() {
  let newConfig;
  try {
    newConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[config] Reload failed, keeping previous config:', e.message);
    return;
  }

  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, newConfig);

  console.log('[config] Reloaded config.json (projects:', (config.projects || []).map(p => p.file).join(', '), ')');
}

try {
  // config.json を直接 fs.watch すると、エディタのアトミック保存（rename経由の
  // 置き換え）で 'change' イベントが飛ばず検知漏れすることがあるため、
  // ディレクトリを監視してファイル名でフィルタする（BACKLOG_DIR監視と同じ方式）。
  // eventType は 'change' 'rename' のどちらでも変更ありとみなす。
  fs.watch(__dirname, { persistent: true }, (eventType, filename) => {
    if (filename !== 'config.json') return;
    // 保存時に短時間で複数イベントが発火することがあるためデバウンス
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(reloadConfig, 300);
  });
} catch (e) {
  console.error('[config] Failed to watch config.json:', e.message);
}

// ============================================================
// Workspace API (BT-049)
// ============================================================

/**
 * タスクが属するプロジェクトのワークスペースをVS Codeで開く
 * @param {string} taskId
 * @returns {{ success: boolean, workspace?: string, error?: string }}
 */
// Windowsの`code`はPATH上の.cmdシムのため shell:true でしか解決できない。
// shell:true は引数をエスケープせず連結するため、config.json由来とはいえ
// シェルメタ文字を含むパスは事前に弾いておく（多層防御）。
const SAFE_WORKSPACE_PATH = /^[A-Za-z0-9 _.:/\\-]+$/;

function spawnVSCode(workspacePath) {
  try {
    const child = spawn('code', [workspacePath], { detached: true, shell: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) {
    console.error(`[workspace] Failed to spawn code for ${workspacePath}:`, e.message);
    return false;
  }
}

// BT-193: DB版。タスクのworkspace(DB)からプロジェクトを解決する(旧findProjectEntryForTaskはmd検索のため使わない)
function openWorkspace(taskId) {
  const db = getDb(BACKLOG_DIR);
  const task = tasksRepo.getByDisplayId(db, taskId);
  if (!task) {
    return { success: false, error: `Task ${taskId} not found` };
  }
  const project = (config.projects || []).find(p => p.file === task.workspace);
  if (!project) {
    return { success: false, error: `Project not found for workspace "${task.workspace}"` };
  }
  if (!project.workspace) {
    return { success: false, error: `Project "${project.name}" has no workspace path configured` };
  }
  if (!SAFE_WORKSPACE_PATH.test(project.workspace)) {
    return { success: false, error: `Workspace path contains unsupported characters: ${project.workspace}` };
  }
  if (!fs.existsSync(project.workspace)) {
    return { success: false, error: `Workspace path does not exist: ${project.workspace}` };
  }

  spawnVSCode(project.workspace);
  return { success: true, workspace: project.workspace };
}

// ============================================================
// Workspace Creation API (BT-051)
// ============================================================

const FILE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const PREFIX_RE = /^[A-Z]{2}$/;

/**
 * 新規プロジェクト（ワークスペース）を作成する
 * - workspaceフォルダが存在しなければ作成（「作って開く」の"作って"部分）
 * - <file>.backlog.md を雛形で新規作成
 * - config.projects[] に追記して永続化
 *   （fs.watchによるホットリロード(BT-050)でも自動反映されるが、直後のリクエストが
 *   古いconfigを見ないよう in-memory も同時に更新する）
 * @param {{file:string, prefix:string, name?:string, workspace?:string}} params
 * @returns {{ success: boolean, file?: string, prefix?: string, name?: string, workspace?: string, error?: string }}
 */
// BT-193: DB版。md雛形(<file>.backlog.md)作成の代わりにcountersテーブルへ行をINSERTする
function createWorkspaceProject({ file, prefix, name, workspace }) {
  if (!file || !FILE_NAME_RE.test(file)) {
    return { success: false, error: 'file must match /^[A-Za-z0-9_-]+$/' };
  }
  if (!prefix || !PREFIX_RE.test(prefix)) {
    return { success: false, error: 'prefix must be 2 uppercase letters (A-Z)' };
  }

  const existingByFile = (config.projects || []).find(p => p.file.toLowerCase() === file.toLowerCase());
  if (existingByFile) {
    return { success: false, error: `Project file "${file}" is already registered` };
  }
  const existingByPrefix = (config.projects || []).find(p => p.prefix === prefix);
  if (existingByPrefix) {
    return { success: false, error: `Prefix "${prefix}" is already used by project "${existingByPrefix.file}"` };
  }
  const db = getDb(BACKLOG_DIR);
  const existingCounter = db.prepare('SELECT workspace, prefix FROM counters WHERE workspace = ? OR prefix = ?').get(file, prefix);
  if (existingCounter) {
    return { success: false, error: `Prefix "${prefix}" or workspace "${file}" already exists in counters (past project residue)` };
  }

  if (workspace) {
    if (!SAFE_WORKSPACE_PATH.test(workspace)) {
      return { success: false, error: `Workspace path contains unsupported characters: ${workspace}` };
    }
    if (!fs.existsSync(workspace)) {
      fs.mkdirSync(workspace, { recursive: true });
      console.log(`[api] Created workspace directory: ${workspace}`);
    }
  }

  const displayName = name || file;
  db.prepare('INSERT INTO counters (workspace, prefix, next_seq) VALUES (?, ?, 1)').run(file, prefix);
  console.log(`[api] Registered counters row for workspace "${file}" (prefix: ${prefix})`);

  const newEntry = { file, prefix, name: displayName, workspace: workspace || '' };
  config.projects = [...(config.projects || []), newEntry];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`[api] Registered project "${file}" (prefix: ${prefix}) in config.json`);

  // 「作って開く」（BT-033の課題1節）を1APIで完結させるため、作成直後にVS Codeを起動する
  if (workspace) {
    spawnVSCode(workspace);
  }

  return { success: true, file, prefix, name: displayName, workspace: workspace || '' };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ============================================================
// GitHub Credentials Management (BT-074)
// ============================================================
// config.json とは別ファイルで管理する。config.json は fs.watch でホット
// リロードされる仕組みがあり、そこにトークンを混在させたくないため分離した。

function readGithubCredentials() {
  if (!fs.existsSync(GITHUB_CREDENTIALS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(GITHUB_CREDENTIALS_PATH, 'utf8'));
  } catch (e) {
    console.error('[github-credentials] Failed to read:', e.message);
    return {};
  }
}

function writeGithubCredentials(creds) {
  fs.writeFileSync(GITHUB_CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + '\n', 'utf8');
}

/**
 * prefix に対応する GitHub 連携設定を保存する。
 * token が省略された場合は既存トークンを保持し、空文字が渡された場合は削除する。
 * @returns {{success: boolean, error?: string}}
 */
function saveGithubSettings(prefix, repoUrl, token) {
  if (!getAllPrefixes().includes(prefix)) {
    return { success: false, error: `Unknown prefix: "${prefix}"` };
  }
  const creds = readGithubCredentials();
  const existing = creds[prefix] || {};
  const entry = { repoUrl: repoUrl || existing.repoUrl || '' };
  if (token === undefined) {
    if (existing.token) entry.token = existing.token;
  } else if (token !== '') {
    entry.token = token;
  }
  creds[prefix] = entry;
  writeGithubCredentials(creds);
  return { success: true };
}

/**
 * prefix に対応する GitHub 連携設定を取得する。トークンの値自体は返さず、
 * 設定済みかどうかのフラグ(hasToken)のみ返す。
 */
function getGithubSettings(prefix) {
  const creds = readGithubCredentials();
  const entry = creds[prefix] || {};
  return { prefix, repoUrl: entry.repoUrl || '', hasToken: !!entry.token };
}

// ============================================================
// Task Completion -> GitHub Sync (BT-119相当、DB版はBT-179で移植)
// ============================================================
// タスクが完了したとき、コミットメッセージ末尾の「(taskId)」表記
// （このリポジトリのコミットメッセージ規約）を目印にコミットハッシュを
// 機械的に検索する。AIの都度判断ではなく決定的なパターンマッチで拾う。

/**
 * workspace配下のgit履歴から、コミットメッセージに taskId を含むコミットの
 * ハッシュ一覧を取得する（新しい順）。gitリポジトリでない/コマンド失敗時は
 * 空配列を返す（呼び出し元でエラー扱いしない）。
 * @param {string} workspace - リポジトリのルートディレクトリ
 * @param {string} taskId
 * @returns {string[]}
 */
function getCommitHashesForTask(workspace, taskId) {
  if (!workspace) return [];
  try {
    const output = execFileSync(
      'git',
      ['log', '--all', `--grep=(${taskId})`, '--fixed-strings', '--format=%H'],
      { cwd: workspace, encoding: 'utf8' }
    );
    return output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.error(`[github-sync] git log failed for ${taskId} in ${workspace}:`, e.message);
    return [];
  }
}

/**
 * タスク完了時、GitHub Issueに完了コメントを投稿してcloseする（BT-119相当）。
 * 失敗してもタスク完了自体は既に成功済みのため、ログ出力のみで握り潰す
 * （fire-and-forget。APIレスポンスをGitHub側の成否で待たせない）。
 * @param {string} prefix
 * @param {{display_id: string, description?: string, github_issue_number: number}} task
 * @param {string[]} commitHashes
 */
function syncCompletionToGithub(prefix, task, commitHashes) {
  const creds = readGithubCredentials()[prefix];
  if (!creds || !creds.repoUrl || !creds.token) return;

  const bodyLines = ['タスクが完了しました。', '', task.description || '(説明なし)'];
  if (commitHashes.length > 0) {
    bodyLines.push('', `コミット: ${commitHashes.join(', ')}`);
  }

  githubClient.issues.createComment(creds.repoUrl, creds.token, task.github_issue_number, bodyLines.join('\n'))
    .then(() => githubClient.issues.update(creds.repoUrl, creds.token, task.github_issue_number, { state: 'closed' }))
    .catch(e => console.error(`[github-sync] Failed to sync completion for ${task.display_id}:`, e.message));
}

// GitHub Issue⇔Backlogタスクの紐付けを示す固定ラベル(BT-143)
const BACKLOG_LINK_LABEL = 'backlog-todo';
const BACKLOG_FOOTER_SEPARATOR = '---';

/**
 * GitHub Issue側でBacklogタスクIDが一目で分かるよう件名にprefixを付与する(BT-143)
 */
function buildBacklogLinkedTitle(taskId, title) {
  return `[${taskId}] ${title}`;
}

/**
 * GitHub Issue本文の末尾にBacklogタスクIDを示すフッターを追記する(BT-143)
 */
function appendBacklogFooter(body, taskId) {
  const base = (body || '').trim();
  const footer = `${BACKLOG_FOOTER_SEPARATOR}\n🔖 Backlog: ${taskId}`;
  return base ? `${base}\n\n${footer}` : footer;
}

/**
 * 取り込んだGitHub Issue側に、確定したBacklogタスクIDを書き戻す(BT-143)。
 * labelsはPATCHで渡すと既存ラベルが上書きされるため、既存ラベル名に合成してから渡す。
 * 失敗してもタスク自体の取り込みは既に成功しているため、ログのみでスキップする。
 */
async function writeBacklogLinkToGithubIssue(creds, issue, taskId) {
  const existingLabels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
  const labels = existingLabels.includes(BACKLOG_LINK_LABEL) ? existingLabels : [...existingLabels, BACKLOG_LINK_LABEL];
  try {
    await githubClient.issues.update(creds.repoUrl, creds.token, issue.number, {
      title: buildBacklogLinkedTitle(taskId, issue.title),
      body: appendBacklogFooter(issue.body, taskId),
      labels,
    });
  } catch (e) {
    console.error(`[github-fetch-issues] Failed to write backlog link back to issue #${issue.number}:`, e.message);
  }
}

// --- MIME Types ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// BT-188: DB版のboard構築(BT-194で全APIのDB化完了)。db/board.jsのbuildBoardFromDb()に
// タスクデータの組み立てを委譲し、config.projectsのみに依存する既存ヘルパー(workspaceMap等)
// をここでマージする。
function buildBoard() {
  const db = getDb(BACKLOG_DIR);
  const dbBoard = buildBoardFromDb(db, config);
  return {
    ...dbBoard,
    workspaceMap: getWorkspaceMap(),
    workspaceFilterMap: getWorkspaceFilterMap(),
    projectFileMap: getProjectFileMap(),
    projectPrefixMap: getProjectPrefixMap(),
  };
}

// プロジェクト表示名 → ワークスペースパスのマッピングを返す
function getWorkspaceMap() {
  const map = {};
  for (const p of config.projects) {
    if (p.workspace) {
      map[p.name] = p.workspace;
    }
  }
  return map;
}

// ワークスペース識別子 → プロジェクト表示名のマッピングを返す
// URLパラメータ ?workspace=xxx で使う。file名、name、パス末尾ディレクトリ名でマッチ可能
function getWorkspaceFilterMap() {
  const map = {};
  for (const p of config.projects) {
    // file名でマッチ (e.g. "kiro-todo")
    if (p.file) map[p.file.toLowerCase()] = p.name;
    // name でマッチ (e.g. "kiro-todo")
    if (p.name) map[p.name.toLowerCase()] = p.name;
    // workspace パスの末尾ディレクトリ名でマッチ
    if (p.workspace) {
      const dirName = p.workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      if (dirName) map[dirName.toLowerCase()] = p.name;
    }
  }
  return map;
}

// プロジェクト表示名 → file名 のマッピングを返す（BT-063: 移管先ピッカーが
// /api/move-task に渡すfile名を、フロントの表示名からも解決できるようにする）
function getProjectFileMap() {
  const map = {};
  for (const p of config.projects) {
    if (p.name && p.file) map[p.name] = p.file;
  }
  return map;
}

// プロジェクト表示名 → prefix のマッピングを返す(BT-077: GitHub連携設定UIが
// プロジェクト選択からprefixを解決するために使う)
function getProjectPrefixMap() {
  const map = {};
  for (const p of config.projects) {
    if (p.name && p.prefix) map[p.name] = p.prefix;
  }
  return map;
}

// ============================================================
// HTTP Server + Static Files
// ============================================================

const publicDir = path.join(__dirname, 'public');


function serveStatic(req, res) {
  console.log(`[http] ${req.method} ${req.url}`);

  // API: GET /api/health
  if (req.url === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    // devInstanceLabelはDB化(BT-169)の並行運用中、本番と見分けるための開発用バッジ表示に使う（BT-185）。
    // 本番のconfig.jsonにはこのキー自体が存在しないため、バッジは複製先(開発用)にのみ出る。
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), apiVersion: API_VERSION, devInstanceLabel: config.devInstanceLabel || null }));
    return;
  }

  // API: GET /api/repo-origin-url（BT-162: ヘッダーロゴクリックで開くこのプロダクト自体のGitHubリンク）
  if (req.url === '/api/repo-origin-url' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ repoUrl: REPO_ORIGIN_URL }));
    return;
  }

  // API: GET /api/board
  if (req.url === '/api/board' && req.method === 'GET') {
    const board = buildBoard();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(board));
    return;
  }

  // API: POST /api/update-status (BT-189: DB版。newStatusはstatus code(todo/ready/do/done)を
  // 受け取る。isChildパラメータは廃止(BT-187)。完了時の自動処理(BT-179で移植):
  // pin/running解除、コミットハッシュ紐付け、GitHub連携完了時同期(旧BT-119相当)
  if (req.url === '/api/update-status' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, newStatus }) => {
      if (!taskId || !newStatus) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId and newStatus are required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const validCodes = db.prepare('SELECT code FROM statuses').all().map(r => r.code);
      if (!validCodes.includes(newStatus)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Invalid newStatus: "${newStatus}". Must be one of: ${validCodes.join(', ')}` }));
        return;
      }
      const existing = tasksRepo.getByDisplayId(db, taskId);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task not found: ${taskId}` }));
        return;
      }

      const isCompleting = newStatus === 'done';
      const project = isCompleting ? (config.projects || []).find(p => p.file === existing.workspace) : null;
      const commitHashes = isCompleting ? getCommitHashesForTask(project && project.workspace, taskId) : [];

      tasksRepo.updateStatus(db, taskId, newStatus);
      if (isCompleting) {
        if (commitHashes.length > 0) tasksRepo.updateCommitHash(db, taskId, commitHashes);
        tasksRepo.setPin(db, existing.workspace, taskId, false);
        tasksRepo.setRunning(db, existing.workspace, taskId, false);
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      broadcast(buildBoard());

      if (isCompleting && existing.github_issue_number && project) {
        syncCompletionToGithub(project.prefix, existing, commitHashes);
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/reorder (BT-189: DB版。isChild/parentIdパラメータは廃止(BT-187)、
  // スコープはorderedIds先頭タスクのparent_id/statusから自動判定する)
  if (req.url === '/api/reorder' && req.method === 'POST') {
    readRequestBody(req).then(({ orderedIds }) => {
      if (!orderedIds || !Array.isArray(orderedIds) || orderedIds.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'orderedIds array (2+ items) is required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      try {
        tasksRepo.reorder(db, orderedIds);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        broadcast(buildBoard());
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/toggle-today (BT-189: DB版。isChildパラメータは廃止(BT-187)、
  // レスポンスキーもtodayFlag→pinnedに改名)
  if (req.url === '/api/toggle-today' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, value }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const existing = tasksRepo.getByDisplayId(db, taskId);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task not found: ${taskId}` }));
        return;
      }
      const pinned = value !== false;
      tasksRepo.setPin(db, existing.workspace, taskId, pinned);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, taskId, pinned }));
      broadcast(buildBoard());
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/toggle-running (BT-189: DB版。isChildパラメータは廃止(BT-187))
  if (req.url === '/api/toggle-running' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, value }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const existing = tasksRepo.getByDisplayId(db, taskId);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task not found: ${taskId}` }));
        return;
      }
      const running = value !== false;
      tasksRepo.setRunning(db, existing.workspace, taskId, running);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, taskId, running }));
      broadcast(buildBoard());
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: GET /api/github-settings?prefix=BT
  if (req.url && req.url.startsWith('/api/github-settings') && req.method === 'GET') {
    const prefix = new URL(req.url, 'http://localhost').searchParams.get('prefix');
    if (!prefix) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'prefix is required' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getGithubSettings(prefix)));
    return;
  }

  // API: POST /api/github-settings
  if (req.url === '/api/github-settings' && req.method === 'POST') {
    readRequestBody(req).then(({ prefix, repoUrl, token }) => {
      if (!prefix) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'prefix is required' }));
        return;
      }
      const result = saveGithubSettings(prefix, repoUrl, token);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: result.error }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/github-create-issue（BT-079/BT-134、BT-192: DB版。isChildパラメータは廃止(BT-187)、
  // Epic判定はtasksRepo.getChildren()の有無で行う）
  if (req.url === '/api/github-create-issue' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const task = tasksRepo.getByDisplayId(db, taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} not found` }));
        return;
      }
      const project = (config.projects || []).find(p => p.file === task.workspace);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Project not found for workspace "${task.workspace}"` }));
        return;
      }
      const creds = readGithubCredentials()[project.prefix];
      if (!creds || !creds.repoUrl || !creds.token) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `GitHub連携が未設定です (prefix: ${project.prefix})` }));
        return;
      }
      if (task.github_issue_number) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} is already linked to issue #${task.github_issue_number}` }));
        return;
      }
      // Epic(子タスクを持つ親)の場合、親Issue作成後に各子タスクをGitHub Issueとして
      // 個別作成し、Sub-issues機能で親に紐付ける(BT-134)
      const children = tasksRepo.getChildren(db, taskId);
      const isEpic = children.length > 0;

      githubClient.issues.create(creds.repoUrl, creds.token, {
        title: buildBacklogLinkedTitle(taskId, task.title),
        body: appendBacklogFooter(task.description, taskId),
        labels: [BACKLOG_LINK_LABEL],
      })
        .then(async (issue) => {
          tasksRepo.setGithubLink(db, taskId, issue.number, issue.html_url);

          const subIssues = [];
          const failedChildIds = [];
          if (isEpic) {
            for (const child of children) {
              if (child.github_issue_number) continue; // 既に紐付け済みの子はスキップ
              try {
                const subIssue = await githubClient.issues.create(creds.repoUrl, creds.token, {
                  title: buildBacklogLinkedTitle(child.display_id, child.title),
                  body: appendBacklogFooter(child.description, child.display_id),
                  labels: [BACKLOG_LINK_LABEL],
                });
                await githubClient.issues.addSubIssue(creds.repoUrl, creds.token, issue.number, subIssue.id);
                tasksRepo.setGithubLink(db, child.display_id, subIssue.number, subIssue.html_url);
                subIssues.push({ taskId: child.display_id, issueNumber: subIssue.number, issueUrl: subIssue.html_url });
              } catch (e) {
                console.error(`[github-create-issue] Failed to create sub-issue for ${child.display_id}:`, e.message);
                failedChildIds.push(child.display_id);
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true, issueNumber: issue.number, issueUrl: issue.html_url, subIssues, failedChildIds,
          }));
          broadcast(buildBoard());
        })
        .catch((e) => {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `GitHub API error: ${e.message}` }));
        });
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/github-link-issue（BT-122、BT-192: DB版。isChildパラメータは廃止(BT-187)。
  // md版にあった「完了済みタスクは非対応」制限(BT-129)はDB版では撤廃される
  // (完了済みでも行が消えず論理削除のみのため取得できる。これはBT-181の
  // 「この設計による副次効果」に沿った意図的な仕様変更)）
  if (req.url === '/api/github-link-issue' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, issueNumber }) => {
      if (!taskId || !issueNumber) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId and issueNumber are required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const task = tasksRepo.getByDisplayId(db, taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} not found` }));
        return;
      }
      const project = (config.projects || []).find(p => p.file === task.workspace);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Project not found for workspace "${task.workspace}"` }));
        return;
      }
      const creds = readGithubCredentials()[project.prefix];
      if (!creds || !creds.repoUrl || !creds.token) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `GitHub連携が未設定です (prefix: ${project.prefix})` }));
        return;
      }
      if (task.github_issue_number) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} is already linked to issue #${task.github_issue_number}` }));
        return;
      }
      const normalizedNumber = String(issueNumber).replace(/^#/, '').trim();
      if (!/^\d+$/.test(normalizedNumber)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Invalid issue number: "${issueNumber}"` }));
        return;
      }

      // 同一workspace内で既にその番号を使っている他タスクがないかチェック(重複紐付け防止)
      const duplicated = tasksRepo.findByGithubIssueNumber(db, task.workspace, normalizedNumber, taskId);
      if (duplicated) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Issue #${normalizedNumber} is already linked to another task` }));
        return;
      }

      githubClient.issues.get(creds.repoUrl, creds.token, normalizedNumber)
        .then((issue) => {
          tasksRepo.setGithubLink(db, taskId, issue.number, issue.html_url);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, issueNumber: issue.number, issueUrl: issue.html_url }));
          broadcast(buildBoard());
        })
        .catch((e) => {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `GitHub API error: ${e.message}` }));
        });
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: GET /api/github-preview-issues?prefix=BT（BT-107: Issue一覧プレビュー、mdへの書き込みは行わない）
  if (req.url && req.url.startsWith('/api/github-preview-issues') && req.method === 'GET') {
    const prefix = new URL(req.url, 'http://localhost').searchParams.get('prefix');
    if (!prefix) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'prefix is required' }));
      return;
    }
    const project = (config.projects || []).find(p => p.prefix === prefix);
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `Unknown prefix: "${prefix}"` }));
      return;
    }
    const creds = readGithubCredentials()[prefix];
    if (!creds || !creds.repoUrl || !creds.token) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `GitHub連携が未設定です (prefix: ${prefix})` }));
      return;
    }

    // 既取り込み済みのissue番号 → backlog内タスクID(このワークスペース内、親・子とも、BT-192: DB版)
    const db = getDb(BACKLOG_DIR);
    const linkedRows = db.prepare(`SELECT display_id, github_issue_number FROM tasks
      WHERE workspace = ? AND github_issue_number IS NOT NULL AND deleted_at IS NULL`).all(project.file);
    const existingNumberToTaskId = new Map(linkedRows.map(r => [String(r.github_issue_number), r.display_id]));

    githubClient.issues.listForRepo(creds.repoUrl, creds.token, { state: 'all', perPage: 100 })
      .then((issues) => {
        // Issues APIはPull Requestも返すため除外する
        const onlyIssues = (issues || []).filter((i) => !i.pull_request);
        // BT-108: 本文の "- [ ] #123" 形式task listから子issue番号を抽出(Epic表現)
        const parseTaskListChildren = (body) => {
          const matches = (body || '').matchAll(/-\s*\[[ xX]\]\s*#(\d+)/g);
          return Array.from(matches, (m) => Number(m[1]));
        };
        const preview = onlyIssues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body || '',
          url: issue.html_url,
          state: issue.state,
          alreadyImported: existingNumberToTaskId.has(String(issue.number)),
          importedTaskId: existingNumberToTaskId.get(String(issue.number)) || null,
          childIssueNumbers: parseTaskListChildren(issue.body),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, issues: preview }));
      })
      .catch((e) => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `GitHub API error: ${e.message}` }));
      });
    return;
  }

  // API: POST /api/github-fetch-issues（BT-078: GitHub Issue→カード取り込み）
  if (req.url === '/api/github-fetch-issues' && req.method === 'POST') {
    readRequestBody(req).then(({ prefix, issueNumbers }) => {
      if (!prefix) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'prefix is required' }));
        return;
      }
      // BT-109: issueNumbers指定時はその番号のみに絞り込む(選択的取り込み)。未指定なら従来通り全件対象
      const selectedNumbers = Array.isArray(issueNumbers) ? new Set(issueNumbers.map(String)) : null;
      const project = (config.projects || []).find(p => p.prefix === prefix);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Unknown prefix: "${prefix}"` }));
        return;
      }
      const creds = readGithubCredentials()[prefix];
      if (!creds || !creds.repoUrl || !creds.token) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `GitHub連携が未設定です (prefix: ${prefix})` }));
        return;
      }

      // 既取り込み済みのissue番号集合(このワークスペース内、親・子とも、BT-192: DB版)
      const db = getDb(BACKLOG_DIR);
      const existingNumbers = tasksRepo.listGithubLinkedNumbers(db, project.file);

      // BT-108: 本文の "- [ ] #123" 形式task listから子issue番号を抽出(Epic表現)
      const parseTaskListChildren = (body) => Array.from((body || '').matchAll(/-\s*\[[ xX]\]\s*#(\d+)/g), (m) => Number(m[1]));
      // task list行はmd側のフィールド書式(- キー: 値)と衝突するため、説明欄に取り込む前に取り除く
      const stripTaskListLines = (body) => (body || '')
        .split(/\r?\n/)
        .filter((line) => !/^\s*-\s*\[[ xX]\]\s*#\d+/.test(line))
        .join('\n')
        .trim();

      githubClient.issues.listForRepo(creds.repoUrl, creds.token, { state: 'all', perPage: 100 })
        .then(async (issues) => {
          // Issues APIはPull Requestも返すため除外する
          const allIssues = (issues || []).filter((i) => !i.pull_request);
          const issueByNumber = new Map(allIssues.map((i) => [i.number, i]));
          // 他issueのtask listに子として現れる番号は、親経由でのみ取り込む(単独では取り込めない)
          const allChildNumbers = new Set();
          for (const i of allIssues) {
            for (const childNum of parseTaskListChildren(i.body)) allChildNumbers.add(childNum);
          }

          let targetIssues = selectedNumbers ? allIssues.filter((i) => selectedNumbers.has(String(i.number))) : allIssues;
          let added = 0;
          let skipped = 0;
          for (const issue of targetIssues) {
            if (allChildNumbers.has(issue.number)) continue; // 子issueは親の取り込み時に一括で処理する
            if (existingNumbers.has(String(issue.number))) { skipped++; continue; }
            let created;
            try {
              created = tasksRepo.create(db, {
                workspace: project.file,
                title: issue.title,
                status: 'todo',
                description: stripTaskListLines(issue.body),
                githubIssueNumber: issue.number,
                githubIssueUrl: issue.html_url,
                createdBy: 'user',
              });
            } catch (e) { continue; }
            added++;
            // 取り込んだGitHub Issue側にも確定したBacklog番号を書き戻す(BT-143)
            await writeBacklogLinkToGithubIssue(creds, issue, created.display_id);

            // task listで紐付いた子issueを親の直下に一括取り込み
            for (const childNumber of parseTaskListChildren(issue.body)) {
              if (existingNumbers.has(String(childNumber))) { skipped++; continue; }
              const childIssue = issueByNumber.get(childNumber);
              if (!childIssue) continue; // 別リポジトリ参照など一覧に無いものは無視
              let childCreated;
              try {
                childCreated = tasksRepo.create(db, {
                  workspace: project.file,
                  title: childIssue.title,
                  status: 'todo',
                  description: stripTaskListLines(childIssue.body),
                  parentDisplayId: created.display_id,
                  githubIssueNumber: childIssue.number,
                  githubIssueUrl: childIssue.html_url,
                  createdBy: 'user',
                });
              } catch (e) { continue; }
              added++;
              await writeBacklogLinkToGithubIssue(creds, childIssue, childCreated.display_id);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, added, skipped }));
          if (added > 0) broadcast(buildBoard());
        })
        .catch((e) => {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `GitHub API error: ${e.message}` }));
        });
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/add-task (BT-190: DB版。statusはstatus code(todo/ready/do/done)を受け取る。
  // projectはconfig.projects[].file値(workspace)。parentIdを渡すと子タスクとして作成され、
  // その場合workspaceは親のworkspaceに強制される(isChild廃止、BT-187))
  if (req.url === '/api/add-task' && req.method === 'POST') {
    readRequestBody(req).then(({ title, project, status, origin, parentId, description }) => {
      if (!title || !title.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'title is required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const newStatus = status || 'todo';
      const validCodes = db.prepare('SELECT code FROM statuses').all().map(r => r.code);
      if (!validCodes.includes(newStatus)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Invalid status: "${newStatus}". Must be one of: ${validCodes.join(', ')}` }));
        return;
      }
      try {
        const created = tasksRepo.create(db, {
          workspace: project || 'inbox',
          title: title.trim(),
          status: newStatus,
          description: description || null,
          parentDisplayId: parentId || null,
          createdBy: origin || 'user',
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: created.display_id }));
        broadcast(buildBoard());
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/open-workspace
  if (req.url === '/api/open-workspace' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const result = openWorkspace(taskId);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, workspace: result.workspace }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: result.error }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/create-workspace
  if (req.url === '/api/create-workspace' && req.method === 'POST') {
    readRequestBody(req).then(({ file, prefix, name, workspace }) => {
      if (!file || !prefix) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'file and prefix are required' }));
        return;
      }
      const result = createWorkspaceProject({ file, prefix, name, workspace });
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, file: result.file, prefix: result.prefix, name: result.name, workspace: result.workspace }));
        const board = buildBoard();
        broadcast(board);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: result.error }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/attach-to-parent (BT-191: DB版。2階層制限の検証はtasksRepo.attachToParent内)
  if (req.url === '/api/attach-to-parent' && req.method === 'POST') {
    readRequestBody(req).then(({ taskIds, parentId }) => {
      if (!Array.isArray(taskIds) || taskIds.length === 0 || !parentId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskIds (non-empty array) and parentId are required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const attached = [];
      const failed = [];
      for (const taskId of taskIds) {
        try {
          tasksRepo.attachToParent(db, taskId, parentId);
          attached.push(taskId);
        } catch (e) {
          failed.push({ taskId, error: e.message });
        }
      }
      if (attached.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, attached, failed }));
        broadcast(buildBoard());
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: failed[0] ? failed[0].error : 'attach failed', failed }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/detach-from-parent (BT-191: DB版)
  if (req.url === '/api/detach-from-parent' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const existing = tasksRepo.getByDisplayId(db, taskId);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task not found: ${taskId}` }));
        return;
      }
      tasksRepo.detachFromParent(db, taskId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, id: taskId }));
      broadcast(buildBoard());
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/move-task (BT-191: DB版。isChildパラメータは廃止(BT-187)。
  // 子タスクを移動する場合は親から切り離され新たなトップレベルタスクになる(既存md版と同じ挙動))
  if (req.url === '/api/move-task' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, targetFile }) => {
      if (!taskId || !targetFile) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId and targetFile are required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      try {
        const result = tasksRepo.moveWorkspace(db, taskId, targetFile, config.projects);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, oldId: result.oldId, newId: result.newId, targetFile: result.targetFile }));
        broadcast(buildBoard());
      } catch (e) {
        const statusCode = e.code === 'has_children' ? 409 : 404;
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.code || e.message }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/update-task (BT-190: DB版。isChildパラメータは廃止(BT-187)。
  // title/descriptionに加えcategory/assignee/startDate/dueDateも同じエンドポイントで
  // 更新できるよう統合した(BT-187決定)。渡されたフィールドのみ更新する。
  // artifactsはBT-225で追加(成果物パスの配列、渡すと丸ごと入れ替え)
  if (req.url === '/api/update-task' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, title, description, category, assignee, startDate, dueDate, artifacts }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const fields = {};
      if (title !== undefined) fields.title = title;
      if (description !== undefined) fields.description = description;
      if (category !== undefined) fields.category = category;
      if (assignee !== undefined) fields.assignee = assignee;
      if (startDate !== undefined) fields.startDate = startDate;
      if (dueDate !== undefined) fields.dueDate = dueDate;
      if (Object.keys(fields).length === 0 && artifacts === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'at least one field (title/description/category/assignee/startDate/dueDate/artifacts) is required' }));
        return;
      }
      if (fields.title !== undefined && !fields.title.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'title must not be empty' }));
        return;
      }
      if (fields.title !== undefined) fields.title = fields.title.trim();
      if (artifacts !== undefined && !Array.isArray(artifacts)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'artifacts must be an array of path strings' }));
        return;
      }

      const db = getDb(BACKLOG_DIR);
      const existing = tasksRepo.getByDisplayId(db, taskId);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task not found: ${taskId}` }));
        return;
      }
      if (Object.keys(fields).length > 0) tasksRepo.updateFields(db, taskId, fields);
      if (artifacts !== undefined) tasksRepo.setArtifacts(db, taskId, artifacts);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      broadcast(buildBoard());
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/delete-tasks（複数一括削除、BT-190: DB版。has_childrenのタスクはfailedに含まれる）
  if (req.url === '/api/delete-tasks' && req.method === 'POST') {
    readRequestBody(req).then(({ taskIds }) => {
      if (!Array.isArray(taskIds) || taskIds.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskIds (non-empty array) is required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      const succeeded = [];
      const failed = [];
      for (const taskId of taskIds) {
        try {
          tasksRepo.softDelete(db, taskId);
          succeeded.push(taskId);
        } catch (e) {
          failed.push({ taskId, error: e.code || e.message });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, succeeded, failed }));
      if (succeeded.length > 0) broadcast(buildBoard());
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/delete-task (BT-190: DB版。isChildパラメータは廃止(BT-187))
  if (req.url === '/api/delete-task' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const db = getDb(BACKLOG_DIR);
      try {
        tasksRepo.softDelete(db, taskId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        broadcast(buildBoard());
      } catch (e) {
        const statusCode = e.code === 'has_children' ? 409 : 404;
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.code || e.message }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // Static files
  let urlPath = req.url.split('?')[0]; // strip query string
  urlPath = decodeURIComponent(urlPath);
  if (urlPath === '/') urlPath = '/index.html';
  // resolve to absolute, preventing path traversal
  let filePath = path.normalize(path.join(publicDir, urlPath));

  // Security: prevent path traversal
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// ============================================================
// WebSocket
// ============================================================

const wss = new WebSocketServer({ server });

function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(json);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('[ws] Client connected');
  // 接続時に現在のボードを送信
  const board = buildBoard();
  ws.send(JSON.stringify(board));
});

// ============================================================
// Start
// ============================================================
// BT-194: mdファイル監視(fs.watch(BACKLOG_DIR,...))と_counter.md初期化(ensureCounter)は、
// 全APIのDB化完了に伴い削除した。DBはtasksRepo経由の各APIハンドラが直接更新し、
// 都度broadcast(buildBoard())しているためファイル変更検知は不要。

server.listen(PORT, () => {
  console.log(`[backlog-dashboard] Listening on http://localhost:${PORT}`);
});
