'use strict';

// ============================================================
// GitHub API Client (BT-075)
// ============================================================
// @octokit/rest は導入せず、Node標準 https で自前実装する(既存依存が
// ws のみという超ミニマル志向に合わせるため)。
// メソッド名は octokit の rest.issues.* に合わせている
// (listForRepo/create/update/createComment)。

const https = require('https');

const GITHUB_API_HOST = 'api.github.com';
const USER_AGENT = 'backlog-dashboard';

/**
 * リポジトリURLから owner/repo を抽出する。
 * 例: https://github.com/owner/repo, https://github.com/owner/repo.git
 */
function parseRepoUrl(repoUrl) {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(repoUrl || '');
  if (!m) throw new Error(`Invalid GitHub repo URL: "${repoUrl}"`);
  return { owner: m[1], repo: m[2] };
}

function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      { hostname: GITHUB_API_HOST, path: urlPath, method, headers },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          if (data) {
            try { parsed = JSON.parse(data); } catch (e) { /* 空/非JSON応答は無視 */ }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const message = (parsed && parsed.message) || `GitHub API error (status ${res.statusCode})`;
            reject(new Error(message));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * GET /repos/{owner}/{repo}/issues 相当
 */
function listForRepo(repoUrl, token, { state = 'open', page = 1, perPage = 30 } = {}) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const query = `state=${encodeURIComponent(state)}&page=${page}&per_page=${perPage}`;
  return request('GET', `/repos/${owner}/${repo}/issues?${query}`, token);
}

/**
 * POST /repos/{owner}/{repo}/issues 相当
 */
function create(repoUrl, token, { title, body }) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  return request('POST', `/repos/${owner}/${repo}/issues`, token, { title, body });
}

/**
 * PATCH /repos/{owner}/{repo}/issues/{issue_number} 相当
 */
function update(repoUrl, token, issueNumber, fields) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  return request('PATCH', `/repos/${owner}/${repo}/issues/${issueNumber}`, token, fields);
}

/**
 * POST /repos/{owner}/{repo}/issues/{issue_number}/comments 相当
 */
function createComment(repoUrl, token, issueNumber, body) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  return request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, { body });
}

module.exports = {
  parseRepoUrl,
  issues: { listForRepo, create, update, createComment },
};
