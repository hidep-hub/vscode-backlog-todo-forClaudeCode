'use strict';

// BM-071: 外部ITS(Redmine/GitLab)連携の設定・資格情報管理。
// github-credentials.jsonと同じ理由(config.jsonはfs.watchでホットリロードされるため
// トークンを混在させたくない)で、別ファイル(its-credentials.json、gitignore対象)に持つ。
//
// 構造(引き継ぎファイル docs/plans/2026-10-07_bm-069-its-import-handoff.md ステップ1案通り):
//   {
//     "workspaces": { "<project.file>": { "redmine": { "projectUrl": "..." }, "gitlab": { "projectUrl": "..." } } },
//     "hosts": { "redmine": { "<host>": { "token": "..." } }, "gitlab": { "<host>": { "token": "..." } } }
//   }
// トークンはホスト単位で持つ(「ユーザー単位で一度設定すればよい」という要望に合わせた形。
// 同じホストなら複数ワークスペースで共有できる)。プロジェクト側はワークスペース単位。

const fs = require('fs');

/**
 * RedmineのプロジェクトURL(issue一覧ページ等のサブリソースURLでも可)を
 * ホスト(Redmineインストールのベース、サブパス設置に対応)とプロジェクト識別子に分解する。
 * @param {string} url
 * @returns {{host: string, projectRef: string}|null} 解析失敗時はnull
 */
function parseRedmineProjectUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const m = trimmed.match(/^(https?:\/\/[^/]+(?:\/[^/]*)*?)\/projects\/([^/?#]+)/);
  if (!m) return null;
  const host = m[1].replace(/\/+$/, '');
  const projectRef = m[2];
  if (!host || !projectRef) return null;
  return { host, projectRef };
}

/**
 * GitLabのプロジェクトURL(例 http://host/group/project、.git付き・/-/issues等のサブパス付きも可)を
 * ホスト(origin)とproject_ref(path_with_namespace)に分解する。
 * @param {string} url
 * @returns {{host: string, projectRef: string}|null} 解析失敗時はnull
 */
function parseGitlabProjectUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return null;
  }
  const host = `${parsed.protocol}//${parsed.host}`;
  let pathPart = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  // "/-/" 以降(issues, merge_requests等のサブパス)は除く
  const dashIndex = pathPart.indexOf('/-/');
  if (dashIndex !== -1) pathPart = pathPart.slice(0, dashIndex);
  pathPart = pathPart.replace(/\.git$/, '');
  if (!pathPart || !pathPart.includes('/')) return null;
  return { host, projectRef: pathPart };
}

const PARSERS = { redmine: parseRedmineProjectUrl, gitlab: parseGitlabProjectUrl };

function parseProjectUrl(source, url) {
  const parser = PARSERS[source];
  if (!parser) return null;
  return parser(url);
}

function readCredentials(filePath) {
  if (!fs.existsSync(filePath)) return { workspaces: {}, hosts: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { workspaces: parsed.workspaces || {}, hosts: parsed.hosts || {} };
  } catch (e) {
    console.error('[its-credentials] Failed to read:', e.message);
    return { workspaces: {}, hosts: {} };
  }
}

