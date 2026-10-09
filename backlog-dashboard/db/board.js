'use strict';

// buildBoard()のDB版(BT-186骨格→BT-188でserver.jsに接続)。
// config.columns[].matchはBT-187決定によりstatuses.code単位の配列(例["todo"])。
// カラム振り分けはDB上のcode(row.status)で行い、表示用のitem.statusはlabelに変換して返す。
// 返却するJSON構造は現行server.jsのbuildBoard()と同じ形を目指す。

const tasksRepo = require('./tasks-repo');

function getStatusList(db) {
  return db.prepare('SELECT code, label, sort_order FROM statuses ORDER BY sort_order').all();
}

// completed_atはUTCのISO文字列で保存される。画面に出す完了日・完了時刻はJST(+9h)に変換する(BT-343)。
// 日付のみ等でDateとして解釈できない値は従来どおり文字列の切り出しにフォールバックする。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstIso(completedAt) {
  if (!completedAt || completedAt.length < 19) return null;
  const ms = Date.parse(completedAt);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + JST_OFFSET_MS).toISOString();
}

function toDateOnly(completedAt) {
  if (!completedAt) return null;
  const jst = toJstIso(completedAt);
  return (jst || completedAt).slice(0, 10);
}

function toTimeOnly(completedAt) {
  const jst = toJstIso(completedAt);
  return jst ? jst.slice(11, 19) : null;
}

/**
 * DB行1件をフロント向けタスクオブジェクトに変換する(children/todayFlag/running等は呼び出し側で付与)。
 */
function toTaskItem(row, { statusLabelMap, projectName }) {
  const deliverables = row.__deliverables || [];
  return {
    id: row.display_id,
    title: row.title,
    project: projectName,
    status: statusLabelMap[row.status] || row.status,
    statusCode: row.status,
    category: row.category || '-',
    // BM-065/BM-083: board用の列を絞ったSELECT(listAllForBoard等)はdescription列自体を
    // 取得しないため、row.descriptionはundefinedになる。buildTaskDetail用(SELECT *、
    // 常にdescription列を持つ)との違いをクライアント側が判別できるよう、boardの軽量itemには
    // descriptionキー自体を含めない(undefinedのままJSON.stringifyで省略される)。
    // 「descriptionが本当に空文字」(buildTaskDetail経由)と「board用で元から取得していない」
    // (キー自体が無い)を区別することで、クライアント側は`'description' in item`で
    // 非同期取得が必要かどうかを判定できる。
    description: row.description === undefined ? undefined : (row.description || ''),
    assignee: row.assignee || null,
    startDate: row.start_date || null,
    dueDate: row.due_date || null,
    githubIssueNumber: row.github_issue_number || null,
    githubIssueUrl: row.github_issue_url || null,
    commit: row.commit_hash || null,
    completedDate: toDateOnly(row.completed_at),
    completedTs: toTimeOnly(row.completed_at),
    origin: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    artifacts: deliverables.length ? deliverables.map(d => d.path).filter(Boolean) : undefined,
    dueDateHistory: row.__dueDateHistory || [],
  };
}

// 子を持つ親の実効ステータスcodeを、子の最大進捗と親自身のステータスの大きい方から決める
// (md版のcomputeParentStatusと同じ「C案」ロジック。完了は除外して集計し、全子完了ならdone)
function computeParentStatusCode(childRows, parentOwnCode, statusRankMap) {
  if (childRows.length === 0) return parentOwnCode;
  if (childRows.every(c => c.status === 'done')) return 'done';
  let maxRank = 0;
  let maxCode = 'todo';
  for (const c of childRows) {
    if (c.status === 'done') continue;
    const rank = statusRankMap[c.status] || 0;
    if (rank > maxRank) { maxRank = rank; maxCode = c.status; }
  }
  const parentRank = statusRankMap[parentOwnCode] || 0;
  return parentRank > maxRank ? parentOwnCode : maxCode;
}

/**
 * 全タスク(削除済み除く)+成果物+pins+running_tasksを読み、
 * 現行buildBoard()と同じ形状の{columns, projects, remainingByProject, ...}を返す。
 * description列はboard用のレスポンスには含めない(BM-065: ブラウザが全量データを持つ
 * ことによるペイロード肥大化対策。詳細はGET /api/task/:id→buildTaskDetailで個別取得する)。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} config - server.jsのconfigオブジェクト(columns/projects/defaultWorkspaceParent)
 * @param {string|null} workspace - 指定時はこのワークスペース(config.projects[].file)のみに絞る(BM-065)。
 *   省略/nullは全ワークスペース(All Projects、従来挙動)。
 */
