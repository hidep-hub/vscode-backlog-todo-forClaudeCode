'use strict';

// タスクCRUDの基本操作(BT-186)。個々のAPI固有ロジック(GitHub連携、reorderの
// スコープ確定、ワークスペース移管の再採番等)は後続タスク(BT-189〜193)で追加する。
// 親子の深さ制限(2階層まで)はDB制約ではなくここ(attachToParent)で検証する
// (docs/design/backlog-db-schema-design-epic-bt169.md BT-182決定事項)。

function nowIso() {
  return new Date().toISOString();
}

/**
 * displayId(例 "BT-181")から内部行を1件取得する。無ければnull。
 */
function getByDisplayId(db, displayId) {
  return db.prepare('SELECT * FROM tasks WHERE display_id = ? AND deleted_at IS NULL').get(displayId) || null;
}

/**
 * 指定ワークスペースの全タスク(削除済み除く)をフラットに返す。
 */
function listByWorkspace(db, workspace) {
  return db.prepare('SELECT * FROM tasks WHERE workspace = ? AND deleted_at IS NULL ORDER BY sort_order').all(workspace);
}

/**
 * 全ワークスペースの全タスク(削除済み除く)をフラットに返す(board用)。
 */
function listAll(db) {
  return db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY workspace, sort_order').all();
}

/**
 * counters.next_seqを払い出し、1件分インクリメントする(既存initCounter()と同じ意味づけ:
 * next_seqは「次に払い出す番号」)。counters行が無いワークスペースはエラーにする
 * (create-workspace API側でcounters行を作る責務を持つ想定、BT-193)。
 */
function allocateSeq(db, workspace) {
  const row = db.prepare('SELECT prefix, next_seq FROM counters WHERE workspace = ?').get(workspace);
  if (!row) throw new Error(`counters行が存在しないワークスペースです: ${workspace}`);
  db.prepare('UPDATE counters SET next_seq = next_seq + 1 WHERE workspace = ?').run(workspace);
  return { prefix: row.prefix, seqNo: row.next_seq };
}

/**
 * タスクを新規作成する。parentDisplayIdを渡すと子タスクとして作成する
 * (この場合、子は親と同じworkspaceに属する。渡されたworkspaceより親のworkspaceを優先する)。
 * sort_orderは暫定でMAX(sort_order)+1を使う(正式なスコープ確定はBT-189で完了、
 * reorder呼び出しまではこの暫定値のまま)。
 */
