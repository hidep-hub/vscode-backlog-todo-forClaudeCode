(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.tagLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // タグ管理画面(BT-394)の純粋ロジック。DOM操作はtags.js側に置き、ここはnode --testで
  // 単体テストできるよう関数だけにする(header-ticker.jsと同じ構成)。
  // 正規化規則はdb/tags-repo.jsのcleanName/toNameKeyと揃える(サーバーが最終判定するため、
  // こちらは入力中のヒント・事前チェック用)。

  /** 表示用の整形: NFKC・連続空白の圧縮・trim。 */
  function cleanTagName(name) {
    return String(name == null ? '' : name).normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  /** 重複判定キー(サーバーのname_keyと同じ)。 */
  function tagNameKey(name) {
    return cleanTagName(name).toLowerCase();
  }

  /** 名前が完全一致(表記ゆれ込み)する既存タグを返す。excludeIdは改名時の自分自身の除外用。 */
  function findExactTag(tags, name, excludeId = null) {
    const key = tagNameKey(name);
    if (!key) return null;
    return tags.find(t => t.id !== excludeId && tagNameKey(t.name) === key) || null;
  }

  /** 色の上に載せる文字色(黒/白)。#rrggbbのYIQ輝度で決める。色なし・不正値はnull。 */
  function readableTextColor(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const yiq = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return yiq >= 150 ? '#1a1a1a' : '#ffffff';
  }

  // タグの色見本。白文字・黒文字のどちらを載せても読めるよう中間の濃さで揃え、
  // 色相が散らばるように並べる(readableTextColorが文字色を自動で決める)。
  const TAG_COLOR_PALETTE = [
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
    return button('', '色なし', ' tag-swatch-none') + TAG_COLOR_PALETTE.map(c => button(c.value, c.name, '')).join('');
  }

  function buildDeleteMessage(tag) {
    const used = tag.usageCount || 0;
    return used > 0
      ? `タグ「${tag.name}」を削除します。付いている ${used} 件のタスクからも外れます。元に戻せません。よろしいですか？`
      : `タグ「${tag.name}」を削除します。元に戻せません。よろしいですか？`;
  }

  function buildMergeMessage(source, target) {
    const used = source.usageCount || 0;
    return `タグ「${source.name}」を「${target.name}」に統合します。`
      + (used > 0 ? `「${source.name}」が付いている ${used} 件のタスクは「${target.name}」に付け替わります。` : '')
      + `「${source.name}」は削除され、元に戻せません。よろしいですか？`;
  }

  /**
   * サーバーのタグAPIエラー(body)を、画面に出す日本語メッセージとヒント情報に変換する。
   * similar_tags は「似たタグがある」ことを伝え、確認のうえ作成を続けられるようにする。
   * @returns {{kind:string, message:string, similar?:Array, existing?:object}}
   */
  function describeTagError(body) {
    const b = body || {};
    switch (b.error) {
      case 'duplicate_tag':
        return { kind: 'duplicate', message: `同じ名前のタグが既にあります: ${b.existing ? b.existing.name : ''}`, existing: b.existing };
      case 'similar_tags':
        return {
          kind: 'similar',
          message: `似た名前のタグがあります: ${(b.similar || []).map(t => t.name).join('、')}`,
          similar: b.similar || [],
        };
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
   * タグ1件のチップHTML。色ありは背景色+読みやすい文字色、色なしはニュートラル。
   * small=カード用の小さめ表示、dim=子タスク由来(EPICの導出表示)で薄く、removable=×ボタン付き。
   */
  function buildTagChipHtml(tag, { small = false, dim = false, removable = false } = {}) {
    const bg = /^#[0-9a-f]{6}$/i.test(tag.color || '') ? tag.color : '';
    const fg = readableTextColor(bg);
    const cls = ['tag-chip', bg ? '' : 'tag-chip-plain', small ? 'tag-chip-sm' : '', dim ? 'tag-chip-dim' : '']
      .filter(Boolean).join(' ');
    const style = bg ? ` style="background:${bg};color:${fg};border-color:${bg}"` : '';
    const remove = removable
      ? `<button type="button" class="tag-chip-remove" data-tag-id="${escapeText(tag.id)}" title="このタグを外す" aria-label="${escapeText(tag.name)}を外す">&times;</button>`
      : '';
    return `<span class="${cls}"${style} title="${escapeText(tag.name)}"><span class="tag-chip-text">${escapeText(tag.name)}</span>${remove}</span>`;
  }

  /**
   * カード・ミニボード用の小さなタグ表示。自分のタグを先に、EPICは子由来のタグを薄く続け、
   * maxを超えた分は「+N」にまとめる(カードがうるさくならないようにするため)。
   */
  function buildCardTagsHtml(tags, childTags, max = 3) {
    const own = (tags || []).map(t => ({ tag: t, dim: false }));
    const derived = (childTags || []).map(t => ({ tag: t, dim: true }));
    const all = own.concat(derived);
    if (all.length === 0) return '';
    const shown = all.slice(0, max);
    const hidden = all.slice(max);
    const chips = shown.map(e => buildTagChipHtml(e.tag, { small: true, dim: e.dim })).join('');
    const more = hidden.length
      ? `<span class="tag-chip tag-chip-sm tag-chip-plain tag-chip-more" title="${escapeText(hidden.map(e => e.tag.name).join('、'))}">+${hidden.length}</span>`
      : '';
    return `<span class="card-tags">${chips}${more}</span>`;
  }

  return {
    cleanTagName, tagNameKey, findExactTag, readableTextColor, buildDeleteMessage, buildMergeMessage, describeTagError,
    escapeText, buildTagChipHtml, buildCardTagsHtml, TAG_COLOR_PALETTE, buildSwatchesHtml,
  };
});
