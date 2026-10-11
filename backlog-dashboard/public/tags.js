'use strict';

// タグ管理画面(BT-394、EPIC BT-391)。ヘッダーのタグボタンから一覧モーダルを開き、
// タグの作成・改名・色変更・統合・削除を行う。タグはワークスペース単位で管理する。
// 自由入力でタグが乱立しないよう、入力中に似た名前を警告し、サーバー側(409)でも
// 完全一致の拒否・似た名前の確認(confirmSimilar)を求める。判定ロジックはtag-logic.js。

let tagModalEl = null;
let tagManagerWorkspace = '';
let tagManagerTags = [];
let tagEditingId = null;
let tagMergingId = null;
let tagSimilarTimer = null;
let tagHintSeq = 0; // 入力中ヒントの世代。送信・再入力のたびに進め、古い結果が警告を上書きしないようにする

async function tagFetchJson(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* 本文なし */ }
  return { status: res.status, body: body || {} };
}

function tagPost(path, payload) {
  return tagFetchJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, actor: 'user' }),
  });
}

/** プロジェクト名→ワークスペース(config.projects[].file)の対応。 */
function tagWorkspaceOptions() {
  const map = (currentBoardData && currentBoardData.projectFileMap) || {};
  return Object.keys(map).sort((a, b) => a.localeCompare(b, 'ja', { sensitivity: 'base' }))
    .map(name => ({ name, file: map[name] }));
}

function tagDefaultWorkspace(options) {
  const map = (currentBoardData && currentBoardData.projectFileMap) || {};
  if (currentFilter && map[currentFilter]) return map[currentFilter];
  return options.length ? options[0].file : '';
}

function tagChipHtml(tag) {
  return tagLogic.buildTagChipHtml(tag);
}

// --- モーダル ---
function getOrCreateTagModal() {
  if (tagModalEl) return tagModalEl;
  tagModalEl = document.createElement('div');
  tagModalEl.id = 'tag-modal-overlay';
  tagModalEl.className = 'tag-modal-overlay';
  tagModalEl.innerHTML = `
    <div class="tag-modal-content" role="dialog" aria-modal="true" aria-labelledby="tag-modal-title">
      <div class="tag-modal-header">
        <h3 id="tag-modal-title"><span class="material-icon icon-tag"></span> タグ管理</h3>
        <label class="tag-ws-label">ワークスペース
          <select id="tag-workspace-select" class="tag-ws-select"></select>
        </label>
        <button type="button" class="tag-modal-close" id="tag-modal-close" title="閉じる">&times;</button>
      </div>
      <form class="tag-create-bar" id="tag-create-form" autocomplete="off">
        <input type="text" id="tag-create-name" class="tag-input" placeholder="新しいタグ名（40文字まで）" maxlength="80" aria-label="新しいタグ名">
        <button type="submit" class="tag-create-btn" id="tag-create-btn">＋ 追加</button>
        <div class="tag-color-field">
          <div class="tag-swatches" role="group" aria-label="色見本">${tagLogic.buildSwatchesHtml('')}</div>
          <label class="tag-custom-color" title="見本にない色を選ぶ">その他の色
            <input type="color" id="tag-create-color" class="tag-color-input" value="#4a90d9" aria-label="その他の色">
          </label>
          <label class="tag-nocolor"><input type="checkbox" id="tag-create-nocolor" checked> 色なし</label>
        </div>
      </form>
      <div class="tag-note" id="tag-create-note" role="status" aria-live="polite" hidden></div>
      <div class="tag-modal-body" id="tag-modal-body"><div class="tag-empty">読み込み中...</div></div>
      <div class="tag-modal-footer">
        タグはワークスペースごとに管理します。似た名前のタグが増えないよう、追加時に近い名前を確認します。
        タスクへの付与は既存のタグから選びます。
      </div>
    </div>
  `;
  document.body.appendChild(tagModalEl);

  tagModalEl.addEventListener('click', (e) => { if (e.target === tagModalEl) closeTagModal(); });
  tagModalEl.querySelector('#tag-modal-close').addEventListener('click', closeTagModal);
  tagModalEl.querySelector('#tag-workspace-select').addEventListener('change', (e) => {
    tagManagerWorkspace = e.target.value;
    tagEditingId = null;
    tagMergingId = null;
    clearTagNote();
    loadTags();
  });
  const form = tagModalEl.querySelector('#tag-create-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); submitTagCreate(false); });
  tagModalEl.querySelector('#tag-create-name').addEventListener('input', scheduleSimilarHint);
  // 色の選択(作成フォーム・編集行で共通): 見本クリック/カラーピッカー/「色なし」を .tag-color-field 単位で同期する
  tagModalEl.addEventListener('click', (e) => {
    const swatch = e.target.closest('.tag-swatch');
    if (!swatch) return;
    const field = swatch.closest('.tag-color-field');
    const noColor = field.querySelector('.tag-nocolor input');
    if (swatch.dataset.color === '') {
      noColor.checked = true;
    } else {
      field.querySelector('input[type="color"]').value = swatch.dataset.color;
      noColor.checked = false;
    }
    syncTagSwatches(field);
  });
  tagModalEl.addEventListener('input', (e) => {
    if (!e.target.matches('.tag-color-field input[type="color"]')) return;
    const field = e.target.closest('.tag-color-field');
    field.querySelector('.tag-nocolor input').checked = false;
    syncTagSwatches(field);
  });
  tagModalEl.addEventListener('change', (e) => {
    if (e.target.matches('.tag-nocolor input')) syncTagSwatches(e.target.closest('.tag-color-field'));
  });
  tagModalEl.querySelector('#tag-create-note').addEventListener('click', (e) => {
    if (e.target.closest('.tag-note-force')) submitTagCreate(true);
    if (e.target.closest('.tag-note-cancel')) clearTagNote();
  });
  tagModalEl.querySelector('#tag-modal-body').addEventListener('click', onTagBodyClick);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (tagModalEl.classList.contains('modal-visible') && typeof isTopmostDialog === 'function' && isTopmostDialog(tagModalEl)) {
      e.preventDefault();
      e.stopPropagation();
      closeTagModal();
    }
  }, true);
  return tagModalEl;
}

