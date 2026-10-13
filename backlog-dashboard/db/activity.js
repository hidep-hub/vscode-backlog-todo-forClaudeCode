'use strict';

// GET /api/activity用の集約ロジック(BT-243)。task_events(BT-241でINSERT配線済み)を
// event_types(label等)・tasks(現在のタイトル・親情報)と結合し、履歴機能(BT-199)の
// タイムライン/ヒートマップUI(BT-244〜246)がそのまま使えるイベント配列を返す。
// BT-408: キーワード(q)・タグ(tagId)の絞り込みをDB側で行う。説明文などクライアントが持たない情報も
// 対象にでき、削除済みタスクの履歴にも効く。どちらも未指定なら従来どおり全件をoccurred_at降順で返す。

const { escapeLikePattern } = require('./tasks-repo');

const SNIPPET_CONTEXT = 30; // ヒット箇所の前後に残す文字数

/**
 * 説明文のヒット箇所の前後を切り出した抜粋を返す(改行は空白に畳み、切れた側に「…」を付ける)。
 * SQLのLIKEと同じく大文字小文字を区別せず探す。位置が見つからなければnull。
 */
function buildSnippet(description, q) {
  if (!description || !q) return null;
  const text = String(description).replace(/\s+/g, ' ');
  const index = text.toLowerCase().indexOf(q.replace(/\s+/g, ' ').toLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - SNIPPET_CONTEXT);
  const end = Math.min(text.length, index + q.length + SNIPPET_CONTEXT);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} config - server.jsのconfigオブジェクト(projects)
 * @param {{q?: string, tagId?: number}} [filters]
 *   q: タスクのタイトル/表示ID/説明文、親EPICのタイトル/表示ID、イベントの値(旧→新)に対する部分一致
 *      (大文字小文字は区別しない)。EPICで探すと配下の子タスクのイベントも対象になる。
 *      qを指定した時だけ、各イベントに matchedIn(title/id/description/parent/valueのうちヒットした箇所)と、
 *      説明文でヒットした場合の descriptionSnippet(ヒット箇所の前後の抜粋)が付く
 *   tagId: そのタグが付いているタスクのイベントだけ(論理削除済みタスクも対象)
 * @returns {Array<object>} occurred_at降順のイベント配列
 */