function buildBoardFromDb(db, config, workspace = null) {
  const statusList = getStatusList(db);
  const statusLabelMap = {};
  const statusRankMap = {};
  for (const s of statusList) {
    statusLabelMap[s.code] = s.label;
    statusRankMap[s.code] = s.sort_order;
  }
  const workspaceToProjectName = {};
  for (const p of config.projects || []) {
    if (p.file) workspaceToProjectName[p.file] = p.name;
  }

  // BM-065: workspace指定時はSQL側(WHERE句)で絞り込む(JS側フィルタではなくDBに委譲)。
  // 併せてboard用途ではdescription列を転送しない列リストを使う。
  const allRows = workspace
    ? tasksRepo.listByWorkspaceForBoard(db, workspace)
    : tasksRepo.listAllForBoard(db);

  // deliverables/pins/running_tasks/task_execution_sessionsは、workspace指定時のみ
  // 対象タスクIDに絞る(IN句)。All Projects時は従来通り全件取得(952件分のIN句展開を避ける)。
  const taskIds = allRows.map(r => r.id);
  const idPlaceholders = workspace && taskIds.length ? taskIds.map(() => '?').join(',') : null;
  const scopeClause = idPlaceholders ? `WHERE task_id IN (${idPlaceholders})` : '';
  const scopeArgs = idPlaceholders ? taskIds : [];
  // workspace指定で対象タスクが0件の場合、空のIN句を発行しないよう早期に空配列へフォールバックする。
  const noRowsInScope = workspace && taskIds.length === 0;

  const deliverableRows = noRowsInScope ? [] :
    db.prepare(`SELECT * FROM deliverables ${scopeClause} ORDER BY task_id, sort_order`).all(...scopeArgs);
  const deliverablesByTaskId = {};
  for (const d of deliverableRows) {
    (deliverablesByTaskId[d.task_id] = deliverablesByTaskId[d.task_id] || []).push(d);
  }
  const pinnedTaskIds = new Set(noRowsInScope ? [] :
    db.prepare(`SELECT task_id FROM pins ${scopeClause}`).all(...scopeArgs).map(r => r.task_id));
  const runningTaskIds = new Set(noRowsInScope ? [] :
    db.prepare(`SELECT task_id FROM running_tasks ${scopeClause}`).all(...scopeArgs).map(r => r.task_id));
  const activeAgentByTaskId = new Map(
    (noRowsInScope ? [] :
      db.prepare(`SELECT task_id, agent_id FROM task_execution_sessions
        ${idPlaceholders ? `WHERE task_id IN (${idPlaceholders}) AND stopped_at IS NULL` : 'WHERE stopped_at IS NULL'}
        ORDER BY started_at DESC, id DESC`).all(...scopeArgs)
    )
      .reverse()
      .map(row => [row.task_id, row.agent_id])
  );

  const dueHistoryByTaskId = tasksRepo.listDueDateHistory(db, taskIds);
  for (const row of allRows) {
    row.__deliverables = deliverablesByTaskId[row.id] || [];
    row.__dueDateHistory = dueHistoryByTaskId[row.id] || [];
  }

  const rowsById = {};
  for (const row of allRows) rowsById[row.id] = row;

  const childrenByParentId = {};
  for (const row of allRows) {
    if (row.parent_id !== null) {
      (childrenByParentId[row.parent_id] = childrenByParentId[row.parent_id] || []).push(row);
    }
  }

  // 個別に完了した子タスク(BT-201: 完了カラムに個別カードとして混在表示する分)。
  // BT-240で親の実効ステータス条件を撤廃し、親がdone扱いになった後も子の個別完了表示を継続するようにした。
  const looseCompletedChildren = [];

  function toItem(row) {
    const projectName = workspaceToProjectName[row.workspace] || row.workspace;
    const item = toTaskItem(row, { statusLabelMap, projectName });
    const childRows = childrenByParentId[row.id] || [];
    const children = childRows.map(childRow => {
      const childItem = toTaskItem(childRow, { statusLabelMap, projectName });
      childItem.todayFlag = pinnedTaskIds.has(childRow.id);
      childItem.running = runningTaskIds.has(childRow.id);
      childItem.agentId = activeAgentByTaskId.get(childRow.id) || null;
      return childItem;
    });
    item.children = children;
    item.todayFlag = pinnedTaskIds.has(row.id);
    item.running = runningTaskIds.has(row.id);
    item.agentId = activeAgentByTaskId.get(row.id) || null;
    if (childRows.length > 0) {
      item.childrenTotal = childRows.length;
      item.childrenDone = childRows.filter(c => c.status === 'done').length;
      const statusCode = computeParentStatusCode(childRows, row.status, statusRankMap);
      item.status = statusLabelMap[statusCode] || statusCode;
      item.statusCode = statusCode;
      const todayCount = children.filter(c => c.todayFlag).length;
      if (todayCount > 0) item.todayCount = todayCount;
      if (children.some(c => c.running)) item.running = true;
      for (const child of children) {
        if (child.statusCode === 'done') {
          looseCompletedChildren.push({ ...child, parentId: item.id, parentTitle: item.title });
        }
      }
    }
    return item;
  }

  const topLevelRows = allRows.filter(r => r.parent_id === null);
  const topLevelItems = topLevelRows.map(toItem);

  const columns = (config.columns || []).map(col => {
    let items = topLevelItems.filter(item => col.match.includes(item.statusCode));
    if (col.id === 'done') {
      items = items.concat(looseCompletedChildren.filter(c => col.match.includes(c.statusCode)));
    }
    const totalCount = items.length;
    if (col.compact || col.id === 'done') {
      items = items.slice().sort((a, b) => {
        const da = a.completedDate || '0000-00-00';
        const dbb = b.completedDate || '0000-00-00';
        const dateCmp = dbb.localeCompare(da);
        if (dateCmp !== 0) return dateCmp;
        if (a.completedTs && b.completedTs) {
          const tsCmp = b.completedTs.localeCompare(a.completedTs);
          if (tsCmp !== 0) return tsCmp;
        }
        return (b.id || '').localeCompare(a.id || '');
      });
    }
    return {
      id: col.id,
      label: col.label,
      match: col.match,
      items,
      totalCount,
      limit: col.limit || null,
      visibleFields: col.visibleFields || null,
      compact: col.compact || false,
    };
  });

  const projectsFromConfig = (config.projects || []).map(p => p.name).filter(Boolean);
  const projectsFromTasks = topLevelItems.map(t => t.project).filter(Boolean);
  // BM-035: デフォルトの.sort()は大文字小文字を区別するUnicode順になり、
  // 大文字始まりの名前が小文字始まりより前に固まってしまう（ワークスペースセレクタの
  // typeahead実装の前提が崩れる）ため、大文字小文字を無視した比較にする。
  const projects = [...new Set([...projectsFromConfig, ...projectsFromTasks])]
    .sort((a, b) => a.localeCompare(b, 'ja', { sensitivity: 'base' }));

  const remainingByProject = {};
  for (const item of topLevelItems) {
    if (!item.project || item.statusCode === 'done') continue;
    remainingByProject[item.project] = (remainingByProject[item.project] || 0) + 1;
  }

  const statuses = statusList.map(s => ({ code: s.code, label: s.label, sortOrder: s.sort_order }));

  return {
    columns,
    projects,
    remainingByProject,
    statuses,
    updatedAt: new Date().toISOString(),
    defaultWorkspaceParent: config.defaultWorkspaceParent || '',
  };
}

