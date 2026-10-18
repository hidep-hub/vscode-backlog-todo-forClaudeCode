// 週報(BT-291)。履歴画面の「タイムライン/グラフ/週報」タブの1つとして、履歴ダイアログの中に埋め込む。
// 左: 期間・ワークスペース・ステータス・列・書式(編集可) / 右: Markdownのプレビューと、編集できる生Markdown。
// 集計とMarkdown生成はサーバー(/api/weekly-report-*)側。ここは入力の収集と表示だけを行う。

let weeklyPaneEl = null; // 週報ペインのルート要素(履歴ダイアログ内)
let weeklyMeta = null; // GET /api/weekly-report-template の応答(placeholders, columnDefs, workspaces, defaults)
let weeklyLastMarkdown = '';
let weeklyManualEdit = false; // 生Markdownを手で編集したか(trueの間は設定を変えても自動で再生成しない)
let weeklyPreviewTimer = null;
let weeklyPreviewSeq = 0;
let weeklyMarked = null;

const WEEKLY_STATUSES = [['todo', 'TODO'], ['ready', 'READY'], ['do', 'DO'], ['done', 'DONE']];

// 件名などに含まれるHTML・危険なリンクを無効化するMarkdownレンダラ(同梱のmarkedを使う)
function getWeeklyMarked() {
  if (weeklyMarked) return weeklyMarked;
  if (typeof marked === 'undefined') return null;
  weeklyMarked = new marked.Marked({
    gfm: true,
    breaks: false,
    renderer: {
      html(token) { return escapeHtml(token.text); },
      image(token) { return escapeHtml(token.text || ''); },
      link(token) {
        const inner = this.parser.parseInline(token.tokens);
        return /^https?:\/\//i.test(token.href) ? `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
      },
    },
  });
  return weeklyMarked;
}

function weeklyIsoDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getOrCreateWeeklyPane(container) {
  if (weeklyPaneEl === container) return weeklyPaneEl;
  weeklyPaneEl = container;
  container.innerHTML = `
    <div class="weekly-left" id="weekly-left">
      <section class="weekly-section">
        <h4>期間</h4>
        <div class="weekly-radio-row" id="weekly-range">
          <label><input type="radio" name="weekly-range" value="this" checked> 今週</label>
          <label><input type="radio" name="weekly-range" value="last"> 先週</label>
          <label><input type="radio" name="weekly-range" value="custom"> 任意</label>
        </div>
        <div class="weekly-custom-range" id="weekly-custom-range" hidden>
          ${renderDateFieldHtml('weekly-from', '', { title: '開始日（クリックでカレンダー）' })}
          <span>〜</span>
          ${renderDateFieldHtml('weekly-to', '', { title: '終了日（クリックでカレンダー）' })}
        </div>
        <div class="weekly-hint" id="weekly-range-label"></div>
      </section>
      <section class="weekly-section">
        <h4>対象ワークスペース</h4>
        <div class="weekly-check-list" id="weekly-workspaces"></div>
      </section>
      <section class="weekly-section">
        <h4>出力ステータス</h4>
        <div class="weekly-check-list weekly-inline" id="weekly-statuses"></div>
        <div class="weekly-hint">期日が期間内のタスクと、期日を過ぎた未完了タスクは、ステータスに関わらず出力します。</div>
      </section>
      <section class="weekly-section">
        <h4>表の列</h4>
        <div class="weekly-check-list weekly-inline" id="weekly-columns"></div>
      </section>
      <section class="weekly-section weekly-format-section">
        <h4>出力フォーマット
          <span class="weekly-format-actions">
            <button type="button" class="weekly-small-btn" id="weekly-save-format">保存</button>
            <button type="button" class="weekly-small-btn" id="weekly-reset-format" title="既定の書式に戻して保存済みの書式を消します">既定に戻す</button>
          </span>
        </h4>
        <textarea id="weekly-template" class="weekly-template" spellcheck="false" aria-label="出力フォーマット"></textarea>
        <div class="weekly-hint" id="weekly-format-status"></div>
        <details class="weekly-placeholders">
          <summary>使えるプレースホルダー（クリックで挿入）</summary>
          <table class="weekly-ph-table" id="weekly-ph-table"></table>
        </details>
      </section>
    </div>
    <div class="weekly-resizer" id="weekly-resizer" role="separator" aria-orientation="vertical" tabindex="0" title="ドラッグで左右の幅を調整（ダブルクリックで元に戻す）"></div>
    <div class="weekly-right">
      <div class="weekly-right-bar">
        <div class="weekly-tabs" id="weekly-tabs">
          <button type="button" class="weekly-tab active" data-view="preview">プレビュー</button>
          <button type="button" class="weekly-tab" data-view="source">Markdown（編集可）</button>
        </div>
        <span class="weekly-status" id="weekly-status"></span>
        <button type="button" class="weekly-primary-btn" id="weekly-copy" title="今の内容(手編集を含む)をクリップボードへコピー">コピー</button>
        <button type="button" class="weekly-primary-btn" id="weekly-download" title="今の内容(手編集を含む)を.mdファイルとして保存">mdをダウンロード</button>
      </div>
      <div class="weekly-edit-banner" id="weekly-edit-banner" hidden>
        <span><b>この編集は保存されません</b>（この画面を開いている間だけ有効。他のタブへ移ると消えます）。残すには右上の<b>「コピー」</b>か<b>「mdをダウンロード」</b>を押してください。左の設定を変えても、自動では上書きしません。</span>
        <button type="button" class="weekly-small-btn" id="weekly-regenerate">設定から再生成（編集を破棄）</button>
      </div>
      <div class="weekly-warnings" id="weekly-warnings" hidden></div>
      <div class="weekly-preview" id="weekly-preview"></div>
      <div class="weekly-source-note" id="weekly-source-note" hidden>ここは自由に書き換えられますが、編集内容は保存されません。残したいときは「コピー」か「mdをダウンロード」を使ってください。</div>
      <textarea class="weekly-source" id="weekly-source" spellcheck="false" aria-label="生Markdown(編集できます)" hidden></textarea>
    </div>`;

  initWeeklyResizer(container);

  const $ = sel => container.querySelector(sel);
  // 設定が変わったら少し待ってプレビューを更新する(日付はカレンダーで選ぶと change が飛ぶ)
  const schedule = () => { renderWeeklyRangeLabel(); clearTimeout(weeklyPreviewTimer); weeklyPreviewTimer = setTimeout(refreshWeeklyPreview, 250); };
  $('#weekly-left').addEventListener('input', schedule);
  $('#weekly-left').addEventListener('change', e => {
    if (e.target.name === 'weekly-range') $('#weekly-custom-range').hidden = e.target.value !== 'custom';
    schedule();
  });
  $('#weekly-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.weekly-tab');
    if (btn) showWeeklyView(btn.dataset.view);
  });
  // 生Markdownの手編集: そのままプレビュー・コピー・ダウンロードに反映する
  $('#weekly-source').addEventListener('input', e => {
    weeklyLastMarkdown = e.target.value;
    weeklyManualEdit = true;
    $('#weekly-edit-banner').hidden = false;
    weeklyPaneEl.classList.add('weekly-edited'); // コピー/ダウンロードを目立たせる
    renderWeeklyPreviewHtml(weeklyLastMarkdown);
  });
  $('#weekly-regenerate').addEventListener('click', () => {
    weeklyManualEdit = false;
    weeklyPaneEl.classList.remove('weekly-edited');
    $('#weekly-edit-banner').hidden = true;
    refreshWeeklyPreview();
  });
  $('#weekly-copy').addEventListener('click', copyWeeklyMarkdown);
  $('#weekly-download').addEventListener('click', downloadWeeklyMarkdown);
  $('#weekly-save-format').addEventListener('click', saveWeeklyFormat);
  $('#weekly-reset-format').addEventListener('click', resetWeeklyFormat);
  return weeklyPaneEl;
}

// --- 左右ペインの仕切り(BT-437) ---
// 幅の上下限はCSS(.weekly-leftのmin-width/max-width)が守る。ここは値の更新と保存だけを行う。
const WEEKLY_LEFT_WIDTH_KEY = 'weeklyLeftWidth';
const WEEKLY_LEFT_MIN = 260;
const WEEKLY_RIGHT_MIN = 367; // 右ペイン360px＋仕切り7px。style.cssのmax-width: calc(100% - 367px)と合わせる

