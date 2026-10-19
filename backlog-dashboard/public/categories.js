'use strict';

// カテゴリ管理画面(BM-106、EPIC BM-101)。タグ管理画面(tags.js)と同じ骨格で、一覧モーダルから
// カテゴリの作成・改名・色変更・統合・削除を行う。カテゴリはワークスペース単位で管理する。
// タグと異なり1タスク1値のため、タスク側は複数選択ピッカーではなく<select>で選ぶ。
// 自由入力でカテゴリが乱立しないよう、入力中に似た名前を警告し、サーバー側(409)でも
// 完全一致の拒否・似た名前の確認(confirmSimilar)を求める。判定ロジックはcategory-logic.js。

let categoryModalEl = null;
let categoryManagerWorkspace = '';
let categoryManagerCategories = [];
let categoryEditingId = null;
let categoryMergingId = null;
let categorySimilarTimer = null;
let categoryHintSeq = 0; // 入力中ヒントの世代。送信・再入力のたびに進め、古い結果が警告を上書きしないようにする

async function categoryFetchJson(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* 本文なし */ }
  return { status: res.status, body: body || {} };
}

function categoryPost(path, payload) {
  return categoryFetchJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, actor: 'user' }),
  });
}

/** プロジェクト名→ワークスペース(config.projects[].file)の対応。tags.jsのtagWorkspaceOptionsと同じ。 */
function categoryWorkspaceOptions() {
  const map = (currentBoardData && currentBoardData.projectFileMap) || {};
  return Object.keys(map).sort((a, b) => a.localeCompare(b, 'ja', { sensitivity: 'base' }))
    .map(name => ({ name, file: map[name] }));
}

function categoryDefaultWorkspace(options) {
  const map = (currentBoardData && currentBoardData.projectFileMap) || {};
  if (currentFilter && map[currentFilter]) return map[currentFilter];
  return options.length ? options[0].file : '';
}

function categoryChipHtml(category) {
  return categoryLogic.buildCategoryChipHtml(category);
}

// --- モーダル ---
function getOrCreateCategoryModal() {
  if (categoryModalEl) return categoryModalEl;
  categoryModalEl = document.createElement('div');
  categoryModalEl.id = 'category-modal-overlay';
  categoryModalEl.className = 'tag-modal-overlay category-modal-overlay';
  categoryModalEl.innerHTML = `
    <div class="tag-modal-content" role="dialog" aria-modal="true" aria-labelledby="category-modal-title">
      <div class="tag-modal-header">
        <h3 id="category-modal-title"><span class="material-icon icon-stacks"></span> カテゴリ管理</h3>
        <label class="tag-ws-label">ワークスペース
          <select id="category-workspace-select" class="tag-ws-select"></select>
        </label>
        <button type="button" class="tag-modal-close" id="category-modal-close" title="閉じる">&times;</button>
      </div>
      <form class="tag-create-bar" id="category-create-form" autocomplete="off">
        <input type="text" id="category-create-name" class="tag-input" placeholder="新しいカテゴリ名（40文字まで）" maxlength="80" aria-label="新しいカテゴリ名">
        <button type="submit" class="tag-create-btn" id="category-create-btn">＋ 追加</button>
        <div class="tag-color-field">
          <div class="tag-swatches" role="group" aria-label="色見本">${categoryLogic.buildSwatchesHtml('')}</div>
          <label class="tag-custom-color" title="見本にない色を選ぶ">その他の色
            <input type="color" id="category-create-color" class="tag-color-input" value="#4a90d9" aria-label="その他の色">
          </label>
          <label class="tag-nocolor"><input type="checkbox" id="category-create-nocolor" checked> 色なし</label>
        </div>
      </form>
      <div class="tag-note" id="category-create-note" role="status" aria-live="polite" hidden></div>
      <div class="tag-modal-body" id="category-modal-body"><div class="tag-empty">読み込み中...</div></div>
      <div class="tag-modal-footer">
        カテゴリはワークスペースごとに管理し、タスクには1つだけ設定できます。似た名前のカテゴリが増えないよう、追加時に近い名前を確認します。
      </div>
    </div>
  `;
  document.body.appendChild(categoryModalEl);

  categoryModalEl.addEventListener('click', (e) => { if (e.target === categoryModalEl) closeCategoryModal(); });
  categoryModalEl.querySelector('#category-modal-close').addEventListener('click', closeCategoryModal);
  categoryModalEl.querySelector('#category-workspace-select').addEventListener('change', (e) => {
    categoryManagerWorkspace = e.target.value;
    categoryEditingId = null;
    categoryMergingId = null;
    clearCategoryNote();
    loadCategories();
  });
  const form = categoryModalEl.querySelector('#category-create-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); submitCategoryCreate(false); });
  categoryModalEl.querySelector('#category-create-name').addEventListener('input', scheduleCategorySimilarHint);
  // 色の選択(作成フォーム・編集行で共通): 見本クリック/カラーピッカー/「色なし」を .tag-color-field 単位で同期する
  categoryModalEl.addEventListener('click', (e) => {
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
    syncCategorySwatches(field);
  });
  categoryModalEl.addEventListener('input', (e) => {
    if (!e.target.matches('.tag-color-field input[type="color"]')) return;
    const field = e.target.closest('.tag-color-field');
    field.querySelector('.tag-nocolor input').checked = false;
    syncCategorySwatches(field);
  });
  categoryModalEl.addEventListener('change', (e) => {
    if (e.target.matches('.tag-nocolor input')) syncCategorySwatches(e.target.closest('.tag-color-field'));
  });
  categoryModalEl.querySelector('#category-create-note').addEventListener('click', (e) => {
    if (e.target.closest('.tag-note-force')) submitCategoryCreate(true);
    if (e.target.closest('.tag-note-cancel')) clearCategoryNote();
  });
  categoryModalEl.querySelector('#category-modal-body').addEventListener('click', onCategoryBodyClick);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (categoryModalEl.classList.contains('modal-visible') && typeof isTopmostDialog === 'function' && isTopmostDialog(categoryModalEl)) {
      e.preventDefault();
      e.stopPropagation();
      closeCategoryModal();
    }
  }, true);
  return categoryModalEl;
}

