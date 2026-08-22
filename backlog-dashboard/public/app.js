'use strict';

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const projectFilterEl = document.getElementById('project-filter');
const searchBtn = document.getElementById('search-btn');
const themeSelectEl = document.getElementById('theme-select');
const githubImportBtn = document.getElementById('github-import-btn');
const headerLogoEl = document.getElementById('header-logo');
const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const settingsThemeEl = document.getElementById('settings-theme');
const settingsAccentEl = document.getElementById('settings-accent');
const settingsGithubProjectEl = document.getElementById('settings-github-project');
const settingsGithubRepoUrlEl = document.getElementById('settings-github-repo-url');
const settingsGithubTokenEl = document.getElementById('settings-github-token');
const settingsGithubStatusEl = document.getElementById('settings-github-status');
const settingsGithubSaveEl = document.getElementById('settings-github-save');
const settingsGithubHintEl = document.getElementById('settings-github-hint');

// --- State ---
let currentBoardData = null;
let currentFilter = ''; // '' = all projects
let todayFilterActive = localStorage.getItem('todayFilterActive') === 'true';
let doneTodayOnly = localStorage.getItem('doneTodayOnly') === 'true'; // 完了カラム「本日完了だけ」表示（達成感モード）
let modalParentEpic = null; // 子タスク詳細表示中の親Epic（戻る用）
let expandedCols = new Set(); // 完了カラム等で「他N件」を展開表示中のカラムID
let expandedMiniCols = new Set(); // ミニボードの完了カラムで「他N件」展開中のカラムID
let workspaceFilterMap = null; // サーバーから取得: { workspaceKey -> projectName }
let wsDefaultFilter = ''; // URLパラメータから決まるデフォルトフィルタ（プロジェクト名）

// --- 複数選択→親付け (BT-034) ---
let selectionMode = false;
let selectedIds = new Set(); // 選択中のタスクID
let parentPickerProject = ''; // 親ピッカー表示中に対象とするプロジェクト名
let pendingAttachIds = []; // 親ピッカーで実際にアタッチ対象となっているID一覧（複数選択 or 単独タスク詳細からの単発指定）

// --- Workspace Filter: sessionStorage + URLパラメータ ハイブリッド ---
// 優先順位: sessionStorage(ユーザー操作記憶) > URLパラメータ(ワークスペースのデフォルト) > All
const WS_FILTER_KEY = 'backlog-ws-filter'; // sessionStorage key

function getUrlWorkspaceParam() {
  const params = new URLSearchParams(window.location.search);
  return params.get('workspace') || '';
}

function getSessionFilter() {
  return sessionStorage.getItem(WS_FILTER_KEY);
}

function setSessionFilter(projectName) {
  sessionStorage.setItem(WS_FILTER_KEY, projectName);
}

/**
 * フィルタの初期値を決定する
 * - sessionStorageに値があればそれを使う（ユーザーが手動で選んだ記憶）
 * - なければ URLパラメータ → workspaceFilterMap で変換
 * - どちらもなければ '' (All Projects)
 */
function resolveInitialFilter() {
  const stored = getSessionFilter();
  if (stored !== null) return stored; // '' (All) も含めて記憶を尊重
  // sessionStorage未設定 → URLパラメータから初期値を決定
  return wsDefaultFilter;
}

/**
 * URLパラメータからデフォルトフィルタを解決する（workspaceFilterMapが必要）
 */
function resolveWsDefault(filterMap) {
  const wsParam = getUrlWorkspaceParam();
  if (!wsParam || !filterMap) return '';
  const key = wsParam.toLowerCase();
  return filterMap[key] || '';
}

// --- Settings (persisted to localStorage) ---
function loadSettings() {
  try {
    const raw = localStorage.getItem('backlog-dashboard-settings');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSettings(settings) {
  localStorage.setItem('backlog-dashboard-settings', JSON.stringify(settings));
}

function applySettings() {
  const settings = loadSettings();
  const theme = settings.theme || 'dark';
  const accent = settings.accent || '#7c8fff';

  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.setProperty('--accent', accent);

  themeSelectEl.value = theme;
  settingsThemeEl.value = theme;
  settingsAccentEl.value = accent;
}

// --- Theme & Settings UI ---
themeSelectEl.addEventListener('change', () => {
  const settings = loadSettings();
  settings.theme = themeSelectEl.value;
  saveSettings(settings);
  applySettings();
});

settingsBtn.addEventListener('click', () => {
  settingsOverlay.classList.add('settings-visible');
  populateGithubProjectSelect();
  loadGithubSettingsForSelectedProject();
});

settingsClose.addEventListener('click', () => {
  settingsOverlay.classList.remove('settings-visible');
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('settings-visible');
});

settingsThemeEl.addEventListener('change', () => {
  const settings = loadSettings();
  settings.theme = settingsThemeEl.value;
  saveSettings(settings);
  applySettings();
});

settingsAccentEl.addEventListener('input', () => {
  const settings = loadSettings();
  settings.accent = settingsAccentEl.value;
  saveSettings(settings);
  applySettings();
});

// --- GitHub連携設定 (BT-077) ---
// Inbox等、実ワークスペース(workspace)を持たない架空プロジェクトはGitHub連携の対象外
function populateGithubProjectSelect() {
  const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
  const workspaceMap = (currentBoardData && currentBoardData.workspaceMap) || {};
  const names = Object.keys(prefixMap).filter(name => workspaceMap[name]).sort();
  const prevValue = settingsGithubProjectEl.value;
  settingsGithubProjectEl.innerHTML = names.map(name => `<option value="${prefixMap[name]}">${name} (${prefixMap[name]})</option>`).join('');
  if (names.some(name => prefixMap[name] === prevValue)) settingsGithubProjectEl.value = prevValue;
}

async function loadGithubSettingsForSelectedProject() {
  const prefix = settingsGithubProjectEl.value;
  settingsGithubTokenEl.value = '';
  if (!prefix) {
    settingsGithubRepoUrlEl.value = '';
    settingsGithubStatusEl.textContent = '';
    settingsGithubTokenEl.placeholder = 'トークンを入力（未入力なら既存を保持）';
    settingsGithubHintEl.style.display = 'none';
    return;
  }
  try {
    const res = await fetch(`/api/github-settings?prefix=${encodeURIComponent(prefix)}`);
    const data = await res.json();
    settingsGithubRepoUrlEl.value = data.repoUrl || '';
    settingsGithubStatusEl.textContent = data.hasToken ? '✅ トークン設定済み' : '未設定';
    // トークン自体の値は表示せず、設定済みかどうかをplaceholderのマスク表示で示す
    settingsGithubTokenEl.placeholder = data.hasToken
      ? '●●●●●●●●●●●●（設定済み・変更する場合のみ入力）'
      : 'トークンを入力（未入力なら既存を保持）';
    settingsGithubHintEl.style.display = data.hasToken ? 'none' : 'block';
  } catch (e) {
    settingsGithubStatusEl.textContent = '取得エラー';
  }
}

settingsGithubProjectEl.addEventListener('change', loadGithubSettingsForSelectedProject);

settingsGithubSaveEl.addEventListener('click', async () => {
  const prefix = settingsGithubProjectEl.value;
  if (!prefix) return;
  const body = { prefix, repoUrl: settingsGithubRepoUrlEl.value.trim() };
  if (settingsGithubTokenEl.value) body.token = settingsGithubTokenEl.value;
  settingsGithubStatusEl.textContent = '保存中...';
  try {
    const res = await fetch('/api/github-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存に失敗しました');
    await loadGithubSettingsForSelectedProject();
    settingsOverlay.classList.remove('settings-visible');
  } catch (e) {
    settingsGithubStatusEl.textContent = `エラー: ${e.message}`;
  }
});

// --- GitHub Issues取り込みダイアログ (BT-106) ---
function populateGithubImportProjectSelect(selectEl) {
  const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
  const workspaceMap = (currentBoardData && currentBoardData.workspaceMap) || {};
  const names = Object.keys(prefixMap).filter(name => workspaceMap[name]).sort();
  const prevValue = selectEl.value;
  selectEl.innerHTML = `<option value="">プロジェクトを選択...</option>` +
    names.map(name => `<option value="${prefixMap[name]}">${name} (${prefixMap[name]})</option>`).join('');
  if (names.some(name => prefixMap[name] === prevValue)) selectEl.value = prevValue;
}

let githubImportEl = null;
let githubImportSelectedNumbers = new Set(); // BT-109: 選択中のissue番号(文字列)
let githubImportAllIssues = []; // BT-130: フィルタ切り替え時に再取得しないためのキャッシュ

function getOrCreateGithubImportModal() {
  if (githubImportEl) return githubImportEl;
  githubImportEl = document.createElement('div');
  githubImportEl.id = 'github-import-overlay';
  githubImportEl.className = 'modal-overlay';
  githubImportEl.innerHTML = `
    <div class="modal-content modal-wide github-import-modal">
      <button class="modal-close" id="github-import-close">&times;</button>
      <h3>🔗 GitHub Issues取り込み</h3>
      <div class="github-import-toolbar">
        <select id="github-import-project"></select>
        <span class="github-import-total-count" id="github-import-total-count"></span>
        <label class="github-import-filter"><input type="checkbox" id="github-import-filter-closed" checked><span id="github-import-filter-closed-label">closedを隠す</span></label>
        <label class="github-import-filter"><input type="checkbox" id="github-import-filter-imported" checked><span id="github-import-filter-imported-label">取込済みを隠す</span></label>
        <button id="github-import-settings-btn" title="GitHub連携設定">⚙️ GitHub設定</button>
      </div>
      <div class="github-import-body" id="github-import-body">
        <p class="github-import-placeholder">プロジェクトを選択してください。</p>
      </div>
      <div class="github-import-footer">
        <span id="github-import-selected-count">0件選択中</span>
        <button id="github-import-execute-btn" disabled>選択した0件を取り込む</button>
      </div>
    </div>
  `;
  document.body.appendChild(githubImportEl);
  githubImportEl.addEventListener('click', (e) => {
    if (e.target === githubImportEl) closeGithubImportModal();
  });
  githubImportEl.querySelector('#github-import-close').addEventListener('click', closeGithubImportModal);
  githubImportEl.querySelector('#github-import-settings-btn').addEventListener('click', () => {
    settingsOverlay.classList.add('settings-visible');
    populateGithubProjectSelect();
    loadGithubSettingsForSelectedProject();
  });
  githubImportEl.querySelector('#github-import-project').addEventListener('change', loadGithubImportPreview);
  githubImportEl.querySelector('#github-import-filter-closed').addEventListener('change', renderGithubImportIssueList);
  githubImportEl.querySelector('#github-import-filter-imported').addEventListener('change', renderGithubImportIssueList);
  githubImportEl.querySelector('#github-import-body').addEventListener('change', (e) => {
    if (e.target.classList.contains('github-issue-checkbox')) updateGithubImportSelection();
  });
  githubImportEl.querySelector('#github-import-execute-btn').addEventListener('click', executeGithubImport);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && githubImportEl.classList.contains('modal-visible')) closeGithubImportModal();
  });
  return githubImportEl;
}

function closeGithubImportModal() {
  if (githubImportEl) githubImportEl.classList.remove('modal-visible');
}