function create(db, { workspace, title, status, category = null, description = null, assignee = null,
  startDate = null, dueDate = null, parentDisplayId = null, createdBy = 'user',
  githubIssueNumber = null, githubIssueUrl = null }) {
  const parentRow = parentDisplayId ? getByDisplayId(db, parentDisplayId) : null;
  if (parentDisplayId && !parentRow) throw new Error(`親タスクが見つかりません: ${parentDisplayId}`);
  if (parentRow && parentRow.parent_id !== null) {
    throw new Error(`親子関係は2階層までのため、既に子タスクである "${parentDisplayId}" の下には追加できません`);
  }

  const effectiveWorkspace = parentRow ? parentRow.workspace : workspace;
  const { prefix, seqNo } = allocateSeq(db, effectiveWorkspace);
  const displayId = `${prefix}-${String(seqNo).padStart(3, '0')}`;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks').get().m;
  const now = nowIso();

  const result = db.prepare(`INSERT INTO tasks
    (workspace, seq_no, display_id, parent_id, title, status, category, description, assignee,
     start_date, due_date, github_issue_number, github_issue_url, sort_order,
     created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    effectiveWorkspace, seqNo, displayId, parentRow ? parentRow.id : null, title, status, category, description,
    assignee, startDate, dueDate, githubIssueNumber, githubIssueUrl, maxSort + 1, now, createdBy, now, createdBy
  );

  return getByDisplayId(db, displayId) || { id: result.lastInsertRowid, display_id: displayId };
}

function updateStatus(db, displayId, newStatus) {
  const now = nowIso();
  const completedAt = newStatus === 'done' ? now : null;
  db.prepare('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?, updated_by = ? WHERE display_id = ?')
    .run(newStatus, completedAt, now, 'user', displayId);
  return getByDisplayId(db, displayId);
}

function setPin(db, workspace, displayId, value) {
  const task = getByDisplayId(db, displayId);
  if (!task) throw new Error(`タスクが見つかりません: ${displayId}`);
  if (value) {
    const exists = db.prepare('SELECT 1 FROM pins WHERE workspace = ? AND task_id = ?').get(workspace, task.id);
    if (!exists) db.prepare('INSERT INTO pins (workspace, task_id, pinned_at) VALUES (?, ?, ?)').run(workspace, task.id, nowIso());
  } else {
    db.prepare('DELETE FROM pins WHERE workspace = ? AND task_id = ?').run(workspace, task.id);
  }
}

function setRunning(db, workspace, displayId, value) {
  const task = getByDisplayId(db, displayId);
  if (!task) throw new Error(`タスクが見つかりません: ${displayId}`);
  if (value) {
    const exists = db.prepare('SELECT 1 FROM running_tasks WHERE workspace = ? AND task_id = ?').get(workspace, task.id);
    if (!exists) db.prepare('INSERT INTO running_tasks (workspace, task_id, started_at) VALUES (?, ?, ?)').run(workspace, task.id, nowIso());
  } else {
    db.prepare('DELETE FROM running_tasks WHERE workspace = ? AND task_id = ?').run(workspace, task.id);
  }
}

function isPinned(db, displayId) {
  const task = getByDisplayId(db, displayId);
  if (!task) return false;
  return !!db.prepare('SELECT 1 FROM pins WHERE task_id = ?').get(task.id);
}

function isRunning(db, displayId) {
  const task = getByDisplayId(db, displayId);
  if (!task) return false;
  return !!db.prepare('SELECT 1 FROM running_tasks WHERE task_id = ?').get(task.id);
}

/**
 * title/description/category/assignee/startDate/dueDateのうち渡されたものだけ更新する。
 */
function updateFields(db, displayId, fields) {
  const allowed = { title: 'title', description: 'description', category: 'category', assignee: 'assignee', startDate: 'start_date', dueDate: 'due_date' };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getByDisplayId(db, displayId);
  sets.push('updated_at = ?', 'updated_by = ?');
  values.push(nowIso(), 'user');
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE display_id = ?`).run(...values, displayId);
  return getByDisplayId(db, displayId);
}

/**
 * 子タスクを持つ場合は拒否する(has_children、既存md版delete-taskと同じ仕様)。
 * 呼び出し側でcatchし、e.code === 'has_children'を409判定に使う想定。
 */
function softDelete(db, displayId) {
  const task = getByDisplayId(db, displayId);
  if (!task) {
    const err = new Error(`Task not found: ${displayId}`);
    err.code = 'not_found';
    throw err;
  }
  const childCount = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE parent_id = ? AND deleted_at IS NULL').get(task.id).c;
  if (childCount > 0) {
    const err = new Error('has_children');
    err.code = 'has_children';
    throw err;
  }
  const now = nowIso();
  db.prepare('UPDATE tasks SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE display_id = ?')
    .run(now, now, 'user', displayId);
}

/**
 * childをparentの子として付け替える。2階層制限: parent自身が既に子(parent_idを持つ)場合は拒否。
 */
function attachToParent(db, childDisplayId, parentDisplayId) {
  const parent = getByDisplayId(db, parentDisplayId);
  if (!parent) throw new Error(`親タスクが見つかりません: ${parentDisplayId}`);
  if (parent.parent_id !== null) {
    throw new Error(`"${parentDisplayId}"は既に子タスクのため、その下には付け替えられません(親子関係は2階層まで)`);
  }
  const child = getByDisplayId(db, childDisplayId);
  if (!child) throw new Error(`子タスクが見つかりません: ${childDisplayId}`);
  const now = nowIso();
  db.prepare('UPDATE tasks SET parent_id = ?, updated_at = ?, updated_by = ? WHERE display_id = ?')
    .run(parent.id, now, 'user', childDisplayId);
  return getByDisplayId(db, childDisplayId);
}