/** 選択中の色(「色なし」なら空)に一致する見本だけを押下状態(aria-pressed)にする。tags.jsのsyncTagSwatchesと同じ。 */
function syncCategorySwatches(field) {
  const current = field.querySelector('.tag-nocolor input').checked
    ? '' : field.querySelector('input[type="color"]').value.toLowerCase();
  field.querySelectorAll('.tag-swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === current)));
}

function openCategoryModal(workspaceFile) {
  const modal = getOrCreateCategoryModal();
  const options = categoryWorkspaceOptions();
  const select = modal.querySelector('#category-workspace-select');
  select.innerHTML = options.map(o => `<option value="${escapeHtml(o.file)}">${escapeHtml(o.name)}</option>`).join('');
  categoryManagerWorkspace = options.some(o => o.file === workspaceFile) ? workspaceFile : categoryDefaultWorkspace(options);
  select.value = categoryManagerWorkspace;
  categoryEditingId = null;
  categoryMergingId = null;
  clearCategoryNote();
  modal.querySelector('#category-create-name').value = '';
  modal.querySelector('#category-create-nocolor').checked = true; // 色は毎回「色なし」から選び直す
  syncCategorySwatches(modal.querySelector('#category-create-form .tag-color-field'));
  modal.classList.add('modal-visible');
  loadCategories();
  modal.querySelector('#category-create-name').focus();
}

function closeCategoryModal() {
  if (categoryModalEl) categoryModalEl.classList.remove('modal-visible');
  // カテゴリ選択<select>から「カテゴリ管理を開く」経由で来た場合は、閉じたら選択欄を最新化する(tagのピッカー復帰と同じ考え方)
  const back = categoryPickerReturnCtx;
  categoryPickerReturnCtx = null;
  if (back && typeof back.onReturn === 'function') back.onReturn();
}

async function loadCategories() {
  const body = categoryModalEl.querySelector('#category-modal-body');
  if (!categoryManagerWorkspace) {
    body.innerHTML = '<div class="tag-empty">ワークスペースがありません。</div>';
    return;
  }
  try {
    const res = await categoryFetchJson(`/api/categories?workspace=${encodeURIComponent(categoryManagerWorkspace)}`);
    if (res.status !== 200) throw new Error(res.body.error || `HTTP ${res.status}`);
    categoryManagerCategories = res.body.categories || [];
    renderCategories();
  } catch (e) {
    body.innerHTML = `<div class="tag-empty">カテゴリ一覧を取得できませんでした（${escapeHtml(e.message)}）。サーバーを最新版へ再起動すると使えます。</div>`;
  }
}

function renderCategories() {
  const body = categoryModalEl.querySelector('#category-modal-body');
  if (categoryManagerCategories.length === 0) {
    body.innerHTML = '<div class="tag-empty">このワークスペースにはまだカテゴリがありません。上の入力欄から追加できます。</div>';
    return;
  }
  const rows = categoryManagerCategories.map(category => {
    if (category.id === categoryEditingId) return renderCategoryEditRow(category);
    const merging = category.id === categoryMergingId;
    const row = `<tr data-category-id="${category.id}">
      <td class="tag-col-name">${categoryChipHtml(category)}</td>
      <td class="tag-col-num">${category.usageCount ?? 0} 件</td>
      <td class="tag-col-actions">
        <button type="button" class="tag-action-btn" data-action="edit" title="名前・色を変更">編集</button>
        <button type="button" class="tag-action-btn" data-action="merge" title="別のカテゴリに統合する"${categoryManagerCategories.length < 2 ? ' disabled' : ''}>統合</button>
        <button type="button" class="tag-action-btn tag-danger" data-action="delete" title="カテゴリを削除する">削除</button>
      </td>
    </tr>`;
    return merging ? row + renderCategoryMergeRow(category) : row;
  }).join('');
  body.innerHTML = `<table class="tag-table">
    <thead><tr><th>カテゴリ</th><th class="tag-col-num">使用数</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  if (categoryEditingId) {
    const input = body.querySelector('.tag-edit-name');
    if (input) input.focus();
  }
}

function renderCategoryEditRow(category) {
  return `<tr class="tag-edit-row" data-category-id="${category.id}">
    <td colspan="3">
      <div class="tag-edit-form">
        <input type="text" class="tag-input tag-edit-name" value="${escapeHtml(category.name)}" maxlength="80" aria-label="カテゴリ名">
        <button type="button" class="tag-action-btn tag-primary" data-action="save">保存</button>
        <button type="button" class="tag-action-btn" data-action="cancel-edit">キャンセル</button>
        <div class="tag-color-field">
          <div class="tag-swatches" role="group" aria-label="色見本">${categoryLogic.buildSwatchesHtml(category.color)}</div>
          <label class="tag-custom-color" title="見本にない色を選ぶ">その他の色
            <input type="color" class="tag-color-input tag-edit-color" value="${escapeHtml(category.color || '#4a90d9')}" aria-label="その他の色">
          </label>
          <label class="tag-nocolor"><input type="checkbox" class="tag-edit-nocolor"${category.color ? '' : ' checked'}> 色なし</label>
        </div>
      </div>
      <div class="tag-row-error" role="alert" hidden></div>
    </td>
  </tr>`;
}

function renderCategoryMergeRow(source) {
  const targets = categoryManagerCategories.filter(c => c.id !== source.id);
  return `<tr class="tag-merge-row" data-category-id="${source.id}">
    <td colspan="3">
      <div class="tag-edit-form">
        <span class="tag-merge-label">「${escapeHtml(source.name)}」の統合先:</span>
        <select class="tag-merge-target" aria-label="統合先のカテゴリ">
          ${targets.map(c => `<option value="${c.id}">${escapeHtml(c.name)}（${c.usageCount ?? 0}件）</option>`).join('')}
        </select>
        <button type="button" class="tag-action-btn tag-primary" data-action="do-merge">統合する</button>
        <button type="button" class="tag-action-btn" data-action="cancel-merge">キャンセル</button>
      </div>
      <div class="tag-row-error" role="alert" hidden></div>
    </td>
  </tr>`;
}

function showCategoryRowError(rowEl, message) {
  const el = rowEl && rowEl.querySelector('.tag-row-error');
  if (!el) { alert(message); return; }
  el.textContent = message;
  el.hidden = false;
}

async function onCategoryBodyClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const rowEl = btn.closest('tr');
  const categoryId = Number(rowEl.dataset.categoryId);
  const category = categoryManagerCategories.find(c => c.id === categoryId);
  if (!category) return;
  switch (btn.dataset.action) {
    case 'edit': categoryEditingId = categoryId; categoryMergingId = null; clearCategoryNote(); renderCategories(); break;
    case 'cancel-edit': categoryEditingId = null; renderCategories(); break;
    case 'merge': categoryMergingId = categoryId; categoryEditingId = null; clearCategoryNote(); renderCategories(); break;
    case 'cancel-merge': categoryMergingId = null; renderCategories(); break;
    case 'save': await saveCategoryEdit(category, rowEl); break;
    case 'do-merge': await doCategoryMerge(category, rowEl); break;
    case 'delete': await doCategoryDelete(category); break;
    default: break;
  }
}

async function saveCategoryEdit(category, rowEl) {
  const name = rowEl.querySelector('.tag-edit-name').value;
  const noColor = rowEl.querySelector('.tag-edit-nocolor').checked;
  const color = noColor ? null : rowEl.querySelector('.tag-edit-color').value;
  const clash = categoryLogic.findExactCategory(categoryManagerCategories, name, category.id);
  if (clash) { showCategoryRowError(rowEl, `同じ名前のカテゴリが既にあります: ${clash.name}`); return; }
  const res = await categoryPost('/api/update-category', { categoryId: category.id, name, color });
  if (res.status !== 200) { showCategoryRowError(rowEl, categoryLogic.describeCategoryError(res.body).message); return; }
  categoryEditingId = null;
  await loadCategories();
  refreshBoardAfterCategoryChange();
}

async function doCategoryMerge(source, rowEl) {
  const targetId = Number(rowEl.querySelector('.tag-merge-target').value);
  const target = categoryManagerCategories.find(c => c.id === targetId);
  if (!target) return;
  if (!window.confirm(categoryLogic.buildMergeMessage(source, target))) return;
  const res = await categoryPost('/api/merge-categories', { sourceId: source.id, targetId });
  if (res.status !== 200) { showCategoryRowError(rowEl, categoryLogic.describeCategoryError(res.body).message); return; }
  categoryMergingId = null;
  await loadCategories();
  refreshBoardAfterCategoryChange();
}

async function doCategoryDelete(category) {
  if (!window.confirm(categoryLogic.buildDeleteMessage(category))) return;
  const res = await categoryPost('/api/delete-category', { categoryId: category.id });
  if (res.status !== 200) { alert(`削除できませんでした: ${categoryLogic.describeCategoryError(res.body).message}`); return; }
  await loadCategories();
  refreshBoardAfterCategoryChange();
}

// 改名・統合・削除はタスク側のcategory列が変わるため、開いていればボードを再描画する
// (タグと違いcategory列はboardデータに直接入っているため、再フェッチで反映する)。
function refreshBoardAfterCategoryChange() {
  if (typeof fetchBoard === 'function') fetchBoard();
}

// --- 作成 ---
function setCategoryNote(html, kind) {
  const note = categoryModalEl.querySelector('#category-create-note');
  note.className = `tag-note tag-note-${kind}`;
  note.innerHTML = html;
  note.hidden = false;
}

function clearCategoryNote() {
  if (!categoryModalEl) return;
  const note = categoryModalEl.querySelector('#category-create-note');
  note.hidden = true;
  note.innerHTML = '';
}

/** 入力中に、完全一致/似た名前のカテゴリがあれば先にヒントを出す(確定判定はサーバー)。 */
function scheduleCategorySimilarHint() {
  clearTimeout(categorySimilarTimer);
  const seq = ++categoryHintSeq;
  const name = categoryModalEl.querySelector('#category-create-name').value;
  if (!categoryLogic.cleanCategoryName(name)) { clearCategoryNote(); return; }
  categorySimilarTimer = setTimeout(async () => {
    if (seq !== categoryHintSeq) return;
    const exact = categoryLogic.findExactCategory(categoryManagerCategories, name);
    if (exact) {
      setCategoryNote(`同じ名前のカテゴリが既にあります: ${categoryChipHtml(exact)}`, 'error');
      return;
    }
    try {
      const res = await categoryFetchJson(`/api/categories/similar?workspace=${encodeURIComponent(categoryManagerWorkspace)}&name=${encodeURIComponent(name)}`);
      if (seq !== categoryHintSeq) return;
      const similar = (res.body && res.body.similar) || [];
      if (similar.length > 0) setCategoryNote(`似た名前のカテゴリがあります: ${similar.map(categoryChipHtml).join(' ')}。既存のカテゴリで足りないか確認してね。`, 'warn');
      else clearCategoryNote();
    } catch (e) { /* ヒントなので失敗は無視 */ }
  }, 250);
}

async function submitCategoryCreate(confirmSimilar) {
  clearTimeout(categorySimilarTimer);
  categoryHintSeq += 1; // 送信後に遅れて届くヒントが、確認ボタン付きの警告を消さないようにする
  const nameEl = categoryModalEl.querySelector('#category-create-name');
  const noColor = categoryModalEl.querySelector('#category-create-nocolor').checked;
  const color = noColor ? null : categoryModalEl.querySelector('#category-create-color').value;
  const name = nameEl.value;
  if (!categoryLogic.cleanCategoryName(name)) { setCategoryNote('カテゴリ名を入力してください', 'error'); return; }
  const res = await categoryPost('/api/create-category', { workspace: categoryManagerWorkspace, name, color, confirmSimilar });
  if (res.status === 200) {
    nameEl.value = '';
    clearCategoryNote();
    await loadCategories();
    nameEl.focus();
    if (typeof refreshCategorySelectOptions === 'function') refreshCategorySelectOptions();
    return;
  }
  const info = categoryLogic.describeCategoryError(res.body);
  if (info.kind === 'similar') {
    setCategoryNote(`${info.similar.length ? '似た名前のカテゴリがあります: ' + info.similar.map(categoryChipHtml).join(' ') : info.message}
      <span class="tag-note-actions">
        <button type="button" class="tag-action-btn tag-note-force">それでも作成</button>
        <button type="button" class="tag-action-btn tag-note-cancel">やめる</button>
      </span>`, 'warn');
  } else {
    setCategoryNote(escapeHtml(info.message), 'error');
  }
}

let categoryPickerReturnCtx = null; // カテゴリ管理を閉じた時に選択欄を最新化するためのctx

// ============================================================
// タスク追加/編集フォームのカテゴリ選択(BM-106): <select>を使い、タグのような複数選択ピッカーは持たない
// ============================================================

/** 指定ワークスペースのカテゴリ一覧を取得する(フォームの<select>用)。失敗時は空配列。 */
async function fetchCategoriesForWorkspace(workspaceFile) {
  if (!workspaceFile) return [];
  try {
    const res = await categoryFetchJson(`/api/categories?workspace=${encodeURIComponent(workspaceFile)}`);
    if (res.status !== 200) return [];
    return res.body.categories || [];
  } catch (e) {
    return [];
  }
}

/**
 * <select>にカテゴリ選択肢を詰め直す。先頭は常に「カテゴリなし」。selectedNameが選択肢に
 * 無い場合(ワークスペース変更直後等)でも、値自体は保持する特殊optionを末尾に追加して消えないようにする。
 */
function populateCategorySelect(selectEl, categories, selectedName) {
  const options = ['<option value="">カテゴリなし</option>']
    .concat(categories.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`));
  if (selectedName && !categories.some(c => c.name === selectedName)) {
    options.push(`<option value="${escapeHtml(selectedName)}">${escapeHtml(selectedName)}（不明）</option>`);
  }
  selectEl.innerHTML = options.join('');
  selectEl.value = selectedName || '';
}

