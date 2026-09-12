'use strict';

// ============================================================
// 履歴ダイアログ (BT-244/245/246)
// ============================================================
// KIRO版(kiro-backlog-todo)のactivity.js(KT-185/KT-187/KT-188)のUI・挙動に準拠して作った、
// 「いつ何をやったか」を時系列で辿るビュー。GET /api/activity(BT-243)が返すtask_eventsの
// イベント配列を日/週/月でグルーピングし、丸＋縦線のタイムラインとして描く。
//
// app.js のグローバル関数に依存する(index.htmlではapp.jsの後に読み込む):
//   escapeHtml / findItemById / openCardDetail / openEpicWithHighlight
//
// データの違い(KIRO版との対応):
//   KIRO版はmd時代の名残でcompleted/deleted/decisionの3種類しかイベントを持たないが、
//   backlog-todo(DB版)のtask_eventsはevent_typeとして8種類(created/status_changed/pinned/
//   unpinned/running_started/running_stopped/assigned/deleted)を記録する。KIRO版と同じ
//   見た目のタブに合わせるため、status_changed→doneをcompleted、deletedはそのまま、
//   残り6種は全部otherにまとめて正規化する(normalizeActivityEvent)。decisionはbacklog-todo
//   に対応データが無いため無し。

let activityModalEl = null;
let activityRawEvents = [];       // GET /api/activityの生データ
let activityNormalized = [];      // normalizeActivityEvent後の配列
let activityUpdatedAt = null;
let activityTypeFilter = 'all';   // all | completed | deleted | other
let activityProjectFilter = '';   // '' = 全ワークスペース
let activityDateFrom = '';        // 'YYYY-MM-DD' or ''
let activityDateTo = '';
let activitySearchQuery = '';
let activityGranularity = localStorage.getItem('activityGranularity') || 'day'; // day | week | month
let activityViewMode = localStorage.getItem('activityViewMode') || 'timeline';  // timeline | chart
let activityChartType = localStorage.getItem('activityChartType') || 'heatmap'; // heatmap | throughput | composition

// KT-187相当: 折りたたみ中のグループ。粒度切り替えでキーの意味が変わるため「<粒度>:<キー>」で保持する。
let activityCollapsedGroups = new Set();
try {
  activityCollapsedGroups = new Set(JSON.parse(localStorage.getItem('activityCollapsedGroups') || '[]'));
} catch { activityCollapsedGroups = new Set(); }

function activityCollapseKey(groupKey) {
  return `${activityGranularity}:${groupKey}`;
}
function isActivityGroupCollapsed(groupKey) {
  return activityCollapsedGroups.has(activityCollapseKey(groupKey));
}
function saveActivityCollapsed() {
  localStorage.setItem('activityCollapsedGroups', JSON.stringify([...activityCollapsedGroups]));
}
function toggleActivityGroup(groupKey) {
  const k = activityCollapseKey(groupKey);
  if (activityCollapsedGroups.has(k)) activityCollapsedGroups.delete(k);
  else activityCollapsedGroups.add(k);
  saveActivityCollapsed();
}

const ACTIVITY_TYPE_DEFS = [
  { key: 'all', label: 'すべて' },
  { key: 'completed', label: '完了' },
  { key: 'deleted', label: '削除' },
  { key: 'other', label: 'その他' },
];

const ACTIVITY_GRANULARITY_DEFS = [
  { key: 'day', label: '日' },
  { key: 'week', label: '週' },
  { key: 'month', label: '月' },
];

const ACTIVITY_CHART_DEFS = [
  { key: 'heatmap', label: 'ヒートマップ' },
  { key: 'throughput', label: 'スループット' },
  { key: 'composition', label: '構成比' },
];

const ACTIVITY_DOW = ['日', '月', '火', '水', '木', '金', '土'];

// スループット積み上げ棒グラフ・タブ配色。KIRO版のcompleted/deleted/decisionの3色分類に倣う。
const ACTIVITY_TYPE_COLOR = {
  completed: 'var(--badge-done-fg)',
  deleted: '#e57373',
  other: 'var(--tag-category-fg)',
};

// event_typesシード(schema.js)の日本語ラベル。「その他」タブの中で個々の行に出す。
const ACTIVITY_EVENT_LABEL = {
  created: '作成',
  status_changed: 'ステータス変更',
  pinned: '今日やるに追加',
  unpinned: '今日やるから解除',
  running_started: '実行中に設定',
  running_stopped: '実行中を解除',
  assigned: '担当変更',
  deleted: '削除',
};

