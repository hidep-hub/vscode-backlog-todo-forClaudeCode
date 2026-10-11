'use strict';

// タグ機能(EPIC BT-391)のリポジトリ層(BT-393)。tags/task_tagsはBT-392で追加済み。
// タグはワークスペース単位で管理し、名前の重複判定は表記ゆれを正規化したname_keyで行う。
// 自由入力でタグが乱立しないよう、作成時は完全一致を拒否し、似た名前がある場合は
// 呼び出し側が明示的に確認(confirmSimilar)しない限り拒否する。

const tasksRepo = require('./tasks-repo');

const MAX_NAME_LENGTH = 40;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function fail(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 表示用のタグ名を整える。NFKC正規化(全角英数→半角、半角カナ→全角カナ等)・連続空白の圧縮・前後trim。
 * 大文字小文字は表示のため保持する。
 */
function cleanName(name) {
  if (typeof name !== 'string') throw fail('invalid_name', 'タグ名は文字列で指定してください');
  const cleaned = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!cleaned) throw fail('invalid_name', 'タグ名が空です');
  if ([...cleaned].length > MAX_NAME_LENGTH) throw fail('invalid_name', `タグ名は${MAX_NAME_LENGTH}文字以内にしてください`);
  return cleaned;
}

/** 重複判定用キー。cleanName後の文字列を小文字化する。 */
function toNameKey(cleanedName) {
  return cleanedName.toLowerCase();
}

function normalizeColor(color) {
  if (color === undefined || color === null || color === '') return null;
  if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
    throw fail('invalid_color', 'colorは#rrggbb形式で指定してください');
  }
  return color.toLowerCase();
}