function detachFromParent(db, displayId) {
  const now = nowIso();
  db.prepare('UPDATE tasks SET parent_id = NULL, updated_at = ?, updated_by = ? WHERE display_id = ?')
    .run(now, 'user', displayId);
  return getByDisplayId(db, displayId);
}

/**
 * 子を持つ親(Epic)の実効ステータスcodeを、子の最大進捗と親自身のステータスの
 * 大きい方から決める(db/board.jsのcomputeParentStatusCodeと同じ「C案」ロジック)。
 * 子を持たないタスクは自身のstatusをそのまま返す。
 * ボード上の列振り分け(db/board.js)はこの実効ステータスで行っているため、
 * reorder()のスコープ判定も同じ基準に合わせる必要がある(BT-200で発覚)。
 */
function getEffectiveStatus(db, row) {
  const children = db.prepare('SELECT status FROM tasks WHERE parent_id = ? AND deleted_at IS NULL').all(row.id);
  if (children.length === 0) return row.status;
  if (children.every(c => c.status === 'done')) return 'done';
  const rankMap = {};
  for (const s of db.prepare('SELECT code, sort_order FROM statuses').all()) rankMap[s.code] = s.sort_order;
  let maxRank = 0;
  let maxCode = 'todo';
  for (const c of children) {
    if (c.status === 'done') continue;
    const rank = rankMap[c.status] || 0;
    if (rank > maxRank) { maxRank = rank; maxCode = c.status; }
  }
  const parentRank = rankMap[row.status] || 0;
  return parentRank > maxRank ? row.status : maxCode;
}

/**
 * orderedIds(表示IDの配列、2件以上)の並び順でsort_orderを振り直す。
 * BT-187決定のスコープ: parent_id IS NULLのタスク同士は実効ステータス単位、
 * parent_idがあるタスク同士はparent_id単位でのみ並べ替えを許可する
 * (異なるスコープを混ぜて渡された場合はエラーにする)。
 * トップレベルの比較は生statusではなく実効ステータス(getEffectiveStatus)で行う。
 * Epicは子から集約したステータスでボードの列に表示される(db/board.js)ため、
 * 生statusで比較すると同じ列に見えているのに別スコープ扱いになりreorderが
 * 404で失敗していた(BT-200)。
 */
function reorder(db, orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length < 2) {
    throw new Error('orderedIds array (2+ items) is required');
  }
  const rows = orderedIds.map(id => getByDisplayId(db, id));
  const missingIdx = rows.findIndex(r => !r);
  if (missingIdx !== -1) throw new Error(`Task not found: ${orderedIds[missingIdx]}`);

  const scopeParentId = rows[0].parent_id;
  const scopeStatus = getEffectiveStatus(db, rows[0]);
  const sameScope = rows.every(r => scopeParentId === null
    ? (r.parent_id === null && getEffectiveStatus(db, r) === scopeStatus)
    : r.parent_id === scopeParentId);
  if (!sameScope) {
    throw new Error('reorder対象は同じ親を持つ子タスク同士、またはトップレベルで同じstatus同士である必要があります');
  }

  const now = nowIso();
  const stmt = db.prepare('UPDATE tasks SET sort_order = ?, updated_at = ?, updated_by = ? WHERE display_id = ?');
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id, idx) => stmt.run(idx + 1, now, 'user', id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * タスクを別ワークスペース(プロジェクト)へ移動する。counters.prefixに基づいて
 * 表示IDを再採番する(既存md版move-taskと同じ挙動)。子を持つトップレベルタスクは
 * 拒否(has_children)。子タスク自体を移動する場合は親から切り離され新たな
 * トップレベルタスクになる(既存md版と同じ挙動: 移動先には常にh3として挿入されていた)。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} displayId
 * @param {string} targetFile - config.projects[].file
 * @param {Array<{file:string, prefix:string}>} projects - config.projects
 */
