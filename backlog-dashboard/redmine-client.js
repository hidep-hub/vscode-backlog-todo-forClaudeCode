'use strict';

// BM-072: Redmine REST APIクライアント(読み取り専用)。
// 旧DB版(C:\shinano\dev\kiro\kiro-backlog-todo-db\backlog-dashboard\redmine-api.js)をベースに、
// GET系のみを持ってくる(BM-069方針C: 外部への書き戻しはしない。update/create/delete等は実装しない)。
//
// 認証はX-Redmine-API-Keyヘッダー(?key=はURL・ログに残るため使わない)。
// http/https両対応(社内Redmineはhttp運用のため)。1リクエスト15秒でタイムアウト。
// 受信はBuffer.concatしてからUTF-8でデコードする(日本語本文の文字化け対策)。

const https = require('https');
const http = require('http');
const { URL } = require('url');

const TIMEOUT_MS = 15000;

/**
 * 指定URLにHTTPリクエストを送り、レスポンスボディをUTF-8文字列として返す。
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
function request(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method,
        headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Redmine APIへの接続がタイムアウトしました'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Redmine REST APIを呼ぶ共通ヘルパー(GETのみ)。
 * @param {string} host - 例: "http://host.example.com/redmine"(末尾スラッシュなし)
 * @param {string} apiKey
 * @param {string} apiPath - 例: "/issues.json?project_id=sample"
 */
async function callRest(host, apiKey, apiPath) {
  const res = await request(`${host}${apiPath}`, { headers: { 'X-Redmine-API-Key': apiKey } });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Redmine APIエラー (${res.statusCode}): ${res.body.slice(0, 300)}`);
  }
  if (!res.body || !res.body.trim()) return {};
  try {
    return JSON.parse(res.body);
  } catch (e) {
    throw new Error('Redmine APIのレスポンスがJSONとして解析できませんでした');
  }
}

/**
 * プロジェクトの基本情報(日本語名称・使えるトラッカー一覧)を取得する。
 * @returns {Promise<{name: string, trackers: Array<{id: number, name: string}>}>}
 */
async function fetchProjectInfo(host, apiKey, projectRef) {
  const data = await callRest(host, apiKey, `/projects/${encodeURIComponent(projectRef)}.json?include=trackers`);
  const project = data.project || {};
  return { name: project.name || '', trackers: (project.trackers || []).map((t) => ({ id: t.id, name: t.name })) };
}

/**
 * close済みとして扱われるステータスID集合を取得する。重要: Redmineのissueのstatusオブジェクトは
 * {id, name}のみでis_closedを持たないため、/issue_statuses.jsonと突き合わせる必要がある。
 * @returns {Promise<Set<number>>}
 */
async function fetchClosedStatusIds(host, apiKey) {
  const data = await callRest(host, apiKey, '/issue_statuses.json');
  return new Set((data.issue_statuses || []).filter((s) => s.is_closed).map((s) => s.id));
}

/**
 * チケット一覧を1ページ取得する(トラッカー必須、status指定可)。
 * @param {{trackerId: number|string, statusFilter: 'open'|'all', limit?: number, offset?: number}} opts
 * @returns {Promise<{issues: Array, totalCount: number}>}
 */
async function fetchIssuesPage(host, apiKey, projectRef, { trackerId, statusFilter, limit = 100, offset = 0 }) {
  const qs = new URLSearchParams({
    project_id: projectRef,
    tracker_id: String(trackerId),
    status_id: statusFilter === 'all' ? '*' : 'open',
    limit: String(limit),
    offset: String(offset),
    sort: 'id:desc',
  });
  const data = await callRest(host, apiKey, `/issues.json?${qs.toString()}`);
  return { issues: data.issues || [], totalCount: data.total_count || 0 };
}

/**
 * チケット一覧を複数ページ分まとめて取得する(1回の呼び出しで最大maxCount件、BM-069決定事項4:
 * 1回の読み込みは最大500件=100件x5ページ)。offsetを受け取り、呼び出し元が続きの有無を
 * totalCountと合わせて判定できるようにする。
 * @returns {Promise<{issues: Array, totalCount: number}>}
 */
async function fetchIssuesBatch(host, apiKey, projectRef, { trackerId, statusFilter, offset = 0, maxCount = 500, pageSize = 100 }) {
  let collected = [];
  let totalCount = 0;
  let currentOffset = offset;
  while (collected.length < maxCount) {
    const page = await fetchIssuesPage(host, apiKey, projectRef, { trackerId, statusFilter, limit: pageSize, offset: currentOffset });
    totalCount = page.totalCount;
    collected = collected.concat(page.issues);
    currentOffset += pageSize;
    if (page.issues.length < pageSize) break; // Redmine側の最終ページ
  }
  return { issues: collected.slice(0, maxCount), totalCount };
}

/**
 * 指定idの配列のチケットだけをまとめて取得する(取り込み実行時、選択されたチケットの
 * 最新状態を取り直すために使う。issue_id=はカンマ区切りで複数id指定できるが、
 * 旧版の実装でlimitを超えた分がまとめて取得できない不具合があったため、
 * 100件ずつに分割して呼ぶ(引き継ぎファイル「旧版から引き継がないもの」参照)。
 * @param {Array<number|string>} issueIds
 * @returns {Promise<Array>}
 */
async function fetchIssuesByIds(host, apiKey, issueIds) {
  if (!issueIds || issueIds.length === 0) return [];
  const chunkSize = 100;
  let all = [];
  for (let i = 0; i < issueIds.length; i += chunkSize) {
    const chunk = issueIds.slice(i, i + chunkSize);
    const qs = new URLSearchParams({ issue_id: chunk.join(','), status_id: '*', limit: String(chunk.length) });
    const data = await callRest(host, apiKey, `/issues.json?${qs.toString()}`);
    all = all.concat(data.issues || []);
  }
  return all;
}

module.exports = {
  fetchProjectInfo,
  fetchClosedStatusIds,
  fetchIssuesPage,
  fetchIssuesBatch,
  fetchIssuesByIds,
};
