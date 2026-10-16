'use strict';

// BM-074: GitLab REST APIクライアント(読み取り専用)。
// redmine-client.js(BM-072)と同じ型(外部依存なし、http/https両対応、GETのみ)で実装する。
// 旧DB版(C:\shinano\dev\kiro\kiro-backlog-todo-db\backlog-dashboard\gitlab-api.js)のHTTP通信部分を
// ベースにしているが、BM-069方針C(外部への書き戻しはしない)のためcreateIssue等は持ってこない。
//
// 認証はPRIVATE-TOKENヘッダー。1リクエスト15秒でタイムアウト。
// 受信はBuffer.concatしてからUTF-8でデコードする(日本語本文の文字化け対策)。
//
// GitLabにはRedmineの「トラッカー」に相当する概念が無く、issueのstateもopened/closedが
// 直接返るため、fetchProjectInfo/fetchClosedStatusIds相当の関数は無い。

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
      reject(new Error('GitLab APIへの接続がタイムアウトしました'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * GitLab REST APIを呼ぶ共通ヘルパー(GETのみ)。ページング判定に使うため、
 * JSONボディだけでなくレスポンスヘッダーも返す(redmine-client.jsのcallRestとの違い)。
 * @param {string} host - 例: "https://gitlab.example.com"(末尾スラッシュなし)
 * @param {string} token - Personal Access Token
 * @param {string} apiPath - 例: "/api/v4/projects/45/issues?state=all"
 * @returns {Promise<{data: any, headers: object}>}
 */
async function callRest(host, token, apiPath) {
  const res = await request(`${host}${apiPath}`, { headers: { 'PRIVATE-TOKEN': token } });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`GitLab APIエラー (${res.statusCode}): ${res.body.slice(0, 300)}`);
  }
  if (!res.body || !res.body.trim()) return { data: {}, headers: res.headers };
  try {
    return { data: JSON.parse(res.body), headers: res.headers };
  } catch (e) {
    throw new Error('GitLab APIのレスポンスがJSONとして解析できませんでした');
  }
}

/**
 * issue一覧を1ページ取得する。offsetはpageに換算して渡す(BM-069決定事項4のoffset/page換算)。
 * 続きの有無は`x-next-page`ヘッダーの有無で判定する(件数ではなくヘッダーで判定するのが確実)。
 * 全件数は`x-total`ヘッダーがあれば使う(無ければnullを返す。GitLabは件数が多いプロジェクトで
 * パフォーマンスのためx-totalを省略できる設定がある)。
 * @param {{statusFilter: 'open'|'all', page: number, perPage?: number}} opts
 * @returns {Promise<{issues: Array, totalCount: number|null, hasNext: boolean}>}
 */
async function fetchIssuesPage(host, token, projectRef, { statusFilter, page = 1, perPage = 100 }) {
  const encodedPath = encodeURIComponent(projectRef);
  const qs = new URLSearchParams({
    state: statusFilter === 'all' ? 'all' : 'opened',
    per_page: String(perPage),
    page: String(page),
    order_by: 'created_at',
    sort: 'desc',
  });
  const { data, headers } = await callRest(host, token, `/api/v4/projects/${encodedPath}/issues?${qs.toString()}`);
  const totalHeader = headers['x-total'];
  return {
    issues: Array.isArray(data) ? data : [],
    totalCount: totalHeader !== undefined ? Number(totalHeader) : null,
    hasNext: !!headers['x-next-page'],
  };
}

/**
 * issue一覧を複数ページ分まとめて取得する(1回の呼び出しで最大maxCount件、BM-069決定事項4:
 * 1回の読み込みは最大500件=100件x5ページ)。offsetを受け取り、呼び出し元が続きの有無を
 * hasMoreで判定できるようにする(totalCountはx-totalが取れない場合nullのままになるため、
 * 続きの有無の判定には使わない)。
 * @returns {Promise<{issues: Array, totalCount: number|null, hasMore: boolean}>}
 */
async function fetchIssuesBatch(host, token, projectRef, { statusFilter, offset = 0, maxCount = 500, pageSize = 100 }) {
  let collected = [];
  let totalCount = null;
  let currentOffset = offset;
  let hasMore = false;
  while (collected.length < maxCount) {
    const page = Math.floor(currentOffset / pageSize) + 1;
    const result = await fetchIssuesPage(host, token, projectRef, { statusFilter, page, perPage: pageSize });
    if (result.totalCount !== null) totalCount = result.totalCount;
    collected = collected.concat(result.issues);
    currentOffset += pageSize;
    hasMore = result.hasNext;
    if (!result.hasNext) break; // GitLab側の最終ページ
  }
  return { issues: collected.slice(0, maxCount), totalCount, hasMore };
}

/**
 * 指定iidの配列のissueだけをまとめて取得する(取り込み実行時、選択されたissueの
 * 最新状態を取り直すために使う。`iids[]=`はカンマ区切りではなく繰り返しパラメータのため、
 * redmine-client.jsのfetchIssuesByIdsと同じく100件ずつに分割して呼ぶ)。
 * @param {Array<number|string>} iids
 * @returns {Promise<Array>}
 */
async function fetchIssuesByIids(host, token, projectRef, iids) {
  if (!iids || iids.length === 0) return [];
  const encodedPath = encodeURIComponent(projectRef);
  const chunkSize = 100;
  let all = [];
  for (let i = 0; i < iids.length; i += chunkSize) {
    const chunk = iids.slice(i, i + chunkSize);
    const iidsQuery = chunk.map((iid) => `iids[]=${encodeURIComponent(iid)}`).join('&');
    const { data } = await callRest(host, token, `/api/v4/projects/${encodedPath}/issues?state=all&per_page=${chunk.length}&${iidsQuery}`);
    all = all.concat(Array.isArray(data) ? data : []);
  }
  return all;
}

module.exports = {
  fetchIssuesPage,
  fetchIssuesBatch,
  fetchIssuesByIids,
};