function setWeeklyLeftWidth(container, px) {
  if (px === null) container.style.removeProperty('--weekly-left-w');
  else container.style.setProperty('--weekly-left-w', `${Math.round(px)}px`);
}

function initWeeklyResizer(container) {
  try {
    const saved = Number(localStorage.getItem(WEEKLY_LEFT_WIDTH_KEY));
    if (saved >= WEEKLY_LEFT_MIN) setWeeklyLeftWidth(container, saved);
  } catch { /* localStorageが使えなくても幅調整自体は動く */ }

  const handle = container.querySelector('#weekly-resizer');
  const left = container.querySelector('#weekly-left');
  const persist = () => {
    try { localStorage.setItem(WEEKLY_LEFT_WIDTH_KEY, String(Math.round(left.getBoundingClientRect().width))); } catch { /* 保存できなくても続行 */ }
  };
  const clamp = px => Math.max(WEEKLY_LEFT_MIN, Math.min(px, container.getBoundingClientRect().width - WEEKLY_RIGHT_MIN));

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('weekly-resizing'); // ドラッグ中はテキスト選択を止める
  });
  handle.addEventListener('pointermove', e => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    setWeeklyLeftWidth(container, clamp(e.clientX - container.getBoundingClientRect().left));
  });
  const end = e => {
    if (!handle.classList.contains('dragging')) return;
    handle.classList.remove('dragging');
    document.body.classList.remove('weekly-resizing');
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    persist();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    setWeeklyLeftWidth(container, null);
    try { localStorage.removeItem(WEEKLY_LEFT_WIDTH_KEY); } catch { /* 無視 */ }
  });
  // キーボードでも調整できるようにする(左右キー、Shiftで大きく)
  handle.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? 80 : 20) * (e.key === 'ArrowLeft' ? -1 : 1);
    setWeeklyLeftWidth(container, clamp(left.getBoundingClientRect().width + step));
    persist();
  });
}

function showWeeklyView(view) {
  for (const t of weeklyPaneEl.querySelectorAll('.weekly-tab')) t.classList.toggle('active', t.dataset.view === view);
  weeklyPaneEl.querySelector('#weekly-preview').hidden = view !== 'preview';
  weeklyPaneEl.querySelector('#weekly-source').hidden = view !== 'source';
  weeklyPaneEl.querySelector('#weekly-source-note').hidden = view !== 'source';
}

function weeklySelection() {
  const $ = sel => weeklyPaneEl.querySelector(sel);
  const range = weeklyPaneEl.querySelector('input[name="weekly-range"]:checked').value;
  const checked = sel => [...weeklyPaneEl.querySelectorAll(`${sel} input:checked`)].map(i => i.value);
  return {
    range, // 'this' | 'last' | 'custom'
    from: $('#weekly-from').value,
    to: $('#weekly-to').value,
    workspaces: checked('#weekly-workspaces'),
    statuses: checked('#weekly-statuses'),
    columns: checked('#weekly-columns'),
    template: $('#weekly-template').value,
  };
}

// サーバーに渡す期間指定: 今週/先週はrange、任意はfrom/to
function weeklyPeriodParams(sel) {
  return sel.range === 'custom' ? { from: sel.from, to: sel.to } : { range: sel.range };
}

function renderWeeklyRangeLabel() {
  const sel = weeklySelection();
  const el = weeklyPaneEl.querySelector('#weekly-range-label');
  if (sel.range === 'custom') {
    el.textContent = sel.from && sel.to ? '' : '開始日と終了日をカレンダーから選ぶと、自動で反映されます';
    return;
  }
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 月=0
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow - (sel.range === 'last' ? 7 : 0));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  el.textContent = `${weeklyIsoDate(monday)} 〜 ${weeklyIsoDate(sunday)}（月〜日）`;
}

function setWeeklyStatus(text, isError = false) {
  const el = weeklyPaneEl.querySelector('#weekly-status');
  el.textContent = text;
  el.classList.toggle('weekly-error', isError);
}

