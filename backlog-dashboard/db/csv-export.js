'use strict';

// タスク一覧のCSVエクスポート(BT-221 / BT-412)。外部のガントチャート等へ転送するための出力で、
// SQLiteバイナリのバックアップ(db/export.js、BT-176)とは別物。履歴(task_events)は含めない。
// 列定義・並び・変換ルールは docs/design/bt-221-csv-export-design.md を参照。

const tagsRepo = require('./tags-repo');
const externalLinksRepo = require('./external-links-repo');
const { computeParentStatusCode } = require('./board');

const COLUMNS = [
  'workspace', 'id', 'parent_id', 'type', 'board_order', 'title', 'status', 'assignee',
  'start_date', 'due_date', 'completed_at', 'tags', 'category', 'description',
  'description_truncated', 'deliverables', 'its_source', 'its_issue', 'its_url',
];

// Excelのセル上限(32,767文字)に収めるための安全策。超えた分は切り詰めて目印を付ける。
const DESCRIPTION_LIMIT = 30000;
const TRUNCATION_MARKER = '…（以下省略。全文はダッシュボード参照）';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstOffsetIso(value) {
  if (!value) return '';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return `${new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

function truncateDescription(text) {
  if (text.length <= DESCRIPTION_LIMIT) return { text, truncated: false };
  let cut = text.slice(0, DESCRIPTION_LIMIT - TRUNCATION_MARKER.length);
  // サロゲートペアの途中で切ると不正な文字になるため、上位サロゲートで終わる場合は1文字戻す
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);
  return { text: cut + TRUNCATION_MARKER, truncated: true };
}

function fileNameOf(deliverable) {
  if (deliverable.path) return deliverable.path.split(/[\\/]/).filter(Boolean).pop() || deliverable.path;
  return deliverable.description || '';
}

// CSVインジェクション対策(先頭が数式として解釈される文字なら ' を前置)とRFC 4180のクォート。
function toCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function loadRows(db, workspace) {
  return workspace
    ? db.prepare('SELECT * FROM tasks WHERE workspace = ? AND deleted_at IS NULL ORDER BY sort_order').all(workspace)
    : db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY workspace, sort_order').all();
}

function inClauseRows(db, table, ids, orderBy) {
  if (ids === null) return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
  if (ids.length === 0) return [];
  return db.prepare(`SELECT * FROM ${table} WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY ${orderBy}`).all(...ids);
}

/**
 * タスク一覧のCSVを組み立てる(読み取りのみ。論理削除済みは除外)。
 * 行の並び: ワークスペース順 → 実効ステータス順(statuses.sort_order) → sort_order。EPICの直後にその子を並べる。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspace?: string|null}} [options] 省略/nullは全ワークスペース
 * @returns {{csv: string, rowCount: number, truncatedCount: number}}
 */
function buildTaskCsv(db, { workspace = null } = {}) {
  const statusRank = {};
  for (const s of db.prepare('SELECT code, sort_order FROM statuses').all()) statusRank[s.code] = s.sort_order;

  const rows = loadRows(db, workspace);
  const ids = workspace ? rows.map(r => r.id) : null;
  const tagsByTaskId = tagsRepo.listTagsForTasks(db, ids);
  const linksByTaskId = externalLinksRepo.listLinksForTasks(db, ids);
  const deliverablesByTaskId = {};
  for (const d of inClauseRows(db, 'deliverables', ids, 'task_id, sort_order')) {
    (deliverablesByTaskId[d.task_id] = deliverablesByTaskId[d.task_id] || []).push(d);
  }

  const rowById = new Map(rows.map(r => [r.id, r]));
  const childrenByParentId = new Map();
  const topLevel = [];
  for (const row of rows) {
    // 親が(何らかの理由で)集合に無い子は、行を落とさないよう単発として扱う
    if (row.parent_id !== null && rowById.has(row.parent_id)) {
      if (!childrenByParentId.has(row.parent_id)) childrenByParentId.set(row.parent_id, []);
      childrenByParentId.get(row.parent_id).push(row);
    } else {
      topLevel.push(row);
    }
  }

  // EPICの状態はボードと同じく子から導出した実効ステータスを使う
  const effectiveStatus = new Map();
  for (const row of topLevel) {
    effectiveStatus.set(row.id, computeParentStatusCode(childrenByParentId.get(row.id) || [], row.status, statusRank));
  }
  const workspaces = [...new Set(topLevel.map(r => r.workspace))];
  const ordered = [];
  for (const ws of workspaces) {
    const inWorkspace = topLevel.filter(r => r.workspace === ws);
    // Array#sortは安定ソートなので、同じ実効ステータス内はsort_order順(取得順)のまま残る
    inWorkspace.sort((a, b) => (statusRank[effectiveStatus.get(a.id)] || 0) - (statusRank[effectiveStatus.get(b.id)] || 0));
    ordered.push(...inWorkspace);
  }

  const lines = [COLUMNS.join(',')];
  let truncatedCount = 0;
  let rowCount = 0;
  const orderCounters = new Map();

  function nextOrder(key) {
    const n = (orderCounters.get(key) || 0) + 1;
    orderCounters.set(key, n);
    return n;
  }

  function emit(row, { parentRow, type, status, boardOrder }) {
    const description = truncateDescription(row.description || '');
    if (description.truncated) truncatedCount += 1;
    const links = [];
    if (row.github_issue_number) {
      links.push({ source: 'github', issue: row.github_issue_number, url: row.github_issue_url || '' });
    }
    for (const l of linksByTaskId[row.id] || []) links.push({ source: l.source, issue: l.key, url: l.url });
    const cells = [
      row.workspace,
      row.display_id,
      parentRow ? parentRow.display_id : '',
      type,
      boardOrder,
      row.title,
      status,
      row.assignee,
      row.start_date,
      row.due_date,
      toJstOffsetIso(row.completed_at),
      (tagsByTaskId[row.id] || []).map(t => t.name).join(';'),
      row.category,
      description.text,
      description.truncated ? 1 : '',
      (deliverablesByTaskId[row.id] || []).map(fileNameOf).filter(Boolean).join(';'),
      links.map(l => l.source).join(';'),
      links.map(l => l.issue).join(';'),
      links.map(l => l.url).join(';'),
    ];
    lines.push(cells.map(toCell).join(','));
    rowCount += 1;
  }

  for (const row of ordered) {
    const children = childrenByParentId.get(row.id) || [];
    const status = effectiveStatus.get(row.id);
    emit(row, {
      parentRow: null,
      type: children.length > 0 ? 'epic' : 'single',
      status,
      boardOrder: nextOrder(`${row.workspace}\u0000${status}`),
    });
    for (const child of children) {
      emit(child, { parentRow: row, type: 'child', status: child.status, boardOrder: nextOrder(`parent:${row.id}`) });
    }
  }

  // BOM付きUTF-8(Excelでの文字化け防止)・CRLF
  return { csv: `﻿${lines.join('\r\n')}\r\n`, rowCount, truncatedCount };
}

module.exports = { buildTaskCsv, COLUMNS, DESCRIPTION_LIMIT, TRUNCATION_MARKER };