/**
 * displayId(例 "BT-181")1件を、buildBoardFromDb()と同じ形状のタスクアイテムとして返す。
 * 子タスクを持つ親であればchildren/childrenTotal/childrenDone/実効statusを含める。
 * 見つからない場合はnullを返す(GET /api/task/:id用、BT-222)。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} config - server.jsのconfigオブジェクト(projects)
 * @param {string} displayId
 */
function buildTaskDetail(db, config, displayId) {
  const row = tasksRepo.getByDisplayId(db, displayId);
  if (!row) return null;

  const statusList = getStatusList(db);
  const statusLabelMap = {};
  const statusRankMap = {};
  for (const s of statusList) {
    statusLabelMap[s.code] = s.label;
    statusRankMap[s.code] = s.sort_order;
  }
  const workspaceToProjectName = {};
  for (const p of config.projects || []) {
    if (p.file) workspaceToProjectName[p.file] = p.name;
  }

  const childRows = db.prepare('SELECT * FROM tasks WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order').all(row.id);
  const relevantIds = [row.id, ...childRows.map(c => c.id)];
  const placeholders = relevantIds.map(() => '?').join(',');
  const deliverableRows = db.prepare(`SELECT * FROM deliverables WHERE task_id IN (${placeholders}) ORDER BY task_id, sort_order`).all(...relevantIds);
  const deliverablesByTaskId = {};
  for (const d of deliverableRows) {
    (deliverablesByTaskId[d.task_id] = deliverablesByTaskId[d.task_id] || []).push(d);
  }
  row.__deliverables = deliverablesByTaskId[row.id] || [];
  for (const c of childRows) c.__deliverables = deliverablesByTaskId[c.id] || [];
  const dueHistoryByTaskId = tasksRepo.listDueDateHistory(db, relevantIds);
  row.__dueDateHistory = dueHistoryByTaskId[row.id] || [];
  for (const c of childRows) c.__dueDateHistory = dueHistoryByTaskId[c.id] || [];

  const pinnedTaskIds = new Set(db.prepare(`SELECT task_id FROM pins WHERE task_id IN (${placeholders})`).all(...relevantIds).map(r => r.task_id));
  const runningTaskIds = new Set(db.prepare(`SELECT task_id FROM running_tasks WHERE task_id IN (${placeholders})`).all(...relevantIds).map(r => r.task_id));
  const activeAgentByTaskId = new Map(
    db.prepare(`SELECT task_id, agent_id FROM task_execution_sessions
      WHERE task_id IN (${placeholders}) AND stopped_at IS NULL
      ORDER BY started_at DESC, id DESC`).all(...relevantIds)
      .reverse()
      .map(row => [row.task_id, row.agent_id])
  );

  const projectName = workspaceToProjectName[row.workspace] || row.workspace;
  const item = toTaskItem(row, { statusLabelMap, projectName });
  item.todayFlag = pinnedTaskIds.has(row.id);
  item.running = runningTaskIds.has(row.id);
  item.agentId = activeAgentByTaskId.get(row.id) || null;

  const children = childRows.map(childRow => {
    const childItem = toTaskItem(childRow, { statusLabelMap, projectName });
    childItem.todayFlag = pinnedTaskIds.has(childRow.id);
    childItem.running = runningTaskIds.has(childRow.id);
    childItem.agentId = activeAgentByTaskId.get(childRow.id) || null;
    return childItem;
  });
  item.children = children;
  if (childRows.length > 0) {
    item.childrenTotal = childRows.length;
    item.childrenDone = childRows.filter(c => c.status === 'done').length;
    const statusCode = computeParentStatusCode(childRows, row.status, statusRankMap);
    item.status = statusLabelMap[statusCode] || statusCode;
    item.statusCode = statusCode;
    const todayCount = children.filter(c => c.todayFlag).length;
    if (todayCount > 0) item.todayCount = todayCount;
    if (children.some(c => c.running)) item.running = true;
  }

  return item;
}

