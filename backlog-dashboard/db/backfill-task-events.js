'use strict';

const { createSchema } = require('./schema');
const tasksRepo = require('./tasks-repo');

/**
 * 既存tasksテーブルのcompleted_at/deleted_atを持つ行から、task_eventsへ1回限り遡及投入する
 * 移行スクリプト(BT-242)。BT-241のinsertEvent()と同じ形状で書き込み、occurred_atには
 * 「今」ではなく実際のcompleted_at/deleted_at当時の日時をそのまま記録する。
 * old_valueは過去データから遷移前の値が分からないため常にnullにする。
 * 既に対応するイベントが記録済みの行はスキップする(誤って複数回実行しても安全 = idempotent)。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{dryRun?: boolean}} opts - dryRun時はSELECTのみ行い、書き込み・件数カウントの結果を返す
 */
function backfillTaskEvents(db, { dryRun = false } = {}) {
  createSchema(db);

  const stats = { statusChangedInserted: 0, statusChangedSkipped: 0, deletedInserted: 0, deletedSkipped: 0 };

  const completedRows = db.prepare(
    `SELECT id, display_id, completed_at FROM tasks WHERE completed_at IS NOT NULL`
  ).all();
  const deletedRows = db.prepare(
    `SELECT id, display_id, deleted_at FROM tasks WHERE deleted_at IS NOT NULL`
  ).all();
  const hasStatusDone = db.prepare(
    `SELECT 1 FROM task_events WHERE task_id = ? AND event_type = 'status_changed' AND new_value = 'done'`
  );
  const hasDeleted = db.prepare(
    `SELECT 1 FROM task_events WHERE task_id = ? AND event_type = 'deleted'`
  );

  if (!dryRun) db.exec('BEGIN');
  try {
    for (const row of completedRows) {
      if (hasStatusDone.get(row.id)) { stats.statusChangedSkipped += 1; continue; }
      stats.statusChangedInserted += 1;
      if (!dryRun) {
        tasksRepo.insertEvent(db, {
          taskId: row.id, taskDisplayId: row.display_id, eventType: 'status_changed',
          oldValue: null, newValue: 'done', actor: 'user', occurredAt: row.completed_at,
        });
      }
    }
    for (const row of deletedRows) {
      if (hasDeleted.get(row.id)) { stats.deletedSkipped += 1; continue; }
      stats.deletedInserted += 1;
      if (!dryRun) {
        tasksRepo.insertEvent(db, {
          taskId: row.id, taskDisplayId: row.display_id, eventType: 'deleted',
          actor: 'user', occurredAt: row.deleted_at,
        });
      }
    }
    if (!dryRun) db.exec('COMMIT');
  } catch (e) {
    if (!dryRun) db.exec('ROLLBACK');
    throw e;
  }

  return stats;
}

module.exports = { backfillTaskEvents };

// CLI実行: node db/backfill-task-events.js <dbPath> [--dry-run]
if (require.main === module) {
  const fs = require('fs');
  const { DatabaseSync } = require('node:sqlite');

  const dbPath = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!dbPath) {
    console.error('使い方: node db/backfill-task-events.js <dbPath> [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`DBファイルが見つかりません: ${dbPath}`);
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);
  try {
    const stats = backfillTaskEvents(db, { dryRun });
    console.log(dryRun ? '[backfill] ドライラン結果(書き込みなし):' : '[backfill] 完了:', stats);
  } finally {
    db.close();
  }
}