// --- KIRO版のICONS_SVGから、履歴ビューで使うものだけ移植 (app.js/kiro-backlog-todo由来) ---
const ACTIVITY_ICONS_SVG = {
  history: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21q-3.45 0-6.012-2.288T3.05 13h2.025q.35 2.6 2.313 4.3T12 19q2.925 0 4.963-2.037T19 12t-2.037-4.963T12 5q-1.725 0-3.225.8T6.25 8H9v2H3V4h2v2.35q1.275-1.6 3.113-2.475T12 3q1.875 0 3.513.713t2.85 1.925t1.925 2.85T21 12t-.712 3.513t-1.925 2.85t-2.85 1.925T12 21m2.8-4.8L11 12.4V7h2v4.6l3.2 3.2z"/></svg>',
  checkCircle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m10.6 16.6l7.05-7.05l-1.4-1.4l-5.65 5.65l-2.85-2.85l-1.4 1.4zM12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22"/></svg>',
  restoreFromTrash: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 21q-.825 0-1.412-.587T5 19V6q-.425 0-.712-.288T4 5t.288-.712T5 4h4q0-.425.288-.712T10 3h4q.425 0 .713.288T15 4h4q.425 0 .713.288T20 5t-.288.713T19 6v13q0 .825-.587 1.413T17 21zm4-9.15V15q0 .425.288.713T12 16t.713-.288T13 15v-3.15l.9.875q.275.275.688.275t.712-.3q.275-.275.275-.7t-.275-.7l-2.6-2.6q-.3-.3-.7-.3t-.7.3l-2.6 2.6q-.275.275-.287.688t.287.712q.275.275.688.288t.712-.263z"/></svg>',
  stacks: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.513 13.663q-.238-.063-.463-.188l-8.45-4.6q-.275-.15-.388-.375T2.1 8t.113-.5t.387-.375l8.45-4.6q.225-.125.463-.188T12 2.275t.488.063t.462.187l8.45 4.6q.275.15.388.375t.112.5t-.112.5t-.388.375l-8.45 4.6q-.225.125-.462.188t-.488.062t-.488-.062M12 15.725l7.85-4.275q.05-.025.475-.125q.425 0 .713.288t.287.712q0 .275-.125.5t-.4.375l-7.85 4.275q-.225.125-.462.188t-.488.062t-.488-.062t-.462-.188L3.2 13.2q-.275-.15-.4-.375t-.125-.5q0-.425.288-.712t.712-.288q.125 0 .238.038t.237.087zm0 4l7.85-4.275q.05-.025.475-.125q.425 0 .713.288t.287.712q0 .275-.125.5t-.4.375l-7.85 4.275q-.225.125-.462.188t-.488.062t-.488-.062t-.462-.188L3.2 17.2q-.275-.15-.4-.375t-.125-.5q0-.425.288-.712t.712-.288q.125 0 .238.038t.237.087z"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21L12 2l11 19zm11.713-3.287Q13 17.425 13 17t-.288-.712T12 16t-.712.288T11 17t.288.713T12 18t.713-.288M11 15h2v-5h-2z"/></svg>',
  autoAwesome: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m19 9l-1.25-2.75L15 5l2.75-1.25L19 1l1.25 2.75L23 5l-2.75 1.25L19 9Zm0 14l-1.25-2.75L15 19l2.75-1.25L19 15l1.25 2.75L23 19l-2.75 1.25L19 23ZM9 20l-2.5-5.5L1 12l5.5-2.5L9 4l2.5 5.5L17 12l-5.5 2.5L9 20Z"/></svg>',
};
function activityIconHtml(name) {
  const svg = ACTIVITY_ICONS_SVG[name];
  if (!svg) return '';
  return `<span class="ui-icon ui-icon-${name}" aria-hidden="true">${svg}</span>`;
}

