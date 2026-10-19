'use strict';

// カテゴリ機能(EPIC BM-101)のリポジトリ層(BM-105)。
// name_key正規化・重複/類似名チェック・sort_orderはtagsと同じ骨格だが、カテゴリは
// 「システムで一意」(ヒデさんの運用認識)のためワークスペースの概念を持たない
// (タグはワークスペース単位で分かれるが、カテゴリは全ワークスペース共通の名前空間)。
// 1タスク1カテゴリのため中間テーブルも持たず、tasks.category列(既存の非正規化列)に
// 名前文字列をそのまま保存する。改名・削除・統合時はマスタとtasks.categoryを同じ
// トランザクションで更新し、category_changed(BM-105)イベントを記録する。

const tasksRepo = require('./tasks-repo');
const { fail, cleanName, toNameKey, normalizeColor, isSimilarKey } = require('./name-normalizer');

function toCategoryItem(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color || null,
    sortOrder: row.sort_order,
    usageCount: row.usage_count === undefined ? undefined : row.usage_count,
  };
}

function getCategory(db, categoryId) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId) || null;
}

/**
 * カテゴリ一覧(使用数付き)。使用数は論理削除されていないタスクのtasks.category一致で
 * ワークスペース横断に数える(tagsのような中間テーブルが無いため、名前の一致で集計する)。
 */
function listCategories(db) {
  const rows = db.prepare(`
    SELECT c.*, (
      SELECT COUNT(*) FROM tasks k
      WHERE k.category = c.name AND k.deleted_at IS NULL
    ) AS usage_count
    FROM categories c
    ORDER BY c.sort_order, c.name_key
  `).all();
  return rows.map(toCategoryItem);
}

/**
 * 与えた名前に似た既存カテゴリ(完全一致は含まない)を返す。excludeIdは改名時の自分自身の除外用。
 */
function findSimilarCategories(db, name, { excludeId = null } = {}) {
  const key = toNameKey(cleanName(name));
  return db.prepare('SELECT * FROM categories').all()
    .filter(c => c.id !== excludeId && c.name_key !== key && isSimilarKey(key, c.name_key))
    .map(toCategoryItem);
}

function findByKey(db, nameKey) {
  return db.prepare('SELECT * FROM categories WHERE name_key = ?').get(nameKey) || null;
}

/**
 * カテゴリを作成する。
 * - 同じ名前(表記ゆれ込み)が既にあれば duplicate_category(err.existing)
 * - 似た名前があり confirmSimilar が真でなければ similar_categories(err.similar)
 */
