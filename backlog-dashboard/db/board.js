'use strict';

// buildBoard()のDB版(BT-186骨格→BT-188でserver.jsに接続)。
// config.columns[].matchは現時点ではstatusesの日本語labelの配列のまま
// (BT-187で1:1のstatus code配列に簡素化する予定、その前提のここでは
// codeをlabelへ変換してから既存matchと比較する)。
// 返却するJSON構造は現行server.jsのbuildBoard()と同じ形を目指す
// (新形状の確定自体はBT-187のスコープ、ここではmd版との突き合わせ検証を優先する)。

const tasksRepo = require('./tasks-repo');

function getStatusLabelMap(db) {
  const rows = db.prepare('SELECT code, label FROM statuses').all();
  const map = {};
  for (const r of rows) map[r.code] = r.label;
  return map;
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
  const statusLabelMap = getStatusLabelMap(db);
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

  function toItem(row) {
    const projectName = workspaceToProjectName[row.workspace] || row.workspace;
    const item = toTaskItem(row, { statusLabelMap, projectName });
    const children = (childrenByParentId[row.id] || []).map(childRow => {
      const childItem = toTaskItem(childRow, { statusLabelMap, projectName });
      childItem.todayFlag = pinnedTaskIds.has(childRow.id);
      childItem.running = runningTaskIds.has(childRow.id);
      return childItem;
    });
    item.children = children;
    item.todayFlag = pinnedTaskIds.has(row.id);
    item.running = runningTaskIds.has(row.id);
    if (children.length > 0) {
      item.childrenTotal = children.length;
      item.childrenDone = children.filter(c => c.status === statusLabelMap.done).length;
    }
    return item;
  }

  const topLevelItems = allRows.filter(r => r.parent_id === null).map(toItem);

  const columns = (config.columns || []).map(col => {
    let items = topLevelItems.filter(item => col.match.includes(item.status));
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

  const doneLabel = statusLabelMap.done;
  const remainingByProject = {};
  for (const item of topLevelItems) {
    if (!item.project || item.status === doneLabel) continue;
    remainingByProject[item.project] = (remainingByProject[item.project] || 0) + 1;
  }

  return {
    columns,
    projects,
    remainingByProject,
    updatedAt: new Date().toISOString(),
    defaultWorkspaceParent: config.defaultWorkspaceParent || '',
  };
}

module.exports = { buildBoardFromDb };
