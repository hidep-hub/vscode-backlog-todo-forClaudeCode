'use strict';

// BM-072/BM-074: 外部ITS(Redmine/GitLab)のメタ情報・プレビュー・取り込みAPI。
// tags-api.js/its-settings-api.jsと同じ切り出し方針。
//   GET  /api/its-meta?prefix=&source=redmine
//     -> { projectName, trackers:[{id,name}] }(Redmine専用。GitLabはトラッカーの概念が無いため呼べない=400)
//   GET  /api/its-preview?prefix=&source=redmine|gitlab&trackerId=(redmineのみ必須)&status=open|all&offset=0
//     -> { issues:[{key,title,url,state,statusName,startDate,dueDate,alreadyImported,importedTaskId,importedTaskIds,
//                    parentKey,childKeys,assignee,version,description}], total, nextOffset }
//          ※assignee/version/description はRedmineのみ(BM-099)。GitLabはassignee/versionが常にnull(descriptionはBT-422で対応)。
//          ※BM-158: 1チケット:nタスクを許可したため、紐付いているタスクは importedTaskIds(配列、作成順)で返す。
//            importedTaskId は互換のため先頭の1件(無ければnull)。
//   POST /api/its-import {prefix, source, keys:[...]}
//     -> { ok, added, skipped, errors }
//
// BM-069方針: 外部への書き戻しはしない(読み取り専用)。取り込む項目は件名・説明・開始日・期日、
// ステータスはtodo固定。Redmineは取得した一覧の中だけparent.idで階層化する(方針D)。GitLabは
// 階層化しない(方針F)。1回の読み込みは最大500件(100件x5ページ、決定事項4)。取り込みは選んだ
// チケットだけをID指定で取り直す(全件再取得はしない)。

const redmineClient = require('./redmine-client');
const gitlabClient = require('./gitlab-client');
const itsCredentials = require('./its-credentials');
const externalLinksRepo = require('./db/external-links-repo');

const SOURCES = ['redmine', 'gitlab'];
const BATCH_SIZE = 500;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 選択集合(issuesの配列、各{id, parent?})の中だけで親子を判定する(BM-069方針D)。
 * 2階層までの制約(tasksRepo.create()が3階層目を拒否する)に合わせて、
 * 「親も選択集合内で誰かの子になっている」場合は孫にあたる方をトップレベルとして扱う
 * (3階層チェーンを平坦化する)。
 * @returns {Map<string, string[]>} parentKey(文字列) -> 子issueのkey配列
 */
function groupParentChild(issues) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const parentIdOf = (issue) => (issue.parent ? issue.parent.id : null);
  const isTopLevel = (issue) => {
    const pid = parentIdOf(issue);
    if (!pid || !byId.has(pid)) return true;
    const parent = byId.get(pid);
    const ppid = parentIdOf(parent);
    if (ppid && byId.has(ppid)) return true; // 親自身も子 -> 3階層目になるため平坦化してトップレベル扱い
    return false;
  };
  const childrenByParentKey = new Map();
  for (const issue of issues) {
    if (isTopLevel(issue)) continue;
    const pid = String(parentIdOf(issue));
    if (!childrenByParentKey.has(pid)) childrenByParentKey.set(pid, []);
    childrenByParentKey.get(pid).push(String(issue.id));
  }
  return { byId, isTopLevel, childrenByParentKey };
}

function toRedminePreviewItem(issue, { host, closedStatusIds, importedMap, childKeys }) {
  return {
    key: String(issue.id),
    title: issue.subject,
    url: `${host}/issues/${issue.id}`,
    state: closedStatusIds.has(issue.status.id) ? 'closed' : 'open',
    statusName: issue.status.name,
    startDate: issue.start_date || null,
    dueDate: issue.due_date || null,
    // BM-099: 一覧(/issues.json)は追加のincludeパラメータなしでもassigned_to/fixed_version/
    // descriptionを標準で返すため、追加のAPI呼び出しは不要(値が無いissueはフィールド自体が無い)。
    assignee: issue.assigned_to ? issue.assigned_to.name : null,
    version: issue.fixed_version ? issue.fixed_version.name : null,
    description: issue.description || '',
    alreadyImported: importedMap.has(String(issue.id)),
    importedTaskId: (importedMap.get(String(issue.id)) || [])[0] || null,
    importedTaskIds: importedMap.get(String(issue.id)) || [],
    parentKey: issue.parent ? String(issue.parent.id) : null,
    childKeys: childKeys || [],
  };
}