// --- 日付ユーティリティ ---
// occurredAtはUTCのISO文字列('...Z')。'YYYY-MM-DD'に単純sliceすると日本時間とずれるため、
// 必ずDateオブジェクトのローカルタイムゲッター経由で日付・時刻を作る。
function activityLocalDateStr(occurredAt) {
  const d = new Date(occurredAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function activityParseDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`);
}
function activityFormatYmd(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function activityWeekStart(dateStr) {
  const d = activityParseDate(dateStr);
  const dow = (d.getDay() + 6) % 7; // 月曜=0
  d.setDate(d.getDate() - dow);
  return activityFormatYmd(d);
}
function activityGroupKey(dateStr) {
  if (activityGranularity === 'month') return dateStr.slice(0, 7);
  if (activityGranularity === 'week') return activityWeekStart(dateStr);
  return dateStr;
}
function activityGroupLabel(key) {
  if (activityGranularity === 'month') {
    const [y, m] = key.split('-');
    return `${y}年${parseInt(m, 10)}月`;
  }
  if (activityGranularity === 'week') {
    const start = activityParseDate(key);
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + 6);
    const fmt = d => `${d.getMonth() + 1}/${d.getDate()}`;
    return `${key.slice(0, 4)}年 ${fmt(start)}（月）〜 ${fmt(end)}（日）`;
  }
  const d = activityParseDate(key);
  return `${key}（${ACTIVITY_DOW[d.getDay()]}）`;
}
function formatActivityTime(occurredAt) {
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// --- 生イベント(BT-243のGET /api/activity)をKIRO風のtype(completed/deleted/other)に正規化 ---
function normalizeActivityEvent(raw) {
  let type;
  if (raw.eventType === 'status_changed' && raw.newValue === 'done') type = 'completed';
  else if (raw.eventType === 'deleted') type = 'deleted';
  else type = 'other';
  return {
    id: raw.taskId,
    title: raw.taskTitle || '',
    project: raw.project || null,
    isChild: !!raw.parentId,
    parentId: raw.parentId || null,
    parentTitle: raw.parentTitle || null,
    type,
    eventType: raw.eventType,
    eventLabel: raw.eventLabel || ACTIVITY_EVENT_LABEL[raw.eventType] || raw.eventType,
    oldValue: raw.oldValue,
    newValue: raw.newValue,
    date: activityLocalDateStr(raw.occurredAt),
    ts: raw.occurredAt,
  };
}

// --- イベント種別のメタ情報 ---
function activityEventMeta(ev) {
  if (ev.type === 'completed') return { icon: 'checkCircle', label: '完了', cls: 'completed' };
  if (ev.type === 'deleted') return { icon: 'restoreFromTrash', label: '削除', cls: 'deleted' };
  return { icon: 'autoAwesome', label: ev.eventLabel, cls: 'other' };
}

// --- モーダルDOM ---
function getOrCreateActivityModal() {
  if (activityModalEl) return activityModalEl;

  activityModalEl = document.createElement('div');
  activityModalEl.id = 'activity-modal-overlay';
  activityModalEl.className = 'activity-modal-overlay';
  activityModalEl.innerHTML = `
    <div class="activity-modal-content">
      <div class="activity-modal-header">
        <h3>${activityIconHtml('history')} 履歴</h3>
        <div class="activity-header-controls">
          <span class="activity-date-range">
            <input type="date" id="activity-date-from" title="期間の開始日">
            <span class="activity-date-range-sep">〜</span>
            <input type="date" id="activity-date-to" title="期間の終了日">
          </span>
          <div class="activity-granularity" id="activity-granularity"></div>
          <div class="activity-viewmode" id="activity-viewmode"></div>
          <div class="activity-chart-tabs" id="activity-chart-tabs" hidden></div>
          <button type="button" class="activity-collapse-all-btn" data-collapse-action="collapse" title="表示中のグループをすべて折りたたむ">すべて畳む</button>
          <button type="button" class="activity-collapse-all-btn" data-collapse-action="expand" title="表示中のグループをすべて展開する">すべて開く</button>
          <button type="button" class="activity-reload-btn" id="activity-reload-btn" title="最新の状態を読み込む">${activityIconHtml('autoAwesome')} 更新</button>
        </div>
        <button type="button" class="activity-modal-close" id="activity-modal-close" title="閉じる">&times;</button>
      </div>
      <div class="activity-filters">
        <div class="activity-tabs" id="activity-tabs" role="tablist"></div>
        <div class="activity-ws-chips" id="activity-ws-chips"></div>
        <input type="search" class="activity-search-input" id="activity-search" placeholder="タイトル・IDで検索">
      </div>
      <div class="activity-body" id="activity-body">
        <div class="activity-loading">読み込み中...</div>
      </div>
      <div class="activity-chart-body" id="activity-chart-body" hidden></div>
      <div class="activity-footer">
        <span class="activity-count-label" id="activity-count-label"></span>
        <span class="activity-updated-label" id="activity-updated-label"></span>
      </div>
    </div>
  `;
  document.body.appendChild(activityModalEl);

  activityModalEl.addEventListener('click', (e) => {
    if (e.target === activityModalEl) closeActivityView();
  });
  activityModalEl.querySelector('#activity-modal-close').addEventListener('click', closeActivityView);
  activityModalEl.querySelector('#activity-reload-btn').addEventListener('click', () => loadActivity(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activityModalEl.classList.contains('modal-visible')) {
      const detail = document.querySelector('.modal-overlay.modal-visible');
      if (detail) return; // 詳細モーダルを重ねている場合はそちらが先に閉じる
      closeActivityView();
    }
  });
  activityModalEl.querySelector('#activity-date-from').addEventListener('change', (e) => {
    activityDateFrom = e.target.value;
    renderActivityControls();
    renderActivityBody();
  });
  activityModalEl.querySelector('#activity-date-to').addEventListener('change', (e) => {
    activityDateTo = e.target.value;
    renderActivityControls();
    renderActivityBody();
  });
  activityModalEl.querySelector('#activity-search').addEventListener('input', (e) => {
    activitySearchQuery = e.target.value.trim();
    renderActivityControls();
    renderActivityBody();
  });

  return activityModalEl;
}

function openActivityView() {
  const modal = getOrCreateActivityModal();
  activityTypeFilter = 'all';
  activityProjectFilter = '';
  activityDateFrom = '';
  activityDateTo = '';
  activitySearchQuery = '';
  modal.querySelector('#activity-date-from').value = '';
  modal.querySelector('#activity-date-to').value = '';
  modal.querySelector('#activity-search').value = '';
  modal.classList.add('modal-visible');
  loadActivity(false);
}

function closeActivityView() {
  if (activityModalEl) activityModalEl.classList.remove('modal-visible');
}

async function loadActivity(isReload) {
  const modal = getOrCreateActivityModal();
  const body = modal.querySelector('#activity-body');
  if (!isReload || activityRawEvents.length === 0) {
    body.innerHTML = '<div class="activity-loading">読み込み中...</div>';
  }
  try {
    const res = await fetch('/api/activity');
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    activityRawEvents = data;
    activityNormalized = data.map(normalizeActivityEvent);
    activityUpdatedAt = new Date().toISOString();
    renderActivityControls();
    renderActivityBody();
  } catch (e) {
    console.error('[activity] Failed to load:', e);
    body.innerHTML = `<div class="activity-error">${activityIconHtml('warning')} 履歴の取得に失敗したよ(${escapeHtml(String(e.message || e))})</div>`;
  }
}

// --- 絞り込み ---
// type以外の条件(project/search/date)だけを適用した配列。タブ・チップのバッジ件数を、
// 「今のタブ/チップを切り替えたら実際何件になるか」が分かるように出すための土台。
function activityEventsExceptType() {
  let result = activityNormalized;
  if (activityProjectFilter) result = result.filter(ev => ev.project === activityProjectFilter);
  if (activitySearchQuery) {
    const q = activitySearchQuery.toLowerCase();
    result = result.filter(ev => (ev.id && ev.id.toLowerCase().includes(q)) || (ev.title && ev.title.toLowerCase().includes(q)));
  }
  if (activityDateFrom) result = result.filter(ev => ev.date >= activityDateFrom);
  if (activityDateTo) result = result.filter(ev => ev.date <= activityDateTo);
  return result;
}
function activityEventsExceptProject() {
  let result = activityTypeFilter === 'all' ? activityNormalized : activityNormalized.filter(ev => ev.type === activityTypeFilter);
  if (activitySearchQuery) {
    const q = activitySearchQuery.toLowerCase();
    result = result.filter(ev => (ev.id && ev.id.toLowerCase().includes(q)) || (ev.title && ev.title.toLowerCase().includes(q)));
  }
  if (activityDateFrom) result = result.filter(ev => ev.date >= activityDateFrom);
  if (activityDateTo) result = result.filter(ev => ev.date <= activityDateTo);
  return result;
}
function filterActivityEvents() {
  let result = activityEventsExceptType();
  if (activityTypeFilter !== 'all') result = result.filter(ev => ev.type === activityTypeFilter);
  return result;
}

// --- ヘッダー・タブ・チップの描画 ---
function renderActivityControls() {
  const modal = activityModalEl;
  if (!modal) return;

  // 粒度セグメント(日/週/月)。グラフのスループットだけ週/月単位の集計が要るためその時だけ限定する。
  const chartNeedsGranularity = activityViewMode === 'chart' && activityChartType === 'throughput';
  const granEl = modal.querySelector('#activity-granularity');
  granEl.hidden = !(activityViewMode === 'timeline' || chartNeedsGranularity);
  if (chartNeedsGranularity && activityGranularity === 'day') {
    activityGranularity = 'week';
    localStorage.setItem('activityGranularity', activityGranularity);
  }
  const granDefs = chartNeedsGranularity ? ACTIVITY_GRANULARITY_DEFS.filter(g => g.key !== 'day') : ACTIVITY_GRANULARITY_DEFS;
  granEl.innerHTML = granDefs.map(g =>
    `<button type="button" class="activity-gran-btn${activityGranularity === g.key ? ' active' : ''}" data-gran="${g.key}">${g.label}</button>`
  ).join('');
  granEl.querySelectorAll('[data-gran]').forEach(btn => {
    btn.addEventListener('click', () => {
      activityGranularity = btn.dataset.gran;
      localStorage.setItem('activityGranularity', activityGranularity);
      renderActivityControls();
      renderActivityBody();
    });
  });

  // 表示形式トグル(タイムライン/グラフ)
  const viewModeEl = modal.querySelector('#activity-viewmode');
  viewModeEl.innerHTML = [
    { key: 'timeline', label: 'タイムライン' },
    { key: 'chart', label: 'グラフ' },
  ].map(v => `<button type="button" class="activity-gran-btn${activityViewMode === v.key ? ' active' : ''}" data-viewmode="${v.key}">${v.label}</button>`).join('');
  viewModeEl.querySelectorAll('[data-viewmode]').forEach(btn => {
    btn.addEventListener('click', () => {
      activityViewMode = btn.dataset.viewmode;
      localStorage.setItem('activityViewMode', activityViewMode);
      renderActivityControls();
      renderActivityBody();
    });
  });

  // グラフ種別タブ(グラフ表示時のみ)
  const chartTabsEl = modal.querySelector('#activity-chart-tabs');
  chartTabsEl.hidden = activityViewMode !== 'chart';
  chartTabsEl.innerHTML = ACTIVITY_CHART_DEFS.map(c =>
    `<button type="button" class="activity-gran-btn${activityChartType === c.key ? ' active' : ''}" data-chart="${c.key}">${c.label}</button>`
  ).join('');
  chartTabsEl.querySelectorAll('[data-chart]').forEach(btn => {
    btn.addEventListener('click', () => {
      activityChartType = btn.dataset.chart;
      localStorage.setItem('activityChartType', activityChartType);
      renderActivityControls();
      renderActivityBody();
    });
  });

  // 一括開閉ボタンはタイムライン専用
  modal.querySelectorAll('.activity-collapse-all-btn').forEach(btn => {
    btn.style.display = (activityViewMode === 'timeline') ? '' : 'none';
  });

  // 種別タブ(件数バッジ付き。type以外のフィルタを反映した件数にする)
  const tabsEl = modal.querySelector('#activity-tabs');
  const exceptType = activityEventsExceptType();
  const tabCounts = { all: exceptType.length, completed: 0, deleted: 0, other: 0 };
  for (const ev of exceptType) tabCounts[ev.type] = (tabCounts[ev.type] || 0) + 1;
  tabsEl.innerHTML = ACTIVITY_TYPE_DEFS.map(t =>
    `<button type="button" class="activity-tab${activityTypeFilter === t.key ? ' active' : ''}" data-type="${t.key}">${t.label}<span class="activity-tab-count">${tabCounts[t.key] || 0}</span></button>`
  ).join('');
  tabsEl.querySelectorAll('.activity-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activityTypeFilter = btn.dataset.type;
      renderActivityControls();
      renderActivityBody();
    });
  });

  // WSチップ(project以外のフィルタを反映した件数、もう一度押すと解除)
  const chipsEl = modal.querySelector('#activity-ws-chips');
  const exceptProject = activityEventsExceptProject();
  const byProject = {};
  for (const ev of exceptProject) {
    if (!ev.project) continue;
    byProject[ev.project] = (byProject[ev.project] || 0) + 1;
  }
  const projects = Object.keys(byProject).sort((a, b) => byProject[b] - byProject[a]);
  chipsEl.innerHTML = projects.map(p => {
    const isActive = activityProjectFilter === p;
    return `<button type="button" class="activity-ws-chip${isActive ? ' active' : ''}" data-project="${escapeHtml(p)}" title="${escapeHtml(p)}のイベントだけ表示">${escapeHtml(p)}<span class="activity-chip-count">${byProject[p]}</span></button>`;
  }).join('');
  chipsEl.querySelectorAll('.activity-ws-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.project;
      activityProjectFilter = (activityProjectFilter === p) ? '' : p;
      renderActivityControls();
      renderActivityBody();
    });
  });

  if (activityUpdatedAt) {
    const d = new Date(activityUpdatedAt);
    const pad = n => String(n).padStart(2, '0');
    modal.querySelector('#activity-updated-label').textContent = `更新 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

// --- レンダー単位の構築 ---
// 同一グループ内で同じ親EPICの完了子タスクが2件以上あれば、EPIC行1つにまとめて子をtreeでネストする。
// 1件だけの場合は親バッジ付きの通常行として出す(縦に間延びしないようにする、KIRO版と同じ判断)。
function buildActivityRenderUnits(events) {
  const byParent = new Map();
  for (const ev of events) {
    if (ev.type === 'completed' && ev.isChild && ev.parentId) {
      if (!byParent.has(ev.parentId)) byParent.set(ev.parentId, []);
      byParent.get(ev.parentId).push(ev);
    }
  }
  const epicIds = new Set();
  byParent.forEach((arr, pid) => { if (arr.length >= 2) epicIds.add(pid); });

  const units = [];
  const consumed = new Set();
  for (const ev of events) {
    const isGrouped = ev.type === 'completed' && ev.isChild && ev.parentId && epicIds.has(ev.parentId);
    if (isGrouped) {
      if (consumed.has(ev.parentId)) continue;
      consumed.add(ev.parentId);
      units.push({ kind: 'epic', parentId: ev.parentId, parentTitle: ev.parentTitle, project: ev.project, children: byParent.get(ev.parentId) });
    } else {
      units.push({ kind: 'event', event: ev });
    }
  }
  return units;
}

function resolveActivityItem(id) {
  if (!id) return null;
  if (typeof findItemById !== 'function') return null;
  return findItemById(id);
}

function buildActivityRowEl(ev, opts = {}) {
  const meta = activityEventMeta(ev);
  const row = document.createElement('div');
  row.className = `activity-row activity-row-${meta.cls}` + (opts.isChildRow ? ' activity-child-row' : '');

  const timeText = formatActivityTime(ev.ts);
  const idHtml = `<span class="activity-id">${escapeHtml(ev.id || '-')}</span>`;
  const wsHtml = (!opts.hideProject && ev.project) ? `<span class="activity-ws">${escapeHtml(ev.project)}</span>` : '';
  const typeHtml = `<span class="activity-type-label">${escapeHtml(meta.label)}</span>`;

  const parentHtml = (!opts.isChildRow && ev.isChild && ev.parentId)
    ? `<span class="activity-parent" data-parent-id="${escapeHtml(ev.parentId)}" data-child-id="${escapeHtml(ev.id || '')}" title="${escapeHtml(ev.parentTitle || ev.parentId)}">${activityIconHtml('stacks')}${escapeHtml(ev.parentId)}</span>`
    : '';

  const changeHtml = (ev.eventType === 'status_changed' && ev.oldValue && ev.newValue)
    ? `<span class="activity-tag">${escapeHtml(ev.oldValue)} → ${escapeHtml(ev.newValue)}</span>` : '';

  row.innerHTML = `
    <span class="activity-dot activity-dot-${meta.cls}" aria-hidden="true">${activityIconHtml(meta.icon)}</span>
    <div class="activity-row-main">
      <div class="activity-row-line1">
        ${typeHtml}${wsHtml}${idHtml}
        <span class="activity-title">${escapeHtml(ev.title || '')}</span>
      </div>
      <div class="activity-row-line2">${parentHtml}${changeHtml}</div>
    </div>
    <span class="activity-time">${timeText}</span>
  `;
  const line2 = row.querySelector('.activity-row-line2');
  if (!line2.textContent.trim() && !parentHtml) line2.remove();

  const target = resolveActivityItem(ev.id);
  if (target) {
    row.classList.add('activity-row-clickable');
    row.addEventListener('click', (e) => {
      if (e.target.closest('.activity-parent')) return;
      openCardDetail(target);
    });
  }

  const parentEl = row.querySelector('.activity-parent');
  if (parentEl) {
    parentEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openActivityParentEpic(parentEl.dataset.parentId, parentEl.dataset.childId);
    });
  }

  return row;
}