function buildActivity(db, config, filters = {}) {
  const workspaceToProjectName = {};
  for (const p of config.projects || []) {
    if (p.file) workspaceToProjectName[p.file] = p.name;
  }

  const where = [];
  const params = [];
  const selectParams = [];
  let matchSelect = '';
  const q = typeof filters.q === 'string' ? filters.q.trim() : '';
  if (q) {
    const pattern = `%${escapeLikePattern(q)}%`;
    const like = c => `${c} LIKE ? ESCAPE '\\'`;
    // 「どこでヒットしたか」をイベントごとに返す(画面でヒット理由を示すため)。
    const matchGroups = {
      title: ['t.title'],
      id: ['t.display_id', 'te.task_display_id'],
      description: ['t.description'],
      parent: ['p.title', 'p.display_id'],
      value: ['te.old_value', 'te.new_value'],
    };
    const cols = Object.values(matchGroups).flat();
    where.push(`(${cols.map(like).join(' OR ')})`);
    for (let i = 0; i < cols.length; i++) params.push(pattern);
    // 説明文の抜粋(前後を切り出す)用に本文も取る。レスポンスには含めない
    matchSelect = `, t.description AS description, ${Object.entries(matchGroups)
      .map(([key, group]) => `(${group.map(like).join(' OR ')}) AS m_${key}`).join(', ')}`;
    for (let i = 0; i < cols.length; i++) selectParams.push(pattern);
  }
  if (Number.isInteger(filters.tagId)) {
    where.push('te.task_id IN (SELECT task_id FROM task_tags WHERE tag_id = ?)');
    params.push(filters.tagId);
  }

  const rows = db.prepare(`
    SELECT
      te.id AS id,
      te.task_display_id AS taskId,
      te.event_type AS eventType,
      te.old_value AS oldValue,
      te.new_value AS newValue,
      te.actor AS actor,
      te.occurred_at AS occurredAt,
      et.label AS eventLabel,
      et.icon AS eventIcon,
      et.color AS eventColor,
      t.title AS taskTitle,
      t.workspace AS workspace,
      t.parent_id AS parentRowId,
      EXISTS (SELECT 1 FROM tasks child WHERE child.parent_id = t.id AND child.deleted_at IS NULL) AS isEpic${matchSelect}
    FROM task_events te
    LEFT JOIN event_types et ON et.code = te.event_type
    LEFT JOIN tasks t ON t.id = te.task_id
    LEFT JOIN tasks p ON p.id = t.parent_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY te.occurred_at DESC, te.id DESC
  `).all(...selectParams, ...params);

  // 親タスクのdisplay_id/titleは行ごとに逐次クエリせず、まとめて1回で解決する
  const parentRowIds = [...new Set(rows.map(r => r.parentRowId).filter(id => id !== null && id !== undefined))];
  const parentsById = {};
  if (parentRowIds.length > 0) {
    const placeholders = parentRowIds.map(() => '?').join(',');
    const parentRows = db.prepare(`SELECT id, display_id, title FROM tasks WHERE id IN (${placeholders})`).all(...parentRowIds);
    for (const p of parentRows) parentsById[p.id] = p;
  }

  return rows.map(row => {
    const parent = row.parentRowId != null ? parentsById[row.parentRowId] : null;
    const matchInfo = q ? {
      matchedIn: ['title', 'id', 'description', 'parent', 'value'].filter(key => row[`m_${key}`]),
      descriptionSnippet: row.m_description ? buildSnippet(row.description, q) : null,
    } : {};
    return {
      ...matchInfo,
      id: row.id,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      project: workspaceToProjectName[row.workspace] || row.workspace || null,
      eventType: row.eventType,
      eventLabel: row.eventLabel,
      eventIcon: row.eventIcon,
      eventColor: row.eventColor,
      oldValue: row.oldValue,
      newValue: row.newValue,
      actor: row.actor,
      occurredAt: row.occurredAt,
      parentId: parent ? parent.display_id : null,
      parentTitle: parent ? parent.title : null,
      isEpic: Boolean(row.isEpic),
    };
  });
}

/**
 * BM-020: ヘッダーのティッカー表示用。履歴モーダル(buildActivity)の全件取得は
 * 562件規模(2026-10時点)でも226KB超あり、board操作のたびにbroadcastへ乗せると
 * 無駄に重くなる。主キー(id)の降順LIMITだけで済む軽量版を別関数として用意し、
 * 「直近イベントを少数だけ流す」用途に限定する。JOIN構造はbuildActivityと同じ。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} config
 * @param {number} limit - 取得件数(既定30)
 */
function buildRecentEvents(db, config, limit = 30) {
  const workspaceToProjectName = {};
  for (const p of config.projects || []) {
    if (p.file) workspaceToProjectName[p.file] = p.name;
  }

  const rows = db.prepare(`
    SELECT
      te.id AS id,
      te.task_display_id AS taskId,
      te.event_type AS eventType,
      te.old_value AS oldValue,
      te.new_value AS newValue,
      te.actor AS actor,
      te.occurred_at AS occurredAt,
      et.label AS eventLabel,
      t.title AS taskTitle,
      t.workspace AS workspace
    FROM task_events te
    LEFT JOIN event_types et ON et.code = te.event_type
    LEFT JOIN tasks t ON t.id = te.task_id
    ORDER BY te.id DESC
    LIMIT ?
  `).all(limit);

  return rows.map(row => ({
    id: row.id,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    project: workspaceToProjectName[row.workspace] || row.workspace || null,
    eventType: row.eventType,
    eventLabel: row.eventLabel,
    oldValue: row.oldValue,
    newValue: row.newValue,
    actor: row.actor,
    occurredAt: row.occurredAt,
  }));
}

module.exports = { buildActivity, buildRecentEvents };