function moveWorkspace(db, displayId, targetFile, projects) {
  const targetProject = (projects || []).find(p => p.file.toLowerCase() === targetFile.toLowerCase());
  if (!targetProject) throw new Error(`Target project "${targetFile}" not found`);
  if (!targetProject.prefix) throw new Error(`Target project "${targetProject.file}" has no prefix configured`);

  const task = getByDisplayId(db, displayId);
  if (!task) throw new Error(`Task ${displayId} not found`);
  if (task.workspace.toLowerCase() === targetProject.file.toLowerCase()) {
    throw new Error(`Task ${displayId} is already in project "${targetProject.file}"`);
  }
  if (task.parent_id === null) {
    const childCount = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE parent_id = ? AND deleted_at IS NULL').get(task.id).c;
    if (childCount > 0) {
      const err = new Error('has_children');
      err.code = 'has_children';
      throw err;
    }
  }

  const { prefix, seqNo } = allocateSeq(db, targetProject.file);
  const newDisplayId = `${prefix}-${String(seqNo).padStart(3, '0')}`;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks').get().m;
  const now = nowIso();

  db.prepare(`UPDATE tasks SET workspace = ?, seq_no = ?, display_id = ?, parent_id = NULL,
    sort_order = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
    .run(targetProject.file, seqNo, newDisplayId, maxSort + 1, now, 'user', task.id);

  return { oldId: displayId, newId: newDisplayId, targetFile: targetProject.file };
}

/**
 * タスクにGitHub Issue番号/URLを紐付ける(BT-192)。
 */
function setGithubLink(db, displayId, issueNumber, issueUrl) {
  const now = nowIso();
  db.prepare('UPDATE tasks SET github_issue_number = ?, github_issue_url = ?, updated_at = ?, updated_by = ? WHERE display_id = ?')
    .run(Number(issueNumber), issueUrl, now, 'user', displayId);
  return getByDisplayId(db, displayId);
}

/**
 * 直下の子タスク一覧(削除済み除く)を返す。Epic判定・sub-issue処理(BT-192)で使う。
 */
function getChildren(db, parentDisplayId) {
  const parent = getByDisplayId(db, parentDisplayId);
  if (!parent) return [];
  return db.prepare('SELECT * FROM tasks WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order').all(parent.id);
}

/**
 * 同一workspace内で指定のgithub_issue_numberを既に使っている他タスクがあるかを調べる
 * (重複紐付け防止、既存md版と同じ挙動)。excludeDisplayId自身は対象から除く。
 */
function findByGithubIssueNumber(db, workspace, issueNumber, excludeDisplayId = null) {
  return db.prepare(`SELECT * FROM tasks WHERE workspace = ? AND github_issue_number = ?
    AND deleted_at IS NULL AND display_id != ?`)
    .get(workspace, Number(issueNumber), excludeDisplayId || '');
}

/**
 * workspace内で既にGitHub連携済み(github_issue_number設定済み)の番号集合を返す
 * (fetch-issuesの重複スキップ判定に使う)。
 */
function listGithubLinkedNumbers(db, workspace) {
  const rows = db.prepare(`SELECT github_issue_number FROM tasks
    WHERE workspace = ? AND github_issue_number IS NOT NULL AND deleted_at IS NULL`).all(workspace);
  return new Set(rows.map(r => String(r.github_issue_number)));
}

module.exports = {
  getByDisplayId, listByWorkspace, listAll, allocateSeq, create, updateStatus,
  setPin, setRunning, isPinned, isRunning, updateFields, softDelete,
  attachToParent, detachFromParent, reorder, moveWorkspace, getEffectiveStatus,
  setGithubLink, getChildren, findByGithubIssueNumber, listGithubLinkedNumbers,
};
