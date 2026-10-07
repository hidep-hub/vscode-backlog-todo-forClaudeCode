'use strict';

// ============================================================
// ガントチャート (BT-268)
// ============================================================
// 週次計画ダイアログの「ガント」表示。開始日(startDate)〜期日(dueDate)を「予定」として、
// 行タイトル型(Jira風)のタイムラインに並べ、ドラッグで日付を動かして計画を見直す。
// DBカラム・APIは増やさず、既存の startDate / dueDate と POST /api/update-task だけで動く。
//
// app.js のグローバルには依存せず、ctx 経由で受け取る(activity.jsと違い単体で読める):
//   ctx.groups        [{ epic: item|null, children: [item...] }]  epic=nullは単発タスクの束
//   ctx.today         'YYYY-MM-DD' (JST)
//   ctx.escapeHtml    (s) => string
//   ctx.holidayName   (ymd) => 祝日名 | null
//   ctx.groupByWorkspace ワークスペースごとの折りたたみ見出しで束ねるか(ALL表示で複数ある時)
//   ctx.onSaveDates   (taskId, patch{startDate?,dueDate?}) => Promise  patchの値は''でクリア
//   ctx.onOpen        (item, parentEpic|null) => void  詳細を開く
//
// 期日欄は app.js 共通のカレンダー(input.date-fieldへのクリック委譲)を使い、changeイベントで保存する。
//
// 仕様の要点:
//  - バー = 開始日〜期日。片方だけなら1日バー。両方無ければ「未計画」行(トラックをクリック/ドラッグで設定)
//  - 完了タスクは移動不可(固定表示)。日付が無い完了タスクは完了日にマーカーだけ出す
//  - 遅延: 期日 < 今日 かつ未完了=赤 / 開始日 < 今日 かつ TODO・READYのまま=橙
//  - EPICは子の期間を集約した読み取り専用バー