/** 選択中の色(「色なし」なら空)に一致する見本だけを押下状態(aria-pressed)にする。 */
function syncTagSwatches(field) {
  const current = field.querySelector('.tag-nocolor input').checked
    ? '' : field.querySelector('input[type="color"]').value.toLowerCase();
  field.querySelectorAll('.tag-swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === current)));
}

function openTagModal(workspaceFile) {
  const modal = getOrCreateTagModal();
  const options = tagWorkspaceOptions();
  const select = modal.querySelector('#tag-workspace-select');
  select.innerHTML = options.map(o => `<option value="${escapeHtml(o.file)}">${escapeHtml(o.name)}</option>`).join('');
  tagManagerWorkspace = options.some(o => o.file === workspaceFile) ? workspaceFile : tagDefaultWorkspace(options);
  select.value = tagManagerWorkspace;
  tagEditingId = null;
  tagMergingId = null;
  clearTagNote();
  modal.querySelector('#tag-create-name').value = '';
  modal.querySelector('#tag-create-nocolor').checked = true; // 色は毎回「色なし」から選び直す
  syncTagSwatches(modal.querySelector('#tag-create-form .tag-color-field'));
  modal.classList.add('modal-visible');
  loadTags();
  modal.querySelector('#tag-create-name').focus();
}

function closeTagModal() {
  if (tagModalEl) tagModalEl.classList.remove('modal-visible');
}

async function loadTags() {
  const body = tagModalEl.querySelector('#tag-modal-body');
  if (!tagManagerWorkspace) {
    body.innerHTML = '<div class="tag-empty">ワークスペースがありません。</div>';
    return;
  }
  try {
    const res = await tagFetchJson(`/api/tags?workspace=${encodeURIComponent(tagManagerWorkspace)}`);
    if (res.status !== 200) throw new Error(res.body.error || `HTTP ${res.status}`);
    tagManagerTags = res.body.tags || [];
    renderTags();
  } catch (e) {
    body.innerHTML = `<div class="tag-empty">タグ一覧を取得できませんでした（${escapeHtml(e.message)}）。サーバーを最新版へ再起動すると使えます。</div>`;
  }
}

function renderTags() {
  const body = tagModalEl.querySelector('#tag-modal-body');
  if (tagManagerTags.length === 0) {
    body.innerHTML = '<div class="tag-empty">このワークスペースにはまだタグがありません。上の入力欄から追加できます。</div>';
    return;
  }
  const rows = tagManagerTags.map(tag => {
    if (tag.id === tagEditingId) return renderEditRow(tag);
    const merging = tag.id === tagMergingId;
    const row = `<tr data-tag-id="${tag.id}">
      <td class="tag-col-name">${tagChipHtml(tag)}</td>
      <td class="tag-col-num">${tag.usageCount ?? 0} 件</td>
      <td class="tag-col-actions">
        <button type="button" class="tag-action-btn" data-action="edit" title="名前・色を変更">編集</button>
        <button type="button" class="tag-action-btn" data-action="merge" title="別のタグに統合する"${tagManagerTags.length < 2 ? ' disabled' : ''}>統合</button>
        <button type="button" class="tag-action-btn tag-danger" data-action="delete" title="タグを削除する">削除</button>
      </td>
    </tr>`;
    return merging ? row + renderMergeRow(tag) : row;
  }).join('');
  body.innerHTML = `<table class="tag-table">
    <thead><tr><th>タグ</th><th class="tag-col-num">使用数</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  if (tagEditingId) {
    const input = body.querySelector('.tag-edit-name');
    if (input) input.focus();
  }
}

function renderEditRow(tag) {
  return `<tr class="tag-edit-row" data-tag-id="${tag.id}">
    <td colspan="3">
      <div class="tag-edit-form">
        <input type="text" class="tag-input tag-edit-name" value="${escapeHtml(tag.name)}" maxlength="80" aria-label="タグ名">
        <button type="button" class="tag-action-btn tag-primary" data-action="save">保存</button>
        <button type="button" class="tag-action-btn" data-action="cancel-edit">キャンセル</button>
        <div class="tag-color-field">
          <div class="tag-swatches" role="group" aria-label="色見本">${tagLogic.buildSwatchesHtml(tag.color)}</div>
          <label class="tag-custom-color" title="見本にない色を選ぶ">その他の色
            <input type="color" class="tag-color-input tag-edit-color" value="${escapeHtml(tag.color || '#4a90d9')}" aria-label="その他の色">
          </label>
          <label class="tag-nocolor"><input type="checkbox" class="tag-edit-nocolor"${tag.color ? '' : ' checked'}> 色なし</label>
        </div>
      </div>
      <div class="tag-row-error" role="alert" hidden></div>
    </td>
  </tr>`;
}

function renderMergeRow(source) {
  const targets = tagManagerTags.filter(t => t.id !== source.id);
  return `<tr class="tag-merge-row" data-tag-id="${source.id}">
    <td colspan="3">
      <div class="tag-edit-form">
        <span class="tag-merge-label">「${escapeHtml(source.name)}」の統合先:</span>
        <select class="tag-merge-target" aria-label="統合先のタグ">
          ${targets.map(t => `<option value="${t.id}">${escapeHtml(t.name)}（${t.usageCount ?? 0}件）</option>`).join('')}
        </select>
        <button type="button" class="tag-action-btn tag-primary" data-action="do-merge">統合する</button>
        <button type="button" class="tag-action-btn" data-action="cancel-merge">キャンセル</button>
      </div>
      <div class="tag-row-error" role="alert" hidden></div>
    </td>
  </tr>`;
}

function showRowError(rowEl, message) {
  const el = rowEl && rowEl.querySelector('.tag-row-error');
  if (!el) { alert(message); return; }
  el.textContent = message;
  el.hidden = false;
}

async function onTagBodyClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const rowEl = btn.closest('tr');
  const tagId = Number(rowEl.dataset.tagId);
  const tag = tagManagerTags.find(t => t.id === tagId);
  if (!tag) return;
  switch (btn.dataset.action) {
    case 'edit': tagEditingId = tagId; tagMergingId = null; clearTagNote(); renderTags(); break;
    case 'cancel-edit': tagEditingId = null; renderTags(); break;
    case 'merge': tagMergingId = tagId; tagEditingId = null; clearTagNote(); renderTags(); break;
    case 'cancel-merge': tagMergingId = null; renderTags(); break;
    case 'save': await saveTagEdit(tag, rowEl); break;
    case 'do-merge': await doTagMerge(tag, rowEl); break;
    case 'delete': await doTagDelete(tag); break;
    default: break;
  }
}

async function saveTagEdit(tag, rowEl) {
  const name = rowEl.querySelector('.tag-edit-name').value;
  const noColor = rowEl.querySelector('.tag-edit-nocolor').checked;
  const color = noColor ? null : rowEl.querySelector('.tag-edit-color').value;
  const clash = tagLogic.findExactTag(tagManagerTags, name, tag.id);
  if (clash) { showRowError(rowEl, `同じ名前のタグが既にあります: ${clash.name}`); return; }
  const res = await tagPost('/api/update-tag', { tagId: tag.id, name, color });
  if (res.status !== 200) { showRowError(rowEl, tagLogic.describeTagError(res.body).message); return; }
  tagEditingId = null;
  await loadTags();
}

async function doTagMerge(source, rowEl) {
  const targetId = Number(rowEl.querySelector('.tag-merge-target').value);
  const target = tagManagerTags.find(t => t.id === targetId);
  if (!target) return;
  if (!window.confirm(tagLogic.buildMergeMessage(source, target))) return;
  const res = await tagPost('/api/merge-tags', { sourceId: source.id, targetId });
  if (res.status !== 200) { showRowError(rowEl, tagLogic.describeTagError(res.body).message); return; }
  tagMergingId = null;
  await loadTags();
}

async function doTagDelete(tag) {
  if (!window.confirm(tagLogic.buildDeleteMessage(tag))) return;
  const res = await tagPost('/api/delete-tag', { tagId: tag.id });
  if (res.status !== 200) { alert(`削除できませんでした: ${tagLogic.describeTagError(res.body).message}`); return; }
  await loadTags();
}

// --- 作成 ---
function setTagNote(html, kind) {
  const note = tagModalEl.querySelector('#tag-create-note');
  note.className = `tag-note tag-note-${kind}`;
  note.innerHTML = html;
  note.hidden = false;
}

function clearTagNote() {
  if (!tagModalEl) return;
  const note = tagModalEl.querySelector('#tag-create-note');
  note.hidden = true;
  note.innerHTML = '';
}

/** 入力中に、完全一致/似た名前のタグがあれば先にヒントを出す(確定判定はサーバー)。 */
function scheduleSimilarHint() {
  clearTimeout(tagSimilarTimer);
  const seq = ++tagHintSeq;
  const name = tagModalEl.querySelector('#tag-create-name').value;
  if (!tagLogic.cleanTagName(name)) { clearTagNote(); return; }
  tagSimilarTimer = setTimeout(async () => {
    if (seq !== tagHintSeq) return;
    const exact = tagLogic.findExactTag(tagManagerTags, name);
    if (exact) {
      setTagNote(`同じ名前のタグが既にあります: ${tagChipHtml(exact)}`, 'error');
      return;
    }
    try {
      const res = await tagFetchJson(`/api/tags/similar?workspace=${encodeURIComponent(tagManagerWorkspace)}&name=${encodeURIComponent(name)}`);
      if (seq !== tagHintSeq) return;
      const similar = (res.body && res.body.similar) || [];
      if (similar.length > 0) setTagNote(`似た名前のタグがあります: ${similar.map(tagChipHtml).join(' ')}。既存のタグで足りないか確認してね。`, 'warn');
      else clearTagNote();
    } catch (e) { /* ヒントなので失敗は無視 */ }
  }, 250);
}

async function submitTagCreate(confirmSimilar) {
  clearTimeout(tagSimilarTimer);
  tagHintSeq += 1; // 送信後に遅れて届くヒントが、確認ボタン付きの警告を消さないようにする
  const nameEl = tagModalEl.querySelector('#tag-create-name');
  const noColor = tagModalEl.querySelector('#tag-create-nocolor').checked;
  const color = noColor ? null : tagModalEl.querySelector('#tag-create-color').value;
  const name = nameEl.value;
  if (!tagLogic.cleanTagName(name)) { setTagNote('タグ名を入力してください', 'error'); return; }
  const res = await tagPost('/api/create-tag', { workspace: tagManagerWorkspace, name, color, confirmSimilar });
  if (res.status === 200) {
    nameEl.value = '';
    clearTagNote();
    await loadTags();
    nameEl.focus();
    return;
  }
  const info = tagLogic.describeTagError(res.body);
  if (info.kind === 'similar') {
    setTagNote(`${info.similar.length ? '似た名前のタグがあります: ' + info.similar.map(tagChipHtml).join(' ') : info.message}
      <span class="tag-note-actions">
        <button type="button" class="tag-action-btn tag-note-force">それでも作成</button>
        <button type="button" class="tag-action-btn tag-note-cancel">やめる</button>
      </span>`, 'warn');
  } else {
    setTagNote(escapeHtml(info.message), 'error');
  }
}

document.getElementById('tag-btn').addEventListener('click', () => openTagModal());

// ============================================================
// タグの付け外し(BT-395): ポップオーバーのピッカー、詳細モーダルのタグ欄、登録フォームのタグ選択
// ============================================================
// タスクへ付けられるのは既存タグのみ(新規作成はタグ管理画面で、似た名前の確認を経て行う)。

let tagPickerEl = null;
let tagPickerCtx = null;

function tagWorkspaceForProject(projectName) {
  const map = (currentBoardData && currentBoardData.projectFileMap) || {};
  return map[projectName] || projectName || '';
}

function closeTagPicker() {
  if (tagPickerEl) tagPickerEl.remove();
  tagPickerEl = null;
  tagPickerCtx = null;
}

function positionTagPicker(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 4;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/**
 * 既存タグから選んで付け外しするポップオーバーを開く。
 * ctx: { anchor, workspace, selectedIds:Set, onToggle(tag, checked) => Promise<boolean> }
 * onToggleがfalseを返したら(失敗)チェック状態を元に戻す。
 */
async function openTagPicker(ctx) {
  closeTagPicker();
  const el = document.createElement('div');
  el.className = 'tag-picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'タグを選択');
  el.innerHTML = `
    <input type="search" class="tag-picker-search tag-input" placeholder="タグを絞り込み" aria-label="タグを絞り込み" autocomplete="off">
    <div class="tag-picker-list" role="group" aria-label="タグ一覧"><div class="tag-picker-empty">読み込み中...</div></div>
    <div class="tag-picker-footer"><button type="button" class="tag-picker-manage">タグ管理を開く…</button></div>`;
  document.body.appendChild(el);
  tagPickerEl = el;
  tagPickerCtx = { ...ctx, tags: [] };
  positionTagPicker(el, ctx.anchor);

  const listEl = el.querySelector('.tag-picker-list');
  const searchEl = el.querySelector('.tag-picker-search');
  const renderList = () => {
    const query = tagLogic.tagNameKey(searchEl.value);
    const tags = tagPickerCtx.tags.filter(t => !query || tagLogic.tagNameKey(t.name).includes(query));
    if (tagPickerCtx.tags.length === 0) {
      listEl.innerHTML = '<div class="tag-picker-empty">このワークスペースにはタグがありません。「タグ管理を開く」から作成できます。</div>';
    } else if (tags.length === 0) {
      listEl.innerHTML = '<div class="tag-picker-empty">一致するタグがありません。</div>';
    } else {
      listEl.innerHTML = tags.map(t => `<label class="tag-picker-row">
        <input type="checkbox" data-tag-id="${t.id}"${ctx.selectedIds.has(t.id) ? ' checked' : ''}>${tagLogic.buildTagChipHtml(t)}</label>`).join('');
    }
    positionTagPicker(el, ctx.anchor);
  };
  searchEl.addEventListener('input', renderList);
  listEl.addEventListener('change', async (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const tag = tagPickerCtx.tags.find(t => t.id === Number(box.dataset.tagId));
    if (!tag) return;
    box.disabled = true;
    let ok = false;
    try { ok = await ctx.onToggle(tag, box.checked); } catch (err) { ok = false; }
    if (!ok) box.checked = !box.checked;
    box.disabled = false;
  });
  el.querySelector('.tag-picker-manage').addEventListener('click', () => {
    closeTagPicker();
    openTagModal(ctx.workspace);
  });
  searchEl.focus();

  try {
    const res = await tagFetchJson(`/api/tags?workspace=${encodeURIComponent(ctx.workspace)}`);
    if (res.status !== 200) throw new Error(res.body.error || `HTTP ${res.status}`);
    if (tagPickerEl !== el) return; // 取得中に閉じられた
    tagPickerCtx.tags = res.body.tags || [];
    renderList();
  } catch (e) {
    listEl.innerHTML = `<div class="tag-picker-empty">タグを取得できませんでした（${escapeHtml(e.message)}）</div>`;
  }
}

// Escはピッカーだけを先に閉じる(背後のモーダルまで閉じない)。ピッカー外のクリックでも閉じる。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !tagPickerEl) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeTagPicker();
}, true);
document.addEventListener('mousedown', (e) => {
  if (!tagPickerEl) return;
  if (tagPickerEl.contains(e.target) || (tagPickerCtx && tagPickerCtx.anchor.contains(e.target))) return;
  closeTagPicker();
});

// --- 詳細モーダルのタグ欄(.detail-tag-list はapp.jsのbuildDetailTagsHtmlが描画する) ---
function tagIdsFromList(listEl) {
  return (listEl.dataset.tagIds || '').split(',').filter(Boolean).map(Number);
}

async function updateTaskTagsApi(taskId, change) {
  const res = await tagPost('/api/update-task-tags', { taskId, ...change });
  if (res.status !== 200) {
    alert(`タグを更新できませんでした: ${tagLogic.describeTagError(res.body).message}`);
    return null;
  }
  return res.body.tags || [];
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#add-task-tags')) return; // 登録フォーム側は下の専用ハンドラが処理する
  const addBtn = e.target.closest('.detail-tag-add-btn');
  if (addBtn) {
    const listEl = addBtn.closest('.detail-tag-list');
    const taskId = listEl.dataset.taskId;
    const selectedIds = new Set(tagIdsFromList(listEl));
    openTagPicker({
      anchor: addBtn,
      workspace: listEl.dataset.workspace,
      selectedIds,
      onToggle: async (tag, checked) => {
        const tags = await updateTaskTagsApi(taskId, checked ? { add: [tag.id] } : { remove: [tag.id] });
        if (!tags) return false;
        selectedIds.clear();
        tags.forEach(t => selectedIds.add(t.id));
        return true;
      },
    });
    return;
  }
  const removeBtn = e.target.closest('.detail-tag-list .tag-chip-remove');
  if (removeBtn) {
    const listEl = removeBtn.closest('.detail-tag-list');
    removeBtn.disabled = true;
    const tags = await updateTaskTagsApi(listEl.dataset.taskId, { remove: [Number(removeBtn.dataset.tagId)] });
    if (!tags) removeBtn.disabled = false; // 成功時はboardの再描画でタグ欄ごと更新される
  }
});

// --- 登録フォームのタグ選択(app.jsのgetOrCreateAddFormが #add-task-tags を用意する) ---
let addFormTags = []; // 選択中のタグ [{id,name,color}]

function getAddFormTagIds() {
  return addFormTags.map(t => t.id);
}

function renderAddFormTags(form) {
  const box = form.querySelector('#add-task-tags');
  if (!box) return;
  box.innerHTML = addFormTags.map(t => tagLogic.buildTagChipHtml(t, { removable: true })).join('')
    + '<button type="button" class="add-form-tag-btn" title="既存のタグから選ぶ">＋ タグ</button>';
}

function resetAddFormTags(form) {
  addFormTags = [];
  closeTagPicker();
  renderAddFormTags(form);
}

document.addEventListener('click', (e) => {
  const box = e.target.closest('#add-task-tags');
  if (!box) return;
  const form = box.closest('.modal-overlay');
  const removeBtn = e.target.closest('.tag-chip-remove');
  if (removeBtn) {
    addFormTags = addFormTags.filter(t => t.id !== Number(removeBtn.dataset.tagId));
    renderAddFormTags(form);
    return;
  }
  const addBtn = e.target.closest('.add-form-tag-btn');
  if (!addBtn) return;
  const projectName = form.querySelector('#add-task-project').value;
  openTagPicker({
    anchor: addBtn,
    workspace: tagWorkspaceForProject(projectName),
    selectedIds: new Set(getAddFormTagIds()),
    onToggle: async (tag, checked) => {
      addFormTags = checked ? addFormTags.concat(tag) : addFormTags.filter(t => t.id !== tag.id);
      renderAddFormTags(form);
      return true;
    },
  });
});

// ============================================================
// タグ絞り込み(BT-396): ヘッダーのボタン+ポップオーバー、絞り込み中バー
// ============================================================
// 状態(tagFilter)はapp.jsが持つ。ここでは変更・保存・再描画を行う。判定はtag-logic.js。
// 絞り込みはタグ名で行うため、全プロジェクト表示では同名タグをワークスペースをまたいで1つにまとめて出す。

let tagFilterPopEl = null;

function saveTagFilter() {
  try { localStorage.setItem('tagFilter', JSON.stringify(tagFilter)); } catch (e) { /* 保存できなくても動作は続ける */ }
}

/** 状態の変更後に呼ぶ: 保存し、ボタン・バーを更新して、開いている画面(ボード/週次計画/ガント)を再描画する。 */
function applyTagFilter() {
  saveTagFilter();
  renderTagFilterControls();
  if (currentBoardData) renderBoard(currentBoardData);
  const plan = document.getElementById('plan-board-overlay');
  if (plan && plan.classList.contains('active') && typeof renderPlanBoard === 'function') renderPlanBoard();
}

function setTagFilterMode(mode) {
  tagFilter = { ...tagFilter, mode: mode === 'and' ? 'and' : 'or' };
  applyTagFilter();
}

function toggleTagFilterKey(option, checked) {
  const rest = tagFilter.tags.filter(t => t.key !== option.key);
  tagFilter = { ...tagFilter, tags: checked ? rest.concat({ key: option.key, name: option.name, color: option.color }) : rest };
  applyTagFilter();
}

function clearTagFilter() {
  tagFilter = { ...tagFilter, tags: [] };
  applyTagFilter();
}

function renderTagFilterControls() {
  const btn = document.getElementById('tag-filter-btn');
  const count = document.getElementById('tag-filter-count');
  const bar = document.getElementById('tag-filter-bar');
  const active = tagFilter.tags.length > 0;
  btn.classList.toggle('filter-active', active);
  count.hidden = !active;
  count.textContent = String(tagFilter.tags.length);
  bar.hidden = !active;
  if (!active) { bar.innerHTML = ''; return; }
  const modeLabel = tagFilter.mode === 'and' ? 'すべて' : 'どれか';
  bar.innerHTML = `<span class="tag-filter-bar-label">タグ</span>`
    + tagFilter.tags.map(t => tagLogic.buildTagChipHtml({ id: t.key, name: t.name, color: t.color }, { small: true, removable: true })).join('')
    + `<button type="button" class="tag-filter-mode-btn" title="複数のタグの条件を切り替える（どれか / すべて）">${modeLabel}</button>`
    + '<button type="button" class="tag-filter-clear-btn" title="タグの絞り込みを解除">解除</button>';
}

function closeTagFilterPopover() {
  if (tagFilterPopEl) tagFilterPopEl.remove();
  tagFilterPopEl = null;
}

async function openTagFilterPopover() {
  closeTagFilterPopover();
  closeTagPicker();
  const anchor = document.getElementById('tag-filter-btn');
  const el = document.createElement('div');
  el.className = 'tag-picker tag-filter-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'タグで絞り込み');
  el.innerHTML = `
    <div class="tag-filter-mode" role="radiogroup" aria-label="複数のタグの条件">
      <label><input type="radio" name="tag-filter-mode" value="or"> どれかを含む</label>
      <label><input type="radio" name="tag-filter-mode" value="and"> すべてを含む</label>
    </div>
    <input type="search" class="tag-picker-search tag-input" placeholder="タグを絞り込み" aria-label="タグを絞り込み" autocomplete="off">
    <div class="tag-picker-list" role="group" aria-label="タグ一覧"><div class="tag-picker-empty">読み込み中...</div></div>
    <div class="tag-picker-footer tag-filter-footer">
      <button type="button" class="tag-picker-manage" data-act="manage">タグ管理を開く…</button>
      <button type="button" class="tag-picker-manage" data-act="clear">絞り込みを解除</button>
    </div>`;
  document.body.appendChild(el);
  tagFilterPopEl = el;
  positionTagPicker(el, anchor);

  const listEl = el.querySelector('.tag-picker-list');
  const searchEl = el.querySelector('.tag-picker-search');
  let options = [];
  const selectedKeys = () => new Set(tagFilter.tags.map(t => t.key));
  const syncMode = () => { el.querySelector(`input[name="tag-filter-mode"][value="${tagFilter.mode}"]`).checked = true; };
  const renderList = () => {
    const query = tagLogic.tagNameKey(searchEl.value);
    const chosen = selectedKeys();
    // 選択中のタグは(使用数が0になっていても)必ず並べ、解除できるようにする
    const merged = options.concat(tagFilter.tags.filter(t => !options.some(o => o.key === t.key)).map(t => ({ ...t, usageCount: 0 })));
    const shown = merged.filter(o => !query || o.key.includes(query));
    if (merged.length === 0) {
      listEl.innerHTML = '<div class="tag-picker-empty">タスクに付いているタグがまだありません。</div>';
    } else if (shown.length === 0) {
      listEl.innerHTML = '<div class="tag-picker-empty">一致するタグがありません。</div>';
    } else {
      listEl.innerHTML = shown.map(o => `<label class="tag-picker-row">
        <input type="checkbox" data-key="${tagLogic.escapeText(o.key)}"${chosen.has(o.key) ? ' checked' : ''}>${tagLogic.buildTagChipHtml({ id: o.key, name: o.name, color: o.color })}
        <span class="tag-filter-usage">${o.usageCount}件</span></label>`).join('');
    }
    positionTagPicker(el, anchor);
  };
  syncMode();
  el.querySelectorAll('input[name="tag-filter-mode"]').forEach(r => r.addEventListener('change', () => setTagFilterMode(r.value)));
  searchEl.addEventListener('input', renderList);
  listEl.addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const merged = options.concat(tagFilter.tags.map(t => ({ ...t, usageCount: 0 })));
    const option = merged.find(o => o.key === box.dataset.key);
    if (option) toggleTagFilterKey(option, box.checked);
    if (tagFilterPopEl === el) renderList();
  });
  el.querySelector('.tag-filter-footer').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'clear') { clearTagFilter(); renderList(); return; }
    closeTagFilterPopover();
    openTagModal(currentFilter ? tagWorkspaceForProject(currentFilter) : undefined);
  });
  searchEl.focus();

  try {
    const file = currentFilter ? tagWorkspaceForProject(currentFilter) : '';
    const res = await tagFetchJson(file ? `/api/tags?workspace=${encodeURIComponent(file)}` : '/api/tags');
    if (res.status !== 200) throw new Error(res.body.error || `HTTP ${res.status}`);
    if (tagFilterPopEl !== el) return; // 取得中に閉じられた
    options = tagLogic.buildTagFilterOptions(res.body.tags || []);
    renderList();
  } catch (e) {
    listEl.innerHTML = `<div class="tag-picker-empty">タグを取得できませんでした（${escapeHtml(e.message)}）</div>`;
  }
}

document.getElementById('tag-filter-btn').addEventListener('click', () => {
  if (tagFilterPopEl) closeTagFilterPopover(); else openTagFilterPopover();
});

// 絞り込み中バーの操作: 個別の×、条件(どれか/すべて)の切り替え、解除
document.getElementById('tag-filter-bar').addEventListener('click', (e) => {
  const remove = e.target.closest('.tag-chip-remove');
  if (remove) {
    tagFilter = { ...tagFilter, tags: tagFilter.tags.filter(t => t.key !== remove.dataset.tagId) };
    applyTagFilter();
    return;
  }
  if (e.target.closest('.tag-filter-mode-btn')) { setTagFilterMode(tagFilter.mode === 'and' ? 'or' : 'and'); return; }
  if (e.target.closest('.tag-filter-clear-btn')) clearTagFilter();
});

// Escで先に閉じる/外側クリックで閉じる(タグ選択ポップオーバーと同じ作法)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !tagFilterPopEl) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeTagFilterPopover();
}, true);
document.addEventListener('mousedown', (e) => {
  if (!tagFilterPopEl) return;
  if (tagFilterPopEl.contains(e.target) || e.target.closest('#tag-filter-btn')) return;
  closeTagFilterPopover();
});

renderTagFilterControls();
