(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.categoryLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // カテゴリ管理画面(BM-106、EPIC BM-101)の純粋ロジック。DOM操作はcategories.js側に置き、
  // ここはnode --testで単体テストできるよう関数だけにする(tag-logic.jsと同じ構成)。
  // 正規化規則はdb/name-normalizer.jsのcleanName/toNameKeyと揃える(サーバーが最終判定するため、
  // こちらは入力中のヒント・事前チェック用)。
  // タグと異なり、カテゴリは1タスク1値のため絞り込みは常にOR相当(複数選んだカテゴリのいずれかに一致)で、
  // and/orの切り替えは持たない。

  /** 表示用の整形: NFKC・連続空白の圧縮・trim。 */
  function cleanCategoryName(name) {
    return String(name == null ? '' : name).normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  /** 重複判定キー(サーバーのname_keyと同じ)。 */
  function categoryNameKey(name) {
    return cleanCategoryName(name).toLowerCase();
  }

  /** 名前が完全一致(表記ゆれ込み)する既存カテゴリを返す。excludeIdは改名時の自分自身の除外用。 */
  function findExactCategory(categories, name, excludeId = null) {
    const key = categoryNameKey(name);
    if (!key) return null;
    return categories.find(c => c.id !== excludeId && categoryNameKey(c.name) === key) || null;
  }

  /** 色の上に載せる文字色(黒/白)。#rrggbbのYIQ輝度で決める。色なし・不正値はnull。 */
  function readableTextColor(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const yiq = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return yiq >= 150 ? '#1a1a1a' : '#ffffff';
  }

  // カテゴリの色見本。タグと同じパレットを使う(配色の一貫性のため)。
  const CATEGORY_COLOR_PALETTE = [
    { name: 'レッド', value: '#e53935' },
    { name: 'ディープオレンジ', value: '#f4511e' },
    { name: 'オレンジ', value: '#fb8c00' },
    { name: 'イエロー', value: '#ffeb3b' },
    { name: 'ライム', value: '#c0ca33' },
    { name: 'グリーン', value: '#43a047' },
    { name: 'ティール', value: '#00897b' },
    { name: 'シアン', value: '#00acc1' },
    { name: 'ブルー', value: '#1e88e5' },
    { name: 'インディゴ', value: '#3949ab' },
    { name: 'パープル', value: '#8e24aa' },
    { name: 'ピンク', value: '#d81b60' },
    { name: 'ブラウン', value: '#6d4c41' },
    { name: 'ブルーグレー', value: '#546e7a' },
  ];

  /**
   * 色見本のボタン群HTML。先頭は「色なし」(data-color="")。selectedに一致する見本はaria-pressed=true。
   * selectedが''/nullなら「色なし」が選択状態になる。
   */
  function buildSwatchesHtml(selected) {
    const current = (selected || '').toLowerCase();
    const button = (color, name, extraClass) => {
      const pressed = color === current ? 'true' : 'false';
      const style = color ? ` style="background:${color}"` : '';
      return `<button type="button" class="tag-swatch${extraClass}" data-color="${color}" title="${escapeText(name)}" aria-label="${escapeText(name)}" aria-pressed="${pressed}"${style}></button>`;
    };
    return button('', '色なし', ' tag-swatch-none') + CATEGORY_COLOR_PALETTE.map(c => button(c.value, c.name, '')).join('');
  }

  // ---- カテゴリ絞り込み: ボードで使う判定 ----
  // カテゴリは「システムで一意」(ワークスペースの概念を持たない)なので、絞り込みは常に
  // カテゴリ名(categoryNameKey)1つに対して1件のマスタ行が対応する。
  // タグと異なり1タスク1値なので、判定は「選択した候補のいずれかに一致するか(OR)」のみ。

  /** item.category(文字列、無しは'-'または空)が、キー配列keysのいずれかに一致するか。keysが空なら常にtrue。 */
  function matchesCategoryFilter(category, keys) {
    if (!keys || keys.length === 0) return true;
    if (!category || category === '-') return false;
    return keys.includes(categoryNameKey(category));
  }

  /** ボードのitem用。EPICは自分のカテゴリで判定する(タグのchildTagsのような子からの導出は持たない)。 */
  function matchesCategoryFilterForBoardItem(item, keys) {
    return matchesCategoryFilter(item.category, keys);
  }

  /**
   * 絞り込み候補。使用中のものだけを使用数の多い順→名前順で返す。[{key,name,color,usageCount}]
   * (カテゴリは名前が既にシステム全体で一意なため、name_keyでの集約は実質素通りになる。
   * tagLogic.buildTagFilterOptionsと同じ形状を保つためにこの関数を残している)
   */
  function buildCategoryFilterOptions(categories) {
    const byKey = new Map();
    for (const c of categories || []) {
      const key = categoryNameKey(c.name);
      if (!key) continue;
      const cur = byKey.get(key);
      if (cur) cur.usageCount += c.usageCount || 0;
      else byKey.set(key, { key, name: cleanCategoryName(c.name), color: c.color || null, usageCount: c.usageCount || 0 });
    }
    return [...byKey.values()].filter(o => o.usageCount > 0)
      .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name, 'ja'));
  }

  /** localStorage保存値(JSON文字列)から絞り込み状態を復元する。壊れた値は「絞り込みなし」にする。 */
  function parseCategoryFilter(json) {
    const empty = { keys: [] };
    if (!json) return empty;
    try {
      const v = JSON.parse(json);
      const keys = (Array.isArray(v.keys) ? v.keys : []).filter(k => typeof k === 'string' && k);
      return { keys };
    } catch (e) {
      return empty;
    }
  }

  /** 画面に出す絞り込み条件の文言。例「カテゴリ: 重要 または 調査」。絞り込みなしは空文字。 */
  function describeCategoryFilter(filter, optionsByKey) {
    if (!filter || filter.keys.length === 0) return '';
    const names = filter.keys.map(k => (optionsByKey && optionsByKey.get(k)) || k);
    return `カテゴリ: ${names.join(' または ')}`;
  }

  function buildDeleteMessage(category) {
    const used = category.usageCount || 0;
    return used > 0
      ? `カテゴリ「${category.name}」を削除します。付いている ${used} 件のタスクはカテゴリなしになります。元に戻せません。よろしいですか？`
      : `カテゴリ「${category.name}」を削除します。元に戻せません。よろしいですか？`;
  }

  function buildMergeMessage(source, target) {
    const used = source.usageCount || 0;
    return `カテゴリ「${source.name}」を「${target.name}」に統合します。`
      + (used > 0 ? `「${source.name}」が付いている ${used} 件のタスクは「${target.name}」に付け替わります。` : '')
      + `「${source.name}」は削除され、元に戻せません。よろしいですか？`;
  }

  /**
   * サーバーのカテゴリAPIエラー(body)を、画面に出す日本語メッセージとヒント情報に変換する。
   * similar_categories は「似たカテゴリがある」ことを伝え、確認のうえ作成を続けられるようにする。
   * @returns {{kind:string, message:string, similar?:Array, existing?:object}}
   */
  function describeCategoryError(body) {
    const b = body || {};
    switch (b.error) {
      case 'duplicate_category':
        return { kind: 'duplicate', message: `同じ名前のカテゴリが既にあります: ${b.existing ? b.existing.name : ''}`, existing: b.existing };
      case 'similar_categories':
        return {
          kind: 'similar',
          message: `似た名前のカテゴリがあります: ${(b.similar || []).map(c => c.name).join('、')}`,
          similar: b.similar || [],
        };
      case 'unknown_category':
        return { kind: 'unknown', message: b.message || 'カテゴリが見つかりません' };
      default:
        return { kind: 'error', message: b.message || b.error || '不明なエラー' };
    }
  }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * カテゴリ1件のチップHTML。色ありは背景色+読みやすい文字色、色なしはニュートラル。
   * small=カード用の小さめ表示。カテゴリは1タスク1値のためremovable(×ボタン)は持たない
   * (選択は<select>側で行い、チップはボード/詳細の表示専用)。
   */
  function buildCategoryChipHtml(category, { small = false } = {}) {
    const bg = /^#[0-9a-f]{6}$/i.test(category.color || '') ? category.color : '';
    const fg = readableTextColor(bg);
    const cls = ['tag-chip', bg ? '' : 'tag-chip-plain', small ? 'tag-chip-sm' : ''].filter(Boolean).join(' ');
    const style = bg ? ` style="background:${bg};color:${fg};border-color:${bg}"` : '';
    return `<span class="${cls}"${style} title="${escapeText(category.name)}"><span class="tag-chip-text">${escapeText(category.name)}</span></span>`;
  }

  return {
    cleanCategoryName, categoryNameKey, findExactCategory, readableTextColor,
    buildDeleteMessage, buildMergeMessage, describeCategoryError, escapeText,
    buildCategoryChipHtml, CATEGORY_COLOR_PALETTE, buildSwatchesHtml,
    matchesCategoryFilter, matchesCategoryFilterForBoardItem, buildCategoryFilterOptions,
    parseCategoryFilter, describeCategoryFilter,
  };
});
