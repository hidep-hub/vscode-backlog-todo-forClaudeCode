'use strict';

// 履歴ダイアログ(BT-244)。BT-243のGET /api/activityを日/週/月グルーピング +
// EPIC(親タスク)配下の完了子タスクまとめ表示で描画する。
// 検索・期間絞り込み・ヘッダー起動ボタンの本実装はBT-246の担当(このファイルでは
// 暫定でヘッダーに直接ボタンを置き、openActivityView()を呼ぶだけにしている)。

const ACTIVITY_TYPE_ORDER = [
  'created', 'status_changed', 'pinned', 'unpinned',
  'running_started', 'running_stopped', 'assigned', 'deleted',
];

const ACTIVITY_TYPE_ICON = {
  created: '✨',
  status_changed: '🔄',
  pinned: '📌',
  unpinned: '📍',
  running_started: '▶',
  running_stopped: '⏸',
  assigned: '👤',
  deleted: '🗑',
};

// event_typesシード(schema.js)と同じ日本語ラベル。まだ1件も発生していない種別は
// activityAllEventsから拾えないため、タブ表示用にフロント側でも固定で持つ。
const ACTIVITY_TYPE_LABEL = {
  created: '作成',
  status_changed: 'ステータス変更',
  pinned: '今日やるに追加',
  unpinned: '今日やるから解除',
  running_started: '実行中に設定',
  running_stopped: '実行中を解除',
  assigned: '担当変更',
  deleted: '削除',
};

// スループット積み上げ棒グラフ用の色(KIRO版のcompleted/deleted/decision 3色分類とは異なり、
// backlog-todoのtask_eventsは8種のevent_typeを持つため、種別ごとに割り当てる)。
const ACTIVITY_TYPE_COLOR = {
  created: '#7c8fff',
  status_changed: 'var(--badge-done-fg)',
  pinned: '#f2994a',
  unpinned: '#bfa76f',
  running_started: '#4fc3f7',
  running_stopped: '#8899aa',
  assigned: 'var(--tag-category-fg)',
  deleted: '#e57373',
};

const ACTIVITY_CHART_DEFS = [
  { key: 'heatmap', label: 'ヒートマップ' },
  { key: 'throughput', label: 'スループット' },
  { key: 'composition', label: '構成比' },
];

let activityModalEl = null;
let activityAllEvents = [];
let activityCurrentType = 'all';
let activityCurrentGranularity = 'day';
let activityViewMode = 'timeline'; // timeline | chart
let activityChartType = 'heatmap'; // heatmap | throughput | composition

function getOrCreateActivityModal() {
  if (activityModalEl) return activityModalEl;
  activityModalEl = document.createElement('div');
  activityModalEl.id = 'activity-modal-overlay';
  activityModalEl.className = 'modal-overlay';
  activityModalEl.innerHTML = `
    <div class="modal-content modal-wide activity-modal">
      <button class="modal-close" id="activity-modal-close">&times;</button>
      <h3>🕘 履歴</h3>
      <div class="activity-toolbar">
        <div class="activity-tabs" id="activity-tabs"></div>
        <div class="activity-toolbar-right">
          <div class="activity-viewmode" id="activity-viewmode">
            <button type="button" class="activity-gran-btn active" data-mode="timeline">タイムライン</button>
            <button type="button" class="activity-gran-btn" data-mode="chart">グラフ</button>
          </div>
          <div class="activity-chart-tabs" id="activity-chart-tabs" hidden>
            ${ACTIVITY_CHART_DEFS.map(c => `<button type="button" class="activity-gran-btn${c.key === activityChartType ? ' active' : ''}" data-chart="${c.key}">${c.label}</button>`).join('')}
          </div>
          <select class="activity-granularity" id="activity-granularity">
            <option value="day">日別</option>
            <option value="week">週別</option>
            <option value="month">月別</option>
          </select>
        </div>
      </div>
      <div class="activity-body" id="activity-body">
        <p class="activity-placeholder">読み込み中...</p>
      </div>
      <div class="activity-chart-body" id="activity-chart-body" hidden></div>
    </div>
  `;
  document.body.appendChild(activityModalEl);

  activityModalEl.addEventListener('click', (e) => {
    if (e.target === activityModalEl) closeActivityModal();
  });
  activityModalEl.querySelector('#activity-modal-close').addEventListener('click', closeActivityModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activityModalEl.classList.contains('modal-visible')) closeActivityModal();
  });
  activityModalEl.querySelector('#activity-granularity').addEventListener('change', (e) => {
    activityCurrentGranularity = e.target.value;
    renderActivityBody();
  });
  activityModalEl.querySelector('#activity-viewmode').querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      activityViewMode = btn.dataset.mode;
      activityModalEl.querySelectorAll('#activity-viewmode [data-mode]').forEach(b => b.classList.toggle('active', b === btn));
      updateActivityControlsVisibility();
      renderActivityBody();
    });
  });
  activityModalEl.querySelector('#activity-chart-tabs').querySelectorAll('[data-chart]').forEach(btn => {
    btn.addEventListener('click', () => {
      activityChartType = btn.dataset.chart;
      activityModalEl.querySelectorAll('#activity-chart-tabs [data-chart]').forEach(b => b.classList.toggle('active', b === btn));
      updateActivityControlsVisibility();
      renderActivityBody();
    });
  });

  return activityModalEl;
}

