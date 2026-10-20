'use strict';

// BT-446: ロゴメニューに出す「直近の更新コミット」(取り込み済み = HEADまでの履歴)を返すAPI。
// 保存はせず、呼ばれるたびにgit logを読む(クローンした人の取り込み量に応じて件数が変わる)。
//   GET /api/recent-commits?limit=N  既定50件・上限200件。PRのマージコミットは件名が中身を表さないため除外
//   ただしHEAD自身がマージコミットの場合だけ先頭に1件加え、isHead:trueを付ける(BT-451)。
//   ロゴ下・更新確認が出すハッシュ(=HEAD)と一覧の現在地を一致させるため
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

const LOG_FORMAT = '--format=%h%x1f%cI%x1f%s%x1f%b%x1e';

function runGitHead(repoRoot) {
  return new Promise((resolve, reject) => {
    execFile('git', ['log', '-1', 'HEAD', LOG_FORMAT], { cwd: repoRoot, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** 一覧の先頭にHEADを揃える。HEADが一覧にあればisHeadを付け、無ければ(=マージコミット)先頭に足す */
function withHead(commits, headStdout) {
  const [head] = parseLog(headStdout);
  if (!head) return commits;
  const idx = commits.findIndex(c => c.shortHash === head.shortHash);
  if (idx >= 0) return commits.map((c, i) => (i === idx ? { ...c, isHead: true } : c));
  return [{ ...head, isHead: true }, ...commits];
}

function runGitLog(repoRoot, limit) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['log', 'HEAD', '--no-merges', `-n${limit}`, LOG_FORMAT],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/**
 * @param {{repoRoot: string, run?: (limit: number) => Promise<string>, runHead?: () => Promise<string>}} deps
 * @returns {(req, res) => boolean} 処理した場合true
 */
function createRecentCommitsApi({ repoRoot, run = limit => runGitLog(repoRoot, limit), runHead = () => runGitHead(repoRoot) }) {
  return function handle(req, res) {
    const [pathname, query = ''] = (req.url || '').split('?');
    if (pathname !== '/api/recent-commits' || req.method !== 'GET') return false;

    const limit = parseLimit(new URLSearchParams(query).get('limit'));
    if (limit === null) {
      sendJson(res, 400, { error: 'invalid_limit', message: 'limitは1以上の整数で指定してください' });
      return true;
    }
    run(limit)
      .then(async (stdout) => {
        // HEADの取得に失敗しても一覧自体は返す(現在地の印だけ付かない)
        const headStdout = await runHead().catch(() => '');
        sendJson(res, 200, { commits: withHead(parseLog(stdout), headStdout), limit });
      })
      .catch((e) => {
        console.error('[recent-commits] git log failed:', e.message);
        // git管理外などで取れない時は空で返し、画面側は「取得できません」と出す
        sendJson(res, 200, { commits: [], limit, unavailable: true });
      });
    return true;
  };
}

module.exports = { createRecentCommitsApi, parseLimit, parseLog, withHead, DEFAULT_LIMIT, MAX_LIMIT };
