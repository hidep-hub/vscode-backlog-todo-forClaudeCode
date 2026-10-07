'use strict';

// バックアップ画面(BT-373、設計: BT-370)。
// ヘッダーのバックアップボタンから一覧モーダルを開き、新規作成・削除を行う。
// 実行中は全操作をブロックする進捗オーバーレイを出し、GET /api/backup-status をポーリングする。
// リロード後も実行中ならブロック表示へ復帰する。

const BACKUP_PHASE_LABELS = {
  db: 'データベースをコピー中…',
  files: '環境ファイルをコピー中…',
  verify: '整合性を検証中…',
  rotate: '古い世代を整理中…',
  done: '完了しました',
};
const BACKUP_POLL_MS = 300;
const BACKUP_MIN_VISIBLE_MS = 600;

let backupModalEl = null;
let backupProgressEl = null;
let backupRunning = false;
let backupPollTimer = null;

function backupFormatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** createdAt(ISO、ローカル時刻)が無いときはフォルダ名から日時を組み立てる。 */
function backupFormatDate(item) {
  if (item.createdAt) return item.createdAt.replace('T', ' ').slice(0, 19);
  const m = /^backlog-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(item.file);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : item.file;
}

async function backupFetchJson(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* 本文なし */ }
  return { status: res.status, body: body || {} };
}

// --- 進捗オーバーレイ(全操作ブロック) ---
function getOrCreateBackupProgress() {
  if (backupProgressEl) return backupProgressEl;
  backupProgressEl = document.createElement('div');
  backupProgressEl.id = 'backup-progress-overlay';
  backupProgressEl.className = 'backup-progress-overlay';
  backupProgressEl.setAttribute('role', 'alertdialog');
  backupProgressEl.setAttribute('aria-modal', 'true');
  backupProgressEl.setAttribute('aria-labelledby', 'backup-progress-title');
  backupProgressEl.innerHTML = `
    <div class="backup-progress-box">
      <h3 id="backup-progress-title"><span class="material-icon icon-backup"></span> バックアップ</h3>
      <p class="backup-progress-phase" id="backup-progress-phase">準備中…</p>
      <div class="backup-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="backup-progress-track">
        <div class="backup-progress-bar" id="backup-progress-bar"></div>
      </div>
      <p class="backup-progress-percent" id="backup-progress-percent">0%</p>
      <p class="backup-progress-note" id="backup-progress-note">バックアップ中のため、操作できません。</p>
      <div class="backup-progress-result" id="backup-progress-result" hidden></div>
      <div class="backup-progress-actions"><button type="button" class="backup-close-btn" id="backup-progress-close" hidden>閉じる</button></div>
    </div>
  `;
  document.body.appendChild(backupProgressEl);
  backupProgressEl.querySelector('#backup-progress-close').addEventListener('click', hideBackupProgress);
  return backupProgressEl;
}

function showBackupProgress() {
  const el = getOrCreateBackupProgress();
  el.querySelector('#backup-progress-result').hidden = true;
  el.querySelector('#backup-progress-result').textContent = '';
  el.querySelector('#backup-progress-close').hidden = true;
  el.querySelector('#backup-progress-note').hidden = false;
  el.classList.remove('backup-failed');
  updateBackupProgress({ percent: 0, phase: 'db' });
  el.classList.add('backup-progress-visible');
}

function hideBackupProgress() {
  if (backupProgressEl) backupProgressEl.classList.remove('backup-progress-visible');
}

function updateBackupProgress(status) {
  const el = getOrCreateBackupProgress();
  const percent = Math.max(0, Math.min(100, Number(status.percent) || 0));
  el.querySelector('#backup-progress-bar').style.width = `${percent}%`;
  el.querySelector('#backup-progress-track').setAttribute('aria-valuenow', String(percent));
  el.querySelector('#backup-progress-percent').textContent = `${percent}%`;
  el.querySelector('#backup-progress-phase').textContent = BACKUP_PHASE_LABELS[status.phase] || '実行中…';
}