/** 追加フォームの#add-task-categoryへワークスペースに応じたカテゴリ一覧を読み込む。 */
async function loadAddFormCategories(form, selectedName) {
  const select = form.querySelector('#add-task-category');
  if (!select) return;
  const projectName = form.querySelector('#add-task-project').value;
  const workspaceFile = tagWorkspaceForProject(projectName);
  const categories = await fetchCategoriesForWorkspace(workspaceFile);
  populateCategorySelect(select, categories, selectedName || '');
}

/** 編集フォームの#edit-task-categoryへワークスペースに応じたカテゴリ一覧を読み込む。 */
async function loadEditFormCategories(form, workspaceFile, selectedName) {
  const select = form.querySelector('#edit-task-category');
  if (!select) return;
  const categories = await fetchCategoriesForWorkspace(workspaceFile);
  populateCategorySelect(select, categories, selectedName || '');
}

// 「カテゴリ管理を開く…」導線: フォームのカテゴリ欄の隣にボタンを置き、開いて戻ったら選択肢を最新化する。
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.category-manage-link');
  if (!btn) return;
  const select = btn.closest('.settings-group').querySelector('select');
  const workspaceFile = btn.dataset.formKind === 'add'
    ? tagWorkspaceForProject(document.getElementById('add-task-project').value)
    : btn.dataset.workspace || '';
  categoryPickerReturnCtx = {
    onReturn: () => {
      if (btn.dataset.formKind === 'add') loadAddFormCategories(getOrCreateAddForm(), select.value);
      else if (select) fetchCategoriesForWorkspace(workspaceFile).then(cs => populateCategorySelect(select, cs, select.value));
    },
  };
  openCategoryModal(workspaceFile);
});