// BM-074: GitLabはトラッカー(status名)の概念が無く、issue.stateがopened/closedを直接返す。
// 階層化もしない(方針F)ため、parentKey/childKeysは常に空にする。
function toGitlabPreviewItem(issue, { importedMap }) {
  const closed = issue.state === 'closed';
  return {
    key: String(issue.iid),
    title: issue.title,
    url: issue.web_url,
    state: closed ? 'closed' : 'open',
    statusName: closed ? 'closed' : 'opened',
    startDate: null, // GitLab issueに開始日フィールドは無い
    dueDate: issue.due_date || null,
    // BM-099: 担当者/バージョン表示はRedmineタブのみのため、形だけ揃えてnullにしておく。
    // BT-422: 説明欄は件名ホバーのツールチップ用に、一覧APIが標準で返すdescriptionを使う
    assignee: null,
    version: null,
    description: issue.description || '',
    alreadyImported: importedMap.has(String(issue.iid)),
    importedTaskId: (importedMap.get(String(issue.iid)) || [])[0] || null,
    importedTaskIds: importedMap.get(String(issue.iid)) || [],
    parentKey: null,
    childKeys: [],
  };
}

/**
 * @param {{config: object, credentialsPath: string, getDb: () => object, tasksRepo: object,
 *   readRequestBody: (req) => Promise<object>, onChange: () => void}} deps
 * @returns {(req, res) => boolean} 処理した場合true(未処理ならfalseを返し呼び出し側が続行する)
 */
