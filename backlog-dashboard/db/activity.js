'use strict';

// GET /api/activity用の集約ロジック(BT-243)。task_events(BT-241でINSERT配線済み)を
// event_types(label等)・tasks(現在のタイトル・親情報)と結合し、履歴機能(BT-199)の
// タイムライン/ヒートマップUI(BT-244〜246)がそのまま使えるイベント配列を返す。
// 検索・期間絞り込みはBT-246の担当なので、ここではフィルタなしの全件をoccurred_at降順で返す。

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} config - server.jsのconfigオブジェクト(projects)
 * @returns {Array<object>} occurred_at降順のイベント配列
 */
function buildActivity(db, config) {
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
      et.icon AS eventIcon,
      et.color AS eventColor,
      t.title AS taskTitle,
      t.workspace AS workspace,
      t.parent_id AS parentRowId
    FROM task_events te
    LEFT JOIN event_types et ON et.code = te.event_type
    LEFT JOIN tasks t ON t.id = te.task_id
    ORDER BY te.occurred_at DESC, te.id DESC
  `).all();

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
    return {
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
    };
  });
}

module.exports = { buildActivity };