async function refreshWeeklyPreview() {
  if (weeklyManualEdit) return; // 手編集を守る。再生成ボタンで明示的に戻す
  const sel = weeklySelection();
  const seq = ++weeklyPreviewSeq;
  if (sel.workspaces.length === 0) { renderWeeklyResult({ markdown: '', warnings: ['対象ワークスペースを1つ以上選んでください'] }); setWeeklyStatus(''); return; }
  if (sel.statuses.length === 0) { renderWeeklyResult({ markdown: '', warnings: ['出力ステータスを1つ以上選んでください'] }); setWeeklyStatus(''); return; }
  if (sel.range === 'custom' && (!sel.from || !sel.to)) { renderWeeklyResult({ markdown: '', warnings: ['任意期間は、開始日と終了日の両方を選んでください'] }); setWeeklyStatus(''); return; }
  setWeeklyStatus('生成中...');
  try {
    const res = await fetch('/api/weekly-report-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...weeklyPeriodParams(sel), workspaces: sel.workspaces, statuses: sel.statuses, columns: sel.columns, template: sel.template }),
    });
    const data = await res.json();
    if (seq !== weeklyPreviewSeq || weeklyManualEdit) return; // 古い応答・手編集後の応答は捨てる
    if (!res.ok) {
      renderWeeklyResult({ markdown: '', warnings: [data.message || data.error || '生成に失敗しました'] });
      setWeeklyStatus('エラー', true);
      return;
    }
    renderWeeklyResult(data);
    setWeeklyStatus(`${data.totalCount}件`);
  } catch (e) {
    if (seq !== weeklyPreviewSeq) return;
    setWeeklyStatus(`通信エラー: ${e.message}`, true);
  }
}

function renderWeeklyPreviewHtml(markdown) {
  const m = getWeeklyMarked();
  weeklyPaneEl.querySelector('#weekly-preview').innerHTML = m ? m.parse(markdown) : `<pre>${escapeHtml(markdown)}</pre>`;
}

function renderWeeklyResult({ markdown, warnings = [] }) {
  weeklyLastMarkdown = markdown;
  renderWeeklyPreviewHtml(markdown);
  weeklyPaneEl.querySelector('#weekly-source').value = markdown;
  const warn = weeklyPaneEl.querySelector('#weekly-warnings');
  warn.hidden = warnings.length === 0;
  warn.innerHTML = warnings.map(w => `<div>⚠ ${escapeHtml(w)}</div>`).join('');
}

async function copyWeeklyMarkdown() {
  try {
    await navigator.clipboard.writeText(weeklyLastMarkdown);
    setWeeklyStatus('コピーしました');
  } catch {
    setWeeklyStatus('コピーできませんでした(Markdownタブから手動でコピーしてください)', true);
  }
}

