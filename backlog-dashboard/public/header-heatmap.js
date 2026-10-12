(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.headerHeatmap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // BT-382: ヘッダのミニヒートマップ用の純粋ロジック。
  // メインスレッドを塞がないよう、重い処理(/api/activityの全件→日別件数への集計)は
  // header-heatmap-worker.jsからこのファイルをimportScriptsして行う。
  // メインスレッド側は、集計済みの日別件数からセル配置を作るだけ(最大約370セルで軽量)。
  // DOM非依存なのでnode --testで単体テストできる(header-ticker.jsと同じ構成)。

  const pad = n => String(n).padStart(2, '0');

  function formatYmd(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseYmd(s) {
    return new Date(`${s}T00:00:00`);
  }

  /**
   * 生イベント配列(GET /api/activity)を「ローカル日付→件数」のオブジェクトに集計する。
   * occurredAtはUTCのISO文字列なので、ローカルタイムのゲッター経由で日付化する(履歴画面と同じ基準)。
   * @param {Array<{occurredAt:string}>} events
   * @returns {Object<string, number>}
   */
  function buildDailyCounts(events) {
    const counts = {};
    if (!Array.isArray(events)) return counts;
    for (const ev of events) {
      if (!ev || !ev.occurredAt) continue;
      const d = new Date(ev.occurredAt);
      if (Number.isNaN(d.getTime())) continue;
      const key = formatYmd(d);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  /**
   * 生イベント配列を「プロジェクト名→(ローカル日付→件数)」に集計する(ワークスペースセレクタ連動用)。
   * projectが無いイベントは空文字キーに入る。
   * @param {Array<{occurredAt:string, project?:string}>} events
   * @returns {Object<string, Object<string, number>>}
   */
  function buildDailyCountsByProject(events) {
    const byProject = {};
    if (!Array.isArray(events)) return byProject;
    for (const ev of events) {
      if (!ev || !ev.occurredAt) continue;
      const d = new Date(ev.occurredAt);
      if (Number.isNaN(d.getTime())) continue;
      const proj = ev.project || '';
      const key = formatYmd(d);
      const counts = byProject[proj] || (byProject[proj] = {});
      counts[key] = (counts[key] || 0) + 1;
    }
    return byProject;
  }

  /**
   * プロジェクト別集計から表示対象の日別件数を取り出す。projectが空なら全プロジェクト合算。
   * @param {Object<string, Object<string, number>>} byProject
   * @param {string} project
   */
  function selectCounts(byProject, project) {
    if (!byProject) return {};
    if (project) return byProject[project] || {};
    const total = {};
    for (const counts of Object.values(byProject)) {
      for (const [date, n] of Object.entries(counts)) total[date] = (total[date] || 0) + n;
    }
    return total;
  }

  /** 件数→濃淡レベル(0〜4)。0件は0、それ以外は最大件数に対する比率で1〜4。 */
  function levelFor(count, maxCount) {
    if (!count) return 0;
    return Math.min(4, Math.ceil((count / Math.max(1, maxCount)) * 4));
  }

  /**
   * 今日を含む週を右端とする直近weeks週ぶんのセル配置を作る(週は月曜始まり、row=0が月曜)。
   * 今日より未来のセルは含めない。濃淡の基準(最大件数)は表示範囲内の最大値。
   * @param {Object<string, number>} counts
   * @param {number} weeks
   * @param {Date} [today]
   * @returns {{cols:number, cells:Array<{col:number,row:number,date:string,count:number,level:number}>}}
   */
  function buildHeatmapGrid(counts, weeks, today) {
    const now = today || new Date();
    const todayStr = formatYmd(now);
    const dow = (now.getDay() + 6) % 7; // 月曜=0
    const thisWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
    const cells = [];
    let maxCount = 0;
    for (let col = 0; col < weeks; col++) {
      for (let row = 0; row < 7; row++) {
        const d = new Date(thisWeek.getFullYear(), thisWeek.getMonth(), thisWeek.getDate() - (weeks - 1 - col) * 7 + row);
        const date = formatYmd(d);
        if (date > todayStr) continue;
        const count = (counts && counts[date]) || 0;
        if (count > maxCount) maxCount = count;
        cells.push({ col, row, date, count, level: 0 });
      }
    }
    for (const c of cells) c.level = levelFor(c.count, maxCount);
    return { cols: weeks, cells };
  }

  /**
   * 月の境目になる列(週)を返す。列ごとに「その週の月曜が属する月」を求め、前の列と月が変わる列番号を並べる
   * (先頭列は境目に含めない)。ヒートマップに月単位の区切り線を引くために使う。
   * @param {Array<{col:number,row:number,date:string}>} cells buildHeatmapGrid()のcells
   * @returns {number[]}
   */
  function buildMonthBoundaries(cells) {
    const monthByCol = new Map();
    for (const c of cells) {
      if (c.row === 0) monthByCol.set(c.col, c.date.slice(0, 7));
    }
    const cols = [...monthByCol.keys()].sort((x, y) => x - y);
    const boundaries = [];
    for (let i = 1; i < cols.length; i++) {
      if (monthByCol.get(cols[i]) !== monthByCol.get(cols[i - 1])) boundaries.push(cols[i]);
    }
    return boundaries;
  }

  /**
   * 月曜基準で同じ月が続く列の範囲(セグメント)を返す。月の数字を表示する位置の算出に使う。
   * @param {Array<{col:number,row:number,date:string}>} cells buildHeatmapGrid()のcells
   * @returns {Array<{month:number,startCol:number,endCol:number}>}
   */
  function buildMonthSegments(cells) {
    const monthByCol = new Map();
    for (const c of cells) {
      if (c.row === 0) monthByCol.set(c.col, parseInt(c.date.slice(5, 7), 10));
    }
    const segments = [];
    for (const col of [...monthByCol.keys()].sort((x, y) => x - y)) {
      const month = monthByCol.get(col);
      const last = segments[segments.length - 1];
      if (last && last.month === month && last.endCol === col - 1) last.endCol = col;
      else segments.push({ month, startCol: col, endCol: col });
    }
    return segments;
  }

  return { buildMonthSegments, buildMonthBoundaries, buildDailyCounts, buildDailyCountsByProject, selectCounts, buildHeatmapGrid, levelFor, formatYmd, parseYmd };
});
