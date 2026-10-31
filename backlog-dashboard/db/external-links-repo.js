'use strict';

// BM-071: 外部ITS(Redmine/GitLab)連携リンク(task_external_links)のリポジトリ層。
// GitHubは既存のtasks.github_issue_*列のまま触らず、Redmine/GitLabはこちらを使う
// (source列で区別。1タスクにつきsourceごとに1件まで)。
// 「紐付いているタスク」の対象は「同じsource/host/projectRef/issueKeyで、タスクが論理削除されていないもの」。
// 削除済みタスクのチケットは再度取り込める(現行GitHubと同じ挙動、BM-069方針C)。
// BM-158: 1チケット:nタスクを許可している(UNIQUEは(task_id, source)のみ)。そのため
// 「紐付いているタスク」は常に配列(0件以上)で返し、タスク作成順(tasks.id順)に並べる。

/**
 * 指定チケット(source/host/projectRef/issueKey)に紐付いている、論理削除されていないタスクの
 * display_idを返す。取り込みプレビューの「取込済み」表示と、紐づけ時の共有確認で使う。
 * @param {string|null} excludeDisplayId 結果から除くタスク(自分自身への再紐づけを共有扱いにしない)
 * @returns {string[]} 紐付いているタスクのdisplay_id(無ければ空配列)
 */
function findLinkedTasks(db, { source, host, projectRef, issueKey }, excludeDisplayId = null) {
  const rows = db.prepare(`
    SELECT t.display_id AS display_id
    FROM task_external_links l
    JOIN tasks t ON t.id = l.task_id
    WHERE l.source = ? AND l.host = ? AND l.project_ref = ? AND l.issue_key = ?
      AND t.deleted_at IS NULL AND t.display_id != ?
    ORDER BY t.id
  `).all(source, host, projectRef, String(issueKey), excludeDisplayId || '');
  return rows.map((r) => r.display_id);
}

/**
 * 複数チケットキーについて、まとめて取込済み判定を行う(プレビュー一覧の都度クエリを避ける)。
 * @param {Array<string|number>} issueKeys
 * @returns {Map<string, string[]>} issueKey(文字列化) -> 紐付いているタスクのdisplay_id配列(1件以上のキーだけ入る)
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
    ORDER BY t.id
  `).all(source, host, projectRef, ...issueKeys.map(String));
  for (const row of rows) {
    if (!result.has(row.issue_key)) result.set(row.issue_key, []);
    result.get(row.issue_key).push(row.display_id);
  }
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

/**
 * タスクに外部リンクを1件設定する(BM-126: 既存タスクへ後から紐づける/上書きする用。
 * insertLink()と異なり、同一(task_id, source)が既にあれば上書きする(間違えた場合の修正を想定)。
 * UNIQUE(task_id, source)に対するON CONFLICTで、INSERTとUPDATEを1文にまとめている。
 */
function setLink(db, { taskId, source, host, projectRef, issueKey, issueUrl, linkedBy = 'user', linkedAt = null }) {
  const now = linkedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO task_external_links (task_id, source, host, project_ref, issue_key, issue_url, linked_at, linked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, source) DO UPDATE SET
      host = excluded.host,
      project_ref = excluded.project_ref,
      issue_key = excluded.issue_key,
      issue_url = excluded.issue_url,
      linked_at = excluded.linked_at,
      linked_by = excluded.linked_by
  `).run(taskId, source, host, projectRef, String(issueKey), issueUrl, now, linkedBy);
}

/**
 * タスクの外部リンクを(task_id, source)で1件削除する(BT-470)。削除した行があればtrue。
 */
function removeLink(db, { taskId, source }) {
  const r = db.prepare('DELETE FROM task_external_links WHERE task_id = ? AND source = ?').run(taskId, source);
  return r.changes > 0;
}

module.exports = {
  findLinkedTasks,
  findLinkedTasksByKeys,
  listLinksForTasks,
  insertLink,
  setLink,
  removeLink,
};
