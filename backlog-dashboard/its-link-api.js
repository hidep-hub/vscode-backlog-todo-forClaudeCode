'use strict';

// BM-126: 既存タスクへ外部ITS(現時点ではRedmineのみ)のチケットを後から紐づけるAPI。
// GitHubの/api/github-link-issue(server.js)と同じ骨格だが、保存先はtasks.github_issue_*列ではなく
// BM-071のtask_external_linksテーブル(externalLinksRepo)。
//   POST /api/its-link-issue {taskId, source, issueKey}
//     -> { ok, source, issueKey, issueUrl }
//
// スコープ(ユーザー合意事項、BM-126):
//   - 既存タスクへの「紐づけ」のみ。チケットの新規作成はしない(github-create-issue相当は作らない)。
//   - 上書き許可(間違えた場合の修正を想定)。同一タスク+sourceへの再紐づけはsetLink()で上書きする。
//   - チケット番号はRedmine APIで実在確認してから保存する(its-credentials未設定なら400)。
//   - GitLabの個別紐づけは対象外(sourceはredmineのみ受け付ける)。

const redmineClient = require('./redmine-client');
const itsCredentials = require('./its-credentials');
const externalLinksRepo = require('./db/external-links-repo');

// BM-126時点ではRedmineのみ対応。GitLabは個別紐づけの対象外(スコープ外、ユーザー合意済み)。
const SUPPORTED_SOURCES = ['redmine'];

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

    // 同一チケットが既に別タスクへ紐づいていないかチェック(上書きは同一タスクへの再設定のみ許可)
    const linked = externalLinksRepo.findLinkedTask(db, {
      source, host: conn.host, projectRef: conn.projectRef, issueKey: normalizedKey,
    });
    if (linked && linked.taskId !== taskId) {
      sendJson(res, 400, { error: `Issue #${normalizedKey} is already linked to another task (${linked.taskId})` });
      return;
    }

    let issues;
    try {
      issues = await redmineClient.fetchIssuesByIds(conn.host, conn.token, [normalizedKey]);
    } catch (e) {
      sendJson(res, 502, { error: `Redmine API error: ${e.message}` });
      return;
    }
    const issue = issues.find((i) => String(i.id) === normalizedKey);
    if (!issue) {
      sendJson(res, 404, { error: `Redmine issue #${normalizedKey} not found` });
      return;
    }

    const issueUrl = `${conn.host}/issues/${issue.id}`;
    externalLinksRepo.setLink(db, {
      taskId: task.id,
      source,
      host: conn.host,
      projectRef: conn.projectRef,
      issueKey: issue.id,
      issueUrl,
      linkedBy: tasksRepo.normalizeActor(body.actor),
    });

    sendJson(res, 200, { ok: true, source, issueKey: String(issue.id), issueUrl });
    onChange();
  }

  return function handle(req, res) {
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