// 親EPICを開き、対象の子タスクをハイライトする(BT-199の元要件)。
// EPICがboard上に見つからない場合は子タスク自身の詳細にフォールバックする。
function openActivityParentEpic(parentId, childId) {
  const epic = resolveActivityItem(parentId);
  if (epic && typeof openEpicWithHighlight === 'function') {
    openEpicWithHighlight(epic, [childId]);
    return;
  }
  const child = resolveActivityItem(childId);
  if (child) openCardDetail(child);
}

function buildActivityEpicEl(unit) {
  const wrap = document.createElement('div');
  wrap.className = 'activity-row activity-row-epic';
  const titleText = unit.parentTitle || unit.parentId;
  wrap.innerHTML = `
    <span class="activity-dot activity-dot-epic" aria-hidden="true">${activityIconHtml('stacks')}</span>
    <div class="activity-row-main">
      <div class="activity-row-line1">
        <span class="activity-type-label">EPIC</span>
        ${unit.project ? `<span class="activity-ws">${escapeHtml(unit.project)}</span>` : ''}
        <span class="activity-id">${escapeHtml(unit.parentId)}</span>
        <span class="activity-title">${escapeHtml(titleText)}</span>
        <span class="activity-epic-count">${unit.children.length}件完了</span>
      </div>
    </div>
    <span class="activity-time"></span>
  `;

  const childIds = unit.children.map(c => c.id).filter(Boolean);
  const epicItem = resolveActivityItem(unit.parentId);
  if (epicItem) {
    wrap.classList.add('activity-row-clickable');
    wrap.addEventListener('click', () => {
      if (typeof openEpicWithHighlight === 'function') openEpicWithHighlight(epicItem, childIds);
      else openCardDetail(epicItem);
    });
  }

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'activity-children';
  for (const child of unit.children) {
    childrenWrap.appendChild(buildActivityRowEl(child, { isChildRow: true, hideProject: true }));
  }

  const block = document.createElement('div');
  block.className = 'activity-epic-block';
  block.appendChild(wrap);
  block.appendChild(childrenWrap);
  return block;
}