function createItsImportApi({ config, credentialsPath, getDb, tasksRepo, readRequestBody, onChange }) {
  function findProjectByPrefix(prefix) {
    return (config.projects || []).find((p) => p.prefix === prefix);
  }

  function resolveConnection(prefix, source) {
    const project = findProjectByPrefix(prefix);
    if (!project) return { error: { status: 404, body: { error: `Unknown prefix: "${prefix}"` } } };
    const conn = itsCredentials.resolveConnection(credentialsPath, project.file, source);
    if (!conn) return { error: { status: 400, body: { error: `${source}連携が未設定です (prefix: ${prefix})` } } };
    return { project, conn };
  }

  async function handleMeta(req, res, url) {
    const prefix = url.searchParams.get('prefix');
    const source = url.searchParams.get('source');
    if (!prefix) return sendJson(res, 400, { error: 'prefix is required' });
    // BM-074: its-metaはRedmine専用(トラッカー一覧取得)。GitLabにトラッカーの概念は無いため非対応。
    if (source !== 'redmine') return sendJson(res, 400, { error: 'source must be "redmine" (its-meta is Redmine-only; GitLab has no tracker concept)' });
    const resolved = resolveConnection(prefix, 'redmine');
    if (resolved.error) return sendJson(res, resolved.error.status, resolved.error.body);
    try {
      const info = await redmineClient.fetchProjectInfo(resolved.conn.host, resolved.conn.token, resolved.conn.projectRef);
      sendJson(res, 200, info);
    } catch (e) {
      sendJson(res, 502, { error: `Redmine API error: ${e.message}` });
    }
  }

  async function handlePreview(req, res, url) {
    const prefix = url.searchParams.get('prefix');
    const source = url.searchParams.get('source');
    const trackerId = url.searchParams.get('trackerId');
    const statusFilter = url.searchParams.get('status') === 'all' ? 'all' : 'open';
    const offset = Number(url.searchParams.get('offset') || '0') || 0;
    if (!prefix) return sendJson(res, 400, { error: 'prefix is required' });
    if (!SOURCES.includes(source)) return sendJson(res, 400, { error: `source must be one of: ${SOURCES.join(', ')}` });
    if (source === 'redmine' && !trackerId) return sendJson(res, 400, { error: 'trackerId is required' });
    const resolved = resolveConnection(prefix, source);
    if (resolved.error) return sendJson(res, resolved.error.status, resolved.error.body);
    const { conn } = resolved;

    if (source === 'redmine') {
      try {
        const [batch, closedStatusIds] = await Promise.all([
          redmineClient.fetchIssuesBatch(conn.host, conn.token, conn.projectRef, { trackerId, statusFilter, offset, maxCount: BATCH_SIZE }),
          redmineClient.fetchClosedStatusIds(conn.host, conn.token),
        ]);
        const keys = batch.issues.map((i) => i.id);
        const importedMap = externalLinksRepo.findLinkedTasksByKeys(getDb(), {
          source: 'redmine', host: conn.host, projectRef: conn.projectRef, issueKeys: keys,
        });
        const { childrenByParentKey } = groupParentChild(batch.issues);
        const issues = batch.issues.map((issue) => toRedminePreviewItem(issue, {
          host: conn.host, closedStatusIds, importedMap, childKeys: childrenByParentKey.get(String(issue.id)),
        }));
        const nextOffset = offset + batch.issues.length < batch.totalCount ? offset + batch.issues.length : null;
        sendJson(res, 200, { issues, total: batch.totalCount, nextOffset });
      } catch (e) {
        sendJson(res, 502, { error: `Redmine API error: ${e.message}` });
      }
      return;
    }

    // source === 'gitlab'(BM-074: 階層化なし・トラッカー絞り込みなしのフラット一覧)
    try {
      const batch = await gitlabClient.fetchIssuesBatch(conn.host, conn.token, conn.projectRef, { statusFilter, offset, maxCount: BATCH_SIZE });
      const keys = batch.issues.map((i) => i.iid);
      const importedMap = externalLinksRepo.findLinkedTasksByKeys(getDb(), {
        source: 'gitlab', host: conn.host, projectRef: conn.projectRef, issueKeys: keys,
      });
      const issues = batch.issues.map((issue) => toGitlabPreviewItem(issue, { importedMap }));
      // GitLabはx-totalが取れない場合totalCountがnullになる(fetchIssuesBatch参照)。
      // その場合は「全件数不明」として扱い、続きの有無はhasMoreで判定する(件数比較ではなく)。
      const total = batch.totalCount;
      const nextOffset = batch.hasMore ? offset + batch.issues.length : null;
      sendJson(res, 200, { issues, total, nextOffset });
    } catch (e) {
      sendJson(res, 502, { error: `GitLab API error: ${e.message}` });
    }
  }

  async function handleImport(req, res, body) {
    const { prefix, source, keys } = body;
    if (!prefix) return sendJson(res, 400, { error: 'prefix is required' });
    if (!SOURCES.includes(source)) return sendJson(res, 400, { error: `source must be one of: ${SOURCES.join(', ')}` });
    if (!Array.isArray(keys) || keys.length === 0) return sendJson(res, 400, { error: 'keys must be a non-empty array' });
    const resolved = resolveConnection(prefix, source);
    if (resolved.error) return sendJson(res, resolved.error.status, resolved.error.body);
    const { project, conn } = resolved;

    if (source === 'redmine') {
      let fetchedIssues;
      try {
        fetchedIssues = await redmineClient.fetchIssuesByIds(conn.host, conn.token, keys);
      } catch (e) {
        return sendJson(res, 502, { error: `Redmine API error: ${e.message}` });
      }

      const db = getDb();
      const existingMap = externalLinksRepo.findLinkedTasksByKeys(db, {
        source: 'redmine', host: conn.host, projectRef: conn.projectRef, issueKeys: fetchedIssues.map((i) => i.id),
      });
      const { isTopLevel, childrenByParentKey, byId } = groupParentChild(fetchedIssues);

      let added = 0;
      let skipped = 0;
      const errors = [];

      function importRedmineOne(issue, parentDisplayId) {
        const key = String(issue.id);
        if (existingMap.has(key)) { skipped++; return null; }
        try {
          const created = tasksRepo.create(db, {
            workspace: project.file,
            title: issue.subject,
            status: 'todo',
            description: issue.description || '',
            startDate: issue.start_date || null,
            dueDate: issue.due_date || null,
            parentDisplayId: parentDisplayId || null,
            createdBy: 'kiro',
            externalLink: {
              source: 'redmine', host: conn.host, projectRef: conn.projectRef,
              issueKey: issue.id, issueUrl: `${conn.host}/issues/${issue.id}`,
            },
          });
          added++;
          return created.display_id;
        } catch (e) {
          errors.push({ key, message: e.message });
          return null;
        }
      }

      for (const issue of fetchedIssues) {
        if (!isTopLevel(issue)) continue; // 子は親の取り込み時に一括処理する
        const parentDisplayId = importRedmineOne(issue, null);
        if (!parentDisplayId) continue; // 作成失敗/既取込ならその子も処理しない(親に紐付けられないため)
        const childKeys = childrenByParentKey.get(String(issue.id)) || [];
        for (const childKey of childKeys) {
          const childIssue = byId.get(Number(childKey));
          if (!childIssue) continue;
          importRedmineOne(childIssue, parentDisplayId);
        }
      }

      sendJson(res, 200, { ok: true, added, skipped, errors });
      if (added > 0) onChange();
      return;
    }

    // source === 'gitlab'(BM-074: 階層化なし。選択されたissueをそれぞれトップレベルで取り込む)
    let fetchedIssues;
    try {
      fetchedIssues = await gitlabClient.fetchIssuesByIids(conn.host, conn.token, conn.projectRef, keys);
    } catch (e) {
      return sendJson(res, 502, { error: `GitLab API error: ${e.message}` });
    }

    const db = getDb();
    const existingMap = externalLinksRepo.findLinkedTasksByKeys(db, {
      source: 'gitlab', host: conn.host, projectRef: conn.projectRef, issueKeys: fetchedIssues.map((i) => i.iid),
    });

    let added = 0;
    let skipped = 0;
    const errors = [];

    for (const issue of fetchedIssues) {
      const key = String(issue.iid);
      if (existingMap.has(key)) { skipped++; continue; }
      try {
        tasksRepo.create(db, {
          workspace: project.file,
          title: issue.title,
          status: 'todo',
          description: issue.description || '',
          startDate: null,
          dueDate: issue.due_date || null,
          parentDisplayId: null,
          createdBy: 'kiro',
          externalLink: {
            source: 'gitlab', host: conn.host, projectRef: conn.projectRef,
            issueKey: issue.iid, issueUrl: issue.web_url,
          },
        });
        added++;
      } catch (e) {
        errors.push({ key, message: e.message });
      }
    }

    sendJson(res, 200, { ok: true, added, skipped, errors });
    if (added > 0) onChange();
  }

  return function handle(req, res) {
    if (req.method === 'GET' && req.url && req.url.startsWith('/api/its-meta')) {
      handleMeta(req, res, new URL(req.url, 'http://localhost'));
      return true;
    }
    if (req.method === 'GET' && req.url && req.url.startsWith('/api/its-preview')) {
      handlePreview(req, res, new URL(req.url, 'http://localhost'));
      return true;
    }
    if (req.method === 'POST' && req.url === '/api/its-import') {
      readRequestBody(req).then((body) => handleImport(req, res, body || {})).catch(() => {
        sendJson(res, 400, { error: 'Invalid JSON body' });
      });
      return true;
    }
    return false;
  };
}

module.exports = { createItsImportApi };