// BT-107: プロジェクト選択に応じてGitHub Issue一覧(プレビュー、md書き込みなし)を取得・表示
async function loadGithubImportPreview() {
  const el = githubImportEl;
  const prefix = el.querySelector('#github-import-project').value;
  const bodyEl = el.querySelector('#github-import-body');
  resetGithubImportSelectionUi();
  resetGithubImportFilterCounts();
  githubImportAllIssues = [];
  if (!prefix) {
    bodyEl.innerHTML = `<p class="github-import-placeholder">プロジェクトを選択してください。</p>`;
    return;
  }
  bodyEl.innerHTML = `<p class="github-import-placeholder">読み込み中...</p>`;
  try {
    const res = await fetch(`/api/github-preview-issues?prefix=${encodeURIComponent(prefix)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '取得に失敗しました');
    githubImportAllIssues = data.issues;
    renderGithubImportIssueList();
  } catch (e) {
    githubImportAllIssues = [];
    bodyEl.innerHTML = `<p class="github-import-placeholder">エラー: ${escapeHtml(e.message)}</p>`;
  }
}

// BT-130: 現在のフィルタ設定(closed非表示/取込済み非表示)に応じてトップレベルIssue一覧を絞り込んで再描画する
// BT-131: あわせてチェックボックスへの該当件数表示・全体件数表示も更新する
function renderGithubImportIssueList() {
  const el = githubImportEl;
  const bodyEl = el.querySelector('#github-import-body');
  if (githubImportAllIssues.length === 0) {
    bodyEl.innerHTML = `<p class="github-import-placeholder">Issueが見つかりませんでした。</p>`;
    resetGithubImportFilterCounts();
    return;
  }
  const hideClosed = el.querySelector('#github-import-filter-closed').checked;
  const hideImported = el.querySelector('#github-import-filter-imported').checked;
  // BT-108: 他issueのtask listに子として現れるissueはトップレベル一覧から除外し、親の下に入れ子表示する
  const issueByNumber = new Map(githubImportAllIssues.map((i) => [i.number, i]));
  const allChildNumbers = new Set();
  for (const i of githubImportAllIssues) {
    for (const childNum of (i.childIssueNumbers || [])) allChildNumbers.add(childNum);
  }
  const topLevelAllIssues = githubImportAllIssues.filter((i) => !allChildNumbers.has(i.number));
  const closedCount = topLevelAllIssues.filter((i) => i.state === 'closed').length;
  const importedCount = topLevelAllIssues.filter((i) => i.alreadyImported).length;
  el.querySelector('#github-import-filter-closed-label').textContent = `closedを隠す (${closedCount})`;
  el.querySelector('#github-import-filter-imported-label').textContent = `取込済みを隠す (${importedCount})`;
  const topLevelIssues = topLevelAllIssues
    .filter((i) => !(hideClosed && i.state === 'closed'))
    .filter((i) => !(hideImported && i.alreadyImported));
  el.querySelector('#github-import-total-count').textContent = `${topLevelIssues.length} / 全${topLevelAllIssues.length}件`;
  bodyEl.innerHTML = topLevelIssues.length > 0
    ? topLevelIssues.map((issue) => renderGithubImportIssueCard(issue, issueByNumber)).join('')
    : `<p class="github-import-placeholder">条件に一致するIssueがありません。</p>`;
}

// BT-131: プロジェクト未選択/Issue0件のとき、フィルタ件数・全体件数の表示を空へ戻す
function resetGithubImportFilterCounts() {
  const el = githubImportEl;
  el.querySelector('#github-import-filter-closed-label').textContent = 'closedを隠す';
  el.querySelector('#github-import-filter-imported-label').textContent = '取込済みを隠す';
  el.querySelector('#github-import-total-count').textContent = '';
}

// BT-109: 選択状態をSet・フッター表示ともに0件へ戻す(DOMの再読み込みに依存しない)
function resetGithubImportSelectionUi() {
  githubImportSelectedNumbers.clear();
  const el = githubImportEl;
  el.querySelector('#github-import-selected-count').textContent = '0件選択中';
  const btnEl = el.querySelector('#github-import-execute-btn');
  btnEl.textContent = '選択した0件を取り込む';
  btnEl.disabled = true;
}

// BT-109: チェックボックスの選択状態を集計し、フッターの件数・実行ボタンに反映
function updateGithubImportSelection() {
  const el = githubImportEl;
  const countEl = el.querySelector('#github-import-selected-count');
  const btnEl = el.querySelector('#github-import-execute-btn');
  const checked = el.querySelectorAll('.github-issue-checkbox:checked');
  githubImportSelectedNumbers = new Set(Array.from(checked).map(cb => cb.dataset.issueNumber));
  const count = githubImportSelectedNumbers.size;
  countEl.textContent = `${count}件選択中`;
  btnEl.textContent = `選択した${count}件を取り込む`;
  btnEl.disabled = count === 0;
}

// BT-109: 選択したissueだけをmdへ取り込む(既存fetch APIをissueNumbers指定で選択実行)
async function executeGithubImport() {
  const el = githubImportEl;
  const prefix = el.querySelector('#github-import-project').value;
  const btnEl = el.querySelector('#github-import-execute-btn');
  const issueNumbers = Array.from(githubImportSelectedNumbers);
  if (!prefix || issueNumbers.length === 0) return;
  btnEl.disabled = true;
  btnEl.textContent = '取り込み中...';
  try {
    const res = await fetch('/api/github-fetch-issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, issueNumbers }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '取り込みに失敗しました');
    await loadGithubImportPreview();
  } catch (e) {
    const countEl = el.querySelector('#github-import-selected-count');
    countEl.textContent = `エラー: ${e.message}`;
    updateGithubImportSelection();
  }
}

// Octicons "mark-github"（GitHub公式アイコンライブラリ、MITライセンス）
const GITHUB_MARK_SVG = '<svg class="github-mark-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.1-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.47-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path></svg>';

// BT-110: 取り込み済みタスクカードにGitHubアイコン+Issue番号を表示(クリックでIssueページを新規タブで開く)
function renderGithubIssueBadge(issueNumber, issueUrl) {
  const href = issueUrl ? escapeHtml(issueUrl) : '#';
  return `<a class="card-tag github-issue-badge" href="${href}" target="_blank" rel="noopener noreferrer" title="GitHub Issue #${escapeHtml(String(issueNumber))}">${GITHUB_MARK_SVG}#${escapeHtml(String(issueNumber))}</a>`;
}

// BT-127: 取込済みissueには、backlog内のタスクIDも併記する
function renderGithubImportedTag(taskId) {
  const idSuffix = taskId ? ` (${escapeHtml(taskId)})` : '';
  return `<span class="card-tag github-issue-imported">取込済み${idSuffix}</span>`;
}

// BT-108: task listで子issueを持つ親(Epic)は、選択チェックボックス+配下の子issueを入れ子表示する。
// 子issueは単独で選択できない(親を取り込むと一括で追従する、[[project_bt071_github_issue_sync_design]]の方針)
function renderGithubImportIssueCard(issue, issueByNumber) {
  const stateTag = issue.state === 'closed' ? '<span class="card-tag github-issue-closed">closed</span>' : '';
  const importedTag = issue.alreadyImported ? renderGithubImportedTag(issue.importedTaskId) : '';
  const checkboxHtml = issue.alreadyImported
    ? `<input type="checkbox" class="github-issue-checkbox" disabled title="取込済み">`
    : `<input type="checkbox" class="github-issue-checkbox" data-issue-number="${issue.number}">`;

  const children = (issue.childIssueNumbers || [])
    .map((num) => issueByNumber && issueByNumber.get(num))
    .filter(Boolean);
  const badgeHtml = children.length > 0
    ? (() => {
        const closedCount = children.filter((c) => c.state === 'closed').length;
        const allDone = closedCount === children.length;
        return `<span class="card-badge${allDone ? ' badge-done' : ''}"><span class="badge-num">${closedCount}</span><span class="badge-den">/${children.length}</span></span>`;
      })()
    : '';
  const childrenHtml = children.length > 0
    ? `<div class="github-issue-children">${children.map(renderGithubImportChildCard).join('')}</div>`
    : '';

  return `
    <div class="card github-issue-card${children.length > 0 ? ' github-issue-epic' : ''}">
      ${checkboxHtml}
      <div class="github-issue-card-body">
        <div class="card-id"><span>#${issue.number}</span>${badgeHtml}</div>
        <div class="card-title">${GITHUB_MARK_SVG}${escapeHtml(issue.title)}</div>
        <div class="card-meta">${stateTag}${importedTag}</div>
      </div>
    </div>
    ${childrenHtml}
  `;
}

function renderGithubImportChildCard(issue) {
  const stateTag = issue.state === 'closed' ? '<span class="card-tag github-issue-closed">closed</span>' : '';
  const importedTag = issue.alreadyImported ? renderGithubImportedTag(issue.importedTaskId) : '';
  return `
    <div class="card github-issue-card github-issue-child-card">
      <div class="github-issue-card-body">
        <div class="card-id"><span>#${issue.number}</span></div>
        <div class="card-title">${GITHUB_MARK_SVG}${escapeHtml(issue.title)}</div>
        <div class="card-meta">${stateTag}${importedTag}</div>
      </div>
    </div>
  `;
}

function openGithubImportModal() {
  const el = getOrCreateGithubImportModal();
  populateGithubImportProjectSelect(el.querySelector('#github-import-project'));
  el.classList.add('modal-visible');
}

githubImportBtn.addEventListener('click', openGithubImportModal);

// --- Header Logo: このダッシュボードアプリ自体のGitHubリポジトリを別タブで開く (BT-162) ---
// リポジトリURLはユーザーごとのgithub-credentials.json（Issue連携先）とは無関係に、
// サーバー側でclone元の`git remote origin`から解決した値を使う（誰の環境でも同じリンクになる）
headerLogoEl.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/repo-origin-url');
    const data = await res.json();
    if (data.repoUrl) {
      window.open(data.repoUrl, '_blank', 'noopener');
    }
  } catch (e) {
    console.error('[header-logo] Failed to open GitHub repo:', e.message);
  }
});

// --- Project Filter ---
projectFilterEl.addEventListener('change', () => {
  currentFilter = projectFilterEl.value;
  setSessionFilter(currentFilter); // ユーザー操作を記憶
  if (currentBoardData) renderBoard(currentBoardData);
});

// ワークスペースバッジクリック → フィルタ連携（トグル対応）
const projectBadgesEl = document.getElementById('project-badges');
if (projectBadgesEl) {
  projectBadgesEl.addEventListener('click', (e) => {
    const badge = e.target.closest('.proj-badge');
    if (!badge) return;
    const proj = badge.dataset.project;
    currentFilter = (currentFilter === proj) ? '' : proj; // 同じバッジ再クリックで解除
    projectFilterEl.value = currentFilter;
    setSessionFilter(currentFilter);
    if (currentBoardData) renderBoard(currentBoardData);
  });
}

// --- Search Modal ---
searchBtn.addEventListener('click', openSearchModal);

// ショートカット: "/" または Ctrl+K（Mac: Cmd+K）で検索ダイアログを開く
document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const isTyping = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  if (e.key === '/' && !isTyping) {
    e.preventDefault();
    openSearchModal();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearchModal();
  }
});

// --- Today Filter ---
const todayFilterBtn = document.getElementById('today-filter-btn');
if (todayFilterActive) todayFilterBtn.classList.add('filter-active');
todayFilterBtn.addEventListener('click', () => {
  todayFilterActive = !todayFilterActive;
  localStorage.setItem('todayFilterActive', todayFilterActive);
  todayFilterBtn.classList.toggle('filter-active', todayFilterActive);
  if (currentBoardData) renderBoard(currentBoardData);
});

// --- Selection Mode Toggle ---
const selectModeBtn = document.getElementById('select-mode-btn');
selectModeBtn.addEventListener('click', () => {
  selectionMode = !selectionMode;
  selectModeBtn.classList.toggle('filter-active', selectionMode);
  if (!selectionMode) selectedIds.clear();
  if (currentBoardData) renderBoard(currentBoardData);
});

function updateProjectFilter(projects) {
  const current = currentFilter; // currentFilter を使う（sessionStorage/URL由来の値を反映）
  projectFilterEl.innerHTML = '<option value="">All Projects</option>';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    projectFilterEl.appendChild(opt);
  }
  projectFilterEl.value = current;
}

// --- WebSocket ---
let ws;
let reconnectTimer;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    setStatus('connected', 'live');
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      currentBoardData = data;

      // workspaceFilterMap を初回受信時に解決
      if (data.workspaceFilterMap && !workspaceFilterMap) {
        workspaceFilterMap = data.workspaceFilterMap;
        wsDefaultFilter = resolveWsDefault(workspaceFilterMap);
        // 初期フィルタを適用（sessionStorage優先）
        currentFilter = resolveInitialFilter();
      }

      if (data.projects) updateProjectFilter(data.projects);
      renderBoard(currentBoardData);
      refreshModalIfOpen();
    } catch (e) {
      console.error('[app] Failed to parse message:', e);
    }
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected', 'reconnecting...');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    connect();
  }, 3000);
}

function setStatus(cls, text) {
  statusEl.className = `status ${cls}`;
  statusEl.textContent = text;
}

// --- 進行中タスク表示（ステータスバー / BT-059） ---
function collectRunningTasks(data) {
  const result = [];
  const seen = new Set();
  if (!data || !data.columns) return result;
  for (const col of data.columns) {
    for (const item of col.items) {
      if (item.running && !seen.has(item.id)) {
        seen.add(item.id);
        result.push({ item, parentEpic: null });
      }
      for (const child of (item.children || [])) {
        if (child.running && !seen.has(child.id)) {
          seen.add(child.id);
          result.push({ item: child, parentEpic: item });
        }
      }
    }
  }
  return result;
}

function renderRunningStrip(data) {
  const el = document.getElementById('running-strip-chips');
  const iconEl = document.getElementById('running-strip-icon');
  if (!el) return;
  const running = collectRunningTasks(data);
  if (iconEl) iconEl.classList.toggle('spinning', running.length > 0);
  if (!running.length) {
    el.innerHTML = '<span class="running-strip-empty">🟡 進行中のタスクはなし</span>';
    return;
  }
  el.innerHTML = running.map(({ item }, idx) => `
    <span class="running-chip" data-idx="${idx}" title="${escapeHtml(item.title)}">
      <span class="running-spinner"></span>
      <span class="running-chip-id">${escapeHtml(item.id)}</span>
      <span class="running-chip-title">${escapeHtml(item.title)}</span>
    </span>
  `).join('');
  el.querySelectorAll('.running-chip').forEach((chipEl) => {
    const idx = parseInt(chipEl.dataset.idx, 10);
    chipEl.addEventListener('click', () => {
      const { item, parentEpic } = running[idx];
      openCardDetail(item, parentEpic);
    });
  });
}