function createCategory(db, { name, color = null, confirmSimilar = false, actor = 'user' }) {
  const cleaned = cleanName(name);
  const key = toNameKey(cleaned);
  const normalizedColor = normalizeColor(color);

  const existing = findByKey(db, key);
  if (existing) throw fail('duplicate_category', `同じ名前のカテゴリが既にあります: ${existing.name}`, { existing: toCategoryItem(existing) });
  if (!confirmSimilar) {
    const similar = findSimilarCategories(db, cleaned);
    if (similar.length > 0) throw fail('similar_categories', '似た名前のカテゴリが既にあります', { similar });
  }

  const now = new Date().toISOString();
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories').get().m;
  const result = db.prepare(`INSERT INTO categories (name, name_key, color, sort_order, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(cleaned, key, normalizedColor, maxSort + 1, now, actor, now, actor);
  return toCategoryItem(getCategory(db, result.lastInsertRowid));
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

/** 名前一致(ワークスペース横断)で、カテゴリが付いている生存タスクを返す。 */
function liveTaskRowsForCategory(db, categoryName) {
  return db.prepare(`SELECT id, display_id FROM tasks
    WHERE category = ? AND deleted_at IS NULL ORDER BY id`).all(categoryName);
}

/**
 * カテゴリの改名・色変更。渡したフィールドのみ更新する(color: null/空文字で色を消す)。
 * 改名先が他カテゴリと完全一致する場合は duplicate_category。
 * 名前が実際に変化した場合、紐づく(tasks.category一致の、ワークスペース横断)全タスクの
 * category列も新しい名前へ一括更新し、タスクごとにcategory_changedイベントを記録する
 * (mergeTagsと同じ考え方)。
 */
function updateCategory(db, categoryId, { name, color }, actor = 'user') {
  const category = getCategory(db, categoryId);
  if (!category) throw fail('category_not_found', `カテゴリが見つかりません: ${categoryId}`);
  let nextName = category.name;
  let nextKey = category.name_key;
  let nextColor = category.color;
  if (name !== undefined) {
    nextName = cleanName(name);
    nextKey = toNameKey(nextName);
    const clash = findByKey(db, nextKey);
    if (clash && clash.id !== category.id) {
      throw fail('duplicate_category', `同じ名前のカテゴリが既にあります: ${clash.name}`, { existing: toCategoryItem(clash) });
    }
  }
  if (color !== undefined) nextColor = normalizeColor(color);

  return inTransaction(db, () => {
    const now = new Date().toISOString();
    if (name !== undefined && nextName !== category.name) {
      const tasks = liveTaskRowsForCategory(db, category.name);
      const updateTaskStmt = db.prepare('UPDATE tasks SET category = ?, updated_at = ?, updated_by = ? WHERE id = ?');
      for (const t of tasks) {
        updateTaskStmt.run(nextName, now, actor, t.id);
        tasksRepo.insertEvent(db, { taskId: t.id, taskDisplayId: t.display_id, eventType: 'category_changed', oldValue: category.name, newValue: nextName, actor });
      }
    }
    db.prepare('UPDATE categories SET name = ?, name_key = ?, color = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(nextName, nextKey, nextColor, now, actor, category.id);
    return toCategoryItem(getCategory(db, category.id));
  });
}

/**
 * カテゴリを削除する。紐づく(tasks.category一致の、ワークスペース横断)全タスクのcategory列
 * をNULLに戻し、タスクごとにcategory_changedイベント(new_value: null)を記録する。
 */
function deleteCategory(db, categoryId, actor = 'user') {
  const category = getCategory(db, categoryId);
  if (!category) throw fail('category_not_found', `カテゴリが見つかりません: ${categoryId}`);
  return inTransaction(db, () => {
    const now = new Date().toISOString();
    const tasks = liveTaskRowsForCategory(db, category.name);
    const updateTaskStmt = db.prepare('UPDATE tasks SET category = NULL, updated_at = ?, updated_by = ? WHERE id = ?');
    for (const t of tasks) {
      updateTaskStmt.run(now, actor, t.id);
      tasksRepo.insertEvent(db, { taskId: t.id, taskDisplayId: t.display_id, eventType: 'category_changed', oldValue: category.name, newValue: null, actor });
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
    return { removedFromTasks: tasks.length };
  });
}

/**
 * sourceをtargetへ統合する(sourceは削除される)。
 * sourceのカテゴリが付いていた全タスク(ワークスペース横断)をtargetのカテゴリ名へ付け替え、
 * 履歴を記録する。
 */
function mergeCategories(db, sourceId, targetId, actor = 'user') {
  if (sourceId === targetId) throw fail('same_category', '同じカテゴリは統合できません');
  const source = getCategory(db, sourceId);
  const target = getCategory(db, targetId);
  if (!source || !target) throw fail('category_not_found', 'カテゴリが見つかりません');
  return inTransaction(db, () => {
    const now = new Date().toISOString();
    const tasks = liveTaskRowsForCategory(db, source.name);
    const updateTaskStmt = db.prepare('UPDATE tasks SET category = ?, updated_at = ?, updated_by = ? WHERE id = ?');
    for (const t of tasks) {
      updateTaskStmt.run(target.name, now, actor, t.id);
      tasksRepo.insertEvent(db, { taskId: t.id, taskDisplayId: t.display_id, eventType: 'category_changed', oldValue: source.name, newValue: target.name, actor });
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(source.id);
    return { mergedTasks: tasks.length };
  });
}

/**
 * add-task/update-task統合用(BM-105方針): 渡された名前をマスタと照合し、
 * 正規化された(マスタに登録されている表記そのままの)カテゴリ名を返す。
 * 空文字/null/undefinedは「カテゴリなし」として常に許可しnullを返す。
 * マスタに存在しない名前はunknown_categoryで拒否する(自由入力による乱立を防ぐ)。
 */
function resolveCategoryName(db, name) {
  if (name === undefined || name === null || name === '') return null;
  let key;
  try {
    key = toNameKey(cleanName(name));
  } catch (e) {
    throw fail('unknown_category', `カテゴリが見つかりません: ${name}`);
  }
  const found = findByKey(db, key);
  if (!found) throw fail('unknown_category', `カテゴリが見つかりません: ${name}`);
  return found.name;
}

module.exports = {
  listCategories, getCategory, findSimilarCategories, createCategory, updateCategory,
  deleteCategory, mergeCategories, resolveCategoryName,
};