function finishBackupProgress(result) {
  const el = getOrCreateBackupProgress();
  const resultEl = el.querySelector('#backup-progress-result');
  el.querySelector('#backup-progress-note').hidden = true;
  if (result && result.ok) {
    updateBackupProgress({ percent: 100, phase: 'done' });
    const counts = result.counts || {};
    resultEl.textContent = `完了: ${result.file}（${backupFormatBytes(result.sizeBytes)} / タスク ${counts.tasks} 件・履歴 ${counts.taskEvents} 件・環境ファイル ${result.files} 件 / ${result.durationMs}ms）`;
  } else {
    el.classList.add('backup-failed');
    el.querySelector('#backup-progress-phase').textContent = 'バックアップに失敗しました';
    resultEl.textContent = `原因: ${(result && result.error) || '不明'}（backup.log を確認してください）`;
  }
  resultEl.hidden = false;
  el.querySelector('#backup-progress-close').hidden = false;
  el.querySelector('#backup-progress-close').focus();
}

// --- ポーリング ---
function stopBackupPolling() {
  if (backupPollTimer) { clearInterval(backupPollTimer); backupPollTimer = null; }
}

function startBackupPolling() {
  stopBackupPolling();
  backupPollTimer = setInterval(async () => {
    try {
      const { body } = await backupFetchJson('/api/backup-status');
      if (body.running) updateBackupProgress(body);
    } catch (e) { /* 一時的な通信失敗は次回に任せる */ }
  }, BACKUP_POLL_MS);
}

// --- バックアップ実行 ---
async function runBackup() {
  if (backupRunning) return;
  backupRunning = true;
  const startedAt = Date.now();
  showBackupProgress();
  startBackupPolling();
  let result;
  try {
    const res = await backupFetchJson('/api/backup', { method: 'POST' });
    result = res.status === 200 ? res.body : { ok: false, error: res.body.error || `HTTP ${res.status}` };
  } catch (e) {
    result = { ok: false, error: e.message || '通信エラー' };
  }
  stopBackupPolling();
  // 一瞬で終わっても進捗が見えるよう、最低限の表示時間を確保する
  const wait = BACKUP_MIN_VISIBLE_MS - (Date.now() - startedAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  finishBackupProgress(result);
  backupRunning = false;
  if (backupModalEl && backupModalEl.classList.contains('modal-visible')) loadBackups();
}

/** 別タブ・リロード直後など、すでに実行中のバックアップがあればブロック表示へ復帰する。 */
async function resumeBackupIfRunning() {
  try {
    const { body } = await backupFetchJson('/api/backup-status');
    if (!body.running || backupRunning) return;
    backupRunning = true;
    showBackupProgress();
    updateBackupProgress(body);
    startBackupPolling();
    const timer = setInterval(async () => {
      const { body: s } = await backupFetchJson('/api/backup-status');
      if (s.running) return;
      clearInterval(timer);
      stopBackupPolling();
      backupRunning = false;
      hideBackupProgress();
      if (backupModalEl && backupModalEl.classList.contains('modal-visible')) loadBackups();
    }, BACKUP_POLL_MS);
  } catch (e) { /* 旧バージョンのサーバー等ではAPIが無いので何もしない */ }
}

// --- 一覧モーダル ---
function getOrCreateBackupModal() {
  if (backupModalEl) return backupModalEl;
  backupModalEl = document.createElement('div');
  backupModalEl.id = 'backup-modal-overlay';
  backupModalEl.className = 'backup-modal-overlay';
  backupModalEl.innerHTML = `
    <div class="backup-modal-content">
      <div class="backup-modal-header">
        <h3><span class="material-icon icon-backup"></span> バックアップ</h3>
        <button type="button" class="backup-create-btn" id="backup-create-btn" title="DBと環境ファイルのバックアップを今すぐ作成する">＋ 新規バックアップ</button>
        <span class="backup-dir-label" id="backup-dir-label"></span>
        <button type="button" class="backup-modal-close" id="backup-modal-close" title="閉じる">&times;</button>
      </div>
      <div class="backup-modal-body" id="backup-modal-body"><div class="backup-empty">読み込み中...</div></div>
      <div class="backup-modal-footer">
        バックアップには github-credentials.json（PAT）を含みます。フォルダを外部へコピーする際はご注意ください。
        日次7世代＋週次4世代を残し、それより古いものは作成時に自動で整理されます。
      </div>
    </div>
  `;
  document.body.appendChild(backupModalEl);

  backupModalEl.addEventListener('click', (e) => {
    if (e.target === backupModalEl) closeBackupModal();
  });
  backupModalEl.querySelector('#backup-modal-close').addEventListener('click', closeBackupModal);
  backupModalEl.querySelector('#backup-create-btn').addEventListener('click', runBackup);
  backupModalEl.querySelector('#backup-modal-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.backup-delete-btn');
    if (btn && !btn.disabled) deleteBackup(btn.dataset.file);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 実行中はEscapeも無効(進捗オーバーレイが表示されている間は何も閉じさせない)
    if (backupProgressEl && backupProgressEl.classList.contains('backup-progress-visible')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (backupModalEl.classList.contains('modal-visible') && typeof isTopmostDialog === 'function' && isTopmostDialog(backupModalEl)) {
      closeBackupModal();
    }
  }, true);
  return backupModalEl;
}

