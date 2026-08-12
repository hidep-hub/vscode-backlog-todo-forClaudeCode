'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { spawn, execFileSync } = require('child_process');
const githubClient = require('./github-client');

// --- Config ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = config.port || 3333;
const BACKLOG_DIR = config.backlogDir.replace(/^~/, os.homedir());
const COUNTER_FILE = path.join(BACKLOG_DIR, '_counter.md');
const GITHUB_CREDENTIALS_PATH = path.join(__dirname, 'github-credentials.json');

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

// --- Status Validation ---
// config.json の columns[].match に定義された値だけを「正当なステータス」として扱う。
// PowerShellのInvoke-RestMethod等でリクエストボディの日本語が文字化けし「???」等の
// 不正な値がmdファイルに書き込まれる事故を防ぐためのガード（KT-052）。
// reloadConfig() で config.columns が変わるたびに作り直すため let にしている。
let VALID_STATUSES = new Set(
  (config.columns || []).flatMap(col => col.match || [])
);

/**
 * ステータス値が既知の値と一致するかを検証する。
 * 未知の値（文字化けした "???" 等）を弾くためのガード。
 * @param {string} status
 * @returns {boolean}
 */
function isValidStatus(status) {
  return typeof status === 'string' && VALID_STATUSES.has(status);
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

  VALID_STATUSES = new Set(
    (config.columns || []).flatMap(col => col.match || [])
  );

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
// Counter (_counter.md) Management
// ============================================================

/**
 * _counter.md を読み込み { prefix: nextNumber } を返す
 * ファイルがなければ null を返す
 */
function readCounter() {
  if (!fs.existsSync(COUNTER_FILE)) return null;
  const content = fs.readFileSync(COUNTER_FILE, 'utf8');
  const counter = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\|\s*([A-Z]{2})\s*\|\s*(\d+)\s*\|/);
    if (m) {
      counter[m[1]] = parseInt(m[2], 10);
    }
  }
  return counter;
}

/**
 * カウンターオブジェクトを _counter.md に書き出す
 * @param {Object} counter - { prefix: nextNumber }
 */
function writeCounter(counter) {
  const lines = [
    '# Backlog Counter',
    '',
    '| prefix | next |',
    '|--------|------|',
  ];
  // プロジェクト定義順に出力
  const allPrefixes = getAllPrefixes();
  for (const prefix of allPrefixes) {
    const next = counter[prefix] || 1;
    lines.push(`| ${prefix} | ${String(next).padStart(3, '0')} |`);
  }
  // config に未定義だがカウンターに存在するプレフィクス（EP等の残骸）
  for (const [prefix, next] of Object.entries(counter)) {
    if (!allPrefixes.includes(prefix)) {
      lines.push(`| ${prefix} | ${String(next).padStart(3, '0')} |`);
    }
  }
  lines.push('');
  fs.writeFileSync(COUNTER_FILE, lines.join('\n'), 'utf8');
  console.log('[counter] Written:', COUNTER_FILE);
}

/**
 * 全バックログmdをスキャンし、各プレフィクスの最大番号を検出
 * → next = max + 1 としてカウンターを初期化・書き出す
 */
function initCounter() {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  const maxMap = {}; // { prefix: maxNumber }

  for (const file of files) {
    const content = fs.readFileSync(path.join(BACKLOG_DIR, file), 'utf8');
    const matches = content.matchAll(/\[([A-Z]{2})-(\d{3})\]/g);
    for (const m of matches) {
      const prefix = m[1];
      const num = parseInt(m[2], 10);
      if (!maxMap[prefix] || maxMap[prefix] < num) {
        maxMap[prefix] = num;
      }
    }
  }

  // next = max + 1 (見つからないプレフィクスは 1)
  const counter = {};
  for (const prefix of getAllPrefixes()) {
    counter[prefix] = (maxMap[prefix] || 0) + 1;
  }

  writeCounter(counter);
  console.log('[counter] Initialized from existing backlogs:', counter);
  return counter;
}

/**
 * カウンターを読み込む。なければ初期化する。
 */
function ensureCounter() {
  let counter = readCounter();
  if (!counter || Object.keys(counter).length === 0) {
    counter = initCounter();
  }
  return counter;
}

/**
 * 指定プレフィクスの次のIDを採番してカウンターを更新
 * @param {string} prefix - e.g. "KT"
 * @returns {string} - e.g. "KT-016"
 */
function allocateId(prefix) {
  const counter = ensureCounter();
  const next = counter[prefix] || 1;
  const id = `${prefix}-${String(next).padStart(3, '0')}`;
  counter[prefix] = next + 1;
  writeCounter(counter);
  return id;
}

/**
 * ファイル名からプレフィクスを逆引き
 * @param {string} fileName - e.g. "kiro-todo"
 * @returns {string|null}
 */
function prefixForFile(fileName) {
  const proj = (config.projects || []).find(p => p.file === fileName || p.file.toLowerCase() === fileName.toLowerCase());
  return proj ? proj.prefix : null;
}

// ============================================================
// Workspace API (BT-049)
// ============================================================

/**
 * タスクIDが属するbacklogファイルを特定し、対応する config.projects[] エントリを返す
 * @param {string} taskId
 * @returns {object|null} - config.projects[] の要素、見つからなければ null
 */
function findProjectEntryForTask(taskId) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  const h3Regex = new RegExp(`^###\\s+\\[${escapeRegex(taskId)}\\]`, 'm');
  const h4Regex = new RegExp(`^####\\s+\\[${escapeRegex(taskId)}\\]`, 'm');

  for (const file of files) {
    const content = fs.readFileSync(path.join(BACKLOG_DIR, file), 'utf8');
    if (h3Regex.test(content) || h4Regex.test(content)) {
      const baseName = path.basename(file, '.backlog.md');
      return (config.projects || []).find(p => p.file === baseName || p.file.toLowerCase() === baseName.toLowerCase()) || null;
    }
  }
  return null;
}

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

