'use strict';

// DB・環境ファイルのバックアップ(BT-372、設計: BT-370)。
// 1回のバックアップ = <backlogDir>/backups/backlog-YYYYMMDD-HHmmss/ の1フォルダ。
//   backlog.sqlite3 ... node:sqliteのbackup()(オンラインバックアップAPI)で取得したDB
//   files/<相対パス> ... config.json / github-credentials.json / docs/ などgit管理外の環境ファイル
//   manifest.json   ... 内容一覧(サイズ・SHA-256・DB件数・整合性検査結果)
// 実行ログは backups/backup.log にJSON Linesで追記する。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync, backup } = require('node:sqlite');

const BACKUP_NAME_RE = /^backlog-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const DAILY_KEEP = 7;
const WEEKLY_KEEP = 4;

const COUNT_TABLES = {
  tasks: 'SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL',
  tasksDeleted: 'SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NOT NULL',
  deliverables: 'SELECT COUNT(*) AS n FROM deliverables',
  taskEvents: 'SELECT COUNT(*) AS n FROM task_events',
  executionSessions: 'SELECT COUNT(*) AS n FROM task_execution_sessions',
  pins: 'SELECT COUNT(*) AS n FROM pins',
  runningTasks: 'SELECT COUNT(*) AS n FROM running_tasks',
};

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function backupNameFromDate(date) {
  return `backlog-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isBackupName(name) {
  return typeof name === 'string' && BACKUP_NAME_RE.test(name);
}

function localIso(date) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** バックアップ名から(日付キー, ISO週キー)を取り出す。 */
function nameParts(name) {
  const m = BACKUP_NAME_RE.exec(name);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // ISO週: 木曜日が属する年・週をその週とする
  const date = new Date(Date.UTC(y, mo - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return { day: `${m[1]}${m[2]}${m[3]}`, week: `${date.getUTCFullYear()}-W${pad(week)}` };
}

/**
 * ローテーション対象の決定(純粋関数)。
 * - 同じ日付は最新の1件だけ残す
 * - 日次: バックアップが存在する日のうち新しい順に DAILY_KEEP 日分
 * - 週次: 日次の範囲外から、ISO週ごとの最新1件を新しい順に WEEKLY_KEEP 週分
 * 任意タイミング運用のため「直近N日」ではなく「存在する日の上位N件」で数える。
 * @param {string[]} names - バックアップ名(順不同)
 * @returns {{keep: string[], remove: string[]}}
 */
function selectRotation(names) {
  const sorted = names.filter(isBackupName).sort().reverse(); // 新しい順
  const newestPerDay = [];
  const seenDays = new Set();
  const remove = [];
  for (const name of sorted) {
    const { day } = nameParts(name);
    if (seenDays.has(day)) {
      remove.push(name);
    } else {
      seenDays.add(day);
      newestPerDay.push(name);
    }
  }
  const keep = newestPerDay.slice(0, DAILY_KEEP);
  const seenWeeks = new Set();
  for (const name of newestPerDay.slice(DAILY_KEEP)) {
    const { week } = nameParts(name);
    if (!seenWeeks.has(week) && seenWeeks.size < WEEKLY_KEEP) {
      seenWeeks.add(week);
      keep.push(name);
    } else {
      remove.push(name);
    }
  }
  return { keep, remove };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** ディレクトリ配下のファイルを再帰列挙(相対パスはスラッシュ区切り)。 */
function walkFiles(rootDir, relBase = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(rootDir, relBase), { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(rootDir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * sourcesを「コピー対象ファイル」に展開する。存在しないsourceはskippedとして返す。
 * @param {{rel: string, abs: string}[]} sources
 */
function expandSources(sources) {
  const files = [];
  const skipped = [];
  for (const s of sources) {
    if (!fs.existsSync(s.abs)) {
      skipped.push(s.rel);
    } else if (fs.statSync(s.abs).isDirectory()) {
      for (const rel of walkFiles(s.abs)) {
        const abs = path.join(s.abs, ...rel.split('/'));
        files.push({ rel: `${s.rel}/${rel}`, abs, size: fs.statSync(abs).size });
      }
    } else {
      files.push({ rel: s.rel, abs: s.abs, size: fs.statSync(s.abs).size });
    }
  }
  return { files, skipped };
}

/** 取得したDBを読み取り専用で開き、整合性検査と件数集計を行う。 */
function inspectDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const integrity = rows.length === 1 && rows[0].integrity_check === 'ok'
      ? 'ok'
      : rows.map(r => r.integrity_check).join('; ');
    const counts = {};
    for (const [key, sql] of Object.entries(COUNT_TABLES)) {
      counts[key] = db.prepare(sql).get().n;
    }
    return { integrity, counts };
  } finally {
    db.close();
  }
}

function appendLog(backupsDir, entry) {
  try {
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.appendFileSync(path.join(backupsDir, 'backup.log'), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('[backup] Failed to write backup.log:', e.message);
  }
}

function dirSize(dir) {
  return walkFiles(dir).reduce((sum, rel) => sum + fs.statSync(path.join(dir, ...rel.split('/'))).size, 0);
}

function listBackups(backupsDir) {
  if (!fs.existsSync(backupsDir)) return [];
  const names = fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && isBackupName(e.name))
    .map(e => e.name)
    .sort()
    .reverse();
  return names.map(name => {
    const dir = path.join(backupsDir, name);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch (e) { /* manifestなし(途中で中断したフォルダ等)はnullで返す */ }
    return {
      file: name,
      createdAt: manifest ? manifest.createdAt : null,
      sizeBytes: dirSize(dir),
      integrity: manifest ? manifest.integrity : null,
      counts: manifest ? manifest.counts : null,
      files: manifest ? manifest.files.length : null,
      skipped: manifest ? manifest.skipped : null,
    };
  });
}

/**
 * バックアップを1件削除する(フォルダごと)。最新の1件は削除できない。
 * @throws {Error} code: invalid_name | not_found | latest_protected
 */
function deleteBackup(backupsDir, name, { actor = 'user', now = new Date() } = {}) {
  const fail = code => Object.assign(new Error(code), { code });
  if (!isBackupName(name)) throw fail('invalid_name');
  const dir = path.join(backupsDir, name);
  if (!fs.existsSync(dir)) throw fail('not_found');
  const newest = listBackups(backupsDir)[0];
  if (newest && newest.file === name) throw fail('latest_protected');
  fs.rmSync(dir, { recursive: true, force: true });
  appendLog(backupsDir, { at: localIso(now), event: 'delete', file: name, ok: true, actor });
}

/**
 * バックアップ実行とその進捗状態を管理する。
 * @param {object} opts
 * @param {() => import('node:sqlite').DatabaseSync} opts.getDb - 稼働中のDB接続
 * @param {string} opts.backlogDir
 * @param {{rel: string, abs: string}[]} opts.sources - コピーする環境ファイル/ディレクトリ
 * @param {() => Date} [opts.clock]
 * @param {() => string} [opts.apiVersion]
 */
function createBackupManager({ getDb, backlogDir, sources, clock = () => new Date(), apiVersion = () => null }) {
  const backupsDir = path.join(backlogDir, 'backups');
  const state = { running: false, percent: 0, phase: null, startedAt: null };

  function setProgress(phase, percent) {
    state.phase = phase;
    state.percent = Math.max(state.percent, Math.min(100, Math.round(percent)));
  }

  async function run({ actor = 'user' } = {}) {
    if (state.running) throw Object.assign(new Error('backup_in_progress'), { code: 'backup_in_progress' });
    const started = clock();
    const name = backupNameFromDate(started);
    const dir = path.join(backupsDir, name);
    if (fs.existsSync(dir)) throw Object.assign(new Error('backup_exists'), { code: 'backup_exists' });

    state.running = true;
    state.percent = 0;
    state.phase = 'db';
    state.startedAt = localIso(started);
    const logBase = { at: localIso(started), event: 'backup', file: name, actor };
    try {
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });

      // 1) DB(0〜60%)。rateは全体が約100ステップになるよう決め、ステップ間でイベントループを解放する
      const db = getDb();
      const pageCount = db.prepare('PRAGMA page_count').get().page_count;
      const dbDest = path.join(dir, 'backlog.sqlite3');
      await backup(db, dbDest, {
        rate: Math.max(8, Math.ceil(pageCount / 100)),
        progress: ({ totalPages, remainingPages }) => {
          setProgress('db', totalPages > 0 ? ((totalPages - remainingPages) / totalPages) * 60 : 0);
        },
      });
      setProgress('db', 60);

      // 2) 環境ファイル(60〜85%)
      state.phase = 'files';
      const { files, skipped } = expandSources(sources);
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0) || 1;
      let doneBytes = 0;
      const manifestFiles = [];
      for (const f of files) {
        const dest = path.join(dir, 'files', ...f.rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const srcHash = sha256File(f.abs);
        fs.copyFileSync(f.abs, dest);
        if (sha256File(dest) !== srcHash) throw new Error(`hash_mismatch: ${f.rel}`);
        manifestFiles.push({ path: `files/${f.rel}`, sizeBytes: f.size, sha256: srcHash });
        doneBytes += f.size;
        setProgress('files', 60 + (doneBytes / totalBytes) * 25);
        await new Promise(resolve => setImmediate(resolve)); // 進捗をステータスAPIから見えるようにする
      }
      setProgress('files', 85);

      // 3) 検証(85〜95%)
      state.phase = 'verify';
      const { integrity, counts } = inspectDatabase(dbDest);
      if (integrity !== 'ok') throw new Error(`integrity_check failed: ${integrity}`);
      setProgress('verify', 95);

      // 4) manifest・ログ・ローテーション(95〜100%)
      state.phase = 'rotate';
      const dbHash = sha256File(dbDest);
      const manifest = {
        createdAt: localIso(started),
        apiVersion: apiVersion(),
        actor,
        db: { path: 'backlog.sqlite3', sizeBytes: fs.statSync(dbDest).size, sha256: dbHash },
        integrity,
        counts,
        files: manifestFiles,
        skipped,
      };
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      const { remove } = selectRotation(fs.readdirSync(backupsDir, { withFileTypes: true })
        .filter(e => e.isDirectory()).map(e => e.name));
      for (const old of remove) fs.rmSync(path.join(backupsDir, old), { recursive: true, force: true });

      const result = {
        ok: true,
        file: name,
        sizeBytes: dirSize(dir),
        durationMs: clock() - started,
        integrity,
        counts,
        files: manifestFiles.length,
        skipped,
        rotatedOut: remove,
      };
      appendLog(backupsDir, { ...logBase, ...result });
      setProgress('done', 100);
      return result;
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      appendLog(backupsDir, { ...logBase, ok: false, error: e.message });
      throw e;
    } finally {
      state.running = false;
    }
  }

  return {
    run,
    status: () => ({ ...state }),
    isRunning: () => state.running,
    list: () => listBackups(backupsDir),
    remove: (name, opts) => deleteBackup(backupsDir, name, { ...opts, now: clock() }),
    backupsDir,
  };
}

module.exports = {
  createBackupManager,
  listBackups,
  deleteBackup,
  selectRotation,
  backupNameFromDate,
  isBackupName,
  inspectDatabase,
};
