// タスクコメント(BM-136)の画面配線。純粋ロジックはcomment-logic.js、コメント欄を描画する側はapp.js
// (詳細モーダル・右クリックTIP)。ここでは取得・投稿・削除と、入力中の文字を守る仕組みを持つ。
//
// 入力中の文字を守る(WebSocketの再描画で入力が消える問題への対策。BM-076/BM-089と同じ考え方):
//  - 一覧だけを差し替える(.comment-list-wrap)。入力欄(.comment-input)は投稿・取得では触らない
//  - 入力欄に文字がある間は、詳細モーダルの再描画をスキップする(app.jsのrefreshModalIfOpen)
//  - 右クリックTIPは、入力欄に文字がある間は外側クリック・背後のスクロールで閉じない(tryCloseTaskQuickTip)
//  - 詳細モーダルは、入力欄に文字がある間は背景クリックで閉じない(closeOnBackdropClick)

// タスクID -> コメント配列(新しい順)。投稿・削除の直後に更新し、WS再描画後も一覧を即座に出せるようにする
const commentCache = new Map();
const commentFetching = new Set();

function commentSectionsFor(taskId, root = document) {
  return [...root.querySelectorAll('.comment-section')].filter(el => el.dataset.taskId === taskId);
}

// 表示に使うコメントと、再取得が要るかを返す。詳細取得(/api/task/:id)のitem.commentsはキャッシュにも反映する
function resolveItemComments(item) {
  const resolved = commentLogic.resolveComments(item, commentCache.get(item.id));
  if (Array.isArray(item.comments) && resolved.comments === item.comments) commentCache.set(item.id, item.comments);
  return resolved;
}

// app.jsから呼ぶ: 詳細モーダル・TIPに入れるコメント欄のHTML(variantは 'modal' / 'tip')
function buildTaskCommentSectionHtml(item, variant) {
  if (!item || !item.id || item.id === '-') return '';
  const { comments } = resolveItemComments(item);
  return commentLogic.buildCommentSectionHtml({ taskId: item.id, comments, count: item.commentCount, variant });
}

// app.jsから呼ぶ: コメント欄を描画した直後に呼び、キャッシュが無い・古い時だけ取得する
function hydrateCommentSections(root, item) {
  if (!root || !item || !item.id) return;
  if (commentSectionsFor(item.id, root).length === 0) return;
  if (resolveItemComments(item).needsFetch) loadTaskComments(item.id);
}

function renderCommentSections(taskId, { failed = false } = {}) {
  const comments = commentCache.has(taskId) ? commentCache.get(taskId) : null;
  for (const section of commentSectionsFor(taskId)) {
    const wrap = section.querySelector('.comment-list-wrap');
    if (wrap) {
      wrap.innerHTML = failed && comments === null
        ? '<div class="comment-empty">コメントを読み込めなかったよ</div>'
        : commentLogic.buildCommentListInnerHtml(comments);
    }
    const countEl = section.querySelector('.comment-count');
    if (countEl && Array.isArray(comments)) countEl.textContent = comments.length > 0 ? String(comments.length) : '';
    // 右クリックTIPは一覧の高さが変わると画面からはみ出すことがあるため、置き直す
    const tip = section.closest('.task-quick-tip');
    if (tip && tip.classList.contains('task-quick-tip-visible')) positionTaskQuickTip(tip);
  }
}

async function loadTaskComments(taskId) {
  if (commentFetching.has(taskId)) return;
  commentFetching.add(taskId);
  try {
    const res = await fetch(`/api/task-comments?taskId=${encodeURIComponent(taskId)}`);
    if (!res.ok) { renderCommentSections(taskId, { failed: true }); return; }
    const data = await res.json();
    commentCache.set(taskId, data.comments || []);
    renderCommentSections(taskId);
  } catch (e) {
    console.error('[comments] Failed to load comments:', e);
    renderCommentSections(taskId, { failed: true });
  } finally {
    commentFetching.delete(taskId);
  }
}

// --- 入力中の文字を守るための部品 ---
function hasCommentDraft(root) {
  if (!root) return false;
  return [...root.querySelectorAll('.comment-input')].some(el => commentLogic.hasDraftText(el.value));
}

// 再描画の前に入力欄の状態を控え、描画後に戻す(文字がある時は再描画自体をスキップするので、主にフォーカスの復元用)
function captureCommentDraft(root) {
  const el = root && root.querySelector('.comment-input');
  if (!el) return null;
  const section = el.closest('.comment-section');
  return {
    taskId: section ? section.dataset.taskId : null,
    value: el.value,
    focused: document.activeElement === el,
    start: el.selectionStart,
    end: el.selectionEnd,
  };
}

