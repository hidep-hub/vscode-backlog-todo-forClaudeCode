'use strict';

// BT-341: ワークスペースバッジの集計対象モード（localStorageに保存）
const BADGE_MODES = {
  do: { label: 'DOのみ', codes: ['do'] },
  doReady: { label: 'DO+READY', codes: ['do', 'ready'] },
  notDone: { label: 'DONE以外', codes: ['todo', 'ready', 'do'] },
};
const BADGE_MODE_KEY = 'badgeMode';
let badgeMode = 'notDone';
try {
  const saved = localStorage.getItem(BADGE_MODE_KEY);
  if (saved && BADGE_MODES[saved]) badgeMode = saved;
} catch (_) {}

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const wsFilterWrapEl = document.getElementById('ws-filter-wrap');
const wsFilterTriggerEl = document.getElementById('ws-filter-trigger');
const wsFilterTriggerLabelEl = document.getElementById('ws-filter-trigger-label');
const wsFilterMenuEl = document.getElementById('ws-filter-menu');
const boardLaneModeBtnEl = document.getElementById('board-lane-mode-btn'); // BM-049: All Projects時のレーン/一枚ボード切替
const searchBtn = document.getElementById('search-btn');
const planBtn = document.getElementById('plan-btn');
const themeSelectEl = document.getElementById('theme-select');
const headerSearchInput = document.getElementById('header-search-input');
const githubImportBtn = document.getElementById('github-import-btn');
const headerLogoEl = document.getElementById('header-logo');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const settingsThemeEl = document.getElementById('settings-theme');
const workspaceThemeSettingsEl = document.getElementById('settings-workspace-theme');
const workspaceThemeLabelEl = document.getElementById('settings-workspace-theme-label');
const themePresetGridEl = document.getElementById('theme-preset-grid');
const workspaceThemeSaveEl = document.getElementById('settings-workspace-theme-save');
const settingsWorkspaceEl = document.getElementById('settings-workspace');
const settingsGithubRepoUrlEl = document.getElementById('settings-github-repo-url');
const settingsGithubTokenEl = document.getElementById('settings-github-token');
const settingsGithubStatusEl = document.getElementById('settings-github-status');
const settingsGithubSaveEl = document.getElementById('settings-github-save');
const settingsGithubHintEl = document.getElementById('settings-github-hint');
// BM-073: Redmine連携設定(ワークスペース単位のプロジェクトURL、ホスト単位のトークン)
const settingsRedmineProjectUrlEl = document.getElementById('settings-redmine-project-url');
const settingsRedmineTokenEl = document.getElementById('settings-redmine-token');
const settingsRedmineStatusEl = document.getElementById('settings-redmine-status');
const settingsRedmineSaveEl = document.getElementById('settings-redmine-save');
// BM-074: GitLab連携設定(Redmineと同じ構成)
const settingsGitlabProjectUrlEl = document.getElementById('settings-gitlab-project-url');
const settingsGitlabTokenEl = document.getElementById('settings-gitlab-token');
const settingsGitlabStatusEl = document.getElementById('settings-gitlab-status');
const settingsGitlabSaveEl = document.getElementById('settings-gitlab-save');

// 重なったモーダルでは、最前面だけを Escape で閉じる。
// z-index が同じ場合はDOM末尾の要素が前面になるCSSの規則にも従う。
function isTopmostDialog(el) {
  const visible = document.querySelectorAll(
    '.modal-overlay.modal-visible, .settings-overlay.settings-visible, .plan-board-overlay.active, .activity-modal-overlay.modal-visible, .backup-modal-overlay.modal-visible, .tag-modal-overlay.modal-visible, .category-modal-overlay.modal-visible, .ui-dialog-overlay.modal-visible'
  );
  let top = null;
  let topLayer = -Infinity;
  for (const candidate of visible) {
    const layer = Number.parseInt(window.getComputedStyle(candidate).zIndex, 10) || 0;
    if (layer >= topLayer) {
      top = candidate;
      topLayer = layer;
    }
  }
  return top === el;
}

// capture で消費することで、背後にある詳細モーダルへ Escape が届かないようにする。
let parentFieldListOpen = false; // BT-432: 親タスク選択コンボボックスの候補リストが開いているか
function closeOnEscape(el, visibleClass, close) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !el.classList.contains(visibleClass) || !isTopmostDialog(el)) return;
    if (dueDatePickerEl) return; // 期日カレンダー表示中は、カレンダー側のEscで先に閉じる（BT-354）
    if (wsFilterMenuOpen) return; // BM-029: ワークスペース絞り込みドロップダウン表示中は、そちら側のEscで先に閉じる
    if (parentFieldListOpen) return; // BT-432: 親タスク候補リスト表示中は、リスト側のEscで先に閉じる
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }, true);
}

// BT-168: フォームの「開いた時点の値」と現在値を比較し、差分があるかを返す。
// 編集モードの保存ボタン活性（BT-367）と、背景クリックで閉じる誤操作の防止の両方で共用する。
function hasFormChanged(initialValues, currentValues) {
  return Object.keys(initialValues).some(key => currentValues[key] !== initialValues[key]);
}

// BT-168: オーバーレイの背景クリックで閉じる。ただし未保存の変更がある間は閉じず、
// 入力が消える2度打ちを防ぐ（×ボタン・Escは意図的な操作なので従来通り閉じる）。
// 未保存判定は el._hasUnsavedChanges（関数）に各フォームが登録する。
function closeOnBackdropClick(el, close) {
  el.addEventListener('click', (e) => {
    if (e.target !== el) return;
    // BM-136: コメント欄に書きかけの文字がある間も、背景クリックでは閉じない
    const hasCommentDraftHere = typeof hasCommentDraft === 'function' && hasCommentDraft(el);
    if ((el._hasUnsavedChanges && el._hasUnsavedChanges()) || hasCommentDraftHere) {
      const content = el.querySelector('.modal-content');
      if (content && content.animate) {
        // CSSのanimationプロパティを上書きすると、終了時に本来の表示アニメーション(modalSlideIn)が
        // 再生されてしまうため、Web Animations APIで一時的に揺らす
        content.animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
          { duration: 300, easing: 'ease' }
        );
      }
      return;
    }
    close();
  });
}

// --- State ---
let currentBoardData = null;
let currentFilter = ''; // '' = all projects
let workspaceThemeDraft = null;
let settingsWorkspace = ''; // BT-362: 設定パネルで選択中のワークスペース名（''=未選択）
let todayFilterActive = localStorage.getItem('todayFilterActive') === 'true';
let doneTodayOnly = localStorage.getItem('doneTodayOnly') === 'true'; // 完了カラム「本日完了だけ」表示（達成感モード）
let modalParentEpic = null; // 子タスク詳細表示中の親Epic（戻る用）
let expandedCols = new Set(); // 完了カラム等で「他N件」を展開表示中のカラムID
// BM-049: All Projects時のかんばん表示モード。'lane' = ワークスペース別レーン表示、'flat' = 従来の横断ボード。
// レーン表示が意味を持つのは currentFilter === '' の時だけ。
let boardLaneMode = localStorage.getItem('boardLaneMode') || 'lane';
// レーン表示で畳んでいるワークスペース名の集合。localStorageに永続化し、再読込後も畳み状態を保持する。
let collapsedBoardLanes = new Set();
try {
  collapsedBoardLanes = new Set(JSON.parse(localStorage.getItem('collapsedBoardLanes') || '[]'));
} catch { collapsedBoardLanes = new Set(); }
function persistCollapsedBoardLanes() {
  localStorage.setItem('collapsedBoardLanes', JSON.stringify([...collapsedBoardLanes]));
}
let expandedMiniCols = new Set(); // ミニボードの完了カラムで「他N件」展開中のカラムID
let pendingHighlightChildId = null; // BT-201: 親Epicリンククリック直後、ミニボードでハイライトすべき子タスクID
let workspaceFilterMap = null; // サーバーから取得: { workspaceKey -> projectName }
let wsDefaultFilter = ''; // URLパラメータから決まるデフォルトフィルタ（プロジェクト名）

// BM-029: ワークスペース絞り込みドロップダウン（列固定表示）の状態
let wsFilterProjects = []; // 現在のプロジェクト名一覧（updateProjectFilter相当）
let wsFilterCounts = {}; // { projectName -> { do, ready, todo } }
let wsFilterMenuOpen = false;
let wsFilterFocusIndex = -1; // キーボード操作中のメニュー内フォーカス位置（0=All Projects行）

const COLUMN_SORT_KEY_PREFIX = 'columnSort_';
const COLUMN_SORT_OPTIONS = [
  ['manual', 'Manual'],
  ['updated-desc', 'Updated'],
  ['due-asc', 'Due date'],
];

function columnSortMode(colId) {
  return localStorage.getItem(COLUMN_SORT_KEY_PREFIX + colId) || 'manual';
}

function columnSortSelectHtml(colId) {
  const current = columnSortMode(colId);
  const options = COLUMN_SORT_OPTIONS.map(([value, label]) =>
    `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`).join('');
  return `<select class="column-sort-select" data-col-id="${colId}" aria-label="${colId}の表示順">${options}</select>`;
}

// BM-012: 週次計画ビューの列は、メインボードの列ID('todo'/'do'等)と同名のバケットIDを
// 持つため、保存キーを別名にして混線を避ける（列内ソート状態を共有しない）。
function planColumnSortMode(bucketId) {
  return localStorage.getItem(COLUMN_SORT_KEY_PREFIX + 'plan_' + bucketId) || 'manual';
}

function planColumnSortSelectHtml(bucketId) {
  const current = planColumnSortMode(bucketId);
  const options = COLUMN_SORT_OPTIONS.map(([value, label]) =>
    `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`).join('');
  return `<select class="column-sort-select plan-col-sort-select" data-bucket-id="${bucketId}" aria-label="${bucketId}の表示順">${options}</select>`;
}

// --- 週次計画ビュー (BT-264, BM-012) ---
let planDragData = null; // { kind: 'single', id } | { kind: 'group', epicId, childIds: [] }
let planCollapsedGroups = new Set(); // 折りたたみ中のEPICグループキー('epicId_bucketId')
let planSearchQuery = ''; // BM-012: ID・件名・親EPICタイトルの部分一致（空文字=絞り込みなし）
let planPinOnly = false; // BM-012: 📌ピンが付いたタスク（EPICは子の集約）だけ表示する
// BT-396: タグ絞り込み。ボード・週次計画・ガントで共通。判定はtag-logic.js、操作UIはtags.js。
// { mode: 'or'|'and', tags: [{key,name,color}] }（keyは表記ゆれを正規化したタグ名）
let tagFilter = tagLogic.parseTagFilter((() => { try { return localStorage.getItem('tagFilter'); } catch (e) { return null; } })());
// BM-106: カテゴリ絞り込み(ボードのみ対応)。カテゴリは1タスク1値のためand/or切替は持たず、
// 選んだ候補のいずれかに一致するか(OR相当)のみ判定する。判定はcategory-logic.js、操作UIはcategories.js。
// { keys: [key,...] }（keyは表記ゆれを正規化したカテゴリ名）
let categoryFilter = categoryLogic.parseCategoryFilter((() => { try { return localStorage.getItem('categoryFilter'); } catch (e) { return null; } })());
let planShowDone = true; // BT-315: 週次カンバンで完了タスクを(列内の折りたたみグループとして)出すか。選択はlocalStorageに保持
let planExpandedDone = new Set(); // BT-315: 開いている完了グループのバケットID（既定は折りたたみ）
try { if (localStorage.getItem('planShowDone') === '0') planShowDone = false; } catch { /* 無視 */ }
let planViewMode = 'week'; // BT-268: 'week'(週次カンバン) | 'gantt'(ガント)。選択はlocalStorageに保持
try { if (localStorage.getItem('planViewMode') === 'gantt') planViewMode = 'gantt'; } catch { /* 無視 */ }

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

// BM-066: ?id=BM-xxx で起動時に該当タスクの詳細を自動的に開くためのパラメータ読み取り。
function getUrlTaskIdParam() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id') || '';
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

// URL で指定されたワークスペースは、手動フィルタで別の表示に切り替えていても
// 「このダッシュボードをどのワークスペースから開いたか」を示す文脈として残す。
function getUrlWorkspaceProject(boardData = currentBoardData) {
  const filterMap = (boardData && boardData.workspaceFilterMap) || workspaceFilterMap;
  return resolveWsDefault(filterMap);
}

function isUrlWorkspaceProject(project, boardData = currentBoardData) {
  const rawWorkspace = getUrlWorkspaceParam().trim().toLowerCase();
  if (!rawWorkspace || !project) return false;
  // project 名を直接指定するURLと、file名・パス末尾を指定するURLの両方を扱う。
  if (project.toLowerCase() === rawWorkspace) return true;
  return getUrlWorkspaceProject(boardData) === project;
}

function isCurrentUrlWorkspace(item) {
  return !!item && isUrlWorkspaceProject(item.project);
}

// --- Theme settings (BT-285, persisted to localStorage) ---
const THEME_PRESETS = {
  'light-blue':    { label: 'Light Blue', mode: 'light', accent: '#0b6fa4' },
  'light-teal':    { label: 'Light Teal', mode: 'light', accent: '#0f766e' },
  'light-indigo':  { label: 'Light Indigo', mode: 'light', accent: '#4f46e5' },
  'light-plum':    { label: 'Light Plum', mode: 'light', accent: '#9333ea' },
  'light-forest':  { label: 'Light Forest', mode: 'light', accent: '#15803d' },
  'light-crimson': { label: 'Light Crimson', mode: 'light', accent: '#be123c' },
  'light-slate':   { label: 'Light Slate', mode: 'light', accent: '#475569' },
  'dark-blue':     { label: 'Dark Blue', mode: 'dark', accent: '#38bdf8' },
  'dark-teal':     { label: 'Dark Teal', mode: 'dark', accent: '#2dd4bf' },
  'dark-violet':   { label: 'Dark Violet', mode: 'dark', accent: '#a78bfa' },
  'dark-amber':    { label: 'Dark Amber', mode: 'dark', accent: '#fbbf24' },
  'dark-rose':     { label: 'Dark Rose', mode: 'dark', accent: '#fb7185' },
  'dark-lime':     { label: 'Dark Lime', mode: 'dark', accent: '#a3e635' },
  'dark-slate':    { label: 'Dark Slate', mode: 'dark', accent: '#94a3b8' },
};

// BT-417: Workspace Themeのカスタム色の見本。原色を避け、彩度を抑えてライト/ダーク両方で映える中間トーンで揃える
const THEME_CUSTOM_SWATCHES = [
  { name: 'ネイビー', value: '#3d5a80' },
  { name: 'スレートブルー', value: '#5b7fa6' },
  { name: 'ダスティティール', value: '#4f9a94' },
  { name: 'シーグリーン', value: '#3f8f6b' },
  { name: 'セージ', value: '#7a9e7e' },
  { name: 'オリーブ', value: '#8a9a5b' },
  { name: 'マスタード', value: '#c9a227' },
  { name: 'テラコッタ', value: '#c8744f' },
  { name: 'コーラル', value: '#e07a6b' },
  { name: 'ダスティローズ', value: '#c76d84' },
  { name: 'モーヴ', value: '#9b7bb3' },
  { name: 'ラベンダー', value: '#8b8fd1' },
];

function mixColors(first, second, amount) {
  const hex = value => value.replace('#', '').match(/.{2}/g).map(part => parseInt(part, 16));
  const [r1, g1, b1] = hex(first); const [r2, g2, b2] = hex(second);
  const component = (a, b) => Math.round(a + (b - a) * amount).toString(16).padStart(2, '0');
  return `#${component(r1, r2)}${component(g1, g2)}${component(b1, b2)}`;
}

function buildThemePalette(mode, accent) {
  const dark = mode === 'dark';
  const base = dark ? '#101722' : '#f6f8fc';
  const surfaceBase = dark ? '#172231' : '#ffffff';
  const cardBase = dark ? '#1e2c3e' : '#eef3f9';
  const text = dark ? '#e8f1fa' : '#17212b';
  const muted = dark ? '#9eb0c3' : '#607080';
  const blend = (color, amount) => mixColors(base, color, amount);
  return {
    '--bg': blend(accent, dark ? .10 : .025),
    '--surface': mixColors(surfaceBase, accent, dark ? .12 : .025),
    '--card': mixColors(cardBase, accent, dark ? .14 : .06),
    '--card-hover': mixColors(cardBase, accent, dark ? .24 : .14),
    '--text': text, '--text-muted': muted, '--accent': accent,
    '--border': blend(accent, dark ? .25 : .18),
    '--badge-done-bg': dark ? '#17382d' : '#d9f1e1', '--badge-done-fg': dark ? '#7cdea4' : '#17733c',
    '--badge-progress-bg': dark ? '#3b3517' : '#fff3cf', '--badge-progress-fg': dark ? '#e5cd75' : '#805e00',
    '--badge-numerator-bg': blend(accent, dark ? .24 : .16), '--badge-denominator-bg': blend(accent, dark ? .10 : .04),
    '--modal-overlay': dark ? 'rgba(4, 9, 16, .68)' : 'rgba(18, 32, 48, .32)',
    '--tag-project-bg': blend(accent, dark ? .18 : .12), '--tag-project-fg': dark ? '#b8e4ff' : '#185c80',
    '--tag-category-bg': dark ? '#302443' : '#eee4f8', '--tag-category-fg': dark ? '#ddc5ff' : '#68418e',
    '--tag-parent-bg': dark ? '#42351f' : '#f8ead9', '--tag-parent-fg': dark ? '#ffd78c' : '#82531a',
    '--compact-card-bg': mixColors(cardBase, accent, dark ? .10 : .04),
    '--compact-card-hover': mixColors(cardBase, accent, dark ? .18 : .11),
    '--drop-highlight': `${accent}1f`, '--btn-add-fg': dark ? '#7cdea4' : '#17733c',
    '--btn-add-bg': dark ? 'rgba(124, 222, 164, .12)' : 'rgba(23, 115, 60, .10)',
    '--btn-neutral-fg': muted, '--btn-neutral-bg': dark ? 'rgba(158, 176, 195, .12)' : 'rgba(96, 112, 128, .08)',
    '--btn-danger-fg': dark ? '#ff8c8c' : '#bd3030', '--btn-danger-bg': dark ? 'rgba(255, 140, 140, .12)' : 'rgba(189, 48, 48, .10)',
    '--brand': accent, '--brand-fg': dark ? '#101722' : '#ffffff', '--brand-fg-soft': dark ? 'rgba(16, 23, 34, .72)' : 'rgba(255, 255, 255, .72)',
  };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('backlog-dashboard-settings');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSettings(settings) {
  localStorage.setItem('backlog-dashboard-settings', JSON.stringify(settings));
}

// --- カード文字サイズ S/M/L (BT-339, localStorageに保存。Lが従来の通常カード) ---
const CARD_SIZES = ['s', 'm', 'l'];

function applyCardSize(size) {
  const value = CARD_SIZES.includes(size) ? size : 'l';
  document.documentElement.setAttribute('data-card-size', value);
  document.querySelectorAll('#card-size-group .card-size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === value);
  });
  // BT-464: よく使うヘッダの操作と全体設定の選択値を常に揃える。
  const globalCardSize = document.getElementById('settings-card-size');
  if (globalCardSize) globalCardSize.value = value;
}

applyCardSize(loadSettings().cardSize);
document.querySelectorAll('#card-size-group .card-size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const settings = loadSettings();
    settings.cardSize = btn.dataset.size;
    saveSettings(settings);
    applyCardSize(settings.cardSize);
  });
});

function normalizedSettings() {
  const settings = loadSettings();
  if (!['dark', 'light', 'system'].includes(settings.theme)) settings.theme = 'system';
  if (!settings.workspaceThemes || typeof settings.workspaceThemes !== 'object') settings.workspaceThemes = {};
  if (!settings.workspaceThemeEnabled || typeof settings.workspaceThemeEnabled !== 'object') settings.workspaceThemeEnabled = {};
  return settings;
}

function activeWorkspace() {
  const paths = (currentBoardData && currentBoardData.workspaceMap) || {};
  return currentFilter && paths[currentFilter] ? currentFilter : '';
}

function systemMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function effectiveTheme(settings) {
  const workspace = activeWorkspace();
  if (workspace && settings.workspaceThemeEnabled[workspace] && settings.workspaceThemes[workspace]) {
    return { selection: 'workspace', ...settings.workspaceThemes[workspace] };
  }
  const mode = settings.theme === 'system' ? systemMode() : settings.theme;
  return { selection: settings.theme, preset: `${mode}-blue` };
}

function applyPalette(theme) {
  const preset = theme.preset && THEME_PRESETS[theme.preset];
  const mode = preset ? preset.mode : (theme.mode || systemMode());
  const accent = preset ? preset.accent : (theme.custom || '#38bdf8');
  document.documentElement.setAttribute('data-theme', mode);
  for (const [name, value] of Object.entries(buildThemePalette(mode, accent))) document.documentElement.style.setProperty(name, value);
}

function syncThemeOptions(settings, effective) {
  const workspace = activeWorkspace();
  for (const select of [themeSelectEl, settingsThemeEl]) {
    const workspaceAction = select.querySelector('option[value="workspace"]');
    const workspaceApplied = select.querySelector('option[value="workspace-applied"]');
    if (workspace && !workspaceAction) select.appendChild(new Option('Workspace を設定…', 'workspace'));
    if (workspace && effective.selection === 'workspace' && !workspaceApplied) {
      select.appendChild(new Option('Workspace（適用中）', 'workspace-applied'));
    }
    if ((!workspace || effective.selection !== 'workspace') && workspaceApplied) workspaceApplied.remove();
    if (!workspace && workspaceAction) workspaceAction.remove();
    select.value = effective.selection === 'workspace' ? 'workspace-applied' : effective.selection;
  }
}

function applySettings() {
  const settings = normalizedSettings();
  const effective = effectiveTheme(settings);
  applyPalette(effective);
  syncThemeOptions(settings, effective);
  renderWorkspaceThemeSettings(settings, settingsWorkspace);
}

function selectTheme(selection) {
  const settings = normalizedSettings();
  const workspace = activeWorkspace();
  if (selection === 'workspace') {
    if (!workspace) return;
    openSettingsPanel(workspace);
    return;
  }
  settings.theme = selection;
  if (workspace) settings.workspaceThemeEnabled[workspace] = false;
  saveSettings(settings);
  applySettings();
}

function renderWorkspaceThemeSettings(settings, workspace) {
  if (!workspace) { workspaceThemeSettingsEl.hidden = true; return; }
  workspaceThemeSettingsEl.hidden = false;
  workspaceThemeLabelEl.textContent = `${workspace} Theme`;
  if (!workspaceThemeDraft || workspaceThemeDraft.workspace !== workspace) {
    workspaceThemeDraft = { workspace, theme: { ...(settings.workspaceThemes[workspace] || {}) } };
  }
  const draft = workspaceThemeDraft.theme;
  themePresetGridEl.innerHTML = Object.entries(THEME_PRESETS).map(([name, preset]) => `
    <button type="button" class="theme-preset${draft.preset === name ? ' is-selected' : ''}" data-preset="${name}" style="--preset-accent:${preset.accent}">
      <span class="theme-preset-swatch"></span>${preset.label}
    </button>`).join('') + `
    <div class="theme-custom-color">
      <span class="theme-custom-label">Custom</span>
      <div class="theme-custom-swatches" role="group" aria-label="カスタム色の見本">${THEME_CUSTOM_SWATCHES.map(c => `
        <button type="button" class="tag-swatch" data-custom="${c.value}" title="${c.name}" aria-label="${c.name}" aria-pressed="${(draft.custom || '').toLowerCase() === c.value}" style="background:${c.value}"></button>`).join('')}
      </div>
      <label class="theme-custom-picker" title="見本にない色を選ぶ">その他の色 <input type="color" id="workspace-custom-accent" value="${draft.custom || '#38bdf8'}"></label>
    </div>`;
  themePresetGridEl.querySelectorAll('[data-custom]').forEach(button => button.addEventListener('click', () => {
    workspaceThemeDraft = { workspace, theme: { custom: button.dataset.custom, mode: systemMode() } };
    renderWorkspaceThemeSettings(settings, workspace);
    applyPalette(workspaceThemeDraft.theme); // 見本もピッカー同様、保存前にその場でプレビュー
  }));
  themePresetGridEl.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
    workspaceThemeDraft = { workspace, theme: { preset: button.dataset.preset } };
    renderWorkspaceThemeSettings(settings, workspace);
    applyPalette(workspaceThemeDraft.theme); // BM-015: 保存前にその場でプレビュー
  }));
  themePresetGridEl.querySelector('#workspace-custom-accent').addEventListener('input', event => {
    workspaceThemeDraft = { workspace, theme: { custom: event.target.value, mode: systemMode() } };
    applyPalette(workspaceThemeDraft.theme); // BM-015: 保存前にその場でプレビュー
  });
}

// --- Theme & Settings UI ---
themeSelectEl.addEventListener('change', () => selectTheme(themeSelectEl.value));

// BM-073: Redmine設定ボタン経由で設定パネルを開いた後、設定を保存してパネルを閉じた時、
// 裏で開いている取り込みモーダルのワークスペース選択(#redmine-import-project)は変わらない
// (changeイベントが発火しない)ため、戻った時点でトラッカー一覧を明示的に再取得する
// (再取得しないとトラッカーセレクトがdisabledのまま残り、選べなくなる)。
function refreshRedmineImportAfterSettingsChange() {
  if (!githubImportEl || !githubImportEl.classList.contains('modal-visible')) return;
  if (importSourceTab !== 'redmine') return;
  if (githubImportEl.querySelector('#redmine-import-project').value) onRedmineImportProjectChange();
}

// BM-074: GitLab設定保存後、裏で開いている取り込みモーダルのGitLabタブを再読込する(Redmineと同じ理由)
function refreshGitlabImportAfterSettingsChange() {
  if (!githubImportEl || !githubImportEl.classList.contains('modal-visible')) return;
  if (importSourceTab !== 'gitlab') return;
  if (githubImportEl.querySelector('#gitlab-import-project').value) onGitlabImportProjectChange();
}

function closeSettings() {
  workspaceThemeDraft = null;
  settingsOverlay.classList.remove('settings-visible');
  applySettings();
}

// BT-428: 設定パネルのタブ切替（workspace=ワークスペース単位 / global=全体設定）
function setSettingsTab(tab) {
  const active = tab === 'global' ? 'global' : 'workspace';
  for (const name of ['workspace', 'global']) {
    document.getElementById(`settings-tab-${name}`).hidden = name !== active;
    const btn = document.getElementById(`settings-tab-btn-${name}`);
    btn.classList.toggle('is-active', name === active);
    btn.setAttribute('aria-selected', String(name === active));
  }
  if (active === 'global') populateGlobalSettings();
}

document.querySelectorAll('.settings-tab').forEach(btn => {
  btn.addEventListener('click', () => setSettingsTab(btn.dataset.tab));
});

// BT-362: 設定パネルを開く。workspaceを渡すとその選択状態で、省略時は現在開いているワークスペース（なければ未選択）で開く
// BT-428: tabで開くタブを指定する（省略時はワークスペースタブ）
function openSettingsPanel(workspace = activeWorkspace(), tab = 'workspace') {
  workspaceThemeDraft = null;
  settingsOverlay.classList.add('settings-visible');
  populateSettingsWorkspaceSelect(workspace);
  onSettingsWorkspaceChanged();
  setSettingsTab(tab);
}

document.getElementById('global-settings-btn').addEventListener('click', () => openSettingsPanel(activeWorkspace(), 'global'));


settingsClose.addEventListener('click', () => {
  closeSettings();
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});
closeOnEscape(settingsOverlay, 'settings-visible', closeSettings);

workspaceThemeSaveEl.addEventListener('click', () => {
  const draft = workspaceThemeDraft;
  if (!draft || !draft.workspace || (!draft.theme.preset && !draft.theme.custom)) return;
  const settings = normalizedSettings();
  settings.workspaceThemes[draft.workspace] = draft.theme;
  settings.workspaceThemeEnabled[draft.workspace] = true;
  saveSettings(settings);
  applyMainFilter(draft.workspace); // BT-360: 保存したワークスペースをメインボードの選択状態にする
  closeSettings();
});

settingsThemeEl.addEventListener('change', () => {
  selectTheme(settingsThemeEl.value);
});

if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (normalizedSettings().theme === 'system') applySettings();
});

// --- GitHub連携設定 (BT-077) ---
// Inbox等、実ワークスペース(workspace)を持たない架空プロジェクトはGitHub連携の対象外
// BT-360: ワークスペース選択に「＋ 新規作成」を追加。この値を選んだ時だけ作成フォームを出す
const NEW_WORKSPACE_VALUE = '__new__';

function populateSettingsWorkspaceSelect(selected) {
  const workspaceMap = (currentBoardData && currentBoardData.workspaceMap) || {};
  const names = Object.keys(workspaceMap).sort();
  settingsWorkspaceEl.innerHTML = `<option value="">（未選択）</option>` +
    names.map(name => `<option value="${name}">${name}</option>`).join('') +
    `<option value="${NEW_WORKSPACE_VALUE}">＋ 新規作成</option>`;
  const valid = names.includes(selected) || selected === NEW_WORKSPACE_VALUE;
  settingsWorkspaceEl.value = valid ? selected : '';
  // 新規作成中はどのワークスペースも選択していない扱い（テーマ/GitHub設定の対象なし）
  settingsWorkspace = settingsWorkspaceEl.value === NEW_WORKSPACE_VALUE ? '' : settingsWorkspaceEl.value;
}

// GitHub設定の対象prefix。ワークスペース未選択、またはprefixを持たない場合は''
function settingsGithubPrefix() {
  const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
  return (settingsWorkspace && prefixMap[settingsWorkspace]) || '';
}

function onSettingsWorkspaceChanged() {
  const creating = settingsWorkspaceEl.value === NEW_WORKSPACE_VALUE;
  settingsWorkspace = creating ? '' : settingsWorkspaceEl.value;
  workspaceThemeDraft = null;
  showWorkspaceCreate(creating);
  applySettings(); // 切替前のプレビューを破棄し、選択ワークスペースのテーマ欄を描画し直す
  loadGithubSettingsForSelectedProject();
  loadRedmineSettingsForSelectedProject();
  loadGitlabSettingsForSelectedProject();
}

// --- ワークスペース新規作成 (BT-360) ---
// 既存の POST /api/create-workspace を使う。サーバー側にも同じ検証があるため、
// ここは入力中に気づけるようにするための事前チェック（countersの過去残骸だけはサーバーの400で検知）
const workspaceCreateEl = document.getElementById('settings-workspace-create');
const settingsColumnsEl = document.getElementById('settings-columns');
const workspaceCreateFileEl = document.getElementById('workspace-create-file');
const workspaceCreatePrefixEl = document.getElementById('workspace-create-prefix');
const workspaceCreateBaseEl = document.getElementById('workspace-create-base');
const workspaceCreatePreviewEl = document.getElementById('workspace-create-path-preview');
const workspaceCreateErrorEl = document.getElementById('workspace-create-error');
const workspaceCreateSubmitEl = document.getElementById('workspace-create-submit');

function showWorkspaceCreate(creating) {
  workspaceCreateEl.hidden = !creating;
  settingsColumnsEl.hidden = creating;
  if (!creating) return;
  workspaceCreateFileEl.value = '';
  workspaceCreatePrefixEl.value = '';
  validateWorkspaceCreate();
  setTimeout(() => workspaceCreateFileEl.focus(), 50);
}

// 入力値を検証し、エラー文言（問題なければ''）を返す。未入力は文言なしで作成不可にする
function workspaceCreateProblem(file, prefix) {
  const fileMap = (currentBoardData && currentBoardData.projectFileMap) || {};
  const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
  if (file && !/^[A-Za-z0-9_-]+$/.test(file)) return 'フォルダ名は英数字・_-のみで入力してね';
  if (file && Object.values(fileMap).some(f => f.toLowerCase() === file.toLowerCase())) return `「${file}」は既に登録済みだよ`;
  if (prefix && !/^[A-Z]{0,2}$/.test(prefix)) return 'プレフィクスは英大文字2文字で入力してね';
  if (prefix.length === 2) {
    const owner = Object.keys(prefixMap).find(name => prefixMap[name] === prefix);
    if (owner) return `プレフィクス「${prefix}」は ${owner} で使用中だよ`;
  }
  return '';
}

function validateWorkspaceCreate() {
  const file = workspaceCreateFileEl.value.trim();
  const prefix = workspaceCreatePrefixEl.value.trim().toUpperCase();
  const parent = (currentBoardData && currentBoardData.defaultWorkspaceParent) || '';
  workspaceCreateBaseEl.textContent = parent || '（未設定: config.jsonのdefaultWorkspaceParentを設定してね）';
  workspaceCreatePreviewEl.textContent = `作成されるフォルダ: ${parent}/${file || '（フォルダ名）'}`;
  const problem = workspaceCreateProblem(file, prefix);
  workspaceCreateErrorEl.textContent = problem;
  // ベース未設定だと相対パスで作られてしまうため、作成不可にする
  workspaceCreateSubmitEl.disabled = !!problem || !file || prefix.length !== 2 || !parent;
}

workspaceCreateFileEl.addEventListener('input', validateWorkspaceCreate);
workspaceCreatePrefixEl.addEventListener('input', () => {
  workspaceCreatePrefixEl.value = workspaceCreatePrefixEl.value.toUpperCase();
  validateWorkspaceCreate();
});

workspaceCreateSubmitEl.addEventListener('click', async () => {
  const file = workspaceCreateFileEl.value.trim();
  const prefix = workspaceCreatePrefixEl.value.trim().toUpperCase();
  const parent = (currentBoardData && currentBoardData.defaultWorkspaceParent) || '';
  workspaceCreateSubmitEl.disabled = true;
  workspaceCreateErrorEl.textContent = '作成中...';
  try {
    const res = await fetch('/api/create-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, prefix, workspace: parent ? `${parent}/${file}` : file }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '作成に失敗しました');
    // WS配信より先にセレクトを再描画するため、最新のboardを取り直して新ワークスペースを選択状態にする
    const board = await (await fetch('/api/board')).json();
    currentBoardData = board;
    populateSettingsWorkspaceSelect(data.name || file);
    onSettingsWorkspaceChanged();
  } catch (e) {
    workspaceCreateErrorEl.textContent = `作成に失敗したよ: ${e.message}`;
    workspaceCreateSubmitEl.disabled = false;
  }
});

async function loadGithubSettingsForSelectedProject() {
  const prefix = settingsGithubPrefix();
  settingsGithubTokenEl.value = '';
  const disabled = !prefix;
  settingsGithubRepoUrlEl.disabled = disabled;
  settingsGithubTokenEl.disabled = disabled;
  settingsGithubSaveEl.disabled = disabled;
  if (!prefix) {
    settingsGithubRepoUrlEl.value = '';
    settingsGithubStatusEl.textContent = settingsWorkspace ? 'このワークスペースはGitHub連携の対象外です' : '上でワークスペースを選択してください';
    settingsGithubTokenEl.placeholder = 'トークンを入力（未入力なら既存を保持）';
    settingsGithubHintEl.style.display = 'none';
    return;
  }
  try {
    const res = await fetch(`/api/github-settings?prefix=${encodeURIComponent(prefix)}`);
    const data = await readJsonOrStatusError(res);
    settingsGithubRepoUrlEl.value = data.repoUrl || '';
    setSettingsStatus(settingsGithubStatusEl, data.hasToken ? 'トークン設定済み' : '未設定');
    // トークン自体の値は表示せず、設定済みかどうかをplaceholderのマスク表示で示す
    settingsGithubTokenEl.placeholder = data.hasToken
      ? '●●●●●●●●●●●●（設定済み・変更する場合のみ入力）'
      : 'トークンを入力（未入力なら既存を保持）';
    settingsGithubHintEl.style.display = data.hasToken ? 'none' : 'block';
  } catch (e) {
    setSettingsStatus(settingsGithubStatusEl, `取得エラー: ${e.message}`, { isError: true });
  }
}

settingsWorkspaceEl.addEventListener('change', onSettingsWorkspaceChanged);

// BM-073: fetchのレスポンスをJSONとして読み、失敗時(非JSON応答。サーバー再起動直後や
// 404/502のプレーンテキスト応答等)でも素の"Unexpected token..."を出さず、
// ステータスコード付きの読める文言にする。
async function readJsonOrStatusError(res) {
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`サーバーから予期しない応答がありました(status ${res.status})。サーバーが再起動中の可能性があります`);
  }
  if (!res.ok) throw new Error(data.error || `保存に失敗しました(status ${res.status})`);
  return data;
}

// 保存系ステータス表示を共通化(成功時は通常色、失敗時は赤文字クラスを付ける)
function setSettingsStatus(el, text, { isError = false } = {}) {
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}

settingsGithubSaveEl.addEventListener('click', async () => {
  const prefix = settingsGithubPrefix();
  if (!prefix) return;
  const body = { prefix, repoUrl: settingsGithubRepoUrlEl.value.trim() };
  if (settingsGithubTokenEl.value) body.token = settingsGithubTokenEl.value;
  setSettingsStatus(settingsGithubStatusEl, '保存中...');
  try {
    const res = await fetch('/api/github-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await readJsonOrStatusError(res);
    await loadGithubSettingsForSelectedProject();
    applyMainFilter(settingsWorkspace); // BT-360: 保存したワークスペースをメインボードの選択状態にする
    settingsOverlay.classList.remove('settings-visible');
  } catch (e) {
    setSettingsStatus(settingsGithubStatusEl, `エラー: ${e.message}`, { isError: true });
  }
});

// --- Redmine連携設定 (BM-073) ---
// GitHub設定(settingsGithubPrefix)と同じ対象prefix判定を共有する(ワークスペース→prefixの解決は
// ソースに依らず同じロジックのため)。
async function loadRedmineSettingsForSelectedProject() {
  const prefix = settingsGithubPrefix();
  settingsRedmineTokenEl.value = '';
  const disabled = !prefix;
  settingsRedmineProjectUrlEl.disabled = disabled;
  settingsRedmineTokenEl.disabled = disabled;
  settingsRedmineSaveEl.disabled = disabled;
  if (!prefix) {
    settingsRedmineProjectUrlEl.value = '';
    settingsRedmineStatusEl.textContent = settingsWorkspace ? 'このワークスペースはRedmine連携の対象外です' : '上でワークスペースを選択してください';
    settingsRedmineTokenEl.placeholder = 'APIキーを入力（未入力なら既存を保持）';
    return;
  }
  try {
    const res = await fetch(`/api/its-settings?prefix=${encodeURIComponent(prefix)}`);
    const data = await readJsonOrStatusError(res);
    const redmine = data.redmine || {};
    settingsRedmineProjectUrlEl.value = redmine.projectUrl || '';
    setSettingsStatus(settingsRedmineStatusEl, redmine.hasToken ? 'APIキー設定済み' : '未設定');
    settingsRedmineTokenEl.placeholder = redmine.hasToken
      ? '●●●●●●●●●●●●（設定済み・変更する場合のみ入力）'
      : 'APIキーを入力（未入力なら既存を保持）';
  } catch (e) {
    setSettingsStatus(settingsRedmineStatusEl, `取得エラー: ${e.message}`, { isError: true });
  }
}

settingsRedmineSaveEl.addEventListener('click', async () => {
  const prefix = settingsGithubPrefix();
  if (!prefix) return;
  const body = { prefix, source: 'redmine', projectUrl: settingsRedmineProjectUrlEl.value.trim() };
  if (settingsRedmineTokenEl.value) body.token = settingsRedmineTokenEl.value;
  setSettingsStatus(settingsRedmineStatusEl, '保存中...');
  try {
    const res = await fetch('/api/its-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await readJsonOrStatusError(res);
    await loadRedmineSettingsForSelectedProject();
    // BM-073: GitHub保存と同じく、保存成功したら設定パネルを閉じる
    settingsOverlay.classList.remove('settings-visible');
    refreshRedmineImportAfterSettingsChange();
  } catch (e) {
    setSettingsStatus(settingsRedmineStatusEl, `エラー: ${e.message}`, { isError: true });
  }
});

// --- GitLab連携設定 (BM-074) ---
// Redmine設定(loadRedmineSettingsForSelectedProject)と同じ構成。GitHub設定と同じ対象prefix判定を共有する。
async function loadGitlabSettingsForSelectedProject() {
  const prefix = settingsGithubPrefix();
  settingsGitlabTokenEl.value = '';
  const disabled = !prefix;
  settingsGitlabProjectUrlEl.disabled = disabled;
  settingsGitlabTokenEl.disabled = disabled;
  settingsGitlabSaveEl.disabled = disabled;
  if (!prefix) {
    settingsGitlabProjectUrlEl.value = '';
    settingsGitlabStatusEl.textContent = settingsWorkspace ? 'このワークスペースはGitLab連携の対象外です' : '上でワークスペースを選択してください';
    settingsGitlabTokenEl.placeholder = 'トークンを入力（未入力なら既存を保持）';
    return;
  }
  try {
    const res = await fetch(`/api/its-settings?prefix=${encodeURIComponent(prefix)}`);
    const data = await readJsonOrStatusError(res);
    const gitlab = data.gitlab || {};
    settingsGitlabProjectUrlEl.value = gitlab.projectUrl || '';
    setSettingsStatus(settingsGitlabStatusEl, gitlab.hasToken ? 'トークン設定済み' : '未設定');
    settingsGitlabTokenEl.placeholder = gitlab.hasToken
      ? '●●●●●●●●●●●●（設定済み・変更する場合のみ入力）'
      : 'トークンを入力（未入力なら既存を保持）';
  } catch (e) {
    setSettingsStatus(settingsGitlabStatusEl, `取得エラー: ${e.message}`, { isError: true });
  }
}

settingsGitlabSaveEl.addEventListener('click', async () => {
  const prefix = settingsGithubPrefix();
  if (!prefix) return;
  const body = { prefix, source: 'gitlab', projectUrl: settingsGitlabProjectUrlEl.value.trim() };
  if (settingsGitlabTokenEl.value) body.token = settingsGitlabTokenEl.value;
  setSettingsStatus(settingsGitlabStatusEl, '保存中...');
  try {
    const res = await fetch('/api/its-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await readJsonOrStatusError(res);
    await loadGitlabSettingsForSelectedProject();
    settingsOverlay.classList.remove('settings-visible');
    refreshGitlabImportAfterSettingsChange();
  } catch (e) {
    setSettingsStatus(settingsGitlabStatusEl, `エラー: ${e.message}`, { isError: true });
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
let importSourceTab = 'github'; // BM-073: 取り込みモーダルで現在表示中のタブ('github' | 'redmine')

// BT-449: 取り込みモーダルで最後に選んだタブをワークスペース(prefix)単位で覚える。
// Redmineしか使わない環境などで、開くたびにタブをクリックし直さなくて済むようにする(BM-099と同じ作法)
const IMPORT_SOURCE_TABS = ['github', 'redmine', 'gitlab'];
function loadImportSourceTabByPrefix() {
  try {
    const raw = localStorage.getItem('importSourceTabByPrefix');
    if (raw) return JSON.parse(raw) || {};
  } catch { /* 無視 */ }
  return {};
}
function saveImportSourceTab(prefix, source) {
  if (!prefix || !IMPORT_SOURCE_TABS.includes(source)) return;
  const map = loadImportSourceTabByPrefix();
  map[prefix] = source;
  try { localStorage.setItem('importSourceTabByPrefix', JSON.stringify(map)); } catch { /* 無視 */ }
}
// 保存値が無い・不正な場合はGitHub(従来の既定)に戻す
function getSavedImportSourceTab(prefix) {
  const saved = prefix ? loadImportSourceTabByPrefix()[prefix] : null;
  return IMPORT_SOURCE_TABS.includes(saved) ? saved : 'github';
}
// 現在表示中のタブが対象にしているワークスペースのprefix
function getActiveImportTabPrefix() {
  const sel = githubImportEl && githubImportEl.querySelector(`#${importSourceTab}-import-project`);
  return sel ? sel.value : '';
}

// BM-073: ヘッダーの「外部取り込み」ボタンから開く取り込みモーダルをGitHub/Redmineのタブで切り替える。
// GitHubタブの既存UI・API・ロジックには一切手を入れない(ワークスペース選択もタブ別に独立させ、
// github-import-*のid/関数はそのまま使う)。Redmineタブは並びで新設する(関数は別名)。
function getOrCreateGithubImportModal() {
  if (githubImportEl) return githubImportEl;
  githubImportEl = document.createElement('div');
  githubImportEl.id = 'github-import-overlay';
  githubImportEl.className = 'modal-overlay modal-front';
  githubImportEl.innerHTML = `
    <div class="modal-content modal-wide github-import-modal">
      <button class="modal-close" id="github-import-close">&times;</button>
      <h3><span class="material-icon icon-link"></span> 外部チケット取り込み</h3>
      <div class="import-source-tabs" id="import-source-tabs" role="tablist">
        <button type="button" class="import-source-tab active" data-source="github" role="tab" aria-selected="true">${GITHUB_MARK_SVG}GitHub</button>
        <button type="button" class="import-source-tab" data-source="redmine" role="tab" aria-selected="false">${REDMINE_MARK_SVG}Redmine</button>
        <button type="button" class="import-source-tab" data-source="gitlab" role="tab" aria-selected="false">${GITLAB_MARK_SVG}GitLab</button>
      </div>
      <div class="import-source-panel" data-source-panel="github">
        <div class="github-import-toolbar">
          <select id="github-import-project"></select>
          <button id="github-import-fetch-btn" class="import-primary-btn" disabled>Issueを取得</button>
          <span class="github-import-result-tools" id="github-import-result-tools" hidden>
            <span class="github-import-total-count" id="github-import-total-count"></span>
            <label class="github-import-filter"><input type="checkbox" id="github-import-filter-closed" checked><span id="github-import-filter-closed-label">closedを隠す</span></label>
            <label class="github-import-filter"><input type="checkbox" id="github-import-filter-imported" checked><span id="github-import-filter-imported-label">取込済みを隠す</span></label>
          </span>
          <button id="github-import-settings-btn" class="import-settings-btn" title="GitHub連携設定"><span class="material-icon icon-settings"></span> GitHub設定</button>
        </div>
        <div class="github-import-body" id="github-import-body">
          <p class="github-import-placeholder">プロジェクトを選択してください。</p>
        </div>
        <div class="github-import-footer">
          <span id="github-import-selected-count">0件選択中</span>
          <button id="github-import-execute-btn" disabled>選択した0件を取り込む</button>
        </div>
      </div>
      <div class="import-source-panel" data-source-panel="redmine" hidden>
        <div class="github-import-toolbar">
          <select id="redmine-import-project"></select>
          <select id="redmine-import-tracker" disabled><option value="">トラッカーを選択...</option></select>
          <select id="redmine-import-status">
            <option value="open">未完了のみ</option>
            <option value="all">すべて</option>
          </select>
          <button id="redmine-import-list-btn" class="import-primary-btn" disabled>一覧を出す</button>
          <span class="github-import-result-tools" id="redmine-import-result-tools">
            <span class="github-import-total-count" id="redmine-import-total-count"></span>
          </span>
          <button id="redmine-import-settings-btn" class="import-settings-btn" title="Redmine連携設定"><span class="material-icon icon-settings"></span> Redmine設定</button>
        </div>
        <div class="github-import-body" id="redmine-import-body">
          <p class="github-import-placeholder">ワークスペースを選択してください。</p>
        </div>
        <div class="github-import-footer">
          <span id="redmine-import-selected-count">0件選択中</span>
          <button id="redmine-import-execute-btn" disabled>選択した0件を取り込む</button>
        </div>
      </div>
      <div class="import-source-panel" data-source-panel="gitlab" hidden>
        <div class="github-import-toolbar">
          <select id="gitlab-import-project"></select>
          <select id="gitlab-import-status">
            <option value="open">未完了のみ</option>
            <option value="all">すべて</option>
          </select>
          <button id="gitlab-import-list-btn" class="import-primary-btn" disabled>一覧を出す</button>
          <span class="github-import-result-tools" id="gitlab-import-result-tools">
            <span class="github-import-total-count" id="gitlab-import-total-count"></span>
          </span>
          <button id="gitlab-import-settings-btn" class="import-settings-btn" title="GitLab連携設定"><span class="material-icon icon-settings"></span> GitLab設定</button>
        </div>
        <div class="github-import-body" id="gitlab-import-body">
          <p class="github-import-placeholder">ワークスペースを選択してください。</p>
        </div>
        <div class="github-import-footer">
          <span id="gitlab-import-selected-count">0件選択中</span>
          <button id="gitlab-import-execute-btn" disabled>選択した0件を取り込む</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(githubImportEl);
  githubImportEl.addEventListener('click', (e) => {
    if (e.target === githubImportEl) closeGithubImportModal();
  });
  githubImportEl.querySelector('#github-import-close').addEventListener('click', closeGithubImportModal);
  githubImportEl.querySelector('#github-import-settings-btn').addEventListener('click', () => {
    // 取り込みダイアログで選択中のプロジェクト(prefix)に対応するワークスペースで開く
    const prefix = githubImportEl.querySelector('#github-import-project').value;
    const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
    openSettingsPanel(Object.keys(prefixMap).find(name => prefixMap[name] === prefix) || '');
  });
  // BT-415: セレクタ変更では通信しない。「Issueを取得」ボタンを押したときだけ取得する
  githubImportEl.querySelector('#github-import-project').addEventListener('change', onGithubImportProjectChange);
  githubImportEl.querySelector('#github-import-fetch-btn').addEventListener('click', loadGithubImportPreview);
  githubImportEl.querySelector('#github-import-filter-closed').addEventListener('change', renderGithubImportIssueList);
  githubImportEl.querySelector('#github-import-filter-imported').addEventListener('change', renderGithubImportIssueList);
  githubImportEl.querySelector('#github-import-body').addEventListener('change', (e) => {
    if (e.target.classList.contains('github-issue-checkbox')) updateGithubImportSelection();
  });
  githubImportEl.querySelector('#github-import-execute-btn').addEventListener('click', executeGithubImport);
  closeOnEscape(githubImportEl, 'modal-visible', closeGithubImportModal);

  // BM-073: タブ切り替え
  githubImportEl.querySelector('#import-source-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.import-source-tab');
    if (btn) {
      switchImportSourceTab(btn.dataset.source);
      saveImportSourceTab(getActiveImportTabPrefix(), btn.dataset.source); // BT-449
    }
  });

  // BM-073: Redmineタブの配線
  githubImportEl.querySelector('#redmine-import-settings-btn').addEventListener('click', () => {
    const prefix = githubImportEl.querySelector('#redmine-import-project').value;
    const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
    openSettingsPanel(Object.keys(prefixMap).find(name => prefixMap[name] === prefix) || '');
  });
  githubImportEl.querySelector('#redmine-import-project').addEventListener('change', onRedmineImportProjectChange);
  githubImportEl.querySelector('#redmine-import-tracker').addEventListener('change', () => {
    const els = redmineImportEls();
    saveRedmineLastTracker(els.project.value, els.tracker.value); // BM-099: 選んだトラッカーを記憶
    updateRedmineImportListButtonState();
  });
  githubImportEl.querySelector('#redmine-import-list-btn').addEventListener('click', () => loadRedmineImportList({ reset: true }));
  githubImportEl.querySelector('#redmine-import-body').addEventListener('click', (e) => {
    if (e.target.closest('#redmine-import-load-more-btn')) loadRedmineImportList({ reset: false });
  });
  // BM-099: 件名ホバーで説明欄をツールチップ表示(ガントの.gantt-tipと同じ見た目を流用)
  // BT-422: GitHub/GitLabタブにも同じツールチップを適用する
  for (const bodyId of ['#github-import-body', '#redmine-import-body', '#gitlab-import-body']) {
    githubImportEl.querySelector(bodyId).addEventListener('mouseover', onImportTitleMouseOver);
    githubImportEl.querySelector(bodyId).addEventListener('mouseout', onImportTitleMouseOut);
  }
  githubImportEl.querySelector('#redmine-import-body').addEventListener('change', (e) => {
    if (!e.target.classList.contains('redmine-issue-checkbox')) return;
    // BM-069決定事項: 親を選ぶと、読み込み済みの子も自動で取り込み対象に含める
    // (子チェックボックスはdata-parent-keyを持つため、空=親のチェックボックスと判定する。
    // 子行(.import-row-child)は親行(.import-row-epic)の直後に連続して並ぶので、続く兄弟を辿って選択する)
    if (!e.target.dataset.parentKey && e.target.checked) {
      const row = e.target.closest('.import-row-epic');
      let next = row && row.nextElementSibling;
      while (next && next.classList.contains('import-row-child')) {
        const cb = next.querySelector('.redmine-issue-checkbox:not(:disabled)');
        if (cb) cb.checked = true;
        next = next.nextElementSibling;
      }
    }
    updateRedmineImportSelection();
  });
  githubImportEl.querySelector('#redmine-import-execute-btn').addEventListener('click', executeRedmineImport);

  // BM-074: GitLabタブの配線(トラッカー・階層化が無いため、Redmineより単純)
  githubImportEl.querySelector('#gitlab-import-settings-btn').addEventListener('click', () => {
    const prefix = githubImportEl.querySelector('#gitlab-import-project').value;
    const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
    openSettingsPanel(Object.keys(prefixMap).find(name => prefixMap[name] === prefix) || '');
  });
  githubImportEl.querySelector('#gitlab-import-project').addEventListener('change', onGitlabImportProjectChange);
  githubImportEl.querySelector('#gitlab-import-list-btn').addEventListener('click', () => loadGitlabImportList({ reset: true }));
  githubImportEl.querySelector('#gitlab-import-body').addEventListener('click', (e) => {
    if (e.target.closest('#gitlab-import-load-more-btn')) loadGitlabImportList({ reset: false });
  });
  githubImportEl.querySelector('#gitlab-import-body').addEventListener('change', (e) => {
    if (e.target.classList.contains('gitlab-issue-checkbox')) updateGitlabImportSelection();
  });
  githubImportEl.querySelector('#gitlab-import-execute-btn').addEventListener('click', executeGitlabImport);

  // BM-099: 列幅のドラッグ/ダブルクリック(ガントの.gantt-resizerと同じ操作感)。
  // モーダル単位で1回配線すれば、GitHub/Redmine/GitLab 3タブの.import-tableすべてに効く
  githubImportEl.addEventListener('pointerdown', (e) => {
    const resizer = e.target.closest('.import-resizer');
    if (resizer && e.button === 0) beginImportColResize(e, resizer);
  });
  githubImportEl.addEventListener('dblclick', (e) => {
    const resizer = e.target.closest('.import-resizer');
    if (resizer) autoFitImportColWidth(resizer);
  });

  return githubImportEl;
}

function closeGithubImportModal() {
  if (githubImportEl) githubImportEl.classList.remove('modal-visible');
  hideImportTip(); // BM-099: モーダルを閉じてもツールチップが残らないようにする
}

// BM-073: GitHub/Redmineタブの表示切り替え。パネルのhidden属性とタブのactiveクラスだけを操作し、
// 各タブの内部状態(選択済みissue等)は保持する(タブを往復しても選択が消えない)。
function switchImportSourceTab(source) {
  if (source !== 'github' && source !== 'redmine' && source !== 'gitlab') return;
  importSourceTab = source;
  const el = githubImportEl;
  el.querySelectorAll('.import-source-tab').forEach((btn) => {
    const active = btn.dataset.source === source;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  el.querySelectorAll('.import-source-panel').forEach((panel) => {
    panel.hidden = panel.dataset.sourcePanel !== source;
  });
  // BT-415: ワークスペースが選択済みでトラッカー未取得なら、Redmineタブを開いた時点で読み込む
  if (source === 'redmine') loadRedmineImportTrackersIfNeeded();
}

// BT-415: 通信待ちが「固まった」ように見えないよう、スピナー付きの読み込み中表示を使う
function importLoadingHtml(message) {
  return `<p class="github-import-placeholder import-loading"><span class="import-spinner" aria-hidden="true"></span>${message}</p>`;
}

// BT-415: 取り込み一覧(GitHub/Redmine共通)は、列見出し+1チケット1行のテーブル表示にする。
// 列は {key, label, width}。widthはCSSのgrid-template-columnsにそのまま渡す。
const IMPORT_COL_CHECK = { key: 'check', label: '', width: '28px' };
// BM-099追補(ヒデさんフィードバック): タイトルは元々flex(minmax(0,1fr))で残りスペースを吸収する
// 列だったため、他の列(担当など)を広げるとタイトルが連動して縮み、結果的に境界線の見た目の
// 位置がドラッグ方向と逆に動く(ように見える)現象が起きていた。タイトルも他列と同じ「固定幅+
// ドラッグでリサイズ可能」な列にすることで、掴んだ列だけが変わる単純な操作に揃える
// (テーブル全体の横幅は.import-tableのmin-widthで確保し、広がった分は横スクロールで吸収する)。
const IMPORT_COL_TITLE = { key: 'title', label: 'タイトル', width: '380px' };
const IMPORT_COLS_GITHUB = [
  IMPORT_COL_CHECK,
  { key: 'id', label: '#', width: '64px' },
  IMPORT_COL_TITLE,
  { key: 'state', label: '状態', width: '72px' },
  { key: 'imported', label: '取込済み', width: '120px' },
];
// BM-099: 件名だけだと分かりにくいため、担当・バージョンの列を追加
const IMPORT_COLS_REDMINE = [
  IMPORT_COL_CHECK,
  { key: 'id', label: '#', width: '64px' },
  IMPORT_COL_TITLE,
  { key: 'assignee', label: '担当', width: '96px' },
  { key: 'version', label: 'バージョン', width: '110px' },
  { key: 'state', label: 'ステータス', width: '104px' },
  { key: 'due', label: '期日', width: '92px' },
  { key: 'imported', label: '取込済み', width: '120px' },
];
// BM-074: GitLabは階層化しない(方針F)ため子の概念が無く、列構成はRedmineと同じ形で流用できる
const IMPORT_COLS_GITLAB = [
  IMPORT_COL_CHECK,
  { key: 'id', label: '#', width: '64px' },
  IMPORT_COL_TITLE,
  { key: 'state', label: '状態', width: '72px' },
  { key: 'due', label: '期日', width: '92px' },
  { key: 'imported', label: '取込済み', width: '120px' },
];

// BM-099: 列幅はドラッグ/ダブルクリックで調整できる(ガントの.gantt-resizerと同じ操作感)。
// 列キー単位でlocalStorageに保持するため、GitHub/Redmine/GitLab 3タブで同じキー(id/state/due/imported等)
// は幅を共有し、タブ切り替え・次回起動後も引き継がれる。check/title列は対象外(固定幅/flex)。
const IMPORT_COL_W_MIN = 40;
const IMPORT_COL_W_MAX = 400;

function loadImportColWidths() {
  try {
    const raw = localStorage.getItem('importColWidths');
    if (raw) return JSON.parse(raw) || {};
  } catch { /* 無視 */ }
  return {};
}
let importColWidths = loadImportColWidths();
function saveImportColWidths() {
  try { localStorage.setItem('importColWidths', JSON.stringify(importColWidths)); } catch { /* 無視 */ }
}

function resolveImportColWidth(col) {
  if (col.key === 'check') return col.width;
  const saved = importColWidths[col.key];
  return saved ? `${saved}px` : col.width;
}

function renderImportTable(cols, rowsHtml) {
  const widths = cols.map((c) => resolveImportColWidth(c));
  const isResizable = (c) => c.key !== 'check';
  const head = cols.map((c) => {
    if (!isResizable(c)) return `<span class="import-cell import-cell-${c.key}">${c.label}</span>`;
    const title = 'ドラッグで列幅を変更（ダブルクリックで内容に合わせる）';
    // BM-099追補2回目(ヒデさんフィードバック): 「左端の境界線を動かす」設計は、タイトルのような
    // 固定幅列を間に挟むと「見た目の境界線の位置」と「実際に動く境界線」がズレて逆転して見える
    // (左端は前の列の幅で決まり、ドラッグしても動かない。実際に動くのは右側のもう1本先の境界)。
    // Excelと同じ「列の右端の境界線=その列自身の右端」に統一する。これなら境界線は常に
    // ドラッグ対象の列自身の端そのものなので、見た目の位置とマウスの動きが必ず一致する。
    // タイトルも固定幅のリサイズ対象列にしたため、全列が自分の右端リサイザーを持つだけで
    // check以外のすべての境界線が1本ずつ埋まる(「タイトルの左に境界が無い」問題も、
    // idの右端リサイザーがその場所を担うことで自動的に解消する)。
    return `<span class="import-cell import-cell-${c.key}"><span class="import-head-label">${c.label}</span><i class="import-resizer" data-col-key="${c.key}" title="${title}"></i></span>`;
  }).join('');
  // 幅の再構築に必要な列定義(key, デフォルトwidth)をDOMに持たせる(再描画後もリサイズ処理から参照できるように)
  const colsMeta = JSON.stringify(cols.map((c) => ({ key: c.key, width: c.width }))).replace(/'/g, '&#39;');
  return `<div class="import-table" data-cols='${colsMeta}' style="--import-cols:${widths.join(' ')}">` +
    `<div class="import-row import-row-head">${head}</div>${rowsHtml}</div>`;
}

// table要素の--import-colsを、overrideKeyの列だけoverridePxに差し替えて再構築する。
// (他の列はresolveImportColWidthで現在の保存値/デフォルトを使う。minmax(0,1fr)のtitle列は
// スペースを含むため単純なsplit(' ')では復元できず、data-colsのJSON定義から組み直す)
function rebuildImportColsVar(table, overrideKey, overridePx) {
  let colsMeta;
  try { colsMeta = JSON.parse(table.dataset.cols || '[]'); } catch { return; }
  const widths = colsMeta.map((c) => (c.key === overrideKey ? `${Math.round(overridePx)}px` : resolveImportColWidth(c)));
  table.style.setProperty('--import-cols', widths.join(' '));
}

// Excelの列幅調整と同じ操作感: 列の左端の境界線をドラッグした方向に、その列自身が伸び縮みする
function beginImportColResize(e, resizer) {
  e.preventDefault();
  const colKey = resizer.dataset.colKey;
  const table = resizer.closest('.import-table');
  const cell = resizer.closest('.import-cell');
  if (!table || !cell) return;
  hideImportTip();
  const x0 = e.clientX;
  const w0 = cell.getBoundingClientRect().width;
  const move = (ev) => {
    const w = Math.max(IMPORT_COL_W_MIN, Math.min(IMPORT_COL_W_MAX, w0 + (ev.clientX - x0)));
    rebuildImportColsVar(table, colKey, w);
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.classList.remove('gantt-resizing');
    importColWidths[colKey] = Math.round(cell.getBoundingClientRect().width);
    saveImportColWidths();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.body.classList.add('gantt-resizing');
}

// ガントのautoFitLabelWidthと同じ操作感: ダブルクリックで、表示中の内容に収まる最大幅へ自動調整する
function autoFitImportColWidth(resizer) {
  const colKey = resizer.dataset.colKey;
  const table = resizer.closest('.import-table');
  if (!table || !colKey) return;
  const cells = [...table.querySelectorAll(`.import-cell-${colKey}`)];
  if (!cells.length) return;
  let need = 0;
  for (const c of cells) need = Math.max(need, c.scrollWidth);
  const w = Math.max(IMPORT_COL_W_MIN, Math.min(IMPORT_COL_W_MAX, need + 4));
  importColWidths[colKey] = w;
  saveImportColWidths();
  rebuildImportColsVar(table, colKey, w);
}

// cells: [[colKey, html, titleAttr?], ...]。子行は.import-row-child(直前の親行の続きに並べる)
function renderImportRow({ epic = false, child = false, imported = false }, cells) {
  const cls = ['import-row', epic ? 'import-row-epic' : '', child ? 'import-row-child' : '', imported ? 'import-row-imported' : '']
    .filter(Boolean).join(' ');
  const cellHtml = cells.map(([key, html, title]) =>
    `<span class="import-cell import-cell-${key}"${title ? ` title="${escapeHtml(title)}"` : ''}>${html}</span>`).join('');
  return `<div class="${cls}">${cellHtml}</div>`;
}

function renderImportChildBadge(children) {
  const closedCount = children.filter((c) => c.state === 'closed').length;
  const allDone = closedCount === children.length;
  return `<span class="card-badge${allDone ? ' badge-done' : ''}"><span class="badge-num">${closedCount}</span><span class="badge-den">/${children.length}</span></span>`;
}

function renderImportTitleHtml(markSvg, title, badgeHtml) {
  return `${markSvg}<span class="import-title-text">${escapeHtml(title)}</span>${badgeHtml || ''}`;
}

// BM-099/BT-422: 取り込み一覧の番号・件名を元issueへのリンク(新規タブ)にする。3タブ共通。
// 件名リンクのdata-import-source/data-issue-keyは、ホバーのツールチップがissueを引くために使う
function renderImportIdLinkHtml(key, url) {
  return `<a class="import-id-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(key)}</a>`;
}

function renderImportTitleLinkHtml(source, key, url, innerHtml) {
  return `<a class="import-title-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" data-import-source="${source}" data-issue-key="${escapeHtml(key)}">${innerHtml}</a>`;
}

// BT-415: メインボードで絞り込み中のワークスペースのprefix。All Projects(または未連携)なら空文字
function getImportDefaultPrefix() {
  const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
  const workspaceMap = (currentBoardData && currentBoardData.workspaceMap) || {};
  return (currentFilter && workspaceMap[currentFilter] && prefixMap[currentFilter]) || '';
}

// BT-415: GitHubタブの一覧・選択・件数表示を取得前の状態へ戻す(通信はしない)
function onGithubImportProjectChange() {
  const el = githubImportEl;
  const prefix = el.querySelector('#github-import-project').value;
  githubImportAllIssues = [];
  resetGithubImportSelectionUi();
  resetGithubImportFilterCounts();
  el.querySelector('#github-import-result-tools').hidden = true;
  el.querySelector('#github-import-fetch-btn').disabled = !prefix;
  el.querySelector('#github-import-body').innerHTML = prefix
    ? `<p class="github-import-placeholder">「Issueを取得」を押してください。</p>`
    : `<p class="github-import-placeholder">プロジェクトを選択してください。</p>`;
}

// BT-107: 「Issueを取得」で、選択中プロジェクトのGitHub Issue一覧(プレビュー、md書き込みなし)を取得・表示
async function loadGithubImportPreview() {
  const el = githubImportEl;
  const prefix = el.querySelector('#github-import-project').value;
  const bodyEl = el.querySelector('#github-import-body');
  const fetchBtn = el.querySelector('#github-import-fetch-btn');
  resetGithubImportSelectionUi();
  resetGithubImportFilterCounts();
  githubImportAllIssues = [];
  el.querySelector('#github-import-result-tools').hidden = true;
  if (!prefix) {
    bodyEl.innerHTML = `<p class="github-import-placeholder">プロジェクトを選択してください。</p>`;
    return;
  }
  bodyEl.innerHTML = importLoadingHtml('GitHubからIssueを読み込み中...');
  fetchBtn.disabled = true;
  fetchBtn.textContent = '取得中...';
  try {
    const res = await fetch(`/api/github-preview-issues?prefix=${encodeURIComponent(prefix)}`);
    const data = await res.json();
    if (prefix !== el.querySelector('#github-import-project').value) return; // 取得中にセレクタが変わった
    if (!res.ok) throw new Error(data.error || '取得に失敗しました');
    githubImportAllIssues = data.issues;
    el.querySelector('#github-import-result-tools').hidden = false;
    renderGithubImportIssueList();
  } catch (e) {
    if (prefix !== el.querySelector('#github-import-project').value) return;
    githubImportAllIssues = [];
    bodyEl.innerHTML = `<p class="github-import-placeholder">エラー: ${escapeHtml(e.message)}</p>`;
  } finally {
    fetchBtn.textContent = 'Issueを取得';
    fetchBtn.disabled = !el.querySelector('#github-import-project').value;
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
    ? renderImportTable(IMPORT_COLS_GITHUB, topLevelIssues.map((issue) => renderGithubImportIssueCard(issue, issueByNumber)).join(''))
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
const GITHUB_MARK_SVG = '<svg class="github-mark-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.1-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.47-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path></svg>';

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
  const checkboxHtml = issue.alreadyImported
    ? `<input type="checkbox" class="github-issue-checkbox" disabled title="取込済み">`
    : `<input type="checkbox" class="github-issue-checkbox" data-issue-number="${issue.number}">`;

  const children = (issue.childIssueNumbers || [])
    .map((num) => issueByNumber && issueByNumber.get(num))
    .filter(Boolean);
  const parentRow = renderImportRow({ epic: children.length > 0, imported: issue.alreadyImported }, [
    ['check', checkboxHtml],
    ['id', renderImportIdLinkHtml(String(issue.number), issue.url)],
    ['title', renderImportTitleLinkHtml('github', String(issue.number), issue.url, renderImportTitleHtml(GITHUB_MARK_SVG, issue.title, children.length > 0 ? renderImportChildBadge(children) : ''))],
    ['state', issue.state === 'closed' ? '<span class="card-tag github-issue-closed">closed</span>' : 'open'],
    ['imported', issue.alreadyImported ? renderGithubImportedTag(issue.importedTaskId) : ''],
  ]);
  return parentRow + children.map(renderGithubImportChildCard).join('');
}

function renderGithubImportChildCard(issue) {
  return renderImportRow({ child: true, imported: issue.alreadyImported }, [
    ['check', ''], // 子は単独で選択できない(親を取り込むと一括で追従する)
    ['id', renderImportIdLinkHtml(String(issue.number), issue.url)],
    ['title', renderImportTitleLinkHtml('github', String(issue.number), issue.url, renderImportTitleHtml(GITHUB_MARK_SVG, issue.title))],
    ['state', issue.state === 'closed' ? '<span class="card-tag github-issue-closed">closed</span>' : 'open'],
    ['imported', issue.alreadyImported ? renderGithubImportedTag(issue.importedTaskId) : ''],
  ]);
}

function openGithubImportModal() {
  const el = getOrCreateGithubImportModal();
  populateGithubImportProjectSelect(el.querySelector('#github-import-project'));
  populateRedmineImportProjectSelect(el.querySelector('#redmine-import-project')); // BM-073
  populateGitlabImportProjectSelect(el.querySelector('#gitlab-import-project')); // BM-074
  // BT-415: メインボードで選択中のワークスペースを初期値にする(All Projectsなら前回値のまま)。
  // changeイベントは発火させず、通信は「Issueを取得」/Redmineタブ表示まで起こさない
  const defaultPrefix = getImportDefaultPrefix();
  if (defaultPrefix) {
    const githubSelect = el.querySelector('#github-import-project');
    if (githubSelect.value !== defaultPrefix) {
      githubSelect.value = defaultPrefix;
      onGithubImportProjectChange();
    }
    const redmineSelect = el.querySelector('#redmine-import-project');
    if (redmineSelect.value !== defaultPrefix) {
      redmineSelect.value = defaultPrefix;
      onRedmineImportProjectChange();
    }
    const gitlabSelect = el.querySelector('#gitlab-import-project');
    if (gitlabSelect.value !== defaultPrefix) {
      gitlabSelect.value = defaultPrefix;
      onGitlabImportProjectChange();
    }
  }
  // BT-449: ワークスペースごとに前回のタブで開く(保存が無ければGitHub。BM-073の「常にGitHub」を置き換え)
  switchImportSourceTab(getSavedImportSourceTab(el.querySelector('#github-import-project').value));
  el.classList.add('modal-visible');
}

githubImportBtn.addEventListener('click', openGithubImportModal);

// --- Redmineチケット取り込みタブ (BM-073) ---
// GitHubタブ(githubImportAllIssues等)とは状態を分離する。設定済み(configured)のワークスペースのみ
// プロジェクトselectに出す(its-settingsのredmine.configuredで判定)。
function populateRedmineImportProjectSelect(selectEl) {
  const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
  const workspaceMap = (currentBoardData && currentBoardData.workspaceMap) || {};
  const names = Object.keys(prefixMap).filter(name => workspaceMap[name]).sort();
  const prevValue = selectEl.value;
  selectEl.innerHTML = `<option value="">ワークスペースを選択...</option>` +
    names.map(name => `<option value="${prefixMap[name]}">${name} (${prefixMap[name]})</option>`).join('');
  if (names.some(name => prefixMap[name] === prevValue)) selectEl.value = prevValue;
}

let redmineImportAllIssues = []; // 読み込み済み全件(「さらに読み込む」で積み増す)
let redmineImportNextOffset = null; // nullなら続きなし
let redmineImportTotal = 0;
let redmineImportSelectedKeys = new Set(); // 選択中issueキー(文字列)
let redmineImportLoadingMore = false;

function redmineImportEls() {
  const el = githubImportEl;
  return {
    project: el.querySelector('#redmine-import-project'),
    tracker: el.querySelector('#redmine-import-tracker'),
    status: el.querySelector('#redmine-import-status'),
    listBtn: el.querySelector('#redmine-import-list-btn'),
    totalCount: el.querySelector('#redmine-import-total-count'),
    body: el.querySelector('#redmine-import-body'),
    selectedCount: el.querySelector('#redmine-import-selected-count'),
    executeBtn: el.querySelector('#redmine-import-execute-btn'),
  };
}

function resetRedmineImportState() {
  redmineImportAllIssues = [];
  redmineImportNextOffset = null;
  redmineImportTotal = 0;
  redmineImportSelectedKeys.clear();
}

let redmineTrackersLoadedPrefix = ''; // BT-415: トラッカー取得済みのワークスペースprefix(空=未取得)

// BM-099: 最後に選んだトラッカーをワークスペース(prefix)単位で覚える(ヒデさんフィードバック)。
// ワークスペースを切り替えても、過去に選んだトラッカーがあれば自動で選択し直す
function loadRedmineLastTrackerByPrefix() {
  try {
    const raw = localStorage.getItem('redmineLastTrackerByPrefix');
    if (raw) return JSON.parse(raw) || {};
  } catch { /* 無視 */ }
  return {};
}
let redmineLastTrackerByPrefix = loadRedmineLastTrackerByPrefix();
function saveRedmineLastTracker(prefix, trackerId) {
  if (!prefix) return;
  redmineLastTrackerByPrefix[prefix] = trackerId;
  try { localStorage.setItem('redmineLastTrackerByPrefix', JSON.stringify(redmineLastTrackerByPrefix)); } catch { /* 無視 */ }
}

// ワークスペース変更時: 表示を初期化し、Redmineタブを表示中ならトラッカー一覧を取得する。
// 初期選択でモーダルを開いただけ(GitHubタブ表示中)では通信せず、タブを切り替えた時に取得する(BT-415)
function onRedmineImportProjectChange() {
  const els = redmineImportEls();
  resetRedmineImportState();
  redmineTrackersLoadedPrefix = '';
  els.tracker.innerHTML = `<option value="">トラッカーを選択...</option>`;
  els.tracker.disabled = true;
  els.listBtn.disabled = true;
  els.totalCount.textContent = '';
  els.body.innerHTML = `<p class="github-import-placeholder">ワークスペースを選択してください。</p>`;
  resetRedmineImportSelectionUi();
  if (importSourceTab === 'redmine') loadRedmineImportTrackersIfNeeded();
}

// トラッカー一覧をits-metaで取得する。未設定ワークスペースはエラー文言を出す
async function loadRedmineImportTrackersIfNeeded() {
  const els = redmineImportEls();
  const prefix = els.project.value;
  if (!prefix || redmineTrackersLoadedPrefix === prefix) return;
  els.body.innerHTML = importLoadingHtml('Redmineからトラッカーを読み込み中...');
  els.tracker.innerHTML = `<option value="">読み込み中...</option>`;
  try {
    const res = await fetch(`/api/its-meta?prefix=${encodeURIComponent(prefix)}&source=redmine`);
    const data = await res.json();
    if (prefix !== els.project.value) return; // 取得中にワークスペースが変わった(新しい方が処理する)
    if (!res.ok) throw new Error(data.error || '取得に失敗しました');
    els.tracker.innerHTML = `<option value="">トラッカーを選択...</option>` +
      data.trackers.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    els.tracker.disabled = false;
    redmineTrackersLoadedPrefix = prefix;
    // BM-099: このワークスペースで最後に選んだトラッカーが選択肢に残っていれば復元する
    const lastTracker = redmineLastTrackerByPrefix[prefix];
    if (lastTracker && els.tracker.querySelector(`option[value="${lastTracker}"]`)) {
      els.tracker.value = lastTracker;
    }
    updateRedmineImportListButtonState();
    els.body.innerHTML = `<p class="github-import-placeholder">トラッカーを選択し、「一覧を出す」を押してください。</p>`;
  } catch (e) {
    if (prefix !== els.project.value) return;
    els.tracker.innerHTML = `<option value="">トラッカーを選択...</option>`;
    els.body.innerHTML = `<p class="github-import-placeholder">エラー: ${escapeHtml(e.message)}</p>`;
  }
}

// BM-069方針E→BM-099で変更: トラッカーを選ぶまで「一覧を出す」は押せない(hiddenではなくdisabled)。
// GitHubの「Issueを取得」ボタンと同じ挙動にし、押せる状態になったら色が変わる(import-primary-btn)
function updateRedmineImportListButtonState() {
  const els = redmineImportEls();
  els.listBtn.disabled = !els.tracker.value;
}

// 一覧取得・「さらに読み込む」(reset:falseでnextOffsetから続きを積み増す)
async function loadRedmineImportList({ reset }) {
  const els = redmineImportEls();
  const prefix = els.project.value;
  const trackerId = els.tracker.value;
  if (!prefix || !trackerId) return;
  if (reset) {
    resetRedmineImportState();
    els.body.innerHTML = importLoadingHtml('Redmineからチケットを読み込み中...');
  } else {
    if (redmineImportNextOffset === null || redmineImportLoadingMore) return;
    redmineImportLoadingMore = true;
  }
  const statusFilter = els.status.value === 'all' ? 'all' : 'open';
  const offset = reset ? 0 : redmineImportNextOffset;
  try {
    const qs = new URLSearchParams({ prefix, source: 'redmine', trackerId, status: statusFilter, offset: String(offset) });
    const res = await fetch(`/api/its-preview?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '取得に失敗しました');
    redmineImportAllIssues = reset ? data.issues : redmineImportAllIssues.concat(data.issues);
    redmineImportNextOffset = data.nextOffset;
    redmineImportTotal = data.total;
    renderRedmineImportIssueList();
  } catch (e) {
    if (reset) {
      els.body.innerHTML = `<p class="github-import-placeholder">エラー: ${escapeHtml(e.message)}</p>`;
    } else {
      els.totalCount.textContent = `さらに読み込むのに失敗しました: ${e.message}`;
    }
  } finally {
    redmineImportLoadingMore = false;
  }
}

// 読み込み済みの範囲内だけで親子を組み直す(BM-069方針D)。childKeysは
// its-import-api.jsが選択集合内で既に計算して返すが、「さらに読み込む」で
// 範囲が広がるたびにクライアント側でも組み直す(サーバー側は毎回のoffset分だけの計算のため)
function renderRedmineImportIssueList() {
  const els = redmineImportEls();
  if (redmineImportAllIssues.length === 0) {
    els.body.innerHTML = `<p class="github-import-placeholder">チケットが見つかりませんでした。</p>`;
    els.totalCount.textContent = '';
    return;
  }
  const issueByKey = new Map(redmineImportAllIssues.map((i) => [i.key, i]));
  const allChildKeys = new Set();
  for (const i of redmineImportAllIssues) {
    if (i.parentKey && issueByKey.has(i.parentKey)) allChildKeys.add(i.key);
  }
  const topLevelIssues = redmineImportAllIssues.filter((i) => !allChildKeys.has(i.key));
  els.totalCount.textContent = redmineImportNextOffset !== null
    ? `読み込み済み ${redmineImportAllIssues.length} / 全${redmineImportTotal}件`
    : `${redmineImportAllIssues.length} / 全${redmineImportTotal}件`;
  const loadMoreHtml = redmineImportNextOffset !== null
    ? `<button id="redmine-import-load-more-btn" class="redmine-import-load-more">さらに読み込む（残り${redmineImportTotal - redmineImportAllIssues.length}件）</button>`
    : '';
  els.body.innerHTML = (topLevelIssues.length > 0
    ? renderImportTable(IMPORT_COLS_REDMINE, topLevelIssues.map((issue) => renderRedmineImportIssueCard(issue, issueByKey, allChildKeys)).join(''))
    : `<p class="github-import-placeholder">条件に一致するチケットがありません。</p>`) + loadMoreHtml;
}

function resetRedmineImportSelectionUi() {
  redmineImportSelectedKeys.clear();
  const els = redmineImportEls();
  els.selectedCount.textContent = '0件選択中';
  els.executeBtn.textContent = '選択した0件を取り込む';
  els.executeBtn.disabled = true;
}

function updateRedmineImportSelection() {
  const els = redmineImportEls();
  const checked = els.body.querySelectorAll('.redmine-issue-checkbox:checked');
  redmineImportSelectedKeys = new Set(Array.from(checked).map(cb => cb.dataset.issueKey));
  const count = redmineImportSelectedKeys.size;
  els.selectedCount.textContent = `${count}件選択中`;
  els.executeBtn.textContent = `選択した${count}件を取り込む`;
  els.executeBtn.disabled = count === 0;
}

async function executeRedmineImport() {
  const els = redmineImportEls();
  const prefix = els.project.value;
  const keys = Array.from(redmineImportSelectedKeys);
  if (!prefix || keys.length === 0) return;
  els.executeBtn.disabled = true;
  els.executeBtn.textContent = '取り込み中...';
  try {
    const res = await fetch('/api/its-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, source: 'redmine', keys }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '取り込みに失敗しました');
    await loadRedmineImportList({ reset: true });
  } catch (e) {
    els.selectedCount.textContent = `エラー: ${e.message}`;
    updateRedmineImportSelection();
  }
}

// --- GitLab issue取り込みタブ (BM-074) ---
// Redmineタブと状態を分離する。GitLabにはトラッカー・階層化の概念が無いため、
// Redmine版からその2点を抜いたシンプルな構成になる(トラッカー選択ボタンが無く、
// ワークスペースを選べばすぐ「一覧を出す」が押せる)。
function populateGitlabImportProjectSelect(selectEl) {
  const prefixMap = (currentBoardData && currentBoardData.projectPrefixMap) || {};
  const workspaceMap = (currentBoardData && currentBoardData.workspaceMap) || {};
  const names = Object.keys(prefixMap).filter(name => workspaceMap[name]).sort();
  const prevValue = selectEl.value;
  selectEl.innerHTML = `<option value="">ワークスペースを選択...</option>` +
    names.map(name => `<option value="${prefixMap[name]}">${name} (${prefixMap[name]})</option>`).join('');
  if (names.some(name => prefixMap[name] === prevValue)) selectEl.value = prevValue;
}

let gitlabImportAllIssues = []; // 読み込み済み全件(「さらに読み込む」で積み増す)
let gitlabImportNextOffset = null; // nullなら続きなし
let gitlabImportTotal = null; // GitLabはx-totalが取れない場合null(「全件数不明」として表示)
let gitlabImportSelectedKeys = new Set(); // 選択中issueキー(文字列)
let gitlabImportLoadingMore = false;

function gitlabImportEls() {
  const el = githubImportEl;
  return {
    project: el.querySelector('#gitlab-import-project'),
    status: el.querySelector('#gitlab-import-status'),
    listBtn: el.querySelector('#gitlab-import-list-btn'),
    totalCount: el.querySelector('#gitlab-import-total-count'),
    body: el.querySelector('#gitlab-import-body'),
    selectedCount: el.querySelector('#gitlab-import-selected-count'),
    executeBtn: el.querySelector('#gitlab-import-execute-btn'),
  };
}

function resetGitlabImportState() {
  gitlabImportAllIssues = [];
  gitlabImportNextOffset = null;
  gitlabImportTotal = null;
  gitlabImportSelectedKeys.clear();
}

// ワークスペース変更時: 表示を初期化する(トラッカーが無いため、Redmineと違って通信の遅延読み込みは不要。
// 「一覧を出す」ボタンを押すまでは通信しない点はRedmineと同じ)。
// GitHubの「Issueを取得」ボタンと同じく、ワークスペース未選択時はdisabledにする
// (Redmineは対応するボタンをhiddenにする形だが、GitLabにはトラッカー選択のステップが無いため、
// ワークスペース未選択=押せない、をdisabledで表現する)
function onGitlabImportProjectChange() {
  const els = gitlabImportEls();
  resetGitlabImportState();
  els.listBtn.disabled = !els.project.value;
  els.totalCount.textContent = '';
  els.body.innerHTML = els.project.value
    ? `<p class="github-import-placeholder">「一覧を出す」を押してください。</p>`
    : `<p class="github-import-placeholder">ワークスペースを選択してください。</p>`;
  resetGitlabImportSelectionUi();
}

// 一覧取得・「さらに読み込む」(reset:falseでnextOffsetから続きを積み増す)
async function loadGitlabImportList({ reset }) {
  const els = gitlabImportEls();
  const prefix = els.project.value;
  if (!prefix) return;
  if (reset) {
    resetGitlabImportState();
    els.body.innerHTML = importLoadingHtml('GitLabからissueを読み込み中...');
  } else {
    if (gitlabImportNextOffset === null || gitlabImportLoadingMore) return;
    gitlabImportLoadingMore = true;
  }
  const statusFilter = els.status.value === 'all' ? 'all' : 'open';
  const offset = reset ? 0 : gitlabImportNextOffset;
  try {
    const qs = new URLSearchParams({ prefix, source: 'gitlab', status: statusFilter, offset: String(offset) });
    const res = await fetch(`/api/its-preview?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '取得に失敗しました');
    gitlabImportAllIssues = reset ? data.issues : gitlabImportAllIssues.concat(data.issues);
    gitlabImportNextOffset = data.nextOffset;
    gitlabImportTotal = data.total;
    renderGitlabImportIssueList();
  } catch (e) {
    if (reset) {
      els.body.innerHTML = `<p class="github-import-placeholder">エラー: ${escapeHtml(e.message)}</p>`;
    } else {
      els.totalCount.textContent = `さらに読み込むのに失敗しました: ${e.message}`;
    }
  } finally {
    gitlabImportLoadingMore = false;
  }
}

// BM-074: 階層化しない(方針F)ため、Redmineの親子組み直しロジックは無く常にフラット一覧になる
function renderGitlabImportIssueList() {
  const els = gitlabImportEls();
  if (gitlabImportAllIssues.length === 0) {
    els.body.innerHTML = `<p class="github-import-placeholder">issueが見つかりませんでした。</p>`;
    els.totalCount.textContent = '';
    return;
  }
  // GitLabはx-totalが取れない場合totalがnullになる(its-import-api.js参照)。その場合は件数不明として表示する
  const totalLabel = gitlabImportTotal === null ? '件数不明' : `全${gitlabImportTotal}件`;
  els.totalCount.textContent = gitlabImportNextOffset !== null
    ? `読み込み済み ${gitlabImportAllIssues.length} / ${totalLabel}`
    : `${gitlabImportAllIssues.length} / ${totalLabel}`;
  const loadMoreHtml = gitlabImportNextOffset !== null
    ? `<button id="gitlab-import-load-more-btn" class="redmine-import-load-more">さらに読み込む</button>`
    : '';
  els.body.innerHTML = renderImportTable(IMPORT_COLS_GITLAB, gitlabImportAllIssues.map((issue) => renderGitlabImportRow(issue)).join('')) + loadMoreHtml;
}

function renderGitlabImportRow(issue) {
  const checkboxHtml = issue.alreadyImported
    ? `<input type="checkbox" class="gitlab-issue-checkbox" disabled title="取込済み">`
    : `<input type="checkbox" class="gitlab-issue-checkbox" data-issue-key="${escapeHtml(issue.key)}">`;
  const stateHtml = issue.state === 'closed'
    ? '<span class="card-tag github-issue-closed">closed</span>'
    : escapeHtml(issue.statusName);
  return renderImportRow({ imported: issue.alreadyImported }, [
    ['check', checkboxHtml],
    ['id', renderImportIdLinkHtml(issue.key, issue.url)],
    ['title', renderImportTitleLinkHtml('gitlab', issue.key, issue.url, renderImportTitleHtml(GITLAB_MARK_SVG, issue.title, ''))],
    ['state', stateHtml],
    ['due', issue.dueDate ? escapeHtml(issue.dueDate) : ''],
    ['imported', issue.alreadyImported ? renderGitlabImportedTag(issue.importedTaskId) : ''],
  ]);
}

function renderGitlabImportedTag(taskId) {
  const idSuffix = taskId ? ` (${escapeHtml(taskId)})` : '';
  return `<span class="card-tag github-issue-imported">取込済み${idSuffix}</span>`;
}

function resetGitlabImportSelectionUi() {
  gitlabImportSelectedKeys.clear();
  const els = gitlabImportEls();
  els.selectedCount.textContent = '0件選択中';
  els.executeBtn.textContent = '選択した0件を取り込む';
  els.executeBtn.disabled = true;
}

function updateGitlabImportSelection() {
  const els = gitlabImportEls();
  const checked = els.body.querySelectorAll('.gitlab-issue-checkbox:checked');
  gitlabImportSelectedKeys = new Set(Array.from(checked).map(cb => cb.dataset.issueKey));
  const count = gitlabImportSelectedKeys.size;
  els.selectedCount.textContent = `${count}件選択中`;
  els.executeBtn.textContent = `選択した${count}件を取り込む`;
  els.executeBtn.disabled = count === 0;
}

async function executeGitlabImport() {
  const els = gitlabImportEls();
  const prefix = els.project.value;
  const keys = Array.from(gitlabImportSelectedKeys);
  if (!prefix || keys.length === 0) return;
  els.executeBtn.disabled = true;
  els.executeBtn.textContent = '取り込み中...';
  try {
    const res = await fetch('/api/its-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, source: 'gitlab', keys }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '取り込みに失敗しました');
    await loadGitlabImportList({ reset: true });
  } catch (e) {
    els.selectedCount.textContent = `エラー: ${e.message}`;
    updateGitlabImportSelection();
  }
}

// Redmineのロゴ(単色・currentColor)。GitHubのGITHUB_MARK_SVGと同じく、テーマの文字色に追従させる
const REDMINE_MARK_SVG = '<svg class="redmine-mark-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M1.092 15.088c.789.243 4.098 1.005 4.098 1.005c.198.061.139.21.139.21c-.228 1.798-.178 3.17-.178 3.644c0 .21-.153.18-.153.18H.168c-.209 0-.164-.19-.164-.19c.04-.599.212-2.303.878-4.746c0 0 .033-.157.21-.103m21.816 0c-.789.243-4.098 1.005-4.098 1.005c-.198.061-.139.21-.139.21c.228 1.798.178 3.17.178 3.644c0 .21.153.18.153.18h4.83c.21 0 .164-.19.164-.19c-.04-.599-.212-2.303-.878-4.746c0 0-.034-.157-.21-.103m-1.929-5.354l-3.448 1.667c-.164.063-.082.212-.082.212c.476 1.134.766 2.091.99 3.251c.038.194.169.132.169.132l3.879-1.684s.116-.044.068-.193c-.172-.531-1.05-2.649-1.402-3.341c0 0-.062-.105-.174-.044m-17.958 0l3.448 1.667c.164.063.082.212.082.212a15.6 15.6 0 0 0-.991 3.251c-.037.194-.169.132-.169.132l-3.878-1.684s-.116-.044-.068-.193c.172-.531 1.05-2.649 1.402-3.341c0 0 .062-.105.174-.044m4.085-4.368l2.302 2.681c.099.128-.032.222-.032.222c-.923.498-1.59 1.25-2.161 2.111c-.114.17-.236.046-.236.046L4.062 8.242s-.126-.074-.016-.22c.854-1.134 1.63-1.934 2.871-2.689c0 0 .094-.089.189.033m9.788 0l-2.302 2.681c-.099.128.032.222.032.222c.923.498 1.59 1.25 2.161 2.111c.114.17.236.046.236.046l2.917-2.184s.126-.074.016-.22c-.854-1.134-1.63-1.934-2.871-2.689c0 0-.094-.089-.189.033M12 7.661c.388 0 1.105.037 1.444.093c.177.03.221-.088.221-.088l1.449-3.028s.097-.114-.106-.188c-1.082-.396-1.657-.578-3.008-.578c-1.335 0-1.926.182-3.008.578c-.203.074-.106.188-.106.188l1.449 3.028s.044.118.221.088c.339-.056 1.056-.093 1.444-.093"></path></svg>';

function renderRedmineImportedTag(taskId) {
  const idSuffix = taskId ? ` (${escapeHtml(taskId)})` : '';
  return `<span class="card-tag github-issue-imported">取込済み${idSuffix}</span>`;
}

// BM-069方針D: 読み込み済みの選択集合内だけで親子を階層化する。親を選ぶと子も一緒に選択されるよう、
// 子チェックボックスは独立無効化はしない(親と一緒に選ぶ想定だが、個別選択も許容する=GitHub側と仕様を揃えない。
// Redmineは子だけ単独取り込みも許す方が自然なため)
function renderRedmineImportIssueCard(issue, issueByKey, allChildKeys) {
  const children = (issue.childKeys || [])
    .map((key) => issueByKey.get(key))
    .filter(Boolean);
  const parentRow = renderRedmineImportRow(issue, {
    epic: children.length > 0,
    parentKey: '',
    badgeHtml: children.length > 0 ? renderImportChildBadge(children) : '',
  });
  return parentRow + children.map((c) => renderRedmineImportRow(c, { child: true, parentKey: c.parentKey || '' })).join('');
}

// 親行・子行で列の中身は同じ。子行は字下げ(.import-row-child)だけが違い、期日も子に出す
// BM-099: チケット番号・件名はクリックでRedmineの元チケットを新規タブで開く(取込済みカードの
// renderRedmineIssueBadgeと同じパターン)。件名ホバーでは説明欄をツールチップ表示する
// (onImportTitleMouseOver。ネイティブtitle属性の全文ツールチップは置き換えるため付与しない)。
function renderRedmineImportRow(issue, { epic = false, child = false, parentKey, badgeHtml = '' }) {
  const checkboxHtml = issue.alreadyImported
    ? `<input type="checkbox" class="redmine-issue-checkbox" disabled title="取込済み">`
    : `<input type="checkbox" class="redmine-issue-checkbox" data-issue-key="${escapeHtml(issue.key)}" data-parent-key="${escapeHtml(parentKey)}">`;
  const stateHtml = issue.state === 'closed'
    ? '<span class="card-tag github-issue-closed">closed</span>'
    : escapeHtml(issue.statusName);
  const idHtml = renderImportIdLinkHtml(issue.key, issue.url);
  const titleHtml = renderImportTitleLinkHtml('redmine', issue.key, issue.url, renderImportTitleHtml(REDMINE_MARK_SVG, issue.title, badgeHtml));
  return renderImportRow({ epic, child, imported: issue.alreadyImported }, [
    ['check', checkboxHtml],
    ['id', idHtml],
    ['title', titleHtml],
    ['assignee', issue.assignee ? escapeHtml(issue.assignee) : ''],
    ['version', issue.version ? escapeHtml(issue.version) : ''],
    ['state', stateHtml],
    ['due', issue.dueDate ? escapeHtml(issue.dueDate) : ''],
    ['imported', issue.alreadyImported ? renderRedmineImportedTag(issue.importedTaskId) : ''],
  ]);
}

// --- BM-099: 件名ホバーの説明欄ツールチップ(ガントの.gantt-tip、gantt.js同パターンを流用) ---
let importTipEl = null;
let importTipShowTimer = null;
let importTipHideTimer = null;
const IMPORT_TIP_DELAY = 350;
const IMPORT_TIP_HIDE_DELAY = 250;

function ensureImportTip() {
  if (importTipEl) return importTipEl;
  importTipEl = document.createElement('div');
  importTipEl.className = 'gantt-tip'; // BM-099: ガントの吹き出し(.gantt-tip、gantt.css)の見た目を流用
  importTipEl.addEventListener('mouseenter', () => clearTimeout(importTipHideTimer));
  importTipEl.addEventListener('mouseleave', scheduleHideImportTip);
  document.body.appendChild(importTipEl);
  return importTipEl;
}

function hideImportTip() {
  clearTimeout(importTipShowTimer);
  clearTimeout(importTipHideTimer);
  if (importTipEl) importTipEl.classList.remove('gantt-tip-visible');
}

function scheduleHideImportTip() {
  clearTimeout(importTipShowTimer);
  clearTimeout(importTipHideTimer);
  importTipHideTimer = setTimeout(() => { if (importTipEl) importTipEl.classList.remove('gantt-tip-visible'); }, IMPORT_TIP_HIDE_DELAY);
}

function importTipHtml(issue) {
  const descHtml = issue.description
    ? escapeHtml(issue.description)
    : '<span class="gantt-tip-none">説明はありません</span>';
  return `<div class="gantt-tip-head"><span class="gantt-tip-id">#${escapeHtml(issue.key)}</span><span class="gantt-tip-title">${escapeHtml(issue.title)}</span></div><div class="gantt-tip-desc">${descHtml}</div>`;
}

// gantt.jsのpositionGanttTipと同じ位置決め(カーソル追従、画面端での折り返し)
function positionImportTip(tip, x, y) {
  const margin = 10;
  const left = Math.min(x + 6, window.innerWidth - tip.offsetWidth - margin);
  let top = y + 14;
  if (top + tip.offsetHeight > window.innerHeight - margin) top = Math.max(margin, y - tip.offsetHeight - 10);
  tip.style.left = `${Math.max(margin, left)}px`;
  tip.style.top = `${top}px`;
}

// BT-422: タブ(source)ごとの読み込み済みissueからツールチップ用のitem({key,title,description})を引く。
// GitHubはnumber/bodyなので、Redmine/GitLabのkey/descriptionの形に正規化して渡す
function findImportTipIssue(source, key) {
  if (source === 'github') {
    const issue = githubImportAllIssues.find((i) => String(i.number) === key);
    return issue && { key: String(issue.number), title: issue.title, description: issue.body };
  }
  const list = source === 'gitlab' ? gitlabImportAllIssues : redmineImportAllIssues;
  return list.find((i) => i.key === key);
}

function onImportTitleMouseOver(e) {
  const el = e.target.closest('.import-title-link');
  if (!el) return;
  const issue = findImportTipIssue(el.dataset.importSource, el.dataset.issueKey);
  if (!issue) return;
  clearTimeout(importTipHideTimer);
  clearTimeout(importTipShowTimer);
  const x = e.clientX;
  const y = e.clientY;
  importTipShowTimer = setTimeout(() => {
    const tip = ensureImportTip();
    tip.innerHTML = importTipHtml(issue);
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.classList.add('gantt-tip-visible');
    positionImportTip(tip, x, y);
  }, IMPORT_TIP_DELAY);
}

function onImportTitleMouseOut(e) {
  if (!e.target.closest('.import-title-link')) return;
  scheduleHideImportTip();
}

// GitLab公式ロゴ(タヌキ、多色版)の輪郭パスを単色化したもの(fill="currentColor"でテーマ追従、
// GitHub/Redmineと同じパターンに統一。BM-069方針2: 統一観点のため公式配色は維持しない)。
// パスデータ出典: 旧版 kiro-backlog-todo-db/backlog-dashboard/public/gitlab-icon.svg
const GITLAB_MARK_SVG = '<svg class="gitlab-mark-icon" viewBox="0 0 1000 963.197" width="16" height="16" fill="currentColor" aria-hidden="true"><g transform="matrix(5.2068817,0,0,5.2068817,-489.30756,-507.76085)"><path d="m 282.83,170.73 -0.27,-0.69 -26.14,-68.22 a 6.81,6.81 0 0 0 -2.69,-3.24 7,7 0 0 0 -8,0.43 7,7 0 0 0 -2.32,3.52 l -17.65,54 h -71.47 l -17.65,-54 a 6.86,6.86 0 0 0 -2.32,-3.53 7,7 0 0 0 -8,-0.43 6.87,6.87 0 0 0 -2.69,3.24 L 97.44,170 l -0.26,0.69 a 48.54,48.54 0 0 0 16.1,56.1 l 0.09,0.07 0.24,0.17 39.82,29.82 19.7,14.91 12,9.06 a 8.07,8.07 0 0 0 9.76,0 l 12,-9.06 19.7,-14.91 40.06,-30 0.1,-0.08 a 48.56,48.56 0 0 0 16.08,-56.04 z"/></g></svg>';

// BM-074: 取り込み済みタスクカードにGitLabアイコン+issue番号を表示(クリックで元issueを新規タブで開く)。
// GitHubの renderGithubIssueBadge と同じ見た目パターン。item.externalLinksからsource==='gitlab'を探す。
function renderGitlabIssueBadge(externalLinks) {
  const link = (externalLinks || []).find((l) => l.source === 'gitlab');
  if (!link) return '';
  const href = link.url ? escapeHtml(link.url) : '#';
  return `<a class="card-tag gitlab-issue-badge" href="${href}" target="_blank" rel="noopener noreferrer" title="GitLab #${escapeHtml(link.key)}">${GITLAB_MARK_SVG}#${escapeHtml(link.key)}</a>`;
}

// BM-073: 取り込み済みタスクカードにRedmineアイコン+チケット番号を表示(クリックで元チケットを新規タブで開く)。
// GitHubの renderGithubIssueBadge と同じ見た目パターン。item.externalLinksからsource==='redmine'を探す。
function renderRedmineIssueBadge(externalLinks) {
  const link = (externalLinks || []).find((l) => l.source === 'redmine');
  if (!link) return '';
  const href = link.url ? escapeHtml(link.url) : '#';
  return `<a class="card-tag redmine-issue-badge" href="${href}" target="_blank" rel="noopener noreferrer" title="Redmine #${escapeHtml(link.key)}">${REDMINE_MARK_SVG}#${escapeHtml(link.key)}</a>`;
}

// --- 開発用インスタンスのビジュアル差別化 (BT-185) ---
// DB化(BT-169)を並行運用で進める間、本番(md版)と複製先(DB版開発中)を見た目で区別するためのバッジ。
// config.jsonにdevInstanceLabelを設定した複製先だけで表示される（本番config.jsonにはキー自体が無い）。
(async () => {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.devInstanceLabel) {
      const badgeEl = document.getElementById('dev-instance-badge');
      badgeEl.textContent = data.devInstanceLabel;
      badgeEl.hidden = false;
      document.body.classList.add('dev-instance');
    }
    // バージョン表示 (BT-212): API/Dashboard/ルールファイルの世代照合に使う
    // BT-405: 稼働中のコミット(起動時固定)を併記。未コミット変更があれば末尾に+、ホバーで日時・件名。
    if (data.apiVersion) {
      const badgeEl = document.getElementById('version-badge');
      const c = data.commit;
      badgeEl.textContent = c ? `v${data.apiVersion} (${c.shortHash}${c.dirty ? '+' : ''})` : `v${data.apiVersion}`;
      if (c) {
        badgeEl.title = `${c.shortHash}${c.dirty ? '（未コミットの変更あり）' : ''}\n${formatCommitDate(c.date)}\n${c.subject}`;
      }
    }
  } catch (e) {
    console.error('[dev-instance-badge] Failed to fetch health:', e.message);
  }
})();

// --- Header Logo: クリックで「GitHubリポジトリを開く」か「更新を確認する」を選ぶメニューを開く (BT-162, BM-064) ---
// リポジトリURLはユーザーごとのgithub-credentials.json（Issue連携先）とは無関係に、
// サーバー側でclone元の`git remote origin`から解決した値を使う（誰の環境でも同じリンクになる）
headerLogoEl.addEventListener('click', () => {
  openProductMenu();
});

function getOrCreateProductMenu() {
  let el = document.getElementById('product-menu-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'product-menu-overlay';
  el.className = 'modal-overlay modal-front';
  el.innerHTML = `<div class="modal-content delete-confirm-modal"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeProductMenu();
  });
  closeOnEscape(el, 'modal-visible', closeProductMenu);
  return el;
}

function closeProductMenu() {
  const el = document.getElementById('product-menu-overlay');
  if (el) el.classList.remove('modal-visible');
  if (productMenuTipEl) productMenuTipEl.classList.remove('gantt-tip-visible');
}

/**
 * origin/mainの最新コミット情報を「コミット番号・日付・件名」の表示用HTMLに整形する。
 * @param {{shortHash: string, date: string, subject: string}|null} commit
 */
function formatLatestCommitHtml(commit) {
  if (!commit) return '';
  const d = new Date(commit.date);
  const dateText = Number.isNaN(d.getTime()) ? commit.date : d.toLocaleString('ja-JP');
  return `
    <p class="delete-confirm-text product-menu-commit">
      <span class="product-menu-commit-hash">${escapeHtml(commit.shortHash)}</span>
      <span class="product-menu-commit-date">${escapeHtml(dateText)}</span><br>
      ${escapeHtml(commit.subject)}
    </p>
  `;
}

/**
 * 適用される更新コミット全件(BT-405)を「ハッシュ＋件名」のリストに整形する。
 * 件名は折り返して全文表示し、リスト部分だけ縦スクロールにする(CSS側)。
 * @param {Array<{shortHash: string, date: string, subject: string}>} commits
 */
function formatPendingCommitsHtml(commits) {
  const items = commits.map((c) => `
    <li title="${escapeHtml(formatCommitDate(c.date))}">
      <span class="product-menu-commit-hash">${escapeHtml(c.shortHash)}</span>${escapeHtml(c.subject)}
    </li>`).join('');
  return `<ul class="product-menu-commit-list">${items}</ul>`;
}

function formatCommitDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? (iso || '') : d.toLocaleString('ja-JP');
}

/**
 * メニュー初期画面のバージョン情報行(version/コミット/更新日/サーバー起動時刻)を/api/healthで埋める (BT-410)。
 * 取得失敗時は「-」のまま残す。取得中に別画面へ切り替わっていた場合は何もしない。
 */
async function fillProductMenuInfo(content) {
  try {
    const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
    const infoEl = content.querySelector('#product-menu-info');
    if (!infoEl) return;
    const set = (key, text, title) => {
      const el = infoEl.querySelector(`[data-info="${key}"]`);
      if (!el) return;
      el.textContent = text;
      if (title) el.title = title;
    };
    if (h.apiVersion) set('version', `v${h.apiVersion}`);
    const c = h.commit;
    if (c) {
      set('commit', `${c.shortHash}${c.dirty ? '+' : ''}`, `${c.subject}${c.dirty ? '\n（未コミットの変更あり）' : ''}`);
      set('commitDate', formatCommitDate(c.date), c.subject);
    }
    if (typeof h.uptime === 'number') {
      set('startedAt', formatCommitDate(new Date(Date.now() - h.uptime * 1000).toISOString()));
    }
  } catch (e) {
    console.error('[product-menu] Failed to fetch health:', e.message);
  }
}

/**
 * メニュー初期画面の「直近の更新コミット」(BT-446)。取り込み済み(HEADまで)のコミットを新しい順に並べ、
 * 先頭にまだ取り込んでいない更新(HEAD..origin/main。/api/update-checkのキャッシュ)を強調して並べる。
 * 保存はせず、開くたびに取り直す。件数が多い時は一覧部分だけ縦スクロール(CSS側)。
 * 各行にマウスを載せると、コミット本文(description)をタスク・ガントと同じ見た目のチップで出す。
 */
async function fillProductMenuHistory(content) {
  const box = content.querySelector('#product-menu-history');
  if (!box) return;
  const title = '<div class="product-menu-rules-title">直近の更新コミット</div>';
  box.innerHTML = `${title}<div class="product-menu-rules-line">読み込み中...</div>`;
  let data = null;
  let pending = [];
  try {
    const [recentRes, updateRes] = await Promise.all([
      fetch('/api/recent-commits', { cache: 'no-store' }),
      fetch('/api/update-check', { cache: 'no-store' }).catch(() => null),
    ]);
    if (recentRes.ok) data = await recentRes.json();
    if (updateRes && updateRes.ok) pending = (await updateRes.json()).commits || [];
  } catch (e) {
    console.error('[product-menu] Failed to fetch recent commits:', e.message);
  }
  if (!box.isConnected) return; // 取得中にメニューが閉じられた/描き直された
  if (!data || data.unavailable || !data.commits.length) {
    box.innerHTML = `${title}<div class="product-menu-rules-line">コミット履歴を取得できませんでした</div>`;
    return;
  }
  const entries = [
    ...pending.map((c) => ({ ...c, pending: true })),
    ...data.commits.map((c) => ({ ...c, pending: false })),
  ];
  const items = entries.map((c, i) => `
    <li data-idx="${i}"${c.pending ? ' class="is-pending"' : ''}>
      <span class="product-menu-commit-hash">${escapeHtml(c.shortHash)}</span>${c.pending ? '<span class="product-menu-pending-badge">未取り込み</span>' : ''}${c.isHead ? '<span class="product-menu-head-badge">現在</span>' : ''}${escapeHtml(c.subject)}
    </li>`).join('');
  const note = pending.length
    ? `<div class="product-menu-rules-line rules-bad">まだ取り込んでいない更新が${pending.length}件あるよ(色付きの行)</div>`
    : '';
  box.innerHTML = `${title}${note}<ul class="product-menu-commit-list">${items}</ul>`;
  bindProductMenuCommitTip(box.querySelector('.product-menu-commit-list'), entries);
}

let productMenuTipEl = null;
let productMenuTipHideTimer = null;

/** コミット行のホバーで本文を出すチップ。ガントのチップ(.gantt-tip)と同じ見た目・位置決めを使う */
function bindProductMenuCommitTip(listEl, entries) {
  // マウスをチップへ移して本文をスクロールできるよう、消すのは少し遅らせ、チップ上にいる間は消さない(ガントと同じ)
  const scheduleHide = () => {
    clearTimeout(productMenuTipHideTimer);
    productMenuTipHideTimer = setTimeout(() => { if (productMenuTipEl) productMenuTipEl.classList.remove('gantt-tip-visible'); }, 250);
  };
  listEl.addEventListener('mouseover', (e) => {
    const li = e.target.closest('li[data-idx]');
    if (!li) { scheduleHide(); return; }
    const c = entries[Number(li.dataset.idx)];
    if (!c) return;
    clearTimeout(productMenuTipHideTimer);
    if (!productMenuTipEl) {
      productMenuTipEl = document.createElement('div');
      productMenuTipEl.className = 'gantt-tip';
      productMenuTipEl.addEventListener('mouseenter', () => clearTimeout(productMenuTipHideTimer));
      productMenuTipEl.addEventListener('mouseleave', scheduleHide);
      document.body.appendChild(productMenuTipEl);
    }
    const tip = productMenuTipEl;
    const warn = c.pending ? '<div class="gantt-tip-warn is-late">まだ取り込んでいない更新だよ(「更新を確認する」から取り込めるよ)</div>' : '';
    tip.innerHTML = `<div class="gantt-tip-head"><span class="gantt-tip-id">${escapeHtml(c.shortHash)}</span><span class="gantt-tip-title">${escapeHtml(c.subject)}</span></div>${warn}`
      + `<div class="gantt-tip-meta"><span>日時: ${escapeHtml(formatCommitDate(c.date))}</span><span>状態: ${c.pending ? '未取り込み' : '取り込み済み'}</span></div>`
      + `<div class="gantt-tip-desc">${c.body ? escapeHtml(c.body) : '<span class="gantt-tip-none">本文はありません</span>'}</div>`;
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.classList.add('gantt-tip-visible');
    const margin = 10;
    const left = Math.min(e.clientX + 6, window.innerWidth - tip.offsetWidth - margin);
    let top = e.clientY + 14;
    if (top + tip.offsetHeight > window.innerHeight - margin) top = Math.max(margin, e.clientY - tip.offsetHeight - 10);
    tip.style.left = `${Math.max(margin, left)}px`;
    tip.style.top = `${top}px`;
  });
  listEl.addEventListener('mouseleave', scheduleHide);
}

const PRODUCT_MENU_STAT_CODES = ['do', 'ready', 'todo', 'done'];

/**
 * メニュー初期画面の件数表(ワークスペース×DO/READY/TODO/DONE/TOTAL)を描画済みのboardから埋める (BT-410)。
 * 集計はバッジと同じ考え方で、親EPICは実効ステータスで1件、親に紐づく完了子の個別表示(parentIdあり)は除外する。
 * ワークスペース行は未完了件数の多い順。行が多い場合は表本体だけ縦スクロールにする(CSS側)。
 */
function fillProductMenuStats(content) {
  const statsEl = content.querySelector('#product-menu-stats');
  if (!statsEl || !lastBoardData) return;
  const byProject = {};
  for (const col of lastBoardData.columns) {
    for (const item of col.items) {
      if (item.parentId || !item.project || !PRODUCT_MENU_STAT_CODES.includes(item.statusCode)) continue;
      const row = byProject[item.project] || (byProject[item.project] = { do: 0, ready: 0, todo: 0, done: 0 });
      row[item.statusCode]++;
    }
  }
  const sum = (row) => PRODUCT_MENU_STAT_CODES.reduce((s, code) => s + row[code], 0);
  const remaining = (row) => row.do + row.ready + row.todo;
  const rows = Object.entries(byProject)
    .sort((a, b) => remaining(b[1]) - remaining(a[1]) || a[0].localeCompare(b[0]));
  const totalRow = { do: 0, ready: 0, todo: 0, done: 0 };
  for (const [, row] of rows) PRODUCT_MENU_STAT_CODES.forEach((code) => { totalRow[code] += row[code]; });
  const cells = (row) => PRODUCT_MENU_STAT_CODES.map((code) =>
    `<td class="${row[code] ? '' : 'product-menu-zero'}">${row[code] || '-'}</td>`).join('')
    + `<td class="product-menu-total-col">${sum(row)}</td>`;
  statsEl.innerHTML = `
    <div class="product-menu-stats-scroll">
      <table class="product-menu-stats-table">
        <thead>
          <tr><th class="product-menu-ws-col"></th><th>DO</th><th>READY</th><th>TODO</th><th>DONE</th><th>TOTAL</th></tr>
          <tr class="product-menu-total-row"><th class="product-menu-ws-col">WORKSPACE</th>${cells(totalRow).replace(/<td/g, '<th').replace(/<\/td>/g, '</th>')}</tr>
        </thead>
        <tbody>
          ${rows.map(([proj, row]) => `<tr><td class="product-menu-ws-col" title="${escapeHtml(proj)}">${escapeHtml(proj)}</td>${cells(row)}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * ロゴクリック時のメニュー本体を描画する(初期状態 = ブランド・バージョン情報・件数と、各機能ボタン)。
 */
function renderProductMenuDefault(content) {
  content.classList.remove('product-menu-wide');
  content.innerHTML = `
    <button class="modal-close" id="product-menu-close">&times;</button>
    <div class="product-menu-brand">
      <img src="favicon.png" alt="" class="product-menu-logo">
      <h3 class="add-form-title">Backlog Dashboard</h3>
      <button class="add-child-btn btn-add" id="product-menu-open-github"><svg class="product-menu-github-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHubを開く</button>
    </div>
    <div class="product-menu-columns">
      <div class="product-menu-col product-menu-col-left">
        <dl class="product-menu-info" id="product-menu-info">
          <dt>version</dt><dd data-info="version">-</dd>
          <dt>コミット</dt><dd data-info="commit">-</dd>
          <dt>更新日</dt><dd data-info="commitDate">-</dd>
          <dt>サーバー起動</dt><dd data-info="startedAt">-</dd>
        </dl>
        <div class="edit-form-actions product-menu-actions">
          <button class="add-child-btn btn-add" id="product-menu-check-update">更新を確認する</button>
          <button class="add-child-btn btn-add" id="product-menu-restart">サーバーを再起動する</button>
        </div>
        <div class="product-menu-rules" id="product-menu-rules"></div>
      </div>
      <div class="product-menu-col product-menu-col-right">
        <div class="product-menu-stats" id="product-menu-stats"></div>
      </div>
    </div>
    <div class="product-menu-history" id="product-menu-history"></div>
  `;
  fillProductMenuInfo(content);
  fillProductMenuStats(content);
  fillProductMenuRules(content);
  fillProductMenuHistory(content);
  content.querySelector('#product-menu-close').addEventListener('click', closeProductMenu);
  content.querySelector('#product-menu-open-github').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/repo-origin-url');
      const data = await res.json();
      if (data.repoUrl) window.open(data.repoUrl, '_blank', 'noopener');
    } catch (e) {
      console.error('[product-menu] Failed to open GitHub repo:', e.message);
    }
    closeProductMenu();
  });
  content.querySelector('#product-menu-check-update').addEventListener('click', () => {
    renderProductMenuChecking(content);
  });
  content.querySelector('#product-menu-restart').addEventListener('click', () => {
    renderProductMenuRestartConfirm(content);
  });
}

/**
 * メニュー初期画面の「エージェント運用ルール」欄 (BT-439)。開いた時に同期状況を確認して表示し、
 * 要同期の時だけ「ルールを同期する」を有効にする。確認は読み取りのみ(同期は押した時だけ)。
 * @param {string} [notice] 同期直後などに添える一言
 */
async function fillProductMenuRules(content, notice = '') {
  const box = content.querySelector('#product-menu-rules');
  if (!box) return;
  box.innerHTML = '<div class="product-menu-rules-title">エージェント運用ルール</div><div class="product-menu-rules-line">確認中...</div>';
  let data;
  try {
    const res = await fetch('/api/rules-status', { cache: 'no-store' });
    data = await res.json();
    if (!res.ok) data = { error: data.message || data.error || '確認に失敗しました' };
  } catch (e) {
    data = { error: '確認に失敗しました。サーバーに接続できません' };
  }
  if (!box.isConnected) return; // 確認中にメニューが閉じられた/描き直された
  if (data.error) {
    box.innerHTML = `<div class="product-menu-rules-title">エージェント運用ルール</div>
      <div class="product-menu-rules-line rules-bad">${escapeHtml(data.error)}</div>
      <div class="product-menu-rules-actions"><button class="add-child-btn" id="product-menu-rules-recheck">もう一度確認</button></div>`;
    box.querySelector('#product-menu-rules-recheck').addEventListener('click', () => fillProductMenuRules(content));
    return;
  }
  const chips = data.agents.map(a =>
    `<span class="rules-chip ${a.current ? 'rules-ok' : 'rules-bad'}">${escapeHtml(a.name)} ${a.current ? '最新' : '要同期'}</span>`).join('');
  const staleDist = data.distribution.filter(d => !d.current).length;
  const versionLine = data.rulesVersion
    ? `ルール v${escapeHtml(data.rulesVersion)} / サーバー v${escapeHtml(data.apiVersion)}`
    : `サーバー v${escapeHtml(data.apiVersion)}`;
  box.innerHTML = `
    <div class="product-menu-rules-title">エージェント運用ルール</div>
    <div class="product-menu-rules-chips">${chips}</div>
    <div class="product-menu-rules-line">${versionLine}</div>
    ${data.versionMismatch ? '<div class="product-menu-rules-line rules-bad">ルールとサーバーのバージョンが違います。更新後はサーバーの再起動が必要かもしれません</div>' : ''}
    ${staleDist ? `<div class="product-menu-rules-line rules-bad">リポジトリ内の配布物（${staleDist}件）が正本と違います</div>` : ''}
    ${notice ? `<div class="product-menu-rules-line rules-ok">${escapeHtml(notice)}</div>` : ''}
    <div class="product-menu-rules-actions">
      <button class="add-child-btn btn-add" id="product-menu-rules-sync"${data.needsSync ? '' : ' disabled'}>ルールを同期する</button>
    </div>`;
  box.querySelector('#product-menu-rules-sync').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '同期中...';
    try {
      const res = await fetch('/api/rules-sync', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        const msg = body.error === 'rules_sync_in_progress' ? 'すでに同期中です。しばらくお待ちください' : `同期に失敗しました: ${body.message || body.error}`;
        box.insertAdjacentHTML('beforeend', `<div class="product-menu-rules-line rules-bad">${escapeHtml(msg)}</div>`);
        btn.disabled = false;
        btn.textContent = 'ルールを同期する';
        return;
      }
      fillProductMenuRules(content, body.changed ? '同期しました' : '最新でした（変更なし）');
    } catch (err) {
      box.insertAdjacentHTML('beforeend', '<div class="product-menu-rules-line rules-bad">同期に失敗しました。サーバーに接続できません</div>');
      btn.disabled = false;
      btn.textContent = 'ルールを同期する';
    }
  });
}

/**
 * 「サーバーを再起動する」クリック後の確認ダイアログ (BT-386)。誤クリックで接続が一時的に切れるのを防ぐ。
 */
function renderProductMenuRestartConfirm(content) {
  content.classList.remove('product-menu-wide');
  content.innerHTML = `
    <button class="modal-close" id="product-menu-close">&times;</button>
    <h3 class="add-form-title">Backlog Dashboard</h3>
    <p class="delete-confirm-text">サーバーを再起動します。数十秒ほど操作できなくなります。復旧後、画面は自動で再読み込みされます。よろしいですか？</p>
    <p class="delete-confirm-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit" id="product-menu-run-restart">再起動する</button>
      <button class="add-child-btn" id="product-menu-cancel-restart">キャンセル</button>
    </div>
  `;
  content.querySelector('#product-menu-close').addEventListener('click', closeProductMenu);
  content.querySelector('#product-menu-cancel-restart').addEventListener('click', closeProductMenu);
  content.querySelector('#product-menu-run-restart').addEventListener('click', () => {
    runRestartFromProductMenu(content);
  });
}

const RESTART_WAIT_TIMEOUT_MS = 90 * 1000;
const RESTART_POLL_INTERVAL_MS = 1500;

/**
 * 再起動を依頼し、サーバーが戻るまで待ってから画面を読み込み直す (BT-386)。
 * 依頼直後はまだ旧プロセスが応答しうるため、health応答のuptimeが依頼前より小さくなった
 * (=新しいプロセスに入れ替わった)ことで復帰を判定する。
 * 再起動スクリプトの完了は待てない(サーバー自身が止まるため)ので、health復帰ポーリングで代替する。
 */
async function runRestartFromProductMenu(content) {
  const errorEl = content.querySelector('.delete-confirm-error');
  let beforeUptime = Infinity;
  try {
    const h = await (await fetch('/api/health')).json();
    if (typeof h.uptime === 'number') beforeUptime = h.uptime;
  } catch (e) {
    // health取得に失敗しても再起動依頼自体は続行する(uptime比較なしで復帰を判定する)
  }

  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errorEl.textContent = body.error === 'restart_in_progress'
        ? 'すでに再起動を依頼済みです。しばらくお待ちください'
        : '再起動の依頼に失敗しました';
      errorEl.style.display = '';
      return;
    }
  } catch (e) {
    errorEl.textContent = '再起動の依頼に失敗しました。ネットワーク接続を確認してください';
    errorEl.style.display = '';
    return;
  }

  content.innerHTML = `
    <h3 class="add-form-title">Backlog Dashboard</h3>
    <p class="delete-confirm-text" id="product-menu-restart-status">再起動中です。サーバーが復旧するまでお待ちください...</p>
  `;
  const statusEl = content.querySelector('#product-menu-restart-status');
  const deadline = Date.now() + RESTART_WAIT_TIMEOUT_MS;
  const timer = setInterval(async () => {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const h = await res.json();
      if (h.status === 'ok' && (typeof h.uptime !== 'number' || h.uptime < beforeUptime)) {
        clearInterval(timer);
        location.reload();
        return;
      }
    } catch (e) {
      // 停止〜起動の間は接続失敗になるのが想定内。待ち続ける。
    }
    if (Date.now() > deadline) {
      clearInterval(timer);
      statusEl.innerHTML = '再起動の完了を確認できませんでした。しばらくしてから画面を再読み込みしてください。復旧しない場合はサーバーのログを確認してください。';
    }
  }, RESTART_POLL_INTERVAL_MS);
}

/**
 * 「更新を確認する」クリック後、確認中の表示を出しつつPOST /api/update-check/refreshを叩く。
 */
async function renderProductMenuChecking(content) {
  content.classList.remove('product-menu-wide');
  content.innerHTML = `
    <button class="modal-close" id="product-menu-close">&times;</button>
    <h3 class="add-form-title">Backlog Dashboard</h3>
    <p class="delete-confirm-text">確認してるよ...</p>
  `;
  content.querySelector('#product-menu-close').addEventListener('click', closeProductMenu);
  try {
    const res = await fetch('/api/update-check/refresh', { method: 'POST' });
    const data = await res.json();
    renderProductMenuResult(content, data);
  } catch (e) {
    console.error('[product-menu] update-check/refresh failed:', e.message);
    content.innerHTML = `
      <button class="modal-close" id="product-menu-close">&times;</button>
      <h3 class="add-form-title">Backlog Dashboard</h3>
      <p class="delete-confirm-text">確認に失敗したよ。ネットワーク接続を確認してね</p>
      <div class="edit-form-actions">
        <button class="add-child-btn" id="product-menu-back">閉じる</button>
      </div>
    `;
    content.querySelector('#product-menu-close').addEventListener('click', closeProductMenu);
    content.querySelector('#product-menu-back').addEventListener('click', closeProductMenu);
  }
}

/**
 * 「現在 vX (hash) → 更新後 vY (hash)」の1行を組み立てる(BT-444)。
 * バージョンやハッシュが取れない側は、取れた分だけ表示する。両方空なら何も出さない。
 * @param {{current?: {version: string|null, shortHash: string|null}, latestVersion?: string|null, latestCommit?: {shortHash: string}|null}} data
 */
function formatVersionTransitionHtml(data) {
  const part = (version, hash) => {
    const items = [];
    if (version) items.push(`v${escapeHtml(version)}`);
    if (hash) items.push(`<span class="product-menu-commit-hash">${escapeHtml(hash)}</span>`);
    return items.join(' ');
  };
  const from = part(data.current && data.current.version, data.current && data.current.shortHash);
  const to = part(data.latestVersion, data.latestCommit && data.latestCommit.shortHash);
  if (!from || !to) return '';
  return `<p class="delete-confirm-text product-menu-version-transition">現在 ${from} → 更新後 ${to}</p>`;
}

/**
 * 更新確認結果を表示する。更新がある場合は最新コミット情報と「今すぐ更新する」ボタンを出す。
 * @param {{updateAvailable: boolean, aheadBy: number, latestCommit: object|null}} data
 */
function renderProductMenuResult(content, data) {
  if (!data.updateAvailable) {
    content.innerHTML = `
      <button class="modal-close" id="product-menu-close">&times;</button>
      <h3 class="add-form-title">Backlog Dashboard</h3>
      <p class="delete-confirm-text">最新版です(更新はありません)</p>
      <div class="edit-form-actions">
        <button class="add-child-btn" id="product-menu-back">閉じる</button>
      </div>
    `;
    content.querySelector('#product-menu-close').addEventListener('click', closeProductMenu);
    content.querySelector('#product-menu-back').addEventListener('click', closeProductMenu);
    updateUpdateBadge({ updateAvailable: false });
    return;
  }

  // 一覧(マージ除外)があればそれを全件表示し、件数も一覧に揃える。
  // マージコミットだけの差分などで一覧が空の場合は、従来どおり最新1件で表示する。
  const pending = Array.isArray(data.commits) ? data.commits : [];
  const hasList = pending.length > 0;
  content.classList.toggle('product-menu-wide', hasList);
  content.innerHTML = `
    <button class="modal-close" id="product-menu-close">&times;</button>
    <h3 class="add-form-title">Backlog Dashboard</h3>
    <p class="delete-confirm-text">更新があるよ(${hasList ? pending.length : data.aheadBy}件)</p>
    ${formatVersionTransitionHtml(data)}
    ${hasList ? formatPendingCommitsHtml(pending) : formatLatestCommitHtml(data.latestCommit)}
    <p class="delete-confirm-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit" id="product-menu-run-update">今すぐ更新する</button>
      <button class="add-child-btn" id="product-menu-cancel-update">キャンセル</button>
    </div>
  `;
  content.querySelector('#product-menu-close').addEventListener('click', closeProductMenu);
  content.querySelector('#product-menu-cancel-update').addEventListener('click', closeProductMenu);
  content.querySelector('#product-menu-run-update').addEventListener('click', () => {
    runUpdateFromProductMenu(content);
  });
  updateUpdateBadge(data);
}

/**
 * 「今すぐ更新する」確定後、サーバーにgit pull+ルール同期+再起動を依頼する。
 * 実際の進行表示(更新中/完了/失敗)は全画面ロック(update-running-overlay、
 * pollUpdateStatusが2秒おきに反映)に一本化するため、このダイアログ自体は
 * 「依頼を送った」ことだけ確認したら即座に閉じる。
 */
async function runUpdateFromProductMenu(content) {
  startAwaitingUpdateResult();
  try {
    await fetch('/api/run-update', { method: 'POST' });
  } catch (e) {
    // サーバー再起動により接続が切れてfetch自体が失敗するのは想定内の挙動。
    console.log('[product-menu] run-update request sent (connection may drop during restart):', e.message);
  }
  closeProductMenu();
  pollUpdateStatus();
}

/**
 * ロゴクリック時のメニューを初期状態で開く。
 */
function openProductMenu() {
  const el = getOrCreateProductMenu();
  document.body.appendChild(el);
  el.classList.add('modal-visible');
  const content = el.querySelector('.modal-content');
  renderProductMenuDefault(content);
}

// --- Update badge (BM-064): ロゴ右下の接続状態ドットの隣に、更新がある時だけバッジを出す ---
const updateBadgeEl = document.createElement('span');
updateBadgeEl.id = 'update-badge';
updateBadgeEl.className = 'update-badge';
updateBadgeEl.title = '更新があります';
updateBadgeEl.setAttribute('aria-label', '更新があります');
headerLogoEl?.parentElement?.appendChild(updateBadgeEl);

function updateUpdateBadge(state) {
  if (!updateBadgeEl) return;
  updateBadgeEl.classList.toggle('show', !!(state && state.updateAvailable));
}

async function pollUpdateCheck() {
  try {
    const res = await fetch('/api/update-check');
    const data = await res.json();
    updateUpdateBadge(data);
  } catch (e) {
    console.error('[update-badge] Failed to fetch update-check:', e.message);
  }
}
pollUpdateCheck();
setInterval(pollUpdateCheck, 5 * 60 * 1000); // 5分おき(サーバー側のキャッシュを読むだけの軽量な呼び出し)

// --- Update running lock (BM-064): 更新の実作業中(git pull〜サーバー再起動)はボードを操作不可にする ---
// state別の扱い:
//   idle/done/failed/stale -> ロック解除(通常操作可能)
//   checking -> まだ何も変更していない確認段階なのでロック対象外
//   running -> 実作業中。ロックする
// サーバー再起動でWebSocketが切れている間も、ポーリング自体は失敗し続けるだけで、
// 直前の表示(ロック中)を維持する(接続断を「ロック解除」と誤判定しない)。
const updateRunningOverlayEl = document.getElementById('update-running-overlay');
let updateRunningMessageEl = null;

function setUpdateRunningLock(locked, message) {
  if (!updateRunningOverlayEl) return;
  updateRunningOverlayEl.hidden = !locked;
  if (locked) {
    if (!updateRunningMessageEl) {
      updateRunningMessageEl = updateRunningOverlayEl.querySelector('.board-initial-loading-dialog span:last-child');
    }
    if (updateRunningMessageEl && message) updateRunningMessageEl.textContent = message;
  }
}

// BM-064: 更新の完了/失敗を伝えるトースト通知。
// ブランチ不一致・ローカル変更での即中止(checking→failed)はミリ秒単位で終わり、
// 2秒おきのポーリングでは"running"状態を一度も観測できないことがある(その場合、
// 「前回の結果」と「今回の結果」を見分ける手段がrunning経由の遷移検知だけでは
// 無い)。そのため「ボタンを押した時刻」を基準にし、updatedAtがそれより新しい
// done/failedだけを「今回の結果」として扱う(古いステータスファイルの読み直しを
// 誤って今回の結果として表示しないようにするため)。
const updateResultToastEl = document.getElementById('update-result-toast');
const updateResultToastTextEl = document.getElementById('update-result-toast-text');
const updateResultToastCloseEl = document.getElementById('update-result-toast-close');
let updateResultToastHideTimer = null;
let awaitingUpdateResultSince = null; // ボタンを押した時刻(ms)。待機中はnull以外。
const AWAITING_UPDATE_RESULT_TIMEOUT_MS = 3 * 60 * 1000; // サーバー側のstale判定と同じ3分

function hideUpdateResultToast() {
  if (!updateResultToastEl) return;
  updateResultToastEl.classList.remove('show');
  if (updateResultToastHideTimer) {
    clearTimeout(updateResultToastHideTimer);
    updateResultToastHideTimer = null;
  }
}

/**
 * @param {'done'|'failed'} state
 * @param {string} message
 */
function showUpdateResultToast(state, message) {
  if (!updateResultToastEl || !updateResultToastTextEl) return;
  updateResultToastEl.hidden = false;
  updateResultToastEl.className = `update-result-toast show ${state === 'done' ? 'success' : 'error'}`;
  updateResultToastTextEl.textContent = state === 'done'
    ? (message || '更新が完了しました')
    : `更新に失敗しました: ${message || '原因不明のエラーです'}`;
  if (updateResultToastHideTimer) clearTimeout(updateResultToastHideTimer);
  // 成功時は自動で消える。失敗時は原因を読めるよう、閉じるボタンで明示的に閉じるまで残す。
  if (state === 'done') {
    updateResultToastHideTimer = setTimeout(hideUpdateResultToast, 6000);
  }
}
updateResultToastCloseEl?.addEventListener('click', hideUpdateResultToast);

/**
 * 「今すぐ更新する」実行時に呼ぶ。以後のポーリングで結果が出たらトーストで知らせる。
 */
function startAwaitingUpdateResult() {
  awaitingUpdateResultSince = Date.now();
  // BT-407: サーバーのstate=runningを待たず、押した瞬間から進行表示を出す(二重押し防止も兼ねる)
  setUpdateRunningLock(true, UPDATE_STEP_MESSAGES.start);
}

// BT-407: update-and-sync.ps1が書き出す工程メッセージを、ユーザー向けの説明に言い換える。
const UPDATE_STEP_MESSAGES = {
  start: '更新を開始しています。最新の資材をダウンロードする準備中です...',
  checking: '更新の前提条件を確認しています...',
  pull: '最新の資材をダウンロードしています(git pull)...',
  sync: 'エージェント運用ルールを同期しています...',
  restart: 'サーバーを再起動しています。数十秒ほどお待ちください...',
  finished: '更新が完了しました。画面を再読み込みします...',
};

function describeUpdateStep(data) {
  const msg = data.message || '';
  if (data.state === 'checking') return UPDATE_STEP_MESSAGES.checking;
  if (msg.includes('git pull')) return UPDATE_STEP_MESSAGES.pull;
  if (msg.includes('ルール同期')) return UPDATE_STEP_MESSAGES.sync;
  if (msg.includes('再起動')) return UPDATE_STEP_MESSAGES.restart;
  return msg || '更新を適用しています。しばらくお待ちください...';
}

/**
 * BT-407: 更新完了後の後処理。更新チェックを再実行してバッジを最新化し、新しい資材を反映するため画面を再読み込みする。
 */
let updateReloading = false; // 完了後のリロード待ち。この間はポーリングでロックを解除しない
async function finishUpdateAndReload() {
  updateReloading = true;
  setUpdateRunningLock(true, UPDATE_STEP_MESSAGES.finished);
  try {
    const res = await fetch('/api/update-check/refresh', { method: 'POST' });
    updateUpdateBadge(await res.json());
  } catch (e) {
    console.error('[update] post-update update-check failed:', e.message);
  }
  // 完了メッセージを一瞬読めるよう少し待ってからリロードする
  setTimeout(() => location.reload(), 1200);
}

async function pollUpdateStatus() {
  try {
    const res = await fetch('/api/update-status');
    const data = await res.json();
    if (updateReloading) return;

    if (awaitingUpdateResultSince !== null) {
      const updatedAtMs = Date.parse(data.updatedAt);
      // 時計のズレを考慮して1秒の許容を持たせる。ボタン押下より前のタイムスタンプは
      // 「前回までの古い結果」なので無視し、待ち続ける。
      const isFresh = Number.isFinite(updatedAtMs) && updatedAtMs >= awaitingUpdateResultSince - 1000;
      if (isFresh && data.state === 'done') {
        awaitingUpdateResultSince = null;
        showUpdateResultToast('done', data.message);
        finishUpdateAndReload();
      } else if (isFresh && data.state === 'failed') {
        awaitingUpdateResultSince = null;
        setUpdateRunningLock(false);
        showUpdateResultToast('failed', data.message);
      } else if (Date.now() - awaitingUpdateResultSince > AWAITING_UPDATE_RESULT_TIMEOUT_MS) {
        // 3分待っても結果が確認できない場合は諦めてロックを解除する(サーバー側のstale判定と揃える)。
        awaitingUpdateResultSince = null;
        setUpdateRunningLock(false);
      } else if (isFresh && (data.state === 'running' || data.state === 'checking')) {
        setUpdateRunningLock(true, describeUpdateStep(data));
      }
      // 結果待ちの間は、古い状態ファイルの内容でロックを解除しない
      return;
    }

    setUpdateRunningLock(data.state === 'running', describeUpdateStep(data));
  } catch (e) {
    // サーバー再起動中は接続断でここに来る。直前の表示(ロック中ならロックのまま)を維持するため何もしない。
    // awaitingUpdateResultSinceはそのまま保持し、再接続後に新しい結果を検知する。
  }
}
pollUpdateStatus();
setInterval(pollUpdateStatus, 2000); // 2秒おき。ロック解除を事故なく素早く反映したいための短い間隔

// --- Board Lane Workspace Launch Menu (BM-096) ---
// レーンヘッダーの「開く」ボタンをクリックした時、KIRO/CODEのどちらで開くか選ぶ小さいメニューを
// そのボタンの直下に出す。badge-mode-menuと同じ「クリックでトグル、外側クリック/Escで閉じる」
// パターンだが、ボタンがレーン数分動的に生成されるため、固定DOM1個の使い回しではなく
// クリックされたボタンの近くに都度生成する。
let boardLaneMenuEl = null;
function closeBoardLaneWorkspaceMenu() {
  if (boardLaneMenuEl) {
    boardLaneMenuEl.remove();
    boardLaneMenuEl = null;
  }
}
function openBoardLaneWorkspaceMenu(btnEl, project) {
  if (boardLaneMenuEl) { closeBoardLaneWorkspaceMenu(); return; }
  const menu = document.createElement('div');
  menu.className = 'board-lane-launch-menu';
  menu.innerHTML = `
    <button type="button" class="board-lane-launch-menu-item" data-editor="kiro">KIROで開く</button>
    <button type="button" class="board-lane-launch-menu-item" data-editor="code">CODEで開く</button>
  `;
  menu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = e.target.closest('.board-lane-launch-menu-item');
    if (!item) return;
    closeBoardLaneWorkspaceMenu();
    await launchBoardLaneWorkspace(btnEl, project, item.dataset.editor);
  });
  btnEl.appendChild(menu);
  boardLaneMenuEl = menu;
}
document.addEventListener('click', (e) => {
  if (boardLaneMenuEl && !e.target.closest('.board-lane-launch-btn')) closeBoardLaneWorkspaceMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && boardLaneMenuEl) closeBoardLaneWorkspaceMenu();
});

async function launchBoardLaneWorkspace(btnEl, project, editor) {
  btnEl.disabled = true;
  btnEl.classList.add('is-launching');
  try {
    const resp = await fetch('/api/open-workspace-by-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, editor }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert(`ワークスペースを開けなかったよ: ${data.error || ''}`);
    }
  } catch (e) {
    console.error('[board-lane-launch] Network error:', e);
    alert('ネットワークエラーが発生したよ');
  } finally {
    btnEl.disabled = false;
    btnEl.classList.remove('is-launching');
  }
}

// --- Project Filter ---
// メインボードの絞り込みを切り替える（ドロップダウン操作と、設定パネルでの保存の両方から使う）
function applyMainFilter(project) {
  currentFilter = project;
  if (wsFilterMainDropdown) wsFilterMainDropdown.render();
  if (wsFilterPlanDropdown) wsFilterPlanDropdown.render();
  applySettings();
  setSessionFilter(currentFilter); // ユーザー操作を記憶
  if (currentBoardData) renderBoard(currentBoardData);
  refreshPlanBoardIfOpen(); // BM-036: Plan Board(週次計画/ガント)が開いていれば絞り込み結果を反映する
  if (typeof tickerShowsHeatmap === 'function' && tickerShowsHeatmap()) scheduleHeaderHeatmapRender(); // BT-382: ヘッダのヒートマップもワークスペースに連動
}

// --- Board Lane Mode (BM-049) ---
// All Projects選択時だけ意味を持つ、かんばんの表示モード切替。
// 'lane' = ワークスペース別レーン表示(デフォルト) / 'flat' = 従来の横断した一枚のボード。
if (boardLaneModeBtnEl) {
  boardLaneModeBtnEl.addEventListener('click', () => {
    boardLaneMode = boardLaneMode === 'lane' ? 'flat' : 'lane';
    localStorage.setItem('boardLaneMode', boardLaneMode);
    if (currentBoardData) renderBoard(currentBoardData);
  });
}

// All Projects選択時のみボタンを表示し、現在のモードをラベル・aria状態に反映する。
function updateBoardLaneModeBtn() {
  if (!boardLaneModeBtnEl) return;
  const show = !currentFilter;
  boardLaneModeBtnEl.hidden = !show;
  if (!show) return;
  const isLane = boardLaneMode === 'lane';
  boardLaneModeBtnEl.textContent = isLane ? 'ワークスペース別' : '横断ボード';
  boardLaneModeBtnEl.title = isLane
    ? 'ワークスペースごとにレーン分けして表示中（クリックで横断した一枚のボードに切替）'
    : '全ワークスペースを横断した一枚のボードを表示中（クリックでワークスペース別レーン表示に切替）';
  boardLaneModeBtnEl.setAttribute('aria-pressed', String(isLane));
}

// レーンの並び順を決める: レーン内タスクのupdatedAt最大値が新しい順(直近更新のあるワークスペースが上)。
// タスクが1件も無いワークスペースはレーンを出さない。
function computeBoardLaneOrder(data) {
  const latestByProject = new Map();
  for (const col of data.columns) {
    for (const item of col.items) {
      if (!item.project) continue;
      const ts = item.updatedAt || '';
      const prev = latestByProject.get(item.project);
      if (!prev || ts > prev) latestByProject.set(item.project, ts);
    }
  }
  return [...latestByProject.keys()].sort((a, b) => {
    const tsCmp = (latestByProject.get(b) || '').localeCompare(latestByProject.get(a) || '');
    if (tsCmp !== 0) return tsCmp;
    return a.localeCompare(b, 'ja', { sensitivity: 'base' });
  });
}

// BM-029: ワークスペース絞り込みドロップダウン（列固定表示: 名前 + DO/READY/TODO件数）。
// ネイティブ<select>のoption内はCSSで列固定できないため、トリガーボタン+ポップアップの
// カスタムドロップダウンに置き換える（badge-mode-menuと同じ構造パターン）。
// ヘッダーと週次計画(Plan Board)の両方で使うため、要素一式を受け取るファクトリにしてある。
function createWsFilterDropdown({ wrapEl, triggerEl, triggerLabelEl, menuEl, includeCreateAction, onSelect }) {
  let open = false;
  let focusIndex = -1;

  function rowsData() {
    const rows = [{ value: '', label: 'All Projects', counts: null, isAction: false }];
    for (const p of wsFilterProjects) {
      rows.push({ value: p, label: p, counts: wsFilterCounts[p] || null, isAction: false });
    }
    if (includeCreateAction) {
      rows.push({ value: NEW_WORKSPACE_VALUE, label: '＋ 新規ワークスペース…', counts: null, isAction: true });
    }
    return rows;
  }

  // BM-029: 名前列を省略せずフル表示しつつ、全行で数字列の縦位置を揃えるため<table>で組む。
  // (CSS Gridで行ごとにgrid-template-columns:autoにすると、行ごとに名前幅が決まってしまい
  //  数字列がずれる。tableはネイティブに列幅を全行の最大コンテンツ幅へ揃えてくれる。)
  function render() {
    const rows = rowsData();
    const selectedIdx = rows.findIndex(r => r.value === currentFilter);
    const selected = rows[selectedIdx] || rows[0];
    triggerLabelEl.textContent = selected.label;
    const headerHtml = `<tr class="ws-filter-col-header" role="presentation">
      <th class="ws-filter-row-name"></th>
      <th class="ws-filter-col-label">DO</th>
      <th class="ws-filter-col-label">READY</th>
      <th class="ws-filter-col-label">TODO</th>
      <th class="ws-filter-col-label">DONE</th>
    </tr>`;
    const rowsHtml = rows.map((r, i) => {
      const isSelected = r.value === currentFilter;
      const cls = ['ws-filter-row', isSelected ? 'is-selected' : '', r.isAction ? 'ws-filter-row-action' : ''].filter(Boolean).join(' ');
      const c = r.counts || {};
      const countsHtml = r.isAction ? '<td colspan="4"></td>' : `<td class="ws-filter-row-count">${c.do || ''}</td><td class="ws-filter-row-count">${c.ready || ''}</td><td class="ws-filter-row-count">${c.todo || ''}</td><td class="ws-filter-row-count">${c.done || ''}</td>`;
      return `<tr class="${cls}" role="option" aria-selected="${isSelected}" data-index="${i}" tabindex="-1">
        <td class="ws-filter-row-name">${escapeHtml(r.label)}</td>${countsHtml}
      </tr>`;
    }).join('');
    menuEl.innerHTML = `<table class="ws-filter-table"><tbody>${headerHtml}${rowsHtml}</tbody></table>`;
  }

  function highlightFocus() {
    const items = menuEl.querySelectorAll('.ws-filter-row');
    items.forEach((el, i) => el.classList.toggle('is-focused', i === focusIndex));
    const focusedEl = items[focusIndex];
    if (focusedEl) focusedEl.scrollIntoView({ block: 'nearest' });
  }

  function openMenu() {
    if (open) return;
    render();
    menuEl.hidden = false;
    open = true;
    wsFilterMenuOpen = true;
    triggerEl.setAttribute('aria-expanded', 'true');
    const rows = rowsData();
    focusIndex = Math.max(0, rows.findIndex(r => r.value === currentFilter));
    highlightFocus();
    menuEl.focus();
  }

  function closeMenu() {
    if (!open) return;
    menuEl.hidden = true;
    open = false;
    wsFilterMenuOpen = false;
    triggerEl.setAttribute('aria-expanded', 'false');
    focusIndex = -1;
  }

  function selectIndex(i) {
    const rows = rowsData();
    const row = rows[i];
    closeMenu();
    triggerEl.focus();
    if (!row) return;
    onSelect(row.value);
  }

  triggerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) closeMenu(); else openMenu();
  });

  triggerEl.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      openMenu();
    }
  });

  menuEl.addEventListener('click', (e) => {
    const rowEl = e.target.closest('.ws-filter-row');
    if (!rowEl) return;
    selectIndex(Number(rowEl.dataset.index));
  });

  menuEl.addEventListener('keydown', (e) => {
    const rows = rowsData();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusIndex = Math.min(rows.length - 1, focusIndex + 1);
      highlightFocus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusIndex = Math.max(0, focusIndex - 1);
      highlightFocus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectIndex(focusIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      triggerEl.focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[a-zA-Z]$/.test(e.key)) {
      // BM-035: 先頭文字キーでの頭文字ジャンプ（typeahead）。
      // 現在位置の次から探すだけで、初回ジャンプも同一文字の連打巡回も同じロジックで成立する
      // （ネイティブ<select>のtypeaheadと同じ考え方）。末尾まで探して無ければ先頭へ巡回する。
      e.preventDefault();
      const char = e.key.toLowerCase();
      const start = rows.length ? (focusIndex + 1) % rows.length : 0;
      for (let i = 0; i < rows.length; i++) {
        const idx = (start + i) % rows.length;
        if ((rows[idx].label || '').toLowerCase().startsWith(char)) {
          focusIndex = idx;
          highlightFocus();
          break;
        }
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (open && !wrapEl.contains(e.target)) closeMenu();
  });

  return { render, close: closeMenu, isOpen: () => open };
}

const wsFilterMainDropdown = createWsFilterDropdown({
  wrapEl: wsFilterWrapEl,
  triggerEl: wsFilterTriggerEl,
  triggerLabelEl: wsFilterTriggerLabelEl,
  menuEl: wsFilterMenuEl,
  includeCreateAction: true,
  onSelect: (value) => {
    if (value === NEW_WORKSPACE_VALUE) {
      openSettingsPanel(NEW_WORKSPACE_VALUE);
      return;
    }
    applyMainFilter(value);
  },
});
// Plan Board側のドロップダウンは getOrCreatePlanBoardModal() で初回オープン時に生成する
let wsFilterPlanDropdown = null;

// ワークスペースバッジクリック → フィルタ連携（トグル対応）
const projectBadgesEl = document.getElementById('project-badges');
if (projectBadgesEl) {
  projectBadgesEl.addEventListener('click', (e) => {
    const badge = e.target.closest('.proj-badge');
    if (!badge) return;
    const proj = badge.dataset.project;
    applyMainFilter(currentFilter === proj ? '' : proj); // 同じバッジ再クリックで解除
  });
}

// --- BT-341: ワークスペースバッジの集計対象メニュー ---
const badgeModeBtn = document.getElementById('badge-mode-btn');
const badgeModeMenu = document.getElementById('badge-mode-menu');
function renderBadgeModeMenu() {
  badgeModeMenu.innerHTML = Object.entries(BADGE_MODES).map(([key, m]) =>
    `<button type="button" class="badge-mode-item${key === badgeMode ? ' active' : ''}" role="menuitemradio" aria-checked="${key === badgeMode}" data-mode="${key}">${m.label}</button>`
  ).join('');
}
function closeBadgeModeMenu() {
  badgeModeMenu.hidden = true;
  badgeModeBtn.setAttribute('aria-expanded', 'false');
}
if (badgeModeBtn && badgeModeMenu) {
  badgeModeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!badgeModeMenu.hidden) { closeBadgeModeMenu(); return; }
    renderBadgeModeMenu();
    badgeModeMenu.hidden = false;
    badgeModeBtn.setAttribute('aria-expanded', 'true');
  });
  badgeModeMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.badge-mode-item');
    if (!item) return;
    badgeMode = item.dataset.mode;
    try { localStorage.setItem(BADGE_MODE_KEY, badgeMode); } catch (_) {}
    closeBadgeModeMenu();
    if (currentBoardData) renderBoard(currentBoardData);
  });
  document.addEventListener('click', (e) => {
    if (!badgeModeMenu.hidden && !e.target.closest('.badge-mode-wrap')) closeBadgeModeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !badgeModeMenu.hidden) closeBadgeModeMenu();
  });
}

// --- Search Modal ---
searchBtn.addEventListener('click', () => openSearchModal(headerSearchInput.value));
headerSearchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  openSearchModal(headerSearchInput.value);
});
planBtn.addEventListener('click', openPlanBoard);

// ショートカット: "/" または Ctrl+K（Mac: Cmd+K）で検索ダイアログを開く
document.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const isTyping = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  if (e.key === '/' && !isTyping) {
    e.preventDefault();
    headerSearchInput.focus();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    headerSearchInput.focus();
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

// --- Header Ticker (BM-020) ---
// ロゴ〜機能ボタン間の空きスペースに、直近の操作ログをコンソール風に縦積みで流す。
// データはWebSocketのboard broadcastに相乗りしたdata.recentEvents(server.js buildBoard())。
// トグルOFF中はrenderHeaderTicker自体を呼ばない設計(app.js側のWSハンドラでも
// 条件分岐はせず常に呼ぶが、関数先頭でtickerModeを見て即returnし、DOM更新コストをゼロにする)。
// BT-382: 表示モードは 'log'(ログ常時) / 'heatmap'(既定。通常はヒートマップ、タスク変動があるとログへ一時切替) / 'off'。
// 旧キーtickerActive='false'のユーザーはoffとして引き継ぐ。
const TICKER_MODES = ['log', 'heatmap', 'off'];
const TICKER_LOG_HOLD_MS = 15000; // 変動後、この時間イベントがなければヒートマップへ戻る
let tickerMode = (() => {
  const saved = localStorage.getItem('tickerMode');
  if (TICKER_MODES.includes(saved)) return saved;
  return localStorage.getItem('tickerActive') === 'false' ? 'off' : 'heatmap';
})();
let tickerLogHoldTimer = null; // ヒートマップ設定中にログへ一時切替している間だけ非null
let headerTickerLastMaxId = -1; // 直前の描画で先頭だった最大id。これより大きいidだけ新規フェードインさせる
const headerTickerEl = document.getElementById('header-ticker');
const headerTickerListEl = document.getElementById('header-ticker-list');
const headerHeatmapEl = document.getElementById('header-heatmap');
const tickerToggleBtn = document.getElementById('ticker-toggle-btn');
const tickerToggleIconEl = document.getElementById('ticker-toggle-icon');

function tickerShowsHeatmap() {
  return tickerMode === 'heatmap' && !tickerLogHoldTimer;
}

function applyTickerVisibility() {
  const showHeatmap = tickerShowsHeatmap();
  const showLog = tickerMode === 'log' || (tickerMode === 'heatmap' && !!tickerLogHoldTimer);
  if (headerTickerEl) headerTickerEl.classList.toggle('ticker-hidden', !showLog);
  if (headerHeatmapEl) headerHeatmapEl.classList.toggle('ticker-hidden', !showHeatmap);
  if (tickerToggleBtn) tickerToggleBtn.classList.toggle('filter-active', tickerMode !== 'off');
  if (tickerToggleIconEl) {
    tickerToggleIconEl.classList.toggle('icon-terminal', tickerMode !== 'heatmap');
    tickerToggleIconEl.classList.toggle('icon-calendar-month', tickerMode === 'heatmap');
  }
  if (showHeatmap) {
    maybePlayHeaderHeatmapIntro(); // ページ読み込みで最初に表示される時だけ、ここでウェルカムメッセージを起動する
    requestHeaderHeatmap(); // データ取得は常に進める(描画自体はintro再生中はrenderHeaderHeatmap側でガードされる)
  }
}

if (tickerToggleBtn) {
  tickerToggleBtn.addEventListener('click', () => {
    // ログ → ヒートマップ → OFF → ログ…の循環
    clearTimeout(tickerLogHoldTimer);
    tickerLogHoldTimer = null;
    tickerMode = TICKER_MODES[(TICKER_MODES.indexOf(tickerMode) + 1) % TICKER_MODES.length];
    localStorage.setItem('tickerMode', tickerMode);
    applyTickerVisibility();
    // OFFからの復帰時、直近データがキャッシュ済みなら即座にログへ反映する
    if (tickerMode !== 'off' && currentBoardData) renderHeaderTicker(currentBoardData.recentEvents);
  });
}

// --- ミニヒートマップ(BT-382) ---
// 表示対象はワークスペースセレクタ(currentFilter)に連動し、未選択時は全体を合算する。
// ボード操作を妨げないための構成: /api/activityの取得・パース・日別集計はWeb Worker、
// メインスレッドは集計済みの小さな日別件数からSVGを組み立てるだけ(アイドル時に実行)。
// データ更新はイベント受信ごとではなく「ヒートマップを表示する時にdirtyなら再取得」とし、
// ログ表示中は一切読み込まない。
const HEATMAP_CELL = 6, HEATMAP_GAP = 2, HEATMAP_STEP = HEATMAP_CELL + HEATMAP_GAP;
const HEATMAP_MONTH_GAP = 4; // 月の境目で広げる隙間(px)
const HEATMAP_OPACITY = [0.05, 0.3, 0.5, 0.75, 1]; // BT-443: 貢献なし(0)を薄くして、貢献の少ない日(1)が浮き出るようにする
let headerHeatmapWorker = null;
let headerHeatmapByProject = null; // 最後に受信した「プロジェクト→日別件数」。nullは未取得
let headerHeatmapDirty = true;
let headerHeatmapLoading = false;
let headerHeatmapSeq = 0;
let headerHeatmapRenderQueued = false;

function requestHeaderHeatmap() {
  if (typeof headerHeatmap === 'undefined' || typeof Worker === 'undefined') return;
  if (headerHeatmapByProject) scheduleHeaderHeatmapRender(); // 手元のデータで即描画し、更新が必要なら裏で取り直す
  if (!headerHeatmapDirty || headerHeatmapLoading) return;
  try {
    if (!headerHeatmapWorker) {
      headerHeatmapWorker = new Worker('header-heatmap-worker.js');
      headerHeatmapWorker.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.seq !== headerHeatmapSeq) return;
        headerHeatmapLoading = false;
        if (msg.type === 'counts') {
          headerHeatmapByProject = msg.byProject;
          headerHeatmapDirty = false;
          scheduleHeaderHeatmapRender();
        }
      };
      headerHeatmapWorker.onerror = () => { headerHeatmapLoading = false; };
    }
    headerHeatmapLoading = true;
    headerHeatmapSeq++;
    headerHeatmapWorker.postMessage({ type: 'load', seq: headerHeatmapSeq });
  } catch (e) {
    headerHeatmapLoading = false;
    console.error('[app] heatmap worker failed:', e);
  }
}

function scheduleHeaderHeatmapRender() {
  if (headerHeatmapRenderQueued) return;
  headerHeatmapRenderQueued = true;
  const run = () => { headerHeatmapRenderQueued = false; renderHeaderHeatmap(); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 });
  else setTimeout(run, 0);
}

// BM-091: ヘッダーミニヒートマップの起動時ウェルカムメッセージ(電光掲示板風)。
// header-heatmap本体と同じ考え方でWeb Workerに計算を切り出し、メインスレッドは
// Workerから届いた点灯セル一覧をSVGとして組み立てるだけにする(本体のボード操作に影響させない)。
// 文言・速度・点灯色の濃淡レベルは、見る人全員が同じものを見るアプリ共通設定として
// サーバー(config.json)に保存する(BM-092)。ページ読み込み時にGET /api/header-heatmap-intro-settings
// で取得し、取得できるまで/失敗した場合はこのデフォルト値で再生する。
const HEADER_HEATMAP_INTRO_DEFAULTS = { text: 'BACKLOG DASHBOARD by HIDEP-HUB', frameMs: 90, litLevel: 3 };
let headerHeatmapIntroSettings = { ...HEADER_HEATMAP_INTRO_DEFAULTS };
let headerHeatmapIntroWorker = null;
let headerHeatmapIntroSeq = 0;
let headerHeatmapIntroCells = null; // 再生中: 現フレームの点灯セル配列。null/非再生中は通常のヒートマップを描く
let headerHeatmapIntroWeeks = 0; // 再生開始時に確定した週数(列数)。再生中はリサイズが起きても描画崩れを避けるためこの値を使う
let headerHeatmapIntroPlayed = false; // このページ表示で既に起動済みか(1ページ表示につき1回だけ再生する)

async function loadHeaderHeatmapIntroSettings() {
  try {
    const res = await fetch('/api/header-heatmap-intro-settings');
    if (!res.ok) return;
    const data = await res.json();
    headerHeatmapIntroSettings = { ...HEADER_HEATMAP_INTRO_DEFAULTS, ...data };
  } catch (e) {
    console.error('[app] failed to load header heatmap intro settings:', e);
  }
}

function headerHeatmapIntroEnabled() {
  if (typeof Worker === 'undefined' || typeof headerHeatmapFont === 'undefined') return false;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

function headerHeatmapCurrentWeeks() {
  const wrap = headerHeatmapEl ? headerHeatmapEl.parentElement : null;
  const avail = (wrap ? wrap.clientWidth : 0) - 44; // 左のトグルボタン分+右padding
  return Math.max(8, Math.min(53, Math.floor(avail / HEATMAP_STEP)));
}

// ページ表示中にヒートマップが初めて表示状態になったタイミングで1回だけ呼ぶ。
// tickerModeがheatmap以外に切り替わってから戻ってきても、2回目以降は再生しない。
// サーバーの設定(文言・速度・濃淡レベル)を使うため、再生前に必ず最新値を取得する
// (ログ/offモードのまま一度も表示されないページ表示では、このfetch自体が発生しない)。
async function maybePlayHeaderHeatmapIntro() {
  if (headerHeatmapIntroPlayed) return;
  headerHeatmapIntroPlayed = true;
  if (!headerHeatmapIntroEnabled()) return;
  await loadHeaderHeatmapIntroSettings();
  const weeks = headerHeatmapCurrentWeeks();
  if (weeks <= 0) return;
  headerHeatmapIntroWeeks = weeks;
  try {
    if (!headerHeatmapIntroWorker) {
      headerHeatmapIntroWorker = new Worker('header-heatmap-intro-worker.js');
      headerHeatmapIntroWorker.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.seq !== headerHeatmapIntroSeq) return;
        if (msg.type === 'frame') {
          headerHeatmapIntroCells = msg.cells;
          renderHeaderHeatmap();
        } else if (msg.type === 'done') {
          headerHeatmapIntroCells = null;
          headerHeatmapIntroRectEls = null;
          headerHeatmapIntroRectWeeks = -1;
          renderHeaderHeatmap(); // 通常のヒートマップへハンドオフ
        }
      };
      headerHeatmapIntroWorker.onerror = () => { headerHeatmapIntroCells = null; };
    }
    headerHeatmapIntroSeq++;
    headerHeatmapIntroWorker.postMessage({
      type: 'start',
      seq: headerHeatmapIntroSeq,
      text: headerHeatmapIntroSettings.text,
      weeks,
      intervalMs: headerHeatmapIntroSettings.frameMs,
    });
  } catch (e) {
    headerHeatmapIntroCells = null;
    console.error('[app] heatmap intro worker failed:', e);
  }
}

// ヒートマップの列ごとのx座標(月の境目で隙間を広げる)を計算する。本体表示とイントロ再生の
// 両方で使い、右端(今日の列/最新フレームの列)の位置を完全に一致させる(BM-092レビューで
// 「イントロの文字出現位置が本体ヒートマップの右端とズレている」との指摘を受けて共通化した)。
function computeHeatmapColumnLayout(weeks, cells) {
  const boundaries = new Set(headerHeatmap.buildMonthBoundaries(cells));
  const colX = [];
  let x = 0;
  for (let col = 0; col < weeks; col++) {
    if (boundaries.has(col)) x += HEATMAP_MONTH_GAP;
    colX.push(x);
    x += HEATMAP_STEP;
  }
  return { colX, width: x - HEATMAP_GAP, boundaries };
}

// BM-092レビュー対応: イントロ再生中にクリックが効かない/ダブルクリックでしか反応しない報告への対応。
// 原因は、フレームごとにheaderHeatmapEl.innerHTMLでDOM要素を丸ごと作り直していたこと。
// mousedown〜mouseupの間にクリック対象の要素がDOMから消えて作り直されると、ブラウザが
// クリックを成立させない(クリックの判定は押した要素と離した要素が同一であることが前提)。
// 対策: SVGの<rect>要素は再生開始時に1回だけ作り、以降のフレームでは既存要素の
// fill-opacity属性だけを書き換える(DOM要素自体は再生中ずっと同一のまま保つ)。
let headerHeatmapIntroRectEls = null; // 再生中のrect要素配列(DOM参照、フレームごとにopacityだけ更新)
let headerHeatmapIntroRectWeeks = -1; // headerHeatmapIntroRectEls構築時のweeks(変化したら再構築)

function renderHeaderHeatmapIntroFrame(weeks) {
  if (!headerHeatmapIntroRectEls || headerHeatmapIntroRectWeeks !== weeks) {
    // イントロの列は実際の活動件数と無関係(文字スクロール用の抽象列)だが、月の境目の位置だけは
    // 本体と同じ日付レンジ({}=件数ダミーで取得)で揃えることで、右端(最新列)が本体表示と一致する。
    const { cells } = headerHeatmap.buildHeatmapGrid({}, weeks);
    const { colX, width } = computeHeatmapColumnLayout(weeks, cells);
    const height = 7 * HEATMAP_STEP - HEATMAP_GAP;
    const rects = headerHeatmapIntroCells.map(c =>
      `<rect x="${colX[c.col]}" y="${c.row * HEATMAP_STEP}" width="${HEATMAP_CELL}" height="${HEATMAP_CELL}" rx="1.5" fill="var(--brand-fg)" fill-opacity="0"/>`
    ).join('');
    headerHeatmapEl.innerHTML = `<svg class="header-heatmap-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${rects}</svg>`;
    headerHeatmapIntroRectEls = Array.from(headerHeatmapEl.querySelectorAll('rect'));
    headerHeatmapIntroRectWeeks = weeks;
  }
  headerHeatmapIntroCells.forEach((c, i) => {
    const opacity = c.on ? HEATMAP_OPACITY[headerHeatmapIntroSettings.litLevel] : HEATMAP_OPACITY[0];
    headerHeatmapIntroRectEls[i].setAttribute('fill-opacity', opacity);
  });
}

function renderHeaderHeatmap() {
  if (!headerHeatmapEl || !tickerShowsHeatmap()) return;
  if (headerHeatmapIntroCells) {
    renderHeaderHeatmapIntroFrame(headerHeatmapIntroWeeks);
    return;
  }
  if (!headerHeatmapByProject) return;
  const wrap = headerHeatmapEl.parentElement;
  const avail = (wrap ? wrap.clientWidth : 0) - 44; // 左のトグルボタン分+右padding
  const weeks = Math.max(8, Math.min(53, Math.floor(avail / HEATMAP_STEP)));
  const { cells } = headerHeatmap.buildHeatmapGrid(headerHeatmap.selectCounts(headerHeatmapByProject, currentFilter), weeks);
  // 月の境目の列は隙間を広げ、その中央に細い区切り線を引く(何月かは各セルのツールチップで確認できる)
  const { colX, width, boundaries } = computeHeatmapColumnLayout(weeks, cells);
  const height = 7 * HEATMAP_STEP - HEATMAP_GAP;
  const dow = ['月', '火', '水', '木', '金', '土', '日'];
  const lines = [...boundaries].map(col => {
    const lx = colX[col] - (HEATMAP_GAP + HEATMAP_MONTH_GAP) / 2;
    return `<line x1="${lx}" y1="0" x2="${lx}" y2="${height}" class="header-heatmap-month-line"/>`;
  }).join('');
  // 月の数字は奇数月だけ(隣り合う月が詰まって9と10などが読みにくくなるのを避ける)。短すぎる区間は出さない
  const monthTexts = headerHeatmap.buildMonthSegments(cells)
    .filter(seg => seg.month % 2 === 1 && seg.endCol - seg.startCol + 1 >= 3)
    .map(seg => {
      const cx = (colX[seg.startCol] + colX[seg.endCol] + HEATMAP_CELL) / 2;
      return `<text x="${cx}" y="${height / 2}" text-anchor="middle" dominant-baseline="central" class="header-heatmap-month">${seg.month}</text>`;
    }).join('');
  const rects = cells.map(c => {
    const title = `${c.date}（${dow[c.row]}） ${c.count}件`;
    return `<rect x="${colX[c.col]}" y="${c.row * HEATMAP_STEP}" width="${HEATMAP_CELL}" height="${HEATMAP_CELL}" rx="1.5" fill="var(--brand-fg)" fill-opacity="${HEATMAP_OPACITY[c.level]}"><title>${title}</title></rect>`;
  }).join('');
  headerHeatmapEl.innerHTML = `<svg class="header-heatmap-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${monthTexts}${lines}${rects}</svg>`;
}

let headerHeatmapResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(headerHeatmapResizeTimer);
  headerHeatmapResizeTimer = setTimeout(() => { if (tickerShowsHeatmap()) scheduleHeaderHeatmapRender(); }, 200);
});

// --- ウェルカムメッセージ設定 (BM-092 / BT-428で全体設定タブへ統合) ---
// 旧モーダルはBT-428で廃止し、設定パネルの「全体設定」タブに移した。
// ヒートマップ(#header-heatmap)のクリックは従来どおり、このタブを開く近道として残す。
const heatmapIntroSettingsSave = document.getElementById('heatmap-intro-settings-save');
const heatmapIntroSettingsStatus = document.getElementById('heatmap-intro-settings-status');
const settingsTickerDefaultModeEl = document.getElementById('settings-ticker-default-mode');
const heatmapIntroTextEl = document.getElementById('heatmap-intro-text');
const heatmapIntroSpeedEl = document.getElementById('heatmap-intro-speed');
const heatmapIntroLitLevelEl = document.getElementById('heatmap-intro-lit-level');
const settingsCardSizeEl = document.getElementById('settings-card-size');
const settingsDescriptionZoomEl = document.getElementById('settings-description-zoom');

// 全体設定タブを開いた時に、各欄へ現在値を反映する（BT-428）
function populateGlobalSettings() {
  populateColumnOrder();
  populateHeatmapIntroSettings();
  // ヘッダ/詳細画面の直接操作で変わった現在値を、全体設定を開くたびに表示する。
  settingsCardSizeEl.value = document.documentElement.getAttribute('data-card-size') || 'l';
  settingsDescriptionZoomEl.value = String(getDescriptionZoom());
}

// BT-464: 全体設定からも、既存のヘッダ文字サイズ操作と同じ保存値を変更できる。
settingsCardSizeEl.addEventListener('change', () => {
  const settings = loadSettings();
  settings.cardSize = settingsCardSizeEl.value;
  saveSettings(settings);
  applyCardSize(settings.cardSize);
});

// BT-464: 詳細のMarkdown表示倍率は、既存の＋/−・Ctrl+ホイールと同じ値を使う。
settingsDescriptionZoomEl.addEventListener('change', () => {
  setDescriptionZoom(Number(settingsDescriptionZoomEl.value));
});

async function populateHeatmapIntroSettings() {
  heatmapIntroSettingsStatus.textContent = '';
  // 起動時のヘッダー表示は個人のブラウザ設定(tickerMode)なので、サーバー取得と無関係にその場の値を反映する。
  // 保存済みの値がoffの場合は(モーダル上の選択肢がログ/マップの2つしかないため)heatmapを初期選択にしておく。
  settingsTickerDefaultModeEl.value = tickerMode === 'log' ? 'log' : 'heatmap';
  await loadHeaderHeatmapIntroSettings();
  heatmapIntroTextEl.value = headerHeatmapIntroSettings.text;
  heatmapIntroSpeedEl.value = String(headerHeatmapIntroSettings.frameMs);
  heatmapIntroLitLevelEl.value = String(headerHeatmapIntroSettings.litLevel);
}

if (headerHeatmapEl) {
  headerHeatmapEl.style.cursor = 'pointer';
  headerHeatmapEl.title = 'クリックして全体設定（ウェルカムメッセージ）を開く';
  headerHeatmapEl.addEventListener('click', () => openSettingsPanel(activeWorkspace(), 'global'));
}

// --- メインボードの列の並び替え (BT-428) ---
// 現在のボードの列順(currentBoardData.columns)を上下ボタンで編集し、保存でPOST /api/update-column-order。
// 保存後はサーバーのboard broadcastでメインボードが並び替わる。
const columnOrderListEl = document.getElementById('settings-column-order');
const columnOrderSaveEl = document.getElementById('settings-column-order-save');
const columnOrderStatusEl = document.getElementById('settings-column-order-status');
let columnOrderDraft = []; // [{id,label}]
let columnOrderBaseline = []; // 保存済みの並び(id配列)

function populateColumnOrder() {
  const cols = (currentBoardData && currentBoardData.columns) || [];
  columnOrderDraft = cols.map(c => ({ id: c.id, label: c.label || c.id }));
  columnOrderBaseline = columnOrderDraft.map(c => c.id);
  columnOrderStatusEl.textContent = '';
  renderColumnOrder();
}

function renderColumnOrder() {
  columnOrderListEl.innerHTML = columnOrderDraft.map((c, i) => `
    <li class="column-order-item" data-id="${escapeHtml(c.id)}">
      <div class="column-order-preview-header">
        <span class="column-order-label">${escapeHtml(c.label)}</span>
        <span class="column-order-preview-kind">ボード列</span>
      </div>
      <div class="column-order-actions">
      <button type="button" class="column-order-btn" data-move="top" title="先頭へ" aria-label="${escapeHtml(c.label)}を先頭へ"${i === 0 ? ' disabled' : ''}>|&lt;</button>
      <button type="button" class="column-order-btn" data-move="-1" title="左へ" aria-label="${escapeHtml(c.label)}を左へ"${i === 0 ? ' disabled' : ''}>←</button>
      <button type="button" class="column-order-btn" data-move="1" title="右へ" aria-label="${escapeHtml(c.label)}を右へ"${i === columnOrderDraft.length - 1 ? ' disabled' : ''}>→</button>
      <button type="button" class="column-order-btn" data-move="end" title="末尾へ" aria-label="${escapeHtml(c.label)}を末尾へ"${i === columnOrderDraft.length - 1 ? ' disabled' : ''}>&gt;|</button>
      </div>
    </li>`).join('');
  columnOrderListEl.querySelectorAll('.column-order-btn').forEach(btn => btn.addEventListener('click', () => {
    const idx = columnOrderDraft.findIndex(c => c.id === btn.closest('.column-order-item').dataset.id);
    if (btn.dataset.move === 'top') {
      if (idx <= 0) return;
      columnOrderDraft.unshift(columnOrderDraft.splice(idx, 1)[0]);
    } else if (btn.dataset.move === 'end') {
      if (idx < 0 || idx >= columnOrderDraft.length - 1) return;
      columnOrderDraft.push(columnOrderDraft.splice(idx, 1)[0]);
    } else {
      const next = idx + Number(btn.dataset.move);
      if (idx < 0 || next < 0 || next >= columnOrderDraft.length) return;
      [columnOrderDraft[idx], columnOrderDraft[next]] = [columnOrderDraft[next], columnOrderDraft[idx]];
    }
    columnOrderStatusEl.textContent = '';
    renderColumnOrder();
  }));
  columnOrderSaveEl.disabled = columnOrderDraft.map(c => c.id).join() === columnOrderBaseline.join();
}

columnOrderSaveEl.addEventListener('click', async () => {
  columnOrderStatusEl.textContent = '保存中...';
  try {
    const res = await fetch('/api/update-column-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: columnOrderDraft.map(c => c.id) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存に失敗しました');
    columnOrderBaseline = columnOrderDraft.map(c => c.id);
    renderColumnOrder();
    columnOrderStatusEl.textContent = '保存したよ';
  } catch (e) {
    columnOrderStatusEl.textContent = `エラー: ${e.message}`;
  }
});

heatmapIntroSettingsSave.addEventListener('click', async () => {
  // 起動時のヘッダー表示(個人のブラウザ設定)は即時にlocalStorageへ反映する(既存のtickerToggleBtnと同じキー)
  tickerMode = settingsTickerDefaultModeEl.value === 'log' ? 'log' : 'heatmap';
  localStorage.setItem('tickerMode', tickerMode);
  applyTickerVisibility();

  // 文言・速度・濃淡レベル(アプリ共通設定)はサーバーへ保存する
  heatmapIntroSettingsStatus.textContent = '保存中...';
  try {
    const res = await fetch('/api/header-heatmap-intro-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: heatmapIntroTextEl.value.trim(),
        frameMs: Number(heatmapIntroSpeedEl.value),
        litLevel: Number(heatmapIntroLitLevelEl.value),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '保存に失敗しました');
    headerHeatmapIntroSettings = { ...HEADER_HEATMAP_INTRO_DEFAULTS, ...data.settings };
    heatmapIntroSettingsStatus.textContent = '保存したよ';
  } catch (e) {
    heatmapIntroSettingsStatus.textContent = `エラー: ${e.message}`;
  }
});

applyTickerVisibility(); // ヒートマップ用のlet変数を宣言し終えた後に初期反映する

// タスク変動(新規イベント)を検知した時の処理。ヒートマップ設定中ならログへ一時切替し、
// 最後の変動から一定時間が過ぎたらヒートマップへ戻す(変動が続く間はタイマーを延長する)。
function onHeaderTickerActivity() {
  headerHeatmapDirty = true;
  if (tickerMode !== 'heatmap') return;
  clearTimeout(tickerLogHoldTimer);
  tickerLogHoldTimer = setTimeout(() => {
    tickerLogHoldTimer = null;
    applyTickerVisibility();
  }, TICKER_LOG_HOLD_MS);
  applyTickerVisibility();
}

function headerTickerLineHtml(line) {
  return `<div class="header-ticker-line" data-ticker-id="${line.id}" title="${escapeHtml(line.title)}">` +
    `<span class="ticker-ts">${escapeHtml(line.time)}</span>` +
    `<span class="ticker-id">${escapeHtml(line.taskId || '')}</span>` +
    `<span class="ticker-action">${escapeHtml(line.action)}</span>` +
    (line.detail ? ` <span class="ticker-detail">${escapeHtml(line.detail)}</span>` : '') +
    (line.title ? ` <span class="ticker-title">${escapeHtml(line.title)}</span>` : '') +
    `</div>`;
}

// data.recentEvents(occurred_at降順、buildRecentEvents()由来)を受け取り、ティッカーのDOMを更新する。
// 既存行は再アニメーションさせず、新規行(id > 前回描画時の最大id)だけを先頭に差分追加する
// 「コンソールにログが流れる」見た目に近づける(全行を毎回作り直すと既存行まで毎回フェードインし直して
// ちらつくため、差分方式にした)。古い行はCSSのmaskで下端が自然にフェードアウトする。
function renderHeaderTicker(events) {
  if (tickerMode === 'off' || !headerTickerListEl) return; // OFF中はDOM更新コストをかけない
  if (!Array.isArray(events) || typeof headerTicker === 'undefined') return;

  const lines = headerTicker.toTickerLines(events); // 新しい順(先頭が最新)
  const isFirstRender = headerTickerListEl.children.length === 0;

  if (isFirstRender) {
    // 初回表示は全件を一括表示する。流れてきた風のアニメーションは不要なので付けない。
    headerTickerListEl.innerHTML = lines.map(headerTickerLineHtml).join('');
    headerTickerListEl.querySelectorAll('.header-ticker-line').forEach(el => {
      el.style.animation = 'none';
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
  } else {
    const newLines = lines.filter(line => line.id > headerTickerLastMaxId);
    if (newLines.length > 0) onHeaderTickerActivity();
    // newLinesは新しい順。DOM先頭に古い方から順に挿してprependすると、
    // 最終的に一番新しい行がDOM最先頭(見た目の最上段)に来る。
    for (let i = newLines.length - 1; i >= 0; i--) {
      headerTickerListEl.insertAdjacentHTML('afterbegin', headerTickerLineHtml(newLines[i]));
    }
  }

  // サーバー側がLIMIT 30で返す件数に合わせてDOM側も同じ件数まで切り詰める
  // (差分追加だけだと長時間稼働でDOMが無限に増えるため)。
  while (headerTickerListEl.children.length > lines.length) {
    headerTickerListEl.removeChild(headerTickerListEl.lastElementChild);
  }

  if (lines.length > 0 && lines[0].id > headerTickerLastMaxId) headerTickerLastMaxId = lines[0].id;
}

function updateProjectFilter(projects) {
  wsFilterProjects = projects;
  wsFilterMainDropdown.render();
  if (wsFilterPlanDropdown) wsFilterPlanDropdown.render();
}

// BM-029: ワークスペース絞り込みドロップダウンのDO/READY/TODO/DONE件数を再計算して描画し直す。
// proj-badge集計(renderBoard内)と同じ考え方: 親EPICは実効ステータスで1件、
// parentIdを持つ個別完了子表示は対象外（親が丸ごとDONEになった時点で親側が1件カウントされる）。
function renderWsFilterCounts(data) {
  const counts = {};
  for (const col of data.columns) {
    for (const item of col.items) {
      if (item.parentId || !item.project) continue;
      if (!['do', 'ready', 'todo', 'done'].includes(item.statusCode)) continue;
      if (!counts[item.project]) counts[item.project] = { do: 0, ready: 0, todo: 0, done: 0 };
      counts[item.project][item.statusCode]++;
    }
  }
  wsFilterCounts = counts;
  wsFilterMainDropdown.render();
  if (wsFilterPlanDropdown) wsFilterPlanDropdown.render();
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
      applySettings();
      renderBoard(currentBoardData);
      renderHeaderTicker(data.recentEvents);
      refreshModalIfOpen();
      refreshPlanBoardIfOpen();
      openTaskFromUrlIfPresent(); // BM-066: ?id=BM-xxx での起動時オープン(内部で1回だけ実行)
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

// BM-014: 右端に浮いていた「live」テキストバッジを廃止し、ロゴ右下の状態ドットに統合。
// 「接続中（live）」は当たり前の状態なので常時は表示しない。表示するのは次の3パターンだけ：
//   1. 接続した瞬間だけ一瞬光らせる（起動/再接続の確認サイン、2.5秒でフェードアウト）
//   2. 進行中タスクがある間（＝誰か/何かが実際に動いている間）は消さず脈動を継続する
//   3. 切断中（異常）は赤で表示し続ける（最優先、再接続まで居座る）
let statusHideTimer = null;
let connStatusCls = 'connected';
let connStatusText = 'connecting...';
let hasRunningTasksForDot = false;

function setStatus(cls, text) {
  connStatusCls = cls;
  connStatusText = text;
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  renderConnStatusDot();
  if (cls === 'connected') {
    // 接続確認の一瞬だけ必ず見せる。進行中タスクがあれば、この後もrenderConnStatusDotが表示を継続する。
    statusHideTimer = setTimeout(() => {
      statusHideTimer = null;
      renderConnStatusDot();
    }, 2500);
  }
  // disconnected はタイマーを張らない。renderConnStatusDotが最優先で表示し続ける。
}

// 進行中タスクの有無が変わった時だけ呼ばれる（renderRunningStripから）。
function setRunningTasksPresence(hasRunning) {
  if (hasRunningTasksForDot === hasRunning) return;
  hasRunningTasksForDot = hasRunning;
  renderConnStatusDot();
}

function renderConnStatusDot() {
  if (connStatusCls === 'disconnected') {
    statusEl.className = 'conn-status-dot show disconnected';
    statusEl.title = connStatusText;
    statusEl.setAttribute('aria-label', connStatusText);
    return;
  }
  const justConnected = statusHideTimer !== null;
  const visible = justConnected || hasRunningTasksForDot;
  const text = hasRunningTasksForDot ? '実行中のタスクがあります' : connStatusText;
  statusEl.className = `conn-status-dot connected${visible ? ' show' : ''}`;
  statusEl.title = text;
  statusEl.setAttribute('aria-label', text);
}

// --- 進行中タスク表示（ステータスバー / BT-059） ---
function collectRunningTasks(data) {
  const result = [];
  const seen = new Set();
  if (!data || !data.columns) return result;
  for (const col of data.columns) {
    for (const item of col.items) {
      // EPICのrunningは子タスクの状態を集約して表示するためのもの。
      // フッダーには実際に作業中の子タスクだけを出し、EPIC自体は出さない。
      const isEpic = (item.children || []).length > 0;
      if (item.running && !isEpic && !seen.has(item.id)) {
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

const RUNNING_AGENT_META = {
  codex: { label: 'Codex', icon: 'codex-icon.svg' },
  'claude-code': { label: 'Claude Code', icon: 'claude-icon.png' },
  kiro: { label: 'Kiro', icon: 'kiro-run-icon.png' },
  user: { label: 'User', icon: 'icons/person.svg' },
};

function runningAgentMeta(agentId) {
  return RUNNING_AGENT_META[agentId] || { label: agentId || 'User', icon: 'icons/person.svg' };
}

function renderRunningStrip(data) {
  const el = document.getElementById('running-strip-agents');
  if (!el) return;
  const running = collectRunningTasks(data);
  const countEl = document.getElementById('running-strip-count');
  if (countEl) {
    countEl.textContent = `進行中: ${running.length}件`;
    countEl.hidden = running.length === 0;
  }
  // BM-014: 進行中タスクがある間は、ロゴ右下の接続状態ドットを消さず脈動させ続ける。
  setRunningTasksPresence(running.length > 0);
  const agents = ['codex', 'claude-code', 'kiro'];
  for (const { item } of running) {
    const agentId = item.agentId || 'user';
    if (!agents.includes(agentId)) agents.push(agentId);
  }
  const activeAgentIds = running
    .map(({ item }) => item.agentId || 'user');
  const orderedAgents = runningAgentOrder.orderAgentsByActivity(agents, activeAgentIds);
  const indexByTaskId = new Map(running.map((entry, index) => [entry.item.id, index]));
  el.innerHTML = orderedAgents.map(agentId => {
    const meta = runningAgentMeta(agentId);
    const tasks = running.filter(({ item }) => (item.agentId || 'user') === agentId);
    const isActiveAgent = tasks.length > 0 && agentId !== 'user';
    const iconAnimation = isActiveAgent
      ? (agentId === 'kiro' ? ' floating' : ' spinning')
      : '';
    const chips = tasks.map(({ item }) => `
      <button type="button" class="running-chip" data-idx="${indexByTaskId.get(item.id)}" title="${escapeHtml(item.title)}">
        <span class="running-spinner"></span>
        <span class="running-chip-id">${escapeHtml(item.id)}</span>
        <span class="running-chip-title">${escapeHtml(item.title)}</span>
      </button>
    `).join('');
    return `<section class="running-agent${tasks.length ? ' is-running' : ''}" data-agent="${escapeHtml(agentId)}" style="--running-count:${Math.max(tasks.length, 1)}" aria-label="${escapeHtml(meta.label)}: ${tasks.length} running tasks">
      <img class="running-agent-icon${iconAnimation}" src="${meta.icon}" alt="${escapeHtml(meta.label)}" title="${escapeHtml(meta.label)}">
      <div class="running-agent-chips">${chips}</div>
    </section>`;
  }).join('');
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
// BM-058: 初回board受信時に一度だけ、中央のローディングダイアログを隠す
function hideBoardInitialLoading() {
  const overlay = document.getElementById('board-initial-loading-overlay');
  if (overlay) overlay.hidden = true;
}

function renderBoard(data) {
  hideBoardInitialLoading();
  lastBoardData = data;
  suppressQuickTipScrollClose(); // BM-136: スクロール位置の書き戻しで右クリックTIPが閉じないようにする

  // BM-078: ピン留め等でWebSocket再描画が入ると列が丸ごと作り直されるため、
  // 破棄前に各列のスクロール位置を保存し、再構築後に書き戻して先頭ジャンプを防ぐ
  const scrollPositions = {};
  boardEl.querySelectorAll('.column-body[data-col-id]').forEach(el => {
    scrollPositions[el.dataset.colId] = el.scrollTop;
  });

  boardEl.innerHTML = '';
  renderRunningStrip(data);
  renderWorkspaceSummary(data);

  // 狭幅時サイドバー(BM-018)用: カラムごとの全件数(limit適用前)を集めておく
  // BM-049: レーン表示中はnarrow railを無効化するため、この集計は一枚ボード表示時のみ使う。
  const railCounts = {};
  // BM-078: VS Code Simple Browser等のwebview環境では、appendChild直後は
  // レイアウトがまだ確定しておらずscrollTopの書き戻しが0にクランプされることがある。
  // 通常のブラウザでは起きないため、次フレームでの再書き戻しを保険として追加する。
  const columnBodyEls = {};

  // BM-029: ワークスペース絞り込みドロップダウンの DO/READY/TODO/DONE 件数を更新する。
  // wsFilterCountsはレーンヘッダーの件数表示(BM-049)にも使う。
  renderWsFilterCounts(data);

  // BM-049: All Projects選択時のみ、ワークスペース別レーン表示が意味を持つ。
  const laneModeActive = !currentFilter && boardLaneMode === 'lane';
  updateBoardLaneModeBtn();
  const runningTasksAll = collectRunningTasks(data); // レーンヘッダーの実行中タスク表示に使う
  // レーン表示は縦に複数レーンを積むため、.board自体を縦スクロールさせる(通常は内部の
  // column-bodyだけがスクロールし、.boardはoverflow:hiddenで画面に固定している)。
  boardEl.classList.toggle('lane-mode-active', laneModeActive);

  // カラム1つ分のDOM（ヘッダー・カード一覧）を組み立てる。laneKeyを渡すとそのワークスペースの
  // タスクだけに絞り込む（レーン表示用）。laneKey===nullは従来の一枚ボード/通常の絞り込み。
  function buildBoardColumn(col, laneKey) {
    const fields = col.visibleFields || ['id', 'title', 'badge', 'project', 'category', 'completedDate'];
    const isCompact = col.compact || false;

    // フィルタ適用
    let items = col.items;
    if (laneKey !== null) {
      items = items.filter(item => item.project === laneKey);
    } else if (currentFilter) {
      items = items.filter(item => item.project === currentFilter);
    }
    if (todayFilterActive) {
      // Epicの今日やるは子タスクの集約だけを正とする。旧データに親自身の
      // todayFlagが残っていても、ピン数0のEpicをフィルタ結果へ混ぜない。
      items = items.filter(item => item.childrenTotal > 0 ? item.todayCount > 0 : item.todayFlag);
    }
    if (tagFilter.tags.length > 0) {
      // BT-396: EPICは子のタグも含めて判定する（子がタグを持てば親も出す）
      const tagKeys = tagFilter.tags.map(t => t.key);
      items = items.filter(item => tagLogic.matchesTagFilterForBoardItem(item, tagKeys, tagFilter.mode));
    }
    if (categoryFilter.keys.length > 0) {
      // BM-106: カテゴリは1タスク1値のため、選んだ候補のいずれかに一致するかで判定する
      items = items.filter(item => categoryLogic.matchesCategoryFilterForBoardItem(item, categoryFilter.keys));
    }
    // 完了カラム「本日完了だけ」表示（達成感モード）: completedDateが今日(JST)のものだけ
    const doneTodayActive = isCompact && doneTodayOnly;
    if (doneTodayActive) {
      const todayStr = getTodayJST();
      items = items.filter(item => item.completedDate === todayStr);
    }
    // DONEは完了日時の新しい順で固定し、並び順の選択対象から外す。
    if (!isCompact) items = columnSort.sortItems(items, columnSortMode(col.id));

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
    // BM-049: レーン表示中は同じcol.idが複数回出現するため、id重複(無効なDOM)を避けて
    // narrow-rail-target-*のidは一枚ボード表示時のみ付与する(narrow railもレーン表示中は無効化する)。
    if (laneKey === null) {
      colEl.id = 'narrow-rail-target-' + col.id;
      railCounts[col.id] = totalBeforeLimit;
    }

    // 完了カラム用「本日完了だけ」トグルチップ
    const doneTodayToggleHtml = isCompact
      ? `<button class="done-today-btn${doneTodayOnly ? ' filter-active' : ''}" data-col-id="${col.id}" title="本日完了分のみ表示（達成感モード）"><span class="material-icon icon-celebration"></span> 今日</button>`
      : '';

    // カウント/limit表示エリア
    let countAreaHtml;
    if (doneTodayActive) {
      // 本日完了だけ表示中: 達成感カウント（limit入力は隠す）
      countAreaHtml = `<span class="count done-today-count"><span class="material-icon icon-celebration"></span> ${items.length}</span>`;
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
          ${!isCompact ? columnSortSelectHtml(col.id) : ''}
          ${countAreaHtml}
          <button class="add-task-btn" data-col-id="${col.id}" data-col-status="${col.match[0]}" data-lane="${escapeHtml(laneKey || '')}" title="${isCompact ? '完了済みタスクを追加' : 'タスク追加'}">+</button>
        </div>
      </div>
      <div class="column-body" data-col-id="${col.id}"></div>
    `;

    const body = colEl.querySelector('.column-body');
    setupDropZone(body, col.id, col.match, laneKey);

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'card' + (isCompact ? ' card-compact' : '');
      const isEpic = item.childrenTotal > 0;
      if (isEpic) card.classList.add('card-epic');
      card.dataset.project = item.project;

      if (item.id && item.id !== '-') {
        card.dataset.taskId = item.id;
        setupDragAndDrop(card, item, col.id, laneKey);
        setupParentDropTarget(card, item, laneKey);
      }

      card.classList.add('card-clickable');
      setupCardClick(card, item, !!item.parentId);

      // 今日やるフラグ（Epic: 子の集約、単発: 自身のフラグ）
      const hasTodayFlag = isEpic ? (item.todayCount > 0) : item.todayFlag;
      if (hasTodayFlag) card.classList.add('card-today');

      // KT-054: 実行中カードの強調（カード全体グロー点滅、B案）
      if (item.running) card.classList.add('is-running');

      // 選択モード（BT-034）: 完了カードは選択不可、それ以外は選択状態を反映（EPICも選択可、BT-455）
      if (selectionMode && item.id && item.id !== '-') {
        if (isCompact) {
          card.classList.add('card-select-disabled');
        } else if (selectedIds.has(item.id)) {
          card.classList.add('card-selected');
        }
      }

      const showField = (name) => fields.includes(name);

      const id = (showField('id') && item.id && item.id !== '-') ? item.id : '';
      const completedDate = (showField('completedDate') && item.completedDate) ? renderCompletedDateBadge(item.completedDate) : '';
      const category = (showField('category') && item.category && item.category !== '-') ? categoryBadgeHtml(item.category, { small: true }) : '';

      // 親Epicへのリンク（BT-201: 親が未完了のまま個別完了した子タスクを完了カラムに混在表示する分）
      // クリックすると親Epicの詳細（ミニボード）を開き、このカードをハイライトする
      const parentEpicLinkHtml = item.parentId
        ? `<span class="parent-epic-link" data-parent-id="${escapeHtml(item.parentId)}" title="親タスク: ${escapeHtml(item.parentTitle || '')}（クリックでEpic詳細へ）"><span class="material-icon icon-stacks"></span>${escapeHtml(item.parentId)}</span><span class="id-separator">|</span>`
        : '';

      // GitHub風ピルバッジ（BM-009: 分子がタスク数か完了数か分かりづらいのでチェックマークを付与）
      let badge = '';
      if (showField('badge') && item.childrenTotal) {
        const allDone = item.childrenDone === item.childrenTotal;
        const badgeClass = allDone ? 'badge-done' : '';
        badge = `<span class="card-badge ${badgeClass}"><span class="badge-num"><span class="material-icon icon-check"></span>${item.childrenDone}</span><span class="badge-den">${item.childrenTotal}</span></span>`;
      }

      // 起源マーク
      const originIcon = item.origin === 'claude' ? '<span class="origin-mark" title="Claude"><span class="material-icon icon-smart-toy"></span></span>'
        : item.origin === 'user' ? '<span class="origin-mark" title="User"><span class="material-icon icon-person"></span></span>' : '';

      // 実行中スピナー
      const spinnerHtml = item.running ? '<span class="running-spinner"></span>' : '';

      // Epicハブアイコン（子タスクを束ねる親タスクの目印）
      // BT-450: 通常カードはタイトル先頭のチップで目立たせ、窮屈な完了列(compact)だけ従来どおりID行の小アイコン
      const epicTitleChip = (isEpic && !isCompact) ? '<span class="epic-title-chip" title="親タスク（子タスクを束ねるEpic）"><span class="material-icon icon-stacks"></span></span>' : '';
      const epicIcon = (isEpic && isCompact) ? '<span class="epic-icon" title="親タスク（子タスクを束ねるEpic）"><span class="material-icon icon-stacks"></span></span>' : '';

      const idHtml = id ? `<div class="card-id">${spinnerHtml}${epicIcon}${parentEpicLinkHtml}<span>${id}</span>${originIcon}</div>` : (originIcon || epicIcon ? `<div class="card-id">${spinnerHtml}${epicIcon}${originIcon}</div>` : '');
      const titleHtml = showField('title') ? `<div class="card-title">${epicTitleChip}${escapeHtml(item.title)}</div>` : '';
      // BM-111: ワークスペースを1つに絞っているとき(currentFilterが非空)は全カード同じ値になり
      // 情報量がゼロなので出さない(Plan Board側のwsBadge/BM-012と同じ考え方)。
      // レーン表示中(laneKey!==null)はレーン見出しに既にワークスペース名が出ているため、
      // All Projects選択中でもカード側のバッジは重複するので出さない。
      const projectTag = (showField('project') && !currentFilter && laneKey === null) ? `<span class="card-tag project">${escapeHtml(item.project)}</span>` : '';
      const artifactIndicator = (item.artifacts && item.artifacts.length > 0) ? '<span class="card-tag artifact-indicator" title="成果物あり"><span class="material-icon icon-attach-file"></span></span>' : '';
      const githubBadge = item.githubIssueNumber ? renderGithubIssueBadge(item.githubIssueNumber, item.githubIssueUrl) : '';
      const redmineBadge = renderRedmineIssueBadge(item.externalLinks); // BM-073
      const gitlabBadge = renderGitlabIssueBadge(item.externalLinks); // BM-074
      const dueBadge = item.dueDate ? renderDueDateBadge(item.dueDate, item.statusCode) : '';
      // BT-395: タグは小さなチップで表示(完了カラムのコンパクトカードでは出さない)
      const tagsHtml = isCompact ? '' : tagLogic.buildCardTagsHtml(item.tags, item.childTags);
      const metaParts = [projectTag, category, artifactIndicator, githubBadge, redmineBadge, gitlabBadge, dueBadge, completedDate, tagsHtml].filter(Boolean);
      if (badge) metaParts.push(badge);
      const metaHtml = metaParts.length > 0 ? `<div class="card-meta">${metaParts.join('')}</div>` : '';

      // ピンボタン（完了カラムには不要）
      let pinHtml = '';
      const pinIconHtml = '<span class="material-icon icon-keep"></span>';
      if (!isCompact && item.id && item.id !== '-') {
        if (isEpic) {
          // Epic: 子の集約表示。ピン+件数（一括操作ボタン）
          const pinActive = item.todayCount > 0;
          const pinLabel = pinActive ? `${pinIconHtml}${item.todayCount}` : pinIconHtml;
          pinHtml = `<button class="today-pin-btn${pinActive ? ' pin-active' : ''}" data-task-id="${item.id}" title="今日やる（一括）">${pinLabel}</button>`;
        } else {
          // 単発タスク: 通常トグル
          pinHtml = `<button class="today-pin-btn${item.todayFlag ? ' pin-active' : ''}" data-task-id="${item.id}" title="今日やる">${pinIconHtml}</button>`;
        }
      }

      // 編集・GitHub紐付け・削除ボタン（BT-041: 詳細モーダルを開かずカードから直接操作。完了カラムには不要。Epicは削除不可のため編集のみ）
      let cardActionsHtml = '';
      if (!isCompact && item.id && item.id !== '-') {
        cardActionsHtml = `<div class="card-actions">
          <button class="card-action-btn card-due-btn" data-task-id="${item.id}" title="期日を設定"><span class="material-icon icon-calendar-month"></span></button>
          <button class="card-action-btn card-tag-btn" data-task-id="${item.id}" title="タグを付け外し"><span class="material-icon icon-tag"></span></button>
          <button class="card-action-btn card-category-btn" data-task-id="${item.id}" title="カテゴリを設定"><span class="material-icon icon-stacks"></span></button>
          <button class="card-action-btn card-comment-btn" data-task-id="${item.id}" title="コメントを書く"><span class="material-icon icon-add-comment"></span></button>
          <button class="card-action-btn card-edit-btn" data-task-id="${item.id}" title="編集"><span class="material-icon icon-edit"></span></button>
          ${!item.githubIssueNumber ? `<button class="card-action-btn card-github-link-btn" data-task-id="${item.id}" title="GitHub Issueと紐づける"><span class="material-icon icon-link"></span></button>` : ''}
          ${!item.githubIssueNumber ? `<button class="card-action-btn card-github-create-btn" data-task-id="${item.id}" data-is-child="false" title="GitHub Issueを新規作成"><span class="material-icon icon-upload"></span></button>` : ''}
          <button class="card-action-btn card-redmine-link-btn" data-task-id="${item.id}" title="Redmineチケットと紐づける">${REDMINE_MARK_SVG}</button>
          ${!isEpic ? `<button class="card-action-btn card-delete-btn danger" data-task-id="${item.id}" title="削除"><span class="material-icon icon-delete"></span></button>` : ''}
        </div>`;
      }

      // BM-136: 最新コメントを1行で出す（コメントなしのカードは行を出さず、高さを変えない）。
      // 完了カラム(compact)にも出す（完了時点の最後の状況が分かるように）。文字サイズはcompact用の変数に連動する。
      // EPICはEPIC自身のコメントのみ。
      const commentLineHtml = commentLogic.buildCardCommentHtml(item.latestComment);

      card.innerHTML = `${pinHtml}${cardActionsHtml}${idHtml}${titleHtml}${metaHtml}${commentLineHtml}`;

      // 親Epicリンクのクリック（BT-201）: カード自体のクリック（子タスク詳細を開く）とは独立させ、
      // 親Epicの詳細（ミニボード）をこのカードをハイライトした状態で開く
      const parentEpicLinkEl = card.querySelector('.parent-epic-link');
      if (parentEpicLinkEl) {
        parentEpicLinkEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const epic = findItemById(item.parentId);
          if (!epic) return;
          expandedMiniCols.add('done'); // 完了済みの対象子タスクがlimitで隠れないようにする
          pendingHighlightChildId = item.id;
          openCardDetail(epic);
        });
      }

      body.appendChild(card);
    }

    // 完了カラム（compact）: 「本日完了だけ」表示中の空状態 or limit超過分のまとめ表示
    if (isCompact && doneTodayActive) {
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'done-today-empty';
        empty.innerHTML = `<span class="material-icon icon-psychiatry done-today-empty-icon"></span><span>今日の達成はまだないよ<br>ひとつ片付けてこ！</span>`;
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

    // BT-425: 完了以外の列は末尾にも「＋」を置く(「他N件」カードと同じ破線の見た目)。
    // 完了カラムは過去分の登録用途のためヘッダーの+だけにする。
    if (!isCompact) {
      const addFooter = document.createElement('div');
      addFooter.className = 'card card-compact card-summary card-add-footer';
      addFooter.dataset.colStatus = col.match[0];
      addFooter.dataset.lane = laneKey || '';
      addFooter.title = 'タスク追加';
      addFooter.innerHTML = '<span class="summary-label">＋</span>';
      body.appendChild(addFooter);
    }

    // scrollTopはDOM接続後でないと反映されない(接続前は高さが確定せず0にクランプされる)
    if (scrollPositions[col.id] != null) body.scrollTop = scrollPositions[col.id];
    columnBodyEls[col.id] = body;

    return colEl;
  }

  if (laneModeActive) {
    // BM-049: ワークスペース別レーン表示。レーン1個=1ワークスペースで、中にTODO/READY/DO/DONEの
    // 4列フルセットを持つ(添付イメージ構造)。レーンの並び順は、レーン内タスクのupdatedAt最大値が
    // 新しい順(直近更新のあるワークスペースが上)。タスクが1件も無いワークスペースはレーンを出さない。
    const laneNames = computeBoardLaneOrder(data);
    for (const laneKey of laneNames) {
      const collapsed = collapsedBoardLanes.has(laneKey);
      const laneEl = document.createElement('section');
      laneEl.className = 'board-lane' + (collapsed ? ' is-collapsed' : '');
      const header = document.createElement('div');
      header.className = 'board-lane-header';

      // BM-049: 畳んだ状態でも状況が分かるよう、件数と実行中タスクをヘッダーに出す。
      const c = wsFilterCounts[laneKey] || { do: 0, ready: 0, todo: 0, done: 0 };
      const countsHtml = `<span class="board-lane-counts" title="DO ${c.do} / READY ${c.ready} / TODO ${c.todo} / DONE ${c.done}">
        <span class="board-lane-count-item board-lane-count-do">${c.do}</span>
        <span class="board-lane-count-item board-lane-count-ready">${c.ready}</span>
        <span class="board-lane-count-item board-lane-count-todo">${c.todo}</span>
        <span class="board-lane-count-item board-lane-count-done">${c.done}</span>
      </span>`;

      const laneRunning = runningTasksAll.filter(({ item }) => item.project === laneKey);
      const runningHtml = laneRunning.length > 0
        ? `<span class="board-lane-running">${laneRunning.map(({ item }) => {
            const meta = runningAgentMeta(item.agentId || 'user');
            return `<span class="board-lane-running-chip" title="${escapeHtml(meta.label)}: ${escapeHtml(item.title)}"><span class="running-spinner"></span><img class="board-lane-running-icon" src="${meta.icon}" alt="${escapeHtml(meta.label)}"><span class="board-lane-running-id">${escapeHtml(item.id)}</span></span>`;
          }).join('')}</span>`
        : '';

      // BM-096: ワークスペースパス設定済みなら「開く」(KIRO/CODE選択メニュー)、
      // 未設定(Inbox等)なら「ワークスペースを作る」導線を出す(タスク詳細モーダルと同じ分岐)。
      const wsPath = (data.workspaceMap || {})[laneKey] || '';
      const launchHtml = wsPath
        ? `<button type="button" class="board-lane-launch-btn" data-lane="${escapeHtml(laneKey)}" title="ワークスペースを開く"><span class="material-icon icon-folder-open"></span></button>`
        : `<button type="button" class="board-lane-launch-btn board-lane-launch-create" data-lane="${escapeHtml(laneKey)}" title="ワークスペースを作る"><span class="material-icon icon-construction"></span></button>`;

      header.innerHTML = `<button type="button" class="board-lane-toggle" title="${collapsed ? '開く' : '畳む'}">${collapsed ? '▸' : '▾'}</button><span class="board-lane-title">${escapeHtml(laneKey)}</span>${launchHtml}${countsHtml}${runningHtml}`;
      header.addEventListener('click', () => {
        if (collapsedBoardLanes.has(laneKey)) collapsedBoardLanes.delete(laneKey); else collapsedBoardLanes.add(laneKey);
        persistCollapsedBoardLanes();
        renderBoard(lastBoardData);
      });
      const launchBtn = header.querySelector('.board-lane-launch-btn');
      launchBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // ヘッダー自体のクリック(折りたたみ)に伝播させない
        if (wsPath) {
          openBoardLaneWorkspaceMenu(launchBtn, laneKey);
        } else {
          openSettingsPanel(NEW_WORKSPACE_VALUE); // 既存のタスク詳細モーダルと同じ「作る」導線に一本化
        }
      });
      laneEl.appendChild(header);

      if (!collapsed) {
        const laneBody = document.createElement('div');
        laneBody.className = 'board-lane-body';
        const laneColumnsEl = document.createElement('div');
        laneColumnsEl.className = 'board-columns';
        for (const col of data.columns) {
          laneColumnsEl.appendChild(buildBoardColumn(col, laneKey));
        }
        laneBody.appendChild(laneColumnsEl);
        laneEl.appendChild(laneBody);
      }
      boardEl.appendChild(laneEl);
    }
  } else {
    const boardColumnsEl = document.createElement('div');
    boardColumnsEl.className = 'board-columns';
    boardEl.appendChild(boardColumnsEl);
    for (const col of data.columns) {
      boardColumnsEl.appendChild(buildBoardColumn(col, null));
    }
  }

  // プロジェクト別残タスクバッジ表示（クリックでフィルタ連携）
  const badgesEl = document.getElementById('project-badges');
  if (badgesEl && data.remainingByProject) {
    // 描画中のボードデータを直接使う。WebSocket再接続や初回描画の順序に左右されず、
    // URLで開いたワークスペースを確実に強調できる。
    // BT-341: 集計対象はバッジ設定メニューで選んだモード。親に紐づく完了子の個別表示(parentIdあり)は除外する。
    const badgeCodes = BADGE_MODES[badgeMode].codes;
    const badgeCounts = {};
    for (const col of data.columns) {
      for (const item of col.items) {
        if (item.parentId || !item.project || !badgeCodes.includes(item.statusCode)) continue;
        badgeCounts[item.project] = (badgeCounts[item.project] || 0) + 1;
      }
    }
    const entries = Object.entries(badgeCounts)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    badgesEl.innerHTML = entries.map(([proj, count]) => {
      const isActive = currentFilter === proj;
      const isDimmed = !!currentFilter && !isActive;
      const isCurrentWorkspace = isUrlWorkspaceProject(proj, data);
      const cls = ['proj-badge', isActive ? 'active' : '', isDimmed ? 'dimmed' : '', isCurrentWorkspace ? 'workspace-context' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" data-project="${escapeHtml(proj)}">${proj}<span class="proj-badge-count">${count}</span></span>`;
    }).join('');
  }

  // BM-078: webview環境向けの保険。次フレームでレイアウト確定後に再度書き戻す。
  // 通常ブラウザでは既に正しい位置になっているため、この再設定は実質no-op。
  // 1回のrAFでレイアウトが確定しきらない環境も想定し、2段(次のフレームのさらに次)で確認する。
  if (Object.keys(scrollPositions).length > 0) {
    const reapply = () => {
      for (const colId of Object.keys(columnBodyEls)) {
        const target = scrollPositions[colId];
        const body = columnBodyEls[colId];
        if (target != null && body && body.scrollTop !== target) {
          body.scrollTop = target;
        }
      }
    };
    requestAnimationFrame(() => {
      reapply();
      requestAnimationFrame(reapply);
    });
  }

  // +ボタンのイベントリスナーを設定
  // BT-425: ヘッダーの+と列末尾の「＋」は同じ判定。レーン表示中はそのレーンのワークスペースに追加する
  boardEl.querySelectorAll('.add-task-btn, .card-add-footer').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddTaskForm(btn.dataset.colStatus, btn.dataset.lane || currentFilter || '', '');
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

  boardEl.querySelectorAll('.column-sort-select').forEach(select => {
    select.addEventListener('change', (e) => {
      localStorage.setItem(COLUMN_SORT_KEY_PREFIX + e.target.dataset.colId, e.target.value);
      renderBoard(lastBoardData);
    });
  });

  // ピンボタンのイベントリスナー
  boardEl.querySelectorAll('.today-pin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const taskId = btn.dataset.taskId;
      const isActive = btn.classList.contains('pin-active');
      toggleTodayFlag(taskId, !isActive);
    });
  });

  // カード期日ボタン（BT-354）: カレンダーを開き、選択した日付をそのまま保存する（履歴はAPI側で自動記録）
  boardEl.querySelectorAll('.card-due-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openDueDatePicker(btn, item.dueDate, (date) => planUpdateDueDate(item.id, date));
    });
  });

  // カードのタグボタン（BT-423）
  boardEl.querySelectorAll('.card-tag-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openCardTagPicker(btn);
    });
  });

  // カードのカテゴリボタン（BT-445）
  boardEl.querySelectorAll('.card-category-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openCardCategoryPicker(btn);
    });
  });

  // カードのコメントボタン（BM-136）: 右クリックTIPを開いて入力欄にフォーカスする
  boardEl.querySelectorAll('.card-comment-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openCardCommentTip(btn);
    });
  });

  // カード直接編集ボタンのイベントリスナー（BT-041）
  boardEl.querySelectorAll('.card-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openCardEditDirect(item);
    });
  });

  // カード直接削除ボタンのイベントリスナー（BT-041）
  boardEl.querySelectorAll('.card-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openDeleteConfirm(item, false);
    });
  });

  // GitHub Issueバッジ: クリックしてもカード詳細を開かず、リンク遷移のみ行う（BT-110）
  boardEl.querySelectorAll('.github-issue-badge').forEach(link => {
    link.addEventListener('click', (e) => e.stopPropagation());
  });
  // Redmineバッジも同様(BM-073)
  boardEl.querySelectorAll('.redmine-issue-badge').forEach(link => {
    link.addEventListener('click', (e) => e.stopPropagation());
  });

  // GitHub Issue紐付けボタンのイベントリスナー（BT-122）
  boardEl.querySelectorAll('.card-github-link-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openGithubLinkModal(item);
    });
  });

  // GitHub Issue新規作成ボタンのイベントリスナー（BT-134）
  boardEl.querySelectorAll('.card-github-create-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openGithubCreateConfirm(item, btn.dataset.isChild === 'true');
    });
  });

  // Redmineチケット紐付けボタンのイベントリスナー（BM-126）
  boardEl.querySelectorAll('.card-redmine-link-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const item = findItemById(btn.dataset.taskId);
      if (item) openRedmineLinkModal(item);
    });
  });

  updateSelectionBar();
  // BM-049: レーン表示中は同じカラムIDが複数回出現し、narrow railのジャンプ先が一意に決まらないため無効化する。
  if (laneModeActive) {
    const railEl = document.getElementById('narrow-rail');
    if (railEl) railEl.innerHTML = '';
  } else {
    renderNarrowRail(data.columns, railCounts);
  }
}

// --- Narrow Rail (BM-018) ---
// 狭幅(800px以下)でカラムが縦積みになる時に迷子にならないための左サイドバー。
// DO/READY/TODO/DONEへのジャンプ + 履歴ダイアログへの入口をまとめる。
const NARROW_RAIL_DEFS = [
  { colId: 'in_progress', label: 'DO', icon: 'play-arrow' },
  { colId: 'ready', label: 'READY', icon: 'arrow-forward' },
  { colId: 'todo', label: 'TODO', icon: 'folder-open' },
  { colId: 'done', label: 'DONE', icon: 'check' },
];

let narrowRailObserver = null;
// IntersectionObserverのentriesには「比率が変化したターゲットだけ」が渡される。
// 呼び出しごとにentries内だけで最大値を取ると、クリック直後などentriesに
// 含まれなかったカラムの比率を見落として選択状態が更新されない。
// 全ターゲットの最新比率をここに保持し、callbackではこのMapを更新してから
// 全体の中で最大のものを選ぶ。
const narrowRailRatios = new Map();

// .board の実際の表示領域(ヘッダー/running-stripに隠れない範囲)の縦中央にバーを置く。
// ヘッダーはワークスペース数で高さが変わるため、画面全体の50%固定だと
// バーがヘッダーの裏に隠れることがある(BM-018バグ報告)。
function positionNarrowRail() {
  const railEl = document.getElementById('narrow-rail');
  if (!railEl || getComputedStyle(railEl).display === 'none') return;
  const boardRect = boardEl.getBoundingClientRect();
  const railHeight = railEl.offsetHeight;
  const minTop = boardRect.top + 8;
  const maxTop = boardRect.bottom - railHeight - 8;
  const centerTop = boardRect.top + (boardRect.height - railHeight) / 2;
  const top = Math.max(minTop, Math.min(maxTop, centerTop));
  railEl.style.top = `${Math.max(8, top)}px`;
  railEl.style.transform = 'none';
}

window.addEventListener('resize', positionNarrowRail);

function renderNarrowRail(columns, railCounts) {
  const railEl = document.getElementById('narrow-rail');
  if (!railEl) return;

  const existingCols = new Set((columns || []).map(c => c.id));
  const buttonsHtml = NARROW_RAIL_DEFS
    .filter(def => existingCols.has(def.colId))
    .map(def => {
      const count = railCounts[def.colId] || 0;
      return `<button type="button" class="narrow-rail-btn" data-col-id="${def.colId}" title="${def.label}へ移動">
        <span class="material-icon icon-${def.icon}"></span>
        <span class="narrow-rail-label">${def.label}</span>
        <span class="narrow-rail-count">${count}</span>
      </button>`;
    }).join('');

  railEl.innerHTML = `${buttonsHtml}
    <button type="button" class="narrow-rail-btn narrow-rail-history-btn" data-action="history" title="履歴を開く">
      <span class="material-icon icon-history"></span>
      <span class="narrow-rail-label">履歴</span>
    </button>`;

  railEl.querySelectorAll('.narrow-rail-btn[data-col-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById('narrow-rail-target-' + btn.dataset.colId);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  const historyBtn = railEl.querySelector('[data-action="history"]');
  if (historyBtn) {
    historyBtn.addEventListener('click', () => {
      if (typeof openActivityView === 'function') openActivityView();
    });
  }

  setupNarrowRailScrollSpy();
  // レンダリング直後はバーの行数(=offsetHeight)が確定した後でないと中央計算がずれるため、
  // 描画が終わった次フレームで位置を合わせる。
  requestAnimationFrame(positionNarrowRail);
}

// メイン領域(.board)のスクロールに合わせて、今見えているカラムのバーボタンをハイライトする。
function setupNarrowRailScrollSpy() {
  if (narrowRailObserver) {
    narrowRailObserver.disconnect();
    narrowRailObserver = null;
  }

  const railEl = document.getElementById('narrow-rail');
  if (!railEl) return;

  const targets = NARROW_RAIL_DEFS
    .map(def => document.getElementById('narrow-rail-target-' + def.colId))
    .filter(Boolean);
  if (targets.length === 0) return;

  const setActive = (colId) => {
    railEl.querySelectorAll('.narrow-rail-btn[data-col-id]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.colId === colId);
    });
  };

  narrowRailRatios.clear();
  narrowRailObserver = new IntersectionObserver((entries) => {
    // entriesには比率が変化したターゲットだけが入るため、まず最新値をMapへ反映し、
    // 全ターゲット分のMapの中から最も大きく見えているものを選ぶ（entries内だけで
    // 比較すると、クリックジャンプ直後などentriesに含まれなかったカラムを見落とす）。
    for (const entry of entries) {
      const colId = entry.target.id.replace('narrow-rail-target-', '');
      narrowRailRatios.set(colId, entry.isIntersecting ? entry.intersectionRatio : 0);
    }
    let bestColId = null;
    let bestRatio = 0;
    for (const [colId, ratio] of narrowRailRatios) {
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestColId = colId;
      }
    }
    if (bestColId) setActive(bestColId);
  }, { root: boardEl, threshold: [0, 0.25, 0.5, 0.75, 1] });

  targets.forEach(t => narrowRailObserver.observe(t));
}

function renderWorkspaceSummary(data) {
  if (!currentFilter || !data.workspaceSummaryMap || !Object.prototype.hasOwnProperty.call(data.workspaceSummaryMap, currentFilter)) return;
  const summary = data.workspaceSummaryMap[currentFilter] || '';
  const workspacePath = (data.workspaceMap && data.workspaceMap[currentFilter]) || '';
  const overview = document.createElement('section');
  overview.className = 'workspace-overview';
  overview.innerHTML = `<div class="workspace-overview-content"><span class="workspace-overview-label">${escapeHtml(currentFilter)}</span><button type="button" class="workspace-overview-edit-btn" title="ワークスペース概要を編集" aria-label="ワークスペース概要を編集"><span class="material-icon icon-edit"></span></button><span class="workspace-overview-text${summary ? '' : ' is-empty'}">${escapeHtml(summary || 'ワークスペースの概要を入力')}</span><span class="workspace-overview-path" title="ワークスペースの場所">${escapeHtml(workspacePath || 'ワークスペースの場所は未設定')}</span></div>`;
  boardEl.appendChild(overview);
  overview.querySelector('.workspace-overview-edit-btn').addEventListener('click', () => startWorkspaceSummaryEdit(overview, currentFilter, summary));
}

function startWorkspaceSummaryEdit(overview, project, initialSummary) {
  overview.classList.add('is-editing');
  const input = document.createElement('input');
  input.className = 'workspace-overview-input';
  input.type = 'text';
  input.maxLength = 240;
  input.value = initialSummary;
  input.placeholder = 'ワークスペースの概要を入力';
  overview.querySelector('.workspace-overview-text').replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const summary = save ? input.value : initialSummary;
    let saved = false;
    if (save && summary !== initialSummary) {
      try {
        const response = await fetch('/api/update-workspace-summary', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project, summary }),
        });
        if (!response.ok) throw new Error((await response.json()).error || '保存に失敗しました');
        saved = true;
      } catch (error) {
        console.error('[workspace-summary]', error);
        alert(`ワークスペース概要を保存できませんでした: ${error.message}`);
      }
    }
    if (!saved) renderBoard(currentBoardData);
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/**
 * カードの編集ボタンから直接呼ばれる: 詳細モーダルを開いて即編集モードにする（BT-041）
 * @param {object} item
 */
function openCardEditDirect(item) {
  openCardDetail(item);
  const modal = getOrCreateModal();
  const body = modal.querySelector('.modal-body');
  const isEpic = item.children && item.children.length > 0;
  const isArchivedSingle = !isEpic && item.statusCode === 'done';
  enterEditMode(item, body, isArchivedSingle, renderModalContent);
}

/**
 * ミニボード子カードの編集ボタンから直接呼ばれる: 子詳細モーダルを開いて即編集モードにする（BT-041）
 * @param {object} childWithProject
 * @param {object} epic
 */
function openChildCardEditDirect(childWithProject, epic) {
  openCardDetail(childWithProject, epic);
  const modal = getOrCreateChildModal();
  const body = modal.querySelector('.modal-body');
  enterEditMode(childWithProject, body, false, openChildModal);
}

// 期日が期限切れ（期日 <= 今日(JST)）かつ未完了か判定する（BT-336）
function isDueOverdue(dueDate, statusCode) {
  return !!dueDate && statusCode !== 'done' && dueDate <= getTodayJST();
}

// 期日の表示（BT-336）。「期日: 現在 (←直前)」の1行を基本とし、変更が2回以上なら
// 「▶変更履歴(n件)」を折り畳みで添える（開くと当初→現在を縦積み、新しいものが上）。
function buildDueDateTrailHtml(item) {
  const entries = dueTrail.buildDueTrail(item.dueDateHistory);
  if (!item.dueDate && entries.length < 2) return '';
  const label = v => (v ? escapeHtml(v) : '未設定');
  // 変更日時(BT-435)。延期=赤・前倒し=青の色クラスを、変更の向きに応じて付ける
  const changedAt = e => (e.at ? ` <span class="due-changed-at">(変更日：${escapeHtml(formatDateTimeJst(e.at))})</span>` : '');
  const currentCls = isDueOverdue(item.dueDate, item.statusCode) ? ' class="due-overdue"' : '';
  const changes = entries.length - 1;
  let prev = '';
  if (changes >= 1) {
    const last = entries[entries.length - 1];
    const cls = ['due-prev', dueTrail.directionClass(last.direction)].filter(Boolean).join(' ');
    prev = ` <span class="${cls}">(←${label(entries[entries.length - 2].value)})${changedAt(last)}</span>`;
  }
  let trailHtml = '';
  if (changes >= 2) {
    const rows = entries.slice().reverse().map(e => `<div class="${dueTrail.directionClass(e.direction)}">${label(e.value)}${changedAt(e)}</div>`).join('<div class="due-arrow">↑</div>');
    trailHtml = `<details class="due-mid"><summary>変更履歴（${changes}件）</summary><div class="due-trail">${rows}</div></details>`;
  }
  return `<li class="detail-due"><strong>期日:</strong> <span${currentCls}>${label(item.dueDate)}</span>${prev}${trailHtml}</li>`;
}

// 情報セクション（担当・日付・トラッキング情報）のHTML生成。
// 単発/子/EPICの3種で別々に組んでいたものをBT-261で1箇所に統一。
function buildMetaHtml(item) {
  const metaParts = [];
  if (item.assignee) metaParts.push(`<li><strong>担当:</strong> ${escapeHtml(item.assignee)}</li>`);
  if (item.startDate) metaParts.push(`<li><strong>開始日:</strong> ${escapeHtml(item.startDate)}</li>`);
  if (item.completedDate) metaParts.push(`<li><strong>完了日:</strong> ${escapeHtml(item.completedDate)}</li>`);
  if (item.createdAt) metaParts.push(`<li><strong>作成日:</strong> ${escapeHtml(formatDateTimeJst(item.createdAt))}</li>`);
  if (item.updatedAt) metaParts.push(`<li><strong>更新日:</strong> ${escapeHtml(formatDateTimeJst(item.updatedAt))}</li>`);
  if (item.updatedBy) metaParts.push(`<li><strong>更新者:</strong> ${escapeHtml(item.updatedBy)}</li>`);
  const dueHtml = buildDueDateTrailHtml(item);
  if (dueHtml) metaParts.push(dueHtml);
  const infoHtml = metaParts.length > 0 ? `<div class="detail-section"><h4>情報</h4><ul class="detail-meta">${metaParts.join('')}</ul></div>` : '';
  return buildDetailCategoryHtml(item) + buildDetailTagsHtml(item) + infoHtml;
}

// 詳細モーダルのステータス表示（BT-457）。他画面と同じTODO/READY/DO/DONE表記にするため、日本語ラベルではなくstatusCodeから引く
const DETAIL_STATUS_LABEL = { todo: 'TODO', ready: 'READY', do: 'DO', done: 'DONE' };
function buildDetailStatusBadgeHtml(item) {
  const label = DETAIL_STATUS_LABEL[item.statusCode] || item.status || '-';
  return `<span class="detail-status">${escapeHtml(label)}</span>`;
}

// 詳細モーダルのカテゴリ欄（BT-457）。タグと同じ右カラムに置き、カテゴリなしなら出さない
function buildDetailCategoryHtml(item) {
  if (!item.category || item.category === '-') return '';
  return `<div class="detail-section detail-category-section"><h4>カテゴリ</h4>${categoryBadgeHtml(item.category)}</div>`;
}

// 詳細モーダルのタグ欄（BT-395）。自分のタグは×で外せ、「＋ タグ」で既存タグから選んで付け外しする。
// EPICは子由来のタグ(childTags)を薄く添える(読み取り専用)。付け外しの操作はtags.jsが委譲で処理する。
function buildDetailTagsHtml(item) {
  if (!item.id || item.id === '-') return '';
  const own = item.tags || [];
  const chips = own.map(t => tagLogic.buildTagChipHtml(t, { removable: true })).join('');
  const derived = (item.childTags || []).map(t => tagLogic.buildTagChipHtml(t, { dim: true })).join('');
  const derivedHtml = derived ? `<div class="detail-tag-derived"><span class="detail-tag-derived-label">子のタグ</span>${derived}</div>` : '';
  const projectFile = ((currentBoardData && currentBoardData.projectFileMap) || {})[item.project] || item.project || '';
  return `<div class="detail-section detail-tags-section"><h4>タグ</h4>
    <div class="detail-tag-list" data-task-id="${escapeHtml(item.id)}" data-workspace="${escapeHtml(projectFile)}" data-tag-ids="${own.map(t => t.id).join(',')}">
      ${chips}<button type="button" class="detail-tag-add-btn" title="既存のタグから選んで付け外しする">＋ タグ</button>
    </div>${derivedHtml}</div>`;
}

// 詳細モーダル本体を、左右2カラムの「固定部＋独立スクロール部」にまとめる（BT-261 → BM-137で再構成）
//   左: headerHtml(ID/タイトル/ボタン行)を固定し、descHtml(説明)＋footerHtml(EPICのミニボード)をスクロール
//   右: metaHtml(カテゴリ/タグ/情報)を固定し、sideScrollHtml(コメント・成果物)をスクロール
// 左右のスクロールは別々なので、説明を読みながらコメントや成果物を見られる。
// .modal-bodyは編集フォームも入る箱のため、その直下に1枚の .detail-split だけを置く。
function buildDetailSplitHtml({ headerHtml, metaHtml, descHtml, sideScrollHtml, footerHtml = '' }) {
  return `<div class="detail-split">`
    + `<div class="detail-split-left"><div class="detail-split-fixed">${headerHtml}</div><div class="detail-split-scroll">${descHtml}${footerHtml}</div></div>`
    + `<div class="detail-split-right"><div class="detail-split-fixed">${metaHtml}</div><div class="detail-split-scroll">${sideScrollHtml}</div></div>`
    + `</div>`;
}

// 詳細モーダルの左右2つのスクロール位置を保存・復元する（BM-078 → BM-137で2領域に対応）。
// WS再描画で.modal-body全体を作り直すと位置が先頭に戻るため、描画前に保存して描画後に戻す。
// 保存時にスクロール領域が無かった(編集フォームなど)場合は空配列で、何もしない。
function captureDetailScroll(body) {
  return Array.from(body.querySelectorAll('.detail-split-scroll'), (el) => el.scrollTop);
}

// rAF2段はwebview環境でのレイアウト確定遅延への保険(ボードと同じ対策)。
function restoreDetailScroll(body, tops) {
  if (!tops || tops.length === 0) return;
  body.querySelectorAll('.detail-split-scroll').forEach((el, i) => {
    const top = tops[i];
    if (!top) return; // 先頭のままなら戻す必要が無い
    el.scrollTop = top;
    const reapply = () => { if (el.scrollTop !== top) el.scrollTop = top; };
    requestAnimationFrame(() => { reapply(); requestAnimationFrame(reapply); });
  });
}

function buildArtifactsHtml(item) {
  if (!item.artifacts || item.artifacts.length === 0) return '';
  const workspaceMap = currentBoardData && currentBoardData.workspaceMap || {};
  const wsPath = workspaceMap[item.project] || '';
  const artifactItems = item.artifacts.map((art, idx) => {
    const escaped = escapeHtml(art);
    const fullPath = wsPath ? (wsPath + '/' + art.replace(/\\/g, '/')) : art;
    return `<li class="artifact-item"><code>${escaped}</code> <button class="artifact-copy-btn" data-path="${escapeHtml(fullPath)}" title="パスをコピー"><span class="material-icon icon-content-copy"></span></button></li>`;
  }).join('');
  const artifactList = `<ul class="detail-artifacts">${artifactItems}</ul>`;
  if (item.artifacts.length === 1) {
    return `<div class="detail-section detail-artifacts-block"><h4>成果物</h4>${artifactList}</div>`;
  }
  return `<details class="detail-section detail-artifacts-block detail-artifacts-collapsible"><summary>成果物（${item.artifacts.length}件）</summary>${artifactList}</details>`;
}

// ボタン群を1つのflex-wrapグループにまとめる（BT-166: ペア単位のflex:1をやめ、
// 内容幅で並べて折り返す方式に変更。ボタン数が変わっても不要に間延びしない）
// 引数のうち空文字列は無視する
function actionsRow(...btns) {
  const content = btns.filter(Boolean).join('');
  return content ? `<div class="detail-actions-row">${content}</div>` : '';
}

// ワークスペース導線ボタンのHTMLを生成する（BT-053）
// プロジェクトにworkspaceパスが設定済みなら「開く」、未設定なら「作る」を出し分ける
// BM-007: 「開く」はエディタ固定(VS Code)だったため、code/kiroの2ボタンに分ける
function buildWorkspaceActionHtml(item) {
  if (!item.id || item.id === '-') return '';
  const workspaceMap = currentBoardData && currentBoardData.workspaceMap || {};
  const wsPath = workspaceMap[item.project] || '';
  if (wsPath) {
    if (isCurrentUrlWorkspace(item)) {
      return `<button class="add-child-btn workspace-open-current" id="modal-open-workspace-btn" disabled title="現在のワークスペースを表示中です"><span class="material-icon icon-folder-open"></span> 現在のワークスペース</button>`;
    }
    return [
      `<button class="add-child-btn" id="modal-open-workspace-code-btn" data-editor="code"><span class="material-icon icon-folder-open"></span> codeで開く</button>`,
      `<button class="add-child-btn" id="modal-open-workspace-kiro-btn" data-editor="kiro"><span class="material-icon icon-folder-open"></span> KIROで開く</button>`,
    ].join('');
  }
  return `<button class="add-child-btn btn-add" id="modal-create-workspace-btn"><span class="material-icon icon-construction"></span> ワークスペースを作る</button>`;
}

function setupWorkspaceActionButtons(body, item) {
  const openBtns = body.querySelectorAll('#modal-open-workspace-code-btn, #modal-open-workspace-kiro-btn');
  openBtns.forEach(btn => {
    btn.addEventListener('click', () => openTaskWorkspace(item.id, btn, btn.dataset.editor));
  });
  const createBtn = body.querySelector('#modal-create-workspace-btn');
  if (createBtn) {
    createBtn.addEventListener('click', () => openSettingsPanel(NEW_WORKSPACE_VALUE)); // BT-360: 新規作成は設定パネルに一本化
  }
}

// ワークスペース移管ボタンのHTMLを生成する（BT-063）
function buildMoveActionHtml(item) {
  if (!item.id || item.id === '-') return '';
  return `<button class="add-child-btn" id="modal-move-btn"><span class="material-icon icon-local-shipping"></span> ワークスペースを移管</button>`;
}

function setupMoveActionButton(body, item, isChild) {
  const moveBtn = body.querySelector('#modal-move-btn');
  if (moveBtn) {
    moveBtn.addEventListener('click', () => openMovePicker([item.id], isChild));
  }
}

async function openTaskWorkspace(taskId, btnEl, editor) {
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '開いてるよ...';
  try {
    const resp = await fetch('/api/open-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, editor }),
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
  const copyIcon = '<span class="material-icon icon-content-copy"></span>';
  const successIcon = '<span class="material-icon icon-check"></span>';
  const errorIcon = '<span class="material-icon icon-close"></span>';
  container.querySelectorAll('.artifact-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pathText = btn.dataset.path;
      navigator.clipboard.writeText(pathText).then(() => {
        btn.innerHTML = successIcon;
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = copyIcon; btn.classList.remove('copied'); }, 1500);
      }).catch(() => {
        // fallback
        btn.innerHTML = errorIcon;
        setTimeout(() => { btn.innerHTML = copyIcon; }, 1500);
      });
    });
  });
}

// --- Search Dialog (BM-082: GET /api/searchへの非同期fetch方式。boardのcurrentBoardDataには依存しない) ---

// 入力停止後にfetchするデバウンス用タイマー。連打的な入力で毎キー毎にAPIを叩かないようにする。
let searchDebounceTimer = null;
const SEARCH_DEBOUNCE_MS = 250;
// 本文検索(「本文も検索する」チェックボックス)のON/OFF状態。モーダルを開き直しても保持する。
let searchIncludeBody = false;
// 現在進行中のfetchの世代カウンタ。入力が速いと複数のfetchが同時に飛ぶことがあるため、
// 最新の入力に対する結果だけを描画する(古い結果が後から返ってきて上書きする事故を防ぐ)。
let searchRequestSeq = 0;
// BT-459: 「他のワークスペースも検索」のON/OFF。選択中プロジェクトがある時だけ意味を持つ
// (All Projects選択中は常に全ワークスペース検索)。
let searchIncludeOtherWorkspaces = false;
// 右ペインのプレビュー取得の世代カウンタ(選択が素早く切り替わった時に古い結果で上書きしない)
let searchPreviewSeq = 0;

// 検索対象のワークスペースキー(projects[].file)。nullなら全ワークスペース横断。
function getSearchWorkspaceKey() {
  if (!currentFilter || searchIncludeOtherWorkspaces || !workspaceFilterMap) return null;
  const key = Object.keys(workspaceFilterMap).find(k => workspaceFilterMap[k] === currentFilter);
  return key || null;
}

function syncSearchWorkspaceToggle() {
  const el = document.getElementById('search-modal-include-other-ws');
  if (!el) return;
  const hasProject = !!currentFilter;
  el.disabled = !hasProject;
  el.checked = hasProject && searchIncludeOtherWorkspaces;
  const label = el.closest('label');
  if (label) label.classList.toggle('search-toggle-disabled', !hasProject);
  const span = label && label.querySelector('span');
  if (span) span.textContent = '他のワークスペースも検索';
  if (label) label.title = hasProject ? `現在のプロジェクト: ${currentFilter}（チェックで全ワークスペースへ広げる）` : 'All Projects選択中は全ワークスペースが対象です';
}

// BT-459: 一覧(左)とプレビュー(右)の境界のツマミ。ドラッグで左ペインの幅(%)を変え、ダブルクリックで既定に戻す。
// 幅はブラウザに記憶する(localStorageが使えない環境でも動作はする)。
const SEARCH_LIST_PCT_DEFAULT = 42;
const SEARCH_LIST_PCT_MIN = 20;
const SEARCH_LIST_PCT_MAX = 80;

function setupSearchSplitter(overlayEl) {
  const splitEl = overlayEl.querySelector('.search-modal-split');
  const listEl = overlayEl.querySelector('#search-result-list');
  const handleEl = overlayEl.querySelector('#search-splitter');
  const applyPct = (pct) => { listEl.style.flex = `0 0 ${pct}%`; };
  let saved = SEARCH_LIST_PCT_DEFAULT;
  try {
    const v = Number(localStorage.getItem('searchListWidthPct'));
    if (v >= SEARCH_LIST_PCT_MIN && v <= SEARCH_LIST_PCT_MAX) saved = v;
  } catch (e) { /* 記憶できなくても既定幅で動く */ }
  applyPct(saved);

  const save = (pct) => { try { localStorage.setItem('searchListWidthPct', String(pct)); } catch (e) { /* 無視 */ } };
  handleEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { handleEl.setPointerCapture(e.pointerId); } catch (err) { /* キャプチャできなくても移動は追従する */ }
    handleEl.classList.add('dragging');
    // flexの%はパディングを除いた内側の幅が基準なので、それに合わせて計算する
    const box = splitEl.getBoundingClientRect();
    const cs = getComputedStyle(splitEl);
    const innerLeft = box.left + parseFloat(cs.paddingLeft);
    const innerWidth = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const onMove = (ev) => {
      const pct = ((ev.clientX - innerLeft) / innerWidth) * 100;
      applyPct(Math.round(Math.max(SEARCH_LIST_PCT_MIN, Math.min(SEARCH_LIST_PCT_MAX, pct)) * 10) / 10);
    };
    const onUp = () => {
      handleEl.classList.remove('dragging');
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      save(Math.round((listEl.getBoundingClientRect().width / innerWidth) * 1000) / 10);
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
    handleEl.addEventListener('pointercancel', onUp);
  });
  handleEl.addEventListener('dblclick', () => {
    applyPct(SEARCH_LIST_PCT_DEFAULT);
    save(SEARCH_LIST_PCT_DEFAULT);
  });
}

function getOrCreateSearchModal() {
  let el = document.getElementById('search-modal-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'search-modal-overlay';
  // 詳細モーダル(1000)・子詳細(1100)より背面に置き、検索から開いたタスクが検索画面の前に出るようにする。
  // 検索画面は背景クリックでは閉じず、Escでのみ閉じる(BT-459)。
  el.className = 'modal-overlay search-overlay';
  el.innerHTML = `
    <div class="modal-content search-modal-content">
      <div class="search-modal-header">
        <h3>検索</h3>
        <button type="button" class="search-modal-close" id="search-modal-close" title="閉じる（Esc）">&times;</button>
      </div>
      <div class="search-modal-toolbar">
      <div class="search-modal-inputrow">
        <input type="text" class="search-modal-input" id="search-modal-input" placeholder="タイトル・ID・担当で検索">
        <span class="search-hit-count" id="search-hit-count"></span>
      </div>
      <div class="search-modal-options">
        <label class="search-modal-body-toggle"><input type="checkbox" id="search-modal-include-body"><span>本文も検索する（3文字以上）</span></label>
        <label class="search-modal-body-toggle"><input type="checkbox" id="search-modal-include-other-ws"><span>他のワークスペースも検索</span></label>
        <label class="search-modal-body-toggle"><input type="checkbox" id="search-modal-group-category" checked><span>カテゴリでグループ化</span></label>
      </div>
      </div>
      <div class="search-modal-split">
        <div class="search-result-list" id="search-result-list"></div>
        <div class="search-splitter" id="search-splitter" role="separator" aria-orientation="vertical" title="ドラッグで左右の幅を調整（ダブルクリックで元に戻す）"></div>
        <div class="search-preview-pane" id="search-preview-pane"><div class="search-result-empty">タスクを選ぶと内容を表示するよ</div></div>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector('#search-modal-close').addEventListener('click', closeSearchModal);
  setupSearchSplitter(el);
  const groupCatEl = el.querySelector('#search-modal-group-category');
  groupCatEl.checked = searchGroupByCategory;
  groupCatEl.addEventListener('change', (e) => {
    searchGroupByCategory = e.target.checked;
    if (searchLastResults.length) renderSearchResults(searchLastResults, { query: searchLastQuery, bodySearchSkipped: false });
  });
  el.querySelector('#search-modal-include-other-ws').addEventListener('change', (e) => {
    searchIncludeOtherWorkspaces = e.target.checked;
    scheduleSearchFetch(el.querySelector('#search-modal-input').value, { immediate: true });
  });
  closeOnEscape(el, 'modal-visible', closeSearchModal);
  const inputEl = el.querySelector('#search-modal-input');
  inputEl.addEventListener('input', (e) => {
    scheduleSearchFetch(e.target.value);
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
  const includeBodyEl = el.querySelector('#search-modal-include-body');
  includeBodyEl.checked = searchIncludeBody;
  includeBodyEl.addEventListener('change', (e) => {
    searchIncludeBody = e.target.checked;
    scheduleSearchFetch(inputEl.value, { immediate: true });
  });
  return el;
}

function closeSearchModal() {
  const el = document.getElementById('search-modal-overlay');
  if (el) el.classList.remove('modal-visible');
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
}

function openSearchModal(initialQuery = '') {
  const el = getOrCreateSearchModal();
  const input = el.querySelector('#search-modal-input');
  input.value = initialQuery;
  syncSearchWorkspaceToggle();
  el.classList.add('modal-visible');
  input.focus();
  scheduleSearchFetch(initialQuery, { immediate: true });
}

// 入力のたびに即座にfetchせず、SEARCH_DEBOUNCE_MS待ってから実行する（immediate指定時は即実行、
// チェックボックス変更や初期表示など「待たずに結果を見せたい」操作用）。
function scheduleSearchFetch(rawQuery, { immediate = false } = {}) {
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  if (immediate) {
    fetchAndRenderSearchResults(rawQuery);
  } else {
    searchDebounceTimer = setTimeout(() => fetchAndRenderSearchResults(rawQuery), SEARCH_DEBOUNCE_MS);
  }
}

// 現在の検索結果に対する表示行（ワークスペース見出し／選択可能なタスク行）を平坦なリストで持つ。
// キーボードの上下移動・Enterでの選択で使う。
let searchEntries = [];
let searchSelectableIndices = [];
let searchSelectedPos = 0;

// サーバー検索結果(フラットなリスト、親Epic情報はparentId/parentTitle/parentStatusで付与済み)を
// ワークスペース(project) → Epic → 子タスク の階層にグルーピングする
// （BT-032由来: 子タスクだけがマッチしても親Epic行を一緒に出す設計を維持）。
function groupSearchResults(results) {
  const projectMap = new Map(); // project名 -> { epics: Map(epicId -> {epic, children:[]}), singles: [] }
  for (const r of results) {
    const proj = r.project || '-';
    if (!projectMap.has(proj)) projectMap.set(proj, { epics: new Map(), singles: [] });
    const projEntry = projectMap.get(proj);
    if (r.parentId) {
      // 子タスクのマッチ: 親Epic行が無ければダミーで作っておき、後からchildrenだけ積む
      if (!projEntry.epics.has(r.parentId)) {
        projEntry.epics.set(r.parentId, {
          epic: { id: r.parentId, title: r.parentTitle, status: r.parentStatus, project: proj, category: r.parentCategory },
          children: [],
          epicMatchedDirectly: false,
        });
      }
      projEntry.epics.get(r.parentId).children.push(r);
    } else if (r.isEpic) {
      if (!projEntry.epics.has(r.id)) {
        projEntry.epics.set(r.id, { epic: r, children: [], epicMatchedDirectly: true });
      } else {
        // 子マッチで先にダミーが作られていた場合、本来のEpic行の情報(status等)で上書きする
        const entry = projEntry.epics.get(r.id);
        entry.epic = r;
        entry.epicMatchedDirectly = true;
      }
    } else {
      projEntry.singles.push(r);
    }
  }
  return projectMap;
}

// BT-459: 「カテゴリでグループ化」(ワークスペース＞カテゴリ＞EPIC＞子タスク)。マスタ順→マスタ外→カテゴリなし。
let searchGroupByCategory = true;
let searchCategoryOrder = []; // カテゴリマスタの並び順(名前の配列)
let searchLastResults = []; // チェックボックス切替時に再取得せず描画し直すため

// 旧データの'-'はカテゴリなし('')として扱う(週報と同じ)
function searchCategoryName(c) {
  return !c || c === '-' ? '' : c;
}

function buildFilteredEntries(results) {
  const tree = groupSearchResults(results);
  const entries = [];
  const baseIndent = searchGroupByCategory ? 2 : 1;
  for (const [projName, projEntry] of tree) {
    entries.push({ type: 'header', level: 'ws', label: projName });
    // ブロック = EPIC(＋ヒットした子)または単発1件。罫線はブロックの先頭行に付ける(子の間には付けない)
    const blocks = [];
    // isHit: 検索にヒットした行か。子だけがヒットして文脈として出している親EPICは false（薄く表示する）
    for (const { epic, children, epicMatchedDirectly } of projEntry.epics.values()) {
      const rows = [{ type: 'task', item: epic, isChild: false, isEpic: true, indent: baseIndent, isHit: !!epicMatchedDirectly, blockStart: true, hasChildren: children.length > 0 }];
      children.forEach((c, i) => rows.push({
        type: 'task', item: c, isChild: true, indent: baseIndent + 1, isHit: true, treeMark: i === children.length - 1 ? '└' : '├',
      }));
      blocks.push({ category: searchCategoryName(epic.category), rows });
    }
    for (const s of projEntry.singles) {
      blocks.push({ category: searchCategoryName(s.category), rows: [{ type: 'task', item: s, isChild: false, indent: baseIndent, isHit: true, blockStart: true }] });
    }
    if (!searchGroupByCategory) {
      for (const b of blocks) entries.push(...b.rows);
      continue;
    }
    const names = [...new Set(blocks.map(b => b.category))];
    const rank = (name) => {
      if (name === '') return 2e9; // カテゴリなしは最後
      const i = searchCategoryOrder.indexOf(name);
      return i < 0 ? 1e9 : i; // マスタ外はマスタ順の後
    };
    names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ja'));
    for (const name of names) {
      entries.push({ type: 'header', level: 'cat', label: name || 'カテゴリなし' });
      for (const b of blocks) if (b.category === name) entries.push(...b.rows);
    }
  }
  return entries;
}

async function fetchAndRenderSearchResults(rawQuery) {
  const query = (rawQuery || '').trim();
  const listEl = document.getElementById('search-result-list');
  if (!listEl) return;

  if (!query) {
    searchEntries = [];
    searchSelectableIndices = [];
    searchSelectedPos = 0;
    listEl.innerHTML = `<div class="search-result-empty">キーワードを入力してね</div>`;
    setSearchHitCount(null);
    renderSearchPreview(null);
    return;
  }

  const seq = ++searchRequestSeq;
  listEl.innerHTML = `<div class="search-result-empty">検索中...</div>`;
  setSearchHitCount(null);

  let data;
  try {
    const params = new URLSearchParams({ q: query, includeBody: String(searchIncludeBody) });
    const workspaceKey = getSearchWorkspaceKey();
    if (workspaceKey) params.set('workspace', workspaceKey);
    const [res, catRes] = await Promise.all([
      fetch(`/api/search?${params.toString()}`),
      fetch('/api/categories').catch(() => null),
    ]);
    data = await res.json();
    try {
      if (catRes && catRes.ok) searchCategoryOrder = ((await catRes.json()).categories || []).map(c => c.name);
    } catch (e) { /* 並び順が取れなくても検索結果は出す */ }
  } catch (e) {
    if (seq !== searchRequestSeq) return; // より新しい入力に対する結果が既に処理されている
    listEl.innerHTML = `<div class="search-result-empty">検索に失敗したよ。もう一度試してね</div>`;
    return;
  }
  if (seq !== searchRequestSeq) return; // 入力中に先行fetchが遅れて返ってきた場合は無視する

  renderSearchResults(data.results || [], { bodySearchSkipped: !!data.bodySearchSkipped, query });
}

// 検索ヒット件数(オプション行の右端)。nullで非表示。
function setSearchHitCount(count) {
  const el = document.getElementById('search-hit-count');
  if (el) el.textContent = count === null ? '' : `${count}件ヒット`;
}

// 検索語をテキスト内で大文字小文字を区別せずハイライトしたHTMLを返す(全体をエスケープ済み)。
function highlightQueryHtml(text, query) {
  const s = String(text == null ? '' : text);
  if (!query) return escapeHtml(s);
  const lower = s.toLowerCase();
  const q = query.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) { out += escapeHtml(s.slice(i)); break; }
    out += `${escapeHtml(s.slice(i, j))}<mark class="search-hit">${escapeHtml(s.slice(j, j + q.length))}</mark>`;
    i = j + q.length;
  }
  return out;
}

// 描画済みのHTML内のテキストノードだけを対象に検索語をハイライトする(タグ・リンク先は壊さない)。
function highlightQueryInElement(root, query) {
  if (!root || !query) return;
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement && node.parentElement.closest('mark, script, style')) continue;
    const text = node.nodeValue;
    if (!text.toLowerCase().includes(q)) continue;
    const holder = document.createElement('span');
    holder.innerHTML = highlightQueryHtml(text, query);
    node.replaceWith(...holder.childNodes);
  }
}

// 現在表示中の検索結果に対する検索語(右ペインのハイライトで使う)
let searchLastQuery = '';

function renderSearchResults(results, { bodySearchSkipped = false, query = '' } = {}) {
  const listEl = document.getElementById('search-result-list');
  if (!listEl) return;
  searchLastQuery = query;
  searchLastResults = results;
  setSearchHitCount(results.length);

  searchEntries = buildFilteredEntries(results);
  searchSelectableIndices = [];
  searchEntries.forEach((entry, idx) => { if (entry.type === 'task') searchSelectableIndices.push(idx); });
  searchSelectedPos = 0;

  const skipNoticeHtml = (searchIncludeBody && bodySearchSkipped)
    ? `<div class="search-result-notice">本文検索は3文字以上のキーワードで有効になるよ（「${escapeHtml(query)}」は${query.length}文字）</div>`
    : '';

  if (searchSelectableIndices.length === 0) {
    listEl.innerHTML = `${skipNoticeHtml}<div class="search-result-empty">見つからなかったよ</div>`;
    setSearchHitCount(0);
    renderSearchPreview(null);
    return;
  }

  const rowsHtml = searchEntries.map((entry, idx) => {
    if (entry.type === 'header') {
      return `<div class="search-group-header search-group-${entry.level}">${escapeHtml(entry.label)}</div>`;
    }
    // 子タスクのツリー線はCSS(疑似要素)で描く。├=続きあり / └=最後の子
    const treeClass = entry.treeMark ? (entry.treeMark === '└' ? ' search-tree-child search-tree-last' : ' search-tree-child') : '';
    const epicIcon = entry.isEpic ? '<span class="epic-icon" title="Epic"><span class="material-icon icon-stacks"></span></span>' : '';
    const snippetHtml = entry.item.snippet
      ? `<div class="search-result-snippet${entry.isEpic ? ' search-snippet-epic' : ''}">${escapeSearchSnippet(entry.item.snippet)}</div>`
      : '';
    return `<div class="search-result-item search-indent-${entry.indent}${treeClass}${entry.hasChildren ? ' search-has-children' : ''}${entry.isHit ? '' : ' search-result-context'}${entry.blockStart ? (entry.isEpic ? ' search-block-start search-block-epic' : ' search-block-start') : ''}" data-entry-idx="${idx}"${entry.isHit ? '' : ' title="検索にはヒットしていない親タスク（文脈として表示）"'}>
      <div class="search-result-row">
        ${epicIcon}<span class="search-result-id">${highlightQueryHtml(entry.item.id, query)}</span>
        <span class="search-result-title">${highlightQueryHtml(entry.item.title, query)}</span>
        <span class="search-result-status">${escapeHtml(entry.item.status || '-')}</span>
      </div>
      ${snippetHtml}
    </div>`;
  }).join('');
  listEl.innerHTML = skipNoticeHtml + rowsHtml;

  listEl.querySelectorAll('.search-result-item').forEach(itemEl => {
    const entryIdx = Number(itemEl.dataset.entryIdx);
    // BT-459: クリック/↑↓は右ペインに内容を出すだけ。タスクを開くのはダブルクリック・Enter・「タスクを開く」ボタン。
    itemEl.addEventListener('click', () => {
      const pos = searchSelectableIndices.indexOf(entryIdx);
      if (pos < 0) return;
      searchSelectedPos = pos;
      updateSearchHighlight();
    });
    itemEl.addEventListener('dblclick', () => {
      const pos = searchSelectableIndices.indexOf(entryIdx);
      if (pos < 0) return;
      searchSelectedPos = pos;
      activateSearchSelection();
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
  const entry = searchEntries[entryIdx];
  renderSearchPreview(entry || null);
}


// 右ペイン: 選択中の検索結果の内容を/api/task/:idから取得して表示する。
async function renderSearchPreview(entry) {
  const paneEl = document.getElementById('search-preview-pane');
  if (!paneEl) return;
  const seq = ++searchPreviewSeq;
  if (!entry) {
    paneEl.innerHTML = `<div class="search-result-empty">タスクを選ぶと内容を表示するよ</div>`;
    return;
  }
  paneEl.innerHTML = `<div class="search-result-empty">読み込み中...</div>`;
  let full = null;
  try {
    full = await fetchTaskDetail(entry.item.id);
  } catch (e) {
    full = null;
  }
  if (seq !== searchPreviewSeq) return; // 選択がさらに切り替わっていた
  if (!full) {
    paneEl.innerHTML = `<div class="search-result-empty">内容を取得できなかったよ</div>`;
    return;
  }
  const desc = full.description || '';
  const descHtml = desc
    ? renderDescriptionMarkdown(desc, { plainClass: 'search-preview-plain' })
    : '<span class="search-preview-nodesc">説明はありません</span>';
  const tags = (full.tags || []).map(t => `<span class="search-preview-tag">${escapeHtml(t.name)}</span>`).join('');
  const dates = [full.startDate ? `開始 ${escapeHtml(full.startDate)}` : '', full.dueDate ? `期日 ${escapeHtml(full.dueDate)}` : ''].filter(Boolean).join(' / ');
  const parentLine = entry.item.parentId
    ? `<div class="search-preview-meta">親: ${escapeHtml(entry.item.parentId)} ${escapeHtml(entry.item.parentTitle || '')}</div>`
    : '';
  paneEl.innerHTML = `
    <div class="search-preview-fixed">
    <div class="search-preview-head">
      <div class="search-preview-title"><span class="search-result-id">${highlightQueryHtml(full.id, searchLastQuery)}</span> ${highlightQueryHtml(full.title, searchLastQuery)}</div>
      <div class="search-preview-actions">
        <button class="search-preview-open" id="search-preview-goto" title="ボード上のタスクの場所へ移動して開く">場所へ行く</button>
        <button class="search-preview-open" id="search-preview-open">タスクを開く</button>
      </div>
    </div>
    <div class="search-preview-meta">${escapeHtml(entry.item.project || '')} ・ ${escapeHtml(full.status || '-')}${full.assignee ? ` ・ 担当: ${escapeHtml(full.assignee)}` : ''}${dates ? ` ・ ${dates}` : ''}</div>
    ${parentLine}
    ${tags ? `<div class="search-preview-tags">${tags}</div>` : ''}
    </div>
    <div class="search-preview-desc">${descHtml}</div>
  `;
  highlightQueryInElement(paneEl.querySelector('.search-preview-desc'), searchLastQuery);
  paneEl.querySelector('#search-preview-open').addEventListener('click', activateSearchSelection);
  paneEl.querySelector('#search-preview-goto').addEventListener('click', goToSearchSelectionOnBoard);
}

// BT-459: 検索画面を閉じ、ボード上のタスクの場所へスクロールして開く。
// 子タスクは親EPICを開いて子をハイライト(履歴・URL起動と同じ openEpicWithHighlight)。
async function goToSearchSelectionOnBoard() {
  const entryIdx = searchSelectableIndices[searchSelectedPos];
  const entry = entryIdx === undefined ? null : searchEntries[entryIdx];
  if (!entry) return;
  const item = entry.item;
  const projectName = item.project;
  const taskId = entry.isChild ? item.parentId : item.id;
  closeSearchModal();
  // 選択中プロジェクトが別なら、そのプロジェクトへ切り替える(All Projectsはそのまま)
  if (currentFilter && projectName && currentFilter !== projectName) applyMainFilter(projectName);
  const boardItem = findItemById(taskId);
  if (!boardItem) {
    // ボードの再送に乗っていない場合の救済: 詳細だけ開く
    const resolved = await resolveFullItemForDetail(item);
    if (!resolved) return;
    if (entry.isChild) openChildModal(resolved.item, resolved.parentEpic);
    else openCardDetail(resolved.item);
    return;
  }
  const cardEl = boardEl.querySelector(`.card[data-task-id="${CSS.escape(taskId)}"]`);
  if (cardEl) {
    cardEl.scrollIntoView({ block: 'center' });
    cardEl.classList.add('card-highlight-pulse');
    setTimeout(() => cardEl.classList.remove('card-highlight-pulse'), 1300);
  }
  if (entry.isChild) openEpicWithHighlight(boardItem, [item.id]);
  else openCardDetail(boardItem);
}

// サーバーのsnippet()が'['/']'でヒット箇所を囲んで返す(db/tasks-repo.js searchByBody)。
// まずHTMLエスケープしてXSSを防ぎ、その後で[ ]を<mark>タグに変換する(エスケープ後の文字列に対して
// 変換するため、本文中に偶然'['や']'が含まれていてもエスケープ処理自体には影響しない)。
function escapeSearchSnippet(raw) {
  const escaped = String(raw).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return escaped.replace(/\[/g, '<mark>').replace(/\]/g, '</mark>');
}

function moveSearchSelection(delta) {
  if (searchSelectableIndices.length === 0) return;
  searchSelectedPos = Math.max(0, Math.min(searchSelectableIndices.length - 1, searchSelectedPos + delta));
  updateSearchHighlight();
}

// BM-082: 検索APIのレスポンスは軽量な形状(description等を含まない)で、boardのcurrentBoardDataも
// BM-065によりdescriptionを持たない軽量データになっている。そのため「currentBoardDataにあれば使う」
// という節約はせず、常に/api/task/:idから完全なデータ(description含む)を個別取得する
// (BM-083で詳細モーダル側の非同期化が本格対応されるまでの間、検索結果クリックで
// descriptionが空のモーダルが開かないようにするための橋渡し)。
// 【注意】buildTaskDetail/buildBoardFromDbが返すitem自体にはparentIdフィールドが無い
// (子はchildren配列の中にネストされる形のみで、子単体にparent情報が付与されない設計のため)。
// 親Epicの解決には、検索結果(lightItem)が持つparentIdを使う必要がある。
async function resolveFullItemForDetail(lightItem) {
  const full = await fetchTaskDetail(lightItem.id);
  if (!full) return null;
  const parentEpic = lightItem.parentId ? await fetchTaskDetail(lightItem.parentId) : null;
  return { item: full, parentEpic };
}

async function fetchTaskDetail(id) {
  const res = await fetch(`/api/task/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

// BM-084: gantt.js(別ファイル、グローバルスコープ経由で連携)がホバーツールチップのdescription
// 非同期取得に使うアクセサ。letで宣言したlastRenderedFullItemByIdはwindowのプロパティには
// ならない(var/functionと違うES6の仕様)ため、関数経由で明示的に公開する。
function getCachedFullTaskItem(id) {
  return lastRenderedFullItemById.get(id) || null;
}

async function activateSearchSelection() {
  const entryIdx = searchSelectableIndices[searchSelectedPos];
  if (entryIdx === undefined) return;
  const entry = searchEntries[entryIdx];
  if (!entry) return;
  // BT-459: 検索画面は閉じずに残す(詳細モーダルは検索画面より前面に開く)
  const resolved = await resolveFullItemForDetail(entry.item);
  if (!resolved) return;
  if (entry.isChild) openChildModal(resolved.item, resolved.parentEpic);
  else openCardDetail(resolved.item);
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

// --- 期日クイック選択・カレンダー (BT-354) ---
// 日付計算はすべてUTC基準のDate.UTCで行い、ローカルTZに依存させない（BT-343の教訓）。
function addDaysYMD(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function getDueQuickOptions() {
  const today = getTodayJST();
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日
  // 週は月曜始まり（週次計画ビューと同じ）。今週/来週は期限として金曜に置く
  const thisFriday = addDaysYMD(today, 4 - ((dow + 6) % 7));
  return [
    { label: '今日', date: today },
    { label: '明日', date: addDaysYMD(today, 1) },
    { label: '今週', date: thisFriday > today ? thisFriday : today }, // 土日は過去日にならないよう今日
    { label: '来週', date: addDaysYMD(thisFriday, 7) },
  ];
}

function renderDueQuickButtonsHtml(extraClass = '') {
  const btns = getDueQuickOptions()
    .map(o => `<button type="button" class="due-quick-btn${extraClass}" data-date="${o.date}" title="${o.date}">${o.label}</button>`)
    .join('');
  // BT-432: 狭い右カラムでも1段に収まるよう、クリアは「C」1文字にする（意味はtitle/aria-labelで補う）
  return `${btns}<button type="button" class="due-quick-btn${extraClass} due-quick-clear" data-date="" title="クリア" aria-label="クリア">C</button>`;
}

let dueDatePickerEl = null;
let dueDatePickerCleanup = null;

function closeDueDatePicker() {
  if (dueDatePickerCleanup) dueDatePickerCleanup();
  dueDatePickerCleanup = null;
  if (dueDatePickerEl) dueDatePickerEl.remove();
  dueDatePickerEl = null;
}

// anchor直下に月グリッドのカレンダーを出す。日付クリック/クイック選択/クリアで onPick(ymd|'') を呼んで閉じる。
function openDueDatePicker(anchor, currentDue, onPick) {
  closeDueDatePicker();
  const pad = (n) => String(n).padStart(2, '0');
  const today = getTodayJST();
  let [viewY, viewM] = (currentDue || today).split('-').map(Number);

  const el = document.createElement('div');
  el.className = 'due-picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '期日を設定');

  const render = () => {
    const startOffset = (new Date(Date.UTC(viewY, viewM - 1, 1)).getUTCDay() + 6) % 7; // 月曜始まり
    const daysInMonth = new Date(Date.UTC(viewY, viewM, 0)).getUTCDate();
    let cells = '<span class="due-picker-blank"></span>'.repeat(startOffset);
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = `${viewY}-${pad(viewM)}-${pad(d)}`;
      const weekday = (startOffset + d - 1) % 7; // 0=月 … 5=土 6=日
      const holidayName = globalThis.jpHolidays ? globalThis.jpHolidays.getHolidayName(ymd) : null;
      const cls = 'due-picker-day'
        + (weekday === 5 ? ' is-sat' : '')
        + (weekday === 6 || holidayName ? ' is-sun' : '') // 日曜と祝日は同色
        + (holidayName ? ' is-holiday' : '')
        + (ymd === today ? ' is-today' : '')
        + (ymd === currentDue ? ' is-selected' : '');
      const title = holidayName ? ` title="${escapeHtml(holidayName)}"` : '';
      cells += `<button type="button" class="${cls}" data-date="${ymd}"${title}>${d}</button>`;
    }
    el.innerHTML = `
      <div class="due-picker-quick">${renderDueQuickButtonsHtml()}</div>
      <div class="due-picker-head">
        <button type="button" class="due-picker-nav" data-nav="-1" title="前の月">◀</button>
        <span class="due-picker-month">${viewY}年${viewM}月</span>
        <button type="button" class="due-picker-nav" data-nav="1" title="次の月">▶</button>
      </div>
      <div class="due-picker-grid">
        ${['月', '火', '水', '木', '金', '土', '日'].map((w, i) => `<span class="due-picker-wd${i === 5 ? ' is-sat' : i === 6 ? ' is-sun' : ''}">${w}</span>`).join('')}
        ${cells}
      </div>`;
  };

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      viewM += Number(nav.dataset.nav);
      if (viewM < 1) { viewM = 12; viewY--; } else if (viewM > 12) { viewM = 1; viewY++; }
      render();
      return;
    }
    const pick = e.target.closest('[data-date]');
    if (pick) {
      closeDueDatePicker();
      onPick(pick.dataset.date);
    }
  });
  el.addEventListener('contextmenu', (e) => e.stopPropagation());

  render();
  document.body.appendChild(el);
  dueDatePickerEl = el;

  const margin = 8;
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - el.offsetWidth - margin);
  const top = rect.bottom + 4 + el.offsetHeight > window.innerHeight - margin
    ? rect.top - el.offsetHeight - 4
    : rect.bottom + 4;
  el.style.left = `${Math.max(margin, left)}px`;
  el.style.top = `${Math.max(margin, top)}px`;

  const onPointerDown = (e) => { if (!el.contains(e.target)) closeDueDatePicker(); };
  // Escはカレンダーが先に消費する（背後のモーダルまで一緒に閉じないように）
  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    closeDueDatePicker();
  };
  const onScroll = (e) => { if (!el.contains(e.target)) closeDueDatePicker(); };
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', closeDueDatePicker);
  window.addEventListener('scroll', onScroll, true);
  dueDatePickerCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', closeDueDatePicker);
    window.removeEventListener('scroll', onScroll, true);
  };
}

// 日付入力欄（input.date-field）は読み取り専用のテキスト欄で、クリックすると共通カレンダーを開く。
// ブラウザ標準のinput[type=date]は祝日・曜日色を出せないため置き換えている。
// 動的に描画される入力欄でも効くよう、documentでの委譲で1回だけ配線する。値は 'YYYY-MM-DD' または ''。
function renderDateFieldHtml(id, value, { title = '' } = {}) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<input type="text" class="date-field" id="${id}" readonly autocomplete="off" placeholder="日付を選択" value="${escapeHtml(value || '')}"${titleAttr}>`;
}

document.addEventListener('click', (e) => {
  const field = e.target.closest && e.target.closest('input.date-field');
  if (!field) return;
  openDueDatePicker(field, field.value, (date) => {
    field.value = date;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
});

// created_at/updated_at(UTC ISO文字列)をJSTの "YYYY-MM-DD HH:mm" 表示に変換する（BT-261）
function formatDateTimeJst(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

// BT-462: 説明欄をMarkdownで描画する共通レンダラ(検索ペイン・詳細モーダル・TIP・入力欄のプレビューで共用)。
// 生HTML・画像・http(s)以外のリンクは無効化する。markedが読み込めない時は従来どおりエスケープ表示にフォールバックする。
let descriptionMarked = null;
function getDescriptionMarked() {
  if (descriptionMarked) return descriptionMarked;
  if (typeof marked === 'undefined') return null;
  descriptionMarked = new marked.Marked({
    gfm: true,
    breaks: true,
    renderer: {
      html(token) { return escapeHtml(token.text); },
      image(token) { return escapeHtml(token.text || ''); },
      link(token) {
        const inner = this.parser.parseInline(token.tokens);
        return /^https?:\/\//i.test(token.href) ? `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
      },
    },
  });
  return descriptionMarked;
}

function renderDescriptionMarkdown(desc, { plainClass = 'description-plain' } = {}) {
  if (!desc) return '';
  const md = getDescriptionMarked();
  return md ? md.parse(desc) : `<pre class="${plainClass}">${escapeHtml(desc)}</pre>`;
}

// BT-462: 説明欄のMarkdown表示倍率(入力欄のプレビュー・詳細モーダル・右クリックTIPで共通)。
// 100%＝入力欄と同じ文字サイズ。実際の倍率はCSS変数 --desc-zoom(:root)に持ち、各表示がそれを掛けて文字サイズを決める。
// 外部(BT-464の全体設定など)から変える時は setDescriptionZoom(倍率) / getDescriptionZoom() を呼ぶ。
// 変更時は document に 'description-zoom-change' イベント(detail.zoom)が飛ぶ。倍率はlocalStorageに保存する
// (localStorageが使えない環境では既定値のまま)。
const DESC_PREVIEW_ZOOM_KEY = 'descriptionPreviewZoom';
const DESC_PREVIEW_ZOOM_MIN = 0.6;
const DESC_PREVIEW_ZOOM_MAX = 1.6;
const DESC_PREVIEW_ZOOM_STEP = 0.1;
function clampDescriptionZoom(z) {
  return Math.min(DESC_PREVIEW_ZOOM_MAX, Math.max(DESC_PREVIEW_ZOOM_MIN, Math.round(z * 100) / 100));
}
let descPreviewZoom = (() => {
  try {
    const v = parseFloat(localStorage.getItem(DESC_PREVIEW_ZOOM_KEY));
    return Number.isFinite(v) ? clampDescriptionZoom(v) : 1;
  } catch (e) { return 1; }
})();

function getDescriptionZoom() { return descPreviewZoom; }

function setDescriptionZoom(z, { persist = true } = {}) {
  if (!Number.isFinite(z)) return descPreviewZoom;
  descPreviewZoom = clampDescriptionZoom(z);
  document.documentElement.style.setProperty('--desc-zoom', String(descPreviewZoom));
  if (persist) {
    try { localStorage.setItem(DESC_PREVIEW_ZOOM_KEY, String(descPreviewZoom)); } catch (e) { /* 保存できなくても動作に影響しない */ }
  }
  document.querySelectorAll('.desc-preview-zoom-label').forEach((el) => { el.textContent = `${Math.round(descPreviewZoom * 100)}%`; });
  const globalDescriptionZoom = document.getElementById('settings-description-zoom');
  if (globalDescriptionZoom) globalDescriptionZoom.value = String(descPreviewZoom);
  // 折りたたみ(2行)の説明欄は、倍率で「もっと見る」が要るかどうかが変わる
  document.querySelectorAll('.description-collapsible').forEach((w) => { if (w._refreshToggle) w._refreshToggle(); });
  document.dispatchEvent(new CustomEvent('description-zoom-change', { detail: { zoom: descPreviewZoom } }));
  return descPreviewZoom;
}

// ＋/－ボタンとラベルの部品(入力欄のツールバーと詳細モーダルの説明見出しで共用)
function descriptionZoomControlHtml(extraClass = '', hidden = false) {
  return `<span class="desc-preview-zoom ${extraClass}"${hidden ? ' hidden' : ''}>
      <button type="button" class="desc-preview-zoom-btn" data-zoom="-1" title="縮小(Ctrl＋ホイール)" aria-label="縮小">−</button>
      <span class="desc-preview-zoom-label">${Math.round(descPreviewZoom * 100)}%</span>
      <button type="button" class="desc-preview-zoom-btn" data-zoom="1" title="拡大(Ctrl＋ホイール)" aria-label="拡大">＋</button>
    </span>`;
}

setDescriptionZoom(descPreviewZoom, { persist: false }); // 起動時にCSS変数へ反映する
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.desc-preview-zoom-btn');
  if (btn) setDescriptionZoom(descPreviewZoom + Number(btn.dataset.zoom) * DESC_PREVIEW_ZOOM_STEP);
});
// Ctrl＋ホイール: ブラウザ全体のズームを奪って、説明欄(表示・プレビュー)の中だけ変える
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !e.target.closest || !e.target.closest('.description-md, .desc-preview-pane')) return;
  e.preventDefault();
  setDescriptionZoom(descPreviewZoom + (e.deltaY < 0 ? 1 : -1) * DESC_PREVIEW_ZOOM_STEP);
}, { passive: false });

// BT-462: 説明欄のtextareaに「編集/プレビュー」切替を被せる。
// textarea自体(id・値・イベント)はそのまま残すので、保存や変更検知は従来のコードがそのまま動く。
function wireDescriptionPreview(textarea) {
  if (!textarea || textarea.dataset.previewWired) return;
  textarea.dataset.previewWired = '1';
  const bar = document.createElement('div');
  bar.className = 'desc-preview-bar';
  bar.innerHTML = `
    <div class="desc-preview-tabs" role="tablist">
      <button type="button" class="desc-preview-tab active" data-mode="edit" role="tab" aria-selected="true">編集</button>
      <button type="button" class="desc-preview-tab" data-mode="preview" role="tab" aria-selected="false">プレビュー</button>
    </div>
    ${descriptionZoomControlHtml('', true)}`;
  const pane = document.createElement('div');
  pane.className = 'desc-preview-pane';
  pane.hidden = true;
  textarea.before(bar);
  textarea.after(pane);

  const zoomWrap = bar.querySelector('.desc-preview-zoom');
  const setMode = (mode) => {
    const preview = mode === 'preview';
    if (preview) {
      pane.innerHTML = textarea.value.trim()
        ? renderDescriptionMarkdown(textarea.value)
        : '<span class="desc-preview-empty">プレビューする内容がないよ</span>';
      // 入力欄(非表示にする前)と同じ高さに固定する。拡大縮小で中身の量が変わっても、
      // ダイアログの大きさが変わらず、はみ出す分はプレビュー内でスクロールする
      pane.style.height = `${textarea.offsetHeight}px`;
    }
    textarea.hidden = preview;
    pane.hidden = !preview;
    zoomWrap.hidden = !preview;
    bar.querySelectorAll('.desc-preview-tab').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (!preview) textarea.focus();
  };
  bar.querySelectorAll('.desc-preview-tab').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  // フォームを開き直して値が差し替わった時などに、編集モードへ戻す
  textarea.resetDescriptionPreview = () => setMode('edit');
}

// 説明欄のHTML生成（BT-080: 長い説明は2行に折りたたみ、▼で展開できるようにする）
// BM-083: descriptionキー自体が無いitem(board用の軽量データ、取得中)は「読み込み中...」を出す。
// descriptionキーがあって空文字(buildTaskDetail経由で本当に説明が無いタスク)は従来通り非表示にする。
function buildDescriptionSectionHtml(item) {
  const hasKey = item && Object.prototype.hasOwnProperty.call(item, 'description');
  if (!hasKey) {
    return `<div class="detail-section detail-description-section"><div class="detail-section-heading"><h4>説明</h4></div><p class="description-loading">読み込み中...</p></div>`;
  }
  const description = item.description;
  if (!description) return '';
  // BT-466: 単発・子タスクはモーダル全体のスクロールに任せて常時展開する。
  // 親子付け替え後も item の最新の子件数から毎回判定するため、次の再描画でEPIC表示へ切り替わる。
  const isEpic = (item.childrenTotal || 0) > 0 || (item.children && item.children.length > 0);
  if (!isEpic) {
    return `<div class="detail-section detail-description-section detail-description-full"><div class="detail-section-heading"><h4>説明</h4>${descriptionZoomControlHtml('desc-zoom-inline')}</div><div class="description-text description-md">${renderDescriptionMarkdown(description)}</div></div>`;
  }
  return `<div class="detail-section detail-description-section detail-description-epic"><div class="detail-section-heading"><h4>説明</h4><button type="button" class="description-toggle-btn" hidden aria-expanded="false">▼ もっと見る</button>${descriptionZoomControlHtml('desc-zoom-inline')}</div><div class="description-collapsible"><div class="description-text description-md">${renderDescriptionMarkdown(description)}</div></div><button type="button" class="description-toggle-btn description-toggle-btn-bottom" hidden aria-expanded="true">▲ 閉じる</button></div>`;
}

// 説明欄の折りたたみトグルを初期化する（BT-080）。2行に収まる場合はボタンを出さない
// BM-089: WS再描画でモーダルを作り直した際、呼び出し元が直前の展開状態をexpandedで渡すと
// 復元できる（渡さなければ常に折りたたみ状態=従来通り）。判定(scrollHeight比較)はまだ
// expandedクラスを付けていない折りたたみ状態で行うため、復元は判定の後に行う。
function setupDescriptionToggle(container, { expanded = false } = {}) {
  container.querySelectorAll('.description-collapsible').forEach((wrap) => {
    const text = wrap.querySelector('.description-text');
    const section = wrap.closest('.detail-description-section');
    const btn = section?.querySelector('.description-toggle-btn:not(.description-toggle-btn-bottom)');
    const bottomBtn = section?.querySelector('.description-toggle-btn-bottom');
    if (!text || !btn) return;
    // BT-462: 表示倍率で「もっと見る」が要るかどうかが変わるため、判定は何度でも行えるようにしておく
    const refreshToggle = () => {
      const overflow = text.scrollHeight > text.clientHeight + 1;
      btn.hidden = !overflow && !wrap.classList.contains('expanded');
    };
    wrap._refreshToggle = refreshToggle;
    refreshToggle();
    // BT-421: 上下のボタンのラベル・aria-expandedを同期する。下ボタンは展開中だけ表示する
    const applyExpanded = (isExpanded) => {
      wrap.classList.toggle('expanded', isExpanded);
      btn.textContent = isExpanded ? '▲ 閉じる' : '▼ もっと見る';
      btn.setAttribute('aria-expanded', String(isExpanded));
      if (bottomBtn) bottomBtn.hidden = !isExpanded;
      refreshToggle();
    };
    btn.addEventListener('click', () => applyExpanded(!wrap.classList.contains('expanded')));
    // BT-421: 下ボタンで閉じたら、画面外に出た説明欄の先頭が見える位置までスクロールを戻す
    bottomBtn?.addEventListener('click', () => {
      applyExpanded(false);
      section.scrollIntoView({ block: 'nearest' });
    });
    // BM-021: 省略表示（...）されている本文クリックでも展開できるようにする。
    // ただし読んでいる途中の誤クリックで閉じてしまうと困るため、本文クリックは展開のみ（閉じない）。閉じるのはボタンのみ。
    text.addEventListener('click', () => {
      if (btn.hidden || wrap.classList.contains('expanded')) return;
      applyExpanded(true);
    });
    if (expanded && !btn.hidden) applyExpanded(true);
  });
}

// --- Drag & Drop ---
let dragData = null;

// BM-049: レーン表示（ワークスペース別）中は、別レーン（別ワークスペース）への
// ドラッグ移動・親子化を禁止する。laneKeyは通常モードでは常に同一値(null)にして、
// 既存の「ワークスペース跨ぎの移動・親子化を許可する」挙動を変えない。
function setupDragAndDrop(card, item, colId, laneKey = null) {
  card.setAttribute('draggable', 'true');
  card.classList.add('card-draggable');

  card.addEventListener('dragstart', (e) => {
    // 親を持たず、子も持たない未完了の単独タスクだけを、カードへ重ねて
    // 親子化できるドラッグ元にする。通常の列移動・並べ替えは全カードで維持する。
    // board APIでは子を持たないタスクのchildrenTotalはnullで返る。
    const canAttach = !item.parentId && !item.childrenTotal && item.statusCode !== 'done';
    dragData = { id: item.id, sourceColId: colId, canAttach, lane: laneKey };
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
    clearParentDropHighlights();
  });
}

function canDropAsChildOn(drag, parentItem, laneKey = null) {
  return !!drag?.canAttach
    && drag.id !== parentItem.id
    && !parentItem.parentId
    && parentItem.statusCode !== 'done'
    && drag.lane === laneKey;
}

function clearParentDropHighlights() {
  document.querySelectorAll('.card-drop-parent').forEach(el => el.classList.remove('card-drop-parent'));
}

// カード上へのドロップは列移動ではなく、ドラッグ元をこのカードの子にする操作。
// 単独タスクを親にすると、そのままEPICとして扱える。
function setupParentDropTarget(card, parentItem, laneKey = null) {
  card.addEventListener('dragover', (e) => {
    if (!canDropAsChildOn(dragData, parentItem, laneKey)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    clearParentDropHighlights();
    card.classList.add('card-drop-parent');
  });

  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('card-drop-parent');
  });

  card.addEventListener('drop', async (e) => {
    if (!canDropAsChildOn(dragData, parentItem, laneKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const childId = dragData.id;
    dragData = null;
    clearParentDropHighlights();
    await attachDraggedTaskToParent(childId, parentItem.id);
  });
}

function setupDropZone(bodyEl, colId, colMatch, laneKey = null) {
  let lastDropTarget = { card: null, position: 'below' }; // dragoverで計算した最後のターゲットを保持

  bodyEl.addEventListener('dragover', (e) => {
    if (!dragData || dragData.lane !== laneKey) return; // BM-049: 別レーンへのドロップは禁止
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

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
    if (!dragData || dragData.lane !== laneKey) return; // BM-049: 別レーンへのドロップは禁止
    e.preventDefault();
    bodyEl.classList.remove('drop-over');
    clearDropIndicators(bodyEl);

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
      reorderItems(filteredIds);
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
      updateStatus(dragInfo.id, newStatus).then(() => {
        // 2つ以上のIDがあればreorder実行
        if (existingIds.length >= 2) {
          reorderItems(existingIds);
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

async function attachDraggedTaskToParent(taskId, parentId) {
  try {
    const resp = await fetch('/api/attach-to-parent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: [taskId], parentId }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      console.error('[dnd] Attach failed:', data.error, data.failed);
      alert(`親子関係の登録に失敗したよ: ${data.error || ''}`);
    }
  } catch (e) {
    console.error('[dnd] Attach network error:', e);
    alert('親子関係の登録中に通信エラーが起きたよ');
  }
}

async function reorderItems(orderedIds) {
  try {
    const resp = await fetch('/api/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      console.error('[dnd] Reorder failed:', err.error);
    }
  } catch (e) {
    console.error('[dnd] Network error:', e);
  }
}

async function updateStatus(taskId, newStatus) {
  try {
    const resp = await fetch('/api/update-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, newStatus }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      console.error('[dnd] Update failed:', err.error);
    }
  } catch (e) {
    console.error('[dnd] Network error:', e);
  }
}

// --- 週次計画ビュー (BT-264) ---
const PLAN_WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function planFormatDueBadge(dueDate) {
  if (!dueDate) return '';
  const d = new Date(dueDate + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}(${PLAN_WEEKDAY_JA[d.getDay()]})`;
}

function renderDueDateBadge(dueDate, statusCode) {
  const label = planFormatDueBadge(dueDate);
  const overdue = isDueOverdue(dueDate, statusCode) ? ' due-overdue' : '';
  return `<span class="card-tag due-badge${overdue}" title="期日"><span class="material-icon icon-timer"></span><span>${escapeHtml(label)}</span></span>`;
}

function renderCompletedDateBadge(completedDate) {
  return `<span class="card-tag completed-date" title="完了日"><span class="material-icon icon-check-box"></span><span>${escapeHtml(completedDate)}</span></span>`;
}

function planGetMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun .. 6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d;
}

function planFormatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function planAddDays(d, n) {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
}

// weeksOffset: 今週=0, 来週=1, それ以降(ドロップ時の基準週)=2
const PLAN_WEEKS_OFFSET = { thisWeek: 0, nextWeek: 1, later: 2 };

// label: 列名（濃い表示） / range: 付随する日付範囲（薄く小さい表示。無ければ空文字）
function planBucketDef() {
  const todayMonday = planGetMonday(getTodayJST());
  const mdOf = (weeksOffset, dayOffset) =>
    planFormatYmd(planAddDays(todayMonday, weeksOffset * 7 + dayOffset)).slice(5).replace('-', '/');
  const todayLabel = getTodayJST().slice(5).replace('-', '/');
  return [
    { id: 'todo', label: 'ストック', range: '' },
    { id: 'overdue', label: '遅延', range: `〜${todayLabel}` },
    { id: 'thisWeek', label: '今週', range: `${mdOf(0, 0)}〜${mdOf(0, 4)}` },
    { id: 'nextWeek', label: '来週', range: `${mdOf(1, 0)}〜${mdOf(1, 4)}` },
    { id: 'later', label: 'それ以降', range: '' },
  ];
}

function planBucketForDueDate(dueDate) {
  if (!dueDate) return 'todo';
  const todayMonday = planGetMonday(getTodayJST());
  const dueMonday = planGetMonday(dueDate);
  const weeksDiff = Math.round((dueMonday - todayMonday) / (7 * 86400000));
  if (weeksDiff < 0) return 'overdue';
  if (weeksDiff === 0) return 'thisWeek';
  if (weeksDiff === 1) return 'nextWeek';
  return 'later';
}

// ドロップ先バケットに対応する開始日(週の月曜)・期日(週の金曜)。BT-434: 週のいつやるか分からないため開始日も置く。
// 既存の開始日が対象週(月〜金)の範囲内なら、本人が決めた着手日として維持する。範囲外(前倒し・後ろ倒し)・未設定は月曜に寄せる。
// TODO(=保留。後で計画し直す)は開始日・期日とも null(=クリア)。遅延(非対応)も同様。
// 「それ以降」は境界がないため、暫定でPLAN_WEEKS_OFFSET.later週に固定する。
function planScheduleForBucket(bucketId, currentStart = null) {
  if (!(bucketId in PLAN_WEEKS_OFFSET)) return { startDate: null, dueDate: null };
  const todayMonday = planGetMonday(getTodayJST());
  const monday = planFormatYmd(planAddDays(todayMonday, PLAN_WEEKS_OFFSET[bucketId] * 7));
  const friday = planFormatYmd(planAddDays(planGetMonday(monday), 4));
  const keep = currentStart && currentStart >= monday && currentStart <= friday;
  return { startDate: keep ? currentStart : monday, dueDate: friday };
}

// 週次計画に出ているタスク(トップレベル・子)をIDで探す
function planFindItem(id) {
  for (const item of planCollectItems()) {
    if (item.id === id) return item;
    const child = (item.children || []).find((c) => c.id === id);
    if (child) return child;
  }
  return null;
}

// メインボードの全カラムからトップレベルitemを収集（parentId付き=完了子タスクの重複表示はスキップ、フィルタはヘッダーのワークスペース選択に追従）
function planCollectItems() {
  if (!lastBoardData || !lastBoardData.columns) return [];
  const result = [];
  const seen = new Set();
  for (const col of lastBoardData.columns) {
    for (const item of col.items) {
      if (!item.id || item.id === '-') continue;
      if (item.parentId) continue; // 親側children配列で既にカウント済み
      if (currentFilter && item.project !== currentFilter) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}

// 📌が立っているか。EPICは自身のフラグを持たず子の集計（todayCount）で表される
function planPinActive(item) {
  return (item.children && item.children.length > 0) || item.childrenTotal > 0
    ? (item.todayCount || 0) > 0
    : !!item.todayFlag;
}

// BM-012: タイトル絞り込み。対象は ID / 件名 / 分類 / ワークスペース。空白区切りはAND。
function planMatchesSearch(item, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [item.id, item.title, item.category, item.project].filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

// BT-396: タグ絞り込み。子はEPIC自身のタグが一致していてもEPICごと出す（検索・ピンと同じ考え方）。
function planMatchesTags(item, epic) {
  if (tagFilter.tags.length === 0) return true;
  const keys = tagFilter.tags.map(t => t.key);
  return tagLogic.matchesTagFilter(item.tags, keys, tagFilter.mode)
    || (!!epic && tagLogic.matchesTagFilter(epic.tags, keys, tagFilter.mode));
}

// BT-315: 完了タスクの置き場。遅延列には出さない（終わったものは遅延としない）／ヘッダーのトグルOFFなら出さない。
// 出す場合は通常カードに混ぜず、列内の折りたたみグループ(doneItems)へ振り分ける。
function planPushDone(bucket, bucketId, item, epic) {
  if (bucketId === 'overdue' || !planShowDone) return;
  bucket.doneItems.push({ item, epic });
}

function planBuildBuckets(bucketDefs) {
  const buckets = {};
  for (const b of bucketDefs) buckets[b.id] = { singles: [], epicGroups: new Map(), doneItems: [] };

  const isFiltered = !!planSearchQuery.trim() || planPinOnly || tagFilter.tags.length > 0;

  for (const item of planCollectItems()) {
    const isEpic = (item.children && item.children.length > 0) || item.childrenTotal > 0;
    if (isEpic) {
      // BM-012: EPIC自身の📌（=子の集約）が立っていれば、絞り込み条件に関わらずEPICごと出す
      const epicPinned = planPinActive(item);
      for (const child of (item.children || [])) {
        const bucketId = planBucketForDueDate(child.dueDate);
        if (bucketId === 'todo' && child.statusCode === 'done') continue; // 完了済みは期日未設定のままTODOに残さない
        if (isFiltered) {
          const matchesPin = !planPinOnly || epicPinned;
          const matchesSearch = planMatchesSearch(child, planSearchQuery) || planMatchesSearch(item, planSearchQuery);
          if (!matchesPin || !matchesSearch || !planMatchesTags(child, item)) continue;
        }
        if (child.statusCode === 'done') { planPushDone(buckets[bucketId], bucketId, child, item); continue; }
        let group = buckets[bucketId].epicGroups.get(item.id);
        if (!group) {
          group = { epic: item, children: [] };
          buckets[bucketId].epicGroups.set(item.id, group);
        }
        group.children.push(child);
      }
    } else {
      const bucketId = planBucketForDueDate(item.dueDate);
      if (bucketId === 'todo' && item.statusCode === 'done') continue;
      if (isFiltered) {
        if (planPinOnly && !planPinActive(item)) continue;
        if (!planMatchesSearch(item, planSearchQuery)) continue;
        if (!planMatchesTags(item, null)) continue;
      }
      if (item.statusCode === 'done') { planPushDone(buckets[bucketId], bucketId, item, null); continue; }
      buckets[bucketId].singles.push(item);
    }
  }
  return buckets;
}

// BT-434: 週バケットへのドロップ用。開始日と期日を同時に更新する（nullは空文字=クリア）
async function planUpdateSchedule(taskId, { startDate, dueDate }) {
  try {
    const resp = await fetch('/api/update-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, startDate: startDate || '', dueDate: dueDate || '' }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      console.error('[plan] update-task failed:', err.error);
    }
  } catch (e) {
    console.error('[plan] Network error:', e);
  }
}

async function planUpdateDueDate(taskId, dueDate) {
  try {
    const resp = await fetch('/api/update-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, dueDate: dueDate || '' }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      console.error('[plan] update-task failed:', err.error);
    }
  } catch (e) {
    console.error('[plan] Network error:', e);
  }
}

function planBuildCard(item, bucketId, parentEpic = null) {
  const isDone = item.statusCode === 'done';
  const pinActive = !!item.todayFlag; // 子タスク・単発タスク自身のピン（EPIC集約は呼び出し元のグループ見出しで表現）
  const card = document.createElement('div');
  card.className = 'card plan-card' + (isDone ? ' plan-card-done' : '') + (pinActive ? ' card-today' : '');
  card.dataset.taskId = item.id;
  const spinner = item.running ? '<span class="running-spinner"></span>' : '';
  const pinIcon = pinActive ? '<span class="material-icon icon-keep plan-card-pin"></span>' : '';
  // BM-012: ワークスペースをALL表示にしているときだけ、カードにワークスペースバッジを出す
  // （1つに絞っているときは全カード同じ値になり情報量がゼロなので出さない）
  const wsBadge = (!currentFilter && item.project)
    ? `<span class="card-tag project">${escapeHtml(item.project)}</span>` : '';
  const dueBadge = item.dueDate ? renderDueDateBadge(item.dueDate, item.statusCode) : '';
  const metaHtml = (wsBadge || dueBadge) ? `<div class="card-meta">${wsBadge}${dueBadge}</div>` : '';
  // BT-315: ホバーで出る期日カレンダーボタン（メインボードのカードと同じ操作）。完了済みは期日を触らない
  const dueBtnHtml = isDone ? ''
    : `<div class="card-actions plan-card-actions"><button type="button" class="card-action-btn plan-card-due-btn" title="期日を設定"><span class="material-icon icon-calendar-month"></span></button></div>`;
  card.innerHTML = `${dueBtnHtml}<div class="card-id">${spinner}${pinIcon}${escapeHtml(item.id)}</div><div class="card-title">${escapeHtml(item.title)}</div>${metaHtml}`;
  const dueBtn = card.querySelector('.plan-card-due-btn');
  if (dueBtn) {
    dueBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openDueDatePicker(dueBtn, item.dueDate, async (date) => {
        await planUpdateDueDate(item.id, date);
        renderPlanBoard();
      });
    });
    // ボタン上ではカード全体のドラッグを始めない
    dueBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  if (!isDone) {
    card.setAttribute('draggable', 'true');
    card.classList.add('card-draggable');
    card.addEventListener('dragstart', (e) => {
      planDragData = { kind: 'single', id: item.id };
      card.classList.add('card-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('card-dragging');
      planDragData = null;
    });
  }

  card.addEventListener('click', () => {
    if (parentEpic) {
      // 子タスク: EPICボード(ミニボード)を開き、この子タスクをハイライト
      expandedMiniCols.add('done');
      pendingHighlightChildId = item.id;
      openCardDetail(parentEpic);
    } else {
      openCardDetail(item);
    }
  });
  setupTaskQuickTip(card, item);
  return card;
}

function planBuildEpicGroup(group, bucketId, forceExpand = false) {
  const key = group.epic.id + '_' + bucketId;
  const isExpanded = forceExpand || !planCollapsedGroups.has(key);
  const wrap = document.createElement('div');
  const epicPinned = planPinActive(group.epic);
  wrap.className = 'plan-epic-group' + (epicPinned ? ' card-today' : '') + (forceExpand ? ' is-forced' : '');

  const header = document.createElement('div');
  header.className = 'plan-epic-header';
  const pinIcon = epicPinned
    ? `<span class="material-icon icon-keep plan-card-pin" title="子タスクに📌あり（${group.epic.todayCount || 0}件）"></span>` : '';
  const toggleTitle = forceExpand ? '絞り込み中は開いたまま表示するよ' : (isExpanded ? '折りたたむ' : '開く');
  header.innerHTML = `<span class="plan-epic-handle" title="ドラッグでこのEPICの子タスクをまとめて移動">≡</span><span class="plan-epic-toggle" title="${escapeHtml(toggleTitle)}">${isExpanded ? '▾' : '▸'}</span><div class="plan-epic-header-text"><div class="plan-epic-header-row1"><span class="card-id">${pinIcon}${escapeHtml(group.epic.id)}</span><span class="count">${group.children.length}</span></div><div class="card-title"><span class="epic-title-chip" title="親タスク（子タスクを束ねるEpic）"><span class="material-icon icon-stacks"></span></span>${escapeHtml(group.epic.title)}</div></div>`;

  header.addEventListener('click', (e) => {
    if (forceExpand) return;
    if (e.target.closest('.plan-epic-handle')) return;
    if (planCollapsedGroups.has(key)) planCollapsedGroups.delete(key); else planCollapsedGroups.add(key);
    renderPlanBoard();
  });

  const handle = header.querySelector('.plan-epic-handle');
  handle.setAttribute('draggable', 'true');
  handle.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    const targetIds = group.children.filter(c => c.statusCode !== 'done').map(c => c.id);
    if (targetIds.length === 0) { e.preventDefault(); return; }
    planDragData = { kind: 'group', epicId: group.epic.id, childIds: targetIds };
    header.classList.add('card-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', group.epic.id);
  });
  handle.addEventListener('dragend', () => {
    header.classList.remove('card-dragging');
    planDragData = null;
  });

  const childrenEl = document.createElement('div');
  childrenEl.className = 'plan-epic-children';
  childrenEl.style.display = isExpanded ? '' : 'none';
  for (const child of group.children) {
    childrenEl.appendChild(planBuildCard(child, bucketId, group.epic));
  }

  wrap.appendChild(header);
  wrap.appendChild(childrenEl);
  return wrap;
}

// BT-315: 列内の「完了 N件」折りたたみグループ。親EPICの子は親IDバッジ付きで並べる
function planBuildDoneGroup(bucketId, doneItems, sortMode) {
  const isExpanded = planExpandedDone.has(bucketId);
  const wrap = document.createElement('div');
  wrap.className = 'plan-done-group';
  const header = document.createElement('div');
  header.className = 'plan-done-header';
  header.innerHTML = `<span class="plan-epic-toggle">${isExpanded ? '▾' : '▸'}</span><span class="material-icon icon-check-box"></span><span class="plan-done-label">完了</span><span class="count">${doneItems.length}</span>`;
  header.title = isExpanded ? '完了タスクを折りたたむ' : '完了タスクを開く';
  header.addEventListener('click', () => {
    if (planExpandedDone.has(bucketId)) planExpandedDone.delete(bucketId); else planExpandedDone.add(bucketId);
    renderPlanBoard();
  });
  wrap.appendChild(header);
  if (isExpanded) {
    const epicOf = new Map(doneItems.map((d) => [d.item.id, d.epic]));
    const list = document.createElement('div');
    list.className = 'plan-done-list';
    for (const item of columnSort.sortItems(doneItems.map((d) => d.item), sortMode)) {
      list.appendChild(planBuildCard(item, bucketId, epicOf.get(item.id) || null));
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function planSetupDropZone(bodyEl, bucketId) {
  const canDrop = bucketId !== 'overdue'; // 遅延列への期日設定は未定義のため今回は非対応

  bodyEl.addEventListener('dragover', (e) => {
    if (!planDragData || !canDrop) return;
    e.preventDefault();
    bodyEl.classList.add('drop-over');
  });
  bodyEl.addEventListener('dragleave', (e) => {
    if (!bodyEl.contains(e.relatedTarget)) bodyEl.classList.remove('drop-over');
  });
  bodyEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    bodyEl.classList.remove('drop-over');
    if (!planDragData || !canDrop) { planDragData = null; return; }

    const drag = planDragData;
    planDragData = null;

    // 開始日の維持判定はタスクごとに行う(EPICグループ一括でも子の開始日はそれぞれ違う)。TODO列は開始日・期日ともクリア
    const scheduleOf = (id) => planScheduleForBucket(bucketId, (planFindItem(id) || {}).startDate || null);
    if (drag.kind === 'single') {
      await planUpdateSchedule(drag.id, scheduleOf(drag.id));
    } else if (drag.kind === 'group') {
      await Promise.all(drag.childIds.map(id => planUpdateSchedule(id, scheduleOf(id))));
    }
    renderPlanBoard();
  });
}

// BT-268: ガント表示用。絞り込み(検索・ピン・ワークスペース)は週次計画と同じ条件で、
// EPIC+子の組(epic=null は単発タスクの束)にして gantt.js へ渡す。日付は update-task の既存項目だけ使う。
// BM-046: フッターの母数(絞り込み前の件数)を出すため、検索・ピン絞り込みを無視した版を作れるようにする
function planBuildGanttGroups(ignoreFilter) {
  const categoryActive = !ignoreFilter && categoryFilter.keys.length > 0;
  const isFiltered = !ignoreFilter && (!!planSearchQuery.trim() || planPinOnly || tagFilter.tags.length > 0 || categoryActive);
  const groups = [];
  const singles = [];
  for (const item of planCollectItems()) {
    // BT-447: カテゴリ絞り込みはボードと同じくEPIC/単発タスク自身のカテゴリで判定する(EPICが合えば子ごと出す)
    if (categoryActive && !categoryLogic.matchesCategoryFilterForBoardItem(item, categoryFilter.keys)) continue;
    const isEpic = (item.children && item.children.length > 0) || item.childrenTotal > 0;
    if (isEpic) {
      const epicPinned = planPinActive(item);
      const children = (item.children || []).filter((child) => {
        if (!isFiltered) return true;
        const matchesPin = !planPinOnly || epicPinned;
        const matchesSearch = planMatchesSearch(child, planSearchQuery) || planMatchesSearch(item, planSearchQuery);
        return matchesPin && matchesSearch && planMatchesTags(child, item);
      });
      if (children.length > 0) groups.push({ epic: item, children });
    } else {
      if (isFiltered) {
        if (planPinOnly && !planPinActive(item)) continue;
        if (!planMatchesSearch(item, planSearchQuery)) continue;
        if (!planMatchesTags(item, null)) continue;
      }
      singles.push(item);
    }
  }
  if (singles.length > 0) groups.push({ epic: null, children: singles });
  return groups;
}

// ガントでのドラッグ結果を保存する。patchの値が''ならその日付をクリアする
async function planSaveGanttDates(taskId, patch) {
  const resp = await fetch('/api/update-task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, ...patch }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  // WS更新が届くまでの間にバーが元の位置へ戻らないよう、手元のデータにも先に反映する
  const apply = (item) => {
    if (item.id !== taskId) return;
    if ('startDate' in patch) item.startDate = patch.startDate || null;
    if ('dueDate' in patch) item.dueDate = patch.dueDate || null;
  };
  for (const item of planCollectItems()) {
    apply(item);
    (item.children || []).forEach(apply);
  }
}

// BT-424: ガント行のステータス変更。失敗はgantt.js側でログに出すため例外を投げる
async function planChangeGanttStatus(taskId, newStatus) {
  const resp = await fetch('/api/update-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, newStatus }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  // WS更新が届くまでの間に表示が元へ戻らないよう、手元のデータにも先に反映する
  const apply = (item) => { if (item.id === taskId) item.statusCode = newStatus; };
  for (const item of planCollectItems()) {
    apply(item);
    (item.children || []).forEach(apply);
  }
}

// BM-046: フッターのDO/READY/TODO/DONE件数。currentFilter(ワークスペースセレクタ)が効いた状態の
// planCollectItems()を母数にし、検索・ピン絞り込み適用後の groups を絞り込み後の件数とする。
// EPICは子の集計に含める(renderWsFilterCountsと同じ考え方。親自身のstatusCodeは数えない)
function planGanttStatusCounts(groups) {
  const counts = { do: 0, ready: 0, todo: 0, done: 0 };
  for (const g of groups) {
    for (const c of g.children) {
      if (counts[c.statusCode] !== undefined) counts[c.statusCode]++;
    }
  }
  return counts;
}

function renderPlanGantt() {
  const root = document.getElementById('plan-gantt-root');
  if (!root || !window.ganttView) return;
  const groups = planBuildGanttGroups();
  // ALL表示でワークスペースが複数ある時だけ、ワークスペースごとの折りたたみ見出しで束ねる(既存仕様)
  const projects = new Set();
  groups.forEach((g) => { if (g.epic) projects.add(g.epic.project); g.children.forEach((c) => projects.add(c.project)); });

  // BM-046: フッターのDO/READY/TODO/DONE件数。母数(allGroups)はワークスペースセレクタのcurrentFilterだけを
  // 反映し検索・ピン絞り込みは無視、絞り込み後(groups)はそれらも反映した件数。絞り込みが無い時はshownを出さない
  const allGroups = planBuildGanttGroups(true);
  const query = planSearchQuery.trim();
  const filtered = !!query || planPinOnly || tagFilter.tags.length > 0 || categoryFilter.keys.length > 0;
  const totalCounts = planGanttStatusCounts(allGroups);
  const shownCounts = filtered ? planGanttStatusCounts(groups) : null;
  // 絞り込みメッセージに出す条件文言。現状の絞り込み手段はキーワード検索と📌今日やるのみ
  const filterLabel = [query ? `「${query}」` : '', planPinOnly ? '📌今日やる' : '', tagLogic.describeTagFilter(tagFilter), categoryFilter.keys.length > 0 ? `カテゴリ:${categoryFilter.keys.join('、')}` : ''].filter(Boolean).join(' + ');

  // BM-093: 「遅延」ボタンの巡回位置をリセットする判定キー。ワークスペース・検索語・ピン・タグ絞り込みの
  // いずれかが変わったら別キーになり、gantt.js側で先頭に戻す(存在しないタスクを指し続けないようにする)
  const overdueFilterKey = JSON.stringify([
    currentFilter,
    planSearchQuery.trim(),
    planPinOnly,
    tagFilter.mode,
    tagFilter.tags.map((t) => t.key).sort(),
    categoryFilter.keys.slice().sort(),
  ]);

  window.ganttView.render(root, {
    groups,
    today: getTodayJST(),
    escapeHtml,
    holidayName: (ymd) => (window.jpHolidays ? window.jpHolidays.getHolidayName(ymd) : null),
    groupByWorkspace: !currentFilter && projects.size > 1,
    footerCounts: { total: totalCounts, shown: shownCounts, filterLabel },
    filterKey: overdueFilterKey,
    // タイトルの右に出すタグ。EPICは自分のタグに子由来のタグ(薄)を続ける
    tagsHtml: (item) => tagLogic.buildCardTagsHtml(item.tags, item.childTags, 2),
    // BT-447: カテゴリ階層の束ね(EPIC/単発タスク自身のカテゴリ)
    categoryOf: (item) => item.category,
    categoryChipHtml: planCategoryChipHtml,
    categoryOrder: [...planCategoryColors.keys()],
    onSaveDates: planSaveGanttDates,
    // BT-424: 行のステータス文字から変更する
    onChangeStatus: planChangeGanttStatus,
    // BT-376: ヘッダの+から既存のタスク追加フォームを開く(日付は空のまま。ユーザーが計画時に入れる)
    // BT-430: 単発タスク見出しからはそのワークスペース(project)を渡す。ヘッダの+は無指定で従来どおり
    onAddTask: (project) => openAddTaskForm('todo', project || currentFilter || '', ''),
    // BT-430: EPIC行の「子タスクを追加」。親EPICのワークスペースで子タスク追加フォームを開く
    onAddChild: (epicId, project) => openAddTaskForm('todo', project || currentFilter || '', epicId),
    onOpen: (item, parentEpic) => {
      if (parentEpic) {
        // 週次計画と同じ: 子タスクはEPICボード(ミニボード)を開き、その子をハイライト
        expandedMiniCols.add('done');
        pendingHighlightChildId = item.id;
        // BT-427: パルスは短く、ミニボードの再描画でも消えるため、どの子か分かるよう
        // 履歴からの遷移と同じ常時ハイライト(モーダルを閉じるまで維持)も付ける
        activityHighlightTaskIds = new Set([item.id]);
        openCardDetail(parentEpic);
      } else {
        openCardDetail(item);
      }
    },
  });
  planUpdateHeaderControls();
}

function planApplyViewMode() {
  const overlay = document.getElementById('plan-board-overlay');
  if (!overlay) return;
  overlay.querySelector('.plan-board-panel').classList.toggle('is-gantt', planViewMode === 'gantt');
  overlay.querySelectorAll('.plan-view-toggle button').forEach((btn) => {
    btn.classList.toggle('is-on', btn.dataset.mode === planViewMode);
  });
  const title = overlay.querySelector('#plan-board-title');
  if (title) title.textContent = planViewMode === 'gantt' ? ' 日程計画（ガント）' : ' 週次計画';
}

function renderPlanBoard() {
  if (planViewMode === 'gantt') { renderPlanGantt(); return; }
  const container = document.getElementById('plan-board-columns');
  if (!container) return;

  // EPIC開閉トグル等での再描画時に、列のスクロール位置が先頭に飛ばないよう保持する
  const scrollPositions = {};
  container.querySelectorAll('.plan-col-body[data-bucket-id]').forEach(el => {
    scrollPositions[el.dataset.bucketId] = el.scrollTop;
  });

  const bucketDefs = planBucketDef();
  const buckets = planBuildBuckets(bucketDefs);
  suppressQuickTipScrollClose(); // BM-136: スクロール位置の書き戻しで右クリックTIPが閉じないようにする
  container.innerHTML = '';

  // BM-078: VS Code Simple Browser等のwebview環境では、appendChild直後は
  // レイアウトがまだ確定しておらずscrollTopの書き戻しが0にクランプされることがある。
  // 通常のブラウザでは起きないため、次フレームでの再書き戻しを保険として追加する(ボードと同じ対策)。
  const planColumnBodyEls = {};

  // 絞り込み中はストックのEPICグループを開いたまま出す（畳んだままだと絞り込んだ意味が無い）
  const isFiltered = !!planSearchQuery.trim() || planPinOnly;

  for (const b of bucketDefs) {
    const bucket = buckets[b.id];
    const totalCount = bucket.singles.length + Array.from(bucket.epicGroups.values()).reduce((s, g) => s + g.children.length, 0);
    const sortMode = planColumnSortMode(b.id);
    const isStock = b.id === 'todo';

    // BM-012: 「全部開く/畳む」はストック列だけの機能なので、共通ヘッダーではなく
    // ストック列のヘッダー内（列名の右）にアイコンボタンとして置く（他列に効くように誤解されないよう）
    if (isStock) {
      planStockGroupKeys = Array.from(bucket.epicGroups.keys()).map((epicId) => epicId + '_todo');
    }
    const stockToggleHtml = isStock
      ? `<button type="button" class="plan-stock-toggle-all-btn" id="plan-stock-toggle-all-btn" title="ストック列のEPICグループをまとめて開閉する">▾</button>`
      : '';

    const rangeHtml = b.range ? `<span class="plan-col-range">${escapeHtml(b.range)}</span>` : '';
    const colEl = document.createElement('div');
    colEl.className = 'plan-col';
    colEl.innerHTML = `<div class="plan-col-header"><span class="plan-col-label">${escapeHtml(b.label)}</span>${stockToggleHtml}${rangeHtml}<div class="column-header-right">${planColumnSortSelectHtml(b.id)}<span class="count">${totalCount}</span></div></div><div class="plan-col-body" data-bucket-id="${b.id}"></div>`;
    const body = colEl.querySelector('.plan-col-body');
    planSetupDropZone(body, b.id);

    if (totalCount === 0 && bucket.doneItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'plan-col-empty';
      empty.textContent = b.id === 'overdue' || b.id === 'later' ? '（なし）' : 'ここにドロップ';
      body.appendChild(empty);
    } else {
      const sortedSingles = columnSort.sortItems(bucket.singles, sortMode);
      for (const item of sortedSingles) {
        body.appendChild(planBuildCard(item, b.id));
      }
      for (const group of bucket.epicGroups.values()) {
        group.children = columnSort.sortItems(group.children, sortMode);
        body.appendChild(planBuildEpicGroup(group, b.id, isStock && isFiltered));
      }
    }
    if (bucket.doneItems.length > 0) body.appendChild(planBuildDoneGroup(b.id, bucket.doneItems, sortMode));

    container.appendChild(colEl);
    // scrollTopはDOM接続後でないと反映されない(接続前は高さが確定せず0にクランプされる)
    if (scrollPositions[b.id] != null) body.scrollTop = scrollPositions[b.id];
    planColumnBodyEls[b.id] = body;
  }

  // BM-078: webview環境向けの保険(ボードと同じ対策)。
  if (Object.keys(scrollPositions).length > 0) {
    const reapplyPlanScroll = () => {
      for (const bucketId of Object.keys(planColumnBodyEls)) {
        const target = scrollPositions[bucketId];
        const body = planColumnBodyEls[bucketId];
        if (target != null && body && body.scrollTop !== target) {
          body.scrollTop = target;
        }
      }
    };
    requestAnimationFrame(() => {
      reapplyPlanScroll();
      requestAnimationFrame(reapplyPlanScroll);
    });
  }

  container.querySelectorAll('.plan-col-sort-select').forEach((select) => {
    select.addEventListener('change', (e) => {
      localStorage.setItem(COLUMN_SORT_KEY_PREFIX + 'plan_' + e.target.dataset.bucketId, e.target.value);
      renderPlanBoard();
    });
  });

  // BM-012: ストック列の「全部開く/畳む」アイコン。対象なし/絞り込み中は無効化する
  // （disabledでも表示は保つ。列内に置くボタンなので他要素との位置ズレは元々気にしなくてよい）
  const stockToggleBtn = container.querySelector('#plan-stock-toggle-all-btn');
  if (stockToggleBtn) {
    const usable = planStockGroupKeys.length > 0 && !isFiltered;
    stockToggleBtn.disabled = !usable;
    const anyCollapsed = usable && planStockGroupKeys.some((k) => planCollapsedGroups.has(k));
    stockToggleBtn.textContent = anyCollapsed ? '▸' : '▾';
    stockToggleBtn.title = usable
      ? (anyCollapsed ? 'ストック列のEPICグループを全部開く' : 'ストック列のEPICグループを全部畳む')
      : '絞り込み中は開いたまま表示するよ';
    stockToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      planToggleAllGroups();
    });
  }

  planUpdateHeaderControls();
}

// BM-012: 共通ヘッダーのピン件数・絞込クリアボタンの表示を最新状態に合わせる
function planUpdateHeaderControls() {
  const overlay = document.getElementById('plan-board-overlay');
  if (!overlay) return;

  // ピン件数はストック列（planCollectItemsの全件、フィルタ前）を対象に数える
  const allItems = planCollectItems();
  let pinCount = 0;
  for (const item of allItems) {
    const isEpic = (item.children && item.children.length > 0) || item.childrenTotal > 0;
    if (isEpic) {
      if (planPinActive(item)) pinCount++;
    } else if (item.todayFlag) {
      pinCount++;
    }
  }
  const pinBtn = overlay.querySelector('#plan-pin-filter-btn');
  if (pinBtn) {
    pinBtn.classList.toggle('filter-active', planPinOnly);
    pinBtn.title = `📌ピンを付けたタスクだけ表示する（${pinCount}件）`;
  }
  const pinCountEl = overlay.querySelector('#plan-pin-count');
  if (pinCountEl) pinCountEl.textContent = pinCount > 0 ? String(pinCount) : '';

  const doneBtn = overlay.querySelector('#plan-done-filter-btn');
  if (doneBtn) {
    doneBtn.classList.toggle('filter-active', planShowDone);
    doneBtn.style.display = planViewMode === 'gantt' ? 'none' : '';
    doneBtn.title = planShowDone
      ? '完了タスクを表示中（クリックで非表示）。遅延列には出ないよ'
      : '完了タスクは非表示（クリックで表示）';
  }

  const clearBtn = overlay.querySelector('#plan-search-clear-btn');
  if (clearBtn) clearBtn.style.visibility = planSearchQuery ? 'visible' : 'hidden';
}

function getOrCreatePlanBoardModal() {
  let overlay = document.getElementById('plan-board-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'plan-board-overlay';
  overlay.className = 'plan-board-overlay';
  overlay.innerHTML = `
    <div class="plan-board-panel">
      <div class="plan-board-header">
        <h3><span class="material-icon icon-calendar-month"></span><span id="plan-board-title"> 週次計画</span></h3>
        <div class="plan-view-toggle" role="group" aria-label="表示切替">
          <button type="button" data-mode="week" title="週ごとのカンバン">週次</button>
          <button type="button" data-mode="gantt" title="日ごとのガントチャート">ガント</button>
        </div>
        <div class="ws-filter-wrap" id="plan-ws-filter-wrap">
          <button type="button" class="ws-filter-trigger" id="plan-ws-filter-trigger" title="Workspace filter" aria-haspopup="listbox" aria-expanded="false">
            <span class="ws-filter-trigger-label" id="plan-ws-filter-trigger-label">All Projects</span>
            <span class="ws-filter-trigger-arrow" aria-hidden="true">▾</span>
          </button>
          <div class="ws-filter-menu" id="plan-ws-filter-menu" role="listbox" tabindex="-1" hidden></div>
        </div>
        <div class="plan-search-wrap">
          <input type="text" class="plan-search-input" id="plan-search-input" placeholder="絞り込み（ID・件名・分類）">
          <button type="button" class="plan-search-clear-btn" id="plan-search-clear-btn" title="絞込解除">&#10005;</button>
        </div>
        <button type="button" class="plan-pin-filter-btn" id="plan-pin-filter-btn" title="📌ピンを付けたタスクだけ表示する（EPICは子に📌があればEPICごと表示）"><span class="material-icon icon-keep"></span><span class="plan-pin-count" id="plan-pin-count"></span></button>
        <button type="button" class="plan-pin-filter-btn plan-tag-filter-btn tag-filter-trigger" id="plan-tag-filter-btn" aria-haspopup="dialog" title="タグで絞り込み（ボード・週次計画・ガント共通）"><span class="material-icon icon-tag"></span><span class="tag-filter-count" hidden></span></button>
        <button type="button" class="plan-pin-filter-btn category-filter-btn category-filter-trigger" id="plan-category-filter-btn" aria-haspopup="dialog" title="カテゴリで絞り込み（ボード・週次計画・ガント共通）"><span class="material-icon icon-stacks"></span><span class="category-filter-count" hidden></span></button>
        <button type="button" class="plan-pin-filter-btn plan-done-filter-btn" id="plan-done-filter-btn"><span class="material-icon icon-check-box"></span></button>
        <button class="plan-board-close" id="plan-board-close">&times;</button>
      </div>
      <div class="plan-board-columns" id="plan-board-columns"></div>
      <div class="plan-gantt-root" id="plan-gantt-root"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll('.plan-view-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      planViewMode = btn.dataset.mode;
      try { localStorage.setItem('planViewMode', planViewMode); } catch { /* 無視 */ }
      if (planViewMode === 'gantt' && window.ganttView) window.ganttView.resetScroll();
      planApplyViewMode();
      renderPlanBoard();
    });
  });
  overlay.querySelector('#plan-board-close').addEventListener('click', closePlanBoard);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePlanBoard(); });
  closeOnEscape(overlay, 'active', closePlanBoard);

  // BM-029: Plan Board側のワークスペース絞り込みドロップダウンもヘッダーと同じ列固定表示にする。
  // モーダルは getOrCreatePlanBoardModal() の初回呼び出しでDOMごと作られるため、ここで生成する。
  wsFilterPlanDropdown = createWsFilterDropdown({
    wrapEl: overlay.querySelector('#plan-ws-filter-wrap'),
    triggerEl: overlay.querySelector('#plan-ws-filter-trigger'),
    triggerLabelEl: overlay.querySelector('#plan-ws-filter-trigger-label'),
    menuEl: overlay.querySelector('#plan-ws-filter-menu'),
    includeCreateAction: false, // Plan Board内は絞り込み専用。新規作成は設定パネルから行う
    onSelect: (value) => applyMainFilter(value),
  });

  // BM-012: キーワード絞り込み
  const searchInput = overlay.querySelector('#plan-search-input');
  searchInput.addEventListener('input', () => {
    planSearchQuery = searchInput.value;
    renderPlanBoard();
  });
  overlay.querySelector('#plan-search-clear-btn').addEventListener('click', () => {
    planSearchQuery = '';
    searchInput.value = '';
    searchInput.focus();
    renderPlanBoard();
  });

  // BM-012: 📌ピンだけ表示のトグル
  overlay.querySelector('#plan-pin-filter-btn').addEventListener('click', () => {
    planPinOnly = !planPinOnly;
    renderPlanBoard();
  });

  // BT-397: 計画画面を開くとヘッダーのタグ絞り込みが隠れるため、画面内にも同じボタンを置く（状態・条件はヘッダーと共通）
  overlay.querySelector('#plan-tag-filter-btn').addEventListener('click', (e) => toggleTagFilterPopover(e.currentTarget));
  overlay.querySelector('#plan-category-filter-btn').addEventListener('click', (e) => toggleCategoryFilterPopover(e.currentTarget));
  renderTagFilterControls();
  renderCategoryFilterControls();

  // BT-315: 完了タスクを出すかどうかのトグル（週次カンバンのみ）
  overlay.querySelector('#plan-done-filter-btn').addEventListener('click', () => {
    planShowDone = !planShowDone;
    try { localStorage.setItem('planShowDone', planShowDone ? '1' : '0'); } catch { /* 無視 */ }
    renderPlanBoard();
  });

  return overlay;
}

// 直近の描画で「ストック列」に出したEPICグループのキー（全部開く/畳むの対象）
let planStockGroupKeys = [];

function planToggleAllGroups() {
  const keys = planStockGroupKeys;
  if (!keys.length) return;
  const anyCollapsed = keys.some((k) => planCollapsedGroups.has(k));
  keys.forEach((k) => {
    if (anyCollapsed) planCollapsedGroups.delete(k); else planCollapsedGroups.add(k);
  });
  renderPlanBoard();
}

// BT-447: ガントのカテゴリ見出しをタグ風チップで出すための色(カテゴリマスタ)。名前→色。
// 開くたびに取り直し、色が変わっていた時だけ描画し直す(取得前・失敗時は色なしのチップで出す)
let planCategoryColors = new Map();
async function planRefreshCategoryColors() {
  try {
    const res = await fetch('/api/categories');
    if (!res.ok) return;
    const body = await res.json();
    const next = new Map((body.categories || []).map((c) => [c.name, c.color || '']));
    const same = next.size === planCategoryColors.size && [...next].every(([k, v]) => planCategoryColors.get(k) === v);
    planCategoryColors = next;
    const overlay = document.getElementById('plan-board-overlay');
    if (!same && overlay && overlay.classList.contains('active') && planViewMode === 'gantt') renderPlanGantt();
    if (!same && lastBoardData) renderBoard(lastBoardData); // BT-454: ボードのカテゴリチップも色の変更に追随させる
  } catch { /* 色なしのチップで続行 */ }
}

// カテゴリ見出し用のチップ。タグのチップ(色つき・角丸)にカテゴリアイコンを前置きする。名前なし=カテゴリなしは色なし
function planCategoryChipHtml(name) {
  return categoryBadgeHtml(name);
}

// BT-454: ボード・詳細のカテゴリ表示。マスタの色(planCategoryColors)を引いて色付きチップにする
function categoryBadgeHtml(name, opts) {
  return categoryLogic.buildCategoryBadgeHtml(name, name ? planCategoryColors.get(name) : '', opts);
}

function openPlanBoard() {
  const overlay = getOrCreatePlanBoardModal();
  planRefreshCategoryColors();
  if (wsFilterPlanDropdown) wsFilterPlanDropdown.render(); // 開くたびに現在のcurrentFilter/件数で描画し直す
  overlay.classList.add('active');
  if (window.ganttView) window.ganttView.resetScroll(); // ガントは開くたびに今日の位置から見せる
  planApplyViewMode();
  renderPlanBoard();
}

function closePlanBoard() {
  const overlay = document.getElementById('plan-board-overlay');
  if (overlay) overlay.classList.remove('active');
  if (window.ganttView) window.ganttView.hideTip();
}

// WS経由のボード更新受信時、週次計画ビューが開いていれば最新データで再描画する
// (ドロップ直後のrenderPlanBoard()はupdate-task完了直後でまだlastBoardDataが古いままのため、
//  WS更新が届いたこのタイミングで改めて描画し直すことで実際の反映を保証する)
function refreshPlanBoardIfOpen() {
  const overlay = document.getElementById('plan-board-overlay');
  if (overlay && overlay.classList.contains('active')) renderPlanBoard();
}

// --- Today Flag Toggle ---
async function toggleTodayFlag(taskId, value) {
  try {
    const resp = await fetch('/api/toggle-today', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, value }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      console.error('[today] Toggle failed:', err.error);
    }
  } catch (e) {
    console.error('[today] Network error:', e);
  }
}

// --- Running Toggle (BT-277) ---
// 実行中タスクは親EPIC・単体とも、詳細モーダルから個別に停止できる。
// API側の実行セッション記録を通すため、表示だけを消すのではなく必ずAPIを呼ぶ。
async function stopRunningTask(taskId, button) {
  button.disabled = true;
  button.textContent = '停止中...';
  try {
    const resp = await fetch('/api/toggle-running', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, value: false }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || '実行中の停止に失敗しました');
    }
  } catch (e) {
    console.error('[running] Stop failed:', e);
    button.disabled = false;
    button.innerHTML = '<span class="material-icon icon-stop"></span> 停止';
    alert(e.message || '実行中の停止に失敗しました');
  }
}

// --- Card Detail Modal ---
let modalEl = null;
let currentModalItemId = null;
let activityHighlightTaskIds = null; // 履歴(activity.js)からEpicを開いた際にハイライトする子タスクIDのSet

function getOrCreateModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement('div');
  modalEl.className = 'modal-overlay';
  modalEl.innerHTML = `
    <div class="modal-content detail-modal-content">
      <button class="modal-close">&times;</button>
      <div class="modal-body"></div>
    </div>
  `;
  document.body.appendChild(modalEl);

  closeOnBackdropClick(modalEl, closeModal);
  modalEl.querySelector('.modal-close').addEventListener('click', closeModal);
  closeOnEscape(modalEl, 'modal-visible', closeModal);

  return modalEl;
}

function closeModal() {
  if (modalEl) {
    modalEl.classList.remove('modal-visible');
    currentModalItemId = null;
    modalParentEpic = null;
    activityHighlightTaskIds = null;
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

// 子タスクはトップレベルitemではなく親の children に入っているため、親を辿って探す
function findChildItemById(id) {
  if (!currentBoardData) return null;
  for (const col of currentBoardData.columns) {
    for (const item of col.items) {
      const child = (item.children || []).find((c) => c.id === id);
      if (child) return child;
    }
  }
  return null;
}

// BM-066: 子タスクIDから、それを含む親Epic itemを探す（URL起動時にEPIC＋ハイライトで開くため）
function findParentEpicOfChildId(id) {
  if (!currentBoardData) return null;
  for (const col of currentBoardData.columns) {
    for (const item of col.items) {
      if ((item.children || []).some((c) => c.id === id)) return item;
    }
  }
  return null;
}

// 最後にモーダルへ描画した完全なitem(description取得済み)をタスクIDで保持する。
// BM-083: WebSocketのboard再送(他ユーザー/他タブの操作含む)でrefreshModalIfOpen/
// refreshChildModalIfOpenが呼ばれるたびにfindItemById(軽量版、descriptionキー無し)で
// 作り直すと、せっかく非同期取得した説明文が「読み込み中...」に戻ってしまう。
// 直前に完全データで描画したタスクであれば、再送されたitemのdescription以外のフィールド
// (status等、WS再送で更新されうる値)だけ使い、descriptionは保持済みの値を引き継ぐ。
let lastRenderedFullItemById = new Map(); // taskId -> 完全なitem(description含む)

function mergeKeepingDescription(lightItem) {
  if (!lightItem || !lightItem.id) return lightItem;
  if (Object.prototype.hasOwnProperty.call(lightItem, 'description')) {
    lastRenderedFullItemById.set(lightItem.id, lightItem);
    return lightItem;
  }
  const prevFull = lastRenderedFullItemById.get(lightItem.id);
  if (!prevFull) return lightItem; // まだ完全データを持っていない(初回取得中)ので軽量版のまま
  return { ...lightItem, description: prevFull.description };
}

// BM-089: 子詳細モーダル(BT-366)と同じ考え方で、編集フォーム表示中は未保存の入力を
// 壊さないよう再描画をスキップする。ボード全体やティッカー等(呼び出し元のws.message内の他処理)
// は引き続き毎回更新されるため、ここで止まるのはこの1モーダルの表示だけ。
function refreshModalIfOpen() {
  refreshChildModalIfOpen();
  if (!currentModalItemId || !modalEl || !modalEl.classList.contains('modal-visible')) return;
  if (modalEl.querySelector('#edit-task-title')) return;
  // BM-136: コメント欄に書きかけの文字がある間は、入力が消えないよう再描画しない（編集フォームと同じ扱い）
  if (hasCommentDraft(modalEl)) return;
  const item = findItemById(currentModalItemId);
  if (item) renderModalContent(mergeKeepingDescription(item));
}

// BT-366: 子詳細モーダルもWS更新で最新化する（停止ボタン押下後に「停止中...」のまま残るのを防ぐ）。
// 編集フォーム表示中は入力を壊さないため再描画しない。
function refreshChildModalIfOpen() {
  if (!currentChildModalItemId) return;
  const el = document.getElementById('child-modal-overlay');
  if (!el || !el.classList.contains('modal-visible')) return;
  if (el.querySelector('#edit-task-title')) return;
  if (hasCommentDraft(el)) return; // BM-136: 書きかけのコメントを守る
  const item = mergeKeepingDescription(findChildItemById(currentChildModalItemId) || findItemById(currentChildModalItemId));
  if (item) openChildModal(item);
}

function openCardDetail(item, parentEpic = null) {
  if (parentEpic) {
    // 子タスク詳細 → 2枚目モーダルを重ねる
    openChildModal(item, parentEpic);
  } else {
    // 通常のカード詳細
    const modal = getOrCreateModal();
    currentModalItemId = item.id;
    modalParentEpic = null;
    modal.classList.add('modal-visible');
    renderModalContent(item);
    loadFullDescriptionIfMissing(item, currentModalItemId, renderModalContent);
  }
}

// BM-083/BM-084: board用の軽量item(descriptionキーを持たない)が渡された場合、まず軽量な内容で
// 即座に描画(呼び出し元で既に実施済み)したうえで、/api/task/:idから完全なデータ(description含む)を
// 非同期取得して再描画する。取得完了までの間にモーダル/TIPが閉じられた・別タスクに切り替わっていた
// 場合は再描画しない。isStillValidを省略した場合は詳細モーダル(currentModalItemId/
// currentChildModalItemId)向けの判定を使う(既存呼び出し元との後方互換)。クイックTIP等、
// 独自の状態管理を持つ呼び出し元はisStillValidコールバックを渡して判定方法を差し替えられる。
async function loadFullDescriptionIfMissing(item, expectedModalItemId, rerender, isStillValid = null) {
  if (Object.prototype.hasOwnProperty.call(item, 'description')) {
    lastRenderedFullItemById.set(item.id, item); // 既に完全なデータ(検索結果経由等)。キャッシュだけ更新
    return;
  }
  if (!item.id || item.id === '-') return;
  try {
    const res = await fetch(`/api/task/${encodeURIComponent(item.id)}`);
    if (!res.ok) return;
    const full = await res.json();
    lastRenderedFullItemById.set(item.id, full); // WS再送時にdescriptionを保持するためキャッシュしておく
    const stillValid = isStillValid
      ? isStillValid()
      : (currentModalItemId === expectedModalItemId || currentChildModalItemId === expectedModalItemId);
    if (!stillValid) return;
    rerender(full);
  } catch (e) {
    console.error('[detail] Failed to load full task detail:', e);
  }
}

// 履歴(activity.js)からEpicを開く専用入口。指定した子タスクIDをミニボードでハイライトする(BT-246)。
function openEpicWithHighlight(epicItem, highlightTaskIds) {
  activityHighlightTaskIds = new Set(highlightTaskIds);
  openCardDetail(epicItem);
}

// BM-066: 起動時URL(?id=BM-xxx)で指定されたタスクの詳細を自動的に開く。
// WS初回受信によるrenderBoard後に1回だけ呼ばれる想定(urlTaskOpenAttemptedで多重実行を防止)。
// 子タスクが指定された場合は単体で開かず、親EpicをopenEpicWithHighlightで開いて
// 該当カードをハイライトする(「親や兄弟も見たい」という利用シーンのため、BM-066合意事項)。
let urlTaskOpenAttempted = false;

async function openTaskFromUrlIfPresent() {
  if (urlTaskOpenAttempted) return;
  const taskId = getUrlTaskIdParam();
  if (!taskId) return;
  urlTaskOpenAttempted = true;

  const topLevelItem = findItemById(taskId);
  // BT-201/BT-240: 完了済み子タスクはDONE列にparentId付きの単独item(ミラー)としても
  // 混在するため、通常のtop-level判定より先にparentIdの有無で子タスクかどうかを見分ける
  // (見分けないと、完了済み子タスクだけ親Epicを経由せず単体モーダルで開いてしまう)
  if (topLevelItem && topLevelItem.parentId) {
    const parentEpic = findItemById(topLevelItem.parentId);
    if (parentEpic) {
      openEpicWithHighlight(parentEpic, [taskId]);
      return;
    }
  }
  if (topLevelItem) {
    openCardDetail(topLevelItem);
    return;
  }

  const parentEpic = findParentEpicOfChildId(taskId);
  if (parentEpic) {
    openEpicWithHighlight(parentEpic, [taskId]);
    return;
  }

  // ボード上(currentBoardData)に見つからない場合の救済。削除済み・論理削除直後等で
  // boardの再送に乗っていないケースを想定し、/api/task/:idを最後に1回だけ試す。
  const full = await fetchTaskDetail(taskId);
  if (!full) {
    alert(`指定されたタスク（${taskId}）が見つかりませんでした。削除されたか、IDが間違っている可能性があります。`);
    return;
  }
  openCardDetail(full);
}

function getOrCreateChildModal() {
  let el = document.getElementById('child-modal-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'child-modal-overlay';
  el.className = 'modal-overlay child-modal-overlay';
  el.innerHTML = `
    <div class="modal-content child-modal-content detail-modal-content">
      <button class="modal-close" id="child-modal-close">&times;</button>
      <div class="modal-body"></div>
    </div>
  `;
  document.body.appendChild(el);
  closeOnBackdropClick(el, closeChildModal);
  el.querySelector('#child-modal-close').addEventListener('click', closeChildModal);
  closeOnEscape(el, 'modal-visible', closeChildModal);
  return el;
}

let currentChildModalItemId = null; // 開いている子詳細モーダルのタスクID（BT-366）

function closeChildModal() {
  currentChildModalItemId = null;
  const el = document.getElementById('child-modal-overlay');
  if (el) el.classList.remove('modal-visible');
}

// BT-355: 子詳細モーダルの親解決。編集モード後の再描画(item単独で呼ばれる)でも消えないよう直近の親を保持する。
let currentChildParent = null; // { childId, epic }

function resolveChildParent(item, parentEpic) {
  // setupCardClickは子カードで true を渡すため、オブジェクトのときだけ親Epicとして扱う
  const epic = (parentEpic && typeof parentEpic === 'object' ? parentEpic : null) || (item.parentId ? findItemById(item.parentId) : null)
    || (currentChildParent && currentChildParent.childId === item.id ? currentChildParent.epic : null);
  if (epic) currentChildParent = { childId: item.id, epic };
  return epic;
}

function buildParentBreadcrumbHtml(epic, item) {
  const parentId = epic ? epic.id : item.parentId;
  if (!parentId) return '';
  const parentTitle = epic ? epic.title : item.parentTitle;
  return `<a class="detail-parent-crumb" href="#" data-parent-id="${escapeHtml(parentId)}" title="親タスクの詳細を開く"><span class="material-icon icon-stacks"></span><span class="detail-parent-crumb-id">${escapeHtml(parentId)}</span><span class="detail-parent-crumb-title">${escapeHtml(parentTitle || '')}</span><span class="detail-parent-crumb-arrow">›</span></a>`;
}

// BM-110: 編集・追加フォーム用のクリック不可パンくず。入力中の画面では遷移すると
// 未保存の変更が消えてしまうため、子タスク詳細(buildParentBreadcrumbHtml)と見た目は揃えつつクリックはさせない
function buildParentCrumbPreviewHtml(parentId, parentTitle) {
  if (!parentId) return '';
  return `<div class="detail-parent-crumb is-static"><span class="material-icon icon-stacks"></span><span class="detail-parent-crumb-id">${escapeHtml(parentId)}</span><span class="detail-parent-crumb-title">${escapeHtml(parentTitle || '')}</span></div>`;
}

// BM-110: フォーム先頭に置くパンくずの入れ物。初期描画時は親の有無に応じて最初から
// 確定した状態(is-visibleの有無)で返すため、開いた瞬間にガタつくことはない。
// 以後の出現/消失は updateParentCrumbSlot がCSSトランジションで滑らかにする。
function renderParentCrumbSlotHtml(idPrefix, parentId, parentTitle) {
  const visible = parentId ? ' is-visible' : '';
  const inner = parentId ? buildParentCrumbPreviewHtml(parentId, parentTitle) : '';
  return `<div class="parent-crumb-slot${visible}" id="${idPrefix}-parent-crumb-slot">${inner}</div>`;
}

// BM-110: 親タスク欄の変更に応じてスロットの中身と表示/非表示を更新する。
// parentTitleを省略した場合はボード上のデータから探す(ユーザーが候補から選んだ場合はここで見つかる)。
function updateParentCrumbSlot(slotEl, parentId, parentTitle) {
  if (!slotEl) return;
  if (parentId) {
    const title = parentTitle != null ? parentTitle : ((findItemById(parentId) || {}).title || '');
    slotEl.innerHTML = buildParentCrumbPreviewHtml(parentId, title);
    slotEl.classList.add('is-visible');
  } else {
    slotEl.classList.remove('is-visible');
  }
}

function openChildModal(item, parentEpic = null) {
  currentChildModalItemId = item.id;
  loadFullDescriptionIfMissing(item, item.id, (full) => openChildModal(full, parentEpic));
  const modal = getOrCreateChildModal();
  const body = modal.querySelector('.modal-body');
  const content = modal.querySelector('.modal-content');
  content.classList.remove('modal-wide');

  // BM-078: WS再描画で.modal-body全体を作り直すと説明欄等のスクロール位置が
  // 失われるため、renderModalContentと同様に保存・復元する（BM-137: 左右2領域）
  const prevScrollTops = captureDetailScroll(body);
  // BM-089: 説明欄「もっと見る」の展開状態も同様に保存・復元する（renderModalContentと同じ対策）
  const prevDescExpanded = !!body.querySelector('.description-collapsible.expanded');

  const parentCrumbHtml = buildParentBreadcrumbHtml(resolveChildParent(item, parentEpic), item);

  const statusBadge = buildDetailStatusBadgeHtml(item);
  const project = item.project ? `<span class="detail-tag project">${escapeHtml(item.project)}</span>` : '';
  const githubBadge = item.githubIssueNumber ? renderGithubIssueBadge(item.githubIssueNumber, item.githubIssueUrl) : '';
  const redmineBadge = renderRedmineIssueBadge(item.externalLinks); // BM-073
  const gitlabBadge = renderGitlabIssueBadge(item.externalLinks); // BM-074

  const desc = buildDescriptionSectionHtml(item);

  // 成果物セクション
  const artifactsHtml = buildArtifactsHtml(item);

  const metaHtml = buildMetaHtml(item);

  const detailSpinner = item.running ? '<span class="running-spinner detail-spinner"></span>' : '';

  // BM-028: 子タスクも実行中ならそのタスクだけを停止できる（renderModalContentの親/単体用ロジックと同じ条件）。
  const stopRunningBtnHtml = (item.id && item.id !== '-' && item.running)
    ? `<button class="detail-action-btn btn-stop-running" id="modal-stop-running-btn"><span class="material-icon icon-stop"></span> 停止</button>`
    : '';

  // 親から外すボタン（BT-034: attachの逆操作。単に外すだけで他の親には付け替えない）
  const detachBtn = (item.id && item.id !== '-')
    ? `<button class="add-child-btn detach-btn" id="modal-detach-btn"><span class="material-icon icon-lock-open"></span> 親から外す</button>`
    : '';

  // 編集・削除ボタン（BT-036/BT-031: 子タスクは常に単独削除可）
  const editBtnHtml = (item.id && item.id !== '-') ? `<button class="detail-action-btn btn-edit" id="modal-edit-btn"><span class="material-icon icon-edit"></span> 編集</button>` : '';
  // 複製ボタン（BM-061: 複製後は親に紐付けない独立したトップレベルタスクとして作成）
  const copyBtnHtml = (item.id && item.id !== '-') ? `<button class="detail-action-btn" id="modal-copy-btn"><span class="material-icon icon-content-copy"></span> 複製</button>` : '';
  const deleteBtnHtml = (item.id && item.id !== '-') ? `<button class="detail-action-btn danger" id="modal-delete-btn"><span class="material-icon icon-delete"></span> 削除</button>` : '';

  // GitHub Issue紐付けボタン（BT-122: カードと同じ操作を詳細モーダルにも配備）
  const githubLinkBtnHtml = (item.id && item.id !== '-' && !item.githubIssueNumber)
    ? `<button class="add-child-btn" id="modal-github-link-btn"><span class="material-icon icon-link"></span> GitHub Issueと紐づける</button>`
    : '';

  // GitHub Issue新規作成ボタン（BT-134）
  const githubCreateBtnHtml = (item.id && item.id !== '-' && !item.githubIssueNumber)
    ? `<button class="add-child-btn btn-add" id="modal-github-create-btn"><span class="material-icon icon-upload"></span> GitHub Issueを新規作成</button>`
    : '';

  // Redmineチケット紐付けボタン（BM-126: GitHubと同様にカードと詳細モーダルの両方に配備。上書き許可のため常に表示）
  const redmineLinkBtnHtml = (item.id && item.id !== '-')
    ? `<button class="add-child-btn" id="modal-redmine-link-btn">${REDMINE_MARK_SVG} Redmineチケットと紐づける</button>`
    : '';

  // ワークスペース導線ボタン（BT-053）
  const workspaceActionHtml = buildWorkspaceActionHtml(item);

  // ワークスペース移管ボタン（BT-063）
  const moveActionHtml = buildMoveActionHtml(item);

  // 今日やるピントグル（BM-061: タイトル右端）
  const titlePinBtnHtml = (item.id && item.id !== '-')
    ? `<button class="detail-title-pin-btn${item.todayFlag ? ' pin-active' : ''}" id="modal-title-pin-btn" data-task-id="${item.id}" title="今日やる"><span class="material-icon icon-keep"></span></button>`
    : '';

  const headerHtml = `
    ${parentCrumbHtml}
    <div class="detail-header">
      ${detailSpinner}<span class="detail-id">${escapeHtml(item.id || '-')}</span>
      ${statusBadge}
      ${project}${githubBadge}${redmineBadge}${gitlabBadge}
    </div>
    <h3 class="detail-title">${escapeHtml(item.title)}${titlePinBtnHtml}</h3>
    ${actionsRow(stopRunningBtnHtml, editBtnHtml, copyBtnHtml, deleteBtnHtml, workspaceActionHtml, moveActionHtml, detachBtn, githubLinkBtnHtml, githubCreateBtnHtml, redmineLinkBtnHtml)}
  `;

  // BM-136: コメント欄は右カラムの情報の下・成果物の上に置く。再描画で入力中の状態を失わないよう控えて戻す
  const prevCommentDraft = captureCommentDraft(body);
  const commentHtml = buildTaskCommentSectionHtml(item, 'modal');
  suppressQuickTipScrollClose();
  body.innerHTML = buildDetailSplitHtml({
    headerHtml,
    metaHtml,
    descHtml: desc,
    sideScrollHtml: commentHtml + artifactsHtml,
  });
  restoreCommentDraft(body, prevCommentDraft);
  hydrateCommentSections(body, item);

  // BM-078: スクロール位置の復元（BM-137: 左右2領域）
  restoreDetailScroll(body, prevScrollTops);

  // 親パンくずのクリック（BT-355）: 子モーダルを閉じて親EPICの詳細へ戻る
  const parentCrumbEl = body.querySelector('.detail-parent-crumb');
  if (parentCrumbEl) {
    parentCrumbEl.addEventListener('click', (e) => {
      e.preventDefault();
      const epic = findItemById(parentCrumbEl.dataset.parentId);
      if (!epic) return;
      closeChildModal();
      pendingHighlightChildId = item.id;
      openCardDetail(epic);
    });
  }

  // 停止ボタンのイベント（BM-028）
  const stopRunningBtnEl = body.querySelector('#modal-stop-running-btn');
  if (stopRunningBtnEl) {
    stopRunningBtnEl.addEventListener('click', () => stopRunningTask(item.id, stopRunningBtnEl));
  }

  // 親から外すボタンのイベント
  const detachBtnEl = body.querySelector('#modal-detach-btn');
  if (detachBtnEl) {
    detachBtnEl.addEventListener('click', () => detachTask(item.id));
  }

  // GitHub Issue紐付けボタンのイベント（BT-122）
  const githubLinkBtnEl = body.querySelector('#modal-github-link-btn');
  if (githubLinkBtnEl) {
    githubLinkBtnEl.addEventListener('click', () => openGithubLinkModal(item));
  }

  // GitHub Issue新規作成ボタンのイベント（BT-134）
  const githubCreateBtnEl = body.querySelector('#modal-github-create-btn');
  if (githubCreateBtnEl) {
    githubCreateBtnEl.addEventListener('click', () => openGithubCreateConfirm(item, true));
  }

  // Redmineチケット紐付けボタンのイベント（BM-126）
  const redmineLinkBtnEl = body.querySelector('#modal-redmine-link-btn');
  if (redmineLinkBtnEl) {
    redmineLinkBtnEl.addEventListener('click', () => openRedmineLinkModal(item));
  }

  // 編集ボタンのイベント（BT-036: 子タスクは常に説明編集可）
  const editBtnEl = body.querySelector('#modal-edit-btn');
  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      enterEditMode(item, body, false, openChildModal);
    });
  }

  // 削除ボタンのイベント（BT-031）
  const deleteBtnEl = body.querySelector('#modal-delete-btn');
  if (deleteBtnEl) {
    deleteBtnEl.addEventListener('click', () => {
      openDeleteConfirm(item, true);
    });
  }

  // 複製ボタンのイベント（BM-061: 子タスク→親に紐付けない独立したトップレベルタスクとして複製）
  const copyBtnEl = body.querySelector('#modal-copy-btn');
  if (copyBtnEl) {
    copyBtnEl.addEventListener('click', async () => {
      // BM-083: board用の軽量item(descriptionキー無し)のまま複製すると説明文が空のタスクが
      // 作られてしまうため、クリックされた瞬間に完全なデータを確定させてから複製フォームを開く。
      let full = item;
      if (!Object.prototype.hasOwnProperty.call(item, 'description')) {
        full = lastRenderedFullItemById.get(item.id) || await fetchTaskDetail(item.id) || item;
      }
      openAddTaskForm('todo', full.project, '', { title: full.title, description: full.description });
    });
  }

  // 今日やるピントグルのイベント（BM-061: タイトル右端）
  const titlePinBtnEl = body.querySelector('#modal-title-pin-btn');
  if (titlePinBtnEl) {
    titlePinBtnEl.addEventListener('click', (e) => {
      e.preventDefault();
      const isActive = titlePinBtnEl.classList.contains('pin-active');
      titlePinBtnEl.classList.toggle('pin-active', !isActive);
      toggleTodayFlag(item.id, !isActive);
    });
  }

  // 成果物コピーボタンのイベント
  setupArtifactCopyButtons(body);

  // ワークスペース導線ボタンのイベント（BT-053）
  setupWorkspaceActionButtons(body, item);

  // プロジェクト移管ボタンのイベント（BT-063）
  setupMoveActionButton(body, item, true);

  modal.classList.add('modal-visible');

  // 説明欄の折りたたみトグル初期化（BT-080: 表示後でないとscrollHeightが取れない。BM-089: 直前の展開状態を復元）
  setupDescriptionToggle(body, { expanded: prevDescExpanded });
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
 * @param {boolean} isArchivedSingle - 完了済みアーカイブ単発タスクか（説明編集不可）
 * @param {(item: object) => void} renderFn - 表示モードに戻す際に呼ぶ描画関数
 */
function enterEditMode(item, body, isArchivedSingle, renderFn) {
  // BM-083: board用の軽量item(descriptionキー無し)で編集フォームを開くと、取得前の空文字を
  // 保存して本文を消してしまう事故になる。キーが無い場合は完全なデータを取得してから
  // 編集フォームを開き直す(キャッシュがあれば先にそれを使う、無ければ/api/task/:idを待つ)。
  if (!Object.prototype.hasOwnProperty.call(item, 'description')) {
    const cached = lastRenderedFullItemById.get(item.id);
    if (cached) {
      enterEditMode(cached, body, isArchivedSingle, renderFn);
    } else {
      fetchTaskDetail(item.id).then(full => {
        if (full) enterEditMode(full, body, isArchivedSingle, renderFn);
      });
    }
    return;
  }
  const descValue = item.description || '';
  const descField = isArchivedSingle
    ? `<div class="detail-section"><p class="archived-note">完了済みタスクのため説明は編集できないよ</p></div>`
    : `<div class="settings-group"><label>説明</label><textarea id="edit-task-description" rows="6" placeholder="説明を入力">${escapeHtml(descValue)}</textarea></div>`;
  const projects = (currentBoardData && currentBoardData.projects) || [];
  const projectOptions = projects.map(project =>
    `<option value="${escapeHtml(project)}"${project === item.project ? ' selected' : ''}>${escapeHtml(project)}</option>`
  ).join('');

  // BM-110: 単発タスクでも親を指定していれば、子タスク詳細と同じ見た目のパンくずを
  // ダイアログ先頭に出す（クリックは不可。入力中に遷移すると未保存の変更が消えるため）
  const initialParentIdForHeader = item.parentId || findParentIdOf(item.id);

  body.innerHTML = `
    ${renderParentCrumbSlotHtml('edit-task', initialParentIdForHeader, item.parentTitle || '')}
    <div class="detail-header">
      <span class="detail-id">${escapeHtml(item.id || '-')}</span>
    </div>
    <div class="edit-task-scroll">
      <div class="detail-layout edit-task-layout">
        <div class="detail-main">
          <div class="settings-group">
            <label>タイトル</label>
            <input type="text" id="edit-task-title" value="${escapeHtml(item.title)}">
          </div>
          ${descField}
        </div>
        <div class="detail-side">
          <div class="settings-group">
            <label>ワークスペース</label>
            <select id="edit-task-project">${projectOptions}</select>
          </div>
          <div class="settings-group">
            <label>親タスク（任意）</label>
            ${renderParentFieldHtml('edit-task')}
          </div>
          <div class="settings-group">
            <label>ステータス</label>
            <select id="edit-task-status">
              <option value="todo"${item.statusCode === 'todo' ? ' selected' : ''}>TODO</option>
              <option value="ready"${item.statusCode === 'ready' ? ' selected' : ''}>READY</option>
              <option value="do"${item.statusCode === 'do' ? ' selected' : ''}>DO</option>
              <option value="done"${item.statusCode === 'done' ? ' selected' : ''}>DONE</option>
            </select>
          </div>
          ${item.statusCode === 'done' ? `<div class="settings-group" id="edit-task-completed-group">
            <label>完了日時</label>
            <div class="add-task-completed-row">
              ${renderDateFieldHtml('edit-task-completed-date', item.completedDate || '')}
              <input type="time" id="edit-task-completed-time" class="time-field" value="${escapeHtml((item.completedTs || '').slice(0, 5))}">
            </div>
          </div>` : ''}
          <div class="settings-group">
            <label>カテゴリ（任意）</label>
            <div class="category-select-row">
              <select id="edit-task-category"><option value="">カテゴリなし</option>${(item.category && item.category !== '-') ? `<option value="${escapeHtml(item.category)}" selected>${escapeHtml(item.category)}</option>` : ''}</select>
              <button type="button" class="category-manage-link" data-form-kind="edit" title="カテゴリ管理を開く"><span class="material-icon icon-settings"></span></button>
            </div>
          </div>
          <div class="settings-group">
            <label>担当（任意）</label>
            <input type="text" id="edit-task-assignee" placeholder="担当者" value="${escapeHtml(item.assignee || '')}">
          </div>
          <div class="settings-group">
            <label>開始日（任意）</label>
            ${renderDateFieldHtml('edit-task-start-date', item.startDate)}
          </div>
          <div class="settings-group">
            <label>期日（任意）</label>
            ${renderDateFieldHtml('edit-task-due-date', item.dueDate)}
            <div class="due-quick-row">${renderDueQuickButtonsHtml()}</div>
          </div>
        </div>
      </div>
    </div>
    <p class="edit-task-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit" id="edit-task-save">保存</button>
      <button class="add-child-btn" id="edit-task-cancel">キャンセル</button>
    </div>
  `;

  const titleInput = body.querySelector('#edit-task-title');
  const descInput = body.querySelector('#edit-task-description');
  wireDescriptionPreview(descInput); // BT-462
  const projectInput = body.querySelector('#edit-task-project');
  const statusInput = body.querySelector('#edit-task-status');
  const categoryInput = body.querySelector('#edit-task-category');
  const assigneeInput = body.querySelector('#edit-task-assignee');
  const startDateInput = body.querySelector('#edit-task-start-date');
  const dueDateInput = body.querySelector('#edit-task-due-date');
  const completedDateInput = body.querySelector('#edit-task-completed-date');
  const completedTimeInput = body.querySelector('#edit-task-completed-time');
  const errorEl = body.querySelector('.edit-task-error');
  const saveBtn = body.querySelector('#edit-task-save');
  const cancelBtn = body.querySelector('#edit-task-cancel');

  cancelBtn.addEventListener('click', () => renderFn(item));

  // BM-106: カテゴリはシステム全体で一意なため、ワークスペースに関わらず全件を読み込む
  loadEditFormCategories(body, (item.category && item.category !== '-') ? item.category : '');

  // BT-432: 親タスク。現在の親を初期値にし、子を持つタスクは2階層制約のため設定不可にする
  const initialParentId = item.parentId || findParentIdOf(item.id);
  let savedParentId = initialParentId; // サーバー上の現在の親（保存の途中経過に合わせて更新する）
  const hasChildren = (item.children && item.children.length > 0) || item.childrenTotal > 0;
  const parentCrumbSlotEl = body.querySelector('#edit-task-parent-crumb-slot'); // BM-110
  const parentField = setupParentField(body.querySelector('#edit-task-parent-field'), {
    getProject: () => projectInput.value,
    excludeId: item.id,
    // BM-110: 親欄の変更をヘッダー先頭のパンくずにも反映する（CSSトランジションで滑らかに出現/消失）
    onChange: () => { updateSaveState(); updateParentCrumbSlot(parentCrumbSlotEl, parentField.getValue()); },
  });
  parentField.setValue(initialParentId, item.parentTitle || '');
  if (hasChildren) parentField.setDisabled(true, '子タスクを持つタスクは親を設定できないよ');

  // BT-367: 開いた時点の値を覚え、現在値と比較して差分がある時だけ保存ボタンを有効にする
  // （元に戻したら無効に戻る）。入力イベントは再判定のきっかけにだけ使う。
  const readFormValues = () => ({
    title: titleInput.value.trim(),
    description: descInput ? descInput.value : '',
    project: projectInput.value,
    parentId: parentField.getValue(),
    status: statusInput.value,
    category: categoryInput.value,
    assignee: assigneeInput.value.trim(),
    startDate: startDateInput.value,
    dueDate: dueDateInput.value,
    completedDate: completedDateInput ? completedDateInput.value : '',
    completedTime: completedTimeInput ? completedTimeInput.value : '',
  });
  const initialValues = readFormValues();
  const updateSaveState = () => {
    const current = readFormValues();
    saveBtn.disabled = !hasFormChanged(initialValues, current);
  };
  // BT-168: 編集中に変更がある間は背景クリックで閉じない。フォームが破棄済み（キャンセル・保存後）なら対象外
  const overlayEl = body.closest('.modal-overlay');
  if (overlayEl) {
    overlayEl._hasUnsavedChanges = () => saveBtn.isConnected && hasFormChanged(initialValues, readFormValues());
  }
  [titleInput, descInput, assigneeInput].forEach(el => { if (el) el.addEventListener('input', updateSaveState); });
  [projectInput, statusInput, categoryInput, startDateInput, dueDateInput, completedDateInput, completedTimeInput].filter(Boolean).forEach(el => el.addEventListener('change', updateSaveState));
  // BT-432: 親は同じワークスペースの中から選ぶため、ワークスペースを変えたら他ワークスペースの親は外す
  projectInput.addEventListener('change', () => {
    const current = parentField.getValue();
    const parent = current ? findItemById(current) : null;
    if (current && (!parent || parent.project !== projectInput.value)) parentField.clear();
    updateSaveState();
  });
  updateSaveState();

  // 期日クイック選択（BT-354）: 入力欄に反映するだけで、保存は「保存」ボタンで行う
  body.querySelectorAll('.due-quick-row .due-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      dueDateInput.value = btn.dataset.date;
      updateSaveState(); // valueの直接代入ではchangeが発火しないため明示的に再判定する
    });
  });

  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return; // BM-054: 連打防止(多重送信ガード)
    const newTitle = titleInput.value.trim();
    if (!newTitle) {
      errorEl.textContent = 'タイトルは必須だよ';
      errorEl.style.display = 'block';
      return;
    }

    const payload = {
      taskId: item.id,
      title: newTitle,
      category: categoryInput.value,
      assignee: assigneeInput.value.trim(),
      startDate: startDateInput.value,
      dueDate: dueDateInput.value,
    };
    if (descInput) payload.description = descInput.value;
    if (completedDateInput) {
      if (!completedDateInput.value) {
        errorEl.textContent = '完了日時を入力してね';
        errorEl.style.display = 'block';
        return;
      }
      const completedAt = `${completedDateInput.value}T${completedTimeInput.value || '00:00'}:00+09:00`;
      if (new Date(completedAt).getTime() > Date.now()) {
        errorEl.textContent = '完了日時は現在より未来にできないよ';
        errorEl.style.display = 'block';
        return;
      }
      payload.completedAt = completedAt;
    }

    // BM-054: 送信中はボタンをdisabled化し、処理中であることを示す(連打による多重送信を防ぐ)
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = '保存中...';
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
      // BT-432: 親の変更は update-task では扱えないため、detach/attach で反映する（付け替えは外してから付ける）。
      // 完了済みは親を付けられないので、ステータス更新より先に行う
      const newParentId = parentField.getValue();
      if (newParentId !== savedParentId) {
        if (savedParentId) {
          const detachResp = await fetch('/api/detach-from-parent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: item.id }),
          });
          const detachData = await detachResp.json();
          if (!detachResp.ok) {
            errorEl.textContent = `親から外すのに失敗したよ: ${detachData.error || ''}`;
            errorEl.style.display = 'block';
            return;
          }
          savedParentId = ''; // 外せた時点で状態を進め、付け直しだけが失敗した場合の再試行で二重に外さないようにする
        }
        if (newParentId) {
          const attachResp = await fetch('/api/attach-to-parent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskIds: [item.id], parentId: newParentId }),
          });
          const attachData = await attachResp.json();
          if (!attachResp.ok || (attachData.failed && attachData.failed.length > 0)) {
            errorEl.textContent = `親の設定に失敗したよ: ${attachData.error || (attachData.failed && attachData.failed[0] && attachData.failed[0].error) || ''}`;
            errorEl.style.display = 'block';
            return;
          }
        }
        savedParentId = newParentId;
        const newParent = newParentId ? findItemById(newParentId) : null;
        item.parentId = newParentId || undefined;
        item.parentTitle = newParent ? newParent.title : undefined;
      }
      if (statusInput.value !== item.statusCode) {
        const statusResp = await fetch('/api/update-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: item.id, newStatus: statusInput.value }),
        });
        const statusData = await statusResp.json();
        if (!statusResp.ok) {
          errorEl.textContent = `ステータス更新に失敗したよ: ${statusData.error || ''}`;
          errorEl.style.display = 'block';
          return;
        }
      }
      let updatedId = item.id;
      if (projectInput.value !== item.project) {
        const projectFileMap = (currentBoardData && currentBoardData.projectFileMap) || {};
        const targetFile = projectFileMap[projectInput.value] || projectInput.value;
        const moveResp = await fetch('/api/move-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: item.id, targetFile }),
        });
        const moveData = await moveResp.json();
        if (!moveResp.ok) {
          errorEl.textContent = `ワークスペース移動に失敗したよ: ${moveData.error || ''}`;
          errorEl.style.display = 'block';
          return;
        }
        updatedId = moveData.newId;
      }
      item.title = newTitle;
      if (descInput) item.description = descInput.value;
      item.category = categoryInput.value || '-';
      item.assignee = assigneeInput.value.trim() || null;
      item.startDate = startDateInput.value || null;
      item.dueDate = dueDateInput.value || null;
      if (completedDateInput) {
        item.completedDate = completedDateInput.value;
        item.completedTs = `${completedTimeInput.value || '00:00'}:00`;
      }
      item.statusCode = statusInput.value;
      if (updatedId !== item.id) lastRenderedFullItemById.delete(item.id);
      item.id = updatedId;
      item.project = projectInput.value;
      // BT-377: 保存後にWS再送で再描画されると、キャッシュ(mergeKeepingDescription)の古い説明が
      // 引き継がれて変更が戻って見えるため、保存した内容でキャッシュも更新する
      lastRenderedFullItemById.set(item.id, item);
      renderFn(item);
    } catch (e) {
      console.error('[edit] Network error:', e);
      errorEl.textContent = 'ネットワークエラーが発生したよ';
      errorEl.style.display = 'block';
    } finally {
      // BM-054: renderFn()で表示モードに戻った場合はこのボタンはDOMから外れているため無害、
      // エラーで同じフォームに留まる場合は再度押せるように戻す
      saveBtn.textContent = originalLabel;
      updateSaveState(); // BT-367: 失敗時は差分が残っているので有効に戻り、成功時はDOMごと破棄される
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
  el.className = 'modal-overlay modal-front';
  el.innerHTML = `<div class="modal-content delete-confirm-modal"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeDeleteConfirm();
  });
  closeOnEscape(el, 'modal-visible', closeDeleteConfirm);
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
  document.body.appendChild(el);
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
        body: JSON.stringify({ taskId: item.id }),
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
  el.className = 'modal-overlay modal-front';
  el.innerHTML = `<div class="modal-content github-link-modal"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeGithubLinkModal();
  });
  closeOnEscape(el, 'modal-visible', closeGithubLinkModal);
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
 */
function openGithubLinkModal(item) {
  const el = getOrCreateGithubLinkModal();
  document.body.appendChild(el);
  const content = el.querySelector('.modal-content');
  content.innerHTML = `
    <button class="modal-close" id="github-link-close">&times;</button>
    <h3 class="add-form-title"><span class="material-icon icon-link"></span> GitHub Issueと紐づける</h3>
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
        body: JSON.stringify({ taskId: item.id, issueNumber }),
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

// --- Redmineチケット紐付けダイアログ (BM-126: 既存タスクカードへ後から紐付ける。GitHubのopenGithubLinkModalと同じパターン) ---
function getOrCreateRedmineLinkModal() {
  let el = document.getElementById('redmine-link-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'redmine-link-overlay';
  el.className = 'modal-overlay modal-front';
  el.innerHTML = `<div class="modal-content github-link-modal"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeRedmineLinkModal();
  });
  closeOnEscape(el, 'modal-visible', closeRedmineLinkModal);
  return el;
}

function closeRedmineLinkModal() {
  const el = document.getElementById('redmine-link-overlay');
  if (el) el.classList.remove('modal-visible');
}

// チケット番号の生入力("123" / "#123" / チケットURL)から番号だけを取り出す(GitHubのparseIssueNumberInputと同じ考え方)
function parseRedmineIssueKeyInput(raw) {
  const s = (raw || '').trim();
  const urlMatch = /\/issues\/(\d+)/.exec(s);
  if (urlMatch) return urlMatch[1];
  const hashMatch = /^#?(\d+)$/.exec(s);
  if (hashMatch) return hashMatch[1];
  return s;
}

/**
 * Redmineチケット紐付けモーダルを開く(BM-126: 上書き許可のため、既にリンク済みでも常に開ける。
 * 既存リンクがあれば入力欄にプレフィルする)
 * @param {object} item - 紐付け対象タスク
 */
function openRedmineLinkModal(item) {
  const el = getOrCreateRedmineLinkModal();
  document.body.appendChild(el);
  const content = el.querySelector('.modal-content');
  const existing = (item.externalLinks || []).find((l) => l.source === 'redmine');
  const existingNote = existing
    ? `<p class="delete-confirm-text">現在 Redmine #${escapeHtml(existing.key)} に紐づいているよ。別のチケット番号を入れると上書きされるよ。</p>`
    : '';
  content.innerHTML = `
    <button class="modal-close" id="redmine-link-close">&times;</button>
    <h3 class="add-form-title"><span class="material-icon icon-link"></span> Redmineチケットと紐づける</h3>
    <p class="delete-confirm-text">「${escapeHtml(item.title)}」(${escapeHtml(item.id)}) に紐づけるチケット番号かURLを入力してね。</p>
    ${existingNote}
    <input type="text" id="redmine-link-input" class="parent-picker-search" placeholder="例: 123 / #123 / https://redmine.example.com/issues/123" value="${existing ? escapeHtml(existing.key) : ''}">
    <p class="delete-confirm-error" style="display:none;"></p>
    <div class="edit-form-actions">
      <button class="add-task-submit" id="redmine-link-ok">紐づける</button>
      <button class="add-child-btn" id="redmine-link-cancel">キャンセル</button>
    </div>
  `;

  content.querySelector('#redmine-link-close').addEventListener('click', closeRedmineLinkModal);
  content.querySelector('#redmine-link-cancel').addEventListener('click', closeRedmineLinkModal);
  content.querySelector('#redmine-link-ok').addEventListener('click', async () => {
    const errorEl = content.querySelector('.delete-confirm-error');
    const issueKey = parseRedmineIssueKeyInput(content.querySelector('#redmine-link-input').value);
    if (!issueKey) {
      errorEl.textContent = 'チケット番号を入力してね';
      errorEl.style.display = 'block';
      return;
    }
    try {
      const resp = await fetch('/api/its-link-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: item.id, source: 'redmine', issueKey }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errorEl.textContent = data.error || '紐づけに失敗したよ';
        errorEl.style.display = 'block';
        return;
      }
      closeRedmineLinkModal();
    } catch (e) {
      console.error('[redmine-link] Network error:', e);
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
  el.className = 'modal-overlay modal-front';
  el.innerHTML = `<div class="modal-content delete-confirm-modal"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el) closeGithubCreateConfirm();
  });
  closeOnEscape(el, 'modal-visible', closeGithubCreateConfirm);
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
  document.body.appendChild(el);
  const content = el.querySelector('.modal-content');
  const isEpic = !isChild && Array.isArray(item.children) && item.children.length > 0;
  const epicNote = isEpic
    ? `<p class="delete-confirm-text">子タスク ${item.children.length}件 もGitHub Issueとして作成し、Sub-issueとして紐づけるよ。</p>`
    : '';
  content.innerHTML = `
    <button class="modal-close" id="github-create-confirm-close">&times;</button>
    <h3 class="add-form-title"><span class="material-icon icon-upload"></span> GitHub Issueを新規作成</h3>
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
        body: JSON.stringify({ taskId: item.id }),
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
  document.body.appendChild(el);
  const content = el.querySelector('.modal-content');
  const skipNote = alreadyLinkedCount > 0
    ? `<p class="delete-confirm-text">連携済みの ${alreadyLinkedCount}件 は対象外にするよ。</p>`
    : '';
  content.innerHTML = `
    <button class="modal-close" id="github-create-confirm-close">&times;</button>
    <h3 class="add-form-title"><span class="material-icon icon-upload"></span> GitHub Issueを一括作成</h3>
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
          body: JSON.stringify({ taskId: item.id }),
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

  // BM-078: WS再描画(ピン留め等)で.modal-body全体を作り直すと、EPIC詳細の
  // ミニボードをスクロールしていた場合に先頭へ飛ばされるため、位置を保存・復元する（BM-137: 左右2領域）
  const prevScrollTops = captureDetailScroll(body);
  // BM-089: 同様に、説明欄「もっと見る」で展開して読んでいる最中にWS再描画が走ると
  // 折りたたみ状態に戻ってしまう(見た目上「閉じられた」ように感じる)ため、展開状態も保存・復元する
  const prevDescExpanded = !!body.querySelector('.description-collapsible.expanded');

  const isEpic = item.children && item.children.length > 0;
  content.classList.toggle('modal-wide', isEpic);

  const statusBadge = buildDetailStatusBadgeHtml(item);
  const project = item.project ? `<span class="detail-tag project">${escapeHtml(item.project)}</span>` : '';
  const githubBadge = item.githubIssueNumber ? renderGithubIssueBadge(item.githubIssueNumber, item.githubIssueUrl) : '';
  const redmineBadge = renderRedmineIssueBadge(item.externalLinks); // BM-073
  const gitlabBadge = renderGitlabIssueBadge(item.externalLinks); // BM-074

  let badgeHtml = '';
  if (item.childrenTotal) {
    const allDone = item.childrenDone === item.childrenTotal;
    const badgeClass = allDone ? 'badge-done' : '';
    badgeHtml = `<span class="card-badge ${badgeClass}"><span class="badge-num"><span class="material-icon icon-check"></span>${item.childrenDone}</span><span class="badge-den">/${item.childrenTotal}</span></span>`;
  }

  const desc = buildDescriptionSectionHtml(item);

  // 成果物セクション
  const artifactsHtml = buildArtifactsHtml(item);

  const metaHtml = buildMetaHtml(item);

  let miniBoard = '';
  if (isEpic) {
    miniBoard = '<div class="mini-board" id="mini-board"></div>';
  }

  // 子タスク追加ボタン（Epicでも非Epicでも表示）
  const addChildBtn = (item.id && item.id !== '-')
    ? `<button class="add-child-btn btn-add" id="modal-add-child-btn">＋ 子タスクを追加</button>`
    : '';

  // 親を設定ボタン（BT-034: 単独タスク→その場でEPIC化。子を持つ/完了済みは対象外）
  const setParentBtn = (item.id && item.id !== '-' && !isEpic && item.statusCode !== 'done')
    ? `<button class="add-child-btn" id="modal-set-parent-btn"><span class="material-icon icon-link"></span> 親を設定</button>`
    : '';

  // BT-277: 親EPICか単体かを問わず、実行中ならそのタスクだけを停止できる。
  const stopRunningBtnHtml = (item.id && item.id !== '-' && item.running)
    ? `<button class="detail-action-btn btn-stop-running" id="modal-stop-running-btn"><span class="material-icon icon-stop"></span> 停止</button>`
    : '';

  const detailSpinner = item.running ? '<span class="running-spinner detail-spinner"></span>' : '';

  // 編集・削除ボタン（BT-036/BT-031: 子ありEpicは削除不可のため削除ボタンを出さない）
  const editBtnHtml = (item.id && item.id !== '-') ? `<button class="detail-action-btn btn-edit" id="modal-edit-btn"><span class="material-icon icon-edit"></span> 編集</button>` : '';
  // 複製ボタン（BM-061: EPICは子タスクの集計表示のため操作対象外とし出さない）
  const copyBtnHtml = (item.id && item.id !== '-' && !isEpic) ? `<button class="detail-action-btn" id="modal-copy-btn"><span class="material-icon icon-content-copy"></span> 複製</button>` : '';
  const deleteBtnHtml = (item.id && item.id !== '-' && !isEpic) ? `<button class="detail-action-btn danger" id="modal-delete-btn"><span class="material-icon icon-delete"></span> 削除</button>` : '';

  // GitHub Issue紐付けボタン（BT-122: カードと同じ操作を詳細モーダルにも配備）
  const githubLinkBtnHtml = (item.id && item.id !== '-' && !item.githubIssueNumber)
    ? `<button class="add-child-btn" id="modal-github-link-btn"><span class="material-icon icon-link"></span> GitHub Issueと紐づける</button>`
    : '';

  // GitHub Issue新規作成ボタン（BT-134: Epicの場合は子タスクもsub-issueとして一括作成）
  const githubCreateBtnHtml = (item.id && item.id !== '-' && !item.githubIssueNumber)
    ? `<button class="add-child-btn btn-add" id="modal-github-create-btn"><span class="material-icon icon-upload"></span> GitHub Issueを新規作成</button>`
    : '';

  // Redmineチケット紐付けボタン（BM-126: GitHubと同様にカードと詳細モーダルの両方に配備。上書き許可のため常に表示）
  const redmineLinkBtnHtml = (item.id && item.id !== '-')
    ? `<button class="add-child-btn" id="modal-redmine-link-btn">${REDMINE_MARK_SVG} Redmineチケットと紐づける</button>`
    : '';

  // ワークスペース導線ボタン（BT-053）
  const workspaceActionHtml = buildWorkspaceActionHtml(item);

  // ワークスペース移管ボタン（BT-063: 子ありEpicはサーバー側でも拒否されるため出さない）
  const moveActionHtml = (!isEpic && item.statusCode !== 'done') ? buildMoveActionHtml(item) : '';

  // 今日やるピントグル（BM-061: タイトル右端。EPICは子タスクの集計表示のため出さない）
  const titlePinBtnHtml = (item.id && item.id !== '-' && !isEpic)
    ? `<button class="detail-title-pin-btn${item.todayFlag ? ' pin-active' : ''}" id="modal-title-pin-btn" data-task-id="${item.id}" title="今日やる"><span class="material-icon icon-keep"></span></button>`
    : '';

  const headerHtml = `
    <div class="detail-header">
      ${detailSpinner}<span class="detail-id">${escapeHtml(item.id || '-')}</span>
      ${statusBadge}
      ${badgeHtml}
      ${project}${githubBadge}${redmineBadge}${gitlabBadge}
    </div>
    <h3 class="detail-title"><span class="detail-title-text">${isEpic ? '<span class="epic-title-chip" title="親タスク（子タスクを束ねるEpic）"><span class="material-icon icon-stacks"></span></span>' : ''}${escapeHtml(item.title)}</span>${titlePinBtnHtml}</h3>
    ${actionsRow(stopRunningBtnHtml, editBtnHtml, copyBtnHtml, deleteBtnHtml, addChildBtn, setParentBtn, workspaceActionHtml, moveActionHtml, githubLinkBtnHtml, githubCreateBtnHtml, redmineLinkBtnHtml)}
  `;

  // BM-136: コメント欄は右カラムの情報の下・成果物の上に置く。再描画で入力中の状態を失わないよう控えて戻す
  const prevCommentDraft = captureCommentDraft(body);
  const commentHtml = buildTaskCommentSectionHtml(item, 'modal');
  suppressQuickTipScrollClose();
  // BM-137: EPICのミニボードは左カラムのスクロール領域に入れる（説明の下。右のコメントは見えたまま）
  body.innerHTML = buildDetailSplitHtml({
    headerHtml,
    metaHtml,
    descHtml: desc,
    sideScrollHtml: commentHtml + artifactsHtml,
    footerHtml: miniBoard,
  });
  restoreCommentDraft(body, prevCommentDraft);
  hydrateCommentSections(body, item);

  // BM-078: スクロール位置の復元（BM-137: 左右2領域）
  restoreDetailScroll(body, prevScrollTops);

  // 説明欄の折りたたみトグル初期化（BT-080。BM-089: 直前の展開状態を復元）
  setupDescriptionToggle(body, { expanded: prevDescExpanded });

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
      openAddTaskForm('todo', item.project, item.id);
    });
  }

  // 親を設定ボタンのイベント（BT-034）
  const setParentBtnEl = body.querySelector('#modal-set-parent-btn');
  if (setParentBtnEl) {
    setParentBtnEl.addEventListener('click', () => {
      openParentPicker([item.id]);
    });
  }

  const stopRunningBtnEl = body.querySelector('#modal-stop-running-btn');
  if (stopRunningBtnEl) {
    stopRunningBtnEl.addEventListener('click', () => stopRunningTask(item.id, stopRunningBtnEl));
  }

  // GitHub Issue紐付けボタンのイベント（BT-122）
  const githubLinkBtnEl = body.querySelector('#modal-github-link-btn');
  if (githubLinkBtnEl) {
    githubLinkBtnEl.addEventListener('click', () => openGithubLinkModal(item));
  }

  // GitHub Issue新規作成ボタンのイベント（BT-134）
  const githubCreateBtnEl = body.querySelector('#modal-github-create-btn');
  if (githubCreateBtnEl) {
    githubCreateBtnEl.addEventListener('click', () => openGithubCreateConfirm(item, false));
  }

  // Redmineチケット紐付けボタンのイベント（BM-126）
  const redmineLinkBtnEl = body.querySelector('#modal-redmine-link-btn');
  if (redmineLinkBtnEl) {
    redmineLinkBtnEl.addEventListener('click', () => openRedmineLinkModal(item));
  }

  // 編集ボタンのイベント（BT-036: 完了済み単発タスクは説明編集不可）
  const editBtnEl = body.querySelector('#modal-edit-btn');
  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      const isArchivedSingle = !isEpic && item.statusCode === 'done';
      enterEditMode(item, body, isArchivedSingle, renderModalContent);
    });
  }

  // 削除ボタンのイベント（BT-031）
  const deleteBtnEl = body.querySelector('#modal-delete-btn');
  if (deleteBtnEl) {
    deleteBtnEl.addEventListener('click', () => {
      openDeleteConfirm(item, false);
    });
  }

  // 複製ボタンのイベント（BM-061: タイトル・説明だけ引き継いだ新規作成フォームを開く）
  const copyBtnEl = body.querySelector('#modal-copy-btn');
  if (copyBtnEl) {
    copyBtnEl.addEventListener('click', async () => {
      // BM-083: board用の軽量item(descriptionキー無し)のまま複製すると説明文が空のタスクが
      // 作られてしまうため、クリックされた瞬間に完全なデータを確定させてから複製フォームを開く。
      let full = item;
      if (!Object.prototype.hasOwnProperty.call(item, 'description')) {
        full = lastRenderedFullItemById.get(item.id) || await fetchTaskDetail(item.id) || item;
      }
      openAddTaskForm('todo', full.project, '', { title: full.title, description: full.description });
    });
  }

  // 今日やるピントグルのイベント（BM-061: タイトル右端）
  const titlePinBtnEl = body.querySelector('#modal-title-pin-btn');
  if (titlePinBtnEl) {
    titlePinBtnEl.addEventListener('click', (e) => {
      e.preventDefault();
      const isActive = titlePinBtnEl.classList.contains('pin-active');
      titlePinBtnEl.classList.toggle('pin-active', !isActive);
      toggleTodayFlag(item.id, !isActive);
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
    let matchedChildren = children.filter(c => col.match.includes(c.statusCode));
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
    // EPIC詳細のDONE列もメインボードと同様に完了日時順を維持する。
    if (!isDoneCol) matchedChildren = columnSort.sortItems(matchedChildren, columnSortMode(col.id));

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
      ? `<button class="done-today-btn${doneTodayOnly ? ' filter-active' : ''}" data-mini-done-today="1" title="本日完了分のみ表示（達成感モード）"><span class="material-icon icon-celebration"></span> 今日</button>`
      : '';
    let countHtml;
    if (miniDoneTodayActive) {
      countHtml = `<span class="count done-today-count"><span class="material-icon icon-celebration"></span> ${matchedChildren.length}</span>`;
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
          ${!isDoneCol ? columnSortSelectHtml(col.id) : ''}
          ${countHtml}
          <button class="add-task-btn add-task-btn-mini" data-col-status="${col.match[0]}" data-parent-id="${epic.id}" data-project="${epic.project}" title="子タスク追加">+</button>
        </div>
      </div>
      <div class="mini-col-body"></div>
    `;

    const body = colEl.querySelector('.mini-col-body');
    setupDropZone(body, col.id, col.match);

    for (const child of matchedChildren) {
      const card = document.createElement('div');
      card.className = 'card card-child card-draggable';
      if (child.todayFlag) card.classList.add('card-today');
      if (child.running) card.classList.add('is-running');
      if (activityHighlightTaskIds && activityHighlightTaskIds.has(child.id)) card.classList.add('card-activity-highlight');
      card.dataset.project = epic.project;
      card.setAttribute('draggable', 'true');
      card.dataset.taskId = child.id;

      card.addEventListener('dragstart', (e) => {
        // BM-113: setupDropZone側はlaneKey省略でnull固定のため、ここもlane: nullを
        // 明示しないとBM-049のレーン一致ガード(dragData.lane !== laneKey)で
        // undefined !== null が常にtrueになり、ドロップが毎回弾かれてしまう
        dragData = { id: child.id, sourceColId: col.id, lane: null };
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
        mParts.push(categoryBadgeHtml(child.category, { small: true }));
      }
      if (child.assignee) {
        mParts.push(`<span class="card-tag">${escapeHtml(child.assignee)}</span>`);
      }
      if (child.artifacts && child.artifacts.length > 0) {
        mParts.push('<span class="card-tag artifact-indicator" title="成果物あり"><span class="material-icon icon-attach-file"></span></span>');
      }
      if (child.githubIssueNumber) {
        mParts.push(renderGithubIssueBadge(child.githubIssueNumber, child.githubIssueUrl));
      }
      const childRedmineBadge = renderRedmineIssueBadge(child.externalLinks); // BM-073
      if (childRedmineBadge) mParts.push(childRedmineBadge);
      const childGitlabBadge = renderGitlabIssueBadge(child.externalLinks); // BM-074
      if (childGitlabBadge) mParts.push(childGitlabBadge);
      if (child.dueDate) {
        mParts.push(renderDueDateBadge(child.dueDate, child.statusCode));
      }
      if (child.completedDate) {
        mParts.push(renderCompletedDateBadge(child.completedDate));
      }
      if (child.tags && child.tags.length > 0) {
        mParts.push(tagLogic.buildCardTagsHtml(child.tags, null));
      }
      const mHtml = mParts.length > 0 ? `<div class="card-meta">${mParts.join('')}</div>` : '';

      // ピンボタン（ミニボード子カード）
      const childPinHtml = child.id
        ? `<button class="today-pin-btn${child.todayFlag ? ' pin-active' : ''}" data-task-id="${child.id}" title="今日やる"><span class="material-icon icon-keep"></span></button>`
        : '';

      // 編集・GitHub紐付け・削除ボタン（ミニボード子カード、BT-041: 子タスクは常に単独削除可。BT-122でGitHub紐付けボタンを追加）
      const childActionsHtml = child.id
        ? `<div class="card-actions">
            <button class="card-action-btn card-child-due-btn" data-task-id="${child.id}" title="期日を設定"><span class="material-icon icon-calendar-month"></span></button>
            <button class="card-action-btn card-tag-btn" data-task-id="${child.id}" title="タグを付け外し"><span class="material-icon icon-tag"></span></button>
            <button class="card-action-btn card-category-btn" data-task-id="${child.id}" title="カテゴリを設定"><span class="material-icon icon-stacks"></span></button>
            <button class="card-action-btn card-comment-btn" data-task-id="${child.id}" title="コメントを書く"><span class="material-icon icon-add-comment"></span></button>
            <button class="card-action-btn card-child-edit-btn" data-task-id="${child.id}" title="編集"><span class="material-icon icon-edit"></span></button>
            ${!child.githubIssueNumber ? `<button class="card-action-btn card-child-github-link-btn" data-task-id="${child.id}" title="GitHub Issueと紐づける"><span class="material-icon icon-link"></span></button>` : ''}
            ${!child.githubIssueNumber ? `<button class="card-action-btn card-child-github-create-btn" data-task-id="${child.id}" title="GitHub Issueを新規作成"><span class="material-icon icon-upload"></span></button>` : ''}
            <button class="card-action-btn card-child-redmine-link-btn" data-task-id="${child.id}" title="Redmineチケットと紐づける">${REDMINE_MARK_SVG}</button>
            <button class="card-action-btn card-child-delete-btn danger" data-task-id="${child.id}" title="削除"><span class="material-icon icon-delete"></span></button>
          </div>`
        : '';

      card.innerHTML = `${childPinHtml}${childActionsHtml}${childId}${childTitle}${mHtml}`;
      card.classList.add('card-clickable');
      setupTaskQuickTip(card, { ...child, project: epic.project });
      card.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        // childにproject情報を付与（リンク生成用）
        const childWithProject = { ...child, project: epic.project };
        openCardDetail(childWithProject, epic);
      });

      // 期日ボタンのイベント（BT-354）
      const childDueBtnEl = card.querySelector('.card-child-due-btn');
      if (childDueBtnEl) {
        childDueBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          openDueDatePicker(childDueBtnEl, child.dueDate, (date) => planUpdateDueDate(child.id, date));
        });
      }

      // タグボタンのイベント（BT-448）
      const childTagBtnEl = card.querySelector('.card-tag-btn');
      if (childTagBtnEl) {
        childTagBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          openCardTagPicker(childTagBtnEl);
        });
      }

      // カテゴリボタンのイベント（BT-445）
      const childCategoryBtnEl = card.querySelector('.card-category-btn');
      if (childCategoryBtnEl) {
        childCategoryBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          openCardCategoryPicker(childCategoryBtnEl);
        });
      }

      // コメントボタンのイベント（BM-136）
      const childCommentBtnEl = card.querySelector('.card-comment-btn');
      if (childCommentBtnEl) {
        childCommentBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          openCardCommentTip(childCommentBtnEl);
        });
      }

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
      const childRedmineBadgeEl = card.querySelector('.redmine-issue-badge');
      if (childRedmineBadgeEl) {
        childRedmineBadgeEl.addEventListener('click', (e) => e.stopPropagation());
      }

      // GitHub Issue紐付けボタンのイベント（BT-122）
      const childGithubLinkBtnEl = card.querySelector('.card-child-github-link-btn');
      if (childGithubLinkBtnEl) {
        childGithubLinkBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const childWithProject = { ...child, project: epic.project };
          openGithubLinkModal(childWithProject);
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

      // Redmineチケット紐付けボタンのイベント（BM-126）
      const childRedmineLinkBtnEl = card.querySelector('.card-child-redmine-link-btn');
      if (childRedmineLinkBtnEl) {
        childRedmineLinkBtnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const childWithProject = { ...child, project: epic.project };
          openRedmineLinkModal(childWithProject);
        });
      }

      body.appendChild(card);
    }

    // 達成感モードで本日完了ゼロのときの空状態（ミニボード用・コンパクト）
    if (miniDoneTodayActive && matchedChildren.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'done-today-empty done-today-empty-mini';
      empty.innerHTML = `<span class="material-icon icon-psychiatry done-today-empty-icon"></span><span>今日はまだ</span>`;
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

    // BT-425: 完了以外の列は末尾にも「＋」を置く(親Epic固定の子タスク追加)
    if (!isDoneCol) {
      const addFooter = document.createElement('div');
      addFooter.className = 'card card-child card-summary card-add-footer card-add-footer-mini';
      addFooter.dataset.colStatus = col.match[0];
      addFooter.dataset.parentId = epic.id;
      addFooter.dataset.project = epic.project;
      addFooter.title = '子タスク追加';
      addFooter.innerHTML = '<span class="summary-label">＋</span>';
      body.appendChild(addFooter);
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
  container.querySelectorAll('.column-sort-select').forEach(select => {
    select.addEventListener('change', (e) => {
      localStorage.setItem(COLUMN_SORT_KEY_PREFIX + e.target.dataset.colId, e.target.value);
      buildMiniBoard(epic);
      if (lastBoardData) renderBoard(lastBoardData);
    });
  });

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
  container.querySelectorAll('.add-task-btn-mini, .card-add-footer-mini').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddTaskForm(btn.dataset.colStatus, btn.dataset.project, btn.dataset.parentId);
    });
  });

  // ミニボード内のピンボタンにイベント設定
  container.querySelectorAll('.today-pin-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const taskId = btn.dataset.taskId;
      const isActive = btn.classList.contains('pin-active');
      toggleTodayFlag(taskId, !isActive);
    });
  });

  // BT-201: 完了カラムの親Epicリンクから来た場合、対象の子タスクカードをハイライト
  if (pendingHighlightChildId) {
    const targetId = pendingHighlightChildId;
    pendingHighlightChildId = null;
    const targetCard = container.querySelector(`[data-task-id="${CSS.escape(targetId)}"]`);
    if (targetCard) {
      targetCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      targetCard.classList.add('card-highlight-pulse');
      setTimeout(() => targetCard.classList.remove('card-highlight-pulse'), 2000);
    }
  }
}

function setupCardClick(card, item, isChildCard = false) {
  card.addEventListener('click', (ev) => {
    if (ev.defaultPrevented) return;
    if (selectionMode) {
      toggleCardSelection(item);
      return;
    }
    openCardDetail(item, isChildCard || null);
  });
  setupTaskQuickTip(card, item);
}

// BT-317: 詳細モーダルを開かずに、カードの内容を素早く確認するための右クリックTIP。
// BM-076: TIP内に編集ボタンを追加し、モーダルを開かずに件名・説明を直接編集できるようにする。
let taskQuickTipEl = null;
let taskQuickTipOrigin = { x: 0, y: 0 }; // 直近に右クリックした座標（編集モード切替時の再配置に使う）
let taskQuickTipHasUnsavedChanges = null; // 編集中のみ関数が入る。表示モードの間はnull
let taskQuickTipScrollSuppressUntil = 0; // この時刻(performance.now)まではscrollでTIPを閉じない（BM-136）

// BM-136: 再描画がスクロール位置を書き戻した直後のscrollでTIPが閉じないよう、短時間だけ無視する。
// 書き戻しは描画の次フレーム以降に発火するため、余裕を見て数百ミリ秒とする。
function suppressQuickTipScrollClose() {
  taskQuickTipScrollSuppressUntil = performance.now() + 500;
}

function getOrCreateTaskQuickTip() {
  if (taskQuickTipEl) return taskQuickTipEl;
  taskQuickTipEl = document.createElement('aside');
  taskQuickTipEl.className = 'task-quick-tip';
  taskQuickTipEl.setAttribute('role', 'dialog');
  taskQuickTipEl.setAttribute('aria-label', 'タスクのクイックプレビュー');
  document.body.appendChild(taskQuickTipEl);

  // BM-076: 編集中に未保存の変更がある間は、外側クリック/背後スクロール/リサイズのどれでも閉じない
  // （BT-168の未保存ガードと同じ考え方）。閉じようとする全ての経路をこの関数に通す。
  document.addEventListener('pointerdown', (e) => {
    if (taskQuickTipEl.contains(e.target)) return;
    tryCloseTaskQuickTip();
  });
  // Escは×ボタンと同じ「意図的な操作」として、未保存でも従来通り閉じる（モーダルのEsc挙動と同じ方針）。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTaskQuickTip();
  });
  window.addEventListener('resize', tryCloseTaskQuickTip);
  // キャプチャで背後のスクロールも検知するが、TIP自身のスクロールでは閉じない。
  // BM-136: 再描画(WS更新)で列のスクロール位置を書き戻すと、人がスクロールしていなくてもscrollが発火して
  // TIPが閉じてしまう。再描画の直後だけは無視する(suppressQuickTipScrollClose)。
  window.addEventListener('scroll', (e) => {
    if (performance.now() < taskQuickTipScrollSuppressUntil) return;
    if (!taskQuickTipEl.contains(e.target)) tryCloseTaskQuickTip();
  }, true);
  return taskQuickTipEl;
}

// BM-076: 未保存の変更がある間は閉じずに揺らすだけ（closeOnBackdropClickと同じ視覚フィードバック）。
// 無ければ通常通り閉じる。
function tryCloseTaskQuickTip() {
  // BM-136: 編集中の未保存に加え、コメント欄の書きかけの文字も守る
  const hasCommentDraftInTip = typeof hasCommentDraft === 'function' && taskQuickTipEl && hasCommentDraft(taskQuickTipEl);
  if ((taskQuickTipHasUnsavedChanges && taskQuickTipHasUnsavedChanges()) || hasCommentDraftInTip) {
    if (taskQuickTipEl && taskQuickTipEl.animate) {
      taskQuickTipEl.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
        { duration: 300, easing: 'ease' }
      );
    }
    return;
  }
  closeTaskQuickTip();
}

function closeTaskQuickTip() {
  if (taskQuickTipEl) taskQuickTipEl.classList.remove('task-quick-tip-visible');
  taskQuickTipHasUnsavedChanges = null;
}

// 右クリック時の座標を基準に、画面端で見切れないようクランプして配置する。
// 編集モードへの切替等で内容の高さが変わった後の再配置にも使う（枠サイズ自体=CSSのwidth/max-heightは変えない）。
function positionTaskQuickTip(tip) {
  tip.style.left = '0px';
  tip.style.top = '0px';
  const margin = 12;
  const left = Math.min(taskQuickTipOrigin.x, window.innerWidth - tip.offsetWidth - margin);
  const top = Math.min(taskQuickTipOrigin.y, window.innerHeight - tip.offsetHeight - margin);
  tip.style.left = `${Math.max(margin, left)}px`;
  tip.style.top = `${Math.max(margin, top)}px`;
}

// BM-084: descriptionキー自体が無いitem(board用の軽量データ、取得中)は「読み込み中...」を出す
// (BM-083のbuildDescriptionSectionHtmlと同じ考え方)。
function buildTaskQuickTipDescriptionInner(item) {
  const hasKey = Object.prototype.hasOwnProperty.call(item, 'description');
  if (!hasKey) return '<span class="task-quick-tip-description-loading">読み込み中...</span>';
  return item.description ? `<div class="description-md">${renderDescriptionMarkdown(item.description)}</div>` : '<span>説明はありません</span>';
}

function buildTaskQuickTipHtml(item) {
  const meta = [];
  if (item.category && item.category !== '-') meta.push(`<span class="task-quick-tip-tag">${escapeHtml(item.category)}</span>`);
  if (item.assignee) meta.push(`<span class="task-quick-tip-tag">担当: ${escapeHtml(item.assignee)}</span>`);
  if (item.startDate) meta.push(`<span class="task-quick-tip-tag">開始: ${escapeHtml(item.startDate)}</span>`);
  meta.push(`<span class="task-quick-tip-tag">期日: ${item.dueDate ? escapeHtml(item.dueDate) : '未設定'}</span>`);
  const artifacts = (item.artifacts || []).slice(0, 3)
    .map(path => `<li><code>${escapeHtml(path)}</code></li>`).join('');
  const moreArtifacts = item.artifacts && item.artifacts.length > 3
    ? `<li>ほか ${item.artifacts.length - 3} 件</li>` : '';
  // BM-076: 件名・説明をその場で編集できるよう、ヘッダー右側に編集ボタンを置く（削除済み等でid不明な時は出さない）。
  const editBtn = (item.id && item.id !== '-')
    ? `<button type="button" class="task-quick-tip-edit-btn" title="編集" aria-label="編集"><span class="material-icon icon-edit"></span></button>` : '';
  return `
    <div class="task-quick-tip-header"><span class="task-quick-tip-id">${escapeHtml(item.id || '-')}</span><div class="task-quick-tip-header-right">${editBtn}<span class="task-quick-tip-hint">Esc または外側クリックで閉じる</span></div></div>
    <div class="task-quick-tip-title">${escapeHtml(item.title || '')}</div>
    <div class="task-quick-tip-description">${buildTaskQuickTipDescriptionInner(item)}</div>
    ${meta.length ? `<div class="task-quick-tip-meta">${meta.join('')}</div>` : ''}
    ${artifacts ? `<div class="task-quick-tip-artifacts"><span>成果物</span><ul>${artifacts}${moreArtifacts}</ul></div>` : ''}
    ${buildTaskCommentSectionHtml(item, 'tip')}
  `;
}

// BM-136: TIPの表示モードを描画する（HTML・編集ボタン・コメント一覧の取得をまとめて行う）。
// 右クリックで開く時、編集からの戻り、全文取得後の再描画の3か所で同じ手順を踏むため共通化した。
function renderTaskQuickTipView(tip, item) {
  tip.innerHTML = buildTaskQuickTipHtml(item);
  wireTaskQuickTipEditButton(tip, item);
  hydrateCommentSections(tip, item);
}

// BM-076: TIP内インライン編集フォーム。enterEditMode(モーダル編集)と同じ考え方(変更検知・未保存ガード・
// 多重送信防止)を、タイトル・説明の2項目だけに絞って移植する。
function buildTaskQuickTipEditHtml(item, isArchivedSingle) {
  const descField = isArchivedSingle
    ? `<p class="archived-note">完了済みタスクのため説明は編集できないよ</p>`
    : `<div class="settings-group"><label>説明</label><textarea id="quick-tip-edit-description" rows="5" placeholder="説明を入力">${escapeHtml(item.description || '')}</textarea></div>`;
  return `
    <div class="task-quick-tip-header"><span class="task-quick-tip-id">${escapeHtml(item.id || '-')}</span><span class="task-quick-tip-hint">保存またはキャンセルで編集を終了</span></div>
    <div class="task-quick-tip-edit-form">
      <div class="settings-group">
        <label>タイトル</label>
        <input type="text" id="quick-tip-edit-title" value="${escapeHtml(item.title || '')}">
      </div>
      ${descField}
      <p class="edit-task-error" id="quick-tip-edit-error" style="display:none;"></p>
      <div class="edit-form-actions">
        <button class="add-task-submit" id="quick-tip-edit-save">保存</button>
        <button class="add-child-btn" id="quick-tip-edit-cancel">キャンセル</button>
      </div>
    </div>
  `;
}

function enterTaskQuickTipEditMode(tip, item) {
  // BM-084: board用の軽量item(descriptionキー無し)のまま編集フォームを開くと、取得前の空文字を
  // 保存して本文を消してしまう事故になる(BM-083のenterEditModeと同じ対策)。
  // キーが無い場合は完全なデータを取得してから編集フォームを開き直す。
  if (!Object.prototype.hasOwnProperty.call(item, 'description')) {
    const cached = lastRenderedFullItemById.get(item.id);
    if (cached) {
      enterTaskQuickTipEditMode(tip, cached);
    } else {
      fetchTaskDetail(item.id).then(full => {
        if (full) enterTaskQuickTipEditMode(tip, full);
      });
    }
    return;
  }
  const isEpic = item.childrenTotal > 0;
  const isArchivedSingle = !isEpic && item.statusCode === 'done';
  tip.innerHTML = buildTaskQuickTipEditHtml(item, isArchivedSingle);
  positionTaskQuickTip(tip);

  const titleInput = tip.querySelector('#quick-tip-edit-title');
  const descInput = tip.querySelector('#quick-tip-edit-description');
  wireDescriptionPreview(descInput); // BT-462
  const errorEl = tip.querySelector('#quick-tip-edit-error');
  const saveBtn = tip.querySelector('#quick-tip-edit-save');
  const cancelBtn = tip.querySelector('#quick-tip-edit-cancel');

  const backToViewMode = () => {
    taskQuickTipHasUnsavedChanges = null;
    renderTaskQuickTipView(tip, item);
    positionTaskQuickTip(tip);
  };
  cancelBtn.addEventListener('click', backToViewMode);

  // BT-367と同じ考え方: 開いた時点の値と比較し、差分がある時だけ保存ボタンを有効にする。
  const readFormValues = () => ({
    title: titleInput.value.trim(),
    description: descInput ? descInput.value : '',
  });
  const initialValues = readFormValues();
  const updateSaveState = () => {
    saveBtn.disabled = !hasFormChanged(initialValues, readFormValues());
  };
  taskQuickTipHasUnsavedChanges = () => saveBtn.isConnected && hasFormChanged(initialValues, readFormValues());
  [titleInput, descInput].forEach(el => { if (el) el.addEventListener('input', updateSaveState); });
  updateSaveState();

  saveBtn.addEventListener('click', async () => {
    if (saveBtn.disabled) return; // BM-054と同様の連打防止(多重送信ガード)
    const newTitle = titleInput.value.trim();
    if (!newTitle) {
      errorEl.textContent = 'タイトルは必須だよ';
      errorEl.style.display = 'block';
      return;
    }

    const payload = { taskId: item.id, title: newTitle };
    if (descInput) payload.description = descInput.value;

    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = '保存中...';
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
      // BT-377: 次回のWS再描画で古い説明に戻らないようキャッシュも更新(説明キーを持つ完全なitemだけ)
      if (Object.prototype.hasOwnProperty.call(item, 'description')) lastRenderedFullItemById.set(item.id, item);
      backToViewMode();
    } catch (e) {
      console.error('[quick-tip-edit] Network error:', e);
      errorEl.textContent = 'ネットワークエラーが発生したよ';
      errorEl.style.display = 'block';
    } finally {
      // 保存成功時はbackToViewMode()でこのボタンはDOMごと破棄されているため無害、
      // 失敗時は再度押せるように戻す(BM-054と同じ考え方)
      if (saveBtn.isConnected) {
        saveBtn.textContent = originalLabel;
        updateSaveState();
      }
    }
  });

  titleInput.focus();
}

function wireTaskQuickTipEditButton(tip, item) {
  const editBtn = tip.querySelector('.task-quick-tip-edit-btn');
  if (!editBtn) return;
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    enterTaskQuickTipEditMode(tip, item);
  });
}

// BM-136: 右クリックTIPを指定位置に開く。コメントボタン（focusComment=true）からも使うため、
// 右クリックのハンドラから切り出した。focusCommentを付けるとコメント入力欄にフォーカスする。
function openTaskQuickTip(item, x, y, { focusComment = false } = {}) {
  const tip = getOrCreateTaskQuickTip();
  taskQuickTipHasUnsavedChanges = null; // 新しいTIPを開くたびに前回の編集状態をリセット
  taskQuickTipOrigin = { x, y };
  renderTaskQuickTipView(tip, item);
  tip.classList.add('task-quick-tip-visible');
  positionTaskQuickTip(tip);
  if (focusComment) focusCommentInput(tip);

  // BM-084: board用の軽量item(descriptionキー無し)の場合、表示直後に完全なデータを
  // 非同期取得して再描画する(BM-083のloadFullDescriptionIfMissingと同じパターン)。
  // TIPが開いたままタスクIDが変わっていない場合のみ再描画する(閉じた後に遅れて
  // 結果が返ってきて別タスクのTIPを上書きする事故を防ぐ。TIPはモーダルと違う独自の
  // 開閉状態を持つため、isStillValidコールバックで判定方法を差し替える)。
  const targetId = item.id;
  const isTipStillShowingThisTask = () => {
    if (!tip.classList.contains('task-quick-tip-visible')) return false;
    if (tip.querySelector('.task-quick-tip-edit-form')) return false; // 編集フォーム表示中は壊さない
    const currentIdEl = tip.querySelector('.task-quick-tip-id');
    return !!currentIdEl && currentIdEl.textContent === (targetId || '-');
  };
  loadFullDescriptionIfMissing(item, targetId, (full) => {
    Object.assign(item, full); // 以後のwireTaskQuickTipEditButton等が同じitem参照を使うため上書きする
    // BM-136: 取得を待つ間にコメントを書き始めていても消えないよう、入力欄の状態を控えて戻す
    const draft = captureCommentDraft(tip);
    renderTaskQuickTipView(tip, item);
    restoreCommentDraft(tip, draft);
    positionTaskQuickTip(tip);
  }, isTipStillShowingThisTask);
}

function setupTaskQuickTip(card, item) {
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTaskQuickTip(item, e.clientX, e.clientY);
  });
}

// BM-136: カードのコメントボタン。右クリックTIPをボタンの下に開き、コメント入力欄にフォーカスする。
// EPICのミニボード上の子カードにも付く（タグボタンと同じく、子はprojectを持たないため親EPICから補う）。
function openCardCommentTip(btn) {
  const taskId = btn.dataset.taskId;
  const parentEpic = findItemById(taskId) ? null : findParentEpicOfChildId(taskId);
  const found = findItemById(taskId) || findChildItemById(taskId);
  if (!found) return;
  const item = parentEpic ? { ...found, project: parentEpic.project } : found;
  const rect = btn.getBoundingClientRect();
  openTaskQuickTip(item, rect.left, rect.bottom + 6, { focusComment: true });
}

// --- 複数選択→親付け (BT-034) ---
function toggleCardSelection(item) {
  if (!item.id || item.id === '-') return;
  const isDone = item.statusCode === 'done';
  if (isDone) return; // 選択不可（グレーアウト対象と同条件）。EPICはタグ・カテゴリの一括設定のため選択できる（BT-455）
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
    <span class="selection-bar-note" hidden>EPICを含む選択では、タグ・カテゴリのみ操作可能</span>
    <button class="selection-bar-btn selection-bar-parent" id="selection-pick-parent">親を選ぶ</button>
    <button class="selection-bar-btn selection-bar-move" id="selection-pick-move"><span class="material-icon icon-local-shipping"></span> 移動</button>
    <button class="selection-bar-btn selection-bar-pin" id="selection-pin"><span class="material-icon icon-keep"></span> ピン留め</button>
    <button class="selection-bar-btn selection-bar-pin" id="selection-unpin"><span class="material-icon icon-keep"></span> ピン解除</button>
    <button class="selection-bar-btn selection-bar-due" id="selection-set-due"><span class="material-icon icon-calendar-month"></span> 期日を設定</button>
    <button class="selection-bar-btn selection-bar-tag" id="selection-tag"><span class="material-icon icon-tag"></span> タグ</button>
    <button class="selection-bar-btn selection-bar-category" id="selection-category"><span class="material-icon icon-stacks"></span> カテゴリ</button>
    <button class="selection-bar-btn selection-bar-github" id="selection-github-create"><span class="material-icon icon-upload"></span> GitHub登録</button>
    <button class="selection-bar-btn selection-bar-delete danger" id="selection-delete"><span class="material-icon icon-delete"></span> 削除</button>
    <button class="selection-bar-btn selection-bar-cancel" id="selection-cancel">キャンセル</button>
  `;
  document.body.appendChild(selectionBarEl);
  selectionBarEl.querySelector('#selection-pick-parent').addEventListener('click', () => openParentPicker());
  selectionBarEl.querySelector('#selection-pick-move').addEventListener('click', () => openMovePicker(null, false));
  selectionBarEl.querySelector('#selection-pin').addEventListener('click', () => applySelectedPin(true));
  selectionBarEl.querySelector('#selection-unpin').addEventListener('click', () => applySelectedPin(false));
  selectionBarEl.querySelector('#selection-set-due').addEventListener('click', (event) => {
    // currentDueは空にして、選択中のタスクの期日が混在していても今日を起点に選べるようにする。
    openDueDatePicker(event.currentTarget, '', (dueDate) => applySelectedDueDate(dueDate));
  });
  selectionBarEl.querySelector('#selection-tag').addEventListener('click', (event) => openBulkTagPicker(event.currentTarget));
  selectionBarEl.querySelector('#selection-category').addEventListener('click', (event) => openBulkCategoryPicker(event.currentTarget));
  selectionBarEl.querySelector('#selection-github-create').addEventListener('click', () => openBulkGithubCreateConfirm());
  selectionBarEl.querySelector('#selection-delete').addEventListener('click', () => openBulkDeleteConfirm());
  selectionBarEl.querySelector('#selection-cancel').addEventListener('click', () => {
    finishSelectionMode();
  });
  return selectionBarEl;
}

// 選択UIを持つ画面（将来のガントを含む）から使える一括更新の共通部品。
// 成功時の再描画・選択解除は呼び出し側が決めるため、ここでは結果だけを返す。
async function applyBulkTaskAction(taskIds, label, request) {
  if (!taskIds.length) return false;
  const results = await Promise.all(taskIds.map(async (taskId) => {
    try {
      const response = await request(taskId);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`);
      return { taskId, ok: true };
    } catch (error) {
      console.error(`[bulk-action] ${label} failed for ${taskId}:`, error);
      return { taskId, ok: false, error: error.message };
    }
  }));
  const failed = results.filter(result => !result.ok);
  if (failed.length) {
    alert(`${label}できなかったタスクがあるよ: ${failed.map(result => result.taskId).join(', ')}。選択はそのまま残してあるよ。`);
    return false;
  }
  return true;
}

function setBulkPinned(taskIds, value) {
  return applyBulkTaskAction(taskIds, value ? 'ピン留め' : 'ピン解除', (taskId) => fetch('/api/toggle-today', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, value }),
  }));
}

function setBulkDueDate(taskIds, dueDate) {
  return applyBulkTaskAction(taskIds, dueDate ? '期日設定' : '期日解除', (taskId) => fetch('/api/update-task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, dueDate }),
  }));
}

// gantt.js は app.js より先に読み込まれるため、実行時に参照できる公開APIとしても渡す。
window.bulkTaskActions = { setPinned: setBulkPinned, setDueDate: setBulkDueDate, openDueDatePicker };

function finishSelectionMode() {
  selectionMode = false;
  selectedIds.clear();
  document.getElementById('select-mode-btn').classList.remove('filter-active');
  if (lastBoardData) renderBoard(lastBoardData);
}

async function applySelectedPin(value) {
  if (await setBulkPinned([...selectedIds], value)) finishSelectionMode();
}

async function applySelectedDueDate(dueDate) {
  if (await setBulkDueDate([...selectedIds], dueDate)) finishSelectionMode();
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
  // EPIC(親)を含む選択はタグ・カテゴリだけ操作可能（親付け・移動・ピン・期日・GitHub・削除は子タスク/単発前提のため、BT-455）
  const hasEpic = [...selectedIds].some(id => {
    const item = findItemById(id);
    return item && item.childrenTotal > 0;
  });
  bar.querySelector('.selection-bar-note').hidden = !hasEpic;
  for (const btnId of SELECTION_BAR_NON_EPIC_BUTTONS) {
    const btn = bar.querySelector(`#${btnId}`);
    btn.disabled = hasEpic;
    btn.title = hasEpic ? 'EPICを含むため使えません（タグ・カテゴリのみ操作可能）' : '';
  }
  bar.classList.add('selection-bar-visible');
}

const SELECTION_BAR_NON_EPIC_BUTTONS = [
  'selection-pick-parent', 'selection-pick-move', 'selection-pin', 'selection-unpin',
  'selection-set-due', 'selection-github-create', 'selection-delete',
];

// Escで選択モードを解除する(BT-455)。外側クリックでは解除しない(選んだ内容が消えるため)。
// モーダル・ピッカー類が開いている間は、そちらのEscを優先する。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !selectionMode) return;
  if (e.defaultPrevented) return;
  if (document.querySelector('.modal-overlay.modal-visible, .settings-overlay.settings-visible, .plan-board-overlay.active, .activity-modal-overlay.modal-visible, .backup-modal-overlay.modal-visible, .tag-modal-overlay.modal-visible, .category-modal-overlay.modal-visible, .ui-dialog-overlay.modal-visible')) return;
  if (dueDatePickerEl || wsFilterMenuOpen || boardLaneMenuEl) return;
  if (typeof tagPickerEl !== 'undefined' && tagPickerEl) return;
  if (typeof categoryPickerEl !== 'undefined' && categoryPickerEl) return;
  if (typeof tagFilterPopEl !== 'undefined' && tagFilterPopEl) return;
  if (typeof categoryFilterPopEl !== 'undefined' && categoryFilterPopEl) return;
  e.preventDefault();
  finishSelectionMode();
});

let parentPickerEl = null;

function getOrCreateParentPicker() {
  if (parentPickerEl) return parentPickerEl;
  parentPickerEl = document.createElement('div');
  parentPickerEl.className = 'modal-overlay modal-front';
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
  closeOnEscape(parentPickerEl, 'modal-visible', closeParentPicker);
  return parentPickerEl;
}

// --- プロジェクト移管 (BT-063) ---
let pendingMoveIds = [];
let moveIsChild = false;
let movePickerEl = null;

function getOrCreateMovePicker() {
  if (movePickerEl) return movePickerEl;
  movePickerEl = document.createElement('div');
  movePickerEl.className = 'modal-overlay modal-front';
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
  closeOnEscape(movePickerEl, 'modal-visible', closeMovePicker);
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
  document.body.appendChild(picker);
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
        body: JSON.stringify({ taskId, targetFile }),
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
  document.body.appendChild(picker);
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
  // ボード表示順（完了カラムは除外）で同一プロジェクトの候補を収集
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
      ? `<span class="card-badge"><span class="badge-num"><span class="material-icon icon-check"></span>${item.childrenDone}</span><span class="badge-den">/${item.childrenTotal}</span></span>`
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
      body: JSON.stringify({ title, project: parentPickerProject, status: 'todo', origin: 'user' }),
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

// --- 親タスク選択コンボボックス (BT-432: 追加ダイアログ・編集画面で共用) ---
const PARENT_FIELD_MAX_ROWS = 50;

function renderParentFieldHtml(idPrefix) {
  return `<div class="parent-field" id="${idPrefix}-parent-field">
    <div class="parent-field-row">
      <input type="text" id="${idPrefix}-parent" class="parent-field-input" autocomplete="off" placeholder="なし（ID・タイトルで検索）">
      <button type="button" class="parent-field-clear" title="親をなしにする" aria-label="親をなしにする">&times;</button>
    </div>
    <div class="parent-field-list" role="listbox" style="display:none;"></div>
    <div class="parent-field-title"></div>
    <div class="parent-field-note"></div>
  </div>`;
}

// 親になれるのは、指定ワークスペースのトップレベルで未完了のタスク（EPICと単発）。子は2階層制約で除外する
function collectParentCandidates(project, excludeId) {
  const candidates = [];
  if (!currentBoardData) return candidates;
  for (const col of currentBoardData.columns) {
    if (col.compact || col.id === 'done') continue;
    for (const item of col.items) {
      if (!item.id || item.id === '-' || item.parentId) continue;
      if (item.project !== project || item.id === excludeId) continue;
      candidates.push(item);
    }
  }
  return candidates;
}

// taskIdの現在の親IDを返す（詳細取得したitemにはparentIdが無いため、ボード上のitemから辿る）
function findParentIdOf(taskId) {
  if (!currentBoardData) return '';
  for (const col of currentBoardData.columns) {
    for (const item of col.items) {
      if (item.id === taskId && item.parentId) return item.parentId;
      if (item.children && item.children.some(c => c.id === taskId)) return item.id;
    }
  }
  return '';
}

/**
 * @param {HTMLElement} root - renderParentFieldHtmlで作った .parent-field 要素
 * @param {{getProject: () => string, excludeId?: string, onChange?: () => void}} opts
 * onChangeはユーザー操作で値が変わった時だけ呼ぶ（setValue/clearでは呼ばない）
 */
function setupParentField(root, { getProject, excludeId = '', onChange = () => {} }) {
  const input = root.querySelector('.parent-field-input');
  const clearBtn = root.querySelector('.parent-field-clear');
  const listEl = root.querySelector('.parent-field-list');
  const titleEl = root.querySelector('.parent-field-title');
  const noteEl = root.querySelector('.parent-field-note');
  let value = '';
  let fallbackTitle = '';
  let disabled = false;

  const showSelected = () => {
    input.value = value;
    const found = value ? findItemById(value) : null;
    const title = found ? found.title : fallbackTitle;
    titleEl.textContent = value ? `親: ${title || ''}` : '';
    clearBtn.style.display = value && !disabled ? '' : 'none';
  };
  const openList = () => { listEl.style.display = ''; parentFieldListOpen = true; };
  const closeList = () => { listEl.style.display = 'none'; parentFieldListOpen = false; };
  const matches = (query) => {
    const q = query.trim().toLowerCase();
    return collectParentCandidates(getProject(), excludeId)
      .filter(it => !q || it.id.toLowerCase().includes(q) || it.title.toLowerCase().includes(q));
  };
  const renderList = (query) => {
    const all = matches(query);
    const rows = all.slice(0, PARENT_FIELD_MAX_ROWS);
    if (rows.length === 0) {
      listEl.innerHTML = '<div class="parent-field-empty">候補がないよ</div>';
      return;
    }
    // EPIC（子を持つタスク）にはアイコンを付け、単発タスクと見分けられるようにする。単発は同幅の空きで揃える
    listEl.innerHTML = rows.map(it => `<div class="parent-field-item${it.id === value ? ' is-selected' : ''}" role="option" data-id="${escapeHtml(it.id)}">
      ${(it.children && it.children.length > 0) || it.childrenTotal > 0
        ? '<span class="parent-field-item-icon material-icon icon-stacks" title="EPIC"></span>'
        : '<span class="parent-field-item-icon" aria-hidden="true"></span>'}
      <span class="parent-field-item-id">${escapeHtml(it.id)}</span>
      <span class="parent-field-item-title">${escapeHtml(it.title)}</span>
    </div>`).join('') + (all.length > rows.length
      ? `<div class="parent-field-more">ほか${all.length - rows.length}件。絞り込んでね</div>`
      : '');
  };
  const pick = (id) => {
    value = id;
    fallbackTitle = '';
    showSelected();
    closeList();
    onChange();
  };

  input.addEventListener('focus', () => { input.select(); renderList(''); openList(); });
  input.addEventListener('input', () => { renderList(input.value); openList(); });
  input.addEventListener('blur', () => { closeList(); showSelected(); }); // 入力途中の文字は捨てて、選択中の値に戻す
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && parentFieldListOpen) {
      e.preventDefault();
      e.stopPropagation();
      input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const first = matches(input.value)[0];
      if (first) { pick(first.id); input.blur(); }
    }
  });
  // blurより先に選択を確定させるため、mousedownで処理する
  listEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const row = e.target.closest('.parent-field-item');
    if (!row) return;
    pick(row.dataset.id);
    input.blur();
  });
  clearBtn.addEventListener('click', () => { pick(''); });

  showSelected();
  return {
    getValue: () => value,
    setValue: (id, title = '') => { value = id || ''; fallbackTitle = title; showSelected(); },
    clear: () => { value = ''; fallbackTitle = ''; showSelected(); },
    setDisabled: (isDisabled, note = '') => {
      disabled = !!isDisabled;
      input.disabled = disabled;
      noteEl.textContent = disabled ? note : '';
      showSelected();
    },
  };
}

// --- Add Task Form ---
let addFormEl = null;

function getOrCreateAddForm() {
  if (addFormEl) return addFormEl;
  addFormEl = document.createElement('div');
  addFormEl.className = 'modal-overlay modal-front';
  addFormEl.innerHTML = `
    <div class="modal-content add-task-modal add-task-form-wide">
      <button class="modal-close" id="add-form-close">&times;</button>
      <h3 class="add-form-title">タスク追加</h3>
      ${renderParentCrumbSlotHtml('add-task', '', '')}
      <div class="detail-layout">
        <div class="detail-main">
          <div class="settings-group">
            <label>タイトル</label>
            <input type="text" id="add-task-title" placeholder="やりたいことを一言で">
          </div>
          <div class="settings-group">
            <label>説明（任意）</label>
            <textarea id="add-task-description" rows="4" placeholder="補足があれば"></textarea>
          </div>
        </div>
        <div class="detail-side">
          <div class="settings-group">
            <label>ワークスペース</label>
            <select id="add-task-project">
              <option value="inbox">未ワークスペース (Inbox)</option>
            </select>
          </div>
          <div class="settings-group">
            <label>親タスク（任意）</label>
            ${renderParentFieldHtml('add-task')}
          </div>
          <div class="settings-group">
            <label>ステータス</label>
            <select id="add-task-status">
              <option value="todo">TODO</option>
              <option value="ready">READY</option>
              <option value="do">DO</option>
              <option value="done">DONE</option>
            </select>
          </div>
          <div class="settings-group" id="add-task-completed-group" style="display:none;">
            <label>完了日・時刻</label>
            <div class="add-task-completed-row">
              ${renderDateFieldHtml('add-task-completed-date', '')}
              <input type="time" id="add-task-completed-time" class="time-field">
            </div>
          </div>
          <div class="settings-group">
            <label>タグ（任意）</label>
            <div class="add-task-tags" id="add-task-tags"></div>
          </div>
          <div class="settings-group">
            <label>カテゴリ（任意）</label>
            <div class="category-select-row">
              <select id="add-task-category"><option value="">カテゴリなし</option></select>
              <button type="button" class="category-manage-link" data-form-kind="add" title="カテゴリ管理を開く"><span class="material-icon icon-settings"></span></button>
            </div>
          </div>
          <div class="settings-group">
            <label>担当（任意）</label>
            <input type="text" id="add-task-assignee" placeholder="担当者">
          </div>
          <div class="settings-group">
            <label>開始日（任意）</label>
            ${renderDateFieldHtml('add-task-start-date', '')}
          </div>
          <div class="settings-group">
            <label>期日（任意）</label>
            ${renderDateFieldHtml('add-task-due-date', '')}
          </div>
        </div>
      </div>
      <p class="edit-task-error" id="add-task-error" style="display:none;"></p>
      <div class="edit-form-actions">
        <button class="add-task-submit" id="add-task-submit">追加</button>
        <button class="add-child-btn" id="add-task-cancel">キャンセル</button>
      </div>
    </div>
  `;
  document.body.appendChild(addFormEl);

  // BT-168: 開いた時点から入力が変わっている間は背景クリックで閉じない
  addFormEl._hasUnsavedChanges = () =>
    !!addFormEl._initialValues && hasFormChanged(addFormEl._initialValues, readAddFormValues());
  closeOnBackdropClick(addFormEl, closeAddForm);
  addFormEl.querySelector('#add-form-close').addEventListener('click', closeAddForm);
  addFormEl.querySelector('#add-task-cancel').addEventListener('click', closeAddForm);

  closeOnEscape(addFormEl, 'modal-visible', closeAddForm);

  addFormEl.querySelector('#add-task-submit').addEventListener('click', submitAddTask);
  // BT-395: タグはワークスペース単位のため、ワークスペースを変えたら選択済みタグをクリアする
  addFormEl.querySelector('#add-task-project').addEventListener('change', () => resetAddFormTags(addFormEl));
  // BT-432: 親タスクの候補は選択中ワークスペースのもの。親を選んだらワークスペースを親に合わせて固定する
  addFormEl._parentField = setupParentField(addFormEl.querySelector('#add-task-parent-field'), {
    getProject: () => addFormEl.querySelector('#add-task-project').value,
    onChange: syncAddFormParent,
  });
  addFormEl.querySelector('#add-task-status').addEventListener('change', syncAddFormCompletedFields);

  // Enterキーで送信（タイトル未入力時はsubmitAddTask側で弾かれる）
  addFormEl.querySelector('#add-task-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAddTask();
  });
  // BT-367: タイトルが入力されている時だけ「追加」を押せるようにする
  addFormEl.querySelector('#add-task-title').addEventListener('input', updateAddSubmitState);

  return addFormEl;
}

function readAddFormValues() {
  const form = getOrCreateAddForm();
  return {
    title: form.querySelector('#add-task-title').value.trim(),
    description: form.querySelector('#add-task-description').value,
    project: form.querySelector('#add-task-project').value,
    parentId: form._parentField.getValue(),
    status: form.querySelector('#add-task-status').value,
    category: form.querySelector('#add-task-category').value,
    assignee: form.querySelector('#add-task-assignee').value.trim(),
    startDate: form.querySelector('#add-task-start-date').value,
    dueDate: form.querySelector('#add-task-due-date').value,
    completedDate: form.querySelector('#add-task-completed-date').value,
    completedTime: form.querySelector('#add-task-completed-time').value,
    tags: getAddFormTagIds().join(','),
  };
}

// BT-377: DONE選択時だけ完了日・時刻の入力欄を出し、空ならJSTの現在日時を初期値にする
function syncAddFormCompletedFields() {
  const form = getOrCreateAddForm();
  const isDone = form.querySelector('#add-task-status').value === 'done';
  form.querySelector('#add-task-completed-group').style.display = isDone ? '' : 'none';
  if (!isDone) return;
  const dateEl = form.querySelector('#add-task-completed-date');
  const timeEl = form.querySelector('#add-task-completed-time');
  // ブラウザのタイムゾーンに依存しないよう、UTCの現在時刻に+9hしてJSTの日時文字列を作る
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  if (!dateEl.value) dateEl.value = jstNow.slice(0, 10);
  if (!timeEl.value) timeEl.value = jstNow.slice(11, 16);
  updateAddSubmitState();
}

function updateAddSubmitState() {
  const form = getOrCreateAddForm();
  form.querySelector('#add-task-submit').disabled = !form.querySelector('#add-task-title').value.trim();
}

// BT-432: 親タスク欄の値に合わせて、見出し・ワークスペース選択（親があれば親のワークスペースに固定）を更新する
function syncAddFormParent() {
  const form = getOrCreateAddForm();
  const parentId = form._parentField.getValue();
  const projectSelect = form.querySelector('#add-task-project');
  if (parentId) {
    const parent = findItemById(parentId);
    if (parent && parent.project && parent.project !== projectSelect.value) {
      projectSelect.value = parent.project;
      resetAddFormTags(form); // タグはワークスペース単位のため、ワークスペースが変わったら選択済みタグを外す
    }
  }
  form.querySelector('.add-form-title').textContent = parentId ? `子タスク追加 (${parentId})` : 'タスク追加';
  projectSelect.disabled = !!parentId;
  // BM-110: ヘッダー先頭のパンくずも親欄に合わせて更新する（CSSトランジションで滑らかに出現/消失）
  updateParentCrumbSlot(form.querySelector('#add-task-parent-crumb-slot'), parentId);
}

function openAddTaskForm(defaultStatus, defaultProject, parentId, defaults) {
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

  // BT-432: 親IDは親タスク欄が保持する。EPIC画面・ガント・列フッターから開いた時は自動セットされ、
  // 子タスク追加時はラベル変更・ワークスペース固定を行う
  form._parentField.setValue(parentId || '');
  syncAddFormParent();

  // ステータスのデフォルト値
  if (defaultStatus) {
    form.querySelector('#add-task-status').value = defaultStatus;
  }

  // タイトル・説明・担当・日付をクリア＆フォーカス（BT-263）
  // BM-061: 複製時はdefaultsでタイトル・説明だけ引き継ぎ、担当・日付は常に空にする
  const titleInput = form.querySelector('#add-task-title');
  titleInput.value = (defaults && defaults.title) || '';
  const addDescInput = form.querySelector('#add-task-description');
  addDescInput.value = (defaults && defaults.description) || '';
  wireDescriptionPreview(addDescInput); // BT-462: フォームは使い回すため初回だけ被せ、開くたびに編集モードへ戻す
  if (addDescInput.resetDescriptionPreview) addDescInput.resetDescriptionPreview();
  form.querySelector('#add-task-assignee').value = '';
  form.querySelector('#add-task-start-date').value = '';
  form.querySelector('#add-task-due-date').value = '';
  form.querySelector('#add-task-completed-date').value = '';
  form.querySelector('#add-task-completed-time').value = '';
  syncAddFormCompletedFields(); // BT-377: DONE列の＋から開いた場合は完了日時を現在で埋める
  resetAddFormTags(form);
  loadAddFormCategories(form, ''); // BM-106: カテゴリはシステム全体で一意なため、開くたびに全件を読み込む(選択はなしから)

  // 前回開いた時のエラー表示を引きずらないようリセット
  const errorEl = form.querySelector('#add-task-error');
  errorEl.textContent = '';
  errorEl.style.display = 'none';

  updateAddSubmitState();
  form._initialValues = readAddFormValues(); // BT-168: 値をセットし終えた時点を「開いた時点の値」とする
  form.classList.add('modal-visible');
  setTimeout(() => titleInput.focus(), 100);
}

function closeAddForm() {
  if (addFormEl) addFormEl.classList.remove('modal-visible');
}

async function submitAddTask() {
  const form = getOrCreateAddForm();
  const submitBtn = form.querySelector('#add-task-submit');
  if (submitBtn.disabled) return; // BM-054: 連打防止(多重送信ガード)
  const title = form.querySelector('#add-task-title').value.trim();
  const description = form.querySelector('#add-task-description').value.trim();
  const project = form.querySelector('#add-task-project').value;
  const status = form.querySelector('#add-task-status').value;
  const category = form.querySelector('#add-task-category').value;
  const assignee = form.querySelector('#add-task-assignee').value.trim();
  const startDate = form.querySelector('#add-task-start-date').value;
  const dueDate = form.querySelector('#add-task-due-date').value;
  const parentId = form._parentField.getValue();
  const errorEl = form.querySelector('#add-task-error');
  errorEl.style.display = 'none';

  if (!title) {
    form.querySelector('#add-task-title').focus();
    return;
  }

  // BM-054: 送信中はボタンをdisabled化し、処理中であることを示す(連打による多重送信を防ぐ)
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = '追加中...';
  try {
    const body = { title, project, status, origin: 'user' };
    if (description) body.description = description;
    if (category) body.category = category;
    if (assignee) body.assignee = assignee;
    if (startDate) body.startDate = startDate;
    if (dueDate) body.dueDate = dueDate;
    if (parentId) body.parentId = parentId;
    if (status === 'done') {
      // BT-377: 完了日・時刻はJSTとして入力されるため、+09:00付きISO文字列でAPIへ渡す
      const completedDate = form.querySelector('#add-task-completed-date').value;
      const completedTime = form.querySelector('#add-task-completed-time').value || '00:00';
      if (completedDate) {
        const completedAt = `${completedDate}T${completedTime}:00+09:00`;
        if (new Date(completedAt).getTime() > Date.now()) {
          errorEl.textContent = '完了日時は現在より未来にできないよ';
          errorEl.style.display = 'block';
          return;
        }
        body.completedAt = completedAt;
      }
    }

    const resp = await fetch('/api/add-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.ok) {
      // BT-395: 選択したタグは、採番されたタスクIDが分かってから付与する(付与に失敗してもタスク自体は作成済み)
      const tagIds = getAddFormTagIds();
      if (tagIds.length > 0) {
        try {
          const created = await resp.json();
          await fetch('/api/update-task-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: created.id, add: tagIds, actor: 'user' }),
          });
        } catch (e) {
          console.error('[add-task] Tagging failed:', e);
        }
      }
      closeAddForm();
    } else {
      const err = await resp.json();
      console.error('[add-task] Failed:', err.error);
      errorEl.textContent = `追加に失敗したよ: ${err.error || ''}`;
      errorEl.style.display = 'block';
    }
  } catch (e) {
    console.error('[add-task] Network error:', e);
    errorEl.textContent = 'ネットワークエラーが発生したよ';
    errorEl.style.display = 'block';
  } finally {
    // closeAddForm()が呼ばれても次回オープン時に同じDOMを再利用するため、ここで必ず戻す
    submitBtn.textContent = originalLabel;
    updateAddSubmitState();
  }
}

// --- Init ---
applySettings();
planRefreshCategoryColors(); // BT-454: ボードのカテゴリチップ用にマスタの色を先に取得する
connect();