// グラフ種別・表示モードに応じて「グラフ種別タブ」「日/週/月セレクタ」の要不要を切り替える。
// heatmap/compositionは期間粒度を使わないため隠し、throughputは週/月のみ選べるようにする(日別だと棒が細かすぎるため)。
function updateActivityControlsVisibility() {
  const chartTabsEl = activityModalEl.querySelector('#activity-chart-tabs');
  const granEl = activityModalEl.querySelector('#activity-granularity');
  chartTabsEl.hidden = activityViewMode !== 'chart';

  const needsGranularity = activityViewMode === 'timeline'
    || (activityViewMode === 'chart' && activityChartType === 'throughput');
  granEl.hidden = !needsGranularity;

  if (activityViewMode === 'chart' && activityChartType === 'throughput' && activityCurrentGranularity === 'day') {
    activityCurrentGranularity = 'week';
    granEl.value = 'week';
  }
  granEl.querySelector('option[value="day"]').hidden = activityViewMode === 'chart' && activityChartType === 'throughput';
}

function closeActivityModal() {
  if (activityModalEl) activityModalEl.classList.remove('modal-visible');
}

async function openActivityView() {
  const modal = getOrCreateActivityModal();
  modal.classList.add('modal-visible');
  const bodyEl = modal.querySelector('#activity-body');
  bodyEl.innerHTML = `<p class="activity-placeholder">読み込み中...</p>`;
  try {
    const res = await fetch('/api/activity');
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || '取得に失敗しました');
    activityAllEvents = data;
    renderActivityTabs();
    updateActivityControlsVisibility();
    renderActivityBody();
  } catch (err) {
    bodyEl.innerHTML = `<p class="activity-placeholder">読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
  }
}

function renderActivityTabs() {
  const tabsEl = activityModalEl.querySelector('#activity-tabs');
  const tabs = [{ code: 'all', label: 'すべて' }].concat(
    ACTIVITY_TYPE_ORDER.map(code => ({ code, label: ACTIVITY_TYPE_LABEL[code] || code }))
  );
  tabsEl.innerHTML = tabs.map(t => `
    <button class="activity-tab${t.code === activityCurrentType ? ' active' : ''}" data-type="${t.code}">${escapeHtml(t.label)}</button>
  `).join('');
  tabsEl.querySelectorAll('.activity-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activityCurrentType = btn.dataset.type;
      tabsEl.querySelectorAll('.activity-tab').forEach(b => b.classList.toggle('active', b === btn));
      renderActivityBody();
    });
  });
}

function activityGroupKey(occurredAt, granularity) {
  const d = new Date(occurredAt);
  if (granularity === 'month') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  if (granularity === 'week') {
    const monday = new Date(d);
    const dow = (monday.getDay() + 6) % 7; // 月曜=0
    monday.setDate(monday.getDate() - dow);
    monday.setHours(0, 0, 0, 0);
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function activityGroupLabel(key, granularity) {
  if (granularity === 'month') {
    const [y, m] = key.split('-');
    return `${y}年${m}月`;
  }
  if (granularity === 'week') {
    const start = new Date(key);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
    return `${fmt(start)} 〜 ${fmt(end)}`;
  }
  const [y, m, dd] = key.split('-');
  return `${y}年${m}月${dd}日`;
}

// 同一グループ内で同じ親を持つ完了(done)子タスクが2件以上あれば、
// 親タスクの下にまとめてぶら下げる(EPIC分の子タスク完了をひとかたまりで見せる)。
function buildActivityRenderUnits(events) {
  const doneChildCountByParent = {};
  for (const ev of events) {
    if (ev.eventType === 'status_changed' && ev.newValue === 'done' && ev.parentId) {
      doneChildCountByParent[ev.parentId] = (doneChildCountByParent[ev.parentId] || 0) + 1;
    }
  }
  const units = [];
  const epicUnitByParent = {};
  for (const ev of events) {
    const isEpicChild = ev.eventType === 'status_changed' && ev.newValue === 'done'
      && ev.parentId && doneChildCountByParent[ev.parentId] >= 2;
    if (isEpicChild) {
      let unit = epicUnitByParent[ev.parentId];
      if (!unit) {
        unit = { type: 'epic', parentId: ev.parentId, parentTitle: ev.parentTitle, children: [] };
        epicUnitByParent[ev.parentId] = unit;
        units.push(unit);
      }
      unit.children.push(ev);
    } else {
      units.push({ type: 'single', event: ev });
    }
  }
  return units;
}

function renderActivityBody() {
  const bodyEl = activityModalEl.querySelector('#activity-body');
  const chartBodyEl = activityModalEl.querySelector('#activity-chart-body');
  const filtered = activityCurrentType === 'all'
    ? activityAllEvents
    : activityAllEvents.filter(ev => ev.eventType === activityCurrentType);

  if (activityViewMode === 'chart') {
    bodyEl.hidden = true;
    chartBodyEl.hidden = false;
    renderActivityChart(chartBodyEl, filtered);
    return;
  }
  bodyEl.hidden = false;
  chartBodyEl.hidden = true;

  if (filtered.length === 0) {
    bodyEl.innerHTML = `<p class="activity-placeholder">履歴がありません。</p>`;
    return;
  }

  const groups = new Map();
  for (const ev of filtered) {
    const key = activityGroupKey(ev.occurredAt, activityCurrentGranularity);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  let html = '';
  for (const [key, events] of groups) {
    const units = buildActivityRenderUnits(events);
    html += `
      <div class="activity-group">
        <div class="activity-group-header">${escapeHtml(activityGroupLabel(key, activityCurrentGranularity))}</div>
        <div class="activity-group-body">
          ${units.map(renderActivityUnit).join('')}
        </div>
      </div>
    `;
  }
  bodyEl.innerHTML = html;

  bodyEl.querySelectorAll('.activity-parent-link').forEach(el => {
    el.addEventListener('click', () => {
      const item = findItemById(el.dataset.parentId);
      if (item) openCardDetail(item);
    });
  });
}

function renderActivityUnit(unit) {
  if (unit.type === 'epic') {
    return `
      <div class="activity-epic">
        <div class="activity-epic-header">
          <span class="activity-parent-link" data-parent-id="${escapeHtml(unit.parentId)}">${escapeHtml(unit.parentId)} ${escapeHtml(unit.parentTitle || '')}</span>
          <span class="activity-epic-count">子タスク完了 ${unit.children.length}件</span>
        </div>
        <div class="activity-epic-children">
          ${unit.children.map(renderActivityRow).join('')}
        </div>
      </div>
    `;
  }
  return renderActivityRow(unit.event);
}

function renderActivityRow(ev) {
  const icon = ACTIVITY_TYPE_ICON[ev.eventType] || '•';
  const time = formatActivityTime(ev.occurredAt);
  const parentBadge = ev.parentId
    ? `<span class="activity-parent-link" data-parent-id="${escapeHtml(ev.parentId)}">${escapeHtml(ev.parentId)}</span>`
    : '';
  return `
    <div class="activity-row">
      <span class="activity-row-icon">${icon}</span>
      <span class="activity-row-main">
        ${parentBadge}
        <span class="activity-row-task">${escapeHtml(ev.taskId)} ${escapeHtml(ev.taskTitle || '')}</span>
        <span class="activity-row-label">${escapeHtml(ev.eventLabel || ev.eventType)}</span>
        ${renderActivityValueChange(ev)}
      </span>
      <span class="activity-row-time">${time}</span>
    </div>
  `;
}

function renderActivityValueChange(ev) {
  if (ev.eventType === 'status_changed' && ev.oldValue && ev.newValue) {
    return `<span class="activity-row-change">${escapeHtml(ev.oldValue)} → ${escapeHtml(ev.newValue)}</span>`;
  }
  return '';
}

function formatActivityTime(occurredAt) {
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ============================================================
// グラフ表示 (BT-245)
// ============================================================
// タイムラインと同じ絞り込み結果(events)を受け取り、種別(ヒートマップ/スループット/構成比)に
// 応じて自前のSVGで描画する。KIRO版(kiro-backlog-todo)のKT-188と同じ方針(CDNのグラフ
// ライブラリは使わない)を踏襲。

function activityDateOnly(occurredAt) {
  return activityGroupKey(occurredAt, 'day');
}

function activityWeekStartDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = (d.getDay() + 6) % 7; // 月曜=0
  d.setDate(d.getDate() - dow);
  return d;
}

function activityFormatYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderActivityChart(container, events) {
  container.innerHTML = '';
  if (events.length === 0) {
    container.innerHTML = `<p class="activity-placeholder">この条件に当てはまる履歴はありません。</p>`;
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
    const date = activityDateOnly(ev.occurredAt);
    countsByDate.set(date, (countsByDate.get(date) || 0) + 1);
    allDates.push(date);
  }
  allDates.sort();
  const minDate = allDates[0];
  const maxDate = allDates[allDates.length - 1];

  const weekStarts = [];
  let cur = activityWeekStartDate(minDate);
  const endWeek = activityWeekStartDate(maxDate);
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
  const DOW_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

  let rects = '';
  let monthLabels = '';
  let lastMonth = '';

  weekStarts.forEach((wk, col) => {
    const wkDate = new Date(`${wk}T00:00:00`);
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
      const title = `${dateStr}（${DOW_LABEL[d.getDay()]}） ${count}件`;
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

// (2) スループット: 週/月別の件数をイベント種別積み上げの棒グラフで見せる。
function renderActivityThroughput(container, events) {
  const groups = new Map(); // key -> { created: n, status_changed: n, ... }
  for (const ev of events) {
    const key = activityGroupKey(ev.occurredAt, activityCurrentGranularity);
    if (!groups.has(key)) groups.set(key, {});
    const g = groups.get(key);
    g[ev.eventType] = (g[ev.eventType] || 0) + 1;
  }

  const keys = [...groups.keys()].sort(); // 時系列昇順(左から右へ)
  const totals = keys.map(k => ACTIVITY_TYPE_ORDER.reduce((s, t) => s + (groups.get(k)[t] || 0), 0));
  const maxTotal = Math.max(1, ...totals);

  const BAR_W = 30, GAP = 16, CHART_H = 220, LEFT_PAD = 6;
  const width = LEFT_PAD + keys.length * (BAR_W + GAP);
  const height = CHART_H + 46;

  let bars = '';
  keys.forEach((key, i) => {
    const g = groups.get(key);
    const total = ACTIVITY_TYPE_ORDER.reduce((s, t) => s + (g[t] || 0), 0);
    const x = LEFT_PAD + i * (BAR_W + GAP);
    let yCursor = CHART_H;
    for (const type of ACTIVITY_TYPE_ORDER) {
      const count = g[type];
      if (!count) continue;
      const h = (count / maxTotal) * (CHART_H - 4);
      const y = yCursor - h;
      bars += `<rect x="${x}" y="${y}" width="${BAR_W}" height="${h}" fill="${ACTIVITY_TYPE_COLOR[type]}"><title>${escapeHtml(activityGroupLabel(key, activityCurrentGranularity))} ${escapeHtml(ACTIVITY_TYPE_LABEL[type])} ${count}件</title></rect>`;
      yCursor = y;
    }
    const labelY = Math.max(10, yCursor - 6);
    bars += `<text x="${x + BAR_W / 2}" y="${labelY}" class="activity-throughput-total" text-anchor="middle">${total || ''}</text>`;
    const shortLabel = activityCurrentGranularity === 'month'
      ? `${parseInt(key.slice(5, 7), 10)}月`
      : (() => { const d = new Date(`${key}T00:00:00`); return `${d.getMonth() + 1}/${d.getDate()}`; })();
    bars += `<text x="${x + BAR_W / 2}" y="${CHART_H + 18}" class="activity-throughput-label" text-anchor="middle">${escapeHtml(shortLabel)}</text>`;
  });

  const legend = ACTIVITY_TYPE_ORDER.map(type => `
    <span class="activity-chart-legend-item"><span class="activity-chart-legend-dot" style="background:${ACTIVITY_TYPE_COLOR[type]}"></span>${escapeHtml(ACTIVITY_TYPE_LABEL[type])}</span>
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