// --- Render: Board ---
let lastBoardData = null;
function renderBoard(data) {
  lastBoardData = data;
  boardEl.innerHTML = '';
  renderRunningStrip(data);

  // プロジェクト別残タスクバッジ表示（クリックでフィルタ連携）
  const badgesEl = document.getElementById('project-badges');
  if (badgesEl && data.remainingByProject) {
    const entries = Object.entries(data.remainingByProject)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    badgesEl.innerHTML = entries.map(([proj, count]) => {
      const isActive = currentFilter === proj;
      const isDimmed = !!currentFilter && !isActive;
      const cls = ['proj-badge', isActive ? 'active' : '', isDimmed ? 'dimmed' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" data-project="${escapeHtml(proj)}">${proj}<span class="proj-badge-count">${count}</span></span>`;
    }).join('');
  }

  for (const col of data.columns) {
    const fields = col.visibleFields || ['id', 'title', 'badge', 'project', 'category', 'completedDate'];
    const isCompact = col.compact || false;

    // フィルタ適用
    let items = col.items;
    if (currentFilter) {
      items = items.filter(item => item.project === currentFilter);
    }
    if (todayFilterActive) {
      items = items.filter(item => item.todayFlag || item.todayCount > 0);
    }
    // 完了カラム「本日完了だけ」表示（達成感モード）: completedDateが今日(JST)のものだけ
    const doneTodayActive = isCompact && doneTodayOnly;
    if (doneTodayActive) {
      const todayStr = getTodayJST();
      items = items.filter(item => item.completedDate === todayStr);
    }

    // limit 制御（フロント側で表示件数を制御）
    const defaultLimit = col.limit || null;
    const limitKey = 'colLimit_' + col.id;
    const currentLimit = defaultLimit ? parseInt(localStorage.getItem(limitKey) || defaultLimit, 10) : null;
    const totalBeforeLimit = items.length;
    // 完了カラム（compact）は超過分を「他N件」まとめカードで畳む。展開中は全件表示。
    // 「本日完了だけ」表示中はlimitを無視して全件出す（達成の可視化が目的）。
    const isExpanded = expandedCols.has(col.id);
    let hiddenCount = 0;
    if (currentLimit && totalBeforeLimit > currentLimit && !(isCompact && isExpanded) && !doneTodayActive) {
      hiddenCount = totalBeforeLimit - currentLimit;
      items = items.slice(0, currentLimit);
    }

    const colEl = document.createElement('div');
    colEl.className = 'column' + (isCompact ? ' column-compact' : '');

    // 完了カラム用「本日完了だけ」トグルチップ
    const doneTodayToggleHtml = isCompact
      ? `<button class="done-today-btn${doneTodayOnly ? ' filter-active' : ''}" data-col-id="${col.id}" title="本日完了分のみ表示（達成感モード）">🎉 今日</button>`
      : '';

    // カウント/limit表示エリア
    let countAreaHtml;
    if (doneTodayActive) {
      // 本日完了だけ表示中: 達成感カウント（limit入力は隠す）
      countAreaHtml = `<span class="count done-today-count">🎉 ${items.length}</span>`;
    } else if (currentLimit) {
      countAreaHtml = `<input type="number" class="limit-input" value="${currentLimit}" min="1" max="${totalBeforeLimit}" data-col-id="${col.id}" title="表示件数 (全${totalBeforeLimit}件)">
               <span class="count-total">/ ${totalBeforeLimit}</span>`;
    } else {
      countAreaHtml = `<span class="count">${items.length}</span>`;
    }

    colEl.innerHTML = `
      <div class="column-header">
        <span>${col.label}</span>
        <div class="column-header-right">
          ${doneTodayToggleHtml}
          ${countAreaHtml}
          ${!isCompact ? `<button class="add-task-btn" data-col-id="${col.id}" data-col-status="${col.match[0]}" title="タスク追加">+</button>` : ''}
        </div>
      </div>
      <div class="column-body"></div>
    `;

    const body = colEl.querySelector('.column-body');
    setupDropZone(body, col.id, col.match, false, null);

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'card' + (isCompact ? ' card-compact' : '');
      const isEpic = item.childrenTotal > 0;
      if (isEpic) card.classList.add('card-epic');
      card.dataset.project = item.project;

      if (item.id && item.id !== '-') {
        card.dataset.taskId = item.id;
        setupDragAndDrop(card, item, col.id, false);
      }

      card.classList.add('card-clickable');
      setupCardClick(card, item);

      // 今日やるフラグ（Epic: 子の集約、単発: 自身のフラグ）
      const hasTodayFlag = isEpic ? (item.todayCount > 0) : item.todayFlag;
      if (hasTodayFlag) card.classList.add('card-today');

      // KT-054: 実行中カードの強調（カード全体グロー点滅、B案）
      if (item.running) card.classList.add('is-running');

      // 選択モード（BT-034）: Epic/完了カードは選択不可、それ以外は選択状態を反映
      if (selectionMode && item.id && item.id !== '-') {
        if (isEpic || isCompact) {
          card.classList.add('card-select-disabled');
        } else if (selectedIds.has(item.id)) {
          card.classList.add('card-selected');
        }
      }

      const showField = (name) => fields.includes(name);

      const id = (showField('id') && item.id && item.id !== '-') ? item.id : '';
      const completedDate = (showField('completedDate') && item.completedDate) ? `<span class="card-tag">${item.completedDate}</span>` : '';
      const category = (showField('category') && item.category && item.category !== '-') ? `<span class="card-tag category">${item.category}</span>` : '';

      // GitHub風ピルバッジ
      let badge = '';
      if (showField('badge') && item.childrenTotal) {
        const allDone = item.childrenDone === item.childrenTotal;
        const badgeClass = allDone ? 'badge-done' : '';
        badge = `<span class="card-badge ${badgeClass}"><span class="badge-num">${item.childrenDone}</span><span class="badge-den">/${item.childrenTotal}</span></span>`;
      }

      // 起源マーク
      const originIcon = item.origin === 'claude' ? '<span class="origin-mark" title="Claude">🤖</span>'
        : item.origin === 'user' ? '<span class="origin-mark" title="User">👤</span>' : '';

      // 実行中スピナー
      const spinnerHtml = item.running ? '<span class="running-spinner"></span>' : '';

      // Epicハブアイコン（子タスクを束ねる親タスクの目印）
      const epicIcon = isEpic ? '<span class="epic-icon" title="親タスク（子タスクを束ねるEpic）">⧉</span>' : '';

      const idHtml = id ? `<div class="card-id">${spinnerHtml}${epicIcon}<span>${id}</span>${badge}${originIcon}</div>` : (badge || originIcon || epicIcon ? `<div class="card-id">${spinnerHtml}${epicIcon}${badge}${originIcon}</div>` : '');
      const titleHtml = showField('title') ? `<div class="card-title">${escapeHtml(item.title)}</div>` : '';
      const projectTag = showField('project') ? `<span class="card-tag project">${escapeHtml(item.project)}</span>` : '';
      const artifactIndicator = (item.artifacts && item.artifacts.length > 0) ? '<span class="card-tag artifact-indicator" title="成果物あり">📎</span>' : '';
      const githubBadge = item.githubIssueNumber ? renderGithubIssueBadge(item.githubIssueNumber, item.githubIssueUrl) : '';
      const metaParts = [projectTag, category, artifactIndicator, githubBadge, completedDate].filter(Boolean);
      const metaHtml = metaParts.length > 0 ? `<div class="card-meta">${metaParts.join('')}</div>` : '';

      // 📌 ピンボタン（完了カラムには不要）
      let pinHtml = '';
      if (!isCompact && item.id && item.id !== '-') {
        if (isEpic) {
          // Epic: 子の集約表示。📌n（一括操作ボタン）
          const pinActive = item.todayCount > 0;
          const pinLabel = pinActive ? `📌${item.todayCount}` : '📌';
          pinHtml = `<button class="today-pin-btn${pinActive ? ' pin-active' : ''}" data-task-id="${item.id}" data-is-child="false" title="今日やる（一括）">${pinLabel}</button>`;
        } else {
          // 単発タスク: 通常トグル
          pinHtml = `<button class="today-pin-btn${item.todayFlag ? ' pin-active' : ''}" data-task-id="${item.id}" data-is-child="false" title="今日やる">📌</button>`;
        }
      }

      // ✏️🔗🗑 編集・GitHub紐付け・削除ボタン（BT-041: 詳細モーダルを開かずカードから直接操作。完了カラムには不要。Epicは削除不可のため編集のみ）
      let cardActionsHtml = '';
      if (!isCompact && item.id && item.id !== '-') {
        cardActionsHtml = `<div class="card-actions">
          <button class="card-action-btn card-edit-btn" data-task-id="${item.id}" title="編集">✏️</button>
          ${!item.githubIssueNumber ? `<button class="card-action-btn card-github-link-btn" data-task-id="${item.id}" data-is-child="false" title="GitHub Issueと紐づける">🔗</button>` : ''}
          ${!item.githubIssueNumber ? `<button class="card-action-btn card-github-create-btn" data-task-id="${item.id}" data-is-child="false" title="GitHub Issueを新規作成">📤</button>` : ''}
          ${!isEpic ? `<button class="card-action-btn card-delete-btn danger" data-task-id="${item.id}" title="削除">🗑</button>` : ''}
        </div>`;
      }

      card.innerHTML = `${pinHtml}${cardActionsHtml}${idHtml}${titleHtml}${metaHtml}`;
      body.appendChild(card);
    }

    // 完了カラム（compact）: 「本日完了だけ」表示中の空状態 or limit超過分のまとめ表示
    if (isCompact && doneTodayActive) {
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'done-today-empty';
        empty.innerHTML = `<span class="done-today-empty-emoji">🌱</span><span>今日の達成はまだないよ<br>ひとつ片付けてこ！</span>`;
        body.appendChild(empty);
      }
    } else if (isCompact) {
      if (hiddenCount > 0) {
        const summary = document.createElement('div');
        summary.className = 'card card-compact card-summary';
        summary.innerHTML = `<span class="summary-label">他 ${hiddenCount} 件</span><span class="summary-chevron">▾</span>`;
        summary.title = 'クリックで全件表示';
        summary.addEventListener('click', () => {
          expandedCols.add(col.id);
          renderBoard(lastBoardData);
        });
        body.appendChild(summary);
      } else if (isExpanded && currentLimit && totalBeforeLimit > currentLimit) {
        const collapse = document.createElement('div');
        collapse.className = 'card card-compact card-summary card-summary-collapse';
        collapse.innerHTML = `<span class="summary-label">折りたたむ</span><span class="summary-chevron">▴</span>`;
        collapse.title = 'クリックで折りたたむ';
        collapse.addEventListener('click', () => {
          expandedCols.delete(col.id);
          renderBoard(lastBoardData);
        });
        body.appendChild(collapse);
      }
    }

    boardEl.appendChild(colEl);
  }

  // +ボタンのイベントリスナーを設定
  boardEl.querySelectorAll('.add-task-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddTaskForm(btn.dataset.colStatus, currentFilter || '', '');
    });
  });

  // 「本日完了だけ」トグルのイベントリスナー
  boardEl.querySelectorAll('.done-today-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      doneTodayOnly = !doneTodayOnly;
      localStorage.setItem('doneTodayOnly', doneTodayOnly);
      renderBoard(lastBoardData);
    });
  });

  // limit入力欄のイベントリスナー
  boardEl.querySelectorAll('.limit-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const colId = e.target.dataset.colId;
      const val = parseInt(e.target.value, 10);
      if (val > 0) {
        localStorage.setItem('colLimit_' + colId, val);
        renderBoard(lastBoardData);
      }
    });
  });

  // 📌 ピンボタンのイベントリスナー
  boardEl.querySelectorAll('.today-pin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const taskId = btn.dataset.taskId;
      const isChild = btn.dataset.isChild === 'true';
      const isActive = btn.classList.contains('pin-active');
      toggleTodayFlag(taskId, isChild, !isActive);
    });
  });

  // ✏️ カード直接編集ボタンのイベントリスナー（BT-041）
  boardEl.querySelectorAll('.card-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openCardEditDirect(item);
    });
  });

  // 🗑 カード直接削除ボタンのイベントリスナー（BT-041）
  boardEl.querySelectorAll('.card-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openDeleteConfirm(item, false);
    });
  });

  // 🔗 GitHub Issueバッジ: クリックしてもカード詳細を開かず、リンク遷移のみ行う（BT-110）
  boardEl.querySelectorAll('.github-issue-badge').forEach(link => {
    link.addEventListener('click', (e) => e.stopPropagation());
  });

  // 🔗 GitHub Issue紐付けボタンのイベントリスナー（BT-122）
  boardEl.querySelectorAll('.card-github-link-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openGithubLinkModal(item, btn.dataset.isChild === 'true');
    });
  });

  // 📤 GitHub Issue新規作成ボタンのイベントリスナー（BT-134）
  boardEl.querySelectorAll('.card-github-create-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openGithubCreateConfirm(item, btn.dataset.isChild === 'true');
    });
  });

  updateSelectionBar();
}

/**
 * カードの✏️ボタンから直接呼ばれる: 詳細モーダルを開いて即編集モードにする（BT-041）
 * @param {object} item
 */
function openCardEditDirect(item) {
  openCardDetail(item);
  const modal = getOrCreateModal();
  const body = modal.querySelector('.modal-body');
  const isEpic = item.children && item.children.length > 0;
  const isArchivedSingle = !isEpic && item.status === '完了';
  enterEditMode(item, body, false, isArchivedSingle, renderModalContent);
}

/**
 * ミニボード子カードの✏️ボタンから直接呼ばれる: 子詳細モーダルを開いて即編集モードにする（BT-041）
 * @param {object} childWithProject
 * @param {object} epic
 */
function openChildCardEditDirect(childWithProject, epic) {
  openCardDetail(childWithProject, epic);
  const modal = getOrCreateChildModal();
  const body = modal.querySelector('.modal-body');
  enterEditMode(childWithProject, body, true, false, openChildModal);
}

function buildArtifactsHtml(item) {
  if (!item.artifacts || item.artifacts.length === 0) return '';
  const workspaceMap = currentBoardData && currentBoardData.workspaceMap || {};
  const wsPath = workspaceMap[item.project] || '';
  const artifactItems = item.artifacts.map((art, idx) => {
    const escaped = escapeHtml(art);
    const fullPath = wsPath ? (wsPath + '/' + art.replace(/\\/g, '/')) : art;
    return `<li class="artifact-item"><code>${escaped}</code> <button class="artifact-copy-btn" data-path="${escapeHtml(fullPath)}" title="パスをコピー">&#128203;</button></li>`;
  }).join('');
  return `<div class="detail-section"><h4>成果物</h4><ul class="detail-artifacts">${artifactItems}</ul></div>`;
}

// ボタン群を横並び1行にまとめる（BT-063: 編集/削除、子タスク追加/親設定、
// ワークスペース開く/移管 のように意味のあるペアを1行にレイアウトするため）
// 引数のうち空文字列は無視するので、片方しかないボタンは自動で全幅表示になる
function actionsRow(...btns) {
  const content = btns.filter(Boolean).join('');
  return content ? `<div class="detail-actions-row">${content}</div>` : '';
}

// ワークスペース導線ボタンのHTMLを生成する（BT-053）
// プロジェクトにworkspaceパスが設定済みなら「開く」、未設定なら「作る」を出し分ける
function buildWorkspaceActionHtml(item) {
  if (!item.id || item.id === '-') return '';
  const workspaceMap = currentBoardData && currentBoardData.workspaceMap || {};
  const wsPath = workspaceMap[item.project] || '';
  if (wsPath) {
    return `<button class="add-child-btn" id="modal-open-workspace-btn">📂 ワークスペースを開く</button>`;
  }
  return `<button class="add-child-btn" id="modal-create-workspace-btn">🛠 ワークスペースを作る</button>`;
}

function setupWorkspaceActionButtons(body, item) {
  const openBtn = body.querySelector('#modal-open-workspace-btn');
  if (openBtn) {
    openBtn.addEventListener('click', () => openTaskWorkspace(item.id, openBtn));
  }
  const createBtn = body.querySelector('#modal-create-workspace-btn');
  if (createBtn) {
    createBtn.addEventListener('click', () => openWorkspaceCreateForm());
  }
}

// ワークスペース移管ボタンのHTMLを生成する（BT-063）
function buildMoveActionHtml(item) {
  if (!item.id || item.id === '-') return '';
  return `<button class="add-child-btn" id="modal-move-btn">🚚 ワークスペースを移管</button>`;
}

function setupMoveActionButton(body, item, isChild) {
  const moveBtn = body.querySelector('#modal-move-btn');
  if (moveBtn) {
    moveBtn.addEventListener('click', () => openMovePicker([item.id], isChild));
  }
}

async function openTaskWorkspace(taskId, btnEl) {
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '開いてるよ...';
  try {
    const resp = await fetch('/api/open-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert(`ワークスペースを開けなかったよ: ${data.error || ''}`);
    }
  } catch (e) {
    console.error('[open-workspace] Network error:', e);
    alert('ネットワークエラーが発生したよ');
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

function setupArtifactCopyButtons(container) {
  container.querySelectorAll('.artifact-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pathText = btn.dataset.path;
      navigator.clipboard.writeText(pathText).then(() => {
        btn.textContent = '✓';
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = '&#128203;'; btn.classList.remove('copied'); }, 1500);
      }).catch(() => {
        // fallback
        btn.textContent = '✗';
        setTimeout(() => { btn.innerHTML = '&#128203;'; }, 1500);
      });
    });
  });
}

// 検索クエリ（小文字化済み）がタイトル・ID・説明・担当のいずれかに部分一致するか判定
function itemMatchesSearch(item, query) {
  const fields = [item.title, item.id, item.description, item.assignee];
  return fields.some(f => f && String(f).toLowerCase().includes(query));
}

// --- Search Dialog ---