// 一括開閉ボタン。「すべて畳む」「すべて開く」を独立した2ボタンにして、押せない時はdisabledで示す。
function setupActivityCollapseAllBtn(groupKeys) {
  if (!activityModalEl) return;
  const collapsedCount = groupKeys.filter(k => isActivityGroupCollapsed(k)).length;

  const apply = (collapse) => {
    for (const k of groupKeys) {
      const ck = activityCollapseKey(k);
      if (collapse) activityCollapsedGroups.add(ck);
      else activityCollapsedGroups.delete(ck);
    }
    saveActivityCollapsed();
    renderActivityBody();
  };

  const collapseBtn = activityModalEl.querySelector('[data-collapse-action="collapse"]');
  const expandBtn = activityModalEl.querySelector('[data-collapse-action="expand"]');
  if (collapseBtn) {
    collapseBtn.disabled = groupKeys.length === 0 || collapsedCount === groupKeys.length;
    collapseBtn.onclick = () => apply(true);
  }
  if (expandBtn) {
    expandBtn.disabled = collapsedCount === 0;
    expandBtn.onclick = () => apply(false);
  }
}

// --- 本体の描画 ---
function renderActivityBody() {
  const modal = activityModalEl;
  if (!modal) return;
  const body = modal.querySelector('#activity-body');
  const chartBody = modal.querySelector('#activity-chart-body');

  const events = filterActivityEvents();
  modal.querySelector('#activity-count-label').textContent = `表示 ${events.length}件 / 全 ${activityNormalized.length}件`;

  if (activityViewMode === 'chart') {
    body.hidden = true;
    chartBody.hidden = false;
    renderActivityChart(chartBody, events);
    return;
  }
  body.hidden = false;
  chartBody.hidden = true;
  body.innerHTML = '';

  if (events.length === 0) {
    body.innerHTML = `<div class="activity-empty">この条件に当てはまる履歴はまだないよ</div>`;
    return;
  }

  const groups = new Map();
  for (const ev of events) {
    const key = activityGroupKey(ev.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  const timeline = document.createElement('div');
  timeline.className = 'activity-timeline';

  groups.forEach((groupEvents, key) => {
    const counts = { completed: 0, deleted: 0, other: 0 };
    for (const ev of groupEvents) counts[ev.type] = (counts[ev.type] || 0) + 1;
    const summaryParts = [];
    if (counts.completed) summaryParts.push(`完了 ${counts.completed}`);
    if (counts.deleted) summaryParts.push(`削除 ${counts.deleted}`);
    if (counts.other) summaryParts.push(`その他 ${counts.other}`);

    const collapsed = isActivityGroupCollapsed(key);
    const groupEl = document.createElement('div');
    groupEl.className = 'activity-group' + (collapsed ? ' group-collapsed' : '');

    const header = document.createElement('div');
    header.className = 'activity-group-header';
    header.innerHTML = `
      <button type="button" class="activity-group-toggle" title="${collapsed ? '開く' : '折りたたむ'}">${collapsed ? '▸' : '▾'}</button>
      <span class="activity-group-date">${escapeHtml(activityGroupLabel(key))}</span>
      <span class="activity-group-summary">${escapeHtml(summaryParts.join(' / '))}</span>
    `;
    header.addEventListener('click', () => {
      toggleActivityGroup(key);
      renderActivityBody();
    });
    groupEl.appendChild(header);

    if (!collapsed) {
      const groupBody = document.createElement('div');
      groupBody.className = 'activity-group-body';
      for (const unit of buildActivityRenderUnits(groupEvents)) {
        if (unit.kind === 'epic') groupBody.appendChild(buildActivityEpicEl(unit));
        else groupBody.appendChild(buildActivityRowEl(unit.event));
      }
      groupEl.appendChild(groupBody);
    }

    timeline.appendChild(groupEl);
  });

  setupActivityCollapseAllBtn([...groups.keys()]);
  body.appendChild(timeline);
  body.scrollTop = 0;
}

// ============================================================
// グラフ表示 (BT-245)
// ============================================================
function renderActivityChart(container, events) {
  container.innerHTML = '';
  if (events.length === 0) {
    container.innerHTML = `<div class="activity-empty">この条件に当てはまる履歴はまだないよ</div>`;
    return;
  }
  if (activityChartType === 'throughput') renderActivityThroughput(container, events);
  else if (activityChartType === 'composition') renderActivityComposition(container, events);
  else renderActivityHeatmap(container, events);
}

// (1) ヒートマップ: GitHub風の日別活動量。週を列、曜日を行とするマス目にイベント件数を濃淡で表す。
function renderActivityHeatmap(container, events) {
  const countsByDate = new Map();
  const allDates = [];
  for (const ev of events) {
    countsByDate.set(ev.date, (countsByDate.get(ev.date) || 0) + 1);
    allDates.push(ev.date);
  }
  allDates.sort();
  const minDate = allDates[0];
  const maxDate = allDates[allDates.length - 1];

  const weekStarts = [];
  let cur = activityParseDate(activityWeekStart(minDate));
  const endWeek = activityParseDate(activityWeekStart(maxDate));
  while (cur.getTime() <= endWeek.getTime()) {
    weekStarts.push(activityFormatYmd(cur));
    cur = new Date(cur.getTime());
    cur.setDate(cur.getDate() + 7);
  }

  const maxCount = Math.max(1, ...countsByDate.values());
  const CELL = 13, GAP = 3, STEP = CELL + GAP;
  const LEFT_PAD = 26, TOP_PAD = 18;
  const width = LEFT_PAD + weekStarts.length * STEP + 4;
  const height = TOP_PAD + 7 * STEP;
  const OPACITY_LEVELS = [1, 0.25, 0.45, 0.68, 1];

  let rects = '';
  let monthLabels = '';
  let lastMonth = '';

  weekStarts.forEach((wk, col) => {
    const wkDate = activityParseDate(wk);
    const monthLabel = `${wkDate.getMonth() + 1}月`;
    if (monthLabel !== lastMonth) {
      monthLabels += `<text x="${LEFT_PAD + col * STEP}" y="12" class="activity-heatmap-label">${monthLabel}</text>`;
      lastMonth = monthLabel;
    }
    for (let row = 0; row < 7; row++) {
      const d = new Date(wkDate.getTime());
      d.setDate(d.getDate() + row);
      const dateStr = activityFormatYmd(d);
      if (dateStr > maxDate) continue;
      const count = countsByDate.get(dateStr) || 0;
      const x = LEFT_PAD + col * STEP;
      const y = TOP_PAD + row * STEP;
      const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / maxCount) * 4));
      const fill = level === 0 ? 'var(--card)' : 'var(--accent)';
      const title = `${dateStr}（${ACTIVITY_DOW[d.getDay()]}） ${count}件`;
      rects += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}" fill-opacity="${OPACITY_LEVELS[level]}" stroke="var(--border)" stroke-width="1"><title>${escapeHtml(title)}</title></rect>`;
    }
  });

  const dowRowLabels = { 1: '月', 3: '水', 5: '金' };
  let dowText = '';
  Object.entries(dowRowLabels).forEach(([row, label]) => {
    dowText += `<text x="0" y="${TOP_PAD + Number(row) * STEP + CELL - 2}" class="activity-heatmap-label">${label}</text>`;
  });

  const legend = [0, 1, 2, 3, 4].map(level => {
    const fill = level === 0 ? 'var(--card)' : 'var(--accent)';
    return `<span class="activity-heatmap-legend-cell" style="background:${fill};opacity:${OPACITY_LEVELS[level]}"></span>`;
  }).join('');

  container.innerHTML = `
    <div class="activity-chart-scroll">
      <svg class="activity-heatmap-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
        ${monthLabels}${dowText}${rects}
      </svg>
    </div>
    <div class="activity-heatmap-legend"><span>少ない</span>${legend}<span>多い</span></div>
  `;
}

