'use strict';

// BM-071: 外部ITS(Redmine/GitLab)連携リンク(task_external_links)のリポジトリ層。
// GitHubは既存のtasks.github_issue_*列のまま触らず、Redmine/GitLabはこちらを使う
// (source列で区別。1タスクにつきsourceごとに1件まで)。
// 重複判定の対象は「同じsource/host/projectRef/issueKeyで、タスクが論理削除されていないもの」。
// 削除済みタスクのチケットは再度取り込める(現行GitHubと同じ挙動、BM-069方針C)。

/**
 * 指定チケット(source/host/projectRef/issueKey)が、論理削除されていないタスクに
 * 既に紐付いているかを調べる。取り込みプレビューの「取込済み」判定で使う。
 * @returns {{taskId: string}|null} 紐付いていればタスクのdisplay_id、無ければnull
 */
function findLinkedTask(db, { source, host, projectRef, issueKey }) {
  const row = db.prepare(`
    SELECT t.display_id AS display_id
    FROM task_external_links l
    JOIN tasks t ON t.id = l.task_id
    WHERE l.source = ? AND l.host = ? AND l.project_ref = ? AND l.issue_key = ?
      AND t.deleted_at IS NULL
  `).get(source, host, projectRef, String(issueKey));
  return row ? { taskId: row.display_id } : null;
}

/**
 * 複数チケットキーについて、まとめて取込済み判定を行う(プレビュー一覧の都度クエリを避ける)。
 * @param {Array<string|number>} issueKeys
 * @returns {Map<string, string>} issueKey(文字列化) -> taskId のMap
 */
function findLinkedTasksByKeys(db, { source, host, projectRef, issueKeys }) {
  const result = new Map();
  if (!issueKeys || issueKeys.length === 0) return result;
  const placeholders = issueKeys.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT l.issue_key AS issue_key, t.display_id AS display_id
    FROM task_external_links l
    JOIN tasks t ON t.id = l.task_id
    WHERE l.source = ? AND l.host = ? AND l.project_ref = ? AND l.issue_key IN (${placeholders})
      AND t.deleted_at IS NULL
  `).all(source, host, projectRef, ...issueKeys.map(String));
  for (const row of rows) result.set(row.issue_key, row.display_id);
  return result;
}

/**
 * タスクに紐付いている外部リンク一覧を返す(board/詳細表示用)。
 * taskIds省略/nullは全タスク分(tagsRepo.listTagsForTasks()と同じ方針。All Projects時に
 * 952件分のIN句を展開しないため)。
 * @param {Array<number>|null} taskIds
 * @returns {Object<number, Array<{source, key, url, projectRef}>>}
 */
function listLinksForTasks(db, taskIds = null) {
  const scoped = Array.isArray(taskIds);
  if (scoped && taskIds.length === 0) return {};
  const rows = db.prepare(`
    SELECT task_id, source, issue_key, issue_url, project_ref
    FROM task_external_links
    ${scoped ? `WHERE task_id IN (${taskIds.map(() => '?').join(',')})` : ''}
  `).all(...(scoped ? taskIds : []));
  const byTaskId = {};
  for (const r of rows) {
    (byTaskId[r.task_id] = byTaskId[r.task_id] || []).push({
      source: r.source,
      key: r.issue_key,
      url: r.issue_url,
      projectRef: r.project_ref,
    });
  }
  return byTaskId;
}

/**
 * タスクに外部リンクを1件追加する(呼び出し元のトランザクション内で呼ぶ想定。
 * tasksRepo.create()が内部でBEGIN/COMMITを持つため、トランザクションを入れ子にできない。
 * そのため、タスク作成とリンク登録は呼び出し元で同じBEGIN/COMMITに収める)。
 * UNIQUE(task_id, source)により、同じタスクへの同source二重登録はSQLiteレベルで防がれる。
 */
function insertLink(db, { taskId, source, host, projectRef, issueKey, issueUrl, linkedBy = 'user', linkedAt = null }) {
  const now = linkedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO task_external_links (task_id, source, host, project_ref, issue_key, issue_url, linked_at, linked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, source, host, projectRef, String(issueKey), issueUrl, now, linkedBy);
}

module.exports = {
  findLinkedTask,
  findLinkedTasksByKeys,
  listLinksForTasks,
  insertLink,
};