function restoreCommentDraft(root, draft) {
  if (!root || !draft) return;
  const el = root.querySelector('.comment-input');
  const section = el && el.closest('.comment-section');
  if (!el || !section || section.dataset.taskId !== draft.taskId) return;
  el.value = draft.value;
  updateCommentSubmitState(section);
  if (draft.focused) {
    el.focus();
    try { el.setSelectionRange(draft.start, draft.end); } catch (e) { /* 非対応環境では無視 */ }
  }
}

function focusCommentInput(root) {
  const el = root && root.querySelector('.comment-input');
  if (el) el.focus();
}

function updateCommentSubmitState(section) {
  const input = section.querySelector('.comment-input');
  const btn = section.querySelector('.comment-submit-btn');
  if (input && btn && !btn.dataset.busy) btn.disabled = !commentLogic.hasDraftText(input.value);
}

function setCommentError(section, message) {
  const errorEl = section.querySelector('.comment-error');
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
}

// --- 投稿 ---
async function submitTaskComment(section) {
  const input = section.querySelector('.comment-input');
  const btn = section.querySelector('.comment-submit-btn');
  if (!input || !btn || btn.disabled || !commentLogic.hasDraftText(input.value)) return;
  const taskId = section.dataset.taskId;
  const body = input.value;
  btn.dataset.busy = '1'; // 連打による多重送信を防ぐ(BM-054と同じ考え方)
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '投稿中...';
  setCommentError(section, '');
  try {
    const res = await fetch('/api/add-task-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCommentError(section, data.message || data.error || `投稿できなかったよ (${res.status})`);
      return;
    }
    // 件数が噛み合う時だけ手元のキャッシュに足す。噛み合わなければ捨てて取り直す(他の人の投稿が挟まった場合など)
    const cached = commentCache.get(taskId);
    if (Array.isArray(cached) && cached.length === data.commentCount - 1) {
      commentCache.set(taskId, [data.comment, ...cached]);
    } else {
      commentCache.delete(taskId);
    }
    input.value = '';
    renderCommentSections(taskId);
    if (!commentCache.has(taskId)) loadTaskComments(taskId);
  } catch (e) {
    console.error('[comments] Failed to post comment:', e);
    setCommentError(section, 'ネットワークエラーが発生したよ');
  } finally {
    delete btn.dataset.busy;
    btn.textContent = label;
    updateCommentSubmitState(section);
  }
}

// --- 削除(誤入力の取り消し) ---
// ダイアログを出すとTIPの「外側クリックで閉じる」に当たるため、同じボタンをもう一度押す2段階にする。
const COMMENT_DELETE_CONFIRM_MS = 3000;

async function deleteTaskComment(btn) {
  const section = btn.closest('.comment-section');
  if (!section) return;
  if (!btn.classList.contains('confirming')) {
    btn.classList.add('confirming');
    btn.dataset.originalHtml = btn.innerHTML;
    btn.textContent = 'もう一度押すと削除';
    setTimeout(() => {
      if (btn.isConnected && btn.classList.contains('confirming')) {
        btn.classList.remove('confirming');
        btn.innerHTML = btn.dataset.originalHtml;
      }
    }, COMMENT_DELETE_CONFIRM_MS);
    return;
  }
  const taskId = section.dataset.taskId;
  const commentId = Number(btn.dataset.commentId);
  btn.disabled = true;
  try {
    const res = await fetch('/api/delete-task-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCommentError(section, data.message || data.error || `削除できなかったよ (${res.status})`);
      btn.disabled = false;
      btn.classList.remove('confirming');
      btn.innerHTML = btn.dataset.originalHtml || btn.innerHTML;
      return;
    }
    const cached = commentCache.get(taskId);
    if (Array.isArray(cached)) commentCache.set(taskId, cached.filter(c => c.id !== commentId));
    renderCommentSections(taskId);
  } catch (e) {
    console.error('[comments] Failed to delete comment:', e);
    setCommentError(section, 'ネットワークエラーが発生したよ');
    btn.disabled = false;
  }
}

// --- イベント委譲(描画のたびに付け直さなくてよい) ---
document.addEventListener('input', (e) => {
  const input = e.target.closest && e.target.closest('.comment-input');
  if (!input) return;
  const section = input.closest('.comment-section');
  if (!section) return;
  setCommentError(section, '');
  updateCommentSubmitState(section);
});

document.addEventListener('click', (e) => {
  const submitBtn = e.target.closest('.comment-submit-btn');
  if (submitBtn) {
    e.preventDefault();
    submitTaskComment(submitBtn.closest('.comment-section'));
    return;
  }
  const deleteBtn = e.target.closest('.comment-delete-btn');
  if (deleteBtn) {
    e.preventDefault();
    e.stopPropagation();
    deleteTaskComment(deleteBtn);
  }
});

// Ctrl+Enter / Cmd+Enterで投稿する。日本語入力の変換確定のEnterでは投稿しない。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
  const input = e.target.closest && e.target.closest('.comment-input');
  if (!input) return;
  e.preventDefault();
  submitTaskComment(input.closest('.comment-section'));
});