function openBackupModal() {
  const modal = getOrCreateBackupModal();
  modal.classList.add('modal-visible');
  loadBackups();
}

function closeBackupModal() {
  if (backupModalEl) backupModalEl.classList.remove('modal-visible');
}

async function loadBackups() {
  const body = backupModalEl.querySelector('#backup-modal-body');
  try {
    const res = await backupFetchJson('/api/backups');
    if (res.status !== 200) throw new Error(res.body.error || `HTTP ${res.status}`);
    backupModalEl.querySelector('#backup-dir-label').textContent = `保存先: ${res.body.backupsDir}`;
    renderBackups(res.body.backups || []);
  } catch (e) {
    body.innerHTML = `<div class="backup-empty">一覧を取得できませんでした（${escapeHtml(e.message)}）。サーバーを最新版へ再起動すると使えます。</div>`;
  }
}

function renderBackups(items) {
  const body = backupModalEl.querySelector('#backup-modal-body');
  if (items.length === 0) {
    body.innerHTML = '<div class="backup-empty">まだバックアップがありません。「＋ 新規バックアップ」で作成できます。</div>';
    return;
  }
  const rows = items.map((item, index) => {
    const counts = item.counts || {};
    const isLatest = index === 0;
    const integrity = item.integrity === 'ok' ? '<span class="backup-ok">OK</span>'
      : item.integrity ? `<span class="backup-ng">${escapeHtml(item.integrity)}</span>` : '<span class="backup-ng">不明</span>';
    const skipped = item.skipped && item.skipped.length
      ? ` title="未取得: ${escapeHtml(item.skipped.join(', '))}"` : '';
    return `<tr>
      <td class="backup-col-date">${escapeHtml(backupFormatDate(item))}${isLatest ? ' <span class="backup-latest">最新</span>' : ''}</td>
      <td class="backup-col-num">${backupFormatBytes(item.sizeBytes)}</td>
      <td class="backup-col-num">${counts.tasks ?? '-'}</td>
      <td class="backup-col-num">${counts.taskEvents ?? '-'}</td>
      <td class="backup-col-num"${skipped}>${item.files ?? '-'}${item.skipped && item.skipped.length ? ' *' : ''}</td>
      <td class="backup-col-center">${integrity}</td>
      <td class="backup-col-center"><button type="button" class="backup-delete-btn" data-file="${escapeHtml(item.file)}"
        ${isLatest ? 'disabled title="最新のバックアップは削除できません"' : 'title="このバックアップを削除する"'}>削除</button></td>
    </tr>`;
  }).join('');
  body.innerHTML = `<table class="backup-table">
    <thead><tr><th>日時</th><th class="backup-col-num">サイズ</th><th class="backup-col-num">タスク</th><th class="backup-col-num">履歴</th><th class="backup-col-num">環境ファイル</th><th class="backup-col-center">検証</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

async function deleteBackup(file) {
  if (!window.confirm(`バックアップ「${file}」を削除します。元に戻せません。よろしいですか？`)) return;
  const res = await backupFetchJson('/api/delete-backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
  if (!res.body.ok) {
    alert(`削除できませんでした: ${res.body.error || res.status}`);
  }
  loadBackups();
}

document.getElementById('backup-btn').addEventListener('click', openBackupModal);
resumeBackupIfRunning();
