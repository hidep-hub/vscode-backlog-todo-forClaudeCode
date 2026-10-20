'use strict';

// 共通の確認/通知ダイアログ(BM-114)。
// VS Code Simple Browser(webview)はサンドボックスの制約でwindow.confirm/window.alertを
// 無視する(ダイアログが出ずに静かに無視される)。タグ・カテゴリ管理画面の削除・統合ボタンは
// これらに依存していたため、Simple Browser上ではクリックしても何も起きないように見えていた。
// このモジュールは window.confirm/window.alert と同じ使い方感覚で使える自作モーダルを提供し、
// 既存の.modal-overlay系モーダル(delete-confirm等)と同じ見た目・Escape/背景クリックでの
// 閉じ方に揃える。
//   await showConfirm('本当に削除しますか？')  // OK=true, キャンセル/Esc/背景クリック=false
//   await showAlert('削除できませんでした')    // OK/Esc/背景クリックのいずれかまで待つ

let uiDialogEl = null;
let uiDialogFinish = null; // 表示中ダイアログのPromiseを解決する関数。重ねて開かれた時に前回分もfalseで解決するため保持

function getOrCreateUiDialog() {
  if (uiDialogEl) return uiDialogEl;
  const el = document.createElement('div');
  el.id = 'ui-dialog-overlay';
  el.className = 'modal-overlay modal-front ui-dialog-overlay';
  el.innerHTML = `
    <div class="modal-content ui-dialog-modal" role="alertdialog" aria-modal="true" aria-labelledby="ui-dialog-text">
      <p class="delete-confirm-text" id="ui-dialog-text"></p>
      <div class="edit-form-actions">
        <button type="button" class="add-task-submit" id="ui-dialog-ok">OK</button>
        <button type="button" class="add-child-btn" id="ui-dialog-cancel">キャンセル</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closeUiDialog(false); });
  closeOnEscape(el, 'modal-visible', () => closeUiDialog(false));
  uiDialogEl = el;
  return el;
}

function closeUiDialog(result) {
  if (!uiDialogEl) return;
  uiDialogEl.classList.remove('modal-visible');
  const finish = uiDialogFinish;
  uiDialogFinish = null;
  if (finish) finish(result);
}

function openUiDialog(message, { showCancel }) {
  const el = getOrCreateUiDialog();
  document.body.appendChild(el); // 他の.modal-overlayと同じく、最前面に出すためDOM末尾へ移動する
  const content = el.querySelector('.modal-content');
  content.querySelector('#ui-dialog-text').textContent = message;
  const okBtn = content.querySelector('#ui-dialog-ok');
  const cancelBtn = content.querySelector('#ui-dialog-cancel');
  cancelBtn.style.display = showCancel ? '' : 'none';

  // 前のダイアログが解決されずに重ねて開かれた場合に備え、先にfalseで解決してから入れ替える
  if (uiDialogFinish) { const prev = uiDialogFinish; uiDialogFinish = null; prev(false); }

  return new Promise((resolve) => {
    uiDialogFinish = resolve;
    okBtn.onclick = () => closeUiDialog(true);
    cancelBtn.onclick = () => closeUiDialog(false);
    el.classList.add('modal-visible');
    okBtn.focus();
  });
}

/**
 * window.confirm相当。OKで true、キャンセル/Esc/背景クリックで false を返す。
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function showConfirm(message) {
  return openUiDialog(message, { showCancel: true });
}

/**
 * window.alert相当。OKボタン/Esc/背景クリックのいずれかで閉じるまで待つ(戻り値は常にfalseだが、
 * alert呼び出し元は戻り値を見ないため実質「閉じるまで待てる」ことだけが意味を持つ)。
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function showAlert(message) {
  return openUiDialog(message, { showCancel: false });
}