// ============================================================
// カテゴリ絞り込み(BM-106): ヘッダーのボタン+ポップオーバー(ボードのみ対応)
// ============================================================
// 状態(categoryFilter)はapp.jsが持つ。ここでは変更・保存・再描画を行う。判定はcategory-logic.js。
// タグと異なり1タスク1値・and/or切替なしのため、ポップオーバーの構成もタグより簡素にする。

let categoryFilterPopEl = null;
let categoryFilterPopAnchor = null;

function saveCategoryFilter() {
  try { localStorage.setItem('categoryFilter', JSON.stringify(categoryFilter)); } catch (e) { /* 保存できなくても動作は続ける */ }
}

/** 状態の変更後に呼ぶ: 保存し、ボタンと開いているポップオーバーの表示を更新して、ボードを再描画する。 */
function applyCategoryFilter() {
  saveCategoryFilter();
  renderCategoryFilterControls();
  if (currentBoardData) renderBoard(currentBoardData);
}

function toggleCategoryFilterKey(key, checked) {
  const rest = categoryFilter.keys.filter(k => k !== key);
  categoryFilter = { keys: checked ? rest.concat(key) : rest };
  applyCategoryFilter();
}

function clearCategoryFilter() {
  categoryFilter = { keys: [] };
  applyCategoryFilter();
}