function getOrCreateSearchModal() {
  let el = document.getElementById('search-modal-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'search-modal-overlay';
  el.className = 'modal-overlay';
  el.innerHTML = `
    <div class="modal-content search-modal-content">
      <button class="modal-close" id="search-modal-close">&times;</button>
      <input type="text" class="search-modal-input" id="search-modal-input" placeholder="タイトル・ID・説明・担当で検索">
      <div class="search-result-list" id="search-result-list"></div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeSearchModal();
  });
  el.querySelector('#search-modal-close').addEventListener('click', closeSearchModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('modal-visible')) closeSearchModal();
  });
  const inputEl = el.querySelector('#search-modal-input');
  inputEl.addEventListener('input', (e) => {
    renderSearchResults(e.target.value.trim().toLowerCase());
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSearchSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSearchSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateSearchSelection();
    }
  });
  return el;
}

function closeSearchModal() {
  const el = document.getElementById('search-modal-overlay');
  if (el) el.classList.remove('modal-visible');
}

function openSearchModal() {
  const el = getOrCreateSearchModal();
  const input = el.querySelector('#search-modal-input');
  input.value = '';
  renderSearchResults('');
  el.classList.add('modal-visible');
  input.focus();
}

// ワークスペース(project) → Epic → 子タスク の階層でグルーピングする
// （BT-032: 完了カラムのlimitで隠れたタスク／Epic配下の子タスクが検索にかからない問題の解消）
function buildSearchTree() {
  const projectMap = new Map(); // project名 -> { epics: Map(epicId -> {epic, children:[]}), singles: [] }
  if (!currentBoardData) return projectMap;
  for (const col of currentBoardData.columns) {
    for (const item of col.items) {
      if (!item.id || item.id === '-') continue;
      const proj = item.project || '-';
      if (!projectMap.has(proj)) projectMap.set(proj, { epics: new Map(), singles: [] });
      const projEntry = projectMap.get(proj);
      if (item.children && item.children.length) {
        const children = item.children
          .filter(c => c.id && c.id !== '-')
          .map(c => ({ ...c, project: proj })); // 子タスクはprojectを持たないため親から補う
        projEntry.epics.set(item.id, { epic: item, children });
      } else {
        projEntry.singles.push(item);
      }
    }
  }
  return projectMap;
}

// 現在の検索クエリに対する表示行（ワークスペース見出し／選択可能なタスク行）を平坦なリストで持つ。
// キーボードの上下移動・Enterでの選択で使う。
let searchEntries = [];
let searchSelectableIndices = [];
let searchSelectedPos = 0;

function buildFilteredEntries(query) {
  const tree = buildSearchTree();
  const entries = [];
  for (const [projName, projEntry] of tree) {
    const matchedEpics = [];
    for (const epicEntry of projEntry.epics.values()) {
      const epicMatches = !query || itemMatchesSearch(epicEntry.epic, query);
      const matchedChildren = epicEntry.children.filter(c => !query || itemMatchesSearch(c, query));
      if (epicMatches || matchedChildren.length > 0) {
        matchedEpics.push({ epic: epicEntry.epic, children: matchedChildren });
      }
    }
    const matchedSingles = projEntry.singles.filter(s => !query || itemMatchesSearch(s, query));
    if (matchedEpics.length === 0 && matchedSingles.length === 0) continue;

    entries.push({ type: 'header', label: projName });
    for (const me of matchedEpics) {
      entries.push({ type: 'task', item: me.epic, isChild: false, isEpic: true, indent: 1 });
      for (const c of me.children) {
        entries.push({ type: 'task', item: c, isChild: true, indent: 2 });
      }
    }
    for (const s of matchedSingles) {
      entries.push({ type: 'task', item: s, isChild: false, indent: 1 });
    }
  }
  return entries;
}

function renderSearchResults(query) {
  const listEl = document.getElementById('search-result-list');
  if (!listEl) return;

  searchEntries = buildFilteredEntries(query);
  searchSelectableIndices = [];
  searchEntries.forEach((entry, idx) => { if (entry.type === 'task') searchSelectableIndices.push(idx); });
  searchSelectedPos = 0;

  if (searchSelectableIndices.length === 0) {
    listEl.innerHTML = `<div class="search-result-empty">${query ? '見つからなかったよ' : 'タスクがまだないよ'}</div>`;
    return;
  }

  listEl.innerHTML = searchEntries.map((entry, idx) => {
    if (entry.type === 'header') {
      return `<div class="search-group-header">${escapeHtml(entry.label)}</div>`;
    }
    const epicIcon = entry.isEpic ? '<span class="epic-icon" title="Epic">⧉</span>' : '';
    return `<div class="search-result-item search-indent-${entry.indent}" data-entry-idx="${idx}">
      ${epicIcon}<span class="search-result-id">${escapeHtml(entry.item.id)}</span>
      <span class="search-result-title">${escapeHtml(entry.item.title)}</span>
      <span class="search-result-status">${escapeHtml(entry.item.status || '-')}</span>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.search-result-item').forEach(itemEl => {
    const entryIdx = Number(itemEl.dataset.entryIdx);
    itemEl.addEventListener('click', () => {
      const pos = searchSelectableIndices.indexOf(entryIdx);
      if (pos < 0) return;
      searchSelectedPos = pos;
      activateSearchSelection();
    });
    itemEl.addEventListener('mouseenter', () => {
      const pos = searchSelectableIndices.indexOf(entryIdx);
      if (pos < 0) return;
      searchSelectedPos = pos;
      updateSearchHighlight();
    });
  });

  updateSearchHighlight();
}

function updateSearchHighlight() {
  const listEl = document.getElementById('search-result-list');
  if (!listEl) return;
  listEl.querySelectorAll('.search-result-item').forEach(el => el.classList.remove('search-result-selected'));
  const entryIdx = searchSelectableIndices[searchSelectedPos];
  if (entryIdx === undefined) return;
  const el = listEl.querySelector(`.search-result-item[data-entry-idx="${entryIdx}"]`);
  if (el) {
    el.classList.add('search-result-selected');
    el.scrollIntoView({ block: 'nearest' });
  }
}

function moveSearchSelection(delta) {
  if (searchSelectableIndices.length === 0) return;
  searchSelectedPos = Math.max(0, Math.min(searchSelectableIndices.length - 1, searchSelectedPos + delta));
  updateSearchHighlight();
}

function activateSearchSelection() {
  const entryIdx = searchSelectableIndices[searchSelectedPos];
  if (entryIdx === undefined) return;
  const entry = searchEntries[entryIdx];
  if (!entry) return;
  closeSearchModal();
  if (entry.isChild) openChildModal(entry.item);
  else openCardDetail(entry.item);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// 本日（JST）の日付文字列 YYYY-MM-DD を返す。サーバーの完了日採番(JST)と揃える。
function getTodayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
  return jst.toISOString().slice(0, 10);
}

// 説明テキストを適度に改行して表示用HTMLにする
function formatDescription(desc) {
  if (!desc) return '';
  // まずエスケープ
  let html = escapeHtml(desc);
  // \n はそのまま改行として表示（white-space: pre-wrapで効く）
  // 句点 (。) の後にスペースや区切りを追加（長い1行の場合）
  // → CSSの word-break + pre-wrap で自然に折り返すので、\n だけ <br> に変換
  html = html.replace(/\n/g, '<br>');
  return html;
}

// 説明欄のHTML生成（BT-080: 長い説明は2行に折りたたみ、▼で展開できるようにする）
function buildDescriptionSectionHtml(description) {
  if (!description) return '';
  return `<div class="detail-section"><h4>説明</h4><div class="description-collapsible"><p class="description-text">${formatDescription(description)}</p><button type="button" class="description-toggle-btn" hidden>▼ もっと見る</button></div></div>`;
}

// 説明欄の折りたたみトグルを初期化する（BT-080）。2行に収まる場合はボタンを出さない
function setupDescriptionToggle(container) {
  container.querySelectorAll('.description-collapsible').forEach((wrap) => {
    const text = wrap.querySelector('.description-text');
    const btn = wrap.querySelector('.description-toggle-btn');
    if (!text || !btn) return;
    if (text.scrollHeight <= text.clientHeight + 1) return;
    btn.hidden = false;
    btn.addEventListener('click', () => {
      const expanded = wrap.classList.toggle('expanded');
      btn.textContent = expanded ? '▲ 閉じる' : '▼ もっと見る';
    });
  });
}

// --- Drag & Drop ---
let dragData = null;

function setupDragAndDrop(card, item, colId, isChild = false, parentId = null) {
  card.setAttribute('draggable', 'true');
  card.classList.add('card-draggable');

  card.addEventListener('dragstart', (e) => {
    dragData = { id: item.id, isChild, sourceColId: colId, parentId };
    card.classList.add('card-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('card-dragging');
    dragData = null;
    document.querySelectorAll('.column-body.drop-over, .mini-col-body.drop-over').forEach(el => el.classList.remove('drop-over'));
    document.querySelectorAll('.card-drop-above').forEach(el => el.classList.remove('card-drop-above'));
    document.querySelectorAll('.card-drop-below').forEach(el => el.classList.remove('card-drop-below'));
  });
}

function setupDropZone(bodyEl, colId, colMatch, isChildZone = false, parentId = null) {
  let lastDropTarget = { card: null, position: 'below' }; // dragoverで計算した最後のターゲットを保持

  bodyEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragData) return;

    // 同一カラムでも別カラムでもドロップ位置インジケータを表示
    const target = getDropTarget(bodyEl, e.clientY);
    lastDropTarget = target; // 記憶
    clearDropIndicators(bodyEl);
    if (target.card) {
      target.card.classList.add(target.position === 'above' ? 'card-drop-above' : 'card-drop-below');
    }

    if (dragData.sourceColId !== colId) {
      bodyEl.classList.add('drop-over');
    }
  });

  bodyEl.addEventListener('dragleave', (e) => {
    if (!bodyEl.contains(e.relatedTarget)) {
      bodyEl.classList.remove('drop-over');
      clearDropIndicators(bodyEl);
    }
  });

  bodyEl.addEventListener('drop', (e) => {
    e.preventDefault();
    bodyEl.classList.remove('drop-over');
    clearDropIndicators(bodyEl);

    if (!dragData) return;

    // dragoverで記憶した位置を使う（drop時のclientYはブラウザで不安定なため）
    const target = lastDropTarget;

    if (dragData.sourceColId === colId) {
      const cards = Array.from(bodyEl.querySelectorAll('.card[data-task-id]'));
      const currentIds = cards.map(c => c.dataset.taskId);
      const dragId = dragData.id;
      if (!currentIds.includes(dragId)) return;

      const filteredIds = currentIds.filter(id => id !== dragId);

      let insertIdx;
      if (!target.card) {
        insertIdx = filteredIds.length;
      } else {
        const targetId = target.card.dataset.taskId;
        const targetIdx = filteredIds.indexOf(targetId);
        insertIdx = target.position === 'above' ? targetIdx : targetIdx + 1;
      }
      filteredIds.splice(insertIdx, 0, dragId);

      if (JSON.stringify(filteredIds) === JSON.stringify(currentIds)) return;
      reorderItems(filteredIds, dragData.isChild, dragData.parentId || parentId);
    } else {
      // 別カラムへ移動 → ステータス変更 + ドロップ位置での並び替え
      const newStatus = colMatch[0];

      // ドロップ先カラムの既存カードID配列を取得
      const existingCards = Array.from(bodyEl.querySelectorAll('.card[data-task-id]'));
      const existingIds = existingCards.map(c => c.dataset.taskId);

      // dragoverで記憶した位置を使う
      let insertIdx;
      if (!target.card) {
        insertIdx = existingIds.length; // 末尾
      } else {
        const targetId = target.card.dataset.taskId;
        const targetIdx = existingIds.indexOf(targetId);
        insertIdx = target.position === 'above' ? targetIdx : targetIdx + 1;
      }

      // ドラッグ元IDを挿入位置に追加
      existingIds.splice(insertIdx, 0, dragData.id);

      // ステータス変更してから並び替え
      const dragInfo = { ...dragData };
      updateStatus(dragInfo.id, newStatus, dragInfo.isChild).then(() => {
        // 2つ以上のIDがあればreorder実行
        if (existingIds.length >= 2) {
          reorderItems(existingIds, dragInfo.isChild, dragInfo.parentId || parentId);
        }
      });
    }
    dragData = null;
  });
}

function getDropTarget(bodyEl, clientY) {
  const cards = Array.from(bodyEl.querySelectorAll('.card[data-task-id]'));
  for (const card of cards) {
    if (card.classList.contains('card-dragging')) continue;
    const rect = card.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (clientY < midY) return { card, position: 'above' };
  }
  const lastCard = cards.filter(c => !c.classList.contains('card-dragging')).pop();
  return lastCard ? { card: lastCard, position: 'below' } : { card: null, position: 'below' };
}

function clearDropIndicators(bodyEl) {
  bodyEl.querySelectorAll('.card-drop-above').forEach(el => el.classList.remove('card-drop-above'));
  bodyEl.querySelectorAll('.card-drop-below').forEach(el => el.classList.remove('card-drop-below'));
}

async function reorderItems(orderedIds, isChild, parentId) {
  try {
    const resp = await fetch('/api/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds, isChild, parentId }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      console.error('[dnd] Reorder failed:', err.error);
    }
  } catch (e) {
    console.error('[dnd] Network error:', e);
  }
}

async function updateStatus(taskId, newStatus, isChild) {
  try {
    const resp = await fetch('/api/update-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, newStatus, isChild }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      console.error('[dnd] Update failed:', err.error);
    }
  } catch (e) {
    console.error('[dnd] Network error:', e);
  }
}

// --- Today Flag Toggle ---
async function toggleTodayFlag(taskId, isChild, value) {
  try {
    const resp = await fetch('/api/toggle-today', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, isChild, value }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      console.error('[today] Toggle failed:', err.error);
    }
  } catch (e) {
    console.error('[today] Network error:', e);
  }
}

// --- Card Detail Modal ---
let modalEl = null;
let currentModalItemId = null;

function getOrCreateModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement('div');
  modalEl.className = 'modal-overlay';
  modalEl.innerHTML = `
    <div class="modal-content">
      <button class="modal-close">&times;</button>
      <div class="modal-body"></div>
    </div>
  `;
  document.body.appendChild(modalEl);

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeModal();
  });
  modalEl.querySelector('.modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalEl.classList.contains('modal-visible')) closeModal();
  });

  return modalEl;
}

function closeModal() {
  if (modalEl) {
    modalEl.classList.remove('modal-visible');
    currentModalItemId = null;
    modalParentEpic = null;
    closeChildModal();
  }
}

function findItemById(id) {
  if (!currentBoardData) return null;
  for (const col of currentBoardData.columns) {
    for (const item of col.items) {
      if (item.id === id) return item;
    }
  }
  return null;
}

function refreshModalIfOpen() {
  if (!currentModalItemId || !modalEl || !modalEl.classList.contains('modal-visible')) return;
  const item = findItemById(currentModalItemId);
  if (item) renderModalContent(item);
}

function openCardDetail(item, parentEpic = null) {
  if (parentEpic) {
    // 子タスク詳細 → 2枚目モーダルを重ねる
    openChildModal(item);
  } else {
    // 通常のカード詳細
    const modal = getOrCreateModal();
    currentModalItemId = item.id;
    modalParentEpic = null;
    modal.classList.add('modal-visible');
    renderModalContent(item);
  }
}

