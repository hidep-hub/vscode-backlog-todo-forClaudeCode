(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.headerHeatmapFont = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // BM-091: ヘッダーミニヒートマップに「電光掲示板」風の起動時メッセージを流すためのドットフォント+
  // スクロール計算の純粋ロジック。DOM非依存で、header-heatmap.jsと同じ理由(node --testで単体テスト
  // できる/header-heatmap-intro-worker.jsからimportScriptsで読み込める)でこの形にしている。
  //
  // 高さは固定7ドット(ヒートマップの曜日7行に揃える)。幅は文字ごとに可変で、
  // 狭い文字(I等)は3〜4列、通常の文字は5列を使う(固定5幅だと表現が窮屈になるため可変幅にした)。
  // 現時点では固定ウェルカムメッセージ("BACKLOG DASHBOARD by HIDEP-HUB")に必要な文字のみ収録。
  // メッセージを可変にする子タスク(ウェルカムメッセージ 管理画面)で新しい文字が必要になったら、
  // GLYPHSに追記する(1文字=7行の'#'/'.'文字列。'#'=点灯、'.'=消灯)。

  const GLYPH_HEIGHT = 7;
  const CHAR_GAP = 1; // 文字と文字の間に空ける列数

  const GLYPHS = {
    ' ': ['...', '...', '...', '...', '...', '...', '...'],
    '-': ['....', '....', '....', '####', '....', '....', '....'],
    'A': ['..#..', '.#.#.', '#...#', '#...#', '#####', '#...#', '#...#'],
    'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    'C': ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
    'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    'G': ['.####', '#....', '#....', '#..##', '#...#', '#...#', '.####'],
    'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'I': ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
    'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    'L': ['#...', '#...', '#...', '#...', '#...', '#...', '####'],
    'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
    'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'b': ['#...', '#...', '#...', '###.', '#..#', '#..#', '###.'],
    'y': ['#...#', '#...#', '.#.#.', '.#.#.', '..#..', '..#..', '.#...'],
  };

  /**
   * 1文字のグリフを返す。完全一致が無ければ大文字変換して再試行し、それでも無ければ空白を返す。
   * @param {string} ch
   * @returns {{width:number, rows:string[]}}
   */
  function getGlyph(ch) {
    let rows = GLYPHS[ch];
    if (!rows) rows = GLYPHS[String(ch).toUpperCase()];
    if (!rows) {
      console.warn(`[header-heatmap-font] 未収録の文字をスペースとして扱います: ${JSON.stringify(ch)}`);
      rows = GLYPHS[' '];
    }
    return { width: rows[0].length, rows };
  }

  /**
   * テキスト全体を「列(column)の配列」に変換する。各列はGLYPH_HEIGHT件のbooleanを持つ配列(true=点灯)。
   * 文字間にCHAR_GAP列分の空白列を挟む。
   * @param {string} text
   * @returns {Array<boolean[]>}
   */
  function textToColumns(text) {
    const columns = [];
    const chars = Array.from(text || '');
    chars.forEach((ch, i) => {
      const { width, rows } = getGlyph(ch);
      for (let col = 0; col < width; col++) {
        const bits = [];
        for (let row = 0; row < GLYPH_HEIGHT; row++) bits.push(rows[row][col] === '#');
        columns.push(bits);
      }
      if (i < chars.length - 1) {
        for (let g = 0; g < CHAR_GAP; g++) columns.push(new Array(GLYPH_HEIGHT).fill(false));
      }
    });
    return columns;
  }

  /**
   * イントロアニメーションの総フレーム数を返す。メッセージが右端から完全に入り、
   * 左端から完全に抜けきった後にもう1フレーム分の「完全な空白」を挟んで本来のヒートマップへ
   * 滑らかに引き継げるようにする。strip(列数)が0ならアニメーション不要として0を返す。
   * @param {number} stripLength textToColumns()の結果の長さ
   * @param {number} weeks 表示可能な列数(ヒートマップの週数と同じ)
   * @returns {number}
   */
  function computeTotalFrames(stripLength, weeks) {
    if (stripLength <= 0 || weeks <= 0) return 0;
    return stripLength + weeks;
  }

  /**
   * 指定フレームでの点灯セル一覧を計算する(右から左へ1列ずつ流れるスクロール)。
   * @param {Array<boolean[]>} strip textToColumns()の結果
   * @param {number} weeks 表示列数
   * @param {number} frame 0始まりのフレーム番号
   * @returns {Array<{col:number,row:number,on:boolean}>}
   */
  function buildIntroFrameCells(strip, weeks, frame) {
    const cells = [];
    for (let s = 0; s < weeks; s++) {
      const stripIndex = s - weeks + 1 + frame;
      const bits = (stripIndex >= 0 && stripIndex < strip.length) ? strip[stripIndex] : null;
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        cells.push({ col: s, row, on: bits ? !!bits[row] : false });
      }
    }
    return cells;
  }

  return { GLYPH_HEIGHT, CHAR_GAP, getGlyph, textToColumns, computeTotalFrames, buildIntroFrameCells };
});