// (2) スループット: 週/月別の件数を種別(完了/削除/その他)積み上げの棒グラフで見せる。
function renderActivityThroughput(container, events) {
  const groups = new Map(); // key -> { completed, deleted, other }
  for (const ev of events) {
    const key = activityGroupKey(ev.date);
    if (!groups.has(key)) groups.set(key, { completed: 0, deleted: 0, other: 0 });
    const g = groups.get(key);
    g[ev.type] = (g[ev.type] || 0) + 1;
  }

  const keys = [...groups.keys()].sort();
  const totals = keys.map(k => { const g = groups.get(k); return g.completed + g.deleted + g.other; });
  const maxTotal = Math.max(1, ...totals);

  const BAR_W = 30, GAP = 16, CHART_H = 220, LEFT_PAD = 6;
  const width = LEFT_PAD + keys.length * (BAR_W + GAP);
  const height = CHART_H + 46;
  const TYPE_LABEL = { completed: '完了', deleted: '削除', other: 'その他' };

  let bars = '';
  keys.forEach((key, i) => {
    const g = groups.get(key);
    const total = g.completed + g.deleted + g.other;
    const x = LEFT_PAD + i * (BAR_W + GAP);
    let yCursor = CHART_H;
    for (const type of ['completed', 'deleted', 'other']) {
      const count = g[type];
      if (!count) continue;
      const h = (count / maxTotal) * (CHART_H - 4);
      const y = yCursor - h;
      bars += `<rect x="${x}" y="${y}" width="${BAR_W}" height="${h}" fill="${ACTIVITY_TYPE_COLOR[type]}"><title>${escapeHtml(activityGroupLabel(key))} ${TYPE_LABEL[type]} ${count}件</title></rect>`;
      yCursor = y;
    }
    const labelY = Math.max(10, yCursor - 6);
    bars += `<text x="${x + BAR_W / 2}" y="${labelY}" class="activity-throughput-total" text-anchor="middle">${total || ''}</text>`;
    const shortLabel = activityGranularity === 'month'
      ? `${parseInt(key.slice(5, 7), 10)}月`
      : (() => { const d = activityParseDate(key); return `${d.getMonth() + 1}/${d.getDate()}`; })();
    bars += `<text x="${x + BAR_W / 2}" y="${CHART_H + 18}" class="activity-throughput-label" text-anchor="middle">${escapeHtml(shortLabel)}</text>`;
  });

  const legend = ['completed', 'deleted', 'other'].map(type => `
    <span class="activity-chart-legend-item"><span class="activity-chart-legend-dot" style="background:${ACTIVITY_TYPE_COLOR[type]}"></span>${TYPE_LABEL[type]}</span>
  `).join('');

  container.innerHTML = `
    <div class="activity-chart-scroll">
      <svg class="activity-throughput-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
        <line x1="0" y1="${CHART_H}" x2="${width}" y2="${CHART_H}" stroke="var(--border)" stroke-width="1" />
        ${bars}
      </svg>
    </div>
    <div class="activity-chart-legend">${legend}</div>
  `;
}