function getOrCreateChildModal() {
  let el = document.getElementById('child-modal-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'child-modal-overlay';
  el.className = 'modal-overlay child-modal-overlay';
  el.innerHTML = `
    <div class="modal-content child-modal-content">
      <button class="modal-close" id="child-modal-close">&times;</button>
      <div class="modal-body"></div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeChildModal();
  });
  el.querySelector('#child-modal-close').addEventListener('click', closeChildModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('modal-visible')) {
      e.stopImmediatePropagation();
      closeChildModal();
    }
  });
  return el;
}

function closeChildModal() {
  const el = document.getElementById('child-modal-overlay');
  if (el) el.classList.remove('modal-visible');
}

function openChildModal(item) {
  const modal = getOrCreateChildModal();
  const body = modal.querySelector('.modal-body');
  const content = modal.querySelector('.modal-content');
  content.classList.remove('modal-wide');

  const statusBadge = `<span class="detail-status">${escapeHtml(item.status || '-')}</span>`;
  const category = (item.category && item.category !== '-') ? `<span class="detail-tag category">${escapeHtml(item.category)}</span>` : '';
  const project = item.project ? `<span class="detail-tag project">${escapeHtml(item.project)}</span>` : '';
  const githubBadge = item.githubIssueNumber ? renderGithubIssueBadge(item.githubIssueNumber, item.githubIssueUrl) : '';

  const desc = buildDescriptionSectionHtml(item.description);

  // 成果物セクション
  const artifactsHtml = buildArtifactsHtml(item);

  const metaParts = [];
  if (item.assignee) metaParts.push(`<li><strong>担当:</strong> ${escapeHtml(item.assignee)}</li>`);
  if (item.startDate) metaParts.push(`<li><strong>開始日:</strong> ${escapeHtml(item.startDate)}</li>`);
  if (item.dueDate) metaParts.push(`<li><strong>期日:</strong> ${escapeHtml(item.dueDate)}</li>`);
  if (item.completedDate) metaParts.push(`<li><strong>完了日:</strong> ${escapeHtml(item.completedDate)}</li>`);
  const metaHtml = metaParts.length > 0 ? `<div class="detail-section"><h4>情報</h4><ul class="detail-meta">${metaParts.join('')}</ul></div>` : '';

  const detailSpinner = item.running ? '<span class="running-spinner detail-spinner"></span>' : '';

  // 親から外すボタン（BT-034: attachの逆操作。単に外すだけで他の親には付け替えない）
  const detachBtn = (item.id && item.id !== '-')
    ? `<button class="add-child-btn detach-btn" id="modal-detach-btn">🔓 親から外す</button>`
    : '';

  // 編集・削除ボタン（BT-036/BT-031: 子タスクは常に単独削除可）
  const editBtnHtml = (item.id && item.id !== '-') ? `<button class="detail-action-btn" id="modal-edit-btn">✏️ 編集</button>` : '';
  const deleteBtnHtml = (item.id && item.id !== '-') ? `<button class="detail-action-btn danger" id="modal-delete-btn">🗑 削除</button>` : '';

  // GitHub Issue紐付けボタン（BT-122: カードと同じ操作を詳細モーダルにも配備）
  const githubLinkBtnHtml = (item.id && item.id !== '-' && !item.githubIssueNumber)
    ? `<button class="add-child-btn" id="modal-github-link-btn">🔗 GitHub Issueと紐づける</button>`
    : '';

  // GitHub Issue新規作成ボタン（BT-134）
  const githubCreateBtnHtml = (item.id && item.id !== '-' && !item.githubIssueNumber)
    ? `<button class="add-child-btn" id="modal-github-create-btn">📤 GitHub Issueを新規作成</button>`
    : '';

  // ワークスペース導線ボタン（BT-053）
  const workspaceActionHtml = buildWorkspaceActionHtml(item);

  // ワークスペース移管ボタン（BT-063）
  const moveActionHtml = buildMoveActionHtml(item);

  body.innerHTML = `
    <div class="detail-header">
      ${detailSpinner}<span class="detail-id">${escapeHtml(item.id || '-')}</span>
      ${statusBadge}
      ${project}${category}${githubBadge}
    </div>
    <h3 class="detail-title">${escapeHtml(item.title)}</h3>
    ${desc}
    ${artifactsHtml}
    ${metaHtml}
    ${actionsRow(editBtnHtml, deleteBtnHtml)}
    ${actionsRow(workspaceActionHtml, moveActionHtml)}
    ${actionsRow(detachBtn, githubLinkBtnHtml)}
    ${actionsRow(githubCreateBtnHtml)}
  `;

  // 親から外すボタンのイベント
  const detachBtnEl = body.querySelector('#modal-detach-btn');
  if (detachBtnEl) {
    detachBtnEl.addEventListener('click', () => detachTask(item.id));
  }

  // GitHub Issue紐付けボタンのイベント（BT-122）
  const githubLinkBtnEl = body.querySelector('#modal-github-link-btn');
  if (githubLinkBtnEl) {
    githubLinkBtnEl.addEventListener('click', () => openGithubLinkModal(item, true));
  }

  // GitHub Issue新規作成ボタンのイベント（BT-134）
  const githubCreateBtnEl = body.querySelector('#modal-github-create-btn');
  if (githubCreateBtnEl) {
    githubCreateBtnEl.addEventListener('click', () => openGithubCreateConfirm(item, true));
  }

  // 編集ボタンのイベント（BT-036: 子タスクは常に説明編集可）
  const editBtnEl = body.querySelector('#modal-edit-btn');
  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      enterEditMode(item, body, true, false, openChildModal);
    });
  }

  // 削除ボタンのイベント（BT-031）
  const deleteBtnEl = body.querySelector('#modal-delete-btn');
  if (deleteBtnEl) {
    deleteBtnEl.addEventListener('click', () => {
      openDeleteConfirm(item, true);
    });
  }

  // 成果物コピーボタンのイベント
  setupArtifactCopyButtons(body);

  // ワークスペース導線ボタンのイベント（BT-053）
  setupWorkspaceActionButtons(body, item);

  // プロジェクト移管ボタンのイベント（BT-063）
  setupMoveActionButton(body, item, true);

  modal.classList.add('modal-visible');

  // 説明欄の折りたたみトグル初期化（BT-080: 表示後でないとscrollHeightが取れない）
  setupDescriptionToggle(body);
}

async function detachTask(taskId) {
  try {
    const resp = await fetch('/api/detach-from-parent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('[detach] Failed:', data.error);
      alert(`外すのに失敗したよ: ${data.error || ''}`);
      return;
    }
    closeChildModal();
  } catch (e) {
    console.error('[detach] Network error:', e);
  }
}

// --- Task Edit (BT-036) ---

/**
 * 詳細モーダルのbodyを編集フォームに差し替える
 * @param {object} item - 編集対象タスク
 * @param {HTMLElement} body - モーダルの .modal-body 要素
 * @param {boolean} isChild - h4子タスクか
 * @param {boolean} isArchivedSingle - 完了済みアーカイブ単発タスクか（説明編集不可）
 * @param {(item: object) => void} renderFn - 表示モードに戻す際に呼ぶ描画関数
 */
function enterEditMode(item, body, isChild, isArchivedSingle, renderFn) {
  const descValue = item.description || '';
  const descField = isArchivedSingle
    ? `<div class="detail-section"><p class="archived-note">完了済みタスクのため説明は編集できないよ</p></div>`
    : `<div class="settings-group"><label>説明</label><textarea id="edit-task-description" rows="6" placeholder="説明を入力">${escapeHtml(descValue)}</textarea></div>`;

  body.innerHTML = `
    <div class="detail-header">
      <span class="detail-id">${escapeHtml(item.id || '-')}</span>
    </div>
    <div class="settings-group">
      <label>タイトル</label>
      <input type="text" id="edit-task-title" value="${escapeHtml(item.title)}">
    </div>
    ${descField}
    <p class="edit-task-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit" id="edit-task-save">保存</button>
      <button class="add-child-btn" id="edit-task-cancel">キャンセル</button>
    </div>
  `;

  const titleInput = body.querySelector('#edit-task-title');
  const descInput = body.querySelector('#edit-task-description');
  const errorEl = body.querySelector('.edit-task-error');
  const saveBtn = body.querySelector('#edit-task-save');
  const cancelBtn = body.querySelector('#edit-task-cancel');

  cancelBtn.addEventListener('click', () => renderFn(item));

  saveBtn.addEventListener('click', async () => {
    const newTitle = titleInput.value.trim();
    if (!newTitle) {
      errorEl.textContent = 'タイトルは必須だよ';
      errorEl.style.display = 'block';
      return;
    }

    const payload = { taskId: item.id, isChild, title: newTitle };
    if (descInput) payload.description = descInput.value;

    try {
      const resp = await fetch('/api/update-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errorEl.textContent = `保存に失敗したよ: ${data.error || ''}`;
        errorEl.style.display = 'block';
        return;
      }
      item.title = newTitle;
      if (descInput) item.description = descInput.value;
      renderFn(item);
    } catch (e) {
      console.error('[edit] Network error:', e);
      errorEl.textContent = 'ネットワークエラーが発生したよ';
      errorEl.style.display = 'block';
    }
  });

  titleInput.focus();
}

// --- Task Delete (BT-031) ---

function getOrCreateDeleteConfirm() {
  let el = document.getElementById('delete-confirm-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'delete-confirm-overlay';
  el.className = 'modal-overlay';
  el.innerHTML = `<div class="modal-content delete-confirm-modal"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeDeleteConfirm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('modal-visible')) closeDeleteConfirm();
  });
  return el;
}

function closeDeleteConfirm() {
  const el = document.getElementById('delete-confirm-overlay');
  if (el) el.classList.remove('modal-visible');
}

/**
 * 削除確認モーダルを開く
 * @param {object} item - 削除対象タスク
 * @param {boolean} isChild - h4子タスクか
 */
function openDeleteConfirm(item, isChild) {
  const el = getOrCreateDeleteConfirm();
  const content = el.querySelector('.modal-content');
  content.innerHTML = `
    <button class="modal-close" id="delete-confirm-close">&times;</button>
    <h3 class="add-form-title">タスクを削除</h3>
    <p class="delete-confirm-text">「${escapeHtml(item.title)}」(${escapeHtml(item.id)}) を削除するよ。元に戻せないけど大丈夫?</p>
    <p class="delete-confirm-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit danger" id="delete-confirm-ok">削除する</button>
      <button class="add-child-btn" id="delete-confirm-cancel">キャンセル</button>
    </div>
  `;

  content.querySelector('#delete-confirm-close').addEventListener('click', closeDeleteConfirm);
  content.querySelector('#delete-confirm-cancel').addEventListener('click', closeDeleteConfirm);
  content.querySelector('#delete-confirm-ok').addEventListener('click', async () => {
    const errorEl = content.querySelector('.delete-confirm-error');
    try {
      const resp = await fetch('/api/delete-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.id, isChild }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errorEl.textContent = data.error === 'has_children'
          ? '子タスクがあるため削除できないよ。先に子タスクを外すか削除してね'
          : `削除に失敗したよ: ${data.error || ''}`;
        errorEl.style.display = 'block';
        return;
      }
      closeDeleteConfirm();
      if (isChild) closeChildModal();
      else closeModal();
    } catch (e) {
      console.error('[delete] Network error:', e);
      errorEl.textContent = 'ネットワークエラーが発生したよ';
      errorEl.style.display = 'block';
    }
  });

  el.classList.add('modal-visible');
}

// --- GitHub Issue紐付けダイアログ (BT-122: 既存タスクカードへ後から紐付ける) ---
function getOrCreateGithubLinkModal() {
  let el = document.getElementById('github-link-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'github-link-overlay';
  el.className = 'modal-overlay';
  el.innerHTML = `<div class="modal-content github-link-modal"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeGithubLinkModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('modal-visible')) closeGithubLinkModal();
  });
  return el;
}

function closeGithubLinkModal() {
  const el = document.getElementById('github-link-overlay');
  if (el) el.classList.remove('modal-visible');
}

// Issue番号の生入力（"123" / "#123" / Issue URL）からissue番号だけを取り出す
function parseIssueNumberInput(raw) {
  const s = (raw || '').trim();
  const urlMatch = /\/issues\/(\d+)/.exec(s);
  if (urlMatch) return urlMatch[1];
  const hashMatch = /^#?(\d+)$/.exec(s);
  if (hashMatch) return hashMatch[1];
  return s;
}

/**
 * GitHub Issue紐付けモーダルを開く
 * @param {object} item - 紐付け対象タスク
 * @param {boolean} isChild - h4子タスクか
 */
function openGithubLinkModal(item, isChild) {
  const el = getOrCreateGithubLinkModal();
  const content = el.querySelector('.modal-content');
  content.innerHTML = `
    <button class="modal-close" id="github-link-close">&times;</button>
    <h3 class="add-form-title">🔗 GitHub Issueと紐づける</h3>
    <p class="delete-confirm-text">「${escapeHtml(item.title)}」(${escapeHtml(item.id)}) に紐づけるIssue番号かURLを入力してね。</p>
    <input type="text" id="github-link-input" class="parent-picker-search" placeholder="例: 123 / #123 / https://github.com/owner/repo/issues/123">
    <p class="delete-confirm-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit" id="github-link-ok">紐づける</button>
      <button class="add-child-btn" id="github-link-cancel">キャンセル</button>
    </div>
  `;

  content.querySelector('#github-link-close').addEventListener('click', closeGithubLinkModal);
  content.querySelector('#github-link-cancel').addEventListener('click', closeGithubLinkModal);
  content.querySelector('#github-link-ok').addEventListener('click', async () => {
    const errorEl = content.querySelector('.delete-confirm-error');
    const issueNumber = parseIssueNumberInput(content.querySelector('#github-link-input').value);
    if (!issueNumber) {
      errorEl.textContent = 'Issue番号を入力してね';
      errorEl.style.display = 'block';
      return;
    }
    try {
      const resp = await fetch('/api/github-link-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.id, isChild, issueNumber }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errorEl.textContent = data.error || '紐づけに失敗したよ';
        errorEl.style.display = 'block';
        return;
      }
      closeGithubLinkModal();
    } catch (e) {
      console.error('[github-link] Network error:', e);
      errorEl.textContent = 'ネットワークエラーが発生したよ';
      errorEl.style.display = 'block';
    }
  });

  el.classList.add('modal-visible');
}

// --- GitHub Issue新規作成確認ダイアログ (BT-134: backlogタスク→GitHub Issue新規作成、Epicはsub-issue化) ---
function getOrCreateGithubCreateConfirm() {
  let el = document.getElementById('github-create-confirm-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'github-create-confirm-overlay';
  el.className = 'modal-overlay';
  el.innerHTML = `<div class="modal-content delete-confirm-modal"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeGithubCreateConfirm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('modal-visible')) closeGithubCreateConfirm();
  });
  return el;
}

function closeGithubCreateConfirm() {
  const el = document.getElementById('github-create-confirm-overlay');
  if (el) el.classList.remove('modal-visible');
}

/**
 * GitHub Issue新規作成の確認モーダルを開く（BT-134）
 * @param {object} item - 作成対象タスク（Epicの場合は子タスクもsub-issueとして作成される）
 * @param {boolean} isChild - h4子タスクか
 */
function openGithubCreateConfirm(item, isChild) {
  const el = getOrCreateGithubCreateConfirm();
  const content = el.querySelector('.modal-content');
  const isEpic = !isChild && Array.isArray(item.children) && item.children.length > 0;
  const epicNote = isEpic
    ? `<p class="delete-confirm-text">子タスク ${item.children.length}件 もGitHub Issueとして作成し、Sub-issueとして紐づけるよ。</p>`
    : '';
  content.innerHTML = `
    <button class="modal-close" id="github-create-confirm-close">&times;</button>
    <h3 class="add-form-title">📤 GitHub Issueを新規作成</h3>
    <p class="delete-confirm-text">「${escapeHtml(item.title)}」(${escapeHtml(item.id)}) からGitHub Issueを新規作成するよ。大丈夫?</p>
    ${epicNote}
    <p class="delete-confirm-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit" id="github-create-confirm-ok">作成する</button>
      <button class="add-child-btn" id="github-create-confirm-cancel">キャンセル</button>
    </div>
  `;

  content.querySelector('#github-create-confirm-close').addEventListener('click', closeGithubCreateConfirm);
  content.querySelector('#github-create-confirm-cancel').addEventListener('click', closeGithubCreateConfirm);
  content.querySelector('#github-create-confirm-ok').addEventListener('click', async () => {
    const errorEl = content.querySelector('.delete-confirm-error');
    const okBtn = content.querySelector('#github-create-confirm-ok');
    okBtn.disabled = true;
    okBtn.textContent = '作成中...';
    try {
      const resp = await fetch('/api/github-create-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.id, isChild }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errorEl.textContent = data.error || '作成に失敗したよ';
        errorEl.style.display = 'block';
        okBtn.disabled = false;
        okBtn.textContent = '作成する';
        return;
      }
      closeGithubCreateConfirm();
      if (data.failedChildIds && data.failedChildIds.length > 0) {
        alert(`親Issueは作成できたけど、一部の子タスク(${data.failedChildIds.join(', ')})のIssue作成に失敗したよ。もう一度試してみてね`);
      }
    } catch (e) {
      console.error('[github-create] Network error:', e);
      errorEl.textContent = 'ネットワークエラーが発生したよ';
      errorEl.style.display = 'block';
      okBtn.disabled = false;
      okBtn.textContent = '作成する';
    }
  });

  el.classList.add('modal-visible');
}

