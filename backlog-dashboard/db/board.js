'use strict';

// buildBoard()のDB版(BT-186骨格→BT-188でserver.jsに接続)。
// config.columns[].matchはBT-187決定によりstatuses.code単位の配列(例["todo"])。
// カラム振り分けはDB上のcode(row.status)で行い、表示用のitem.statusはlabelに変換して返す。
// 返却するJSON構造は現行server.jsのbuildBoard()と同じ形を目指す。

const tasksRepo = require('./tasks-repo');

function getStatusList(db) {
  return db.prepare('SELECT code, label, sort_order FROM statuses ORDER BY sort_order').all();
}

function toDateOnly(completedAt) {
  if (!completedAt) return null;
  return completedAt.slice(0, 10);
}

function toTimeOnly(completedAt) {
  if (!completedAt || completedAt.length < 19) return null;
  return completedAt.slice(11, 19);
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
    category: row.category || '-',
    description: row.description || '',
    assignee: row.assignee || null,
    startDate: row.start_date || null,
    dueDate: row.due_date || null,
    githubIssueNumber: row.github_issue_number || null,
    githubIssueUrl: row.github_issue_url || null,
    commit: row.commit_hash || null,
    completedDate: toDateOnly(row.completed_at),
    completedTs: toTimeOnly(row.completed_at),
    origin: row.created_by,
    artifacts: deliverables.length ? deliverables.map(d => d.path).filter(Boolean) : undefined,
  };
}

/**
 * 全ワークスペースの全タスク(削除済み除く)+成果物+pins+running_tasksを読み、
 * 現行buildBoard()と同じ形状の{columns, projects, remainingByProject, ...}を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} config - server.jsのconfigオブジェクト(columns/projects/defaultWorkspaceParent)
 */
function buildBoardFromDb(db, config) {
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

  const allRows = tasksRepo.listAll(db);
  const deliverableRows = db.prepare('SELECT * FROM deliverables ORDER BY task_id, sort_order').all();
  const deliverablesByTaskId = {};
  for (const d of deliverableRows) {
    (deliverablesByTaskId[d.task_id] = deliverablesByTaskId[d.task_id] || []).push(d);
  }
  const pinnedTaskIds = new Set(db.prepare('SELECT task_id FROM pins').all().map(r => r.task_id));
  const runningTaskIds = new Set(db.prepare('SELECT task_id FROM running_tasks').all().map(r => r.task_id));

  for (const row of allRows) row.__deliverables = deliverablesByTaskId[row.id] || [];

  const rowsById = {};
  for (const row of allRows) rowsById[row.id] = row;

  const childrenByParentId = {};
  for (const row of allRows) {
    if (row.parent_id !== null) {
      (childrenByParentId[row.parent_id] = childrenByParentId[row.parent_id] || []).push(row);
    }
  }

  // 子を持つ親の実効ステータスcodeを、子の最大進捗と親自身のステータスの大きい方から決める
  // (md版のcomputeParentStatusと同じ「C案」ロジック。完了は除外して集計し、全子完了ならdone)
  function computeParentStatusCode(childRows, parentOwnCode) {
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

  function toItem(row) {
    const projectName = workspaceToProjectName[row.workspace] || row.workspace;
    const item = toTaskItem(row, { statusLabelMap, projectName });
    const childRows = childrenByParentId[row.id] || [];
    const children = childRows.map(childRow => {
      const childItem = toTaskItem(childRow, { statusLabelMap, projectName });
      childItem.todayFlag = pinnedTaskIds.has(childRow.id);
      childItem.running = runningTaskIds.has(childRow.id);
      return childItem;
    });
    item.children = children;
    item.todayFlag = pinnedTaskIds.has(row.id);
    item.running = runningTaskIds.has(row.id);
    let statusCode = row.status;
    if (childRows.length > 0) {
      item.childrenTotal = childRows.length;
      item.childrenDone = childRows.filter(c => c.status === 'done').length;
      statusCode = computeParentStatusCode(childRows, row.status);
      item.status = statusLabelMap[statusCode] || statusCode;
      const todayCount = children.filter(c => c.todayFlag).length;
      if (todayCount > 0) item.todayCount = todayCount;
      if (children.some(c => c.running)) item.running = true;
    }
    return { item, statusCode };
  }

  const topLevelRows = allRows.filter(r => r.parent_id === null);
  const topLevelResults = topLevelRows.map(toItem);
  const topLevelItems = topLevelResults.map(r => r.item);

  const columns = (config.columns || []).map(col => {
    let items = topLevelResults.filter(r => col.match.includes(r.statusCode)).map(r => r.item);
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
  const projects = [...new Set([...projectsFromConfig, ...projectsFromTasks])].sort();

  const remainingByProject = {};
  for (const { item, statusCode } of topLevelResults) {
    if (!item.project || statusCode === 'done') continue;
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

module.exports = { buildBoardFromDb };
