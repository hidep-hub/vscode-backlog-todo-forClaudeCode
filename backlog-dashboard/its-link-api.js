'use strict';

// BM-126: 既存タスクへ外部ITS(Redmine / BM-164でGitLabを追加)のチケットを後から紐づけるAPI。
// GitHubの/api/github-link-issue(server.js)と同じ骨格だが、保存先はtasks.github_issue_*列ではなく
// BM-071のtask_external_linksテーブル(externalLinksRepo)。
//   POST /api/its-link-issue {taskId, source, issueKey, allowShared?, actor?}
//     -> { ok, source, issueKey, issueUrl, sharedWith }
// BT-470: 紐づけ/解除は履歴(external_link_added/removed)に記録する。解除は POST /api/its-unlink-issue。
//
// スコープ(ユーザー合意事項、BM-126):
//   - 既存タスクへの「紐づけ」のみ。チケットの新規作成はしない(github-create-issue相当は作らない)。
//   - 上書き許可(間違えた場合の修正を想定)。同一タスク+sourceへの再紐づけはsetLink()で上書きする。
//   - チケット番号は外部ITSのAPIで実在確認してから保存する(its-credentials未設定なら400)。
//
// BM-164: GitLabの個別紐づけに対応した(source: 'gitlab')。キーはissueのiid(プロジェクト内連番)で、
// 実在確認は取り込み(BM-074)と同じgitlab-client.fetchIssuesByIidsを使い、URLはGitLabが返すweb_urlを保存する。
// 外部への書き戻しはしない(読み取りのみ)。作成はGitHubだけ(BM-160の合意事項)。
//
// BM-158: 1チケット:nタスクを許可する。ただし打ち間違いが黙って通らないよう、既に別タスクへ
// 紐づいているチケットは409 already_linked(linkedTaskIds付き)で止め、呼び出し側が
// allowShared:true を付けて再送した時だけ紐づける(タグ作成のconfirmSimilarと同じ作法)。
//   -> 成功時のレスポンスに sharedWith(同じチケットに紐づく他タスクのID配列、無ければ空)が付く。

const redmineClient = require('./redmine-client');
const gitlabClient = require('./gitlab-client');
const itsCredentials = require('./its-credentials');
const externalLinksRepo = require('./db/external-links-repo');

const SUPPORTED_SOURCES = ['redmine', 'gitlab'];

