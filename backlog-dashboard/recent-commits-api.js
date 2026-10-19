'use strict';

// BT-446: ロゴメニューに出す「直近の更新コミット」(取り込み済み = HEADまでの履歴)を返すAPI。
// 保存はせず、呼ばれるたびにgit logを読む(クローンした人の取り込み量に応じて件数が変わる)。
//   GET /api/recent-commits?limit=N  既定50件・上限200件。PRのマージコミットは件名が中身を表さないため除外
// gitの実行は呼び出し元から注入し、テストで差し替えられる(rules-sync-api.jsと同じ方針)。

const { execFile } = require('node:child_process');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function parseLimit(raw) {
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n >= 1 ? Math.min(n, MAX_LIMIT) : null;
}

function parseLog(stdout) {
  // 1コミット=1レコード(0x1E区切り)。本文(body)は複数行になりうるため改行ではなくレコード区切りを使う
  return String(stdout).split('\u001e').map(r => r.replace(/^\n+/, '')).filter(Boolean).map((rec) => {
    const [shortHash, date, subject, body = ''] = rec.split('\u001f');
    return { shortHash, date, subject, body: body.trim() };
  });
}

function runGitLog(repoRoot, limit) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['log', 'HEAD', '--no-merges', `-n${limit}`, '--format=%h%x1f%cI%x1f%s%x1f%b%x1e'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/**
 * @param {{repoRoot: string, run?: (limit: number) => Promise<string>}} deps
 * @returns {(req, res) => boolean} 処理した場合true
 */
function createRecentCommitsApi({ repoRoot, run = limit => runGitLog(repoRoot, limit) }) {
  return function handle(req, res) {
    const [pathname, query = ''] = (req.url || '').split('?');
    if (pathname !== '/api/recent-commits' || req.method !== 'GET') return false;

    const limit = parseLimit(new URLSearchParams(query).get('limit'));
    if (limit === null) {
      sendJson(res, 400, { error: 'invalid_limit', message: 'limitは1以上の整数で指定してください' });
      return true;
    }
    run(limit)
      .then(stdout => sendJson(res, 200, { commits: parseLog(stdout), limit }))
      .catch((e) => {
        console.error('[recent-commits] git log failed:', e.message);
        // git管理外などで取れない時は空で返し、画面側は「取得できません」と出す
        sendJson(res, 200, { commits: [], limit, unavailable: true });
      });
    return true;
  };
}

module.exports = { createRecentCommitsApi, parseLimit, parseLog, DEFAULT_LIMIT, MAX_LIMIT };