function renderCategoryFilterControls() {
  const active = categoryFilter.keys.length > 0;
  document.querySelectorAll('.category-filter-trigger').forEach((btn) => {
    btn.classList.toggle('filter-active', active);
    btn.title = active ? `カテゴリで絞り込み中（${describeCategoryFilterCurrent()}）` : 'カテゴリで絞り込み';
    const count = btn.querySelector('.category-filter-count');
    if (count) {
      count.hidden = !active;
      count.textContent = String(categoryFilter.keys.length);
    }
  });
  if (categoryFilterPopEl) {
    const clearBtn = categoryFilterPopEl.querySelector('.tag-filter-clear-sel');
    if (clearBtn) clearBtn.disabled = categoryFilter.keys.length === 0;
  }
}

function describeCategoryFilterCurrent() {
  // ポップオーバーで取得済みのoptionsが無い場面(初期化直後)もあるため、保存済みのkeyをそのまま出す簡易表示にする
  return categoryFilter.keys.join('、');
}

function closeCategoryFilterPopover() {
  if (categoryFilterPopEl) categoryFilterPopEl.remove();
  categoryFilterPopEl = null;
  categoryFilterPopAnchor = null;
}

function toggleCategoryFilterPopover(anchor) {
  if (categoryFilterPopEl && categoryFilterPopAnchor === anchor) { closeCategoryFilterPopover(); return; }
  openCategoryFilterPopover(anchor);
}