function writeCredentials(filePath, data) {
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch (e) {
      console.error('[its-credentials] Failed to create .bak before write:', e.message);
    }
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function hasHostToken(data, source, host) {
  const entry = ((data.hosts || {})[source] || {})[host];
  return !!(entry && entry.token && entry.token.trim());
}

function getHostToken(data, source, host) {
  const entry = ((data.hosts || {})[source] || {})[host];
  return (entry && entry.token) || '';
}

/**
 * workspace(project.file) + source の設定を返す。トークン値そのものは返さない(hasTokenのみ)。
 * @returns {{configured: boolean, projectUrl: string, host: string, projectRef: string, hasToken: boolean}}
 */
function getSettings(filePath, workspace, source) {
  const data = readCredentials(filePath);
  const projectUrl = ((data.workspaces || {})[workspace] || {})[source]?.projectUrl || '';
  const parsed = parseProjectUrl(source, projectUrl);
  const host = parsed ? parsed.host : '';
  const projectRef = parsed ? parsed.projectRef : '';
  const hasToken = host ? hasHostToken(data, source, host) : false;
  return { source, configured: !!(host && projectRef && hasToken), projectUrl, host, projectRef, hasToken };
}

/**
 * workspace配下の全source設定を返す({redmine: {...}, gitlab: {...}})。
 * 取り込みモーダルで「設定済みのソースだけ選べる」ようにするための一括取得用。
 */
function getAllSettingsForWorkspace(filePath, workspace) {
  const result = {};
  for (const source of Object.keys(PARSERS)) {
    result[source] = getSettings(filePath, workspace, source);
  }
  return result;
}

/**
 * workspace + source のプロジェクトURL・(渡された場合のみ)トークンを保存する。
 * トークンが未指定なら既存トークンを保持し、空文字が渡されたらそのホストのトークンを消す。
 * @returns {{success: boolean, error?: string, host?: string}}
 */
function saveSettings(filePath, workspace, source, { projectUrl, token } = {}) {
  if (!PARSERS[source]) return { success: false, error: `未対応のsourceです: ${source}` };
  const data = readCredentials(filePath);
  data.workspaces = data.workspaces || {};
  data.hosts = data.hosts || {};
  data.workspaces[workspace] = data.workspaces[workspace] || {};
  const existingUrl = (data.workspaces[workspace][source] || {}).projectUrl || '';
  const nextUrl = projectUrl !== undefined ? projectUrl : existingUrl;

  let host = null;
  if (nextUrl) {
    const parsed = parseProjectUrl(source, nextUrl);
    if (!parsed) {
      return { success: false, error: `${source}のプロジェクトURLとして解釈できませんでした: "${nextUrl}"` };
    }
    host = parsed.host;
  }
  data.workspaces[workspace][source] = { projectUrl: nextUrl };

  if (token !== undefined && token !== '') {
    if (!host) return { success: false, error: 'トークンを保存するにはプロジェクトURLが先に必要です' };
    data.hosts[source] = data.hosts[source] || {};
    data.hosts[source][host] = { token };
  } else if (token === '') {
    if (host && data.hosts[source] && data.hosts[source][host]) {
      delete data.hosts[source][host];
    }
  }

  writeCredentials(filePath, data);
  return { success: true, host };
}

/**
 * 指定source/urlの入力中に「このホストはトークン設定済みか」を判定する(設定パネルの
 * デバウンス入力確認用)。URLがまだ解析できない場合はvalid:falseを返す。
 */
function getHostStatus(filePath, source, url) {
  const parsed = parseProjectUrl(source, url);
  if (!parsed) return { valid: false, host: '', projectRef: '', hasToken: false };
  const data = readCredentials(filePath);
  return { valid: true, host: parsed.host, projectRef: parsed.projectRef, hasToken: hasHostToken(data, source, parsed.host) };
}

/**
 * Redmine/GitLabクライアントがAPI呼び出しに使うホスト・トークンを取得する(サーバー内部用、
 * トークン本体をフロントへ返す経路ではここを通さないこと)。
 * @returns {{host: string, projectRef: string, token: string}|null} 未設定ならnull
 */
function resolveConnection(filePath, workspace, source) {
  const settings = getSettings(filePath, workspace, source);
  if (!settings.configured) return null;
  const data = readCredentials(filePath);
  return { host: settings.host, projectRef: settings.projectRef, token: getHostToken(data, source, settings.host) };
}

module.exports = {
  parseRedmineProjectUrl,
  parseGitlabProjectUrl,
  parseProjectUrl,
  readCredentials,
  writeCredentials,
  getSettings,
  getAllSettingsForWorkspace,
  saveSettings,
  getHostStatus,
  resolveConnection,
};