function openWorkspace(taskId) {
  const project = findProjectEntryForTask(taskId);
  if (!project) {
    return { success: false, error: `Task ${taskId} not found` };
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

function projectTemplate(name) {
  return `# ${name} バックログ

## 🔥 次やる

## 💡 アイデア／保留

## ✅ 完了（アーカイブ）

| 完了日 | ts | 親 | ID | 件名 |
|---|---|---|---|---|
`;
}

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
  const counter = readCounter();
  if (counter && counter[prefix]) {
    return { success: false, error: `Prefix "${prefix}" already exists in _counter.md (past project residue)` };
  }

  const mdPath = path.join(BACKLOG_DIR, `${file}.backlog.md`);
  if (fs.existsSync(mdPath)) {
    return { success: false, error: `${file}.backlog.md already exists` };
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
  fs.writeFileSync(mdPath, projectTemplate(displayName), 'utf8');
  console.log(`[api] Created ${file}.backlog.md`);

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

// --- MIME Types ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ============================================================
// Markdown Parser
// ============================================================

// ステータスの進捗順序（数字が大きいほど進んでいる）
const STATUS_ORDER = {
  '保留': 0,
  '未着手': 1,
  '未着手（素材あり）': 2,
  '進行中': 3,
  '完了': 4,
};

function getStatusRank(status) {
  return STATUS_ORDER[status] !== undefined ? STATUS_ORDER[status] : 1;
}

/**
 * 親ステータスを計算する（C案）
 * - 子が全て完了 → '完了'
 * - そうでなければ → 子の最大進捗（完了を除く）vs 親の明示ステータス の大きい方
 */
function computeParentStatus(children, parentOwnStatus) {
  if (!children || children.length === 0) return parentOwnStatus;

  const allDone = children.every(c => c.status === '完了');
  if (allDone) return '完了';

  // 完了していない子の中で最大進捗を探す
  let maxRank = 0;
  let maxStatus = '未着手';

  for (const child of children) {
    if (child.status === '完了') continue; // 完了は除外して集計
    const rank = getStatusRank(child.status);
    if (rank > maxRank) {
      maxRank = rank;
      maxStatus = child.status;
    }
  }

  // C案: 親の明示ステータスと子の最大進捗の大きい方を採用
  const parentRank = getStatusRank(parentOwnStatus);
  return parentRank > maxRank ? parentOwnStatus : maxStatus;
}

function parseBacklogFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const fileName = path.basename(filePath, '.backlog.md');
  const tasks = [];

  // プロジェクト表示名: # <name> バックログ
  const titleMatch = content.match(/^#\s+(.+?)[\s]*バックログ/m);
  const projectName = titleMatch ? titleMatch[1].trim() : fileName;

  const lines = content.split(/\r?\n/);
  let currentSection = null; // セクション名 (🔥 / 💡 / ✅)
  let currentTask = null;    // h3 タスク（カード化対象）
  let currentChild = null;   // h4 子タスク（カードにしない）

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // セクション検出: ## 🔥 / ## 💡 / ## ✅
    const sectionMatch = line.match(/^##\s+(.*)/);
    if (sectionMatch) {
      // 前の子タスクを確定
      if (currentChild && currentTask) {
        currentTask.children.push(currentChild);
        currentChild = null;
      }
      // 前タスクを確定
      if (currentTask) tasks.push(currentTask);
      currentTask = null;

      const sectionText = sectionMatch[1];
      if (sectionText.includes('🔥')) currentSection = 'active';
      else if (sectionText.includes('💡')) currentSection = 'hold';
      else if (sectionText.includes('✅')) currentSection = 'done';
      else currentSection = null;
      continue;
    }

    // 完了テーブル行: | YYYY-MM-DD | 親 | ID | 件名 |（BT-066以降は | YYYY-MM-DD | ts | 親 | ID | 件名 |）
    if (currentSection === 'done' && line.match(/^\|.*\|$/)) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      // ヘッダー行/セパレータをスキップ
      if (cells.length >= 4 && cells[0].match(/^\d{4}-\d{2}-\d{2}$/)) {
        const hasTs = cells.length >= 5 && /^\d{2}:\d{2}:\d{2}$/.test(cells[1]);
        const offset = hasTs ? 1 : 0;
        tasks.push({
          id: cells[2 + offset] || '-',
          title: cells[3 + offset],
          project: projectName,
          status: '完了',
          category: '-',
          completedDate: cells[0],
          completedTs: hasTs ? cells[1] : '',
        });
      }
      continue;
    }

    // h3 タスク開始: ### [<ID>] <件名>
    const taskMatch = line.match(/^###\s+\[([^\]]+)\]\s+(.+)/);
    if (taskMatch) {
      // 前の子タスクを確定
      if (currentChild && currentTask) {
        currentTask.children.push(currentChild);
        currentChild = null;
      }
      // 前タスクを確定
      if (currentTask) tasks.push(currentTask);

      currentTask = {
        id: taskMatch[1],
        title: taskMatch[2].trim(),
        project: projectName,
        status: currentSection === 'hold' ? '保留' : '未着手',
        category: '-',
        description: '',
        children: [],          // h4 子タスク格納用
      };
      continue;
    }

    // h4 子タスク開始: #### [<ID>] <件名>（親:XXX）
    const childMatch = line.match(/^####\s+\[([^\]]+)\]\s+(.+)/);
    if (childMatch && currentTask) {
      // 前の子タスクを確定
      if (currentChild) {
        currentTask.children.push(currentChild);
      }
      // タイトルから「（親:XXX）」を除去
      const rawTitle = childMatch[2].trim();
      const cleanTitle = rawTitle.replace(/[（(]親[:：].+?[）)]\s*$/, '').trim();

      currentChild = {
        id: childMatch[1],
        title: cleanTitle,
        status: currentSection === 'hold' ? '保留' : '未着手',
        category: '-',
        description: '',
      };
      continue;
    }

    // フィールド: - <key>: <value>
    const fieldMatch = line.match(/^\s*-\s+(.+?)[:：]\s*(.*)/);
    if (fieldMatch) {
      const key = fieldMatch[1].trim();
      const value = fieldMatch[2].trim();

      // 子タスクのフィールド（currentChild が存在する場合はそちらに適用）
      const target = currentChild || currentTask;
      if (!target) continue;

      switch (key) {
        case '状態':
          target.status = value;
          break;
        case '分類':
          target.category = value;
          break;
        case '説明':
          target.description = value;
          // 次の行が継続行なら取り込む（- で始まらず # でも始まらない非空行）
          while (i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            if (!nextLine.trim()) break; // 空行で終了
            if (/^\s*-\s+/.test(nextLine)) break; // 次のフィールド
            if (/^#{1,4}\s/.test(nextLine)) break; // 次のヘッダー
            target.description += '\n' + nextLine.trim();
            i++;
          }
          break;
        case '担当':
          target.assignee = value;
          break;
        case '開始日':
          target.startDate = value;
          break;
        case '期日':
          target.dueDate = value;
          break;
        case '起源':
          target.origin = value;
          break;
        case '成果物':
          // カンマ区切りで配列に格納（前後の空白をトリム）
          target.artifacts = value.split(',').map(s => s.trim()).filter(Boolean);
          break;
        case '完了日':
          target.completedDate = value;
          break;
        case 'github_issue_number':
          target.githubIssueNumber = value;
          break;
        case 'github_issue_url':
          target.githubIssueUrl = value;
          break;
        case '今日やる':
          if (value === 'true') target.todayFlag = true;
          break;
        case '実行中':
          if (value === 'true') target.running = true;
          break;
      }
    }
  }

  // 最後の子タスクを確定
  if (currentChild && currentTask) {
    currentTask.children.push(currentChild);
  }
  // 最後のタスクを追加
  if (currentTask) tasks.push(currentTask);

  // --- 集約処理: 子を持つ親にバッジと自動ステータスを付与 ---
  for (const task of tasks) {
    if (task.children && task.children.length > 0) {
      const total = task.children.length;
      const done = task.children.filter(c => c.status === '完了').length;
      task.childrenTotal = total;
      task.childrenDone = done;
      // 親のステータスを子の最大進捗から自動計算
      task.status = computeParentStatus(task.children, task.status);
      // 子の「今日やる」フラグ数を集約
      const todayCount = task.children.filter(c => c.todayFlag).length;
      if (todayCount > 0) {
        task.todayCount = todayCount;
      }
      // 子の「実行中」フラグを親に伝播
      if (task.children.some(c => c.running)) {
        task.running = true;
      }
    }
  }

  return tasks;
}

function parseAllBacklogs() {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  const allTasks = [];
  for (const file of files) {
    try {
      const tasks = parseBacklogFile(path.join(BACKLOG_DIR, file));
      allTasks.push(...tasks);
    } catch (e) {
      console.error(`[parser] Error parsing ${file}:`, e.message);
    }
  }

  // アーカイブから完了チケットの詳細情報をマージ
  mergeArchiveDetails(allTasks);

  // 同一IDの重複排除: 詳細版（description/artifacts/childrenあり）を優先
  const deduped = [];
  const seen = new Map(); // id -> index in deduped
  for (const task of allTasks) {
    if (!task.id || task.id === '-') {
      deduped.push(task);
      continue;
    }
    if (seen.has(task.id)) {
      const existingIdx = seen.get(task.id);
      const existing = deduped[existingIdx];
      // 詳細が多い方を優先（description, artifacts, children で判定）
      const existingScore = (existing.description ? 1 : 0) + (existing.artifacts ? 1 : 0) + ((existing.children && existing.children.length) ? 1 : 0);
      const newScore = (task.description ? 1 : 0) + (task.artifacts ? 1 : 0) + ((task.children && task.children.length) ? 1 : 0);
      if (newScore > existingScore) {
        // 新しい方が詳細 → completedDateだけは古い方から引き継ぐ
        if (existing.completedDate && !task.completedDate) {
          task.completedDate = existing.completedDate;
        }
        deduped[existingIdx] = task;
      } else {
        // 既存の方が詳細 or 同スコア → completedDateだけ引き継ぐ
        if (task.completedDate && !existing.completedDate) {
          existing.completedDate = task.completedDate;
        }
      }
    } else {
      seen.set(task.id, deduped.length);
      deduped.push(task);
    }
  }

  return deduped;
}

/**
 * archive/*.archive.md を読み込み、完了チケットに詳細情報（説明・成果物等）をマージする
 */
function mergeArchiveDetails(allTasks) {
  const archiveDir = path.join(BACKLOG_DIR, 'archive');
  if (!fs.existsSync(archiveDir)) return;

  const archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.archive.md'));
  const archiveMap = {}; // id -> { description, artifacts, ... }

  for (const file of archiveFiles) {
    try {
      const content = fs.readFileSync(path.join(archiveDir, file), 'utf8');
      const lines = content.split(/\r?\n/);
      let current = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // ## [ID] タイトル... のパターン
        const headerMatch = line.match(/^##\s+\[([^\]]+)\]\s+/);
        if (headerMatch) {
          if (current) archiveMap[current.id] = current;
          current = { id: headerMatch[1] };
          continue;
        }

        if (!current) continue;

        // フィールド: - key: value
        const fieldMatch = line.match(/^\s*-\s+(.+?)[:：]\s*(.*)/);
        if (fieldMatch) {
          const key = fieldMatch[1].trim();
          const value = fieldMatch[2].trim();
          switch (key) {
            case '説明':
              current.description = value;
              while (i + 1 < lines.length) {
                const nextLine = lines[i + 1];
                if (!nextLine.trim()) break;
                if (/^\s*-\s+/.test(nextLine)) break;
                if (/^#{1,4}\s/.test(nextLine)) break;
                current.description += '\n' + nextLine.trim();
                i++;
              }
              break;
            case '成果物':
              current.artifacts = value.split(',').map(s => s.trim()).filter(Boolean);
              break;
            case '分類':
              current.category = value;
              break;
            case '担当':
              current.assignee = value;
              break;
          }
        }
      }
      if (current) archiveMap[current.id] = current;
    } catch (e) {
      console.error(`[archive] Error parsing ${file}:`, e.message);
    }
  }

  // 完了タスクにアーカイブの詳細をマージ
  for (const task of allTasks) {
    if (task.status === '完了' && archiveMap[task.id]) {
      const detail = archiveMap[task.id];
      if (detail.description && !task.description) task.description = detail.description;
      if (detail.artifacts) task.artifacts = detail.artifacts;
      if (detail.category && task.category === '-') task.category = detail.category;
      if (detail.assignee && !task.assignee) task.assignee = detail.assignee;
    }
  }
}

function buildBoard() {
  const allTasks = parseAllBacklogs();
  const columns = config.columns.map(col => {
    let items = allTasks.filter(t => col.match.includes(t.status));
    const totalCount = items.length;
    // 完了カラムは日付新しい順、同日内はID降順（新しい番号が上）にソート
    if (col.compact || col.id === 'done') {
      items.sort((a, b) => {
        const da = a.completedDate || '0000-00-00';
        const db = b.completedDate || '0000-00-00';
        const dateCmp = db.localeCompare(da); // 降順（新しい順）
        if (dateCmp !== 0) return dateCmp;
        // 同日ならts（完了時刻）降順。ts未記録の旧データはID降順にフォールバック（BT-066）
        if (a.completedTs && b.completedTs) {
          const tsCmp = b.completedTs.localeCompare(a.completedTs);
          if (tsCmp !== 0) return tsCmp;
        }
        return (b.id || '').localeCompare(a.id || '');
      });
    }
    // limitはフロント側で制御するため、サーバーでは切らない（全件返す）
    return {
      id: col.id,
      label: col.label,
      match: col.match,
      items,
      totalCount,
      limit: col.limit || null,
      visibleFields: col.visibleFields || null,
      compact: col.compact || false,
    };
  });

  // プロジェクト一覧を抽出（タスクが1件も無い新規作成直後のワークスペースもフィルタに
  // 出したいため、config.projects[]の全件とタスク由来のproject名の和集合にする）
  const projectsFromConfig = (config.projects || []).map(p => p.name).filter(Boolean);
  const projectsFromTasks = allTasks.map(t => t.project).filter(Boolean);
  const projects = [...new Set([...projectsFromConfig, ...projectsFromTasks])].sort();

  // プロジェクト別残タスク数（完了以外のh3タスク）
  const remainingByProject = {};
  for (const t of allTasks) {
    if (!t.project || t.status === '完了') continue;
    remainingByProject[t.project] = (remainingByProject[t.project] || 0) + 1;
  }

  return { columns, projects, remainingByProject, updatedAt: new Date().toISOString(), workspaceMap: getWorkspaceMap(), workspaceFilterMap: getWorkspaceFilterMap(), projectFileMap: getProjectFileMap(), projectPrefixMap: getProjectPrefixMap(), defaultWorkspaceParent: config.defaultWorkspaceParent || '' };
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

// ============================================================
// Status Update API
// ============================================================

/**
 * mdファイル内の指定タスクのステータスを書き換える
 * @param {string} taskId - タスクID (e.g. "KT-007")
 * @param {string} newStatus - 新しいステータス (e.g. "進行中")
 * @param {boolean} isChild - 子タスク(h4)かどうか
 * @returns {{ success: boolean, file?: string, error?: string }}
 */
/**
 * タスクブロック(headerIdx直後〜blockEnd)に「- commit: <hash1>,<hash2>」を追加・更新する(BT-119)
 * 完了日行の直後（無ければヘッダー直後）に挿入する。ブロックが削除されるケース
 * (h3単発タスク完了)では呼び出し側で呼ばないこと。
 */
function insertOrUpdateCommitField(lines, headerIdx, blockEnd, commitHashes) {
  const value = commitHashes.join(',');
  let fieldIdx = -1;
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    if (/^\s*-\s+commit[:：]/.test(lines[i])) { fieldIdx = i; break; }
  }
  if (fieldIdx !== -1) {
    lines[fieldIdx] = `- commit: ${value}`;
    return;
  }
  let insertAt = headerIdx + 1;
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    if (/^\s*-\s+完了日[:：]/.test(lines[i])) { insertAt = i + 1; break; }
  }
  lines.splice(insertAt, 0, `- commit: ${value}`);
}

function updateTaskStatus(taskId, newStatus, isChild = false, commitHashes = []) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  for (const file of files) {
    const filePath = path.join(BACKLOG_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    // タスクヘッダーを探す (h3 or h4)
    // isChild=false の場合、h3で見つからなければh4にフォールバック
    const h3Regex = new RegExp(`^###\\s+\\[${escapeRegex(taskId)}\\]`);
    const h4Regex = new RegExp(`^####\\s+\\[${escapeRegex(taskId)}\\]`);

    let taskLineIdx = -1;
    if (isChild) {
      // 明示的にh4指定
      for (let i = 0; i < lines.length; i++) {
        if (h4Regex.test(lines[i])) { taskLineIdx = i; break; }
      }
    } else {
      // h3を探す → 見つからなければh4にフォールバック
      for (let i = 0; i < lines.length; i++) {
        if (h3Regex.test(lines[i])) { taskLineIdx = i; break; }
      }
      if (taskLineIdx === -1) {
        for (let i = 0; i < lines.length; i++) {
          if (h4Regex.test(lines[i])) { taskLineIdx = i; break; }
        }
      }
    }

    if (taskLineIdx === -1) continue; // このファイルにはない

    // タスクヘッダーの次の行から「- 状態:」を探す
    // 次のh3/h4/h2が来るまでの範囲内で
    let statusLineIdx = -1;
    for (let i = taskLineIdx + 1; i < lines.length; i++) {
      if (/^#{2,4}\s/.test(lines[i])) break; // 次のセクション/タスク
      if (/^\s*-\s+状態[:：]/.test(lines[i])) {
        statusLineIdx = i;
        break;
      }
    }

    if (statusLineIdx !== -1) {
      // 既存の「- 状態:」行を書き換え
      lines[statusLineIdx] = `- 状態: ${newStatus}`;
    } else {
      // 「- 状態:」行がない場合、ヘッダー直後に挿入
      lines.splice(taskLineIdx + 1, 0, `- 状態: ${newStatus}`);
    }

    // 完了時: 「今日やる」「実行中」フラグを自動解除 + 完了日付与
    if (newStatus === '完了') {
      // タスクブロック範囲を再計算（状態行挿入で行数が変わっている可能性）
      let blockEnd = lines.length;
      for (let i = taskLineIdx + 1; i < lines.length; i++) {
        if (/^#{2,4}\s/.test(lines[i])) { blockEnd = i; break; }
      }
      for (let i = taskLineIdx + 1; i < blockEnd; i++) {
        if (/^\s*-\s+今日やる[:：]/.test(lines[i])) {
          lines.splice(i, 1);
          blockEnd--;
          break;
        }
      }
      for (let i = taskLineIdx + 1; i < blockEnd; i++) {
        if (/^\s*-\s+実行中[:：]/.test(lines[i])) {
          lines.splice(i, 1);
          blockEnd--;
          break;
        }
      }
      // 完了日を付与（JST）
      const now = new Date();
      const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const dateStr = jstDate.toISOString().slice(0, 10);
      const tsStr = jstDate.toISOString().slice(11, 19); // 完了カラムの並び順用（BT-066）
      let completedLineIdx = -1;
      for (let i = taskLineIdx + 1; i < blockEnd; i++) {
        if (/^\s*-\s+完了日[:：]/.test(lines[i])) {
          completedLineIdx = i;
          break;
        }
      }
      if (completedLineIdx !== -1) {
        // 既存の完了日を上書き
        lines[completedLineIdx] = `- 完了日: ${dateStr}`;
      } else {
        // 状態行の直後に挿入
        const insertIdx = statusLineIdx !== -1 ? statusLineIdx + 1 : taskLineIdx + 1;
        lines.splice(insertIdx, 0, `- 完了日: ${dateStr}`);
      }

      // h3単発タスク（子を持たない）が完了した場合、🔥/💡ブロックから
      // 完了テーブルへ自動移動する（BT-017）。h4子タスクとEpic（子あり）は対象外。
      if (!isChild && h3Regex.test(lines[taskLineIdx])) {
        let archiveBlockEnd = lines.length;
        for (let i = taskLineIdx + 1; i < lines.length; i++) {
          if (/^#{2,3}\s/.test(lines[i])) { archiveBlockEnd = i; break; }
        }
        const hasChildren = lines.slice(taskLineIdx + 1, archiveBlockEnd).some(l => /^####\s+\[/.test(l));

        if (!hasChildren) {
          const headerMatch = lines[taskLineIdx].match(/^###\s+\[([^\]]+)\]\s+(.+)/);
          const title = headerMatch ? headerMatch[2].trim() : '';

          lines.splice(taskLineIdx, archiveBlockEnd - taskLineIdx);

          let doneSectionIdx = -1;
          for (let i = 0; i < lines.length; i++) {
            if (/^##\s+.*✅/.test(lines[i])) { doneSectionIdx = i; break; }
          }
          if (doneSectionIdx !== -1) {
            let tableEnd = lines.length;
            for (let i = doneSectionIdx + 1; i < lines.length; i++) {
              if (/^##\s/.test(lines[i])) { tableEnd = i; break; }
            }
            let insertAt = tableEnd;
            while (insertAt > doneSectionIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
            lines.splice(insertAt, 0, `| ${dateStr} | ${tsStr} | - | ${taskId} | ${title} |`);
          }
        } else if (commitHashes.length > 0) {
          // Epic（子あり）: ブロックは削除されず残るのでcommitフィールドを追記する（BT-119）
          insertOrUpdateCommitField(lines, taskLineIdx, archiveBlockEnd, commitHashes);
        }
      } else if (isChild && commitHashes.length > 0) {
        // h4子タスク: ブロックは残るのでcommitフィールドを追記する（BT-119）
        let childBlockEnd = lines.length;
        for (let i = taskLineIdx + 1; i < lines.length; i++) {
          if (/^#{2,4}\s/.test(lines[i])) { childBlockEnd = i; break; }
        }
        insertOrUpdateCommitField(lines, taskLineIdx, childBlockEnd, commitHashes);
      }
    } else {
      // 完了以外に変更: 完了日行があれば削除
      let blockEnd = lines.length;
      for (let i = taskLineIdx + 1; i < lines.length; i++) {
        if (/^#{2,4}\s/.test(lines[i])) { blockEnd = i; break; }
      }
      for (let i = taskLineIdx + 1; i < blockEnd; i++) {
        if (/^\s*-\s+完了日[:：]/.test(lines[i])) {
          lines.splice(i, 1);
          break;
        }
      }
    }

    // ファイル書き戻し
    const newContent = lines.join('\n');
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`[api] Updated ${taskId} -> ${newStatus} in ${file}`);
    return { success: true, file };
  }

  return { success: false, error: `Task ${taskId} not found` };
}

/**
 * タスクの「今日やる」フラグをトグルする
 * @param {string} taskId - タスクID
 * @param {boolean} isChild - h4子タスクか
 * @param {boolean} value - true=ON, false=OFF
 * @returns {{ success: boolean, todayFlag?: boolean, error?: string }}
 */
function toggleTodayFlag(taskId, isChild = false, value = true) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  for (const file of files) {
    const filePath = path.join(BACKLOG_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    let lines = content.split(/\r?\n/);

    // タスクヘッダーを探す
    // isChild=false の場合、h3で見つからなければh4にフォールバック
    const h3Regex = new RegExp(`^###\\s+\\[${escapeRegex(taskId)}\\]`);
    const h4Regex = new RegExp(`^####\\s+\\[${escapeRegex(taskId)}\\]`);

    let taskLineIdx = -1;
    if (isChild) {
      for (let i = 0; i < lines.length; i++) {
        if (h4Regex.test(lines[i])) { taskLineIdx = i; break; }
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (h3Regex.test(lines[i])) { taskLineIdx = i; break; }
      }
      if (taskLineIdx === -1) {
        for (let i = 0; i < lines.length; i++) {
          if (h4Regex.test(lines[i])) { taskLineIdx = i; break; }
        }
      }
    }

    if (taskLineIdx === -1) continue;

    // --- 単一タスクのフラグを操作するヘルパー（lines配列を直接変更） ---
    function applyFlag(startIdx, lines) {
      // ブロック範囲を特定（次のh2/h3/h4まで）
      let blockEnd = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^#{2,4}\s/.test(lines[i])) { blockEnd = i; break; }
      }

      // 既存の「- 今日やる:」行を探す
      let todayLineIdx = -1;
      for (let i = startIdx + 1; i < blockEnd; i++) {
        if (/^\s*-\s+今日やる[:：]/.test(lines[i])) {
          todayLineIdx = i;
          break;
        }
      }

      if (value) {
        if (todayLineIdx === -1) {
          let insertAfter = startIdx;
          for (let i = startIdx + 1; i < blockEnd; i++) {
            if (/^\s*-\s+状態[:：]/.test(lines[i])) { insertAfter = i; break; }
          }
          lines.splice(insertAfter + 1, 0, '- 今日やる: true');
          return 1; // 1行挿入した
        }
      } else {
        if (todayLineIdx !== -1) {
          lines.splice(todayLineIdx, 1);
          return -1; // 1行削除した
        }
      }
      return 0; // 変更なし
    }

    // 自身のフラグを操作（子タスクの場合、または子を持たない親タスクの場合）
    if (isChild) {
      applyFlag(taskLineIdx, lines);
    } else {
      // 親タスク: 配下のh4子タスクを全て一括操作
      // まず親のブロック範囲を特定（次のh2/h3まで）
      let parentEnd = lines.length;
      for (let i = taskLineIdx + 1; i < lines.length; i++) {
        if (/^#{2,3}\s/.test(lines[i])) { parentEnd = i; break; }
      }

      // 配下のh4子タスクを収集
      const childIndices = [];
      for (let i = taskLineIdx + 1; i < parentEnd; i++) {
        if (/^####\s+\[/.test(lines[i])) {
          childIndices.push(i);
        }
      }

      if (childIndices.length > 0) {
        // 子がある場合: 子を全て一括操作（後ろから処理して行番号ズレを回避）
        for (let c = childIndices.length - 1; c >= 0; c--) {
          applyFlag(childIndices[c], lines);
        }
      } else {
        // 子がない単発タスク: 自身にフラグ操作
        applyFlag(taskLineIdx, lines);
      }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    console.log(`[api] Toggle today flag: ${taskId} -> ${value} (isChild=${isChild}) in ${file}`);
    return { success: true, taskId, todayFlag: value };
  }

  return { success: false, error: `Task ${taskId} not found` };
}

/**
 * タスクの「実行中」フラグをトグルする（単体操作、親子伝播なし）
 * @param {string} taskId - タスクID
 * @param {boolean} isChild - h4子タスクか
 * @param {boolean} value - true=ON, false=OFF
 * @returns {{ success: boolean, running?: boolean, error?: string }}
 */
function toggleRunning(taskId, isChild = false, value = true) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  for (const file of files) {
    const filePath = path.join(BACKLOG_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    // isChild=false の場合、h3で見つからなければh4にフォールバック
    const h3Regex = new RegExp(`^###\\s+\\[${escapeRegex(taskId)}\\]`);
    const h4Regex = new RegExp(`^####\\s+\\[${escapeRegex(taskId)}\\]`);

    let taskLineIdx = -1;
    if (isChild) {
      for (let i = 0; i < lines.length; i++) {
        if (h4Regex.test(lines[i])) { taskLineIdx = i; break; }
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (h3Regex.test(lines[i])) { taskLineIdx = i; break; }
      }
      if (taskLineIdx === -1) {
        for (let i = 0; i < lines.length; i++) {
          if (h4Regex.test(lines[i])) { taskLineIdx = i; break; }
        }
      }
    }

    if (taskLineIdx === -1) continue;

    let blockEnd = lines.length;
    for (let i = taskLineIdx + 1; i < lines.length; i++) {
      if (/^#{2,4}\s/.test(lines[i])) { blockEnd = i; break; }
    }

    // 既存の「- 実行中:」行を探す
    let runLineIdx = -1;
    for (let i = taskLineIdx + 1; i < blockEnd; i++) {
      if (/^\s*-\s+実行中[:：]/.test(lines[i])) {
        runLineIdx = i;
        break;
      }
    }

    if (value) {
      if (runLineIdx === -1) {
        // 状態行の次に挿入
        let insertAfter = taskLineIdx;
        for (let i = taskLineIdx + 1; i < blockEnd; i++) {
          if (/^\s*-\s+状態[:：]/.test(lines[i])) { insertAfter = i; break; }
        }
        lines.splice(insertAfter + 1, 0, '- 実行中: true');
      }
    } else {
      if (runLineIdx !== -1) {
        lines.splice(runLineIdx, 1);
      }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    console.log(`[api] Toggle running: ${taskId} -> ${value} in ${file}`);
    return { success: true, taskId, running: value };
  }

  return { success: false, error: `Task ${taskId} not found` };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * mdファイル内のタスクブロック（h3 or h4）を並び替える
 * @param {string[]} orderedIds - 並び替え後のタスクID配列
 * @param {boolean} isChild - h4子タスクの並べ替えか
 * @param {string} [parentId] - isChild=true時の親タスクID
 * @returns {{ success: boolean, error?: string }}
 */
function reorderTasks(orderedIds, isChild = false, parentId = null) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  // h3(親タスク)の並べ替えは複数ワークスペース(複数ファイル)にまたがりうるため、
  // 「最初にヒットしたファイルでreturn」せず、該当ファイルを全て処理して変更有無を追跡する。
  let changed = false;

  for (const file of files) {
    const filePath = path.join(BACKLOG_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    if (isChild && parentId) {
      // --- 子タスク(h4)の並べ替え ---
      // 親(h3)を見つけ、その配下のh4ブロックを並べ替える
      const parentRegex = new RegExp(`^###\\s+\\[${escapeRegex(parentId)}\\]`);
      let parentIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (parentRegex.test(lines[i])) { parentIdx = i; break; }
      }
      if (parentIdx === -1) continue;

      // 親の範囲: 次のh2 or h3まで
      let parentEnd = lines.length;
      for (let i = parentIdx + 1; i < lines.length; i++) {
        if (/^#{2,3}\s/.test(lines[i])) { parentEnd = i; break; }
      }

      // h4ブロックを抽出
      const childBlocks = []; // { id, startLine, endLine }
      for (let i = parentIdx + 1; i < parentEnd; i++) {
        const m = lines[i].match(/^####\s+\[([^\]]+)\]/);
        if (m) {
          const blockStart = i;
          let blockEnd = parentEnd;
          for (let j = i + 1; j < parentEnd; j++) {
            if (/^####\s/.test(lines[j])) { blockEnd = j; break; }
          }
          childBlocks.push({ id: m[1], startLine: blockStart, endLine: blockEnd });
          i = blockEnd - 1; // skip to end of block
        }
      }

      // orderedIds に含まれるブロックだけ対象
      const blockMap = {};
      for (const b of childBlocks) { blockMap[b.id] = b; }

      // 全てのIDがこのファイルに存在するか確認
      const foundAll = orderedIds.every(id => blockMap[id]);
      if (!foundAll) continue;

      // 並べ替え実行: 元のブロック領域を削除して、新しい順序で挿入
      // ブロックの行データを収集
      const blockLines = {};
      for (const b of childBlocks) {
        blockLines[b.id] = lines.slice(b.startLine, b.endLine);
      }

      // 最初のh4ブロック開始位置
      const firstBlockStart = childBlocks[0].startLine;
      // 最後のh4ブロック終了位置
      const lastBlockEnd = childBlocks[childBlocks.length - 1].endLine;

      // h4ブロック以外の行（親のフィールド行など）を保持
      const beforeBlocks = lines.slice(parentIdx + 1, firstBlockStart);

      // 新しい順序でh4ブロックを組み立て
      const reordered = [];
      for (const id of orderedIds) {
        reordered.push(...blockLines[id]);
      }
      // orderedIdsに含まれないブロック（あれば末尾に）
      for (const b of childBlocks) {
        if (!orderedIds.includes(b.id)) {
          reordered.push(...blockLines[b.id]);
        }
      }

      // 再構築
      const newLines = [
        ...lines.slice(0, parentIdx + 1),
        ...beforeBlocks,
        ...reordered,
        ...lines.slice(lastBlockEnd),
      ];

      fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
      console.log(`[api] Reordered children of ${parentId} in ${file}`);
      return { success: true };

    } else {
      // --- 親タスク(h3)の並べ替え ---
      // h3ブロックを特定: 各h3の開始行〜次のh3 or h2の直前
      const h3Blocks = []; // { id, startLine, endLine, section }
      let currentSection = null;

      for (let i = 0; i < lines.length; i++) {
        const secMatch = lines[i].match(/^##\s+(.*)/);
        if (secMatch) {
          if (secMatch[1].includes('🔥')) currentSection = 'active';
          else if (secMatch[1].includes('💡')) currentSection = 'hold';
          else if (secMatch[1].includes('✅')) currentSection = 'done';
          else currentSection = null;
          continue;
        }
        const taskMatch = lines[i].match(/^###\s+\[([^\]]+)\]/);
        if (taskMatch) {
          const blockStart = i;
          let blockEnd = lines.length;
          for (let j = i + 1; j < lines.length; j++) {
            if (/^#{2,3}\s/.test(lines[j])) { blockEnd = j; break; }
          }
          h3Blocks.push({ id: taskMatch[1], startLine: blockStart, endLine: blockEnd, section: currentSection });
          i = blockEnd - 1;
        }
      }

      // 【案A】このファイルに存在する orderedIds だけを対象にする。
      // 複数WSが混在するカラムでは orderedIds が複数ファイルにまたがるため、
      // 全IDが揃う事を要求せず「このファイル内の対象IDの相対順」だけを反映する。
      const blockMap = {};
      for (const b of h3Blocks) { blockMap[b.id] = b; }

      const fileIds = orderedIds.filter(id => blockMap[id]);
      if (fileIds.length < 2) continue; // このファイルに並べ替え対象が1件以下なら何もしない

      // 基準セクション = このファイル内 orderedIds の先頭が属するセクション
      const targetSection = blockMap[fileIds[0]].section;
      // 基準セクションに属する対象IDだけを、指定された相対順として使う
      const orderInSection = fileIds.filter(id => blockMap[id].section === targetSection);
      if (orderInSection.length < 2) continue;

      const sectionBlocks = h3Blocks.filter(b => b.section === targetSection);

      // セクション内の全ブロック行データを収集
      const blockLines = {};
      for (const b of sectionBlocks) {
        blockLines[b.id] = lines.slice(b.startLine, b.endLine);
      }

      // セクション内の最初と最後の位置
      const firstStart = sectionBlocks[0].startLine;
      const lastEnd = sectionBlocks[sectionBlocks.length - 1].endLine;

      // 【最小並べ替え】対象IDが元々占めていたスロットだけを新しい順で埋め直し、
      // 対象外ブロック（別ステータス等、同一セクションの他タスク）は元の位置に据え置く。
      const targetSet = new Set(orderInSection);
      let k = 0;
      const finalOrderIds = sectionBlocks.map(b =>
        targetSet.has(b.id) ? orderInSection[k++] : b.id
      );

      const reordered = [];
      for (const id of finalOrderIds) {
        reordered.push(...blockLines[id]);
      }

      // 変化が無ければ書き込まない
      const originalIds = sectionBlocks.map(b => b.id);
      if (JSON.stringify(finalOrderIds) === JSON.stringify(originalIds)) continue;

      // 再構築
      const newLines = [
        ...lines.slice(0, firstStart),
        ...reordered,
        ...lines.slice(lastEnd),
      ];

      fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
      console.log(`[api] Reordered h3 tasks in ${file}: [${orderInSection.join(', ')}]`);
      changed = true;
      // 他ファイルにも対象がありうるので return せず継続する
    }
  }

  if (changed) return { success: true };
  return { success: false, error: 'Tasks not found in any backlog file' };
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
// Task Completion -> GitHub Sync (BT-119)
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
 * タスク完了時、GitHub Issueに完了コメントを投稿してcloseする（BT-119）。
 * 失敗してもタスク完了自体は既に成功済みのため、ログ出力のみで握り潰す
 * （fire-and-forget。APIレスポンスをGitHub側の成否で待たせない）。
 * @param {string} prefix
 * @param {{id: string, description?: string, githubIssueNumber: string}} task
 * @param {string[]} commitHashes
 */
function syncCompletionToGithub(prefix, task, commitHashes) {
  const creds = readGithubCredentials()[prefix];
  if (!creds || !creds.repoUrl || !creds.token) return;

  const bodyLines = ['タスクが完了しました。', '', task.description || '(説明なし)'];
  if (commitHashes.length > 0) {
    bodyLines.push('', `コミット: ${commitHashes.join(', ')}`);
  }

  githubClient.issues.createComment(creds.repoUrl, creds.token, task.githubIssueNumber, bodyLines.join('\n'))
    .then(() => githubClient.issues.update(creds.repoUrl, creds.token, task.githubIssueNumber, { state: 'closed' }))
    .catch(e => console.error(`[github-sync] Failed to sync completion for ${task.id}:`, e.message));
}

// ============================================================
// Task Add API
// ============================================================

const INBOX_FILE = 'inbox.backlog.md';
const INBOX_TEMPLATE = `# Inbox バックログ

## 🔥 アクティブ

## 💡 アイデア／保留

## ✅ 完了（アーカイブ）

| 完了日 | ts | 親 | ID | 件名 |
|---|---|---|---|---|
`;

/**
 * inbox.backlog.md がなければ作成する
 */
function ensureInbox() {
  const filePath = path.join(BACKLOG_DIR, INBOX_FILE);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, INBOX_TEMPLATE, 'utf8');
    console.log(`[api] Created ${INBOX_FILE}`);
  }
  return filePath;
}

/**
 * mdファイルにタスクを追加する
 * @param {string} title - タスクタイトル
 * @param {string} project - プロジェクト名（ファイル名に対応）or 'inbox'
 * @param {string} status - 状態 (デフォルト: 未着手)
 * @param {string} origin - 起源 (user / claude)
 * @param {string} description - 説明
 * @param {{githubIssueNumber?: string, githubIssueUrl?: string}} extraFields - 追加フィールド(BT-078: GitHub Issue取り込み時の紐付け用)
 * @returns {{ success: boolean, id?: string, error?: string }}
 */
function addTask(title, project, status = '未着手', origin = 'user', description = '', extraFields = {}) {
  // ファイル特定
  let filePath;
  if (project === 'inbox' || !project) {
    filePath = ensureInbox();
  } else {
    // プロジェクト名からファイルを探す
    const files = fs.readdirSync(BACKLOG_DIR)
      .filter(f => f.endsWith('.backlog.md'));

    const match = files.find(f => {
      const name = path.basename(f, '.backlog.md');
      return name === project || name.toLowerCase() === project.toLowerCase();
    });

    if (match) {
      filePath = path.join(BACKLOG_DIR, match);
    } else {
      // 見つからなければ inbox に
      filePath = ensureInbox();
    }
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  // 🔥 アクティブセクションを探す
  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+.*🔥/.test(lines[i])) {
      activeIdx = i;
      break;
    }
  }

  if (activeIdx === -1) {
    return { success: false, error: 'Active section not found in file' };
  }

  // アクティブセクションの次のセクション(## )を探す → その直前に挿入
  let insertIdx = lines.length;
  for (let i = activeIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      insertIdx = i;
      break;
    }
  }

  // 自動採番: プロジェクトファイル名からプレフィクスを解決
  const baseName = path.basename(filePath, '.backlog.md');
  const prefix = prefixForFile(baseName);
  const taskId = prefix ? allocateId(prefix) : '未採番';

  // 空行調整: 直前が空行でなければ空行を入れる
  const descLines = description.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const taskBlock = [
    `### [${taskId}] ${title}`,
    `- 状態: ${status}`,
    ...(descLines.length > 0 ? [`- 説明: ${descLines[0]}`, ...descLines.slice(1)] : []),
    `- 起源: ${origin}`,
    ...(extraFields.githubIssueNumber ? [`- github_issue_number: ${extraFields.githubIssueNumber}`] : []),
    ...(extraFields.githubIssueUrl ? [`- github_issue_url: ${extraFields.githubIssueUrl}`] : []),
    '',
  ];

  // 挿入位置の直前に空行がなければ追加
  if (insertIdx > 0 && lines[insertIdx - 1].trim() !== '') {
    taskBlock.unshift('');
  }

  lines.splice(insertIdx, 0, ...taskBlock);

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`[api] Added task "${title}" as ${taskId} to ${path.basename(filePath)} (origin: ${origin})`);
  return { success: true, id: taskId };
}

/**
 * 親タスク(h3)の配下に子タスク(h4)を追加する
 * @param {string} title - 子タスクタイトル
 * @param {string} parentId - 親タスクのID
 * @param {string} status - 状態
 * @param {string} origin - 起源
 * @returns {{ success: boolean, error?: string }}
 */
function addChildTask(title, parentId, status = '未着手', origin = 'user', description = '', extraFields = {}) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  for (const file of files) {
    const filePath = path.join(BACKLOG_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    // 親(h3)を探す
    const parentRegex = new RegExp(`^###\\s+\\[${escapeRegex(parentId)}\\]`);
    let parentIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (parentRegex.test(lines[i])) { parentIdx = i; break; }
    }
    if (parentIdx === -1) continue;

    // 親の範囲の末尾(次のh2 or h3の直前)を探す
    let parentEnd = lines.length;
    for (let i = parentIdx + 1; i < lines.length; i++) {
      if (/^#{2,3}\s/.test(lines[i])) { parentEnd = i; break; }
    }

    // 自動採番: ファイル名からプレフィクスを解決
    const baseName = path.basename(file, '.backlog.md');
    const prefix = prefixForFile(baseName);
    const childId = prefix ? allocateId(prefix) : '未採番';

    // 親の末尾に子タスクブロックを挿入
    const descLines = description.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const childBlock = [
      `#### [${childId}] ${title}（親:${parentId}）`,
      `- 状態: ${status}`,
      ...(descLines.length > 0 ? [`- 説明: ${descLines[0]}`, ...descLines.slice(1)] : []),
      `- 起源: ${origin}`,
      ...(extraFields.githubIssueNumber ? [`- github_issue_number: ${extraFields.githubIssueNumber}`] : []),
      ...(extraFields.githubIssueUrl ? [`- github_issue_url: ${extraFields.githubIssueUrl}`] : []),
      '',
    ];

    // 挿入位置の直前に空行がなければ追加
    if (parentEnd > 0 && lines[parentEnd - 1].trim() !== '') {
      childBlock.unshift('');
    }

    lines.splice(parentEnd, 0, ...childBlock);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    console.log(`[api] Added child task "${title}" as ${childId} under ${parentId} in ${file} (origin: ${origin})`);
    return { success: true, id: childId };
  }

  return { success: false, error: `Parent task ${parentId} not found` };
}

/**
 * 既存のh3タスクを別の親(h3)の子(h4)へ後付けで変換する（同一ファイル内のみ）
 * @param {string[]} taskIds - 子にするタスクIDの配列
 * @param {string} parentId - 親タスクID
 * @returns {{ success: boolean, attached?: string[], failed?: {id:string, reason:string}[], error?: string }}
 */
function attachToParent(taskIds, parentId) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  // 親(h3)を含むファイルを特定
  let targetFile = null;
  for (const file of files) {
    const content = fs.readFileSync(path.join(BACKLOG_DIR, file), 'utf8');
    const parentRegex = new RegExp(`^###\\s+\\[${escapeRegex(parentId)}\\]`, 'm');
    if (parentRegex.test(content)) { targetFile = file; break; }
  }
  if (!targetFile) {
    return { success: false, error: `Parent task ${parentId} not found` };
  }

  const filePath = path.join(BACKLOG_DIR, targetFile);
  let lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  function findH3Block(id) {
    const regex = new RegExp(`^###\\s+\\[${escapeRegex(id)}\\]`);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) { start = i; break; }
    }
    if (start === -1) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
    }
    return { start, end };
  }

  const failed = [];
  const toMove = []; // { id, start, end }

  for (const taskId of taskIds) {
    if (taskId === parentId) {
      failed.push({ id: taskId, reason: 'self' });
      continue;
    }
    const block = findH3Block(taskId);
    if (!block) {
      failed.push({ id: taskId, reason: 'not_found_in_same_project' });
      continue;
    }
    const hasChildren = lines.slice(block.start + 1, block.end).some(l => /^####\s+\[/.test(l));
    if (hasChildren) {
      failed.push({ id: taskId, reason: 'has_children' });
      continue;
    }
    toMove.push({ id: taskId, start: block.start, end: block.end });
  }

  if (toMove.length === 0) {
    return { success: false, error: 'No valid tasks to attach', failed };
  }

  // ブロックを後ろ(行番号が大きい方)から順に削除し、行データを保持
  toMove.sort((a, b) => b.start - a.start);
  const blockLinesMap = {};
  for (const b of toMove) {
    const raw = lines.slice(b.start, b.end);
    // ヘッダー行変換: ### [ID] Title → #### [ID] Title（親:parentId）
    const headerMatch = raw[0].match(/^###\s+\[([^\]]+)\]\s+(.+)/);
    const title = headerMatch ? headerMatch[2].trim() : '';
    raw[0] = `#### [${b.id}] ${title}（親:${parentId}）`;
    // 末尾の空行は挿入時に整形するのでいったん除去
    while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop();
    blockLinesMap[b.id] = raw;
    lines.splice(b.start, b.end - b.start);
  }

  // 親を再検索（削除により行位置がずれている可能性があるため）
  const parentBlock = findH3Block(parentId);
  if (!parentBlock) {
    return { success: false, error: 'Parent block lost during processing' };
  }

  // 挿入する子ブロックを元のtaskIds順で組み立て
  const orderedMoved = taskIds.filter(id => blockLinesMap[id]);
  const insertLines = [];
  for (const id of orderedMoved) {
    insertLines.push(...blockLinesMap[id]);
    insertLines.push('');
  }
  if (parentBlock.end > 0 && lines[parentBlock.end - 1].trim() !== '') {
    insertLines.unshift('');
  }

  lines.splice(parentBlock.end, 0, ...insertLines);

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`[api] Attached [${orderedMoved.join(', ')}] to parent ${parentId} in ${targetFile}`);

  return { success: true, attached: orderedMoved, failed };
}

/**
 * 子タスク(h4)を親から外し、独立したh3タスクとして🔥アクティブセクション末尾に戻す
 * @param {string} taskId - 外す子タスクのID
 * @returns {{ success: boolean, id?: string, error?: string }}
 */
function detachFromParent(taskId) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  for (const file of files) {
    const filePath = path.join(BACKLOG_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const h4Regex = new RegExp(`^####\\s+\\[${escapeRegex(taskId)}\\]`, 'm');
    if (!h4Regex.test(content)) continue;

    let lines = content.split(/\r?\n/);
    const regex = new RegExp(`^####\\s+\\[${escapeRegex(taskId)}\\]`);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) { start = i; break; }
    }
    if (start === -1) continue;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^#{2,4}\s/.test(lines[i])) { end = i; break; }
    }

    const raw = lines.slice(start, end);
    const headerMatch = raw[0].match(/^####\s+\[([^\]]+)\]\s+(.+)/);
    let title = headerMatch ? headerMatch[2].trim() : '';
    // タイトル末尾の（親:XXX）を除去してh3ヘッダーに変換
    title = title.replace(/[（(]親[:：].+?[）)]\s*$/, '').trim();
    raw[0] = `### [${taskId}] ${title}`;
    while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop();

    // 元の位置（親の配下）から削除
    lines.splice(start, end - start);

    // 🔥 アクティブセクション末尾（次の##直前）に独立タスクとして挿入
    let activeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+.*🔥/.test(lines[i])) { activeIdx = i; break; }
    }

    const insertBlock = [...raw, ''];

    if (activeIdx === -1) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== '') insertBlock.unshift('');
      lines.push(...insertBlock);
    } else {
      let insertIdx = lines.length;
      for (let i = activeIdx + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) { insertIdx = i; break; }
      }
      if (insertIdx > 0 && lines[insertIdx - 1].trim() !== '') insertBlock.unshift('');
      lines.splice(insertIdx, 0, ...insertBlock);
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    console.log(`[api] Detached ${taskId} from parent in ${file}`);
    return { success: true, id: taskId };
  }

  return { success: false, error: `Child task ${taskId} not found` };
}

// ============================================================
// Cross-Project Task Move API (BT-052)
// ============================================================

/**
 * タスクを別プロジェクトへ移管し、移動先プレフィクスで再採番する
 * - h3単発タスク（子なし）またはh4子タスクのみ対応
 * - 子タスクを持つh3(Epic)は誤操作防止のため拒否する（移動は個別に子から行う）
 * - h4子タスクを移動する場合は「（親:XXX）」表記を外し、移動先ではh3の単発タスクとして扱う
 * @param {string} taskId - 移動元タスクID
 * @param {string} targetFile - 移動先プロジェクトのfile名（config.projects[].file）
 * @param {boolean} isChild - 移動元がh4子タスクかどうか
 * @returns {{ success: boolean, oldId?: string, newId?: string, targetFile?: string, error?: string }}
 */
function moveTaskToProject(taskId, targetFile, isChild = false) {
  const targetProject = (config.projects || []).find(p => p.file === targetFile || p.file.toLowerCase() === targetFile.toLowerCase());
  if (!targetProject) {
    return { success: false, error: `Target project "${targetFile}" not found` };
  }
  if (!targetProject.prefix) {
    return { success: false, error: `Target project "${targetProject.file}" has no prefix configured` };
  }

  const block = findTaskBlock(taskId, isChild);
  if (!block) {
    return { success: false, error: `Task ${taskId} not found` };
  }
  const { lines, filePath, file, headerIdx, blockEnd, isH3 } = block;

  if (path.basename(file, '.backlog.md').toLowerCase() === targetProject.file.toLowerCase()) {
    return { success: false, error: `Task ${taskId} is already in project "${targetProject.file}"` };
  }

  if (isH3) {
    const hasChildren = lines.slice(headerIdx + 1, blockEnd).some(l => /^####\s+\[/.test(l));
    if (hasChildren) {
      return { success: false, error: 'has_children' };
    }
  }

  // 移動先ファイル・アクティブセクションの存在を先に検証する（元ファイル削除後の
  // 書き込み失敗によるタスク消失を防ぐため、破壊的な変更は全検証が通ってから行う）
  const targetPath = path.join(BACKLOG_DIR, `${targetProject.file}.backlog.md`);
  if (!fs.existsSync(targetPath)) {
    return { success: false, error: `${targetProject.file}.backlog.md not found` };
  }
  const targetLines = fs.readFileSync(targetPath, 'utf8').split(/\r?\n/);
  let activeIdx = -1;
  for (let i = 0; i < targetLines.length; i++) {
    if (/^##\s+.*🔥/.test(targetLines[i])) { activeIdx = i; break; }
  }
  if (activeIdx === -1) {
    return { success: false, error: `Active section (🔥) not found in ${targetProject.file}.backlog.md` };
  }

  const raw = lines.slice(headerIdx, blockEnd);
  const headerMatch = isH3
    ? raw[0].match(/^###\s+\[([^\]]+)\]\s+(.+)/)
    : raw[0].match(/^####\s+\[([^\]]+)\]\s+(.+)/);
  let title = headerMatch ? headerMatch[2].trim() : '';
  title = title.replace(/[（(]親[:：].+?[）)]\s*$/, '').trim();

  const newId = allocateId(targetProject.prefix);
  raw[0] = `### [${newId}] ${title}`;
  while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop();

  // 元ファイルからブロック削除
  lines.splice(headerIdx, blockEnd - headerIdx);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  // 移動先の🔥アクティブセクション末尾に挿入
  let insertIdx = targetLines.length;
  for (let i = activeIdx + 1; i < targetLines.length; i++) {
    if (/^##\s/.test(targetLines[i])) { insertIdx = i; break; }
  }
  const insertBlock = [...raw, ''];
  if (insertIdx > 0 && targetLines[insertIdx - 1].trim() !== '') insertBlock.unshift('');
  targetLines.splice(insertIdx, 0, ...insertBlock);
  fs.writeFileSync(targetPath, targetLines.join('\n'), 'utf8');

  console.log(`[api] Moved ${taskId} -> ${newId} (${file} -> ${targetProject.file}.backlog.md)`);
  return { success: true, oldId: taskId, newId, targetFile: targetProject.file };
}

// ============================================================
// Task Update (title/description) API
// ============================================================

/**
 * h3/h4タスクブロックの範囲を探す（見つからなければnull）
 * @returns {{ lines: string[], filePath: string, file: string, headerIdx: number, blockEnd: number, isH3: boolean } | null}
 */
function findTaskBlock(taskId, isChild) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  const h3Regex = new RegExp(`^###\\s+\\[${escapeRegex(taskId)}\\]`);
  const h4Regex = new RegExp(`^####\\s+\\[${escapeRegex(taskId)}\\]`);

  for (const file of files) {
    const filePath = path.join(BACKLOG_DIR, file);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

    let headerIdx = -1;
    let isH3 = false;
    if (isChild) {
      for (let i = 0; i < lines.length; i++) {
        if (h4Regex.test(lines[i])) { headerIdx = i; break; }
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (h3Regex.test(lines[i])) { headerIdx = i; isH3 = true; break; }
      }
      if (headerIdx === -1) {
        for (let i = 0; i < lines.length; i++) {
          if (h4Regex.test(lines[i])) { headerIdx = i; break; }
        }
      }
    }

    if (headerIdx === -1) continue;

    let blockEnd = lines.length;
    const stopRegex = isH3 ? /^#{2,3}\s/ : /^#{2,4}\s/;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (stopRegex.test(lines[i])) { blockEnd = i; break; }
    }

    return { lines, filePath, file, headerIdx, blockEnd, isH3 };
  }

  return null;
}

/**
 * 完了アーカイブテーブル行（h3単発の完了タスク）を探す
 * @returns {{ lines: string[], filePath: string, file: string, rowIdx: number, cells: string[] } | null}
 */
function findArchiveTableRow(taskId) {
  const files = fs.readdirSync(BACKLOG_DIR)
    .filter(f => f.endsWith('.backlog.md'));

  for (const file of files) {
    const filePath = path.join(BACKLOG_DIR, file);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\|.*\|$/.test(line)) continue;
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length < 4 || !cells[0].match(/^\d{4}-\d{2}-\d{2}$/)) continue;
      // ts列（BT-066）の有無でID/件名の位置がずれるため判定してから比較
      const hasTs = cells.length >= 5 && /^\d{2}:\d{2}:\d{2}$/.test(cells[1]);
      const offset = hasTs ? 1 : 0;
      if (cells[2 + offset] === taskId) {
        return { lines, filePath, file, rowIdx: i, cells, hasTs, offset };
      }
    }
  }

  return null;
}

/**
 * archive/<project>.archive.md 内の該当タスクの見出しブロックを探す
 * @returns {{ archivePath: string, lines: string[], startIdx: number, endIdx: number } | null}
 */
function findArchiveDetailBlock(taskId) {
  const archiveDir = path.join(BACKLOG_DIR, 'archive');
  if (!fs.existsSync(archiveDir)) return null;

  const archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.archive.md'));
  const headerRegex = new RegExp(`^##\\s+\\[${escapeRegex(taskId)}\\]\\s+`);

  for (const file of archiveFiles) {
    const archivePath = path.join(archiveDir, file);
    const lines = fs.readFileSync(archivePath, 'utf8').split(/\r?\n/);

    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (headerRegex.test(lines[i])) { startIdx = i; break; }
    }
    if (startIdx === -1) continue;

    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { endIdx = i; break; }
    }

    return { archivePath, lines, startIdx, endIdx };
  }

  return null;
}

/**
 * タスクのタイトルを変更する（通常ブロック / 完了アーカイブ行の両対応）
 * @param {string} taskId
 * @param {string} newTitle
 * @param {boolean} isChild
 * @returns {{ success: boolean, error?: string }}
 */
function updateTaskTitle(taskId, newTitle, isChild = false) {
  const block = findTaskBlock(taskId, isChild);
  if (block) {
    const { lines, filePath, headerIdx, isH3 } = block;
    if (isH3) {
      const m = lines[headerIdx].match(/^###\s+\[([^\]]+)\]/);
      lines[headerIdx] = `### [${m[1]}] ${newTitle}`;
    } else {
      const m = lines[headerIdx].match(/^####\s+\[([^\]]+)\]\s+(.+)/);
      const oldTitle = m[2].trim();
      const parentSuffixMatch = oldTitle.match(/[（(]親[:：].+?[）)]\s*$/);
      const parentSuffix = parentSuffixMatch ? parentSuffixMatch[0] : '';
      lines[headerIdx] = `#### [${m[1]}] ${newTitle}${parentSuffix ? `${parentSuffix}` : ''}`;
    }
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    console.log(`[api] Updated title of ${taskId} -> "${newTitle}"`);
    return { success: true };
  }

  // 完了済みh3単発タスク（アーカイブテーブル行）
  const row = findArchiveTableRow(taskId);
  if (row) {
    const { lines, filePath, rowIdx, cells } = row;
    lines[rowIdx] = `| ${cells.slice(0, cells.length - 1).join(' | ')} | ${newTitle} |`;
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

    // archive/*.archive.md 側の見出しも合わせて更新（あれば）
    const detail = findArchiveDetailBlock(taskId);
    if (detail) {
      detail.lines[detail.startIdx] = `## [${taskId}] ${newTitle}`;
      fs.writeFileSync(detail.archivePath, detail.lines.join('\n'), 'utf8');
    }

    console.log(`[api] Updated title of archived task ${taskId} -> "${newTitle}"`);
    return { success: true };
  }

  return { success: false, error: `Task ${taskId} not found` };
}

/**
 * タスクの説明を変更する（通常ブロックのみ対応。完了アーカイブ行には説明フィールドがないため非対応）
 * @param {string} taskId
 * @param {string} newDescription
 * @param {boolean} isChild
 * @returns {{ success: boolean, error?: string }}
 */
function updateTaskDescription(taskId, newDescription, isChild = false) {
  const block = findTaskBlock(taskId, isChild);
  if (!block) {
    if (findArchiveTableRow(taskId)) {
      return { success: false, error: 'archived_no_description' };
    }
    return { success: false, error: `Task ${taskId} not found` };
  }

  const { lines, filePath, headerIdx, blockEnd } = block;

  // 既存の「- 説明:」行（+継続行）の範囲を特定
  let descStart = -1;
  let descEnd = blockEnd;
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    if (/^\s*-\s+説明[:：]/.test(lines[i])) {
      descStart = i;
      for (let j = i + 1; j < blockEnd; j++) {
        if (!lines[j].trim()) { descEnd = j; break; }
        if (/^\s*-\s+/.test(lines[j])) { descEnd = j; break; }
        descEnd = j + 1;
      }
      break;
    }
  }

  const descLines = newDescription.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const newBlock = descLines.length > 0
    ? [`- 説明: ${descLines[0]}`, ...descLines.slice(1)]
    : [];

  if (descStart !== -1) {
    lines.splice(descStart, descEnd - descStart, ...newBlock);
  } else if (newBlock.length > 0) {
    // 「状態:」行の直後に挿入
    let insertAfter = headerIdx;
    for (let i = headerIdx + 1; i < blockEnd; i++) {
      if (/^\s*-\s+状態[:：]/.test(lines[i])) { insertAfter = i; break; }
    }
    lines.splice(insertAfter + 1, 0, ...newBlock);
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`[api] Updated description of ${taskId}`);
  return { success: true };
}

/**
 * 全バックログからIDでタスク(親 or 子)を検索する
 */
function findTaskInAll(taskId) {
  const all = parseAllBacklogs();
  for (const t of all) {
    if (t.id === taskId) return t;
    if (t.children) {
      const c = t.children.find(ch => ch.id === taskId);
      if (c) return c;
    }
  }
  return null;
}

/**
 * タスクのmdブロックに github_issue_number / github_issue_url フィールドを追加・更新する(BT-079)
 * @returns {{ success: boolean, error?: string }}
 */
function setGithubIssueLink(taskId, isChild, issueNumber, issueUrl) {
  const block = findTaskBlock(taskId, isChild);
  if (!block) {
    return { success: false, error: `Task ${taskId} not found` };
  }
  const { lines, filePath, headerIdx } = block;
  let blockEnd = block.blockEnd;

  // 挿入基準点(起源行、無ければヘッダー行)。フィールドを1つ挿入するたびに
  // その挿入位置へ更新し、次のフィールドが直後に続くようにする。
  let insertAfter = headerIdx;
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    if (/^\s*-\s+起源[:：]/.test(lines[i])) { insertAfter = i; }
  }

  function upsertField(key, value) {
    let fieldIdx = -1;
    const fieldRegex = new RegExp(`^\\s*-\\s+${key}[:：]`);
    for (let i = headerIdx + 1; i < blockEnd; i++) {
      if (fieldRegex.test(lines[i])) { fieldIdx = i; break; }
    }
    if (fieldIdx !== -1) {
      lines[fieldIdx] = `- ${key}: ${value}`;
      insertAfter = fieldIdx;
      return;
    }
    lines.splice(insertAfter + 1, 0, `- ${key}: ${value}`);
    insertAfter++;
    blockEnd++;
  }

  upsertField('github_issue_number', issueNumber);
  upsertField('github_issue_url', issueUrl);

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`[api] Linked ${taskId} to GitHub issue #${issueNumber}`);
  return { success: true };
}

// ============================================================
// Task Delete API
// ============================================================

/**
 * タスクを削除する（通常ブロック / 完了アーカイブ行の両対応）
 * 子タスクを持つh3（Epic）は誤削除防止のため削除を拒否する
 * @param {string} taskId
 * @param {boolean} isChild
 * @returns {{ success: boolean, error?: string }}
 */
function deleteTask(taskId, isChild = false) {
  const block = findTaskBlock(taskId, isChild);
  if (block) {
    const { lines, filePath, headerIdx, blockEnd, isH3 } = block;

    if (isH3) {
      const hasChildren = lines.slice(headerIdx + 1, blockEnd).some(l => /^####\s+\[/.test(l));
      if (hasChildren) {
        return { success: false, error: 'has_children' };
      }
    }

    lines.splice(headerIdx, blockEnd - headerIdx);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    console.log(`[api] Deleted task ${taskId}`);
    return { success: true };
  }

  // 完了済みh3単発タスク（アーカイブテーブル行）
  const row = findArchiveTableRow(taskId);
  if (row) {
    const { lines, filePath, rowIdx } = row;
    lines.splice(rowIdx, 1);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

    // archive/*.archive.md 側のブロックも合わせて削除（あれば）
    const detail = findArchiveDetailBlock(taskId);
    if (detail) {
      detail.lines.splice(detail.startIdx, detail.endIdx - detail.startIdx);
      fs.writeFileSync(detail.archivePath, detail.lines.join('\n'), 'utf8');
    }

    console.log(`[api] Deleted archived task ${taskId}`);
    return { success: true };
  }

  return { success: false, error: `Task ${taskId} not found` };
}

function serveStatic(req, res) {
  console.log(`[http] ${req.method} ${req.url}`);

  // API: GET /api/health
  if (req.url === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // API: GET /api/board
  if (req.url === '/api/board' && req.method === 'GET') {
    const board = buildBoard();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(board));
    return;
  }

  // API: POST /api/update-status
  if (req.url === '/api/update-status' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, newStatus, isChild }) => {
      if (!taskId || !newStatus) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId and newStatus are required' }));
        return;
      }
      if (!isValidStatus(newStatus)) {
        // 文字化け（PowerShell Invoke-RestMethod等でのマルチバイト文字破損）や
        // 未知のステータス値がmdファイルに書き込まれるのを防ぐ（KT-052）
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Invalid newStatus: "${newStatus}". Must be one of: ${[...VALID_STATUSES].join(', ')}` }));
        return;
      }
      // md書き換え前にGitHub連携情報とコミットハッシュを確定させる（BT-119）。
      // h3単発タスクの完了ではタスクブロック自体が削除されるため、書き換え後には
      // github_issue_number等をmdから読み取れなくなる。
      const project = newStatus === '完了' ? findProjectEntryForTask(taskId) : null;
      const taskBeforeUpdate = newStatus === '完了' ? findTaskInAll(taskId) : null;
      const commitHashes = newStatus === '完了'
        ? getCommitHashesForTask(project && project.workspace, taskId)
        : [];

      const result = updateTaskStatus(taskId, newStatus, !!isChild, commitHashes);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        // ファイル変更 → watcherが検知してbroadcastするが、即時性のため手動broadcast
        const board = buildBoard();
        broadcast(board);

        if (newStatus === '完了' && taskBeforeUpdate && taskBeforeUpdate.githubIssueNumber && project) {
          syncCompletionToGithub(project.prefix, taskBeforeUpdate, commitHashes);
        }
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

  // API: POST /api/reorder
  if (req.url === '/api/reorder' && req.method === 'POST') {
    readRequestBody(req).then(({ orderedIds, isChild, parentId }) => {
      if (!orderedIds || !Array.isArray(orderedIds) || orderedIds.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'orderedIds array (2+ items) is required' }));
        return;
      }
      const result = reorderTasks(orderedIds, !!isChild, parentId || null);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        const board = buildBoard();
        broadcast(board);
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

  // API: POST /api/toggle-today
  if (req.url === '/api/toggle-today' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, isChild, value }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const result = toggleTodayFlag(taskId, !!isChild, value !== false);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, taskId: result.taskId, todayFlag: result.todayFlag }));
        const board = buildBoard();
        broadcast(board);
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

  // API: POST /api/toggle-running
  if (req.url === '/api/toggle-running' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, isChild, value }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const result = toggleRunning(taskId, !!isChild, value !== false);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, taskId: result.taskId, running: result.running }));
        const board = buildBoard();
        broadcast(board);
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

  // API: POST /api/github-create-issue（BT-079: カード→GitHub Issue作成）
  if (req.url === '/api/github-create-issue' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, isChild }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const project = findProjectEntryForTask(taskId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} not found` }));
        return;
      }
      const creds = readGithubCredentials()[project.prefix];
      if (!creds || !creds.repoUrl || !creds.token) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `GitHub連携が未設定です (prefix: ${project.prefix})` }));
        return;
      }
      const task = findTaskInAll(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} not found` }));
        return;
      }
      if (task.githubIssueNumber) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} is already linked to issue #${task.githubIssueNumber}` }));
        return;
      }
      githubClient.issues.create(creds.repoUrl, creds.token, { title: task.title, body: task.description || '' })
        .then((issue) => {
          const result = setGithubIssueLink(taskId, !!isChild, String(issue.number), issue.html_url);
          if (!result.success) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
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

  // API: POST /api/github-link-issue（BT-122: 既存タスクカードへGitHub Issueを後から紐付け）
  if (req.url === '/api/github-link-issue' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, isChild, issueNumber }) => {
      if (!taskId || !issueNumber) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId and issueNumber are required' }));
        return;
      }
      const project = findProjectEntryForTask(taskId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} not found` }));
        return;
      }
      const creds = readGithubCredentials()[project.prefix];
      if (!creds || !creds.repoUrl || !creds.token) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `GitHub連携が未設定です (prefix: ${project.prefix})` }));
        return;
      }
      const task = findTaskInAll(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} not found` }));
        return;
      }
      if (task.githubIssueNumber) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Task ${taskId} is already linked to issue #${task.githubIssueNumber}` }));
        return;
      }
      const normalizedNumber = String(issueNumber).replace(/^#/, '').trim();
      if (!/^\d+$/.test(normalizedNumber)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Invalid issue number: "${issueNumber}"` }));
        return;
      }

      // 同一project内で既にその番号を使っている他タスクがないかチェック(重複紐付け防止)
      const duplicated = parseAllBacklogs().some((t) => {
        if (t.project !== project.file) return false;
        if (t.id !== taskId && String(t.githubIssueNumber) === normalizedNumber) return true;
        if (t.children) {
          return t.children.some((c) => c.id !== taskId && String(c.githubIssueNumber) === normalizedNumber);
        }
        return false;
      });
      if (duplicated) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Issue #${normalizedNumber} is already linked to another task` }));
        return;
      }

      githubClient.issues.get(creds.repoUrl, creds.token, normalizedNumber)
        .then((issue) => {
          const result = setGithubIssueLink(taskId, !!isChild, String(issue.number), issue.html_url);
          if (!result.success) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
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

    // 既取り込み済みのissue番号 → backlog内タスクID(このプロジェクト内、親・子とも)
    const existingNumberToTaskId = new Map();
    for (const t of parseAllBacklogs()) {
      if (t.project === project.file && t.githubIssueNumber) existingNumberToTaskId.set(String(t.githubIssueNumber), t.id);
      if (t.children) {
        for (const c of t.children) {
          if (c.githubIssueNumber) existingNumberToTaskId.set(String(c.githubIssueNumber), c.id);
        }
      }
    }

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

      // 既取り込み済みのissue番号集合(このプロジェクト内、親・子とも)
      const existingNumbers = new Set();
      for (const t of parseAllBacklogs()) {
        if (t.project === project.file && t.githubIssueNumber) existingNumbers.add(String(t.githubIssueNumber));
        if (t.children) {
          for (const c of t.children) {
            if (c.githubIssueNumber) existingNumbers.add(String(c.githubIssueNumber));
          }
        }
      }

      // BT-108: 本文の "- [ ] #123" 形式task listから子issue番号を抽出(Epic表現)
      const parseTaskListChildren = (body) => Array.from((body || '').matchAll(/-\s*\[[ xX]\]\s*#(\d+)/g), (m) => Number(m[1]));
      // task list行はmd側のフィールド書式(- キー: 値)と衝突するため、説明欄に取り込む前に取り除く
      const stripTaskListLines = (body) => (body || '')
        .split(/\r?\n/)
        .filter((line) => !/^\s*-\s*\[[ xX]\]\s*#\d+/.test(line))
        .join('\n')
        .trim();

      githubClient.issues.listForRepo(creds.repoUrl, creds.token, { state: 'all', perPage: 100 })
        .then((issues) => {
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
            const result = addTask(issue.title, project.file, '未着手', 'user', stripTaskListLines(issue.body), {
              githubIssueNumber: String(issue.number),
              githubIssueUrl: issue.html_url,
            });
            if (!result.success) continue;
            added++;

            // task listで紐付いた子issueを親の直下に一括取り込み
            for (const childNumber of parseTaskListChildren(issue.body)) {
              if (existingNumbers.has(String(childNumber))) { skipped++; continue; }
              const childIssue = issueByNumber.get(childNumber);
              if (!childIssue) continue; // 別リポジトリ参照など一覧に無いものは無視
              const childResult = addChildTask(childIssue.title, result.id, '未着手', 'user', stripTaskListLines(childIssue.body), {
                githubIssueNumber: String(childIssue.number),
                githubIssueUrl: childIssue.html_url,
              });
              if (childResult.success) added++;
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

  // API: POST /api/add-task
  if (req.url === '/api/add-task' && req.method === 'POST') {
    readRequestBody(req).then(({ title, project, status, origin, parentId, description }) => {
      if (!title || !title.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'title is required' }));
        return;
      }
      if (status && !isValidStatus(status)) {
        // 文字化け等による未知のステータス値の書き込みを防ぐ（KT-052）
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Invalid status: "${status}". Must be one of: ${[...VALID_STATUSES].join(', ')}` }));
        return;
      }

      let result;
      if (parentId) {
        // 子タスク追加
        result = addChildTask(title.trim(), parentId, status || '未着手', origin || 'user', description || '');
      } else {
        // 親タスク追加
        result = addTask(
          title.trim(),
          project || 'inbox',
          status || '未着手',
          origin || 'user',
          description || ''
        );
      }

      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: result.id || '未採番' }));
        const board = buildBoard();
        broadcast(board);
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: result.error }));
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

  // API: POST /api/attach-to-parent
  if (req.url === '/api/attach-to-parent' && req.method === 'POST') {
    readRequestBody(req).then(({ taskIds, parentId }) => {
      if (!Array.isArray(taskIds) || taskIds.length === 0 || !parentId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskIds (non-empty array) and parentId are required' }));
        return;
      }
      const result = attachToParent(taskIds, parentId);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, attached: result.attached, failed: result.failed || [] }));
        const board = buildBoard();
        broadcast(board);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: result.error, failed: result.failed || [] }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/detach-from-parent
  if (req.url === '/api/detach-from-parent' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const result = detachFromParent(taskId);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id: result.id }));
        const board = buildBoard();
        broadcast(board);
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

  // API: POST /api/move-task
  if (req.url === '/api/move-task' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, targetFile, isChild }) => {
      if (!taskId || !targetFile) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId and targetFile are required' }));
        return;
      }
      const result = moveTaskToProject(taskId, targetFile, !!isChild);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, oldId: result.oldId, newId: result.newId, targetFile: result.targetFile }));
        const board = buildBoard();
        broadcast(board);
      } else {
        const statusCode = result.error === 'has_children' ? 409 : 404;
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: result.error }));
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/update-task
  if (req.url === '/api/update-task' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, isChild, title, description }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      if (title === undefined && description === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'title or description is required' }));
        return;
      }
      if (title !== undefined && !title.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'title must not be empty' }));
        return;
      }

      let result = { success: true };
      if (title !== undefined) {
        result = updateTaskTitle(taskId, title.trim(), !!isChild);
      }
      if (result.success && description !== undefined) {
        result = updateTaskDescription(taskId, description, !!isChild);
      }

      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        const board = buildBoard();
        broadcast(board);
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

  // API: POST /api/delete-tasks（複数一括削除, BT-042）
  if (req.url === '/api/delete-tasks' && req.method === 'POST') {
    readRequestBody(req).then(({ taskIds }) => {
      if (!Array.isArray(taskIds) || taskIds.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskIds (non-empty array) is required' }));
        return;
      }
      const results = taskIds.map(taskId => {
        const result = deleteTask(taskId, false);
        return { taskId, success: result.success, error: result.error };
      });
      const succeeded = results.filter(r => r.success).map(r => r.taskId);
      const failed = results.filter(r => !r.success);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, succeeded, failed }));
      if (succeeded.length > 0) {
        const board = buildBoard();
        broadcast(board);
      }
    }).catch(e => {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    });
    return;
  }

  // API: POST /api/delete-task
  if (req.url === '/api/delete-task' && req.method === 'POST') {
    readRequestBody(req).then(({ taskId, isChild }) => {
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      const result = deleteTask(taskId, !!isChild);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        const board = buildBoard();
        broadcast(board);
      } else if (result.error === 'has_children') {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: result.error }));
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
// File Watcher
// ============================================================

let debounceTimer = null;

function onFileChange(eventType, filename) {
  if (!filename || !filename.endsWith('.backlog.md')) return;

  // debounce: 300ms 以内の連続変更はまとめる
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`[watch] ${filename} changed, broadcasting update`);
    const board = buildBoard();
    broadcast(board);
  }, 300);
}

// ============================================================
// Start
// ============================================================

server.listen(PORT, () => {
  console.log(`[backlog-dashboard] Listening on http://localhost:${PORT}`);
  console.log(`[backlog-dashboard] Watching: ${BACKLOG_DIR}`);

  // カウンター初期化（なければ既存mdから自動生成）
  const counter = ensureCounter();
  console.log('[backlog-dashboard] Counter ready:', counter);

  // ファイル監視開始
  try {
    fs.watch(BACKLOG_DIR, { persistent: true }, onFileChange);
  } catch (e) {
    console.error('[watch] Failed to watch directory:', e.message);
  }
});