function levenshtein(a, b) {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

// 片方がもう片方を含む(2文字以上)か、4文字以上で編集距離1以内なら「似ている」とみなす。
function isSimilarKey(a, b) {
  const shorter = Math.min([...a].length, [...b].length);
  if (shorter >= 2 && (a.includes(b) || b.includes(a))) return true;
  return shorter >= 4 && levenshtein(a, b) <= 1;
}

function toTagItem(row) {
  return {
    id: row.id,
    workspace: row.workspace,
    name: row.name,
    color: row.color || null,
    sortOrder: row.sort_order,
    usageCount: row.usage_count === undefined ? undefined : row.usage_count,
  };
}

function getTag(db, tagId) {
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(tagId) || null;
}

/**
 * タグ一覧(使用数付き)。使用数は論理削除されていないタスクへの付与のみ数える。
 * workspace省略時は全ワークスペース。
 */
function listTags(db, workspace = null) {
  const rows = db.prepare(`
    SELECT t.*, (
      SELECT COUNT(*) FROM task_tags tt
      JOIN tasks k ON k.id = tt.task_id
      WHERE tt.tag_id = t.id AND k.deleted_at IS NULL
    ) AS usage_count
    FROM tags t
    ${workspace ? 'WHERE t.workspace = ?' : ''}
    ORDER BY t.workspace, t.sort_order, t.name_key
  `).all(...(workspace ? [workspace] : []));
  return rows.map(toTagItem);
}

/**
 * 与えた名前に似た既存タグ(完全一致は含まない)を返す。excludeIdは改名時の自分自身の除外用。
 */
function findSimilarTags(db, workspace, name, { excludeId = null } = {}) {
  const key = toNameKey(cleanName(name));
  return db.prepare('SELECT * FROM tags WHERE workspace = ?').all(workspace)
    .filter(t => t.id !== excludeId && t.name_key !== key && isSimilarKey(key, t.name_key))
    .map(toTagItem);
}

function findByKey(db, workspace, nameKey) {
  return db.prepare('SELECT * FROM tags WHERE workspace = ? AND name_key = ?').get(workspace, nameKey) || null;
}

/**
 * タグを作成する。
 * - 同一ワークスペースに同じ名前(表記ゆれ込み)があれば duplicate_tag(err.existing)
 * - 似た名前があり confirmSimilar が真でなければ similar_tags(err.similar)
 */
function createTag(db, { workspace, name, color = null, confirmSimilar = false, actor = 'user' }) {
  if (typeof workspace !== 'string' || !workspace) throw fail('invalid_workspace', 'workspaceは必須です');
  if (!db.prepare('SELECT 1 FROM counters WHERE workspace = ?').get(workspace)) {
    throw fail('unknown_workspace', `ワークスペースが見つかりません: ${workspace}`);
  }
  const cleaned = cleanName(name);
  const key = toNameKey(cleaned);
  const normalizedColor = normalizeColor(color);

  const existing = findByKey(db, workspace, key);
  if (existing) throw fail('duplicate_tag', `同じ名前のタグが既にあります: ${existing.name}`, { existing: toTagItem(existing) });
  if (!confirmSimilar) {
    const similar = findSimilarTags(db, workspace, cleaned);
    if (similar.length > 0) throw fail('similar_tags', '似た名前のタグが既にあります', { similar });
  }

  const now = new Date().toISOString();
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tags WHERE workspace = ?').get(workspace).m;
  const result = db.prepare(`INSERT INTO tags (workspace, name, name_key, color, sort_order, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workspace, cleaned, key, normalizedColor, maxSort + 1, now, actor, now, actor);
  return toTagItem(getTag(db, result.lastInsertRowid));
}

/**
 * タグの改名・色変更。渡したフィールドのみ更新する(color: null/空文字で色を消す)。
 * 改名先が他タグと完全一致する場合は duplicate_tag。
 */
function updateTag(db, tagId, { name, color }, actor = 'user') {
  const tag = getTag(db, tagId);
  if (!tag) throw fail('tag_not_found', `タグが見つかりません: ${tagId}`);
  let nextName = tag.name;
  let nextKey = tag.name_key;
  let nextColor = tag.color;
  if (name !== undefined) {
    nextName = cleanName(name);
    nextKey = toNameKey(nextName);
    const clash = findByKey(db, tag.workspace, nextKey);
    if (clash && clash.id !== tag.id) {
      throw fail('duplicate_tag', `同じ名前のタグが既にあります: ${clash.name}`, { existing: toTagItem(clash) });
    }
  }
  if (color !== undefined) nextColor = normalizeColor(color);
  db.prepare('UPDATE tags SET name = ?, name_key = ?, color = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(nextName, nextKey, nextColor, new Date().toISOString(), actor, tag.id);
  return toTagItem(getTag(db, tag.id));
}

function liveTaskRowsForTag(db, tagId) {
  return db.prepare(`SELECT k.id, k.display_id FROM task_tags tt
    JOIN tasks k ON k.id = tt.task_id
    WHERE tt.tag_id = ? AND k.deleted_at IS NULL ORDER BY k.id`).all(tagId);
}

function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * タグを削除する。付与されていたタスクにはtag_removedを記録し、付与行も削除する。
 */
function deleteTag(db, tagId, actor = 'user') {
  const tag = getTag(db, tagId);
  if (!tag) throw fail('tag_not_found', `タグが見つかりません: ${tagId}`);
  return inTransaction(db, () => {
    const tasks = liveTaskRowsForTag(db, tag.id);
    for (const t of tasks) {
      tasksRepo.insertEvent(db, { taskId: t.id, taskDisplayId: t.display_id, eventType: 'tag_removed', oldValue: tag.name, actor });
    }
    db.prepare('DELETE FROM task_tags WHERE tag_id = ?').run(tag.id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    return { removedFromTasks: tasks.length };
  });
}

/**
 * sourceをtargetへ統合する(sourceは削除される)。同一ワークスペース内のみ。
 * sourceが付いていたタスクにはtargetを付与(既に付いていれば何もしない)し、履歴を記録する。
 */
function mergeTags(db, sourceId, targetId, actor = 'user') {
  if (sourceId === targetId) throw fail('same_tag', '同じタグは統合できません');
  const source = getTag(db, sourceId);
  const target = getTag(db, targetId);
  if (!source || !target) throw fail('tag_not_found', 'タグが見つかりません');
  if (source.workspace !== target.workspace) throw fail('workspace_mismatch', '別ワークスペースのタグは統合できません');
  return inTransaction(db, () => {
    const now = new Date().toISOString();
    const tasks = liveTaskRowsForTag(db, source.id);
    let added = 0;
    for (const t of tasks) {
      const has = db.prepare('SELECT 1 FROM task_tags WHERE task_id = ? AND tag_id = ?').get(t.id, target.id);
      if (!has) {
        db.prepare('INSERT INTO task_tags (task_id, tag_id, created_at, created_by) VALUES (?, ?, ?, ?)').run(t.id, target.id, now, actor);
        tasksRepo.insertEvent(db, { taskId: t.id, taskDisplayId: t.display_id, eventType: 'tag_added', newValue: target.name, actor });
        added++;
      }
      tasksRepo.insertEvent(db, { taskId: t.id, taskDisplayId: t.display_id, eventType: 'tag_removed', oldValue: source.name, actor });
    }
    db.prepare('DELETE FROM task_tags WHERE tag_id = ?').run(source.id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(source.id);
    return { mergedTasks: tasks.length, newlyTaggedTasks: added };
  });
}

/**
 * タスクのタグを付け外しする。実際に変化した分だけtag_added/tag_removedを記録する。
 * 付与できるのは既存タグのみで、タスクと同じワークスペースのものに限る。
 * @returns {Array} 変更後のタグ一覧({id,name,color})
 */
function updateTaskTags(db, displayId, { add = [], remove = [] }, actor = 'user') {
  const task = tasksRepo.getByDisplayId(db, displayId);
  if (!task) throw fail('not_found', `Task not found: ${displayId}`);
  const addTags = [];
  for (const id of add) {
    const tag = getTag(db, id);
    if (!tag) throw fail('tag_not_found', `タグが見つかりません: ${id}`);
    if (tag.workspace !== task.workspace) throw fail('workspace_mismatch', `別ワークスペースのタグは付けられません: ${tag.name}`);
    addTags.push(tag);
  }
  inTransaction(db, () => {
    const now = new Date().toISOString();
    for (const tag of addTags) {
      const has = db.prepare('SELECT 1 FROM task_tags WHERE task_id = ? AND tag_id = ?').get(task.id, tag.id);
      if (has) continue;
      db.prepare('INSERT INTO task_tags (task_id, tag_id, created_at, created_by) VALUES (?, ?, ?, ?)').run(task.id, tag.id, now, actor);
      tasksRepo.insertEvent(db, { taskId: task.id, taskDisplayId: displayId, eventType: 'tag_added', newValue: tag.name, actor });
    }
    for (const id of remove) {
      const tag = getTag(db, id);
      if (!tag) continue;
      const result = db.prepare('DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?').run(task.id, tag.id);
      if (result.changes > 0) {
        tasksRepo.insertEvent(db, { taskId: task.id, taskDisplayId: displayId, eventType: 'tag_removed', oldValue: tag.name, actor });
      }
    }
    db.prepare('UPDATE tasks SET updated_at = ?, updated_by = ? WHERE id = ?').run(now, actor, task.id);
  });
  return listTagsForTasks(db, [task.id])[task.id] || [];
}

/**
 * タスクIDごとのタグ配列({id,name,color})を返す。taskIds省略/nullは全タスク分(board全件取得用)。
 * 並びはタグのsort_order→name_key。
 * @returns {Object<number, Array<{id:number,name:string,color:string|null}>>}
 */
function listTagsForTasks(db, taskIds = null) {
  const scoped = Array.isArray(taskIds);
  if (scoped && taskIds.length === 0) return {};
  const rows = db.prepare(`
    SELECT tt.task_id AS task_id, t.id AS id, t.name AS name, t.color AS color
    FROM task_tags tt JOIN tags t ON t.id = tt.tag_id
    ${scoped ? `WHERE tt.task_id IN (${taskIds.map(() => '?').join(',')})` : ''}
    ORDER BY t.sort_order, t.name_key
  `).all(...(scoped ? taskIds : []));
  const byTaskId = {};
  for (const r of rows) {
    (byTaskId[r.task_id] = byTaskId[r.task_id] || []).push({ id: r.id, name: r.name, color: r.color || null });
  }
  return byTaskId;
}

module.exports = {
  cleanName, toNameKey, isSimilarKey,
  listTags, getTag, findSimilarTags, createTag, updateTag, deleteTag, mergeTags,
  updateTaskTags, listTagsForTasks,
};