/**
 * 複数選択タスクをまとめてGitHub Issueとして新規作成する確認モーダルを開く（BT-146）
 * 既存の単発作成API（/api/github-create-issue）を選択件数分呼び出すだけで、専用のバックエンドAPIは持たない
 */
function openBulkGithubCreateConfirm() {
  const allIds = [...selectedIds];
  if (allIds.length === 0) return;

  const targets = [];
  let alreadyLinkedCount = 0;
  for (const id of allIds) {
    const item = findItemById(id);
    if (!item) continue;
    if (item.githubIssueNumber) {
      alreadyLinkedCount += 1;
      continue;
    }
    targets.push(item);
  }

  const el = getOrCreateGithubCreateConfirm();
  const content = el.querySelector('.modal-content');
  const skipNote = alreadyLinkedCount > 0
    ? `<p class="delete-confirm-text">連携済みの ${alreadyLinkedCount}件 は対象外にするよ。</p>`
    : '';
  content.innerHTML = `
    <button class="modal-close" id="github-create-confirm-close">&times;</button>
    <h3 class="add-form-title">📤 GitHub Issueを一括作成</h3>
    <p class="delete-confirm-text">選択中のタスクから ${targets.length}件 のGitHub Issueを新規作成するよ。大丈夫?</p>
    ${skipNote}
    <p class="delete-confirm-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit" id="github-create-confirm-ok">作成する</button>
      <button class="add-child-btn" id="github-create-confirm-cancel">キャンセル</button>
    </div>
  `;

  content.querySelector('#github-create-confirm-close').addEventListener('click', closeGithubCreateConfirm);
  content.querySelector('#github-create-confirm-cancel').addEventListener('click', closeGithubCreateConfirm);
  content.querySelector('#github-create-confirm-ok').addEventListener('click', async () => {
    if (targets.length === 0) {
      closeGithubCreateConfirm();
      return;
    }
    const errorEl = content.querySelector('.delete-confirm-error');
    const okBtn = content.querySelector('#github-create-confirm-ok');
    okBtn.disabled = true;

    const succeeded = [];
    const failed = [];
    for (const item of targets) {
      okBtn.textContent = `作成中... (${succeeded.length + failed.length + 1}/${targets.length})`;
      try {
        const resp = await fetch('/api/github-create-issue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: item.id, isChild: false }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          failed.push({ taskId: item.id, error: data.error || '不明なエラー' });
          continue;
        }
        succeeded.push(item.id);
      } catch (e) {
        failed.push({ taskId: item.id, error: 'ネットワークエラー' });
      }
    }

    closeGithubCreateConfirm();
    let message = `${succeeded.length}件 GitHub Issueを作成したよ。`;
    if (failed.length > 0) {
      const reasons = failed.map(f => `${f.taskId}(${f.error})`).join(', ');
      message += `\n${failed.length}件は失敗: ${reasons}`;
    }
    alert(message);

    selectionMode = false;
    selectedIds.clear();
    document.getElementById('select-mode-btn').classList.remove('filter-active');
    renderBoard(lastBoardData);
  });

  el.classList.add('modal-visible');
}

function renderModalContent(item) {
  const modal = getOrCreateModal();
  const body = modal.querySelector('.modal-body');
  const content = modal.querySelector('.modal-content');

  const isEpic = item.children && item.children.length > 0;
  content.classList.toggle('modal-wide', isEpic);

  const statusBadge = `<span class="detail-status">${escapeHtml(item.status || '-')}</span>`;
  const category = (item.category && item.category !== '-') ? `<span class="detail-tag category">${escapeHtml(item.category)}</span>` : '';
  const project = item.project ? `<span class="detail-tag project">${escapeHtml(item.project)}</span>` : '';
  const githubBadge = item.githubIssueNumber ? renderGithubIssueBadge(item.githubIssueNumber, item.githubIssueUrl) : '';

  let badgeHtml = '';
  if (item.childrenTotal) {
    const allDone = item.childrenDone === item.childrenTotal;
    const badgeClass = allDone ? 'badge-done' : '';
    badgeHtml = `<span class="card-badge ${badgeClass}"><span class="badge-num">${item.childrenDone}</span><span class="badge-den">/${item.childrenTotal}</span></span>`;
  }

  const desc = buildDescriptionSectionHtml(item.description);

  // 成果物セクション
  const artifactsHtml = buildArtifactsHtml(item);

  const metaParts = [];
  if (item.assignee) metaParts.push(`<li><strong>担当:</strong> ${escapeHtml(item.assignee)}</li>`);
  if (item.startDate) metaParts.push(`<li><strong>開始日:</strong> ${escapeHtml(item.startDate)}</li>`);
  if (item.dueDate) metaParts.push(`<li><strong>期日:</strong> ${escapeHtml(item.dueDate)}</li>`);
  if (item.completedDate) metaParts.push(`<li><strong>完了日:</strong> ${escapeHtml(item.completedDate)}</li>`);
  const metaHtml = metaParts.length > 0 ? `<div class="detail-section"><h4>情報</h4><ul class="detail-meta">${metaParts.join('')}</ul></div>` : '';

  let miniBoard = '';
  if (isEpic) {
    miniBoard = '<div class="mini-board" id="mini-board"></div>';
  }

  // 子タスク追加ボタン（Epicでも非Epicでも表示）
  const addChildBtn = (item.id && item.id !== '-')
    ? `<button class="add-child-btn" id="modal-add-child-btn">＋ 子タスクを追加</button>`
    : '';

  // 親を設定ボタン（BT-034: 単独タスク→その場でEPIC化。子を持つ/完了済みは対象外）
  const setParentBtn = (item.id && item.id !== '-' && !isEpic && item.status !== '完了')
    ? `<button class="add-child-btn" id="modal-set-parent-btn">🔗 親を設定</button>`
    : '';

  const detailSpinner = item.running ? '<span class="running-spinner detail-spinner"></span>' : '';

  // 編集・削除ボタン（BT-036/BT-031: 子ありEpicは削除不可のため削除ボタンを出さない）
  const editBtnHtml = (item.id && item.id !== '-') ? `<button class="detail-action-btn" id="modal-edit-btn">✏️ 編集</button>` : '';
  const deleteBtnHtml = (item.id && item.id !== '-' && !isEpic) ? `<button class="detail-action-btn danger" id="modal-delete-btn">🗑 削除</button>` : '';

  // GitHub Issue紐付けボタン（BT-122: カードと同じ操作を詳細モーダルにも配備）
  const githubLinkBtnHtml = (item.id && item.id !== '-' && !item.githubIssueNumber)
    ? `<button class="add-child-btn" id="modal-github-link-btn">🔗 GitHub Issueと紐づける</button>`
    : '';

  // GitHub Issue新規作成ボタン（BT-134: Epicの場合は子タスクもsub-issueとして一括作成）
  const githubCreateBtnHtml = (item.id && item.id !== '-' && !item.githubIssueNumber)
    ? `<button class="add-child-btn" id="modal-github-create-btn">📤 GitHub Issueを新規作成</button>`
    : '';

  // ワークスペース導線ボタン（BT-053）
  const workspaceActionHtml = buildWorkspaceActionHtml(item);

  // ワークスペース移管ボタン（BT-063: 子ありEpicはサーバー側でも拒否されるため出さない）
  const moveActionHtml = (!isEpic && item.status !== '完了') ? buildMoveActionHtml(item) : '';

  body.innerHTML = `
    <div class="detail-header">
      ${detailSpinner}<span class="detail-id">${escapeHtml(item.id || '-')}</span>
      ${statusBadge}
      ${badgeHtml}
      ${project}${category}${githubBadge}
    </div>
    <h3 class="detail-title">${escapeHtml(item.title)}</h3>
    ${desc}
    ${artifactsHtml}
    ${metaHtml}
    ${actionsRow(editBtnHtml, deleteBtnHtml)}
    ${actionsRow(addChildBtn, setParentBtn)}
    ${actionsRow(workspaceActionHtml, moveActionHtml)}
    ${actionsRow(githubLinkBtnHtml, githubCreateBtnHtml)}
    ${miniBoard}
  `;

  // 説明欄の折りたたみトグル初期化（BT-080）
  setupDescriptionToggle(body);

  // 「戻る」ボタンのイベント
  const backBtn = body.querySelector('#modal-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const epic = modalParentEpic;
      modalParentEpic = null;
      currentModalItemId = epic.id;
      renderModalContent(epic);
    });
  }

  // 子タスク追加ボタンのイベント
  const childBtn = body.querySelector('#modal-add-child-btn');
  if (childBtn) {
    childBtn.addEventListener('click', () => {
      openAddTaskForm('未着手', item.project, item.id);
    });
  }

  // 親を設定ボタンのイベント（BT-034）
  const setParentBtnEl = body.querySelector('#modal-set-parent-btn');
  if (setParentBtnEl) {
    setParentBtnEl.addEventListener('click', () => {
      openParentPicker([item.id]);
    });
  }

  // GitHub Issue紐付けボタンのイベント（BT-122）
  const githubLinkBtnEl = body.querySelector('#modal-github-link-btn');
  if (githubLinkBtnEl) {
    githubLinkBtnEl.addEventListener('click', () => openGithubLinkModal(item, false));
  }

  // GitHub Issue新規作成ボタンのイベント（BT-134）
  const githubCreateBtnEl = body.querySelector('#modal-github-create-btn');
  if (githubCreateBtnEl) {
    githubCreateBtnEl.addEventListener('click', () => openGithubCreateConfirm(item, false));
  }

  // 編集ボタンのイベント（BT-036: 完了済み単発タスクは説明編集不可）
  const editBtnEl = body.querySelector('#modal-edit-btn');
  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      const isArchivedSingle = !isEpic && item.status === '完了';
      enterEditMode(item, body, false, isArchivedSingle, renderModalContent);
    });
  }

  // 削除ボタンのイベント（BT-031）
  const deleteBtnEl = body.querySelector('#modal-delete-btn');
  if (deleteBtnEl) {
    deleteBtnEl.addEventListener('click', () => {
      openDeleteConfirm(item, false);
    });
  }

  // 成果物コピーボタンのイベント
  setupArtifactCopyButtons(body);

  // ワークスペース導線ボタンのイベント（BT-053）
  setupWorkspaceActionButtons(body, item);

  // プロジェクト移管ボタンのイベント（BT-063）
  setupMoveActionButton(body, item, false);

  if (isEpic) buildMiniBoard(item);
}