/**
 * BM-081: サーバー側検索API用。タイトル/ID/担当者(常にLIKE)+本文(includeBody時のみFTS5)を
 * ワークスペース横断(常に全件対象、boardの絞り込み状態と無関係)で検索し、
 * クライアントのグルーピング表示(buildSearchTree相当: Epic→子タスク)に必要な
 * parentId/parentTitle/isEpicを付与したフラットなリストを返す。
 * descriptionはフルで返さずsnippet(ヒット箇所抜粋)のみ含める(ペイロード肥大化を避ける、BM-065の方針を継承)。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} config - server.jsのconfigオブジェクト(projects)
 * @param {string} query
 * @param {object} opts
 * @param {boolean} opts.includeBody - trueの時のみ本文(description)もFTS5で検索対象にする
 * @param {number} opts.limit - タイトル検索・本文検索それぞれの上限件数(デフォルト50)
 */
function buildSearchResults(db, config, query, { includeBody = false, limit = 50 } = {}) {
  const trimmed = (query || '').trim();
  if (!trimmed) return { results: [], bodySearchSkipped: false };

  const statusList = getStatusList(db);
  const statusLabelMap = {};
  for (const s of statusList) statusLabelMap[s.code] = s.label;
  const workspaceToProjectName = {};
  for (const p of config.projects || []) {
    if (p.file) workspaceToProjectName[p.file] = p.name;
  }

  const titleRows = tasksRepo.searchByTitleIdAssignee(db, trimmed, { limit });
  // trigramの制約(3文字未満は常に0件)により、本文検索は3文字以上の時だけ実行する。
  // 2文字以下でincludeBody=trueが指定された場合、呼び出し側(server.js)に
  // 「本文検索はスキップされた」ことを伝え、UIで案内できるようにする。
  const bodySearchSkipped = includeBody && trimmed.length < 3;
  const bodyMatches = includeBody && !bodySearchSkipped ? tasksRepo.searchByBody(db, trimmed, { limit }) : [];

  // タイトル/ID/担当者ヒットと本文ヒットをタスクID基準でマージする(両方にヒットした場合はsnippetを残す)。
  const merged = new Map(); // taskId -> { row, snippet }
  for (const row of titleRows) merged.set(row.id, { row, snippet: null });
  for (const { task, snippet } of bodyMatches) {
    const existing = merged.get(task.id);
    if (existing) existing.snippet = snippet;
    else merged.set(task.id, { row: task, snippet });
  }

  const results = [];
  for (const { row, snippet } of merged.values()) {
    const projectName = workspaceToProjectName[row.workspace] || row.workspace;
    let parentId = null;
    let parentTitle = null;
    let parentStatusCode = null;
    if (row.parent_id !== null) {
      const parentRow = tasksRepo.getById(db, row.parent_id);
      if (parentRow) {
        parentId = parentRow.display_id;
        parentTitle = parentRow.title;
        parentStatusCode = parentRow.status;
      }
    }
    const childCount = row.parent_id === null ? tasksRepo.countChildren(db, row.id) : 0;
    results.push({
      id: row.display_id,
      title: row.title,
      status: statusLabelMap[row.status] || row.status,
      statusCode: row.status,
      project: projectName,
      assignee: row.assignee || null,
      parentId,
      parentTitle,
      // BM-082: 検索結果はEpic配下の子マッチも親行として表示するグルーピング(buildSearchTree相当)を
      // クライアント側で再現する必要があるため、親の表示用ラベルも付与しておく。
      parentStatus: parentStatusCode ? (statusLabelMap[parentStatusCode] || parentStatusCode) : null,
      isEpic: childCount > 0,
      snippet: snippet || null,
    });
  }

  return { results, bodySearchSkipped };
}

