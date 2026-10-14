'use strict';

// BM-071: 外部ITS(Redmine/GitLab)連携の設定取得・保存API。tags-api.jsと同じ切り出し方針
// (server.jsが肥大化しないよう別ファイルに持ち、DB以外の依存は呼び出し元から注入する)。
//   GET  /api/its-settings?prefix=XX        プロジェクト単位の全source設定(github/redmine/gitlab)
//   POST /api/its-settings  {prefix, source, projectUrl?, token?}
//   GET  /api/its-host-status?source=&url=  入力中のURLからホストを判定し、トークン設定済みかを返す

const itsCredentials = require('./its-credentials');

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * @param {{config: object, credentialsPath: string, readRequestBody: (req) => Promise<object>, getGithubStatus: (prefix: string) => {configured: boolean}}} deps
 * @returns {(req, res) => boolean} 処理した場合true(未処理ならfalseを返し呼び出し側が続行する)
 */
function createItsSettingsApi({ config, credentialsPath, readRequestBody, getGithubStatus }) {
  function findProjectByPrefix(prefix) {
    return (config.projects || []).find(p => p.prefix === prefix);
  }

  return function handle(req, res) {
    if (req.method === 'GET' && req.url && req.url.startsWith('/api/its-settings')) {
      const url = new URL(req.url, 'http://localhost');
      const prefix = url.searchParams.get('prefix');
      if (!prefix) {
        sendJson(res, 400, { error: 'prefix is required' });
        return true;
      }
      const project = findProjectByPrefix(prefix);
      if (!project) {
        sendJson(res, 404, { error: `Unknown prefix: "${prefix}"` });
        return true;
      }
      const perSource = itsCredentials.getAllSettingsForWorkspace(credentialsPath, project.file);
      sendJson(res, 200, { prefix, github: getGithubStatus(prefix), ...perSource });
      return true;
    }

    if (req.method === 'GET' && req.url && req.url.startsWith('/api/its-host-status')) {
      const url = new URL(req.url, 'http://localhost');
      const source = url.searchParams.get('source');
      const projectUrl = url.searchParams.get('url') || '';
      if (source !== 'redmine' && source !== 'gitlab') {
        sendJson(res, 400, { error: 'source must be "redmine" or "gitlab"' });
        return true;
      }
      sendJson(res, 200, itsCredentials.getHostStatus(credentialsPath, source, projectUrl));
      return true;
    }

    if (req.method === 'POST' && req.url === '/api/its-settings') {
      readRequestBody(req).then(({ prefix, source, projectUrl, token }) => {
        if (!prefix) {
          sendJson(res, 400, { error: 'prefix is required' });
          return;
        }
        if (source !== 'redmine' && source !== 'gitlab') {
          sendJson(res, 400, { error: 'source must be "redmine" or "gitlab"' });
          return;
        }
        const project = findProjectByPrefix(prefix);
        if (!project) {
          sendJson(res, 404, { error: `Unknown prefix: "${prefix}"` });
          return;
        }
        const result = itsCredentials.saveSettings(credentialsPath, project.file, source, { projectUrl, token });
        if (result.success) {
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 400, { error: result.error });
        }
      }).catch(() => {
        sendJson(res, 400, { error: 'Invalid JSON body' });
      });
      return true;
    }

    return false;
  };
}

module.exports = { createItsSettingsApi };