// sourceごとの違い(表示名、実在確認、保存するキーとURL)をここに集める。
// lookup は { key, url } を返し、見つからなければ null を返す。通信の失敗は例外のまま呼び出し元(502)へ渡す。
const SOURCE_ADAPTERS = {
  redmine: {
    label: 'Redmine',
    async lookup(conn, key) {
      const issues = await redmineClient.fetchIssuesByIds(conn.host, conn.token, [key]);
      const issue = issues.find((i) => String(i.id) === key);
      return issue ? { key: String(issue.id), url: `${conn.host}/issues/${issue.id}` } : null;
    },
  },
  gitlab: {
    label: 'GitLab',
    async lookup(conn, key) {
      // projectRefで絞った検索なので、別プロジェクトの同じiidは返らない(空配列になり、見つからない扱い)
      const issues = await gitlabClient.fetchIssuesByIids(conn.host, conn.token, conn.projectRef, [key]);
      const issue = issues.find((i) => String(i.iid) === key);
      return issue ? { key: String(issue.iid), url: issue.web_url } : null;
    },
  },
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * @param {{config: object, credentialsPath: string, getDb: () => object, tasksRepo: object,
 *   readRequestBody: (req) => Promise<object>, onChange: () => void}} deps
 * @returns {(req, res) => boolean} 処理した場合true(未処理ならfalseを返し呼び出し側が続行する)
 */
function createItsLinkApi({ config, credentialsPath, getDb, tasksRepo, readRequestBody, onChange }) {
  async function handleLink(req, res, body) {
    const { taskId, source, issueKey } = body;
    if (!taskId || !issueKey) {
      sendJson(res, 400, { error: 'taskId and issueKey are required' });
      return;
    }
    if (!SUPPORTED_SOURCES.includes(source)) {
      sendJson(res, 400, { error: `source must be one of: ${SUPPORTED_SOURCES.join(', ')}` });
      return;
    }

    const db = getDb();
    const task = tasksRepo.getByDisplayId(db, taskId);
    if (!task) {
      sendJson(res, 404, { error: `Task ${taskId} not found` });
      return;
    }
    const project = (config.projects || []).find((p) => p.file === task.workspace);
    if (!project) {
      sendJson(res, 404, { error: `Project not found for workspace "${task.workspace}"` });
      return;
    }

    const conn = itsCredentials.resolveConnection(credentialsPath, task.workspace, source);
    if (!conn) {
      sendJson(res, 400, { error: `${source}連携が未設定です (workspace: ${task.workspace})` });
      return;
    }

    const normalizedKey = String(issueKey).replace(/^#/, '').trim();
    if (!/^\d+$/.test(normalizedKey)) {
      sendJson(res, 400, { error: `Invalid issue key: "${issueKey}"` });
      return;
    }

    // 同一チケットが既に別タスクへ紐づいている場合は、allowSharedが無い限り409で確認を求める(BM-158)
    const sharedWith = externalLinksRepo.findLinkedTasks(db, {
      source, host: conn.host, projectRef: conn.projectRef, issueKey: normalizedKey,
    }, taskId);
    if (sharedWith.length > 0 && body.allowShared !== true) {
      sendJson(res, 409, {
        error: 'already_linked',
        message: `Issue #${normalizedKey} is already linked to other task(s): ${sharedWith.join(', ')}`,
        linkedTaskIds: sharedWith,
      });
      return;
    }

    const adapter = SOURCE_ADAPTERS[source];
    let found;
    try {
      found = await adapter.lookup(conn, normalizedKey);
    } catch (e) {
      sendJson(res, 502, { error: `${adapter.label} API error: ${e.message}` });
      return;
    }
    if (!found) {
      sendJson(res, 404, { error: `${adapter.label} issue #${normalizedKey} not found` });
      return;
    }

    // BT-470: リンクの保存と履歴(external_link_added)を同一トランザクションにする。
    // 同じタスク+sourceに既存リンクがあれば、上書きなので解除(external_link_removed)も先に記録する
    const actor = tasksRepo.normalizeActor(body.actor);
    const previous = (externalLinksRepo.listLinksForTasks(db, [task.id])[task.id] || []).find((l) => l.source === source);
    db.exec('BEGIN');
    try {
      if (previous) {
        tasksRepo.insertEvent(db, { taskId: task.id, taskDisplayId: task.display_id, eventType: 'external_link_removed',
          oldValue: tasksRepo.formatExternalLinkValue(source, previous.key), actor });
      }
      externalLinksRepo.setLink(db, {
        taskId: task.id,
        source,
        host: conn.host,
        projectRef: conn.projectRef,
        issueKey: found.key,
        issueUrl: found.url,
        linkedBy: actor,
      });
      tasksRepo.insertEvent(db, { taskId: task.id, taskDisplayId: task.display_id, eventType: 'external_link_added',
        newValue: tasksRepo.formatExternalLinkValue(source, found.key), actor });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    sendJson(res, 200, { ok: true, source, issueKey: found.key, issueUrl: found.url, sharedWith });
    onChange();
  }

  // BT-470: 紐づけ解除。こちら側のリンクを外すだけで、外部ITSへは何もしない(読み取り専用の方針)。
  //   POST /api/its-unlink-issue {taskId, source, actor?} -> { ok, source, issueKey }
  function handleUnlink(req, res, body) {
    const { taskId, source } = body;
    if (!taskId) {
      sendJson(res, 400, { error: 'taskId is required' });
      return;
    }
    if (!SUPPORTED_SOURCES.includes(source)) {
      sendJson(res, 400, { error: `source must be one of: ${SUPPORTED_SOURCES.join(', ')}` });
      return;
    }
    const db = getDb();
    const task = tasksRepo.getByDisplayId(db, taskId);
    if (!task) {
      sendJson(res, 404, { error: `Task ${taskId} not found` });
      return;
    }
    const existing = (externalLinksRepo.listLinksForTasks(db, [task.id])[task.id] || []).find((l) => l.source === source);
    if (!existing) {
      sendJson(res, 404, { error: `Task ${taskId} is not linked to ${source}` });
      return;
    }
    const actor = tasksRepo.normalizeActor(body.actor);
    db.exec('BEGIN');
    try {
      externalLinksRepo.removeLink(db, { taskId: task.id, source });
      tasksRepo.insertEvent(db, { taskId: task.id, taskDisplayId: task.display_id, eventType: 'external_link_removed',
        oldValue: tasksRepo.formatExternalLinkValue(source, existing.key), actor });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJson(res, 200, { ok: true, source, issueKey: existing.key });
    onChange();
  }

  return function handle(req, res) {
    if (req.method === 'POST' && req.url === '/api/its-unlink-issue') {
      readRequestBody(req).then((body) => handleUnlink(req, res, body || {})).catch(() => {
        sendJson(res, 400, { error: 'Invalid JSON body' });
      });
      return true;
    }
    if (req.method === 'POST' && req.url === '/api/its-link-issue') {
      readRequestBody(req).then((body) => handleLink(req, res, body || {})).catch(() => {
        sendJson(res, 400, { error: 'Invalid JSON body' });
      });
      return true;
    }
    return false;
  };
}

module.exports = { createItsLinkApi };