function buildMiniBoard(epic) {
  const container = document.getElementById('mini-board');
  if (!container) return;
  container.innerHTML = '';

  const children = epic.children || [];
  const columns = currentBoardData.columns;

  for (const col of columns) {
    const isDoneCol = col.compact || col.id === 'done';
    let matchedChildren = children.filter(c => col.match.includes(c.status));
    // 完了カラムは日付降順、同日内はID降順ソート（completedDateがないものは末尾）
    if (isDoneCol) {
      matchedChildren = [...matchedChildren].sort((a, b) => {
        if (a.completedDate && b.completedDate) {
          const dateCmp = b.completedDate.localeCompare(a.completedDate);
          if (dateCmp !== 0) return dateCmp;
          return (b.id || '').localeCompare(a.id || ''); // 同日ならID降順
        }
        if (a.completedDate && !b.completedDate) return -1;
        if (!a.completedDate && b.completedDate) return 1;
        return 0; // 両方なければ元の順序維持
      });
    }

    // 達成感モード: 完了カラムを本日完了(JST)だけに絞る（doneTodayOnlyはメインと共有）
    const miniDoneTodayActive = isDoneCol && doneTodayOnly;
    if (miniDoneTodayActive) {
      const todayStr = getTodayJST();
      matchedChildren = matchedChildren.filter(c => c.completedDate === todayStr);
    }

    // limit 制御（完了カラムのみ・メインボードと同じ思想）。
    // 「本日完了だけ」表示中はlimitを無視して全件出す。
    const miniLimitDefault = isDoneCol ? (col.limit || null) : null;
    const miniLimitKey = 'miniColLimit_' + col.id;
    const miniLimit = miniLimitDefault ? parseInt(localStorage.getItem(miniLimitKey) || miniLimitDefault, 10) : null;
    const miniTotalBeforeLimit = matchedChildren.length;
    const miniExpanded = expandedMiniCols.has(col.id);
    let miniHidden = 0;
    if (miniLimit && miniTotalBeforeLimit > miniLimit && !miniExpanded && !miniDoneTodayActive) {
      miniHidden = miniTotalBeforeLimit - miniLimit;
      matchedChildren = matchedChildren.slice(0, miniLimit);
    }

    const colEl = document.createElement('div');
    colEl.className = 'mini-col';

    // 完了カラム用「本日完了だけ」トグル＋達成感カウント
    const doneTodayToggleHtml = isDoneCol
      ? `<button class="done-today-btn${doneTodayOnly ? ' filter-active' : ''}" data-mini-done-today="1" title="本日完了分のみ表示（達成感モード）">🎉 今日</button>`
      : '';
    let countHtml;
    if (miniDoneTodayActive) {
      countHtml = `<span class="count done-today-count">🎉 ${matchedChildren.length}</span>`;
    } else if (miniLimit) {
      countHtml = `<input type="number" class="limit-input mini-limit-input" value="${miniLimit}" min="1" max="${miniTotalBeforeLimit}" data-col-id="${col.id}" title="表示件数 (全${miniTotalBeforeLimit}件)"><span class="count-total">/ ${miniTotalBeforeLimit}</span>`;
    } else {
      countHtml = `<span class="count">${matchedChildren.length}</span>`;
    }

    colEl.innerHTML = `
      <div class="mini-col-header">
        <span>${col.label}</span>
        <div class="column-header-right">
          ${doneTodayToggleHtml}
          ${countHtml}
          <button class="add-task-btn add-task-btn-mini" data-col-status="${col.match[0]}" data-parent-id="${epic.id}" data-project="${epic.project}" title="子タスク追加">+</button>
        </div>
      </div>
      <div class="mini-col-body"></div>
    `;

    const body = colEl.querySelector('.mini-col-body');
    setupDropZone(body, col.id, col.match, true, epic.id);

    for (const child of matchedChildren) {
      const card = document.createElement('div');
      card.className = 'card card-child card-draggable';
      if (child.todayFlag) card.classList.add('card-today');
      if (child.running) card.classList.add('is-running');
      card.dataset.project = epic.project;
      card.setAttribute('draggable', 'true');
      card.dataset.taskId = child.id;

      card.addEventListener('dragstart', (e) => {
        dragData = { id: child.id, isChild: true, sourceColId: col.id, parentId: epic.id };
        card.classList.add('card-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', child.id);
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('card-dragging');
        dragData = null;
        document.querySelectorAll('.mini-col-body.drop-over').forEach(el => el.classList.remove('drop-over'));
        document.querySelectorAll('.card-drop-above').forEach(el => el.classList.remove('card-drop-above'));
        document.querySelectorAll('.card-drop-below').forEach(el => el.classList.remove('card-drop-below'));
      });

      const childSpinner = child.running ? '<span class="running-spinner"></span>' : '';
      const childId = child.id ? `<div class="card-id">${childSpinner}${escapeHtml(child.id)}</div>` : '';
      const childTitle = `<div class="card-title">${escapeHtml(child.title)}</div>`;

      const mParts = [];
      if (child.category && child.category !== '-') {
        mParts.push(`<span class="card-tag category">${escapeHtml(child.category)}</span>`);
      }
      if (child.assignee) {
        mParts.push(`<span class="card-tag">${escapeHtml(child.assignee)}</span>`);
      }
      if (child.artifacts && child.artifacts.length > 0) {
        mParts.push('<span class="card-tag artifact-indicator" title="成果物あり">📎</span>');
      }
      if (child.githubIssueNumber) {
        mParts.push(renderGithubIssueBadge(child.githubIssueNumber, child.githubIssueUrl));
      }
      if (child.completedDate) {
        mParts.push(`<span class="card-tag completed-date" title="完了日">${escapeHtml(child.completedDate)}</span>`);
      }
      const mHtml = mParts.length > 0 ? `<div class="card-meta">${mParts.join('')}</div>` : '';

      // 📌 ピンボタン（ミニボード子カード）
      const childPinHtml = child.id
        ? `<button class="today-pin-btn${child.todayFlag ? ' pin-active' : ''}" data-task-id="${child.id}" data-is-child="true" title="今日やる">📌</button>`
        : '';

      // ✏️🔗🗑 編集・GitHub紐付け・削除ボタン（ミニボード子カード、BT-041: 子タスクは常に単独削除可。BT-122でGitHub紐付けボタンを追加）
      const childActionsHtml = child.id
        ? `<div class="card-actions">
            <button class="card-action-btn card-child-edit-btn" data-task-id="${child.id}" title="編集">✏️</button>
            ${!child.githubIssueNumber ? `<button class="card-action-btn card-child-github-link-btn" data-task-id="${child.id}" title="GitHub Issueと紐づける">🔗</button>` : ''}
            ${!child.githubIssueNumber ? `<button class="card-action-btn card-child-github-create-btn" data-task-id="${child.id}" title="GitHub Issueを新規作成">📤</button>` : ''}
            <button class="card-action-btn card-child-delete-btn danger" data-task-id="${child.id}" title="削除">🗑</button>
          </div>`
        : '';

      card.innerHTML = `${childPinHtml}${childActionsHtml}${childId}${childTitle}${mHtml}`;
      card.classList.add('card-clickable');
      card.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        // childにproject情報を付与（リンク生成用）
        const childWithProject = { ...child, project: epic.project };
        openCardDetail(childWithProject, epic);
      });

      // 編集ボタンのイベント（BT-041）
      const childEditBtnEl = card.querySelector('.card-child-edit-btn');
      if (childEditBtnEl) {
        childEditBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const childWithProject = { ...child, project: epic.project };
          openChildCardEditDirect(childWithProject, epic);
        });
      }

      // 削除ボタンのイベント（BT-041）
      const childDeleteBtnEl = card.querySelector('.card-child-delete-btn');
      if (childDeleteBtnEl) {
        childDeleteBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const childWithProject = { ...child, project: epic.project };
          openDeleteConfirm(childWithProject, true);
        });
      }

      const childGithubBadgeEl = card.querySelector('.github-issue-badge');
      if (childGithubBadgeEl) {
        childGithubBadgeEl.addEventListener('click', (e) => e.stopPropagation());
      }

      // GitHub Issue紐付けボタンのイベント（BT-122）
      const childGithubLinkBtnEl = card.querySelector('.card-child-github-link-btn');
      if (childGithubLinkBtnEl) {
        childGithubLinkBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const childWithProject = { ...child, project: epic.project };
          openGithubLinkModal(childWithProject, true);
        });
      }

      // GitHub Issue新規作成ボタンのイベント（BT-134）
      const childGithubCreateBtnEl = card.querySelector('.card-child-github-create-btn');
      if (childGithubCreateBtnEl) {
        childGithubCreateBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const childWithProject = { ...child, project: epic.project };
          openGithubCreateConfirm(childWithProject, true);
        });
      }

      body.appendChild(card);
    }

    // 達成感モードで本日完了ゼロのときの空状態（ミニボード用・コンパクト）
    if (miniDoneTodayActive && matchedChildren.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'done-today-empty done-today-empty-mini';
      empty.innerHTML = `<span class="done-today-empty-emoji">🌱</span><span>今日はまだ</span>`;
      body.appendChild(empty);
    }

    // limit超過分の「他N件」まとめカード／展開中は折りたたみカード（達成感モード中は出さない）
    if (isDoneCol && !miniDoneTodayActive) {
      if (miniHidden > 0) {
        const summary = document.createElement('div');
        summary.className = 'card card-child card-summary';
        summary.innerHTML = `<span class="summary-label">他 ${miniHidden} 件</span><span class="summary-chevron">▾</span>`;
        summary.title = 'クリックで全件表示';
        summary.addEventListener('click', () => {
          expandedMiniCols.add(col.id);
          buildMiniBoard(epic);
        });
        body.appendChild(summary);
      } else if (miniExpanded && miniLimit && miniTotalBeforeLimit > miniLimit) {
        const collapse = document.createElement('div');
        collapse.className = 'card card-child card-summary card-summary-collapse';
        collapse.innerHTML = `<span class="summary-label">折りたたむ</span><span class="summary-chevron">▴</span>`;
        collapse.title = 'クリックで折りたたむ';
        collapse.addEventListener('click', () => {
          expandedMiniCols.delete(col.id);
          buildMiniBoard(epic);
        });
        body.appendChild(collapse);
      }
    }

    container.appendChild(colEl);
  }

  // ミニボード完了カラムのlimit入力欄にイベント設定
  container.querySelectorAll('.mini-limit-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const colId = e.target.dataset.colId;
      const val = parseInt(e.target.value, 10);
      if (val > 0) {
        localStorage.setItem('miniColLimit_' + colId, val);
        buildMiniBoard(epic);
      }
    });
  });

  // ミニボード内「本日完了だけ」トグルにイベント設定（状態はメインと共有）
  container.querySelectorAll('[data-mini-done-today]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      doneTodayOnly = !doneTodayOnly;
      localStorage.setItem('doneTodayOnly', doneTodayOnly);
      buildMiniBoard(epic);         // ミニボードを再描画
      if (lastBoardData) renderBoard(lastBoardData); // メインボードも同期
    });
  });

  // ミニボード内の+ボタンにイベント設定
  container.querySelectorAll('.add-task-btn-mini').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddTaskForm(btn.dataset.colStatus, btn.dataset.project, btn.dataset.parentId);
    });
  });

  // ミニボード内の📌ピンボタンにイベント設定
  container.querySelectorAll('.today-pin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const taskId = btn.dataset.taskId;
      const isChild = btn.dataset.isChild === 'true';
      const isActive = btn.classList.contains('pin-active');
      toggleTodayFlag(taskId, isChild, !isActive);
    });
  });
}

function setupCardClick(card, item) {
  card.addEventListener('click', (ev) => {
    if (ev.defaultPrevented) return;
    if (selectionMode) {
      toggleCardSelection(item);
      return;
    }
    openCardDetail(item);
  });
}

// --- 複数選択→親付け (BT-034) ---
function toggleCardSelection(item) {
  if (!item.id || item.id === '-') return;
  const isEpic = item.childrenTotal > 0;
  const isDone = item.status === '完了';
  if (isEpic || isDone) return; // 選択不可（グレーアウト対象と同条件）
  if (selectedIds.has(item.id)) selectedIds.delete(item.id);
  else selectedIds.add(item.id);
  renderBoard(lastBoardData);
}

let selectionBarEl = null;

function getOrCreateSelectionBar() {
  if (selectionBarEl) return selectionBarEl;
  selectionBarEl = document.createElement('div');
  selectionBarEl.className = 'selection-bar';
  selectionBarEl.innerHTML = `
    <span class="selection-bar-count"></span>
    <button class="selection-bar-btn selection-bar-parent" id="selection-pick-parent">親を選ぶ</button>
    <button class="selection-bar-btn selection-bar-move" id="selection-pick-move">🚚 移動</button>
    <button class="selection-bar-btn selection-bar-github" id="selection-github-create">📤 GitHub登録</button>
    <button class="selection-bar-btn selection-bar-delete danger" id="selection-delete">🗑 削除</button>
    <button class="selection-bar-btn selection-bar-cancel" id="selection-cancel">キャンセル</button>
  `;
  document.body.appendChild(selectionBarEl);
  selectionBarEl.querySelector('#selection-pick-parent').addEventListener('click', () => openParentPicker());
  selectionBarEl.querySelector('#selection-pick-move').addEventListener('click', () => openMovePicker(null, false));
  selectionBarEl.querySelector('#selection-github-create').addEventListener('click', () => openBulkGithubCreateConfirm());
  selectionBarEl.querySelector('#selection-delete').addEventListener('click', () => openBulkDeleteConfirm());
  selectionBarEl.querySelector('#selection-cancel').addEventListener('click', () => {
    selectionMode = false;
    selectedIds.clear();
    document.getElementById('select-mode-btn').classList.remove('filter-active');
    renderBoard(lastBoardData);
  });
  return selectionBarEl;
}

/**
 * 一括削除確認モーダルを開く（BT-042）
 */
function openBulkDeleteConfirm() {
  const taskIds = [...selectedIds];
  if (taskIds.length === 0) return;

  const el = getOrCreateDeleteConfirm();
  const content = el.querySelector('.modal-content');
  content.innerHTML = `
    <button class="modal-close" id="delete-confirm-close">&times;</button>
    <h3 class="add-form-title">タスクを一括削除</h3>
    <p class="delete-confirm-text">選択中の ${taskIds.length}件 を削除するよ。元に戻せないけど大丈夫?</p>
    <p class="delete-confirm-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit danger" id="delete-confirm-ok">削除する</button>
      <button class="add-child-btn" id="delete-confirm-cancel">キャンセル</button>
    </div>
  `;

  content.querySelector('#delete-confirm-close').addEventListener('click', closeDeleteConfirm);
  content.querySelector('#delete-confirm-cancel').addEventListener('click', closeDeleteConfirm);
  content.querySelector('#delete-confirm-ok').addEventListener('click', async () => {
    const errorEl = content.querySelector('.delete-confirm-error');
    try {
      const resp = await fetch('/api/delete-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errorEl.textContent = `削除に失敗したよ: ${data.error || ''}`;
        errorEl.style.display = 'block';
        return;
      }
      closeDeleteConfirm();
      if (data.failed && data.failed.length > 0) {
        const reasons = data.failed.map(f => `${f.taskId}(${f.error})`).join(', ');
        alert(`${data.succeeded.length}件削除したよ。${data.failed.length}件は失敗: ${reasons}`);
      }
      selectionMode = false;
      selectedIds.clear();
      document.getElementById('select-mode-btn').classList.remove('filter-active');
      renderBoard(lastBoardData);
    } catch (e) {
      console.error('[bulk-delete] Network error:', e);
      errorEl.textContent = 'ネットワークエラーが発生したよ';
      errorEl.style.display = 'block';
    }
  });

  el.classList.add('modal-visible');
}

function updateSelectionBar() {
  if (!selectionMode || selectedIds.size === 0) {
    if (selectionBarEl) selectionBarEl.classList.remove('selection-bar-visible');
    return;
  }
  const bar = getOrCreateSelectionBar();
  bar.querySelector('.selection-bar-count').textContent = `${selectedIds.size}件選択中`;
  bar.classList.add('selection-bar-visible');
}

let parentPickerEl = null;

function getOrCreateParentPicker() {
  if (parentPickerEl) return parentPickerEl;
  parentPickerEl = document.createElement('div');
  parentPickerEl.className = 'modal-overlay';
  parentPickerEl.innerHTML = `
    <div class="modal-content parent-picker-modal">
      <button class="modal-close" id="parent-picker-close">&times;</button>
      <h3 class="add-form-title">親タスクを選ぶ</h3>
      <button class="parent-picker-new-btn" id="parent-picker-new">＋ 新しい親タスクを作る</button>
      <input type="text" id="parent-picker-search" class="parent-picker-search" placeholder="検索...">
      <div class="parent-picker-list" id="parent-picker-list"></div>
    </div>
  `;
  document.body.appendChild(parentPickerEl);
  parentPickerEl.addEventListener('click', (e) => {
    if (e.target === parentPickerEl) closeParentPicker();
  });
  parentPickerEl.querySelector('#parent-picker-close').addEventListener('click', closeParentPicker);
  parentPickerEl.querySelector('#parent-picker-new').addEventListener('click', openNewParentForm);
  parentPickerEl.querySelector('#parent-picker-search').addEventListener('input', (e) => {
    renderParentPickerList(e.target.value);
  });
  return parentPickerEl;
}

// --- プロジェクト移管 (BT-063) ---
let pendingMoveIds = [];
let moveIsChild = false;
let movePickerEl = null;

function getOrCreateMovePicker() {
  if (movePickerEl) return movePickerEl;
  movePickerEl = document.createElement('div');
  movePickerEl.className = 'modal-overlay';
  movePickerEl.innerHTML = `
    <div class="modal-content parent-picker-modal">
      <button class="modal-close" id="move-picker-close">&times;</button>
      <h3 class="add-form-title">移動先プロジェクトを選ぶ</h3>
      <div class="parent-picker-list" id="move-picker-list"></div>
    </div>
  `;
  document.body.appendChild(movePickerEl);
  movePickerEl.addEventListener('click', (e) => {
    if (e.target === movePickerEl) closeMovePicker();
  });
  movePickerEl.querySelector('#move-picker-close').addEventListener('click', closeMovePicker);
  return movePickerEl;
}

function closeMovePicker() {
  if (movePickerEl) movePickerEl.classList.remove('modal-visible');
  pendingMoveIds = [];
}

/**
 * 移動先プロジェクトのピッカーを開く
 * @param {string[]|null} idsOverride - 単独タスク詳細から呼ぶ場合のID配列。nullなら複数選択中のIDを使う
 * @param {boolean} isChild - 移動元がh4子タスクか
 */
