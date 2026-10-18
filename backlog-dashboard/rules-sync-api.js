'use strict';

// BT-439: エージェント運用ルール(AGENTS.md.sample)の配布先への同期状況の確認・同期API。
// its-settings-api.jsと同じ切り出し方針(スクリプトの実行は呼び出し元から注入し、テストで差し替えられる)。
//   GET  /api/rules-status  scripts/install-agent-rules.ps1 -Check の結果(読み取りのみ)
//   POST /api/rules-sync    要同期の時だけ scripts/install-agent-rules.ps1 を実行(既に最新なら何もしない)
// 同期スクリプトは実行のたびに配置先へ.bakを作るため、最新の時は実行しない(利用者のホーム配下にゴミを増やさない)。

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const AGENTS = [
  { key: 'claude', name: 'Claude Code' },
  { key: 'codex', name: 'Codex' },
  { key: 'kiro', name: 'Kiro' },
];
const SCRIPT_TIMEOUT_MS = 120 * 1000;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * 既定のスクリプト実行。終了コードが非0でも reject せず {code, stdout, stderr} を返す
 * (-Check は要同期の時に終了コード1を返す仕様のため)。起動自体の失敗は error を付けて返す。
 */
function runInstallScript(repoRoot, args) {
  const scriptPath = path.join(repoRoot, 'scripts', 'install-agent-rules.ps1');
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { cwd: repoRoot, timeout: SCRIPT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') resolve({ code: null, stdout: stdout || '', stderr: stderr || '', error: error.message });
        else resolve({ code: error ? error.code : 0, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

/**
 * -Check の出力(英語固定)をエージェント別・配布物別の判定にする。
 * 例: "Claude Code rules are current." / "Kiro rules need synchronization." /
 *     "Rule distribution is current: <path>" / "Rule distribution needs synchronization: <path>"
 */
function parseCheckOutput(stdout) {
  const agents = [];
  const distribution = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    const a = /^(Claude Code|Codex|Kiro) rules (are current|need synchronization)\.?$/.exec(line);
    if (a) {
      const def = AGENTS.find(x => x.name === a[1]);
      agents.push({ key: def.key, name: def.name, current: a[2] === 'are current' });
      continue;
    }
    const d = /^Rule distribution (is current|needs synchronization): (.+)$/.exec(line);
    if (d) distribution.push({ file: d[2], current: d[1] === 'is current' });
  }
  return { agents, distribution };
}

// 失敗時にユーザーへ見せる一言。PowerShellのエラーは末尾が装飾(+ ~~~~ / CategoryInfo)になるため、最初の意味のある行を使う。
function failureDetail(result) {
  const pick = text => String(text || '').split(/\r?\n/).map(l => l.trim()).find(l => l && !/^[+~\s]+$/.test(l) && !/^At .* char:\d+/.test(l));
  const line = pick(result.stderr) || pick(result.stdout) || '';
  return line.replace(/^powershell\.exe\s*:\s*/i, '').slice(0, 200);
}

function readRulesVersion(repoRoot) {
  try {
    const head = fs.readFileSync(path.join(repoRoot, 'AGENTS.md.sample'), 'utf8').slice(0, 2000);
    const m = /対応API version:\s*([0-9][0-9.]*)/.exec(head);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * @param {{repoRoot: string, apiVersion: string, run?: (args: string[]) => Promise<{code: number|null, stdout: string, stderr: string, error?: string}>}} deps
 * @returns {(req, res) => boolean} 処理した場合true
 */
function createRulesApi({ repoRoot, apiVersion, run = args => runInstallScript(repoRoot, args) }) {
  let syncing = false;

  async function checkStatus() {
    const result = await run(['-Check']);
    const { agents, distribution } = parseCheckOutput(result.stdout);
    // 判定行が1つも読めない = スクリプトが動かなかった(終了コード1だけでは要同期と区別できない)
    if (result.error || agents.length === 0) {
      return { error: 'check_failed', message: result.error || failureDetail(result) || '判定結果を読み取れませんでした' };
    }
    const rulesVersion = readRulesVersion(repoRoot);
    return {
      ok: true,
      agents,
      distribution,
      needsSync: agents.some(a => !a.current) || distribution.some(d => !d.current),
      rulesVersion,
      apiVersion,
      versionMismatch: rulesVersion !== null && rulesVersion !== apiVersion,
      checkedAt: new Date().toISOString(),
    };
  }

  return function handle(req, res) {
    const pathname = (req.url || '').split('?')[0];

    if (pathname === '/api/rules-status' && req.method === 'GET') {
      checkStatus().then(status => sendJson(res, status.error ? 500 : 200, status))
        .catch(e => sendJson(res, 500, { error: 'check_failed', message: e.message }));
      return true;
    }

    if (pathname === '/api/rules-sync' && req.method === 'POST') {
      if (syncing) {
        sendJson(res, 409, { error: 'rules_sync_in_progress' });
        return true;
      }
      syncing = true;
      (async () => {
        const before = await checkStatus();
        if (before.error) return { status: 500, body: before };
        if (!before.needsSync) return { status: 200, body: { ...before, changed: false } };
        const result = await run([]);
        if (result.error || result.code !== 0) {
          const detail = result.error || failureDetail(result);
          return { status: 500, body: { error: 'sync_failed', message: detail || `終了コード ${result.code}` } };
        }
        const after = await checkStatus();
        return after.error ? { status: 500, body: after } : { status: 200, body: { ...after, changed: true } };
      })().catch(e => ({ status: 500, body: { error: 'sync_failed', message: e.message } }))
        .then(({ status, body }) => {
          syncing = false; // 応答より先に下ろす(失敗直後の再実行が409にならないように)
          sendJson(res, status, body);
        });
      return true;
    }

    return false;
  };
}

module.exports = { createRulesApi, parseCheckOutput, readRulesVersion };