/**
 * BM-065: ワークスペースセレクタ/バッジ用の軽量集計。project毎のdo/ready/todo/done件数を返す
 * ({ [projectName]: { do, ready, todo, done } })。description等は読まず、status/parent_id/workspaceのみの
 * 軽いSELECTで計算する。クライアント側のrenderWsFilterCounts/project-badges集計(親EPICは実効
 * ステータスで1件、parentIdを持つ個別完了子表示は対象外)と同じ考え方をSQL結果に対して適用する。
 * ユーザー合意の設計: リアルタイム更新はせず、セレクタを開く操作をトリガーに都度取得する想定。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} config - server.jsのconfigオブジェクト(projects)
 */
function buildWorkspaceCounts(db, config) {
  const statusRankMap = {};
  for (const s of getStatusList(db)) statusRankMap[s.code] = s.sort_order;
  const workspaceToProjectName = {};
  for (const p of config.projects || []) {
    if (p.file) workspaceToProjectName[p.file] = p.name;
  }

  const rows = db.prepare('SELECT id, parent_id, workspace, status FROM tasks WHERE deleted_at IS NULL').all();
  const childrenByParentId = {};
  for (const row of rows) {
    if (row.parent_id !== null) {
      (childrenByParentId[row.parent_id] = childrenByParentId[row.parent_id] || []).push(row);
    }
  }

  const counts = {};
  for (const row of rows) {
    if (row.parent_id !== null) continue; // トップレベルのみ(子は親の実効ステータスに集約済み)
    const projectName = workspaceToProjectName[row.workspace] || row.workspace;
    if (!projectName) continue;
    const childRows = childrenByParentId[row.id] || [];
    const statusCode = computeParentStatusCode(childRows, row.status, statusRankMap);
    if (!['do', 'ready', 'todo', 'done'].includes(statusCode)) continue;
    if (!counts[projectName]) counts[projectName] = { do: 0, ready: 0, todo: 0, done: 0 };
    counts[projectName][statusCode]++;
  }
  return counts;
}

module.exports = { buildBoardFromDb, buildTaskDetail, buildSearchResults, buildWorkspaceCounts };