// 画面の内容(手編集を含む)をそのままブラウザ側でファイルとして保存する
function downloadWeeklyMarkdown() {
  const sel = weeklySelection();
  const stamp = sel.range === 'custom' ? `${sel.from}_${sel.to}` : weeklyPaneEl.querySelector('#weekly-range-label').textContent.replace(/（.*$/, '').replace(' 〜 ', '_');
  const blob = new Blob([weeklyLastMarkdown], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `weekly-report-${stamp || 'report'}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function saveWeeklyFormat() {
  const sel = weeklySelection();
  const statusEl = weeklyPaneEl.querySelector('#weekly-format-status');
  try {
    const res = await fetch('/api/weekly-report-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: sel.template, columns: sel.columns }),
    });
    const data = await res.json();
    statusEl.textContent = res.ok ? '書式を保存しました' : (data.message || data.error || '保存に失敗しました');
    statusEl.classList.toggle('weekly-error', !res.ok);
  } catch (e) {
    statusEl.textContent = `保存に失敗しました: ${e.message}`;
    statusEl.classList.add('weekly-error');
  }
}

async function resetWeeklyFormat() {
  const statusEl = weeklyPaneEl.querySelector('#weekly-format-status');
  try {
    const res = await fetch('/api/weekly-report-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    weeklyPaneEl.querySelector('#weekly-template').value = weeklyMeta.defaults.template;
    setWeeklyColumns(weeklyMeta.defaults.columns);
    statusEl.textContent = '既定の書式に戻しました';
    statusEl.classList.remove('weekly-error');
    refreshWeeklyPreview();
  } catch (e) {
    statusEl.textContent = `リセットに失敗しました: ${e.message}`;
    statusEl.classList.add('weekly-error');
  }
}

function setWeeklyColumns(selected) {
  const box = weeklyPaneEl.querySelector('#weekly-columns');
  // 必須列(disabled)もcheckedのままなので :checked で拾える
  box.innerHTML = weeklyMeta.columnDefs.map(c => `
    <label><input type="checkbox" value="${escapeHtml(c.key)}"${selected.includes(c.key) || c.required ? ' checked' : ''}${c.required ? ' disabled' : ''}> ${escapeHtml(c.label)}</label>`).join('');
}

function renderWeeklyPlaceholders() {
  const table = weeklyPaneEl.querySelector('#weekly-ph-table');
  table.innerHTML = `<thead><tr><th>プレースホルダー</th><th>使える場所</th><th>説明</th><th>例</th></tr></thead><tbody>${
    weeklyMeta.placeholders.map(p => {
      const token = p.name.startsWith('#') ? '{{#workspace}}\n\n{{/workspace}}' : `{{${p.name}}}`;
      return `<tr><td><button type="button" class="weekly-ph-btn" data-token="${escapeHtml(token)}">${escapeHtml(p.name.startsWith('#') ? '{{#workspace}} … {{/workspace}}' : `{{${p.name}}}`)}</button></td><td>${escapeHtml(p.scope)}</td><td>${escapeHtml(p.description)}</td><td>${escapeHtml(p.example)}</td></tr>`;
    }).join('')}</tbody>`;
  table.onclick = e => {
    const btn = e.target.closest('.weekly-ph-btn');
    if (!btn) return;
    const ta = weeklyPaneEl.querySelector('#weekly-template');
    const { selectionStart: s, selectionEnd: en } = ta;
    ta.value = ta.value.slice(0, s) + btn.dataset.token + ta.value.slice(en);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + btn.dataset.token.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
}

// 履歴ダイアログの「週報」タブを開いた時に呼ぶ(タブに入るたびに設定を読み直して今週に戻す)
async function showWeeklyPane(container) {
  const pane = getOrCreateWeeklyPane(container);
  const $ = sel => pane.querySelector(sel);
  weeklyManualEdit = false;
  pane.classList.remove('weekly-edited');
  $('#weekly-edit-banner').hidden = true;
  setWeeklyStatus('読み込み中...');
  try {
    weeklyMeta = await (await fetch('/api/weekly-report-template')).json();
  } catch (e) {
    setWeeklyStatus(`読み込みに失敗しました: ${e.message}`, true);
    return;
  }
  // 履歴画面・メイン画面で絞り込み中のワークスペースがあればそれを初期選択、無ければ全ワークスペース
  const preferred = (typeof activityProjectFilter === 'string' && activityProjectFilter) || (typeof currentFilter === 'string' && currentFilter) || '';
  const files = weeklyMeta.workspaces.map(w => w.file);
  const initial = files.includes(preferred) ? [preferred] : files;
  $('#weekly-workspaces').innerHTML = weeklyMeta.workspaces.map(w => `
    <label><input type="checkbox" value="${escapeHtml(w.file)}"${initial.includes(w.file) ? ' checked' : ''}> ${escapeHtml(w.prefix ? `${w.prefix} ` : '')}${escapeHtml(w.name)}</label>`).join('');
  $('#weekly-statuses').innerHTML = WEEKLY_STATUSES.map(([code, label]) => `
    <label><input type="checkbox" value="${code}"${code === 'done' || code === 'do' ? ' checked' : ''}> ${label}</label>`).join('');
  setWeeklyColumns(weeklyMeta.columns);
  $('#weekly-template').value = weeklyMeta.template;
  $('#weekly-format-status').textContent = weeklyMeta.saved ? '保存済みの書式を使っています' : '既定の書式です(編集して「保存」できます)';
  $('#weekly-format-status').classList.remove('weekly-error');
  renderWeeklyPlaceholders();
  pane.querySelector('input[name="weekly-range"][value="this"]').checked = true;
  $('#weekly-custom-range').hidden = true;
  renderWeeklyRangeLabel();
  showWeeklyView('preview');
  refreshWeeklyPreview();
}
