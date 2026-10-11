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
  const bg = tag.color || '';
  const fg = tagLogic.readableTextColor(bg);
  const style = bg ? ` style="background:${escapeHtml(bg)};color:${fg};border-color:${escapeHtml(bg)}"` : '';
  return `<span class="tag-chip${bg ? '' : ' tag-chip-plain'}"${style}>${escapeHtml(tag.name)}</span>`;
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
        <input type="color" id="tag-create-color" class="tag-color-input" value="#4a90d9" title="色" aria-label="色">
        <label class="tag-nocolor"><input type="checkbox" id="tag-create-nocolor" checked> 色なし</label>
        <button type="submit" class="tag-create-btn" id="tag-create-btn">＋ 追加</button>
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
  tagModalEl.querySelector('#tag-create-color').addEventListener('input', () => {
    tagModalEl.querySelector('#tag-create-nocolor').checked = false;
  });
  tagModalEl.querySelector('#tag-create-note').addEventListener('click', (e) => {
    if (e.target.closest('.tag-note-force')) submitTagCreate(true);
    if (e.target.closest('.tag-note-cancel')) clearTagNote();
  });
  tagModalEl.querySelector('#tag-modal-body').addEventListener('click', onTagBodyClick);
  tagModalEl.querySelector('#tag-modal-body').addEventListener('input', (e) => {
    if (e.target.classList.contains('tag-edit-color')) {
      tagModalEl.querySelector('.tag-edit-nocolor').checked = false;
    }
  });
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

function openTagModal() {
  const modal = getOrCreateTagModal();
  const options = tagWorkspaceOptions();
  const select = modal.querySelector('#tag-workspace-select');
  select.innerHTML = options.map(o => `<option value="${escapeHtml(o.file)}">${escapeHtml(o.name)}</option>`).join('');
  tagManagerWorkspace = tagDefaultWorkspace(options);
  select.value = tagManagerWorkspace;
  tagEditingId = null;
  tagMergingId = null;
  clearTagNote();
  modal.querySelector('#tag-create-name').value = '';
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
        <input type="color" class="tag-color-input tag-edit-color" value="${escapeHtml(tag.color || '#4a90d9')}" aria-label="色">
        <label class="tag-nocolor"><input type="checkbox" class="tag-edit-nocolor"${tag.color ? '' : ' checked'}> 色なし</label>
        <button type="button" class="tag-action-btn tag-primary" data-action="save">保存</button>
        <button type="button" class="tag-action-btn" data-action="cancel-edit">キャンセル</button>
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

document.getElementById('tag-btn').addEventListener('click', openTagModal);