(function (root) {
  const LABEL_W_DEFAULT = 300;
  const LABEL_W_MIN = 220;
  const LABEL_W_MAX = 640;
  const ROW_H = 28;
  const HEAD_H = 44;
  const ZOOMS = { day: 28, week: 12 };
  // BM-039: 帯の上に重ねる完了マーカー(緑丸+チェック)のサイズ。CSSの.gantt-done-mark幅と合わせること
  const DONE_MARK_SIZE = 11;
  // BM-050: EPIC帯に乗せる子タスクの期限(○)/完了(●)マーカー。単独行の完了マークより小さくする
  const EPIC_MARK_SIZE = 7;
  const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const DAY_MS = 86400000;
  const DRAG_THRESHOLD = 4;
  const TIP_DELAY = 350;
  const TIP_HIDE_DELAY = 250;

  // ---- 日付ユーティリティ(UTC基準。ローカルTZに依存させない: BT-343の教訓) ----
  const parse = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (ymd, n) => fmt(parse(ymd) + n * DAY_MS);
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / DAY_MS);
  const dow = (ymd) => new Date(parse(ymd)).getUTCDay();
  const mondayOf = (ymd) => addDays(ymd, -((dow(ymd) + 6) % 7));
  const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
  const mdw = (ymd) => `${md(ymd)}(${WEEKDAY_JA[dow(ymd)]})`; // 未計画行のクリック位置確認用(曜日付き)

  function loadZoom() {
    try { const z = localStorage.getItem('ganttZoom'); if (z in ZOOMS) return z; } catch { /* 無視 */ }
    return 'day';
  }
  function loadShowDone() {
    // 完了が大量にあると未完了の計画が埋もれるため、既定は非表示(チェックで表示)
    try { return localStorage.getItem('ganttShowDone') === '1'; } catch { return false; }
  }

  function loadLabelW() {
    try {
      const w = Number(localStorage.getItem('ganttLabelW'));
      if (w >= LABEL_W_MIN && w <= LABEL_W_MAX) return w;
    } catch { /* 無視 */ }
    return LABEL_W_DEFAULT;
  }

  const state = {
    labelW: loadLabelW(),   // タスク列の幅(ヘッダー境界のドラッグで変更。localStorageに保持)
    zoom: loadZoom(),
    showDone: loadShowDone(),
    collapsed: new Set(),   // 折りたたみ中のEPIC id と単発グループ('single:<project>')
    collapsedWs: new Set(), // 折りたたみ中のワークスペース(ALL表示時)
    extraBefore: 0,         // 範囲を過去へ広げた週数
    extraAfter: 0,          // 範囲を未来へ広げた週数
    needsInitialScroll: true,
    scrollTarget: null,     // 'left'|'right': 「4週」で範囲を広げた直後に、増えた側へスクロールする
  };

  let current = null;       // { container, ctx, scrollEl, lookup, range, dw }
  let drag = null;
  let hoverEl = null;       // 未計画行のホバー位置(1日ぶんの枠+曜日付き日付)
  let tipEl = null;
  let tipShowTimer = null;
  let tipHideTimer = null;

  const isDone = (item) => item.statusCode === 'done';

  // 遅延判定。'overdue' | 'late-start' | 'normal'(完了は常にnormal)
  function judge(item, today) {
    if (isDone(item)) return 'normal';
    if (item.dueDate && item.dueDate < today) return 'overdue';
    if (item.startDate && item.startDate < today && (item.statusCode === 'todo' || item.statusCode === 'ready')) return 'late-start';
    return 'normal';
  }

  // バーの表示範囲(日付なしはnull)
  function barSpan(item) {
    const s = item.startDate || null;
    const d = item.dueDate || null;
    if (!s && !d) return null;
    const a = s || d;
    const b = d || s;
    return a <= b ? { start: a, end: b } : { start: b, end: a };
  }

  // dueDateには旧データで'-'(未設定扱い)が混在することがあるため、有効な日付文字列かどうかを見てから比較する
  const isLateDone = (item) => !!(item.completedDate && item.dueDate && item.dueDate !== '-' && item.completedDate > item.dueDate);

  // ドラッグ結果の日付を計算する。返り値 { start, due } (null=未設定)
  function computeDates(item, kind, delta) {
    const s = item.startDate || null;
    const d = item.dueDate || null;
    const span = barSpan(item);
    const start0 = span.start;
    const end0 = span.end;
    if (kind === 'move') {
      return { start: s ? addDays(s, delta) : null, due: d ? addDays(d, delta) : null };
    }
    if (kind === 'resize-l') {
      let ns = addDays(start0, delta);
      if (ns > end0) ns = end0;
      return { start: ns, due: d || (s ? end0 : null) };
    }
    // resize-r
    let ne = addDays(end0, delta);
    if (ne < start0) ne = start0;
    return { start: s || null, due: ne };
  }

  function collectRows(ctx) {
    const rows = [];
    const lookup = new Map();
    const today = ctx.today;
    const stats = { overdue: 0, lateStart: 0, unplanned: 0, oldestOverdue: null };
    const dated = []; // 範囲決定用の非完了日付
    const keys = [];  // 折りたためるグループのキー(「全部折りたたむ」用。ワークスペース折りたたみ中の分も含める)

    // 完了で日付も完了日も無いタスクは置く場所が無いので行ごと出さない
    const visibleChildren = (g) => g.children.filter((c) => !isDone(c) || (state.showDone && (barSpan(c) || c.completedDate)));
    // BT-364: 並びは日付で入れ替えない（日程を編集しても行が動かないよう、カンバンの並びをそのまま使う）

    // show=falseでも統計・範囲・lookupには数える(折りたたんでも「遅延N件」等は変わらないように)
    // BM-033: isLastはEPIC配下で表示中の子のうち最後の1件かどうか(ツリー線を止める位置の判定用)
    const pushItem = (item, parent, show, isLast) => {
      lookup.set(item.id, { item, parent });
      const sp = barSpan(item);
      if (!isDone(item)) {
        if (!sp) stats.unplanned++;
        else { dated.push(sp.start, sp.end); }
        const j = judge(item, today);
        if (j === 'overdue') {
          stats.overdue++;
          if (!stats.oldestOverdue || item.dueDate < stats.oldestOverdue) stats.oldestOverdue = item.dueDate;
        } else if (j === 'late-start') stats.lateStart++;
      }
      if (show) rows.push({ type: 'task', item, parent, isLast });
    };

    // ワークスペースごとに束ねる(ALLで複数ある時だけ見出しを出す)。単発の束はプロジェクトで分割する
    const byProject = new Map();
    const bucket = (p) => { if (!byProject.has(p)) byProject.set(p, []); return byProject.get(p); };
    for (const g of ctx.groups) {
      if (g.epic) { bucket(ctx.groupByWorkspace ? g.epic.project : '').push(g); continue; }
      for (const c of g.children) {
        const list = bucket(ctx.groupByWorkspace ? c.project : '');
        let s = list.find((x) => !x.epic);
        if (!s) { s = { epic: null, children: [] }; list.push(s); }
        s.children.push(c);
      }
    }

    for (const project of [...byProject.keys()].sort()) {
      const groups = byProject.get(project)
        .map((g) => ({ epic: g.epic, children: visibleChildren(g), allChildren: g.children }))
        .filter((g) => g.children.length > 0);
      if (groups.length === 0) continue;
      const epics = groups.filter((g) => g.epic);
      const singles = groups.filter((g) => !g.epic);

      const wsCollapsed = ctx.groupByWorkspace && state.collapsedWs.has(project);
      if (ctx.groupByWorkspace) {
        rows.push({ type: 'ws', project, count: groups.reduce((n, g) => n + g.children.length, 0), collapsed: wsCollapsed });
      }
      const emit = (row) => { if (!wsCollapsed) rows.push(row); };

      for (const g of epics) {
        let min = null, max = null, done = 0;
        // BM-050: 畳んだ状態でも帯だけでマイルストーンが見えるよう、子の期限(due)/完了(doneAt)を集めておく
        const marks = [];
        for (const c of g.allChildren) {
          if (isDone(c)) done++;
          const sp = barSpan(c);
          if (sp) { if (!min || sp.start < min) min = sp.start; if (!max || sp.end > max) max = sp.end; }
          if (c.completedDate) marks.push({ date: c.completedDate, kind: 'done', item: c, late: isLateDone(c) });
          else if (c.dueDate && c.dueDate !== '-') marks.push({ date: c.dueDate, kind: 'due', item: c, late: c.dueDate < today });
        }
        keys.push(g.epic.id);
        emit({ type: 'epic', epic: g.epic, span: min ? { start: min, end: max } : null, done, total: g.allChildren.length, marks });
        const show = !wsCollapsed && !state.collapsed.has(g.epic.id);
        g.children.forEach((c, i) => pushItem(c, g.epic, show, i === g.children.length - 1));
      }
      for (const g of singles) {
        const key = `single:${project}`;
        keys.push(key);
        emit({ type: 'head', key, label: '単発タスク', count: g.children.length, collapsed: state.collapsed.has(key) });
        for (const c of g.children) pushItem(c, null, !wsCollapsed && !state.collapsed.has(key), false);
      }
    }
    return { rows, lookup, stats, dated, keys };
  }

  function computeRange(today, dated) {
    let min = addDays(today, -14);
    let max = addDays(today, 84);
    const lo = addDays(today, -365);
    const hi = addDays(today, 365);
    for (const d of dated) {
      if (d < min && d >= lo) min = d;
      if (d > max && d <= hi) max = d;
    }
    const start = addDays(mondayOf(min), -7 * state.extraBefore);
    const end = addDays(mondayOf(max), 6 + 7 * state.extraAfter);
    return { start, end, days: diffDays(start, end) + 1 };
  }

  // ---- 描画 ----
  function render(container, ctx) {
    hoverEl = null; // 再描画でDOMごと消えるため参照だけ捨てる
    if (drag) return; // ドラッグ中にWS更新で再描画されるとバー要素が差し替わるため、終わるまで待つ
    const esc = ctx.escapeHtml;
    const prev = container.querySelector('.gantt-scroll');
    const prevLeft = prev ? prev.scrollLeft : 0;
    const prevTop = prev ? prev.scrollTop : 0;

    const { rows, lookup, stats, dated, keys } = collectRows(ctx);
    const range = computeRange(ctx.today, dated);
    const dw = ZOOMS[state.zoom];
    const gridW = state.labelW + range.days * dw + 110; // 右端のバーの日付ラベルが見切れない余白
    const idx = (ymd) => diffDays(range.start, ymd);

    const toolbar = `
      <div class="gantt-toolbar">
        <button type="button" class="gantt-btn" data-act="expand-all" title="ワークスペース・EPIC・単発タスクをすべて展開">▾ 全部展開</button>
        <button type="button" class="gantt-btn" data-act="collapse-all" title="EPIC・単発タスクをすべて折りたたむ（ワークスペース見出しは残す）">▸ 全部折りたたむ</button>
        <button type="button" class="gantt-btn" data-act="today" title="今日の位置へ移動">今日</button>
        <button type="button" class="gantt-btn" data-act="more-before" title="過去へ4週ぶん広げる">◀ 4週</button>
        <button type="button" class="gantt-btn" data-act="more-after" title="未来へ4週ぶん広げる">4週 ▶</button>
        <span class="gantt-zoom" role="group" aria-label="表示幅">
          <button type="button" class="gantt-btn${state.zoom === 'day' ? ' is-on' : ''}" data-act="zoom" data-zoom="day">日</button>
          <button type="button" class="gantt-btn${state.zoom === 'week' ? ' is-on' : ''}" data-act="zoom" data-zoom="week">週</button>
        </span>
        <label class="gantt-check"><input type="checkbox" data-act="show-done"${state.showDone ? ' checked' : ''}> 完了を表示</label>
        <span class="gantt-stats">
          ${stats.overdue ? `<button type="button" class="gantt-stat gantt-stat-overdue" data-act="jump-overdue" title="期日を過ぎて未完了のタスク。クリックで一番古いものへ移動">遅延 ${stats.overdue}件</button>` : ''}
          ${stats.lateStart ? `<span class="gantt-stat gantt-stat-late" title="開始日を過ぎたのにTODO/READYのまま">開始遅れ ${stats.lateStart}件</span>` : ''}
          ${stats.unplanned ? `<span class="gantt-stat" title="開始日も期日も未設定。右の空欄をクリック／ドラッグで計画できるよ">未計画 ${stats.unplanned}件</span>` : ''}
        </span>
        <span class="gantt-hint">バーをドラッグで移動／両端で期間変更／未計画の行は空欄をクリック・ドラッグで設定</span>
      </div>`;

    // ヘッダー(月行 + 日行)
    let monthHtml = '';
    let dayHtml = '';
    let monthStart = 0;
    let monthLabel = range.start.slice(0, 7);
    const flushMonth = (endIdx) => {
      const [y, m] = monthLabel.split('-');
      monthHtml += `<div class="gantt-month" style="left:${monthStart * dw}px;width:${(endIdx - monthStart) * dw}px"><span class="gantt-month-label">${y}年${Number(m)}月</span></div>`;
    };
    const bandHtml = [];
    for (let i = 0; i < range.days; i++) {
      const ymd = addDays(range.start, i);
      if (ymd.slice(0, 7) !== monthLabel) { flushMonth(i); monthStart = i; monthLabel = ymd.slice(0, 7); }
      const w = dow(ymd);
      const hol = ctx.holidayName ? ctx.holidayName(ymd) : null;
      const off = w === 0 || w === 6 || !!hol;
      const showNum = state.zoom === 'day' || w === 1;
      const label = state.zoom === 'day'
        ? `<span class="gantt-dnum">${Number(ymd.slice(8))}</span><span class="gantt-dow">${WEEKDAY_JA[w]}</span>`
        : (showNum ? `<span class="gantt-dnum">${Number(ymd.slice(8))}</span>` : '');
      dayHtml += `<div class="gantt-day${off ? ' is-off' : ''}${ymd === ctx.today ? ' is-today' : ''}" style="left:${i * dw}px;width:${dw}px" title="${esc(ymd + (hol ? ' ' + hol : ''))}">${label}</div>`;
      if (off) bandHtml.push(`<i class="gantt-band${hol ? ' is-hol' : ''}" style="left:${i * dw}px;width:${dw}px"></i>`);
    }
    flushMonth(range.days);
    const todayIdx = idx(ctx.today);
    const todayLine = (todayIdx >= 0 && todayIdx < range.days)
      ? `<i class="gantt-today" style="left:${todayIdx * dw + dw / 2}px"></i>` : '';

    // 日付ラベルはバーの外(右)に出す。バー内だと短いバーで見切れるため
    const dateLabel = (a, b, spin = '') => `<span class="gantt-bar-date">${spin}${esc(a === b ? md(a) : `${md(a)}〜${md(b)}`)}</span>`;
    // BM-039: 完了マーカー(丸+チェック)。期日を過ぎて完了した場合は赤(is-late)にして一目で遅延完了とわかるようにする。
    // サイズは帯の上/単独表示どちらも統一(11px)。色はCSSでcurrentColor経由にして.is-lateで切り替える
    const doneMark = (late = false) => `<svg class="gantt-done-mark${late ? ' is-late' : ''}" viewBox="0 0 24 24" aria-hidden="true"><circle class="gantt-done-mark-bg" cx="12" cy="12" r="12"/><path class="gantt-done-mark-check" d="M7 12.5l3 3 7-7.5" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    // BM-050: EPIC帯の上に乗せる完了マーカー。単独行のdoneMarkと同じ丸+チェック柄(見た目を揃える)。
    // サイズだけ小さくするため専用クラスを付け、帯の色(緑/グレー)と同化しないよう背景色で縁取る(CSS側)
    const epicDoneMark = (late = false) => `<svg class="gantt-epic-mark gantt-epic-mark-done${late ? ' is-late' : ''}" viewBox="0 0 24 24" aria-hidden="true"><circle class="gantt-epic-mark-bg" cx="12" cy="12" r="12"/><path class="gantt-epic-mark-check" d="M7 12.5l3 3 7-7.5" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    // BM-050: EPIC帯の上に乗せる小さい○(期限)マーカー。中抜きリング
    const epicDueMark = (late = false) => `<svg class="gantt-epic-mark gantt-epic-mark-due${late ? ' is-late' : ''}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke-width="4"/></svg>`;

    let wsOpen = false;
    const rowParts = [];
    for (const r of rows) {
      if (r.type === 'ws') {
        // ワークスペース見出し。グループ(wrapper)ごとにposition:stickyで、スクロール中も上に残す
        if (wsOpen) rowParts.push('</div>');
        wsOpen = true;
        rowParts.push(`<div class="gantt-ws-group"><div class="gantt-row gantt-row-ws"><div class="gantt-label gantt-label-ws" data-act="toggle-ws" data-ws="${esc(r.project)}"><span class="gantt-toggle">${r.collapsed ? '▸' : '▾'}</span><span class="gantt-title">${esc(r.project || '(未設定)')}</span><span class="gantt-count">${r.count}</span><i class="gantt-resizer" title="ドラッグでタスク列の幅を変更"></i></div><div class="gantt-track" style="width:${range.days * dw}px"></div></div>`);
        continue;
      }
      rowParts.push(buildRow(r));
    }
    if (wsOpen) rowParts.push('</div>');
    const rowHtml = rowParts.join('');

    function buildRow(r) {
      if (r.type === 'head') {
        return `<div class="gantt-row gantt-row-head"><div class="gantt-label gantt-label-head" data-act="toggle-epic" data-epic-id="${esc(r.key)}"><span class="gantt-toggle">${r.collapsed ? '▸' : '▾'}</span>${esc(r.label)}<span class="gantt-count">${r.count}</span><i class="gantt-resizer" title="ドラッグでタスク列の幅を変更"></i></div><div class="gantt-track" style="width:${range.days * dw}px"></div></div>`;
      }
      if (r.type === 'epic') {
        const collapsed = state.collapsed.has(r.epic.id);
        let bar = '';
        // 完了度「(1/2 50%)」。バーは完了ぶんを緑で塗り分け、日付ラベルの後ろに添える
        const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
        const progress = `<span class="gantt-epic-pct">(${r.done}/${r.total} ${pct}%)</span>`;
        if (r.span) {
          const left = idx(r.span.start) * dw;
          const width = (diffDays(r.span.start, r.span.end) + 1) * dw;
          const spanText = r.span.start === r.span.end ? md(r.span.start) : `${md(r.span.start)}〜${md(r.span.end)}`;
          // BM-050: 帯の範囲内に収まる子タスクの期限(○)/完了(●)マーカーを重ねる。範囲外(帯より前後にずれた期限等)は乗せない
          // 重なりは許容(しばらく使ってみて見づらければ調整する)。各マーカーは「ID タイトル 期限:YYYY-MM-DD」の1行をtitleで出す
          const markHtml = (r.marks || []).map((mk) => {
            const mi = idx(mk.date);
            if (mi < idx(r.span.start) || mi > idx(r.span.end)) return '';
            const markLeft = (mi - idx(r.span.start)) * dw + dw / 2;
            const label = `${mk.item.id} ${mk.item.title} 期限:${mk.date}`;
            const svg = mk.kind === 'done' ? epicDoneMark(mk.late) : epicDueMark(mk.late);
            return `<span class="gantt-epic-mark-wrap" style="left:${markLeft}px" title="${esc(label)}">${svg}</span>`;
          }).join('');
          bar = `<div class="gantt-bar gantt-bar-epic" style="left:${left}px;width:${Math.max(width, dw)}px;--pct:${pct}%" title="${esc(spanText + ' 完了 ' + r.done + '/' + r.total)}">${markHtml}<span class="gantt-bar-date">${esc(spanText)} ${progress}</span></div>`;
        } else if (todayIdx >= 0 && todayIdx < range.days) {
          // 子に日付が1つも無いEPICは、バーの代わりに今日の線の右へ完了度だけ出す
          bar = `<span class="gantt-epic-solo" style="left:${todayIdx * dw + dw + 6}px">${progress}</span>`;
        }
        // BT-365: EPICにも [スピナー][ステータス文字]。EPICのstatusCodeは子から導出された値。完了もDONEと文字で出す
        const eRunning = r.epic.running || r.epic.statusCode === 'do'
          ? `<span class="gantt-running${r.epic.running ? '' : ' is-idle'}" title="${r.epic.running ? '実行中' : '進行中'}"></span>` : '<span class="gantt-running-slot"></span>';
        const epicState = `<span class="gantt-state">${eRunning}<span class="gantt-status-text st-${esc(r.epic.statusCode)}" title="${esc(r.epic.status || r.epic.statusCode)}">${esc(String(r.epic.statusCode).toUpperCase())}</span></span>`;
        return `<div class="gantt-row gantt-row-epic${r.epic.statusCode === 'done' ? ' is-done' : ''}" data-epic-id="${esc(r.epic.id)}"><div class="gantt-label gantt-label-epic" data-act="toggle-epic" data-epic-id="${esc(r.epic.id)}" data-task-id="${esc(r.epic.id)}"><span class="gantt-toggle">${collapsed ? '▸' : '▾'}</span>${epicState}<span class="gantt-id">${esc(r.epic.id)}</span><span class="gantt-title">${esc(r.epic.title)}</span><span class="gantt-count">${r.done}/${r.total}</span><i class="gantt-resizer" title="ドラッグでタスク列の幅を変更"></i></div><div class="gantt-track" style="width:${range.days * dw}px">${bar}</div></div>`;
      }
      const item = r.item;
      const done = isDone(item);
      const span = barSpan(item);
      const j = judge(item, ctx.today);
      // 進行中(DO)はスピナーをステータス文字の左に出す。実行中フラグONなら回転、そうでなければ止まった薄い表示
      const running = (!done && (item.running || item.statusCode === 'do'))
        ? `<span class="gantt-running${item.running ? '' : ' is-idle'}" title="${item.running ? '実行中' : '進行中'}"></span>` : '';
      const pin = item.todayFlag ? '<span class="gantt-pin" title="今日やる">📌</span>' : '';
      // 期日欄: 共通カレンダー(app.jsのinput.date-field委譲)で設定する。完了タスクは移動不可なので表示のみ
      const dueCell = done
        ? `<span class="gantt-due-text">${esc(item.dueDate || '')}</span>`
        : `<input type="text" class="date-field gantt-due-input${j === 'overdue' ? ' is-overdue' : ''}" readonly autocomplete="off" placeholder="期日" data-task-id="${esc(item.id)}" value="${esc(item.dueDate || '')}" title="期日（クリックでカレンダー）">`;
      // BT-365: 行頭に [スピナー][ステータス文字]。DONEもグレーの文字で出す(緑ドットは廃止)
      const stateCell = `<span class="gantt-state">${running || '<span class="gantt-running-slot"></span>'}<span class="gantt-status-text st-${esc(item.statusCode)}" title="${esc(item.status || item.statusCode)}">${esc(String(item.statusCode).toUpperCase())}</span></span>`;
      // BM-033: 子タスクはis-childでツリー線用の背景・インデントを付与。is-lastは縦線を自分の行で止める印
      const childCls = r.parent ? ` is-child${r.isLast ? ' is-last' : ''}` : '';
      const label = `<div class="gantt-label gantt-label-task${childCls}" data-act="open" data-task-id="${esc(item.id)}">${stateCell}<span class="gantt-id">${esc(item.id)}</span><span class="gantt-title">${esc(item.title)}</span>${pin}<i class="gantt-resizer gantt-resizer-due" title="ドラッグでタスク列の幅を変更（タイトルを広げる）"></i>${dueCell}<i class="gantt-resizer" title="ドラッグでタスク列の幅を変更"></i></div>`;

      let trackInner = '';
      let trackClass = 'gantt-track';
      if (span) {
        const i0 = idx(span.start);
        const i1 = idx(span.end);
        if (i1 < 0 || i0 >= range.days) {
          if (!done) trackInner = `<span class="gantt-offrange" style="${i1 < 0 ? 'left:4px' : 'right:4px'}">${i1 < 0 ? '◀ ' : ''}${esc(md(span.start))}${i1 < 0 ? '' : ' ▶'}</span>`;
        } else {
          const left = i0 * dw;
          const width = (i1 - i0 + 1) * dw;
          const cls = `gantt-bar st-${item.statusCode} j-${j}${done ? ' is-done' : ''}`;
          const handles = done ? '' : '<span class="gantt-handle gantt-handle-l" data-handle="resize-l"></span><span class="gantt-handle gantt-handle-r" data-handle="resize-r"></span>';
          const clear = done ? '' : '<button type="button" class="gantt-bar-clear" data-act="clear" title="日付をクリア（未計画に戻す）">×</button>';
          // BM-039: 完了タスクは帯の幅・位置をそのまま残し(色はCSSでグレーに)、completedDateの位置に小さい完了マーク(緑丸+チェック)を重ねる。
          // 期日より後、または開始日より前に完了させた場合は帯の外側にマークを出し「計画からズレて完了させた」のがわかるようにする
          let doneMarkHtml = '';
          if (done && item.completedDate) {
            const late = isLateDone(item);
            const lateTitle = late ? '（期日超過で完了）' : '';
            const ci = idx(item.completedDate);
            if (ci >= i0 && ci <= i1) {
              doneMarkHtml = `<span class="gantt-done-mark-wrap" style="left:${(ci - i0) * dw + dw / 2}px" title="完了日 ${esc(item.completedDate)}${lateTitle}">${doneMark(late)}</span>`;
            } else if (ci >= 0 && ci < range.days) {
              const outsideLeft = ci < i0 ? -(DONE_MARK_SIZE / 2 + 2) : width + DONE_MARK_SIZE / 2 + 2;
              doneMarkHtml = `<span class="gantt-done-mark-wrap gantt-done-mark-wrap-outside" style="left:${outsideLeft}px" title="完了日 ${esc(item.completedDate)}（計画の範囲外）${lateTitle}">${doneMark(late)}</span>`;
            }
          }
          trackInner = `<div class="${cls}" data-task-id="${esc(item.id)}" style="left:${left}px;width:${width}px">${handles}${clear}${doneMarkHtml}${dateLabel(span.start, span.end, running)}</div>`;
        }
      } else if (done) {
        const c = item.completedDate;
        const ci = c ? idx(c) : -1;
        if (c && ci >= 0 && ci < range.days) {
          const late = isLateDone(item);
          trackInner = `<div class="gantt-marker" data-task-id="${esc(item.id)}" style="left:${ci * dw + dw / 2}px" title="完了日 ${esc(c)}${late ? '（期日超過で完了）' : ''}">${doneMark(late)}${dateLabel(c, c)}</div>`;
        }
      } else {
        trackClass += ' is-empty';
      }
      return `<div class="gantt-row gantt-row-task${done ? ' is-done' : ''}" data-task-id="${esc(item.id)}">${label}<div class="${trackClass}" data-task-id="${esc(item.id)}" style="width:${range.days * dw}px">${trackInner}</div></div>`;
    }

    // BM-046: フッターのステータス別件数サマリ。ALL表示時は全体合算、ワークスペースセレクタで絞った時は
    // そのワークスペース1件分の内訳(ctx.footerCountsはapp.js側でcurrentFilterを反映済み)。
    // 検索・ピン絞り込みが効いている時は「母数(絞り込み前)/絞り込み後の件数(太字)」の形で両方出し、
    // DONEバッジの右に「全体の何件から何件に絞り込んだか」のメッセージも添える
    const STATUS_LABEL = { do: 'DO', ready: 'READY', todo: 'TODO', done: 'DONE' };
    const footer = (() => {
      const fc = ctx.footerCounts;
      if (!fc) return '';
      const parts = Object.keys(STATUS_LABEL).map((code) => {
        const total = fc.total[code] || 0;
        const shown = fc.shown ? (fc.shown[code] || 0) : null;
        const num = shown === null ? `${total}` : `<strong>${shown}</strong>/${total}`;
        return `<span class="gantt-stat gantt-stat-${code}" title="${esc(STATUS_LABEL[code])} ${shown === null ? total : `${shown}/${total}`}件">${esc(STATUS_LABEL[code])} ${num}</span>`;
      });
      let msg = '';
      if (fc.shown) {
        const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
        const totalAll = sum(fc.total);
        const shownAll = sum(fc.shown);
        const label = fc.filterLabel ? `${esc(fc.filterLabel)}で` : '';
        msg = `<span class="gantt-footer-msg">${label}全${totalAll}件から${shownAll}件に絞り込み中</span>`;
      }
      return `<div class="gantt-footer">${parts.join('')}${msg}</div>`;
    })();

    container.innerHTML = `
      ${toolbar}
      <div class="gantt-scroll">
        <div class="gantt-grid" style="width:${gridW}px;--gantt-label-w:${state.labelW}px;--gantt-row-h:${ROW_H}px;--gantt-head-h:${HEAD_H}px;--gantt-dw:${dw}px">
          <div class="gantt-head">
            <div class="gantt-corner"><span>タスク</span><span class="gantt-corner-due">期日</span><i class="gantt-resizer gantt-resizer-due" title="ドラッグでタスク列の幅を変更（タイトルを広げる）"></i><i class="gantt-resizer" title="ドラッグでタスク列の幅を変更"></i></div>
            <div class="gantt-head-days"><div class="gantt-months" style="width:${range.days * dw}px">${monthHtml}</div><div class="gantt-days" style="width:${range.days * dw}px">${dayHtml}</div></div>
          </div>
          <div class="gantt-bands" style="width:${range.days * dw}px">${bandHtml.join('')}${todayLine}</div>
          ${rowHtml || '<div class="gantt-empty">表示できるタスクがないよ</div>'}
        </div>
      </div>
      ${footer}`;

    const scrollEl = container.querySelector('.gantt-scroll');
    current = { container, ctx, scrollEl, lookup, range, dw, stats, keys };
    bind(container, scrollEl);

    if (state.scrollTarget) {
      scrollEl.scrollLeft = state.scrollTarget === 'left' ? 0 : scrollEl.scrollWidth;
      scrollEl.scrollTop = prevTop;
      state.scrollTarget = null;
    } else if (state.needsInitialScroll) {
      state.needsInitialScroll = false;
      scrollToDate(ctx.today);
    } else {
      scrollEl.scrollLeft = prevLeft;
      scrollEl.scrollTop = prevTop;
    }
  }

  function scrollToDate(ymd) {
    if (!current) return;
    const i = diffDays(current.range.start, ymd);
    current.scrollEl.scrollLeft = Math.max(0, i * current.dw - 80);
  }

  // ---- イベント ----
  function bind(container, scrollEl) {
    container.onclick = onClick;
    container.onchange = onChange;
    scrollEl.onpointerdown = onPointerDown;
    scrollEl.onpointermove = onTrackHover;
    scrollEl.onpointerleave = clearHover;
    scrollEl.onmouseover = onMouseOver;
    scrollEl.onmouseout = onMouseOut;
  }

  function rerender() { if (current) render(current.container, current.ctx); }

  function onChange(e) {
    const t = e.target;
    if (t.matches && t.matches('.gantt-due-input')) {
      const info = current && current.lookup.get(t.dataset.taskId);
      if (!info) return;
      const due = t.value || '';
      const patch = { dueDate: due };
      // 期日を開始日より前にした場合は、バーが逆転しないよう開始日も期日に合わせる
      if (due && info.item.startDate && due < info.item.startDate) patch.startDate = due;
      if ((info.item.dueDate || '') === due && patch.startDate === undefined) return;
      save(t.dataset.taskId, patch);
      return;
    }
    if (t.matches && t.matches('[data-act="show-done"]')) {
      state.showDone = t.checked;
      try { localStorage.setItem('ganttShowDone', t.checked ? '1' : '0'); } catch { /* 無視 */ }
      rerender();
    }
  }

  function onClick(e) {
    if (!current) return;
    if (e.target.closest('.gantt-resizer')) return; // 幅変更のつかみ。行の詳細・折りたたみは動かさない
    // 期日欄のクリックはカレンダーを開くだけ(行の詳細は開かない)
    if (e.target.closest('.gantt-due-input, .gantt-due-text')) { hideTip(); return; }
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;
    if (act === 'today') { scrollToDate(current.ctx.today); return; }
    // 範囲を広げたら、増えた側へスクロールして「増えた領域」がすぐ見えるようにする
    if (act === 'more-before') { state.extraBefore += 4; state.scrollTarget = 'left'; rerender(); return; }
    if (act === 'more-after') { state.extraAfter += 4; state.scrollTarget = 'right'; rerender(); return; }
    if (act === 'expand-all') { state.collapsed.clear(); state.collapsedWs.clear(); rerender(); return; }
    if (act === 'collapse-all') { current.keys.forEach((k) => state.collapsed.add(k)); rerender(); return; }
    if (act === 'zoom') {
      state.zoom = actEl.dataset.zoom;
      try { localStorage.setItem('ganttZoom', state.zoom); } catch { /* 無視 */ }
      state.needsInitialScroll = true;
      rerender();
      return;
    }
    if (act === 'jump-overdue') { if (current.stats.oldestOverdue) scrollToDate(current.stats.oldestOverdue); return; }
    if (act === 'toggle-ws') {
      const ws = actEl.dataset.ws;
      if (state.collapsedWs.has(ws)) state.collapsedWs.delete(ws); else state.collapsedWs.add(ws);
      rerender();
      return;
    }
    if (act === 'toggle-epic') {
      const id = actEl.dataset.epicId;
      if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
      rerender();
      return;
    }
    if (act === 'clear') {
      e.stopPropagation();
      const id = actEl.closest('[data-task-id]').dataset.taskId;
      save(id, { startDate: '', dueDate: '' });
      return;
    }
    if (act === 'open') {
      const info = current.lookup.get(actEl.dataset.taskId);
      if (info) current.ctx.onOpen(info.item, info.parent);
    }
  }

  async function save(taskId, patch) {
    if (!current || Object.keys(patch).length === 0) return;
    hideTip();
    try {
      await current.ctx.onSaveDates(taskId, patch);
    } catch (err) {
      console.error('[gantt] save failed:', err);
    }
    rerender();
  }

  // ---- ドラッグ(バーの移動/リサイズ、未計画行の範囲設定) ----
  function dayDeltaOf(e) {
    const dx = (e.clientX + drag.scroll.scrollLeft) - (drag.x0 + drag.scroll0);
    return Math.round(dx / current.dw);
  }

  function onPointerDown(e) {
    if (!current || e.button !== 0) return;
    if (e.target.closest('.gantt-resizer')) { beginResize(e); return; }
    if (e.target.closest('.gantt-bar-clear')) return;
    const bar = e.target.closest('.gantt-bar[data-task-id]');
    const track = e.target.closest('.gantt-track.is-empty');
    if (bar) {
      const info = current.lookup.get(bar.dataset.taskId);
      if (!info) return;
      const handle = e.target.closest('.gantt-handle');
      const kind = isDone(info.item) ? 'click' : (handle ? handle.dataset.handle : 'move');
      beginDrag(e, { kind, item: info.item, parent: info.parent, bar });
    } else if (track) {
      const info = current.lookup.get(track.dataset.taskId);
      if (!info) return;
      const rect = track.getBoundingClientRect();
      const anchor = Math.max(0, Math.min(current.range.days - 1, Math.floor((e.clientX - rect.left) / current.dw)));
      beginDrag(e, { kind: 'create', item: info.item, parent: info.parent, track, anchor });
    }
  }

  // 未計画行: カーソル位置の日を枠+「10/16(金)」で示す。どの日をクリックするか確実に分かるように
  function clearHover() {
    if (hoverEl) hoverEl.remove();
    hoverEl = null;
  }

  function onTrackHover(e) {
    if (!current || drag) return;
    const track = e.target.closest && e.target.closest('.gantt-track.is-empty');
    if (!track) { clearHover(); return; }
    const rect = track.getBoundingClientRect();
    const i = Math.max(0, Math.min(current.range.days - 1, Math.floor((e.clientX - rect.left) / current.dw)));
    if (!hoverEl) {
      hoverEl = document.createElement('div');
      hoverEl.className = 'gantt-hover-day';
    }
    if (hoverEl.parentNode !== track) track.appendChild(hoverEl);
    hoverEl.style.left = `${i * current.dw}px`;
    hoverEl.style.width = `${current.dw}px`;
    const label = mdw(addDays(current.range.start, i));
    if (hoverEl.dataset.label !== label) {
      hoverEl.dataset.label = label;
      hoverEl.innerHTML = `<span class="gantt-bar-date">${label}</span>`;
    }
  }

  // タスク列の幅変更。ヘッダー境界をドラッグ → CSS変数を直接更新して追従させる(再描画しない)
  function beginResize(e) {
    e.preventDefault();
    hideTip();
    const grid = current.scrollEl.querySelector('.gantt-grid');
    const x0 = e.clientX;
    const w0 = state.labelW;
    const trackW = current.range.days * current.dw;
    const move = (ev) => {
      const w = Math.max(LABEL_W_MIN, Math.min(LABEL_W_MAX, w0 + ev.clientX - x0));
      state.labelW = w;
      grid.style.setProperty('--gantt-label-w', `${w}px`);
      grid.style.width = `${w + trackW + 110}px`;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.classList.remove('gantt-resizing');
      try { localStorage.setItem('ganttLabelW', String(state.labelW)); } catch { /* 無視 */ }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.body.classList.add('gantt-resizing');
  }

  function beginDrag(e, base) {
    e.preventDefault();
    hideTip();
    clearHover();
    if (base.kind === 'create') document.body.classList.add('gantt-creating');
    drag = { ...base, x0: e.clientX, scroll: current.scrollEl, scroll0: current.scrollEl.scrollLeft, moved: false, delta: 0, result: null, ghost: null };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', cancelDrag);
    document.body.classList.add('gantt-dragging');
  }

  function autoScroll(e) {
    const rect = drag.scroll.getBoundingClientRect();
    const edge = 48;
    if (e.clientX > rect.right - edge) drag.scroll.scrollLeft += 18;
    else if (e.clientX < rect.left + state.labelW + edge) drag.scroll.scrollLeft -= 18;
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) >= DRAG_THRESHOLD) drag.moved = true;
    if (!drag.moved) return;
    autoScroll(e);
    const dw = current.dw;
    if (drag.kind === 'create') {
      const rect = drag.track.getBoundingClientRect();
      const cur = Math.max(0, Math.min(current.range.days - 1, Math.floor((e.clientX - rect.left) / dw)));
      const i0 = Math.min(drag.anchor, cur);
      const i1 = Math.max(drag.anchor, cur);
      if (!drag.ghost) {
        drag.ghost = document.createElement('div');
        drag.ghost.className = 'gantt-bar gantt-ghost';
        drag.track.appendChild(drag.ghost);
      }
      drag.ghost.style.left = `${i0 * dw}px`;
      drag.ghost.style.width = `${(i1 - i0 + 1) * dw}px`;
      const s = addDays(current.range.start, i0);
      const d = addDays(current.range.start, i1);
      drag.ghost.innerHTML = `<span class="gantt-bar-date">${i0 === i1 ? mdw(d) : `${mdw(s)}〜${mdw(d)}`}</span>`;
      drag.result = { i0, i1 };
      return;
    }
    if (drag.kind === 'click') return;
    drag.delta = dayDeltaOf(e);
    const res = computeDates(drag.item, drag.kind, drag.delta);
    drag.result = res;
    const a = res.start || res.due;
    const b = res.due || res.start;
    const lo = a <= b ? a : b;
    const hi = a <= b ? b : a;
    drag.bar.style.left = `${diffDays(current.range.start, lo) * dw}px`;
    drag.bar.style.width = `${(diffDays(lo, hi) + 1) * dw}px`;
    const text = drag.bar.querySelector('.gantt-bar-date');
    if (text) text.textContent = lo === hi ? md(lo) : `${md(lo)}〜${md(hi)}`;
    drag.bar.classList.add('is-dragging');
  }

  function endDrag() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', cancelDrag);
    document.body.classList.remove('gantt-dragging', 'gantt-creating');
  }

  function cancelDrag() {
    if (!drag) return;
    endDrag();
    drag = null;
    rerender();
  }

  function onPointerUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    endDrag();
    if (d.kind === 'click' || (!d.moved && d.kind !== 'create')) {
      current.ctx.onOpen(d.item, d.parent);
      return;
    }
    if (d.kind === 'create') {
      // クリックのみ(動かしていない)は期日だけ設定する。週次計画の「ドロップ=期日設定」と同じ扱い
      const i0 = d.moved && d.result ? d.result.i0 : d.anchor;
      const i1 = d.moved && d.result ? d.result.i1 : d.anchor;
      const s = addDays(current.range.start, i0);
      const due = addDays(current.range.start, i1);
      save(d.item.id, i0 === i1 ? { dueDate: due } : { startDate: s, dueDate: due });
      return;
    }
    if (!d.moved || !d.result) { rerender(); return; }
    const patch = {};
    if ((d.result.start || null) !== (d.item.startDate || null)) patch.startDate = d.result.start || '';
    if ((d.result.due || null) !== (d.item.dueDate || null)) patch.dueDate = d.result.due || '';
    if (Object.keys(patch).length === 0) { rerender(); return; }
    save(d.item.id, patch);
  }

  // ---- ホバーのチップヘルプ(説明欄。スクロール可) ----
  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'gantt-tip';
    tipEl.addEventListener('mouseenter', () => clearTimeout(tipHideTimer));
    tipEl.addEventListener('mouseleave', scheduleHideTip);
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function hideTip() {
    clearTimeout(tipShowTimer);
    clearTimeout(tipHideTimer);
    if (tipEl) tipEl.classList.remove('gantt-tip-visible');
  }

  function scheduleHideTip() {
    clearTimeout(tipShowTimer);
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(() => { if (tipEl) tipEl.classList.remove('gantt-tip-visible'); }, TIP_HIDE_DELAY);
  }

  function tipHtml(item, ctx) {
    const esc = ctx.escapeHtml;
    const j = judge(item, ctx.today);
    const warn = j === 'overdue' ? '<div class="gantt-tip-warn">期日を過ぎているよ。いつやるか計画を見直そう</div>'
      : (j === 'late-start' ? '<div class="gantt-tip-warn is-late">開始予定を過ぎたのに未着手だよ。日付を見直すか着手しよう</div>' : '');
    const meta = [
      `<span>状態: ${esc(item.status || item.statusCode)}</span>`,
      `<span>開始: ${item.startDate ? esc(item.startDate) : '未設定'}</span>`,
      `<span>期日: ${item.dueDate ? esc(item.dueDate) : '未設定'}</span>`,
    ];
    if (item.completedDate) meta.push(`<span>完了: ${esc(item.completedDate)}</span>`);
    if (item.assignee) meta.push(`<span>担当: ${esc(item.assignee)}</span>`);
    return `<div class="gantt-tip-head"><span class="gantt-tip-id">${esc(item.id)}</span><span class="gantt-tip-title">${esc(item.title || '')}</span></div>${warn}<div class="gantt-tip-meta">${meta.join('')}</div><div class="gantt-tip-desc">${item.description ? esc(item.description) : '<span class="gantt-tip-none">説明はありません</span>'}</div>`;
  }

  function onMouseOver(e) {
    if (!current || drag) return;
    if (e.target.closest('.gantt-bar-epic')) return;
    const el = e.target.closest('[data-task-id].gantt-bar, [data-task-id].gantt-label-task, [data-task-id].gantt-marker');
    if (!el) return;
    const info = current.lookup.get(el.dataset.taskId);
    if (!info) return;
    clearTimeout(tipHideTimer);
    clearTimeout(tipShowTimer);
    const x = e.clientX;
    const y = e.clientY;
    tipShowTimer = setTimeout(() => {
      if (!current || drag) return;
      const tip = ensureTip();
      tip.innerHTML = tipHtml(info.item, current.ctx);
      tip.style.left = '0px';
      tip.style.top = '0px';
      tip.classList.add('gantt-tip-visible');
      const margin = 10;
      const left = Math.min(x + 6, window.innerWidth - tip.offsetWidth - margin);
      let top = y + 14;
      if (top + tip.offsetHeight > window.innerHeight - margin) top = Math.max(margin, y - tip.offsetHeight - 10);
      tip.style.left = `${Math.max(margin, left)}px`;
      tip.style.top = `${top}px`;
    }, TIP_DELAY);
  }

  function onMouseOut(e) {
    if (!e.target.closest('[data-task-id]')) return;
    scheduleHideTip();
  }

  root.ganttView = {
    render,
    hideTip,
    // ダイアログを開き直した時に今日の位置から見せる
    resetScroll() { state.needsInitialScroll = true; },
  };
})(globalThis);
