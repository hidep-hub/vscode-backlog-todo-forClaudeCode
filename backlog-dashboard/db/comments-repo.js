'use strict';

// タスクコメント(BM-136)のリポジトリ層。task_commentsはschema.jsで定義。
// 状況メモを日時つきで追記していくための仕組みで、編集はできず、追加と削除だけを持つ。
// 履歴(task_events)には記録せず、tasks.updated_at / updated_byも更新しない(サイレント)。
// コメントの日時はコメント自身が持つため、タスクの「更新者」を書き換えたくない。

const tasksRepo = require('./tasks-repo');
const { fail } = require('./name-normalizer');

const MAX_BODY_LENGTH = 1000; // 1件あたりの上限(文字数)
const PREVIEW_LENGTH = 120; // board配信に載せる最新コメントの先頭文字数

function toCommentItem(row) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** 本文を整える。改行はLFにそろえ、前後の空白を除く。空・長すぎはinvalid_body。 */
function cleanBody(body) {
  if (typeof body !== 'string') throw fail('invalid_body', 'コメント本文は文字列で指定してください');
  const cleaned = body.replace(/\r\n?/g, '\n').trim();
  if (!cleaned) throw fail('invalid_body', 'コメントが空です');
  if ([...cleaned].length > MAX_BODY_LENGTH) throw fail('invalid_body', `コメントは${MAX_BODY_LENGTH}文字以内にしてください`);
  return cleaned;
}

function preview(body) {
  const chars = [...body];
  return chars.length > PREVIEW_LENGTH ? chars.slice(0, PREVIEW_LENGTH).join('') : body;
}

/**
 * タスクにコメントを追加する。
 * @returns {{comment: object, commentCount: number}}
 */
function addComment(db, displayId, body, actor = 'user') {
  const task = tasksRepo.getByDisplayId(db, displayId);
  if (!task) throw fail('not_found', `Task not found: ${displayId}`);
  const text = cleanBody(body);
  const now = new Date().toISOString();
  const result = db.prepare('INSERT INTO task_comments (task_id, body, created_at, created_by) VALUES (?, ?, ?, ?)')
    .run(task.id, text, now, actor);
  const row = db.prepare('SELECT * FROM task_comments WHERE id = ?').get(result.lastInsertRowid);
  const count = db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(task.id).n;
  return { comment: toCommentItem(row), commentCount: count };
}

/**
 * コメントを削除する(誤入力の取り消し用)。
 * @returns {{taskId: string, commentCount: number}} 対象タスクの表示IDと、削除後の件数
 */
function deleteComment(db, commentId) {
  const row = db.prepare(`SELECT c.id AS id, c.task_id AS task_id, k.display_id AS display_id
    FROM task_comments c JOIN tasks k ON k.id = c.task_id WHERE c.id = ?`).get(commentId);
  if (!row) throw fail('comment_not_found', `コメントが見つかりません: ${commentId}`);
  db.prepare('DELETE FROM task_comments WHERE id = ?').run(row.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(row.task_id).n;
  return { taskId: row.display_id, commentCount: count };
}

/** タスク1件のコメント全件(新しい順)。taskIdは内部ID(tasks.id)。 */
function listCommentsForTaskId(db, taskId) {
  return db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at DESC, id DESC')
    .all(taskId).map(toCommentItem);
}

/**
 * 表示IDでタスクを引いて、コメント全件(新しい順)を返す。タスクが無ければnot_found。
 * @returns {{taskId: string, comments: Array}}
 */
function listComments(db, displayId) {
  const task = tasksRepo.getByDisplayId(db, displayId);
  if (!task) throw fail('not_found', `Task not found: ${displayId}`);
  return { taskId: displayId, comments: listCommentsForTaskId(db, task.id) };
}

/**
 * board配信用の要約。タスクごとに件数と最新1件(本文は先頭120文字)だけを返す。
 * 全件を載せるとboardのWebSocket配信が肥大化するため、全件は詳細取得(listComments)に任せる。
 * taskIdsを省略/nullにすると全タスク分、配列を渡すとそのタスクだけ(IN句)。
 * @returns {Object<number, {count:number, latest:{id,body,createdAt,createdBy}}>} 内部task_idをキーとする
 */
function summarizeForTasks(db, taskIds = null) {
  const scoped = Array.isArray(taskIds);
  if (scoped && taskIds.length === 0) return {};
  const where = scoped ? `WHERE task_id IN (${taskIds.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`
    SELECT c.task_id AS task_id, c.id AS id, c.body AS body, c.created_at AS created_at,
           c.created_by AS created_by, n.cnt AS cnt
    FROM task_comments c
    JOIN (SELECT task_id, COUNT(*) AS cnt, MAX(id) AS max_id FROM task_comments ${where} GROUP BY task_id) n
      ON n.task_id = c.task_id AND n.max_id = c.id
  `).all(...(scoped ? taskIds : []));
  const byTaskId = {};
  for (const r of rows) {
    byTaskId[r.task_id] = {
      count: r.cnt,
      latest: { id: r.id, body: preview(r.body), createdAt: r.created_at, createdBy: r.created_by },
    };
  }
  return byTaskId;
}

/**
 * 週報用。指定期間内(startIso以上、endExclusiveIso未満。UTCのISO文字列)に投稿されたコメントのうち、
 * タスクごとに最新の1件(本文は全文)を返す。期間外のコメントは対象にしない。
 * @returns {Object<number, {id:number, body:string, createdAt:string, createdBy:string}>} 内部task_idをキーとする
 */
function latestInRangeForTasks(db, taskIds, startIso, endExclusiveIso) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return {};
  const rows = db.prepare(`
    SELECT c.* FROM task_comments c
    JOIN (SELECT task_id, MAX(id) AS max_id FROM task_comments
          WHERE task_id IN (${taskIds.map(() => '?').join(',')}) AND created_at >= ? AND created_at < ?
          GROUP BY task_id) n
      ON n.task_id = c.task_id AND n.max_id = c.id
  `).all(...taskIds, startIso, endExclusiveIso);
  const byTaskId = {};
  for (const r of rows) byTaskId[r.task_id] = toCommentItem(r);
  return byTaskId;
}

module.exports = {
  MAX_BODY_LENGTH, PREVIEW_LENGTH,
  addComment, deleteComment, listComments, listCommentsForTaskId, summarizeForTasks, latestInRangeForTasks,
};