function openMovePicker(idsOverride, isChild) {
  pendingMoveIds = (idsOverride && idsOverride.length > 0) ? idsOverride : [...selectedIds];
  if (pendingMoveIds.length === 0) return;
  moveIsChild = !!isChild;

  const items = pendingMoveIds.map(id => findItemById(id)).filter(Boolean);
  const currentProjects = new Set(items.map(i => i.project));

  const picker = getOrCreateMovePicker();
  const listEl = picker.querySelector('#move-picker-list');
  const projectFileMap = (currentBoardData && currentBoardData.projectFileMap) || {};
  const projectNames = (currentBoardData && currentBoardData.projects) || [];

  // 移動元と同じプロジェクトは候補から除外（複数選択で複数プロジェクトにまたがる場合はどちらも除外）
  const candidates = projectNames.filter(name => projectFileMap[name] && !currentProjects.has(name));

  if (candidates.length === 0) {
    listEl.innerHTML = '<div class="parent-picker-empty">移動できる別プロジェクトがないよ</div>';
  } else {
    listEl.innerHTML = candidates.map(name => {
      return `<div class="parent-picker-item" data-file="${escapeHtml(projectFileMap[name])}">
        <span class="parent-picker-item-title">${escapeHtml(name)}</span>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.parent-picker-item').forEach(el => {
      el.addEventListener('click', () => confirmMove(el.dataset.file));
    });
  }

  picker.classList.add('modal-visible');
}

/**
 * 選択中タスクを移動先プロジェクトへ移管する（1件ずつ順にAPIを呼ぶ）
 * @param {string} targetFile - 移動先プロジェクトのfile名
 */
async function confirmMove(targetFile) {
  const taskIds = pendingMoveIds.length > 0 ? pendingMoveIds : [...selectedIds];
  const isChild = moveIsChild;
  const succeeded = [];
  const failed = [];

  for (const taskId of taskIds) {
    try {
      const resp = await fetch('/api/move-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, targetFile, isChild }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        failed.push({ taskId, error: data.error || '' });
      } else {
        succeeded.push({ taskId, newId: data.newId });
      }
    } catch (e) {
      console.error('[move-task] Network error:', e);
      failed.push({ taskId, error: 'network' });
    }
  }

  closeMovePicker();
  if (failed.length > 0) {
    const reasons = failed.map(f => `${f.taskId}(${f.error})`).join(', ');
    alert(`${succeeded.length}件移管したよ。${failed.length}件は失敗: ${reasons}`);
  }

  // 単独タスク詳細から実行した場合、そのタスクは別プロジェクトへ移ったので詳細モーダルも閉じる
  if (isChild) {
    closeChildModal();
  } else if (currentModalItemId && taskIds.includes(currentModalItemId)) {
    closeModal();
  }

  selectionMode = false;
  selectedIds.clear();
  const selectBtn = document.getElementById('select-mode-btn');
  if (selectBtn) selectBtn.classList.remove('filter-active');
  renderBoard(lastBoardData);
}

function openParentPicker(idsOverride) {
  pendingAttachIds = (idsOverride && idsOverride.length > 0) ? idsOverride : [...selectedIds];
  if (pendingAttachIds.length === 0) return;
  const items = pendingAttachIds.map(id => findItemById(id)).filter(Boolean);
  const projects = new Set(items.map(i => i.project));
  if (projects.size > 1) {
    alert('選択したタスクが複数のプロジェクトにまたがっているよ。同じプロジェクト内のタスクだけ選んでね');
    return;
  }
  parentPickerProject = items[0] ? items[0].project : '';

  const picker = getOrCreateParentPicker();
  // 新規作成フォームを表示中だった場合に備えて一覧UIへ戻す
  picker.querySelector('.modal-content').innerHTML = `
    <button class="modal-close" id="parent-picker-close">&times;</button>
    <h3 class="add-form-title">親タスクを選ぶ</h3>
    <button class="parent-picker-new-btn" id="parent-picker-new">＋ 新しい親タスクを作る</button>
    <input type="text" id="parent-picker-search" class="parent-picker-search" placeholder="検索...">
    <div class="parent-picker-list" id="parent-picker-list"></div>
  `;
  picker.querySelector('#parent-picker-close').addEventListener('click', closeParentPicker);
  picker.querySelector('#parent-picker-new').addEventListener('click', openNewParentForm);
  picker.querySelector('#parent-picker-search').addEventListener('input', (e) => {
    renderParentPickerList(e.target.value);
  });

  renderParentPickerList('');
  picker.classList.add('modal-visible');
}

function closeParentPicker() {
  if (parentPickerEl) parentPickerEl.classList.remove('modal-visible');
  pendingAttachIds = [];
}

function renderParentPickerList(query) {
  const listEl = parentPickerEl.querySelector('#parent-picker-list');
  if (!listEl || !currentBoardData) return;

  const q = query.trim().toLowerCase();
  const candidates = [];
  // ボード表示順（🔥アクティブ→💡保留、完了カラムは除外）で同一プロジェクトの候補を収集
  for (const col of currentBoardData.columns) {
    if (col.compact || col.id === 'done') continue;
    for (const item of col.items) {
      if (!item.id || item.id === '-') continue;
      if (item.project !== parentPickerProject) continue;
      if (pendingAttachIds.includes(item.id)) continue; // アタッチ対象の自分自身は親にできない
      if (q && !(item.title.toLowerCase().includes(q) || item.id.toLowerCase().includes(q))) continue;
      candidates.push(item);
    }
  }

  if (candidates.length === 0) {
    listEl.innerHTML = '<div class="parent-picker-empty">候補がないよ</div>';
    return;
  }

  listEl.innerHTML = candidates.map(item => {
    const badge = item.childrenTotal
      ? `<span class="card-badge"><span class="badge-num">${item.childrenDone}</span><span class="badge-den">/${item.childrenTotal}</span></span>`
      : '';
    return `<div class="parent-picker-item" data-id="${escapeHtml(item.id)}">
      <span class="parent-picker-item-id">${escapeHtml(item.id)}</span>
      <span class="parent-picker-item-title">${escapeHtml(item.title)}</span>
      ${badge}
    </div>`;
  }).join('');

  listEl.querySelectorAll('.parent-picker-item').forEach(el => {
    el.addEventListener('click', () => confirmAttach(el.dataset.id));
  });
}

function openNewParentForm() {
  const picker = getOrCreateParentPicker();
  const content = picker.querySelector('.modal-content');
  content.querySelector('#parent-picker-search').style.display = 'none';
  content.querySelector('#parent-picker-list').innerHTML = `
    <div class="parent-picker-new-form">
      <input type="text" id="new-parent-title" class="parent-picker-search" placeholder="新しい親タスクのタイトル">
      <button class="add-task-submit" id="new-parent-submit">作成してアタッチ</button>
    </div>
  `;
  const titleInput = content.querySelector('#new-parent-title');
  content.querySelector('#new-parent-submit').addEventListener('click', () => submitNewParent(titleInput.value));
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNewParent(titleInput.value); });
  setTimeout(() => titleInput.focus(), 50);
}

async function submitNewParent(title) {
  title = (title || '').trim();
  if (!title) return;
  try {
    const resp = await fetch('/api/add-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, project: parentPickerProject, status: '未着手', origin: 'user' }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('[attach] add-task failed:', data.error);
      alert(`親タスクの作成に失敗したよ: ${data.error || ''}`);
      return;
    }
    await confirmAttach(data.id);
  } catch (e) {
    console.error('[attach] Network error:', e);
  }
}

async function confirmAttach(parentId) {
  const taskIds = pendingAttachIds.length > 0 ? pendingAttachIds : [...selectedIds];
  try {
    const resp = await fetch('/api/attach-to-parent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds, parentId }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('[attach] Failed:', data.error, data.failed);
      alert(`アタッチに失敗したよ: ${data.error || ''}`);
      return;
    }
    if (data.failed && data.failed.length > 0) {
      alert(`${data.attached.length}件はアタッチできたけど、${data.failed.length}件は失敗したよ(${data.failed.map(f => f.id).join(', ')})`);
    }
    closeParentPicker();
    // 単独タスク詳細から実行した場合、そのタスクはもう子になったので詳細モーダルも閉じる
    if (currentModalItemId && taskIds.includes(currentModalItemId)) {
      closeModal();
    }
    selectionMode = false;
    selectedIds.clear();
    pendingAttachIds = [];
    document.getElementById('select-mode-btn').classList.remove('filter-active');
    renderBoard(lastBoardData);
  } catch (e) {
    console.error('[attach] Network error:', e);
  }
}

// --- Workspace Create Form (BT-053) ---
let workspaceFormEl = null;

function getOrCreateWorkspaceCreateForm() {
  if (workspaceFormEl) return workspaceFormEl;
  workspaceFormEl = document.createElement('div');
  workspaceFormEl.className = 'modal-overlay';
  workspaceFormEl.innerHTML = `
    <div class="modal-content add-task-modal">
      <button class="modal-close" id="workspace-form-close">&times;</button>
      <h3 class="add-form-title">ワークスペースを作る</h3>
      <div class="settings-group">
        <label>フォルダ名（英数字・_-のみ）</label>
        <input type="text" id="workspace-form-file" placeholder="my-project">
        <p class="workspace-form-path-preview" id="workspace-form-path-preview"></p>
      </div>
      <div class="settings-group">
        <label>プレフィクス（英大文字2文字・タスクIDの接頭辞）</label>
        <input type="text" id="workspace-form-prefix" maxlength="2" placeholder="MP">
      </div>
      <p class="edit-task-error" id="workspace-form-error" style="display:none;"></p>
      <button class="add-task-submit" id="workspace-form-submit">作って開く</button>
    </div>
  `;
  document.body.appendChild(workspaceFormEl);

  workspaceFormEl.addEventListener('click', (e) => {
    if (e.target === workspaceFormEl) closeWorkspaceCreateForm();
  });
  workspaceFormEl.querySelector('#workspace-form-close').addEventListener('click', closeWorkspaceCreateForm);

  const fileInput = workspaceFormEl.querySelector('#workspace-form-file');
  const pathPreview = workspaceFormEl.querySelector('#workspace-form-path-preview');
  fileInput.addEventListener('input', () => updateWorkspacePathPreview(fileInput, pathPreview));

  workspaceFormEl.querySelector('#workspace-form-submit').addEventListener('click', submitCreateWorkspace);

  return workspaceFormEl;
}

function updateWorkspacePathPreview(fileInput, pathPreview) {
  const parent = (currentBoardData && currentBoardData.defaultWorkspaceParent) || '';
  pathPreview.textContent = fileInput.value ? `${parent}/${fileInput.value}` : parent;
}

function openWorkspaceCreateForm() {
  const form = getOrCreateWorkspaceCreateForm();
  const fileInput = form.querySelector('#workspace-form-file');
  const prefixInput = form.querySelector('#workspace-form-prefix');
  const pathPreview = form.querySelector('#workspace-form-path-preview');
  const errorEl = form.querySelector('#workspace-form-error');

  fileInput.value = '';
  prefixInput.value = '';
  errorEl.style.display = 'none';
  updateWorkspacePathPreview(fileInput, pathPreview);

  form.classList.add('modal-visible');
  setTimeout(() => fileInput.focus(), 100);
}

function closeWorkspaceCreateForm() {
  if (workspaceFormEl) workspaceFormEl.classList.remove('modal-visible');
}

async function submitCreateWorkspace() {
  const form = getOrCreateWorkspaceCreateForm();
  const file = form.querySelector('#workspace-form-file').value.trim();
  const prefix = form.querySelector('#workspace-form-prefix').value.trim().toUpperCase();
  const errorEl = form.querySelector('#workspace-form-error');
  const parent = (currentBoardData && currentBoardData.defaultWorkspaceParent) || '';

  if (!file || !/^[A-Za-z0-9_-]+$/.test(file)) {
    errorEl.textContent = 'フォルダ名は英数字・_-のみで入力してね';
    errorEl.style.display = 'block';
    return;
  }
  if (!prefix || !/^[A-Z]{2}$/.test(prefix)) {
    errorEl.textContent = 'プレフィクスは英大文字2文字で入力してね';
    errorEl.style.display = 'block';
    return;
  }

  const workspace = parent ? `${parent}/${file}` : file;

  try {
    const resp = await fetch('/api/create-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, prefix, workspace }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      errorEl.textContent = `作成に失敗したよ: ${data.error || ''}`;
      errorEl.style.display = 'block';
      return;
    }
    closeWorkspaceCreateForm();
  } catch (e) {
    console.error('[create-workspace] Network error:', e);
    errorEl.textContent = 'ネットワークエラーが発生したよ';
    errorEl.style.display = 'block';
  }
}

// --- Add Task Form ---
let addFormEl = null;

function getOrCreateAddForm() {
  if (addFormEl) return addFormEl;
  addFormEl = document.createElement('div');
  addFormEl.className = 'modal-overlay';
  addFormEl.innerHTML = `
    <div class="modal-content add-task-modal">
      <button class="modal-close" id="add-form-close">&times;</button>
      <h3 class="add-form-title">タスク追加</h3>
      <div class="settings-group">
        <label>タイトル</label>
        <input type="text" id="add-task-title" placeholder="やりたいことを一言で">
      </div>
      <div class="settings-group">
        <label>説明（任意）</label>
        <textarea id="add-task-description" rows="4" placeholder="補足があれば"></textarea>
      </div>
      <div class="settings-group">
        <label>ワークスペース</label>
        <select id="add-task-project">
          <option value="inbox">未ワークスペース (Inbox)</option>
        </select>
      </div>
      <div class="settings-group">
        <label>ステータス</label>
        <select id="add-task-status">
          <option value="未着手">未着手</option>
          <option value="進行中">進行中</option>
          <option value="保留">保留</option>
        </select>
      </div>
      <button class="add-task-submit" id="add-task-submit">追加</button>
    </div>
  `;
  document.body.appendChild(addFormEl);

  addFormEl.addEventListener('click', (e) => {
    if (e.target === addFormEl) closeAddForm();
  });
  addFormEl.querySelector('#add-form-close').addEventListener('click', closeAddForm);

  addFormEl.querySelector('#add-task-submit').addEventListener('click', submitAddTask);

  // Enterキーで送信
  addFormEl.querySelector('#add-task-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAddTask();
  });

  return addFormEl;
}

function openAddTaskForm(defaultStatus, defaultProject, parentId) {
  const form = getOrCreateAddForm();
  // 同じz-index(1000)の他モーダル(EPIC詳細など)より必ず手前に出すため、
  // 表示するたびDOM末尾に移動する（BT-118: ミニボードから開くとEPIC画面の後ろに隠れる問題の修正）
  document.body.appendChild(form);

  // プロジェクト選択肢を更新
  const projectSelect = form.querySelector('#add-task-project');
  projectSelect.innerHTML = '<option value="inbox">未ワークスペース (Inbox)</option>';
  if (currentBoardData && currentBoardData.projects) {
    for (const p of currentBoardData.projects) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      projectSelect.appendChild(opt);
    }
  }

  // デフォルトプロジェクト設定
  if (defaultProject) {
    projectSelect.value = defaultProject;
  }

  // 親ID保持（子タスク追加用）
  form.dataset.parentId = parentId || '';

  // 子タスク追加時はラベルを変える
  const titleLabel = form.querySelector('.add-form-title');
  if (parentId) {
    titleLabel.textContent = `子タスク追加 (${parentId})`;
    projectSelect.disabled = true;
  } else {
    titleLabel.textContent = 'タスク追加';
    projectSelect.disabled = false;
  }

  // ステータスのデフォルト値
  if (defaultStatus) {
    form.querySelector('#add-task-status').value = defaultStatus;
  }

  // タイトル・説明をクリア＆フォーカス
  const titleInput = form.querySelector('#add-task-title');
  titleInput.value = '';
  form.querySelector('#add-task-description').value = '';

  form.classList.add('modal-visible');
  setTimeout(() => titleInput.focus(), 100);
}

function closeAddForm() {
  if (addFormEl) addFormEl.classList.remove('modal-visible');
}

async function submitAddTask() {
  const form = getOrCreateAddForm();
  const title = form.querySelector('#add-task-title').value.trim();
  const description = form.querySelector('#add-task-description').value.trim();
  const project = form.querySelector('#add-task-project').value;
  const status = form.querySelector('#add-task-status').value;
  const parentId = form.dataset.parentId || '';

  if (!title) {
    form.querySelector('#add-task-title').focus();
    return;
  }

  try {
    const body = { title, project, status, origin: 'user' };
    if (description) body.description = description;
    if (parentId) body.parentId = parentId;

    const resp = await fetch('/api/add-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.ok) {
      closeAddForm();
    } else {
      const err = await resp.json();
      console.error('[add-task] Failed:', err.error);
    }
  } catch (e) {
    console.error('[add-task] Network error:', e);
  }
}

// --- Init ---
applySettings();
connect();
