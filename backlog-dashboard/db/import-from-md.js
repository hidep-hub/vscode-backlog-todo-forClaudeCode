'use strict';

const fs = require('fs');
const path = require('path');
const { parseBacklogMd, parseArchiveMd } = require('./md-parser');
const { createSchema } = require('./schema');

// BT-182決定: `保留`は廃止しtodoへ丸める
const STATUS_MAP = {
  '未着手': 'todo',
  '未着手（素材あり）': 'ready',
  '保留': 'todo',
  '進行中': 'do',
  '完了': 'done',
};

function mapStatus(rawStatus) {
  const mapped = STATUS_MAP[rawStatus];
  if (!mapped) throw new Error(`未知のステータス値のためインポートできません: "${rawStatus}"`);
  return mapped;
}

/**
 * 現行 initCounter() と同じロジック: 全mdファイル中の [XX-nnn] パターンから
 * プレフィクスごとの最大番号を求める。
 */
function computeMaxSeqMap(backlogDir) {
  const files = fs.readdirSync(backlogDir).filter(f => f.endsWith('.backlog.md'));
  const maxMap = {};
  for (const file of files) {
    const content = fs.readFileSync(path.join(backlogDir, file), 'utf8');
    for (const m of content.matchAll(/\[([A-Z]{2})-(\d{3,})\]/g)) {
      const prefix = m[1];
      const num = parseInt(m[2], 10);
      if (!maxMap[prefix] || maxMap[prefix] < num) maxMap[prefix] = num;
    }
  }
  return maxMap;
}

/**
 * 既存md群をパースし、渡されたDB接続(スキーマ未作成でも可)へ全件インポートする。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{backlogDir: string, projects: Array<{file:string, prefix:string}>}} opts
 */
function importFromMarkdown(db, { backlogDir, projects }) {
  createSchema(db);

  const now = new Date().toISOString();
  const maxSeqMap = computeMaxSeqMap(backlogDir);

  const insertCounter = db.prepare(
    'INSERT OR REPLACE INTO counters (workspace, prefix, next_seq) VALUES (?, ?, ?)'
  );
  for (const proj of projects) {
    insertCounter.run(proj.file, proj.prefix, (maxSeqMap[proj.prefix] || 0) + 1);
  }

  const insertTask = db.prepare(`INSERT INTO tasks
    (workspace, seq_no, display_id, parent_id, title, status, category, description, assignee,
     start_date, due_date, github_issue_number, github_issue_url, commit_hash, sort_order,
     completed_at, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDeliverable = db.prepare(
    'INSERT INTO deliverables (task_id, description, path, sort_order) VALUES (?, NULL, ?, ?)'
  );
  const insertPin = db.prepare('INSERT INTO pins (workspace, task_id, pinned_at) VALUES (?, ?, ?)');
  const insertRunning = db.prepare('INSERT INTO running_tasks (workspace, task_id, started_at) VALUES (?, ?, ?)');

  const stats = { tasks: 0, deliverables: 0, pins: 0, running: 0, skipped: [] };
  let sortCounter = 0;

  function insertOneTask(workspace, node, parentInternalId, archiveMap) {
    const idMatch = typeof node.id === 'string' && node.id.match(/^([A-Z]{2})-(\d+)$/);
    if (!idMatch) {
      stats.skipped.push({ workspace, id: node.id, title: node.title });
      return null;
    }
    const seqNo = parseInt(idMatch[2], 10);
    const archived = archiveMap[node.id] || {};

    const description = node.description || archived.description || null;
    const category = (node.category && node.category !== '-') ? node.category : (archived.category || '-');
    const artifacts = node.artifacts || archived.artifacts || [];
    const assignee = node.assignee || archived.assignee || null;
    const githubIssueNumber = node.githubIssueNumber || archived.githubIssueNumber || null;
    const githubIssueUrl = node.githubIssueUrl || archived.githubIssueUrl || null;
    const completedAt = node.completedDate
      ? `${node.completedDate}T${node.completedTs || '00:00:00'}`
      : null;

    sortCounter += 1;
    const result = insertTask.run(
      workspace,
      seqNo,
      node.id,
      parentInternalId,
      node.title,
      mapStatus(node.status),
      category,
      description,
      assignee,
      node.startDate || null,
      node.dueDate || null,
      githubIssueNumber ? parseInt(githubIssueNumber, 10) : null,
      githubIssueUrl,
      node.commitHash || null,
      sortCounter,
      completedAt,
      now,
      node.origin || 'user',
      now,
      node.origin || 'user'
    );
    stats.tasks += 1;
    const internalId = result.lastInsertRowid;

    artifacts.forEach((p, idx) => {
      insertDeliverable.run(internalId, p, idx);
      stats.deliverables += 1;
    });
    if (node.todayFlag) { insertPin.run(workspace, internalId, now); stats.pins += 1; }
    if (node.running) { insertRunning.run(workspace, internalId, now); stats.running += 1; }

    return internalId;
  }

  db.exec('BEGIN');
  try {
    for (const proj of projects) {
      const filePath = path.join(backlogDir, `${proj.file}.backlog.md`);
      if (!fs.existsSync(filePath)) continue;

      const nodes = parseBacklogMd(filePath);
      const archiveMap = parseArchiveMd(backlogDir, proj.file);

      for (const node of nodes) {
        const parentInternalId = insertOneTask(proj.file, node, null, archiveMap);
        if (parentInternalId === null) continue;
        for (const child of node.children || []) {
          insertOneTask(proj.file, child, parentInternalId, archiveMap);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return stats;
}

module.exports = { importFromMarkdown, mapStatus, STATUS_MAP };

// CLI実行: node db/import-from-md.js <出力DBパス> [configパス]
if (require.main === module) {
  const { DatabaseSync } = require('node:sqlite');
  const os = require('os');

  const outDbPath = process.argv[2];
  if (!outDbPath) {
    console.error('使い方: node db/import-from-md.js <出力DBパス> [config.jsonパス]');
    process.exit(1);
  }
  const configPath = process.argv[3] || path.join(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const backlogDir = config.backlogDir.replace(/^~/, os.homedir());

  if (fs.existsSync(outDbPath)) {
    console.error(`既に存在します（上書き防止のため中断）: ${outDbPath}`);
    process.exit(1);
  }

  const db = new DatabaseSync(outDbPath);
  try {
    const stats = importFromMarkdown(db, { backlogDir, projects: config.projects || [] });
    console.log('[import] 完了:', stats);
    if (stats.skipped.length > 0) {
      console.warn('[import] スキップされたノード（ID形式不正）:', stats.skipped);
    }
  } finally {
    db.close();
  }
}