// (3) 構成比: ワークスペース別のイベント件数をドーナツチャートで見せる。
function renderActivityComposition(container, events) {
  const counts = new Map();
  for (const ev of events) {
    const p = ev.project || '(不明)';
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, c]) => s + c, 0);

  const PALETTE = ['#7c8fff', '#f2994a', '#6fcf97', '#e57373', '#bb86fc', '#4fc3f7', '#ffd54f', '#a1887f', '#81c784', '#f06292'];
  const R = 80, CX = 100, CY = 100, STROKE = 32;
  const circumference = 2 * Math.PI * R;
  let offset = 0;
  let segments = '';
  entries.forEach(([project, count], i) => {
    const frac = count / total;
    const len = frac * circumference;
    const color = PALETTE[i % PALETTE.length];
    segments += `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-dasharray="${len} ${circumference - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${CX} ${CY})"><title>${escapeHtml(project)} ${count}件（${Math.round(frac * 100)}%）</title></circle>`;
    offset += len;
  });

  const legend = entries.map(([project, count], i) => {
    const color = PALETTE[i % PALETTE.length];
    const pct = Math.round((count / total) * 100);
    return `<div class="activity-chart-legend-item"><span class="activity-chart-legend-dot" style="background:${color}"></span>${escapeHtml(project)}<span class="activity-composition-count">${count}件 / ${pct}%</span></div>`;
  }).join('');

  container.innerHTML = `
    <div class="activity-composition-wrap">
      <svg class="activity-composition-svg" viewBox="0 0 200 200" width="220" height="220">
        ${segments}
        <text x="100" y="96" text-anchor="middle" class="activity-composition-total-num">${total}</text>
        <text x="100" y="116" text-anchor="middle" class="activity-composition-total-label">件</text>
      </svg>
      <div class="activity-composition-legend">${legend}</div>
    </div>
  `;
}

document.getElementById('activity-btn').addEventListener('click', openActivityView);
