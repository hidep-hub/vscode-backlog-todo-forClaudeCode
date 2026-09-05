'use strict';

// server.js の parseBacklogFile / mergeArchiveDetails と同等のロジックを、
// DBインポート専用に複製したもの（BT-176）。
// 意図的な複製: server.js は require した瞬間に server.listen() が走り本番ポートを
// 掴みに行く作りのため、直接requireできない。md形式自体がこの移行期限定の存在のため、
// 一時的な重複は許容している（詳細: docs/design/backlog-db-schema-design-epic-bt169.md）。

const fs = require('fs');
const path = require('path');

const KNOWN_FIELD_KEYS = ['状態', '分類', '説明', '担当', '開始日', '期日', '起源', '成果物', '完了日', 'github_issue_number', 'github_issue_url', 'commit'];
const FIELD_LINE_RE = new RegExp(`^\\s*-\\s+(?:${KNOWN_FIELD_KEYS.join('|')})[:：]`);

function detectSectionType(headingText) {
  if (headingText.includes('次やる')) return 'active';
  if (headingText.includes('アイデア')) return 'hold';
  if (headingText.includes('完了')) return 'done';
  return null;
}

/**
 * *.backlog.md をパースし、フラットなタスク配列を返す（h3は children に h4 を内包）。
 * ステータス値・成果物等は生のmd値のまま返す（statuses変換等はimport側の責務）。
 */
function parseBacklogMd(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const tasks = [];

  const lines = content.split(/\r?\n/);
  let currentSection = null;
  let currentTask = null;
  let currentChild = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const sectionMatch = line.match(/^##\s+(.*)/);
    if (sectionMatch) {
      if (currentChild && currentTask) { currentTask.children.push(currentChild); currentChild = null; }
      if (currentTask) tasks.push(currentTask);
      currentTask = null;
      currentSection = detectSectionType(sectionMatch[1]);
      continue;
    }

    // 完了テーブル行: | 完了日 | (ts) | 親 | ID | 件名 |
    if (currentSection === 'done' && line.match(/^\|.*\|$/)) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 4 && cells[0].match(/^\d{4}-\d{2}-\d{2}$/)) {
        const hasTs = cells.length >= 5 && /^\d{2}:\d{2}:\d{2}$/.test(cells[1]);
        const offset = hasTs ? 1 : 0;
        tasks.push({
          id: cells[2 + offset] || '-',
          title: cells[3 + offset],
          status: '完了',
          category: '-',
          completedDate: cells[0],
          completedTs: hasTs ? cells[1] : '',
          children: [],
        });
      }
      continue;
    }

    const taskMatch = line.match(/^###\s+\[([^\]]+)\]\s+(.+)/);
    if (taskMatch) {
      if (currentChild && currentTask) { currentTask.children.push(currentChild); currentChild = null; }
      if (currentTask) tasks.push(currentTask);
      currentTask = {
        id: taskMatch[1],
        title: taskMatch[2].trim(),
        status: currentSection === 'hold' ? '保留' : '未着手',
        category: '-',
        description: '',
        children: [],
      };
      continue;
    }

    const childMatch = line.match(/^####\s+\[([^\]]+)\]\s+(.+)/);
    if (childMatch && currentTask) {
      if (currentChild) currentTask.children.push(currentChild);
      const rawTitle = childMatch[2].trim();
      const cleanTitle = rawTitle.replace(/[（(]親[:：].+?[）)]\s*$/, '').trim();
      currentChild = {
        id: childMatch[1],
        title: cleanTitle,
        status: currentSection === 'hold' ? '保留' : '未着手',
        category: '-',
        description: '',
      };
      continue;
    }

    const fieldMatch = line.match(/^\s*-\s+(.+?)[:：]\s*(.*)/);
    if (fieldMatch) {
      const key = fieldMatch[1].trim();
      const value = fieldMatch[2].trim();
      const target = currentChild || currentTask;
      if (!target) continue;

      switch (key) {
        case '状態':
          target.status = value;
          break;
        case '分類':
          target.category = value;
          break;
        case '説明':
          target.description = value;
          while (i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            if (!nextLine.trim()) break;
            if (FIELD_LINE_RE.test(nextLine)) break;
            if (/^#{1,4}\s/.test(nextLine)) break;
            target.description += '\n' + nextLine.trim();
            i++;
          }
          break;
        case '担当':
          target.assignee = value;
          break;
        case '開始日':
          target.startDate = value;
          break;
        case '期日':
          target.dueDate = value;
          break;
        case '起源':
          target.origin = value;
          break;
        case '成果物':
          target.artifacts = value.split(',').map(s => s.trim()).filter(Boolean);
          break;
        case '完了日':
          target.completedDate = value;
          break;
        case 'github_issue_number':
          target.githubIssueNumber = value;
          break;
        case 'github_issue_url':
          target.githubIssueUrl = value;
          break;
        case 'commit':
          target.commitHash = value;
          break;
        case '今日やる':
          if (value === 'true') target.todayFlag = true;
          break;
        case '実行中':
          if (value === 'true') target.running = true;
          break;
      }
    }
  }

  if (currentChild && currentTask) currentTask.children.push(currentChild);
  if (currentTask) tasks.push(currentTask);

  return tasks;
}

/**
 * archive/<projectFile>.archive.md を読み込み、id -> 詳細情報 のMapを返す。
 * ファイルが無ければ空オブジェクトを返す。
 */
function parseArchiveMd(backlogDir, projectFile) {
  const archivePath = path.join(backlogDir, 'archive', `${projectFile}.archive.md`);
  const archiveMap = {};
  if (!fs.existsSync(archivePath)) return archiveMap;

  const content = fs.readFileSync(archivePath, 'utf8');
  const lines = content.split(/\r?\n/);
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const headerMatch = line.match(/^##\s+\[([^\]]+)\]\s+/);
    if (headerMatch) {
      if (current) archiveMap[current.id] = current;
      current = { id: headerMatch[1] };
      continue;
    }
    if (!current) continue;

    const fieldMatch = line.match(/^\s*-\s+(.+?)[:：]\s*(.*)/);
    if (fieldMatch) {
      const key = fieldMatch[1].trim();
      const value = fieldMatch[2].trim();
      switch (key) {
        case '説明':
          current.description = value;
          while (i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            if (!nextLine.trim()) break;
            if (FIELD_LINE_RE.test(nextLine)) break;
            if (/^#{1,4}\s/.test(nextLine)) break;
            current.description += '\n' + nextLine.trim();
            i++;
          }
          break;
        case '成果物':
          current.artifacts = value.split(',').map(s => s.trim()).filter(Boolean);
          break;
        case '分類':
          current.category = value;
          break;
        case '担当':
          current.assignee = value;
          break;
        case 'github_issue_number':
          current.githubIssueNumber = value;
          break;
        case 'github_issue_url':
          current.githubIssueUrl = value;
          break;
      }
    }
  }
  if (current) archiveMap[current.id] = current;

  return archiveMap;
}

module.exports = { parseBacklogMd, parseArchiveMd, detectSectionType, KNOWN_FIELD_KEYS, FIELD_LINE_RE };