async function openCategoryFilterPopover(anchor) {
  closeCategoryFilterPopover();
  closeTagFilterPopover();
  closeTagPicker();
  categoryFilterPopAnchor = anchor;
  const el = document.createElement('div');
  el.className = 'tag-picker tag-filter-pop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'カテゴリで絞り込み');
  el.innerHTML = `
    <div class="tag-filter-mode" role="group" aria-label="カテゴリの絞り込み">
      <span class="category-filter-hint">選んだカテゴリのいずれかを表示</span>
      <button type="button" class="tag-filter-clear-sel" data-act="clear" title="選択したカテゴリをすべて解除する（絞り込みを外す）">クリア</button>
    </div>
    <input type="search" class="tag-picker-search tag-input" placeholder="カテゴリを絞り込み" aria-label="カテゴリを絞り込み" autocomplete="off">
    <div class="tag-picker-list" role="group" aria-label="カテゴリ一覧"><div class="tag-picker-empty">読み込み中...</div></div>
    <div class="tag-picker-footer tag-filter-footer">
      <button type="button" class="tag-picker-manage" data-act="manage"><span class="material-icon icon-settings"></span>カテゴリ管理を開く…</button>
    </div>`;
  document.body.appendChild(el);
  categoryFilterPopEl = el;
  positionTagPicker(el, anchor);

  const listEl = el.querySelector('.tag-picker-list');
  const searchEl = el.querySelector('.tag-picker-search');
  let options = [];
  const renderList = () => {
    const query = categoryLogic.categoryNameKey(searchEl.value);
    const chosen = new Set(categoryFilter.keys);
    const merged = options.concat(categoryFilter.keys.filter(k => !options.some(o => o.key === k)).map(k => ({ key: k, name: k, color: null, usageCount: 0 })));
    const shown = merged.filter(o => !query || o.key.includes(query));
    if (merged.length === 0) {
      listEl.innerHTML = '<div class="tag-picker-empty">タスクに付いているカテゴリがまだありません。</div>';
    } else if (shown.length === 0) {
      listEl.innerHTML = '<div class="tag-picker-empty">一致するカテゴリがありません。</div>';
    } else {
      listEl.innerHTML = shown.map(o => `<label class="tag-picker-row">
        <input type="checkbox" data-key="${categoryLogic.escapeText(o.key)}"${chosen.has(o.key) ? ' checked' : ''}>${categoryLogic.buildCategoryChipHtml({ name: o.name, color: o.color })}
        <span class="tag-filter-usage">${o.usageCount}件</span></label>`).join('');
    }
    el.querySelector('.tag-filter-clear-sel').disabled = categoryFilter.keys.length === 0;
    positionTagPicker(el, anchor);
  };
  el.querySelector('.tag-filter-clear-sel').disabled = categoryFilter.keys.length === 0;
  searchEl.addEventListener('input', renderList);
  listEl.addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    toggleCategoryFilterKey(box.dataset.key, box.checked);
    if (categoryFilterPopEl === el) renderList();
  });
  el.querySelector('.tag-filter-clear-sel').addEventListener('click', () => {
    clearCategoryFilter();
    if (categoryFilterPopEl === el) renderList();
  });
  el.querySelector('.tag-filter-footer').addEventListener('click', (e) => {
    if (!e.target.closest('[data-act="manage"]')) return;
    closeCategoryFilterPopover();
    openCategoryModal(currentFilter ? tagWorkspaceForProject(currentFilter) : undefined);
  });
  searchEl.focus();

  try {
    const file = currentFilter ? tagWorkspaceForProject(currentFilter) : '';
    const res = await categoryFetchJson(file ? `/api/categories?workspace=${encodeURIComponent(file)}` : '/api/categories');
    if (res.status !== 200) throw new Error(res.body.error || `HTTP ${res.status}`);
    if (categoryFilterPopEl !== el) return; // 取得中に閉じられた
    options = categoryLogic.buildCategoryFilterOptions(res.body.categories || []);
    renderList();
  } catch (e) {
    listEl.innerHTML = `<div class="tag-picker-empty">カテゴリを取得できませんでした（${escapeHtml(e.message)}）</div>`;
  }
}

document.addEventListener('mousedown', (e) => {
  if (!categoryFilterPopEl) return;
  if (categoryFilterPopEl.contains(e.target) || (categoryFilterPopAnchor && categoryFilterPopAnchor.contains(e.target))) return;
  closeCategoryFilterPopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !categoryFilterPopEl) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeCategoryFilterPopover();
}, true);

document.getElementById('category-filter-btn').addEventListener('click', (e) => toggleCategoryFilterPopover(e.currentTarget));
renderCategoryFilterControls();
