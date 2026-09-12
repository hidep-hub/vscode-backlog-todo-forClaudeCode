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

let activityModalEl = null;
let activityAllEvents = [];
let activityCurrentType = 'all';
let activityCurrentGranularity = 'day';

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
        <select class="activity-granularity" id="activity-granularity">
          <option value="day">日別</option>
          <option value="week">週別</option>
          <option value="month">月別</option>
        </select>
      </div>
      <div class="activity-body" id="activity-body">
        <p class="activity-placeholder">読み込み中...</p>
      </div>
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

  return activityModalEl;
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
  const filtered = activityCurrentType === 'all'
    ? activityAllEvents
    : activityAllEvents.filter(ev => ev.eventType === activityCurrentType);

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

document.getElementById('activity-btn').addEventListener('click', openActivityView);
